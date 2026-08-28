import { describe, expect, it, vi } from "vitest";

import { ApprovalBroker, type ApprovalGate } from "../../src/agent/approval.js";
import { AgentLoop } from "../../src/agent/loop.js";
import { Redactor } from "../../src/security/redaction.js";
import { createCodingToolRegistry } from "../../src/tools/coding-tools.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { collectAgentRun } from "../agent-run.js";
import { FakeProvider } from "../fake-provider.js";
import { FakeTool } from "../fake-tool.js";

const request = {
  approvalId: "approval-1",
  step: 1,
  toolCallId: "call-1",
  toolName: "danger",
  riskCategory: "command_execution",
  actionSummary: "执行 fixture",
} as const;

describe("M5 ApprovalBroker", () => {
  it("decision 精确绑定 ID 且只能消费一次，未知、过期和重复 ID 不生效", async () => {
    const broker = new ApprovalBroker();
    const controller = new AbortController();
    const pending = broker.request(request, { signal: controller.signal });
    expect(broker.pendingCount()).toBe(1);
    expect(broker.resolve({ approvalId: "unknown", approved: true })).toBe(false);
    expect(broker.resolve({ approvalId: request.approvalId, approved: true })).toBe(true);
    await expect(pending).resolves.toEqual({ approvalId: request.approvalId, approved: true });
    expect(broker.resolve({ approvalId: request.approvalId, approved: true })).toBe(false);
    expect(broker.pendingCount()).toBe(0);
  });

  it("abort 和 dispose 拒绝并清除 pending approval", async () => {
    const abortedBroker = new ApprovalBroker();
    const controller = new AbortController();
    const aborted = abortedBroker.request(request, { signal: controller.signal });
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
    expect(abortedBroker.pendingCount()).toBe(0);

    const disposedBroker = new ApprovalBroker();
    const disposed = disposedBroker.request(request, { signal: new AbortController().signal });
    disposedBroker.dispose();
    await expect(disposed).rejects.toMatchObject({ name: "AbortError" });
    expect(disposedBroker.pendingCount()).toBe(0);
  });
});

function scriptedToolCall(id: string) {
  return [
    { type: "tool_call", index: 0, id, name: "danger", arguments: { value: id } } as const,
    { type: "finish", reason: "tool_calls" } as const,
  ];
}

