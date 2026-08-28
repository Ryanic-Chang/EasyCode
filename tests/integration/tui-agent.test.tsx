import { cleanup, render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentLoop } from "../../src/agent/loop.js";
import { AgentSession, DEFAULT_SYSTEM_PROMPT } from "../../src/agent/session.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { EasyCodeApp } from "../../src/ui/app.js";
import { createDeferred, waitForAbort } from "../deferred.js";
import { FakeProvider } from "../fake-provider.js";
import { FakeTool } from "../fake-tool.js";

afterEach(() => {
  cleanup();
});

function submit(instance: ReturnType<typeof render>, task: string): void {
  instance.stdin.write(task);
  instance.stdin.write("\r");
}

describe("M4 TUI 离线闭环", () => {
  it("用户任务经 Session 进入真实 Agent，流式显示工具事件，并让第二条任务继承成功历史", async () => {
    const provider = new FakeProvider([
      [
        { type: "tool_call", index: 0, id: "echo-1", name: "echo", arguments: { value: "第一条" } },
        { type: "finish", reason: "tool_calls" },
      ],
      [
        { type: "text_delta", delta: "第一条" },
        { type: "text_delta", delta: "已完成" },
        { type: "finish", reason: "stop" },
      ],
      [
        { type: "text_delta", delta: "第二条继承上下文完成" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const tools = new ToolRegistry();
    const tool = new FakeTool({
      name: "echo",
      parse(input) {
        return input;
      },
      execute() {
        return { output: "处理完成", isError: false };
      },
    });
    tools.register(tool);
    const session = new AgentSession(
      new AgentLoop({ provider, tools, model: "fake-model", cwd: "fixture", maxSteps: 4 }),
    );
    const instance = render(
      <EasyCodeApp runner={session} model="fake-model" workspace="fixture" colorEnabled={false} columns={80} />,
    );

    submit(instance, "执行第一条任务");
    await vi.waitFor(() => expect(instance.lastFrame()).toContain("第一条已完成"));
    expect(instance.lastFrame()).toContain("[完成] echo · 参数已隐藏");
    expect(instance.lastFrame()).toContain("处理完成");
    expect(instance.lastFrame()).toContain("[等待输入]");

    submit(instance, "执行第二条任务");
    await vi.waitFor(() => expect(instance.lastFrame()).toContain("第二条继承上下文完成"));

    expect(tool.executions).toHaveLength(1);
    expect(provider.requests).toHaveLength(3);
    expect(provider.requests[2]?.messages).toEqual([
      { role: "system", content: DEFAULT_SYSTEM_PROMPT },
      { role: "user", content: "执行第一条任务" },
      { role: "assistant", content: "", toolCalls: [{ id: "echo-1", name: "echo", arguments: { value: "第一条" } }] },
      {
        role: "tool",
        toolCallId: "echo-1",
        toolName: "echo",
        content: "处理完成",
        isError: false,
      },
      { role: "assistant", content: "第一条已完成", toolCalls: [] },
      { role: "user", content: "执行第二条任务" },
    ]);
  });

  it("Ctrl+C 的同一 signal 下传 Provider，取消不会固化半截 ToolCall 或污染下一任务", async () => {
    const entered = createDeferred<void>();
    const provider = new FakeProvider([
      [
        { type: "tool_call_delta", index: 0, id: "partial", name: "missing", argumentsDelta: '{"path":' },
        async ({ signal }) => {
          entered.resolve(undefined);
          if (signal === undefined) {
            throw new Error("缺少 AbortSignal");
          }
          await waitForAbort(signal);
        },
      ],
      [
        { type: "text_delta", delta: "取消后重新完成" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const session = new AgentSession(
      new AgentLoop({ provider, tools: new ToolRegistry(), model: "fake-model", cwd: "fixture", maxSteps: 4 }),
    );
    const instance = render(
      <EasyCodeApp runner={session} model="fake-model" workspace="fixture" colorEnabled={false} columns={80} />,
    );

    submit(instance, "先取消");
    await entered.promise;
    const signal = provider.signals[0];
    instance.stdin.write("\u0003");
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    await vi.waitFor(() => expect(instance.lastFrame()).toContain("[任务已取消]"));

    submit(instance, "重新开始");
    await vi.waitFor(() => expect(instance.lastFrame()).toContain("取消后重新完成"));

    expect(provider.requests[1]?.messages).toEqual([
      { role: "system", content: DEFAULT_SYSTEM_PROMPT },
      { role: "user", content: "重新开始" },
    ]);
    expect(session.snapshot()).toEqual([
      { role: "system", content: DEFAULT_SYSTEM_PROMPT },
      { role: "user", content: "重新开始" },
      { role: "assistant", content: "取消后重新完成", toolCalls: [] },
    ]);
  });
});
