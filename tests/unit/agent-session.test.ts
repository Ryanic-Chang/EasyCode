import { describe, expect, it } from "vitest";

import { AgentLoop } from "../../src/agent/loop.js";
import type { SessionEvent, SessionRunResult } from "../../src/agent/session.js";
import { AgentSession, DEFAULT_SYSTEM_PROMPT, SessionBusyError } from "../../src/agent/session.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { createDeferred, waitForAbort } from "../deferred.js";
import { FakeProvider } from "../fake-provider.js";
import { FakeTool } from "../fake-tool.js";

async function collect(
  stream: AsyncGenerator<SessionEvent, SessionRunResult>,
): Promise<{ readonly events: readonly SessionEvent[]; readonly result: SessionRunResult }> {
  const events: SessionEvent[] = [];
  while (true) {
    const next = await stream.next();
    if (next.done) {
      return { events, result: next.value };
    }
    events.push(next.value);
  }
}

function session(provider: FakeProvider, maxSteps = 4): AgentSession {
  return new AgentSession(
    new AgentLoop({ provider, tools: new ToolRegistry(), model: "fake-model", cwd: "workspace", maxSteps }),
  );
}

describe("AgentSession", () => {
  it("只在 complete 时提交规范历史，第二条任务继承成功上下文", async () => {
    const provider = new FakeProvider([
      [
        { type: "text_delta", delta: "第一条完成" },
        { type: "finish", reason: "stop" },
      ],
      [
        { type: "text_delta", delta: "第二条完成" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const runner = session(provider);

    const first = await collect(runner.submit("第一条任务", { signal: new AbortController().signal }));
    const second = await collect(runner.submit("第二条任务", { signal: new AbortController().signal }));

    expect(first.result).toEqual({ runId: 1, reason: "complete" });
    expect(second.result).toEqual({ runId: 2, reason: "complete" });
    expect(provider.requests[0]?.messages).toEqual([
      { role: "system", content: DEFAULT_SYSTEM_PROMPT },
      { role: "user", content: "第一条任务" },
    ]);
    expect(provider.requests[1]?.messages).toEqual([
      { role: "system", content: DEFAULT_SYSTEM_PROMPT },
      { role: "user", content: "第一条任务" },
      { role: "assistant", content: "第一条完成", toolCalls: [] },
      { role: "user", content: "第二条任务" },
    ]);
    expect(runner.snapshot().at(-1)).toMatchObject({ role: "assistant", content: "第二条完成" });
  });

  it.each(["provider_error", "protocol_error"] as const)("%s 终止时回滚候选历史", async (reason) => {
    const failureScript =
      reason === "provider_error"
        ? [
            {
              type: "error" as const,
              error: { code: "provider_server" as const, message: "sensitive", retryable: false },
            },
          ]
        : [{ type: "finish" as const, reason: "length" as const }];
    const provider = new FakeProvider([
      failureScript,
      [
        { type: "text_delta", delta: "恢复完成" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const runner = session(provider);

    const failed = await collect(runner.submit("失败任务", { signal: new AbortController().signal }));
    await collect(runner.submit("恢复任务", { signal: new AbortController().signal }));

    expect(failed.result.reason).toBe(reason);
    expect(provider.requests[1]?.messages).toEqual([
      { role: "system", content: DEFAULT_SYSTEM_PROMPT },
      { role: "user", content: "恢复任务" },
    ]);
  });

  it("max_steps 时回滚已产生 ToolCall/ToolResult 的候选历史", async () => {
    const provider = new FakeProvider([
      [
        { type: "tool_call", index: 0, id: "call", name: "echo", arguments: {} },
        { type: "finish", reason: "tool_calls" },
      ],
    ]);
    const tools = new ToolRegistry();
    tools.register(
      new FakeTool({
        name: "echo",
        parse: (input) => input,
        execute: () => ({ output: "已执行", isError: false }),
      }),
    );
    const runner = new AgentSession(
      new AgentLoop({ provider, tools, model: "fake-model", cwd: "workspace", maxSteps: 1 }),
    );

    const failed = await collect(runner.submit("达到上限", { signal: new AbortController().signal }));

    expect(failed.result.reason).toBe("max_steps");
    expect(runner.snapshot()).toEqual([{ role: "system", content: DEFAULT_SYSTEM_PROMPT }]);
  });

  it("拒绝并发提交，并把调用方的同一个 AbortSignal 传给 Agent", async () => {
    const entered = createDeferred<void>();
    const provider = new FakeProvider([
      [
        async ({ signal }) => {
          entered.resolve(undefined);
          if (signal === undefined) {
            throw new Error("缺少 signal");
          }
          await waitForAbort(signal);
        },
      ],
    ]);
    const runner = session(provider);
    const controller = new AbortController();
    const active = runner.submit("等待取消", { signal: controller.signal });

    await active.next();
    const pending = active.next();
    await entered.promise;
    expect(() => runner.submit("并发任务", { signal: new AbortController().signal })).toThrow(SessionBusyError);
    controller.abort();
    await pending;
    const finished = await active.next();

    expect(finished.done).toBe(true);
    expect(provider.signals).toEqual([controller.signal]);
    expect(runner.snapshot()).toEqual([{ role: "system", content: DEFAULT_SYSTEM_PROMPT }]);
  });

  it("拒绝空白任务，且系统提示保持克制的安全要求", () => {
    const runner = session(new FakeProvider([]));
    expect(() => runner.submit("   ", { signal: new AbortController().signal })).toThrow("任务不能为空");
    expect(DEFAULT_SYSTEM_PROMPT).toContain("中文优先");
    expect(DEFAULT_SYSTEM_PROMPT).toContain("apply_patch");
    expect(DEFAULT_SYSTEM_PROMPT).toContain("不得声称未实际执行的验证通过");
    expect(DEFAULT_SYSTEM_PROMPT).toContain("无可选参数时也使用 {}");
    expect(DEFAULT_SYSTEM_PROMPT).toContain("未授权或硬拒绝操作时不要试探调用工具");
  });
});
