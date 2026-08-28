import { describe, expect, it } from "vitest";

import type { AgentEvent } from "../../src/agent/events.js";
import { MetricsCollector } from "../../src/metrics/collector.js";

function clock(values: readonly number[]): () => number {
  let index = 0;
  return () => values[index++] ?? values.at(-1) ?? 0;
}

describe("M6 指标采集", () => {
  it("准确统计 round、attempt、retry、工具、approval、usage 与注入时钟耗时", () => {
    const collector = new MetricsCollector(clock([0, 2, 3, 4, 7, 8, 12, 13, 14, 20]));
    const events: AgentEvent[] = [
      { type: "turn_start", step: 1 },
      {
        type: "provider_retry",
        step: 1,
        attempt: 1,
        maxRetries: 2,
        delayMs: 10,
        error: { code: "provider_network", message: "safe", recoverable: true },
      },
      { type: "usage", step: 1, usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 } },
      {
        type: "approval_required",
        step: 1,
        request: {
          approvalId: "approval-1",
          step: 1,
          toolCallId: "call-1",
          toolName: "run_command",
          riskCategory: "command_execution",
          actionSummary: "safe",
        },
      },
      {
        type: "approval_resolved",
        step: 1,
        approvalId: "approval-1",
        toolCallId: "call-1",
        toolName: "run_command",
        approved: true,
      },
      {
        type: "tool_start",
        step: 1,
        toolCall: { id: "call-1", name: "run_command", arguments: {} },
      },
      {
        type: "tool_end",
        step: 1,
        result: { toolCallId: "call-1", toolName: "run_command", output: "safe", isError: false },
      },
      { type: "turn_start", step: 2 },
      { type: "usage", step: 2, usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 } },
      { type: "complete", step: 2, reason: "complete" },
    ];
    for (const event of events) {
      collector.consume(event);
    }

    expect(collector.snapshot()).toEqual({
      providerRounds: 2,
      providerAttempts: 3,
      providerRetries: 1,
      toolCallsRequested: 1,
      toolExecutions: 1,
      toolSuccesses: 1,
      toolFailures: 0,
      approvalRequests: 1,
      approvalAllowed: 1,
      approvalDenied: 0,
      usage: { inputTokens: 22, outputTokens: 7, totalTokens: 29, roundsWithUsage: 2, complete: true },
      durations: { totalMs: 20, providerMs: 11, toolMs: 4, approvalMs: 3 },
      terminationReason: "complete",
    });
  });

  it("缺失 usage 保持 unknown，绝不伪造为 0", () => {
    const collector = new MetricsCollector(clock([0, 1, 2, 3]));
    collector.consume({ type: "turn_start", step: 1 });
    collector.consume({ type: "complete", step: 1, reason: "complete" });
    expect(collector.snapshot().usage).toEqual({ roundsWithUsage: 0, complete: false });
  });

  it("拒绝倒退的时间源", () => {
    const collector = new MetricsCollector(clock([2, 1]));
    collector.consume({ type: "turn_start", step: 1 });
    expect(() => collector.consume({ type: "complete", step: 1, reason: "complete" })).toThrow("单调");
  });
});
