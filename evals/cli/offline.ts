import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { ScriptedEvalProvider } from "../runtime/scripted-provider.js";
import { runSuite } from "../runtime/suite.js";
import { EVALUATION_SCENARIOS } from "../scenarios/catalog.js";

const OFFLINE_MODEL = "scripted-eval-v1";
const OFFLINE_SEED = 20260828;

export function evaluationExitCode(failedScenarios: number): number {
  return failedScenarios === 0 ? 0 : 1;
}

export async function runOfflineEvaluation(root = process.cwd()): Promise<number> {
  const { report, path: reportPath } = await runSuite({
    root,
    mode: "offline",
    model: OFFLINE_MODEL,
    seed: OFFLINE_SEED,
    command: "npm run eval:offline",
    retry: { maxRetries: 2, baseDelayMs: 100, requestTimeoutMs: 5_000 },
    scenarios: EVALUATION_SCENARIOS,
    createProvider: (scenario) => new ScriptedEvalProvider(scenario.createOfflineScript(process.execPath)),
  });
  process.stdout.write(
    `EasyCode offline eval：${report.summary.passed}/${report.summary.total} 通过；` +
      `rounds=${report.summary.providerRounds} attempts=${report.summary.providerAttempts} ` +
      `tools=${report.summary.toolExecutions}；报告 ${path.relative(root, reportPath)}\n`,
  );
  for (const scenario of report.scenarios.filter((result) => !result.passed)) {
    const failedAssertions = scenario.grade.assertions.filter((assertion) => !assertion.passed).map(({ id }) => id);
    process.stderr.write(`${scenario.scenarioId} 未通过：${failedAssertions.join(",")}\n`);
  }
  return evaluationExitCode(report.summary.failed);
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runOfflineEvaluation().then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    () => {
      process.stderr.write("EasyCode offline eval：评测基础设施失败，未生成完整报告。\n");
      process.exitCode = 1;
    },
  );
}
