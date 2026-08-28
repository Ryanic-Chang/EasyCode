import { describe, expect, it, vi } from "vitest";
import { evaluationExitCode } from "../../evals/cli/offline.js";
import { assertRealEvaluationEnabled, runRealEvaluation } from "../../evals/cli/real.js";
import type { EvaluationReportPayload } from "../../evals/core/types.js";
import { EVALUATION_SCHEMA_VERSION } from "../../evals/core/types.js";
import {
  type AtomicReportFileSystem,
  createReport,
  parseReport,
  writeReportAtomic,
} from "../../evals/report/report.js";

function payload(): EvaluationReportPayload {
  return {
    schemaVersion: EVALUATION_SCHEMA_VERSION,
    suiteVersion: "1.0.0",
    metadata: {
      runId: "run-1",
      startedAt: "2026-08-28T00:00:00.000Z",
      mode: "offline",
      gitCommit: "a".repeat(40),
      gitDirty: false,
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      packageLockSha256: "b".repeat(64),
      topLevelDependencies: {},
      model: "scripted-eval-v1",
      maxStepsPolicy: "scenario",
      retry: { maxRetries: 0, baseDelayMs: 1, requestTimeoutMs: 1_000 },
      seed: 1,
      command: "npm run eval:offline",
    },
    scenarios: [],
    summary: {
      total: 0,
      passed: 0,
      failed: 0,
      successRate: 0,
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
      usageComplete: true,
      durationMs: 0,
    },
  };
}

describe("M6 报告与 CLI 安全语义", () => {
  it("报告 hash 可验证，非法 schema 和不完整 hash 被拒绝", () => {
    const report = createReport(payload());
    expect(parseReport(JSON.stringify(report))).toEqual(report);
    expect(() => parseReport(JSON.stringify({ ...report, schemaVersion: "9" }))).toThrow("schema");
    expect(() => parseReport(JSON.stringify({ ...report, reportHash: "bad" }))).toThrow("hash");
  });

  it("原子 rename 失败时清理临时文件，不留下完整报告", async () => {
    const remove = vi.fn(async () => undefined);
    const fileSystem: AtomicReportFileSystem = {
      mkdir: vi.fn(async () => undefined),
      write: vi.fn(async () => undefined),
      rename: vi.fn(async () => {
        throw new Error("fixture rename failure");
      }),
      remove,
    };
    await expect(writeReportAtomic("C:\\fixture", createReport(payload()), fileSystem)).rejects.toThrow(
      "fixture rename failure",
    );
    expect(remove).toHaveBeenCalledOnce();
  });

  it("报告模型不包含消息、ToolCall 参数、ToolResult 或 secret 字段", () => {
    const serialized = JSON.stringify(createReport(payload()));
    for (const forbidden of ["messages", "arguments", "toolResult", "apiKey", "Authorization", "secret-value"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("grader 失败对应非零 CLI exit code", () => {
    expect(evaluationExitCode(0)).toBe(0);
    expect(evaluationExitCode(1)).toBe(1);
  });

  it("真实评测开关先于 Provider 配置检查", () => {
    expect(() => assertRealEvaluationEnabled({ EASYCODE_REAL_EVAL: "0" })).toThrow("默认关闭");
    expect(() => assertRealEvaluationEnabled({ EASYCODE_REAL_EVAL: "1" })).not.toThrow();
  });

  it("真实评测未显式开启时不读取 Provider 凭据", async () => {
    const accessed: string[] = [];
    const environment = new Proxy<Record<string, string | undefined>>(
      { EASYCODE_REAL_EVAL: "0" },
      {
        get(target, property, receiver) {
          accessed.push(String(property));
          return Reflect.get(target, property, receiver) as string | undefined;
        },
      },
    );
    await expect(runRealEvaluation(process.cwd(), environment)).rejects.toThrow("默认关闭");
    expect(accessed).toEqual(["EASYCODE_REAL_EVAL"]);
  });
});
