import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../../src/agent/events.js";
import { AgentLoop, type AgentRunResult } from "../../src/agent/loop.js";
import type { Message } from "../../src/agent/messages.js";
import type { ProviderEvent } from "../../src/llm/provider.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import type { ToolExecutionResult } from "../../src/tools/tool.js";
import { createDeferred, waitForAbort } from "../deferred.js";
import { FakeProvider } from "../fake-provider.js";
import { FakeTool } from "../fake-tool.js";

const initialMessages: readonly Message[] = [{ role: "user", content: "请完成任务" }];

interface CollectedRun {
  readonly events: readonly AgentEvent[];
  readonly result: AgentRunResult;
}

async function collectRun(stream: AsyncGenerator<AgentEvent, AgentRunResult>): Promise<CollectedRun> {
  const events: AgentEvent[] = [];
  while (true) {
    const item = await stream.next();
    if (item.done) {
      return { events, result: item.value };
    }
    events.push(item.value);
  }
}

function createAgent(
  provider: FakeProvider,
  configureTools: (registry: ToolRegistry) => void = () => undefined,
  maxSteps = 5,
): AgentLoop {
  const tools = new ToolRegistry();
  configureTools(tools);
  return new AgentLoop({ provider, tools, model: "fake-model", cwd: "workspace", maxSteps });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createValueTool(
  name: string,
  execute: (value: string) => ToolExecutionResult,
): FakeTool<{ readonly value: string }> {
  return new FakeTool({
    name,
    inputSchema: { type: "object", required: ["value"] },
    parse(input) {
      if (!isRecord(input) || typeof input.value !== "string") {
        throw new Error("value 必须是字符串");
      }
      return { value: input.value };
    },
    execute(input) {
      return execute(input.value);
    },
  });
}

function terminationReasons(events: readonly AgentEvent[]): string[] {
  return events.filter((event) => event.type === "complete").map((event) => event.reason);
}

function toolStartIds(events: readonly AgentEvent[]): string[] {
  return events.filter((event) => event.type === "tool_start").map((event) => event.toolCall.id);
}

describe("AgentLoop 验收场景", () => {
  it("AL-01：纯文本流只请求一次 Provider 并正常完成", async () => {
    const provider = new FakeProvider([
      [
        { type: "start" },
        { type: "text_delta", delta: "任务" },
        { type: "text_delta", delta: "完成" },
        { type: "finish", reason: "stop" },
      ],
    ]);

    const run = await collectRun(createAgent(provider).run(initialMessages));

    expect(run.events).toEqual([
      { type: "turn_start", step: 1 },
      { type: "assistant_delta", step: 1, delta: "任务" },
      { type: "assistant_delta", step: 1, delta: "完成" },
      { type: "complete", step: 1, reason: "complete" },
    ]);
    expect(provider.requests).toHaveLength(1);
    expect(run.result).toEqual({
      reason: "complete",
      step: 1,
      messages: [...initialMessages, { role: "assistant", content: "任务完成", toolCalls: [] }],
    });
  });

  it("AL-02：完整 ToolCall 执行一次并把 assistant 与 ToolResult 回传下一轮", async () => {
    const provider = new FakeProvider([
      [
        { type: "tool_call", index: 0, id: "call-1", name: "echo", arguments: { value: "你好" } },
        { type: "finish", reason: "tool_calls" },
      ],
      [
        { type: "text_delta", delta: "已处理" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const tool = createValueTool("echo", (value) => ({ output: `回显：${value}`, isError: false }));
    const agent = createAgent(provider, (registry) => registry.register(tool));

    const run = await collectRun(agent.run(initialMessages));

    expect(tool.executions.map(({ input }) => input)).toEqual([{ value: "你好" }]);
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]?.messages).toEqual([
      { role: "user", content: "请完成任务" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call-1", name: "echo", arguments: { value: "你好" } }],
      },
      {
        role: "tool",
        toolCallId: "call-1",
        toolName: "echo",
        content: "回显：你好",
        isError: false,
      },
    ]);
    expect(run.events.map(({ type }) => type)).toEqual([
      "turn_start",
      "tool_start",
      "tool_end",
      "turn_start",
      "assistant_delta",
      "complete",
    ]);
    expect(run.result.reason).toBe("complete");
  });

  it("AL-03：交错增量按 index 串行执行，多轮调用无遗漏、无重复且 step 稳定", async () => {
    const executionOrder: string[] = [];
    const first = createValueTool("first", (value) => {
      executionOrder.push(`first:${value}`);
      return { output: `first:${value}`, isError: false };
    });
    const second = createValueTool("second", (value) => {
      executionOrder.push(`second:${value}`);
      return { output: `second:${value}`, isError: false };
    });
    const provider = new FakeProvider([
      [
        {
          type: "tool_call_delta",
          index: 1,
          id: "call-2",
          name: "second",
          argumentsDelta: '{"value":',
        },
        {
          type: "tool_call_delta",
          index: 0,
          id: "call-1",
          name: "first",
          argumentsDelta: '{"value":"A"}',
        },
        { type: "tool_call_delta", index: 1, argumentsDelta: '"B"}' },
        { type: "finish", reason: "tool_calls" },
      ],
      [
        { type: "tool_call_delta", index: 0, id: "call-3", name: "first", argumentsDelta: '{"value"' },
        { type: "tool_call_delta", index: 0, argumentsDelta: ':"C"}' },
        { type: "finish", reason: "tool_calls" },
      ],
      [
        { type: "text_delta", delta: "全部完成" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const agent = createAgent(provider, (registry) => {
      registry.register(first);
      registry.register(second);
    });

    const run = await collectRun(agent.run(initialMessages));

    expect(executionOrder).toEqual(["first:A", "second:B", "first:C"]);
    expect(toolStartIds(run.events)).toEqual(["call-1", "call-2", "call-3"]);
    expect(run.events.filter((event) => event.type === "turn_start").map((event) => event.step)).toEqual([1, 2, 3]);
    expect(provider.requests).toHaveLength(3);
    expect(provider.requests.map(({ messages }) => messages.length)).toEqual([1, 4, 6]);
    expect(
      provider.requests[1]?.messages.filter((message) => message.role === "tool").map(({ toolCallId }) => toolCallId),
    ).toEqual(["call-1", "call-2"]);
    expect(
      provider.requests[2]?.messages.filter((message) => message.role === "tool").map(({ toolCallId }) => toolCallId),
    ).toEqual(["call-1", "call-2", "call-3"]);
    expect(run.result.reason).toBe("complete");
    expect(run.result.step).toBe(3);
  });

  it("AL-04：可恢复工具失败形成失败 ToolResult，并允许 Provider 下一轮修正", async () => {
    const provider = new FakeProvider([
      [
        { type: "tool_call", index: 0, id: "call-fail", name: "lookup", arguments: { value: "missing" } },
        { type: "finish", reason: "tool_calls" },
      ],
      [
        { type: "text_delta", delta: "已改用其他方案" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const tool = createValueTool("lookup", () => ({
      output: "未找到目标",
      isError: true,
      metadata: { kind: "not_found" },
    }));

    const run = await collectRun(createAgent(provider, (registry) => registry.register(tool)).run(initialMessages));

    const toolEnds = run.events.filter((event) => event.type === "tool_end");
    expect(toolEnds).toHaveLength(1);
    expect(toolEnds[0]?.result.isError).toBe(true);
    expect(provider.requests[1]?.messages.at(-1)).toEqual({
      role: "tool",
      toolCallId: "call-fail",
      toolName: "lookup",
      content: "未找到目标",
      isError: true,
      metadata: { kind: "not_found" },
    });
    expect(run.result.reason).toBe("complete");
  });

  it("AL-05：Provider error event 脱敏终止，不执行工具或追加 assistant 历史", async () => {
    const provider = new FakeProvider([
      [
        { type: "text_delta", delta: "未完成" },
        {
          type: "error",
          error: { code: "remote_error", message: "TOP_SECRET_VALUE", retryable: true },
        },
      ],
    ]);
    const tool = createValueTool("unused", () => ({ output: "不应执行", isError: false }));

    const run = await collectRun(createAgent(provider, (registry) => registry.register(tool)).run(initialMessages));

    expect(tool.executions).toHaveLength(0);
    expect(run.result.messages).toEqual(initialMessages);
    expect(terminationReasons(run.events)).toEqual(["provider_error"]);
    expect(run.events.find((event) => event.type === "error")).toEqual({
      type: "error",
      step: 1,
      error: { code: "provider_error", message: "模型服务暂时不可用，请稍后重试。", recoverable: true },
    });
    expect(JSON.stringify(run.events)).not.toContain("TOP_SECRET_VALUE");
  });

  it("AL-05：Provider 抛出未知异常时使用稳定消息且不伪造历史", async () => {
    const provider = new FakeProvider([
      [
        () => {
          throw new Error("TOP_SECRET_VALUE");
        },
      ],
    ]);

    const run = await collectRun(createAgent(provider).run(initialMessages));

    expect(run.result.messages).toEqual(initialMessages);
    expect(terminationReasons(run.events)).toEqual(["provider_error"]);
    expect(JSON.stringify(run.events)).not.toContain("TOP_SECRET_VALUE");
  });

  it("AL-06：Provider 流暂停时取消，传播同一 AbortSignal 且不再请求", async () => {
    const entered = createDeferred<void>();
    let receivedSignal: AbortSignal | undefined;
    const provider = new FakeProvider([
      [
        async ({ signal }) => {
          receivedSignal = signal;
          entered.resolve(undefined);
          if (signal === undefined) {
            throw new Error("缺少 AbortSignal");
          }
          await waitForAbort(signal);
        },
      ],
    ]);
    const controller = new AbortController();
    const runPromise = collectRun(createAgent(provider).run(initialMessages, { signal: controller.signal }));

    await entered.promise;
    controller.abort();
    const run = await runPromise;

    expect(receivedSignal).toBe(controller.signal);
    expect(provider.signals).toEqual([controller.signal]);
    expect(provider.requests).toHaveLength(1);
    expect(run.result.reason).toBe("aborted");
    expect(terminationReasons(run.events)).toEqual(["aborted"]);
    expect(run.events.some((event) => event.type === "error")).toBe(false);
  });

  it("AL-06：工具执行暂停时取消，传播同一 AbortSignal 且不产生后续调用", async () => {
    const entered = createDeferred<void>();
    const provider = new FakeProvider([
      [
        { type: "tool_call", index: 0, id: "call-wait", name: "wait", arguments: { value: "x" } },
        { type: "finish", reason: "tool_calls" },
      ],
      [{ type: "finish", reason: "stop" }],
    ]);
    const tool = new FakeTool({
      name: "wait",
      parse(input) {
        return input;
      },
      async execute(_input, context) {
        entered.resolve(undefined);
        return await waitForAbort(context.signal);
      },
    });
    const controller = new AbortController();
    const runPromise = collectRun(
      createAgent(provider, (registry) => registry.register(tool)).run(initialMessages, { signal: controller.signal }),
    );

    await entered.promise;
    controller.abort();
    const run = await runPromise;

    expect(tool.executions).toHaveLength(1);
    expect(tool.executions[0]?.context.signal).toBe(controller.signal);
    expect(provider.signals).toEqual([controller.signal]);
    expect(provider.requests).toHaveLength(1);
    expect(run.events.filter((event) => event.type === "tool_end")).toHaveLength(0);
    expect(run.result.reason).toBe("aborted");
    expect(run.events.some((event) => event.type === "error")).toBe(false);
  });

  it("AL-07：达到 maxSteps 后不多请求 Provider，也不多执行工具", async () => {
    const provider = new FakeProvider([
      [
        { type: "tool_call", index: 0, id: "call-1", name: "echo", arguments: { value: "一次" } },
        { type: "finish", reason: "tool_calls" },
      ],
      [
        { type: "tool_call", index: 0, id: "call-2", name: "echo", arguments: { value: "不应发生" } },
        { type: "finish", reason: "tool_calls" },
      ],
    ]);
    const tool = createValueTool("echo", (value) => ({ output: value, isError: false }));

    const run = await collectRun(createAgent(provider, (registry) => registry.register(tool), 1).run(initialMessages));

    expect(provider.requests).toHaveLength(1);
    expect(tool.executions.map(({ input }) => input)).toEqual([{ value: "一次" }]);
    expect(terminationReasons(run.events)).toEqual(["max_steps"]);
    expect(run.result).toMatchObject({ reason: "max_steps", step: 1 });
  });

  it.each([
    {
      label: "缺少 id",
      events: [
        { type: "tool_call_delta", index: 0, name: "known", argumentsDelta: "{}" },
        { type: "finish", reason: "tool_calls" },
      ] satisfies ProviderEvent[],
    },
    {
      label: "缺少 name",
      events: [
        { type: "tool_call_delta", index: 0, id: "call-1", argumentsDelta: "{}" },
        { type: "finish", reason: "tool_calls" },
      ] satisfies ProviderEvent[],
    },
  ])("AL-08：$label 时拒绝执行且不发布 tool_start", async ({ events }) => {
    const provider = new FakeProvider([events]);
    const tool = new FakeTool({
      name: "known",
      parse: (input) => input,
      execute: () => ({ output: "不应执行", isError: false }),
    });

    const run = await collectRun(createAgent(provider, (registry) => registry.register(tool)).run(initialMessages));

    expect(tool.executions).toHaveLength(0);
    expect(toolStartIds(run.events)).toEqual([]);
    expect(run.result.messages).toEqual(initialMessages);
    expect(run.result.reason).toBe("protocol_error");
  });

  it("AL-08：参数流在 finish 前截断时拒绝执行", async () => {
    const provider = new FakeProvider([
      [{ type: "tool_call_delta", index: 0, id: "call-1", name: "known", argumentsDelta: '{"value":' }],
    ]);
    const tool = createValueTool("known", (value) => ({ output: value, isError: false }));

    const run = await collectRun(createAgent(provider, (registry) => registry.register(tool)).run(initialMessages));

    expect(tool.executions).toHaveLength(0);
    expect(toolStartIds(run.events)).toEqual([]);
    expect(run.result.reason).toBe("protocol_error");
  });

  it("AL-08：arguments 不是合法 JSON object 时拒绝执行", async () => {
    const provider = new FakeProvider([
      [
        { type: "tool_call_delta", index: 0, id: "call-1", name: "known", argumentsDelta: "not-json" },
        { type: "finish", reason: "tool_calls" },
      ],
    ]);
    const tool = createValueTool("known", (value) => ({ output: value, isError: false }));

    const run = await collectRun(createAgent(provider, (registry) => registry.register(tool)).run(initialMessages));

    expect(tool.executions).toHaveLength(0);
    expect(toolStartIds(run.events)).toEqual([]);
    expect(run.result.reason).toBe("protocol_error");
  });

  it("AL-08：工具不存在时拒绝整轮执行", async () => {
    const provider = new FakeProvider([
      [
        { type: "tool_call", index: 0, id: "call-1", name: "missing", arguments: {} },
        { type: "finish", reason: "tool_calls" },
      ],
    ]);

    const run = await collectRun(createAgent(provider).run(initialMessages));

    expect(toolStartIds(run.events)).toEqual([]);
    expect(run.result.messages).toEqual(initialMessages);
    expect(run.result.reason).toBe("protocol_error");
  });

  it("AL-08：任一 schema 解析失败时不执行同轮任何工具", async () => {
    const provider = new FakeProvider([
      [
        { type: "tool_call", index: 0, id: "call-valid", name: "known", arguments: { value: "ok" } },
        { type: "tool_call", index: 1, id: "call-invalid", name: "known", arguments: { value: 42 } },
        { type: "finish", reason: "tool_calls" },
      ],
    ]);
    const tool = createValueTool("known", (value) => ({ output: value, isError: false }));

    const run = await collectRun(createAgent(provider, (registry) => registry.register(tool)).run(initialMessages));

    expect(tool.parseInputs).toHaveLength(2);
    expect(tool.executions).toHaveLength(0);
    expect(toolStartIds(run.events)).toEqual([]);
    expect(run.result.messages).toEqual(initialMessages);
    expect(run.result.reason).toBe("protocol_error");
  });

  it("AL-08：同一 index 混用完整与增量 ToolCall 时拒绝执行", async () => {
    const provider = new FakeProvider([
      [
        { type: "tool_call", index: 0, id: "call-1", name: "known", arguments: { value: "ok" } },
        { type: "tool_call_delta", index: 0, argumentsDelta: "{}" },
        { type: "finish", reason: "tool_calls" },
      ],
    ]);
    const tool = createValueTool("known", (value) => ({ output: value, isError: false }));

    const run = await collectRun(createAgent(provider, (registry) => registry.register(tool)).run(initialMessages));

    expect(tool.executions).toHaveLength(0);
    expect(toolStartIds(run.events)).toEqual([]);
    expect(run.result.reason).toBe("protocol_error");
  });

  it("未知工具执行异常以 internal_error 终止，不伪装成 ToolResult", async () => {
    const provider = new FakeProvider([
      [
        { type: "tool_call", index: 0, id: "call-1", name: "broken", arguments: {} },
        { type: "finish", reason: "tool_calls" },
      ],
    ]);
    const tool = new FakeTool({
      name: "broken",
      parse: (input) => input,
      execute() {
        throw new Error("TOP_SECRET_VALUE");
      },
    });

    const run = await collectRun(createAgent(provider, (registry) => registry.register(tool)).run(initialMessages));

    expect(run.events.filter((event) => event.type === "tool_end")).toHaveLength(0);
    expect(run.result.reason).toBe("internal_error");
    expect(JSON.stringify(run.events)).not.toContain("TOP_SECRET_VALUE");
  });
});
