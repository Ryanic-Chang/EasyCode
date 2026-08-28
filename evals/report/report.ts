import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";

import {
  EVALUATION_SCHEMA_VERSION,
  type EvaluationReport,
  type EvaluationReportPayload,
  type EvaluationSummary,
  type ScenarioEvaluationResult,
} from "../core/types.js";

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right, "en"))
        .map(([key, child]) => [key, sortValue(child)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(sortValue(value), null, 2)}\n`;
}

export function createReport(payload: EvaluationReportPayload): EvaluationReport {
  const reportHash = createHash("sha256").update(canonicalJson(payload)).digest("hex");
  return { ...payload, reportHash };
}

export function summarize(results: readonly ScenarioEvaluationResult[]): EvaluationSummary {
  const passed = results.filter((result) => result.passed).length;
  const usageComplete = results.every((result) => result.metrics.usage.complete);
  const sum = (selector: (result: ScenarioEvaluationResult) => number): number =>
    results.reduce((total, result) => total + selector(result), 0);
  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    successRate: results.length === 0 ? 0 : passed / results.length,
    providerRounds: sum((result) => result.metrics.providerRounds),
    providerAttempts: sum((result) => result.metrics.providerAttempts),
    providerRetries: sum((result) => result.metrics.providerRetries),
    toolCallsRequested: sum((result) => result.metrics.toolCallsRequested),
    toolExecutions: sum((result) => result.metrics.toolExecutions),
    toolSuccesses: sum((result) => result.metrics.toolSuccesses),
    toolFailures: sum((result) => result.metrics.toolFailures),
    approvalRequests: sum((result) => result.metrics.approvalRequests),
    approvalAllowed: sum((result) => result.metrics.approvalAllowed),
    approvalDenied: sum((result) => result.metrics.approvalDenied),
    ...(usageComplete
      ? {
          inputTokens: sum((result) => result.metrics.usage.inputTokens ?? 0),
          outputTokens: sum((result) => result.metrics.usage.outputTokens ?? 0),
          totalTokens: sum((result) => result.metrics.usage.totalTokens ?? 0),
        }
      : {}),
    usageComplete,
    durationMs: sum((result) => result.metrics.durations.totalMs),
  };
}

export function parseReport(contents: string): EvaluationReport {
  const parsed: unknown = JSON.parse(contents);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("schemaVersion" in parsed) ||
    parsed.schemaVersion !== EVALUATION_SCHEMA_VERSION ||
    !("reportHash" in parsed) ||
    typeof parsed.reportHash !== "string" ||
    !("suiteVersion" in parsed) ||
    typeof parsed.suiteVersion !== "string" ||
    !("metadata" in parsed) ||
    typeof parsed.metadata !== "object" ||
    parsed.metadata === null ||
    !("scenarios" in parsed) ||
    !Array.isArray(parsed.scenarios) ||
    !("summary" in parsed) ||
    typeof parsed.summary !== "object" ||
    parsed.summary === null
  ) {
    throw new Error("评测报告 schema 无效或不兼容");
  }
  const { reportHash, ...payload } = parsed as EvaluationReport;
  const expected = createHash("sha256").update(canonicalJson(payload)).digest("hex");
  if (expected !== reportHash) {
    throw new Error("评测报告 hash 校验失败");
  }
  return parsed as EvaluationReport;
}

export interface AtomicReportFileSystem {
  mkdir(directory: string): Promise<void>;
  write(filePath: string, contents: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(filePath: string): Promise<void>;
}

const DEFAULT_FILE_SYSTEM: AtomicReportFileSystem = {
  async mkdir(directory): Promise<void> {
    await mkdir(directory, { recursive: true });
  },
  async write(filePath, contents): Promise<void> {
    await writeFile(filePath, contents, { encoding: "utf8", flag: "wx" });
  },
  async rename(from, to): Promise<void> {
    await rename(from, to);
  },
  async remove(filePath): Promise<void> {
    await rm(filePath, { force: true });
  },
};

export async function writeReportAtomic(
  outputDirectory: string,
  report: EvaluationReport,
  fileSystem: AtomicReportFileSystem = DEFAULT_FILE_SYSTEM,
): Promise<string> {
  await fileSystem.mkdir(outputDirectory);
  const finalPath = path.join(outputDirectory, `${report.metadata.runId}.json`);
  const temporaryPath = path.join(outputDirectory, `.${report.metadata.runId}.${randomUUID()}.tmp`);
  try {
    await fileSystem.write(temporaryPath, canonicalJson(report));
    await fileSystem.rename(temporaryPath, finalPath);
    return finalPath;
  } catch (error) {
    try {
      await fileSystem.remove(temporaryPath);
    } catch {
      // 清理失败不替换原始报告写入错误。
    }
    throw error;
  }
}
