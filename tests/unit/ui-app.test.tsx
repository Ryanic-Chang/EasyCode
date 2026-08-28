import { renderToString } from "ink";
import { cleanup, render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApprovalDecision } from "../../src/agent/approval.js";
import type { AgentEvent } from "../../src/agent/events.js";
import type { AgentRunner, AgentRunOptions, SessionEvent, SessionRunResult } from "../../src/agent/session.js";
import { EasyCodeApp, EasyCodeView } from "../../src/ui/app.js";
import { EMPTY_INPUT } from "../../src/ui/input.js";
import { INITIAL_UI_STATE, uiReducer } from "../../src/ui/model.js";
import { createDeferred, waitForAbort } from "../deferred.js";

type Script = (runId: number, options: AgentRunOptions) => AsyncGenerator<SessionEvent, SessionRunResult>;

class ScriptedRunner implements AgentRunner {
  readonly submissions: Array<{ readonly task: string; readonly signal: AbortSignal }> = [];
  readonly approvals: ApprovalDecision[] = [];
  approvalHandler: ((decision: ApprovalDecision) => boolean) | undefined;
  readonly #scripts: Script[];

  constructor(scripts: readonly Script[]) {
    this.#scripts = [...scripts];
  }

  submit(task: string, options: AgentRunOptions): AsyncGenerator<SessionEvent, SessionRunResult> {
    const script = this.#scripts.shift();
    if (script === undefined) {
      throw new Error("缺少测试脚本");
    }
    this.submissions.push({ task, signal: options.signal });
    return script(this.submissions.length, options);
  }

  resolveApproval(decision: ApprovalDecision): boolean {
    this.approvals.push(decision);
    return this.approvalHandler?.(decision) ?? false;
  }

  dispose(): void {}
}

function eventsScript(events: readonly AgentEvent[]): Script {
  return async function* (runId) {
    for (const event of events) {
      yield { runId, event };
    }
    const complete = [...events].reverse().find((event) => event.type === "complete");
    return { runId, reason: complete?.type === "complete" ? complete.reason : "internal_error" };
  };
}

function app(runner: AgentRunner, overrides: Partial<Parameters<typeof EasyCodeApp>[0]> = {}) {
  return (
    <EasyCodeApp
      runner={runner}
      model="fake-model"
      workspace="fixture"
      colorEnabled={false}
      columns={80}
      {...overrides}
    />
  );
}

afterEach(() => {
  cleanup();
});

