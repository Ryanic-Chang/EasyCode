import { renderToString } from "ink";
import { cleanup, render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApprovalBroker, type ApprovalGate } from "../../src/agent/approval.js";
import { AgentLoop } from "../../src/agent/loop.js";
import { AgentSession, DEFAULT_SYSTEM_PROMPT } from "../../src/agent/session.js";
import { type FetchTransport, OpenAICompatibleProvider } from "../../src/llm/openai-compatible/provider.js";
import { Redactor } from "../../src/security/redaction.js";
import { createCodingToolRegistry } from "../../src/tools/coding-tools.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { EasyCodeApp, EasyCodeView } from "../../src/ui/app.js";
import { EMPTY_INPUT } from "../../src/ui/input.js";
import { INITIAL_UI_STATE, uiReducer } from "../../src/ui/model.js";
import { collectAgentRun } from "../agent-run.js";
import { FakeProvider } from "../fake-provider.js";
import { FakeTool } from "../fake-tool.js";
import {
  completionChunk,
  encode,
  responseFromChunks,
  sseData,
  successfulTextResponse,
} from "../fixtures/openai-compatible.js";
import { createTemporaryWorkspace, type TemporaryWorkspace } from "../temp-workspace.js";

const workspaces: TemporaryWorkspace[] = [];

afterEach(async () => {
  cleanup();
  for (const item of workspaces.splice(0)) await item.cleanup();
});

function toolCallResponse(id: string, name: string, args: unknown): Response {
  return responseFromChunks([
    encode(
      [
        sseData(
          completionChunk({
            role: "assistant",
            tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
          }),
        ),
        sseData(completionChunk({}, "tool_calls")),
        sseData({ choices: [], usage: { total_tokens: 3 } }),
        sseData("[DONE]"),
      ].join(""),
    ),
  ]);
}

function highRiskTool(execute = vi.fn(() => ({ output: "command done", isError: false }))) {
  return new FakeTool({
    name: "danger",
    parse: (input) => input,
    approval: () => ({ riskCategory: "command_execution", actionSummary: "node verify.mjs · . · 30000 ms" }),
    execute,
  });
}

