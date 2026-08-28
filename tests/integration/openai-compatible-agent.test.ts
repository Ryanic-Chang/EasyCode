import { describe, expect, it } from "vitest";

import { AgentLoop } from "../../src/agent/loop.js";
import { OpenAICompatibleProvider } from "../../src/llm/openai-compatible/provider.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { collectAgentRun } from "../agent-run.js";
import { FakeTool } from "../fake-tool.js";
import {
  completionChunk,
  encode,
  recordFetch,
  responseFromChunks,
  sseData,
  successfulTextResponse,
} from "../fixtures/openai-compatible.js";

describe("OpenAI-compatible Provider 与 Agent Loop 集成", () => {
  it("离线 fixture 可驱动 Agent 完成一次纯文本轮次", async () => {
    const recorder = recordFetch(successfulTextResponse("离线完成"));
    const provider = new OpenAICompatibleProvider(
      { apiKey: "fixture-key", baseUrl: new URL("https://example.test/v1") },
      { fetch: recorder.fetch },
    );
    const loop = new AgentLoop({
      provider,
      tools: new ToolRegistry(),
      model: "fixture-model",
      cwd: "C:\\fixture",
      maxSteps: 1,
    });

    const run = await collectAgentRun(loop.run([{ role: "user", content: "开始" }]));

    expect(run.result.reason).toBe("complete");
    expect(run.events).toEqual([
      { type: "turn_start", step: 1 },
      { type: "assistant_delta", step: 1, delta: "离线完成" },
      { type: "usage", step: 1, usage: { totalTokens: 3 } },
      { type: "complete", step: 1, reason: "complete" },
    ]);
    expect(recorder.calls).toHaveLength(1);
  });

  it("跨 chunk ToolCall 经 Agent 组装执行后，以结构化 ToolResult 进入下一轮请求", async () => {
    const first = [
      sseData(
        completionChunk({
          tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "lookup", arguments: '{"pa' } }],
        }),
      ),
      sseData(completionChunk({ tool_calls: [{ index: 0, function: { arguments: 'th":"src/main.ts"}' } }] })),
      sseData(completionChunk({}, "tool_calls")),
      sseData("[DONE]"),
    ].join("");
    const responses = [
      responseFromChunks([encode(first.slice(0, 37)), encode(first.slice(37))]),
      successfulTextResponse(),
    ];
    const recorder = recordFetch(() => {
      const response = responses.shift();
      if (response === undefined) {
        throw new Error("fixture 响应已耗尽");
      }
      return response;
    });
    const provider = new OpenAICompatibleProvider(
      { apiKey: "fixture-key", baseUrl: new URL("https://example.test/v1") },
      { fetch: recorder.fetch },
    );
    const tool = new FakeTool<{ readonly path: string }>({
      name: "lookup",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      parse(input) {
        if (typeof input !== "object" || input === null || !("path" in input) || typeof input.path !== "string") {
          throw new Error("非法 fixture 参数");
        }
        return { path: input.path };
      },
      execute(input) {
        return { output: `已读取 ${input.path}`, isError: false, metadata: { bytes: 12 } };
      },
    });
    const tools = new ToolRegistry();
    tools.register(tool);
    const loop = new AgentLoop({ provider, tools, model: "fixture-model", cwd: "C:\\fixture", maxSteps: 2 });

    const run = await collectAgentRun(loop.run([{ role: "user", content: "开始" }]));

    expect(run.result.reason).toBe("complete");
    expect(tool.executions).toHaveLength(1);
    expect(tool.executions[0]?.input).toEqual({ path: "src/main.ts" });
    expect(recorder.calls).toHaveLength(2);
    const secondBody = JSON.parse(String(recorder.calls[1]?.init?.body));
    expect(secondBody.messages).toEqual([
      { role: "user", content: "开始" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "lookup", arguments: '{"path":"src/main.ts"}' },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call-1",
        content:
          '{"easycode_tool_result":{"tool_name":"lookup","is_error":false,"output":"已读取 src/main.ts","metadata":{"bytes":12}}}',
      },
    ]);
  });

  it("具体 Provider 的截断 ToolCall 不进入历史也不执行工具", async () => {
    const partial = sseData(
      completionChunk({
        tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "lookup", arguments: '{"path":' } }],
      }),
    );
    const recorder = recordFetch(responseFromChunks([encode(partial)]));
    const provider = new OpenAICompatibleProvider(
      { apiKey: "fixture-key", baseUrl: new URL("https://example.test/v1") },
      { fetch: recorder.fetch },
    );
    const tool = new FakeTool<Record<string, unknown>>({
      name: "lookup",
      parse(input) {
        if (typeof input !== "object" || input === null || Array.isArray(input)) {
          throw new Error("非法 fixture 参数");
        }
        return { ...input };
      },
      execute() {
        return { output: "不应执行", isError: false };
      },
    });
    const tools = new ToolRegistry();
    tools.register(tool);
    const loop = new AgentLoop({ provider, tools, model: "fixture-model", cwd: "C:\\fixture", maxSteps: 1 });

    const run = await collectAgentRun(loop.run([{ role: "user", content: "开始" }]));

    expect(run.result.reason).toBe("provider_error");
    expect(run.result.messages).toEqual([{ role: "user", content: "开始" }]);
    expect(tool.parseInputs).toHaveLength(0);
    expect(tool.executions).toHaveLength(0);
    expect(run.events.some((event) => event.type === "tool_start")).toBe(false);
  });
});