describe("中文 Ink TUI", () => {
  it("初始 idle 首屏紧凑可用，不显示欢迎页或帮助栏", () => {
    const instance = render(app(new ScriptedRunner([])));
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("EasyCode");
    expect(frame).toContain("模型 fake-model · workspace fixture");
    expect(frame).toContain("[等待输入]");
    expect(frame).toContain("› │");
    expect(frame).not.toContain("快捷键");
  });

  it.each([
    ["\r", false, "已拒绝"],
    ["n", false, "已拒绝"],
    ["y", true, "已允许"],
  ] as const)("确认输入 %j 只解析一次，Enter 默认拒绝", async (input, approved, label) => {
    const decision = createDeferred<ApprovalDecision>();
    const runner = new ScriptedRunner([
      async function* (runId) {
        yield {
          runId,
          event: {
            type: "approval_required",
            step: 1,
            request: {
              approvalId: "approval-ui",
              step: 1,
              toolCallId: "command-ui",
              toolName: "run_command",
              riskCategory: "command_execution",
              actionSummary: "node verify.mjs · . · 30000 ms",
            },
          },
        };
        const resolved = await decision.promise;
        yield {
          runId,
          event: {
            type: "approval_resolved",
            step: 1,
            approvalId: resolved.approvalId,
            toolCallId: "command-ui",
            toolName: "run_command",
            approved: resolved.approved,
          },
        };
        yield { runId, event: { type: "complete", step: 1, reason: "complete" } };
        return { runId, reason: "complete" };
      },
    ]);
    runner.approvalHandler = (value) => {
      decision.resolve(value);
      return true;
    };
    const instance = render(app(runner, { columns: 40, colorEnabled: false }));
    instance.stdin.write("运行验证");
    instance.stdin.write("\r");
    await vi.waitFor(() => expect(instance.lastFrame()).toContain("[等待确认]"));
    expect(instance.lastFrame()).toContain("一次性授权");
    instance.stdin.write(input);
    await vi.waitFor(() => expect(instance.lastFrame()).toContain(`[${label}] run_command`));
    expect(runner.approvals).toEqual([{ approvalId: "approval-ui", approved }]);
  });

  it("等待确认时 Ctrl+C 取消当前 run，不提交 decision", async () => {
    const entered = createDeferred<void>();
    const runner = new ScriptedRunner([
      async function* (runId, options) {
        yield {
          runId,
          event: {
            type: "approval_required",
            step: 1,
            request: {
              approvalId: "approval-abort",
              step: 1,
              toolCallId: "command-abort",
              toolName: "run_command",
              riskCategory: "command_execution",
              actionSummary: "node verify.mjs",
            },
          },
        };
        entered.resolve(undefined);
        try {
          await waitForAbort(options.signal);
        } catch {
          // 测试 runner 将取消转换为与 AgentSession 一致的 terminal event。
        }
        yield { runId, event: { type: "complete", step: 1, reason: "aborted" } };
        return { runId, reason: "aborted" };
      },
    ]);
    const instance = render(app(runner));
    instance.stdin.write("运行验证");
    instance.stdin.write("\r");
    await entered.promise;
    instance.stdin.write("\u0003");
    await vi.waitFor(() => expect(instance.lastFrame()).toContain("[任务已取消]"));
    expect(runner.submissions[0]?.signal.aborted).toBe(true);
    expect(runner.approvals).toHaveLength(0);
  });

  it("中文任务提交后流式累计到同一 assistant block，完成后恢复输入", async () => {
    const release = createDeferred<void>();
    const runner = new ScriptedRunner([
      async function* (runId) {
        yield { runId, event: { type: "turn_start", step: 1 } };
        yield { runId, event: { type: "assistant_delta", step: 1, delta: "正在分析" } };
        await release.promise;
        yield { runId, event: { type: "assistant_delta", step: 1, delta: "并修复" } };
        yield { runId, event: { type: "complete", step: 1, reason: "complete" } };
        return { runId, reason: "complete" };
      },
    ]);
    const instance = render(app(runner));

    instance.stdin.write("修复测试");
    instance.stdin.write("\r");
    await vi.waitFor(() => expect(instance.lastFrame()).toContain("正在分析"));
    expect(instance.lastFrame()).not.toContain("正在分析并修复");
    release.resolve(undefined);
    await vi.waitFor(() => expect(instance.lastFrame()).toContain("正在分析并修复"));

    expect(runner.submissions.map(({ task }) => task)).toEqual(["修复测试"]);
    expect(instance.lastFrame()).toContain("[任务完成]");
    expect(instance.lastFrame()).toContain("[等待输入]");
    expect(instance.lastFrame()?.match(/助手/g) ?? []).toHaveLength(1);
  });

  it("按顺序显示工具运行、成功、失败及有界结果摘要", async () => {
    const runner = new ScriptedRunner([
      eventsScript([
        { type: "turn_start", step: 1 },
        {
          type: "tool_start",
          step: 1,
          toolCall: { id: "read", name: "read_file", arguments: { path: "src/main.ts" } },
        },
        {
          type: "tool_end",
          step: 1,
          result: {
            toolCallId: "read",
            toolName: "read_file",
            output: "完整文件内容不展示",
            isError: false,
            metadata: { startLine: 1, endLine: 20 },
          },
        },
        {
          type: "tool_start",
          step: 1,
          toolCall: { id: "command", name: "run_command", arguments: { executable: "node", args: [], cwd: "." } },
        },
        {
          type: "tool_end",
          step: 1,
          result: {
            toolCallId: "command",
            toolName: "run_command",
            output: "命令失败",
            isError: true,
            metadata: { stderr: "test failed", exitCode: 1 },
          },
        },
        { type: "complete", step: 1, reason: "complete" },
      ]),
    ]);
    const instance = render(app(runner));

    instance.stdin.write("执行验证");
    instance.stdin.write("\r");
    await vi.waitFor(() => expect(instance.lastFrame()).toContain("[任务完成]"));
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("[完成] read_file · src/main.ts · 全部");
    expect(frame).toContain("读取 1–20 行");
    expect(frame).toContain("[失败] run_command · node · .");
    expect(frame).toContain("test failed");
    expect(frame).not.toContain("完整文件内容不展示");
  });

  it.each([
    ["provider_error", "模型服务错误"],
    ["protocol_error", "模型协议错误"],
    ["internal_error", "内部执行错误"],
    ["max_steps", "达到最大轮次"],
    ["aborted", "任务已取消"],
  ] as const)("展示 %s 并恢复 idle", async (reason, label) => {
    const errorEvents: AgentEvent[] =
      reason === "provider_error"
        ? [
            {
              type: "error",
              step: 1,
              error: { code: "provider_server", message: "模型服务暂时不可用", recoverable: false },
            },
          ]
        : [];
    const runner = new ScriptedRunner([eventsScript([...errorEvents, { type: "complete", step: 1, reason }])]);
    const instance = render(app(runner));
    instance.stdin.write("任务");
    instance.stdin.write("\r");
    await vi.waitFor(() => expect(instance.lastFrame()).toContain(`[${label}]`));
    expect(instance.lastFrame()).toContain("[等待输入]");
    if (reason === "provider_error") {
      expect(instance.lastFrame()).toContain("[错误] provider_server · 模型服务暂时不可用");
    }
  });

  it("active Ctrl+C 取消同一 signal；cancelling 禁止提交，二次 Ctrl+C 等待清理后退出", async () => {
    const entered = createDeferred<void>();
    const cleanupGate = createDeferred<void>();
    let exitRequested = 0;
    const runner = new ScriptedRunner([
      async function* (runId, { signal }) {
        yield { runId, event: { type: "turn_start", step: 1 } };
        entered.resolve(undefined);
        try {
          await waitForAbort(signal);
        } catch {
          // 取消是本测试预期路径。
        }
        await cleanupGate.promise;
        yield { runId, event: { type: "complete", step: 1, reason: "aborted" } };
        return { runId, reason: "aborted" };
      },
    ]);
    const instance = render(app(runner, { onExitRequested: () => (exitRequested += 1) }));

    instance.stdin.write("等待任务");
    instance.stdin.write("\r");
    await entered.promise;
    const signal = runner.submissions[0]?.signal;
    expect(signal?.aborted).toBe(false);
    instance.stdin.write("\u0003");
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    expect(instance.lastFrame()).toContain("[正在取消]");
    instance.stdin.write("不应提交");
    instance.stdin.write("\r");
    expect(runner.submissions).toHaveLength(1);
    instance.stdin.write("\u0003");
    expect(exitRequested).toBe(0);
    cleanupGate.resolve(undefined);
    await vi.waitFor(() => expect(exitRequested).toBe(1));
  });

  it("idle Ctrl+C 安全退出；unmount 会 abort 活跃 signal", async () => {
    let idleExit = 0;
    const idle = render(app(new ScriptedRunner([]), { onExitRequested: () => (idleExit += 1) }));
    idle.stdin.write("\u0003");
    await vi.waitFor(() => expect(idleExit).toBe(1));

    const entered = createDeferred<void>();
    const runner = new ScriptedRunner([
      async function* (runId, { signal }) {
        yield { runId, event: { type: "turn_start", step: 1 } };
        entered.resolve(undefined);
        await waitForAbort(signal);
        return { runId, reason: "aborted" };
      },
    ]);
    const active = render(app(runner));
    active.stdin.write("等待");
    active.stdin.write("\r");
    await entered.promise;
    active.unmount();
    await vi.waitFor(() => expect(runner.submissions[0]?.signal.aborted).toBe(true));
  });

  it("stdin bracketed paste 将 CR/LF 归一化为一条任务", async () => {
    const runner = new ScriptedRunner([eventsScript([{ type: "complete", step: 0, reason: "complete" }])]);
    const instance = render(app(runner));
    instance.stdin.write("\u001B[200~第一行\n第二行\r\n第三行\u001B[201~");
    instance.stdin.write("\r");
    await vi.waitFor(() => expect(runner.submissions).toHaveLength(1));
    expect(runner.submissions[0]?.task).toBe("第一行 第二行 第三行");
  });
});

