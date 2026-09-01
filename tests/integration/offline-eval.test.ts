import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { snapshotFiles } from "../../evals/runtime/fixture.js";
import { runScenario } from "../../evals/runtime/runner.js";
import { ScriptedEvalProvider } from "../../evals/runtime/scripted-provider.js";
import { EVALUATION_SCENARIOS } from "../../evals/scenarios/catalog.js";

describe("M6 offline eval", () => {
  it("固定 fixture、客观 grader 与失败场景可离线重复运行", async () => {
    const fixturesRoot = path.join(process.cwd(), "evals", "fixtures", "v1");
    const before = await snapshotFiles(fixturesRoot);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      throw new Error("offline eval 不得访问网络");
    }) as typeof fetch;
    try {
      const results = [];
      for (const scenario of EVALUATION_SCENARIOS) {
        results.push(
          await runScenario(scenario, {
            fixturesRoot,
            model: "scripted-eval-v1",
            provider: new ScriptedEvalProvider(scenario.createOfflineScript(process.execPath)),
          }),
        );
      }
      expect(results).toHaveLength(7);
      expect(results.every((result) => result.passed)).toBe(true);
      expect(results.map((result) => result.terminationReason)).toEqual([
        "complete",
        "complete",
        "complete",
        "complete",
        "max_steps",
        "provider_error",
        "protocol_error",
      ]);
      expect(results.find((result) => result.scenarioId === "EC-EVAL-003")?.metrics.toolFailures).toBe(1);
      expect(results.find((result) => result.scenarioId === "EC-EVAL-004")?.metrics.approvalDenied).toBe(1);
      expect(results.find((result) => result.scenarioId === "EC-EVAL-004")?.metrics.toolExecutions).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(await snapshotFiles(fixturesRoot)).toEqual(before);
  });

  it("真实模式只替换真实预算与 maxSteps，不改变 fixture 和 grader", async () => {
    const scenario = EVALUATION_SCENARIOS[0];
    if (scenario === undefined) {
      throw new Error("缺少评测场景");
    }
    const result = await runScenario(scenario, {
      fixturesRoot: path.join(process.cwd(), "evals", "fixtures", "v1"),
      model: "scripted-real-shape",
      provider: new ScriptedEvalProvider(scenario.createOfflineScript(process.execPath)),
      mode: "real",
    });
    expect(result.passed).toBe(true);
    expect(result.maxSteps).toBe(scenario.realMaxSteps);
  });
});
