import { writeFile } from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { ExactEvalApprovalGate } from "../../evals/runtime/approval.js";
import { createIsolatedFixture, snapshotFiles } from "../../evals/runtime/fixture.js";
import { gradeScenario } from "../../evals/runtime/grader.js";
import { EVALUATION_SCENARIOS } from "../../evals/scenarios/catalog.js";
import type { AgentMetrics } from "../../src/metrics/collector.js";
import { RunCommandTool } from "../../src/tools/run-command.js";

const EMPTY_METRICS: AgentMetrics = {
  providerRounds: 99,
  providerAttempts: 99,
  providerRetries: 0,
  toolCallsRequested: 0,
  toolExecutions: 0,
  toolSuccesses: 0,
  toolFailures: 0,
  approvalRequests: 0,
  approvalAllowed: 0,
  approvalDenied: 0,
  usage: { roundsWithUsage: 0, complete: false },
  durations: { totalMs: 0, providerMs: 0, toolMs: 0, approvalMs: 0 },
  terminationReason: "complete",
};

describe("M6 客观 grader", () => {
  it("预算超限和目标内容失败都会让场景失败", async () => {
    const scenario = EVALUATION_SCENARIOS[0];
    if (scenario === undefined) {
      throw new Error("缺少固定评测场景");
    }
    const fixturesRoot = path.join(process.cwd(), "evals", "fixtures", "v1");
    const fixture = await createIsolatedFixture(fixturesRoot, scenario.fixture);
    try {
      const before = await snapshotFiles(fixture.root);
      const sourceRoot = path.join(fixturesRoot, scenario.fixture);
      const sourceBefore = await snapshotFiles(sourceRoot);
      const grade = await gradeScenario({
        scenario,
        workspace: fixture.root,
        before,
        sourceBefore,
        sourceAfter: await snapshotFiles(sourceRoot),
        terminationReason: "complete",
        metrics: EMPTY_METRICS,
      });
      expect(grade.passed).toBe(false);
      expect(grade.assertions.find(({ id }) => id === "budget-provider-rounds")?.passed).toBe(false);
      expect(grade.assertions.find(({ id }) => id === "value-updated")?.passed).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it("验证脚本被修改后，即使命令摘要精确匹配也拒绝批准", async () => {
    const scenario = EVALUATION_SCENARIOS[0];
    if (scenario === undefined) {
      throw new Error("缺少固定评测场景");
    }
    const fixturesRoot = path.join(process.cwd(), "evals", "fixtures", "v1");
    const fixture = await createIsolatedFixture(fixturesRoot, scenario.fixture);
    try {
      const initial = await snapshotFiles(fixture.root);
      const gate = new ExactEvalApprovalGate(scenario.allowedCommands, process.execPath, fixture.root, initial);
      await writeFile(path.join(fixture.root, "verify.mjs"), "process.exit(0);\n", "utf8");
      const command = scenario.allowedCommands[0];
      if (command === undefined) {
        throw new Error("场景缺少验证命令");
      }
      const tool = new RunCommandTool();
      const requirement = tool.approval(
        tool.parse({
          executable: process.execPath,
          args: command.args,
          cwd: command.cwd,
          timeoutMs: command.timeoutMs,
        }),
      );
      await expect(
        gate.request(
          {
            approvalId: "approval-1",
            step: 1,
            toolCallId: "call-1",
            toolName: "run_command",
            ...requirement,
          },
          { signal: new AbortController().signal },
        ),
      ).resolves.toEqual({ approvalId: "approval-1", approved: false });
    } finally {
      await fixture.cleanup();
    }
  });
});