describe("M5 Agent Approval Gate", () => {
  it.each([
    [true, 1, false],
    [false, 0, true],
  ])("approved=%s 时 execute 次数=%s，并以结构化 ToolResult 回传", async (approved, calls, isError) => {
    const tool = new FakeTool({
      name: "danger",
      parse: (input) => input,
      approval: () => ({ riskCategory: "fixture", actionSummary: "单次动作" }),
      execute: () => ({ output: "done", isError: false }),
    });
    const registry = new ToolRegistry();
    registry.register(tool);
    const gate: ApprovalGate = { request: async (item) => ({ approvalId: item.approvalId, approved }) };
    const provider = new FakeProvider([
      scriptedToolCall("call-1"),
      [
        { type: "text_delta", delta: "完成" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const run = await collectAgentRun(
      new AgentLoop({
        provider,
        tools: registry,
        model: "fake",
        cwd: "fixture",
        maxSteps: 2,
        approvalGate: gate,
        approvalIdFactory: () => "approval-fixture",
      }).run([{ role: "user", content: "测试" }]),
    );

    expect(tool.executions).toHaveLength(calls);
    expect(provider.requests[1]?.messages.at(-1)).toMatchObject({ role: "tool", isError });
    const types = run.events.map((event) => event.type);
    expect(types).toContain("approval_required");
    expect(types).toContain("approval_resolved");
    expect(types.filter((type) => type === "tool_start")).toHaveLength(calls);
  });

  it("默认拒绝；parse 硬拒绝发生在 approval 之前", async () => {
    const gate = { request: vi.fn(async () => ({ approvalId: "unused", approved: true })) };
    const tool = new FakeTool({
      name: "danger",
      parse: () => {
        throw new Error("hard reject");
      },
      approval: () => ({ riskCategory: "fixture", actionSummary: "不应出现" }),
      execute: () => ({ output: "never", isError: false }),
    });
    const registry = new ToolRegistry();
    registry.register(tool);
    const provider = new FakeProvider([scriptedToolCall("bad")]);
    const run = await collectAgentRun(
      new AgentLoop({
        provider,
        tools: registry,
        model: "fake",
        cwd: "fixture",
        maxSteps: 1,
        approvalGate: gate,
      }).run([{ role: "user", content: "测试" }]),
    );
    expect(run.result.reason).toBe("protocol_error");
    expect(gate.request).not.toHaveBeenCalled();
    expect(tool.executions).toHaveLength(0);
  });

  it("Approval Gate 未知异常脱敏为 internal_error，不执行工具", async () => {
    const tool = new FakeTool({
      name: "danger",
      parse: (input) => input,
      approval: () => ({ riskCategory: "fixture", actionSummary: "单次动作" }),
      execute: () => ({ output: "never", isError: false }),
    });
    const registry = new ToolRegistry();
    registry.register(tool);
    const provider = new FakeProvider([scriptedToolCall("approval-error")]);
    const run = await collectAgentRun(
      new AgentLoop({
        provider,
        tools: registry,
        model: "fake",
        cwd: "fixture",
        maxSteps: 1,
        approvalGate: {
          request: async () => {
            throw new Error("SENSITIVE_APPROVAL_DETAIL");
          },
        },
      }).run([{ role: "user", content: "测试" }]),
    );
    expect(run.result.reason).toBe("internal_error");
    expect(run.events.find((event) => event.type === "error")).toMatchObject({
      error: { code: "internal_error", recoverable: true },
    });
    expect(JSON.stringify(run.events)).not.toContain("SENSITIVE_APPROVAL_DETAIL");
    expect(tool.executions).toHaveLength(0);
  });

  it("同轮多个高风险调用逐个授权，一个批准不能授权下一调用", async () => {
    const tool = new FakeTool({
      name: "danger",
      parse: (input) => input,
      approval: () => ({ riskCategory: "fixture", actionSummary: "单次动作" }),
      execute: () => ({ output: "done", isError: false }),
    });
    const registry = new ToolRegistry();
    registry.register(tool);
    const requests: string[] = [];
    const decisions = [true, false];
    const gate: ApprovalGate = {
      request: async (item) => {
        requests.push(item.approvalId);
        return { approvalId: item.approvalId, approved: decisions.shift() ?? false };
      },
    };
    const ids = ["approval-first", "approval-second"];
    const provider = new FakeProvider([
      [
        { type: "tool_call", index: 0, id: "call-first", name: "danger", arguments: {} },
        { type: "tool_call", index: 1, id: "call-second", name: "danger", arguments: {} },
        { type: "finish", reason: "tool_calls" },
      ],
      [
        { type: "text_delta", delta: "完成" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const run = await collectAgentRun(
      new AgentLoop({
        provider,
        tools: registry,
        model: "fake",
        cwd: "fixture",
        maxSteps: 2,
        approvalGate: gate,
        approvalIdFactory: () => ids.shift() ?? "unexpected",
      }).run([{ role: "user", content: "测试" }]),
    );
    expect(requests).toEqual(["approval-first", "approval-second"]);
    expect(tool.executions).toHaveLength(1);
    expect(run.events.filter((event) => event.type === "approval_required")).toHaveLength(2);
    expect(provider.requests[1]?.messages.filter((message) => message.role === "tool")).toHaveLength(2);
  });

  it("生产注册表只有 run_command 声明逐调用确认，其他四个工具无需确认", () => {
    const registry = createCodingToolRegistry();
    expect(registry.prepare("list_directory", { path: "." })?.approvalRequirement).toBeUndefined();
    expect(registry.prepare("search_files", { query: "x", path: "." })?.approvalRequirement).toBeUndefined();
    expect(registry.prepare("read_file", { path: "x" })?.approvalRequirement).toBeUndefined();
    expect(
      registry.prepare("apply_patch", { operation: "create", path: "x", content: "x" })?.approvalRequirement,
    ).toBeUndefined();
    expect(
      registry.prepare("run_command", { executable: "node", args: [], cwd: "." })?.approvalRequirement,
    ).toMatchObject({
      riskCategory: "command_execution",
    });
  });

  it("确认摘要在 Agent 边界脱敏并截断", async () => {
    const secret = "fixture-approval-secret";
    const tool = new FakeTool({
      name: "danger",
      parse: (input) => input,
      approval: () => ({ riskCategory: secret, actionSummary: `${secret}${"🙂".repeat(1_000)}` }),
      execute: () => ({ output: "never", isError: false }),
    });
    const registry = new ToolRegistry();
    registry.register(tool);
    const provider = new FakeProvider([
      scriptedToolCall("summary"),
      [
        { type: "text_delta", delta: "完成" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const run = await collectAgentRun(
      new AgentLoop({
        provider,
        tools: registry,
        model: "fake",
        cwd: "fixture",
        maxSteps: 2,
        redactor: new Redactor({ secrets: [secret] }),
      }).run([{ role: "user", content: "测试" }]),
    );
    const required = run.events.find((event) => event.type === "approval_required");
    expect(JSON.stringify(required)).not.toContain(secret);
    if (required?.type === "approval_required") {
      expect(Buffer.byteLength(required.request.actionSummary, "utf8")).toBeLessThanOrEqual(1_024);
    }
    expect(tool.executions).toHaveLength(0);
  });
});
