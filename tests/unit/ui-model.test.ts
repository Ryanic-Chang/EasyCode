import { describe, expect, it } from "vitest";

import type { AgentEvent } from "../../src/agent/events.js";
import type { TranscriptItem } from "../../src/ui/model.js";
import { INITIAL_UI_STATE, MAX_ASSISTANT_GRAPHEMES, MAX_TRANSCRIPT_ITEMS, uiReducer } from "../../src/ui/model.js";

function event(state: typeof INITIAL_UI_STATE, runId: number, value: AgentEvent) {
  return uiReducer(state, { type: "agent_event", runId, event: value });
}

describe("TUI AgentEvent reducer", () => {
  it("按顺序累计 assistant delta，新 turn 保留上一轮文本", () => {
    let state = uiReducer(INITIAL_UI_STATE, { type: "submit", runId: 1, task: "修复测试" });
    state = event(state, 1, { type: "turn_start", step: 1 });
    state = event(state, 1, { type: "assistant_delta", step: 1, delta: "正在" });
    state = event(state, 1, { type: "assistant_delta", step: 1, delta: "分析" });
    state = event(state, 1, { type: "turn_start", step: 2 });

    expect(state.transcript.filter((item) => item.type === "assistant")).toEqual([
      { id: "run-1-assistant-1", type: "assistant", step: 1, text: "正在分析", done: true },
    ]);
  });

  it("多个工具按事件顺序展示，并把 tool_end 关联到正确调用", () => {
    let state = uiReducer(INITIAL_UI_STATE, { type: "submit", runId: 3, task: "检查" });
    state = event(state, 3, { type: "turn_start", step: 1 });
    state = event(state, 3, {
      type: "tool_start",
      step: 1,
      toolCall: { id: "a", name: "read_file", arguments: { path: "a.ts" } },
    });
    state = event(state, 3, {
      type: "tool_start",
      step: 1,
      toolCall: { id: "b", name: "run_command", arguments: { executable: "node", args: [], cwd: "." } },
    });
    state = event(state, 3, {
      type: "tool_end",
      step: 1,
      result: { toolCallId: "b", toolName: "run_command", output: "exit 1", isError: true },
    });

    const tools = state.transcript.filter((item) => item.type === "tool");
    expect(tools.map((item) => item.toolCallId)).toEqual(["a", "b"]);
    expect(tools.map((item) => item.status)).toEqual(["running", "failure"]);
  });

  it("终止只提交一次，迟到或旧 run 事件均被忽略", () => {
    let state = uiReducer(INITIAL_UI_STATE, { type: "submit", runId: 1, task: "任务" });
    state = event(state, 1, { type: "complete", step: 1, reason: "complete" });
    const terminal = state;
    state = event(state, 1, { type: "assistant_delta", step: 1, delta: "迟到" });
    state = event(state, 1, { type: "complete", step: 1, reason: "aborted" });
    state = event(state, 99, { type: "turn_start", step: 1 });
    expect(state).toEqual(terminal);
    expect(state.transcript.filter((item) => item.type === "complete")).toHaveLength(1);
  });

  it("支持 cancelling、错误、主要终止原因并重新回到 idle", () => {
    let state = uiReducer(INITIAL_UI_STATE, { type: "submit", runId: 2, task: "任务" });
    state = uiReducer(state, { type: "cancelling", runId: 2 });
    expect(state.phase).toBe("cancelling");
    state = event(state, 2, {
      type: "error",
      step: 1,
      error: { code: "provider_server", message: "模型服务不可用", recoverable: false },
    });
    state = event(state, 2, { type: "complete", step: 1, reason: "provider_error" });
    expect(state.phase).toBe("idle");
    expect(state.currentError?.code).toBe("provider_server");
    expect(state.terminationReason).toBe("provider_error");
  });

  it("限制 assistant 字符与 transcript 项数", () => {
    let state = uiReducer(INITIAL_UI_STATE, { type: "submit", runId: 1, task: "任务" });
    state = event(state, 1, {
      type: "assistant_delta",
      step: 1,
      delta: "x".repeat(MAX_ASSISTANT_GRAPHEMES + 20),
    });
    const assistant = state.transcript.find(
      (item): item is Extract<TranscriptItem, { readonly type: "assistant" }> => item.type === "assistant",
    );
    expect(assistant?.text).toHaveLength(MAX_ASSISTANT_GRAPHEMES);
    expect(assistant?.text).toContain("[已截断]");

    for (let runId = 1; runId <= MAX_TRANSCRIPT_ITEMS; runId += 1) {
      state = event(state, runId, { type: "complete", step: 1, reason: "complete" });
      state = uiReducer(state, { type: "submit", runId: runId + 1, task: `任务 ${runId}` });
    }
    expect(state.transcript.length).toBeLessThanOrEqual(MAX_TRANSCRIPT_ITEMS);
  });

  it("在 assistant 文本边界处保留完整 Unicode 字素", () => {
    const submitted = uiReducer(INITIAL_UI_STATE, { type: "submit", runId: 1, task: "测试" });
    const state = event(submitted, 1, {
      type: "assistant_delta",
      step: 1,
      delta: `${"x".repeat(MAX_ASSISTANT_GRAPHEMES - 7)}👩‍💻中文尾部追加内容`,
    });
    const assistant = state.transcript.find((item) => item.type === "assistant");
    expect(assistant?.text).not.toContain("�");
    expect(assistant?.text).toContain("👩‍💻");
    expect(assistant?.text).toContain("[已截断]");
  });
});
