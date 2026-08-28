import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { ConfigError, type EasyCodeEnvironment, loadEasyCodeConfig } from "../../src/config/config.js";
import { OpenAICompatibleProvider } from "../../src/llm/openai-compatible/provider.js";
import { SILENT_LOGGER } from "../../src/security/logger.js";
import { Redactor } from "../../src/security/redaction.js";
import { runSuite } from "../runtime/suite.js";
import { EVALUATION_SCENARIOS } from "../scenarios/catalog.js";

export function assertRealEvaluationEnabled(environment: EasyCodeEnvironment): void {
  if (environment.EASYCODE_REAL_EVAL !== "1") {
    throw new Error("真实评测默认关闭；仅 EASYCODE_REAL_EVAL=1 时可启动");
  }
}

export async function runRealEvaluation(
  root = process.cwd(),
  environment: EasyCodeEnvironment = process.env,
): Promise<number> {
  assertRealEvaluationEnabled(environment);
  const config = loadEasyCodeConfig(environment);
  const redactor = new Redactor({ secrets: [config.apiKey] });
  const scenarios = EVALUATION_SCENARIOS.filter((scenario) => scenario.realEligible);
  const { report, path: reportPath } = await runSuite({
    root,
    mode: "real",
    model: config.model,
    seed: 20260828,
    command: "EASYCODE_REAL_EVAL=1 npm run eval:real",
    retry: {
      maxRetries: config.maxRetries,
      baseDelayMs: config.retryBaseDelayMs,
      requestTimeoutMs: config.requestTimeoutMs,
    },
    scenarios,
    createProvider: () =>
      new OpenAICompatibleProvider(config, {
        retry: { maxRetries: config.maxRetries, baseDelayMs: config.retryBaseDelayMs },
        requestTimeoutMs: config.requestTimeoutMs,
        logger: SILENT_LOGGER,
        redactor,
      }),
  });
  process.stdout.write(
    `EasyCode real eval：${report.summary.passed}/${report.summary.total} 通过；报告 ${path.relative(root, reportPath)}\n`,
  );
  return report.summary.failed === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runRealEvaluation().then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error: unknown) => {
      const message = error instanceof ConfigError ? "真实评测 Provider 配置无效。" : "真实评测未启动或执行失败。";
      process.stderr.write(`EasyCode real eval：${message}\n`);
      process.exitCode = 1;
    },
  );
}