describe("TUI 宽度与无颜色渲染", () => {
  function displayWidth(value: string): number {
    return [...value].reduce((width, character) => width + ((character.codePointAt(0) ?? 0) >= 0x2e80 ? 2 : 1), 0);
  }

  it.each([120, 80, 60, 40])("%d columns 下保持单列且长中英文不越界", (columns) => {
    let state = uiReducer(INITIAL_UI_STATE, {
      type: "submit",
      runId: 1,
      task: `修复${"很长的中文".repeat(20)} ${"unbroken".repeat(40)}`,
    });
    state = uiReducer(state, {
      type: "agent_event",
      runId: 1,
      event: { type: "assistant_delta", step: 1, delta: `${"连续中文".repeat(40)}${"longtoken".repeat(50)}` },
    });
    const frame = renderToString(
      <EasyCodeView
        state={state}
        input={EMPTY_INPUT}
        model="very-long-model-name"
        workspace="very-long-workspace-name"
        colorEnabled={false}
        columns={columns}
      />,
      { columns },
    );
    expect(frame).not.toContain("\u001B[");
    expect(Math.max(...frame.split("\n").map(displayWidth))).toBeLessThanOrEqual(columns);
    expect(frame).toContain("EasyCode");
    expect(frame).toContain("[正在运行]");
  });
});
