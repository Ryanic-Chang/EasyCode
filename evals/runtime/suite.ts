import * as path from "node:path";

import type { Provider } from "../../src/llm/provider.js";
import type { EvaluationMode, EvaluationReport, EvaluationScenario, ScenarioEvaluationResult } from "../core/types.js";
import { EVALUATION_SCHEMA_VERSION, EVALUATION_SUITE_VERSION } from "../core/types.js";
import { collectMetadata } from "../report/metadata.js";
import { createReport, summarize, writeReportAtomic } from "../report/report.js";
import { runScenario } from "./runner.js";

export interface SuiteRunOptions {
  readonly root: string;
  readonly mode: EvaluationMode;
  readonly model: string;
  readonly seed: number;
  readonly command: string;
  readonly retry: { readonly maxRetries: number; readonly baseDelayMs: number; readonly requestTimeoutMs: number };
  readonly scenarios: readonly EvaluationScenario[];
  createProvider(scenario: EvaluationScenario): Provider;
}

function infrastructureFailure(scenario: EvaluationScenario, mode: EvaluationMode): ScenarioEvaluationResult {
  const maxSteps = mode === "real" ? (scenario.realMaxSteps ?? scenario.maxSteps) : scenario.maxSteps;
  return {
    scenarioId: scenario.id,
    scenarioVersion: scenario.version,
    fixtureVersion: scenario.fixtureVersion,
    maxSteps,
    passed: false,
    terminationReason: "internal_error",
    errorCode: "internal_error",
    grade: {
      passed: false,
      changedFiles: [],
      assertions: [{ id: "evaluation-infrastructure", passed: false, expected: true, actual: false }],
    },
    metrics: {
      providerRounds: 0,
      providerAttempts: 0,
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
      terminationReason: "internal_error",
      errorCode: "internal_error",
    },
  };
}

export async function runSuite(
  options: SuiteRunOptions,
): Promise<{ readonly report: EvaluationReport; readonly path: string }> {
  const metadata = await collectMetadata({
    root: options.root,
    mode: options.mode,
    model: options.model,
    seed: options.seed,
    command: options.command,
    retry: options.retry,
  });
  const fixturesRoot = path.join(options.root, "evals", "fixtures", "v1");
  const results: ScenarioEvaluationResult[] = [];
  for (const scenario of options.scenarios) {
    try {
      results.push(
        await runScenario(scenario, {
          fixturesRoot,
          model: options.model,
          provider: options.createProvider(scenario),
          mode: options.mode,
        }),
      );
    } catch {
      results.push(infrastructureFailure(scenario, options.mode));
    }
  }
  const report = createReport({
    schemaVersion: EVALUATION_SCHEMA_VERSION,
    suiteVersion: EVALUATION_SUITE_VERSION,
    metadata,
    scenarios: results,
    summary: summarize(results),
  });
  const reportPath = await writeReportAtomic(path.join(options.root, ".easycode", "evals"), report);
  return { report, path: reportPath };
}
