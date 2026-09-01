import type { ApprovalController, ApprovalDecision } from "./approval.js";
import type { AgentEvent, AgentTerminationReason } from "./events.js";
import type { AgentLoop } from "./loop.js";
import type { Message } from "./messages.js";

export const DEFAULT_SYSTEM_PROMPT = `你是 EasyCode，一个中文优先的 Coding Agent。
先搜索、读取并理解相关文件，再制定最短方案；只修改完成任务必需的文件。
修改文件优先使用 apply_patch。运行命令必须使用 executable、args 和可选 stdin 的结构化字段；没有 shell，不得生成管道、重定向、&&、cmd 或 PowerShell 包装。
每个 ToolCall 的 arguments 必须是完整 JSON object，无可选参数时也使用 {}；遇到未授权或硬拒绝操作时不要试探调用工具，直接说明停止。
工具失败时读取错误结果并采用安全替代方案；修改后运行适当验证，不得声称未实际执行的验证通过。
最终回答保持简短，说明改动、实际验证和仍有限制；始终遵守工具、逐次确认与 workspace 安全边界。`;

export interface SessionEvent {
  readonly runId: number;
  readonly event: AgentEvent;
}

export interface SessionRunResult {
  readonly runId: number;
  readonly reason: AgentTerminationReason;
}

export interface AgentRunOptions {
  readonly signal: AbortSignal;
}

export interface AgentRunner {
  submit(task: string, options: AgentRunOptions): AsyncGenerator<SessionEvent, SessionRunResult>;
  resolveApproval(decision: ApprovalDecision): boolean;
  dispose(): void;
}

export class SessionBusyError extends Error {
  constructor() {
    super("已有任务正在运行");
    this.name = "SessionBusyError";
  }
}

export class AgentSession implements AgentRunner {
  readonly #agent: AgentLoop;
  readonly #approvalController: ApprovalController | undefined;
  #messages: readonly Message[];
  #activeRunId: number | undefined;
  #nextRunId = 1;

  constructor(agent: AgentLoop, approvalController?: ApprovalController) {
    this.#agent = agent;
    this.#approvalController = approvalController;
    this.#messages = [{ role: "system", content: DEFAULT_SYSTEM_PROMPT }];
  }

  submit(task: string, options: AgentRunOptions): AsyncGenerator<SessionEvent, SessionRunResult> {
    if (this.#activeRunId !== undefined) {
      throw new SessionBusyError();
    }
    if (task.trim().length === 0) {
      throw new TypeError("任务不能为空");
    }

    const runId = this.#nextRunId;
    this.#nextRunId += 1;
    this.#activeRunId = runId;
    const candidateMessages: readonly Message[] = [...this.#messages, { role: "user", content: task }];
    return this.#run(runId, candidateMessages, options.signal);
  }

  snapshot(): readonly Message[] {
    return [...this.#messages];
  }

  resolveApproval(decision: ApprovalDecision): boolean {
    return this.#approvalController?.resolve(decision) ?? false;
  }

  dispose(): void {
    this.#approvalController?.dispose();
  }

  async *#run(
    runId: number,
    candidateMessages: readonly Message[],
    signal: AbortSignal,
  ): AsyncGenerator<SessionEvent, SessionRunResult> {
    const stream = this.#agent.run(candidateMessages, { signal });
    let completed = false;
    try {
      while (true) {
        const next = await stream.next();
        if (next.done) {
          completed = true;
          if (next.value.reason === "complete") {
            this.#messages = [...next.value.messages];
          }
          return { runId, reason: next.value.reason };
        }
        yield { runId, event: next.value };
      }
    } finally {
      try {
        if (!completed) {
          await stream.return({ reason: "aborted", step: 0, messages: candidateMessages });
        }
      } finally {
        if (this.#activeRunId === runId) {
          this.#activeRunId = undefined;
        }
      }
    }
  }
}
