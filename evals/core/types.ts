import type { AgentErrorCode, AgentTerminationReason } from "../../src/agent/events.js";
import type { ProviderEvent } from "../../src/llm/provider.js";
import type { AgentMetrics } from "../../src/metrics/collector.js";

export const EVALUATION_SCHEMA_VERSION = "1.0.0";
export const EVALUATION_SUITE_VERSION = "1.0.0";
export const FIXTURE_VERSION = "1";

export type EvaluationMode = "offline" | "real";

export interface AllowedCommand {
  readonly executable: "$NODE";
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
}

export type ObjectiveAssertion =
  | { readonly id: string; readonly type: "file_content"; readonly path: string; readonly expected: string }
  | { readonly id: string; readonly type: "file_exists"; readonly path: string; readonly exists: boolean }
  | { readonly id: string; readonly type: "validation"; readonly script: string };

export interface ResourceBudget {
  readonly providerRounds: number;
  readonly providerAttempts: number;
  readonly toolCallsRequested: number;
  readonly toolExecutions: number;
  readonly approvalRequests: number;
  readonly totalTokens?: number;
}

export interface EvaluationScenario {
  readonly id: string;
  readonly version: string;
  readonly task: string;
  readonly fixture: string;
  readonly fixtureVersion: string;
  readonly maxSteps: number;
  readonly expectedTermination: AgentTerminationReason;
  readonly expectedErrorCode?: AgentErrorCode;
  readonly allowedModifiedFiles: readonly string[];
  readonly assertions: readonly ObjectiveAssertion[];
  readonly budget: ResourceBudget;
  readonly realMaxSteps?: number;
  readonly realBudget?: ResourceBudget;
  readonly allowedCommands: readonly AllowedCommand[];
  readonly realEligible: boolean;
  createOfflineScript(nodeExecutable: string): readonly (readonly ProviderEvent[])[];
}

export interface AssertionEvidence {
  readonly id: string;
  readonly passed: boolean;
  readonly expected?: string | number | boolean;
  readonly actual?: string | number | boolean;
}

export interface ScenarioGrade {
  readonly passed: boolean;
  readonly assertions: readonly AssertionEvidence[];
  readonly changedFiles: readonly string[];
}

export interface ScenarioEvaluationResult {
  readonly scenarioId: string;
  readonly scenarioVersion: string;
  readonly fixtureVersion: string;
  readonly maxSteps: number;
  readonly passed: boolean;
  readonly terminationReason: AgentTerminationReason;
  readonly errorCode?: AgentErrorCode;
  readonly grade: ScenarioGrade;
  readonly metrics: AgentMetrics;
}

export interface ReproductionMetadata {
  readonly runId: string;
  readonly startedAt: string;
  readonly mode: EvaluationMode;
  readonly gitCommit: string;
  readonly gitDirty: boolean;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly nodeVersion: string;
  readonly packageLockSha256: string;
  readonly topLevelDependencies: Readonly<Record<string, string>>;
  readonly model: string;
  readonly maxStepsPolicy: "scenario";
  readonly retry: { readonly maxRetries: number; readonly baseDelayMs: number; readonly requestTimeoutMs: number };
  readonly seed: number;
  readonly command: string;
}

export interface EvaluationSummary {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly successRate: number;
  readonly providerRounds: number;
  readonly providerAttempts: number;
  readonly providerRetries: number;
  readonly toolCallsRequested: number;
  readonly toolExecutions: number;
  readonly toolSuccesses: number;
  readonly toolFailures: number;
  readonly approvalRequests: number;
  readonly approvalAllowed: number;
  readonly approvalDenied: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly usageComplete: boolean;
  readonly durationMs: number;
}

export interface EvaluationReportPayload {
  readonly schemaVersion: typeof EVALUATION_SCHEMA_VERSION;
  readonly suiteVersion: string;
  readonly metadata: ReproductionMetadata;
  readonly scenarios: readonly ScenarioEvaluationResult[];
  readonly summary: EvaluationSummary;
}

export interface EvaluationReport extends EvaluationReportPayload {
  readonly reportHash: string;
}
