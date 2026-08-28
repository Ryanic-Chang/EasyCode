import type { AgentEvent, AgentTerminationReason } from "./events.js";
import type { AgentLoop } from "./loop.js";
import type { Message } from "./messages.js";

export const DEFAULT_SYSTEM_PROMPT = `你是 EasyCode，一个中文优先的 Coding Agent。
修改前先观察相关文件，文件修改优先使用 apply_patch，修改后寻找并运行适当验证。
不得声称未实际执行的验证通过；始终遵守工具与 workspace 安全边界。`;

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
}

export class SessionBusyError extends Error {
  constructor() {
    super("已有任务正在运行");
    this.name = "SessionBusyError";
  }
}

export class AgentSession implements AgentRunner {
  readonly #agent: AgentLoop;
  #messages: readonly Message[];
  #activeRunId: number | undefined;
  #nextRunId = 1;

  constructor(agent: AgentLoop) {
    this.#agent = agent;
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