describe("M5 离线端到端恢复场景", () => {
  it("场景 1：429 重试成功，调用 read_file 后最终 complete，retry 不增加 Agent step", async () => {
    const workspace = await createTemporaryWorkspace();
    workspaces.push(workspace);
    await workspace.write("note.txt", "fixture content\n");
    const responses = [
      new Response("limited", { status: 429 }),
      toolCallResponse("read-1", "read_file", { path: "note.txt" }),
      successfulTextResponse("读取完成"),
    ];
    const fetch = vi.fn<FetchTransport>(async () => responses.shift() ?? successfulTextResponse("unexpected"));
    const provider = new OpenAICompatibleProvider(
      { apiKey: "fixture-key", baseUrl: new URL("https://example.test/v1") },
      { fetch, retry: { maxRetries: 1, baseDelayMs: 1 }, sleep: async () => undefined, random: () => 0.5 },
    );
    const run = await collectAgentRun(
      new AgentLoop({
        provider,
        tools: createCodingToolRegistry(),
        model: "fixture",
        cwd: workspace.root,
        maxSteps: 2,
      }).run([{ role: "user", content: "读取 note" }]),
    );
    expect(run.result).toMatchObject({ reason: "complete", step: 2 });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(run.events.filter((event) => event.type === "provider_retry")).toHaveLength(1);
    expect(run.events.filter((event) => event.type === "tool_start")).toHaveLength(1);
  });

  it("场景 2：TUI 显示逐次确认，用户允许后工具只执行一次并 complete", async () => {
    const broker = new ApprovalBroker();
    const tool = highRiskTool();
    const tools = new ToolRegistry();
    tools.register(tool);
    const provider = new FakeProvider([
      [
        { type: "tool_call", index: 0, id: "danger-1", name: "danger", arguments: {} },
        { type: "finish", reason: "tool_calls" },
      ],
      [
        { type: "text_delta", delta: "命令完成" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const session = new AgentSession(
      new AgentLoop({
        provider,
        tools,
        model: "fixture",
        cwd: "fixture",
        maxSteps: 2,
        approvalGate: broker,
        approvalIdFactory: () => "approval-e2e",
      }),
      broker,
    );
    const instance = render(
      <EasyCodeApp runner={session} model="fixture" workspace="fixture" colorEnabled={false} columns={40} />,
    );
    instance.stdin.write("运行验证");
    instance.stdin.write("\r");
    await vi.waitFor(() => expect(instance.lastFrame()).toContain("[确认] danger"));
    instance.stdin.write("y");
    await vi.waitFor(() => expect(instance.lastFrame()).toContain("命令完成"));
    expect(tool.executions).toHaveLength(1);
    expect(instance.lastFrame()).toContain("[已允许] danger");
  });

  it("场景 3：用户拒绝后 Tool 不执行，失败 ToolResult 回传模型并允许修正", async () => {
    const tool = highRiskTool();
    const tools = new ToolRegistry();
    tools.register(tool);
    const deny: ApprovalGate = { request: async (request) => ({ approvalId: request.approvalId, approved: false }) };
    const provider = new FakeProvider([
      [
        { type: "tool_call", index: 0, id: "danger-2", name: "danger", arguments: {} },
        { type: "finish", reason: "tool_calls" },
      ],
      [
        { type: "text_delta", delta: "改用安全方案" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const run = await collectAgentRun(
      new AgentLoop({ provider, tools, model: "fixture", cwd: "fixture", maxSteps: 2, approvalGate: deny }).run([
        { role: "user", content: "测试拒绝" },
      ]),
    );
    expect(run.result.reason).toBe("complete");
    expect(tool.executions).toHaveLength(0);
    expect(provider.requests[1]?.messages.at(-1)).toMatchObject({
      role: "tool",
      isError: true,
      metadata: { kind: "approval_denied" },
    });
    expect(run.events.some((event) => event.type === "tool_start")).toBe(false);
  });

  it("场景 4：等待确认时 abort 清除 pending，Tool 不执行且 Session 回滚", async () => {
    const broker = new ApprovalBroker();
    const tool = highRiskTool();
    const tools = new ToolRegistry();
    tools.register(tool);
    const provider = new FakeProvider([
      [
        { type: "tool_call", index: 0, id: "danger-3", name: "danger", arguments: {} },
        { type: "finish", reason: "tool_calls" },
      ],
    ]);
    const session = new AgentSession(
      new AgentLoop({ provider, tools, model: "fixture", cwd: "fixture", maxSteps: 1, approvalGate: broker }),
      broker,
    );
    const controller = new AbortController();
    const stream = session.submit("取消确认", { signal: controller.signal });
    let sawApproval = false;
    while (!sawApproval) {
      const next = await stream.next();
      if (!next.done && next.value.event.type === "approval_required") sawApproval = true;
    }
    const pendingNext = stream.next();
    await vi.waitFor(() => expect(broker.pendingCount()).toBe(1));
    controller.abort();
    let result = await pendingNext;
    while (!result.done) result = await stream.next();
    expect(result.value.reason).toBe("aborted");
    expect(broker.pendingCount()).toBe(0);
    expect(tool.executions).toHaveLength(0);
    expect(session.snapshot()).toEqual([{ role: "system", content: DEFAULT_SYSTEM_PROMPT }]);
  });

  it("场景 5：SSE 已输出文本后断流不重试、不执行工具并安全终止", async () => {
    const response = responseFromChunks([encode(sseData(completionChunk({ role: "assistant", content: "半截输出" })))]);
    const fetch = vi.fn<FetchTransport>().mockResolvedValue(response);
    const provider = new OpenAICompatibleProvider(
      { apiKey: "fixture-key", baseUrl: new URL("https://example.test/v1") },
      { fetch, retry: { maxRetries: 2, baseDelayMs: 1 }, sleep: async () => undefined },
    );
    const run = await collectAgentRun(
      new AgentLoop({ provider, tools: new ToolRegistry(), model: "fixture", cwd: "fixture", maxSteps: 1 }).run([
        { role: "user", content: "测试断流" },
      ]),
    );
    expect(fetch).toHaveBeenCalledOnce();
    expect(run.result.reason).toBe("provider_error");
    expect(run.events.map((event) => event.type)).toEqual(["turn_start", "assistant_delta", "error", "complete"]);
    expect(run.result.messages).toEqual([{ role: "user", content: "测试断流" }]);
  });

  it("场景 6：恶意 ToolResult 不会泄露到 Provider、AgentEvent 或 TUI", async () => {
    const secret = "fixture-malicious-secret";
    const metadata: Record<string, unknown> = { password: secret, stdout: `Bearer ${secret}` };
    metadata.self = metadata;
    const tool = new FakeTool({
      name: "malicious",
      parse: (input) => input,
      execute: () => ({ output: `${secret}${"🙂".repeat(20_000)}`, isError: false, metadata }),
    });
    const tools = new ToolRegistry();
    tools.register(tool);
    const provider = new FakeProvider([
      [
        { type: "tool_call", index: 0, id: "malicious-1", name: "malicious", arguments: {} },
        { type: "finish", reason: "tool_calls" },
      ],
      [
        { type: "text_delta", delta: "安全完成" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const run = await collectAgentRun(
      new AgentLoop({
        provider,
        tools,
        model: "fixture",
        cwd: "fixture",
        maxSteps: 2,
        redactor: new Redactor({ secrets: [secret] }),
      }).run([{ role: "user", content: "测试恶意工具" }]),
    );
    let state = uiReducer(INITIAL_UI_STATE, { type: "submit", runId: 1, task: "测试恶意工具" });
    for (const event of run.events) state = uiReducer(state, { type: "agent_event", runId: 1, event });
    const frame = renderToString(
      <EasyCodeView
        state={state}
        input={EMPTY_INPUT}
        model="fixture"
        workspace="fixture"
        colorEnabled={false}
        columns={40}
      />,
    );
    expect(JSON.stringify(provider.requests[1])).not.toContain(secret);
    expect(JSON.stringify(run.events)).not.toContain(secret);
    expect(frame).not.toContain(secret);
    expect(provider.requests[1]?.messages.at(-1)).toMatchObject({
      role: "tool",
      metadata: { outputTruncated: true, metadataTruncated: true },
    });
  });
});
