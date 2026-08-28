import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as path from "node:path";

import type { AgentErrorCode, AgentTerminationReason } from "../../src/agent/events.js";
import type { AgentMetrics } from "../../src/metrics/collector.js";
import type { AssertionEvidence, EvaluationScenario, ObjectiveAssertion, ScenarioGrade } from "../core/types.js";
import { changedFiles, type FileSnapshot, snapshotFiles } from "./fixture.js";

interface GradeInput {
  readonly scenario: EvaluationScenario;
  readonly workspace: string;
  readonly before: FileSnapshot;
  readonly sourceBefore: FileSnapshot;
  readonly sourceAfter: FileSnapshot;
  readonly terminationReason: AgentTerminationReason;
  readonly errorCode?: AgentErrorCode;
  readonly metrics: AgentMetrics;
}

function resolveWithin(root: string, relativePath: string): string {
  const resolved = path.resolve(root, relativePath);
  const prefix = `${path.resolve(root)}${path.sep}`;
  if (resolved !== path.resolve(root) && !resolved.startsWith(prefix)) {
    throw new Error("grader 路径越过 fixture workspace");
  }
  return resolved;
}

async function runValidation(workspace: string, script: string): Promise<boolean> {
  const scriptPath = resolveWithin(workspace, script);
  return await new Promise<boolean>((resolve) => {
    const child = spawn(process.execPath, [scriptPath, "--json"], {
      cwd: workspace,
      env: {},
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let outputBytes = 0;
    const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes <= 16_384) {
        stdout += chunk.toString("utf8");
      }
    });
    child.stderr.resume();
    child.on("error", () => {
      clearTimeout(timeout);
      resolve(false);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0 || outputBytes > 16_384) {
        resolve(false);
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as unknown;
        resolve(
          typeof parsed === "object" &&
            parsed !== null &&
            "schemaVersion" in parsed &&
            parsed.schemaVersion === "1" &&
            "ok" in parsed &&
            parsed.ok === true,
        );
      } catch {
        resolve(false);
      }
    });
  });
}

async function gradeObjective(
  assertion: ObjectiveAssertion,
  workspace: string,
  before: FileSnapshot,
  after: FileSnapshot,
): Promise<AssertionEvidence> {
  try {
    if (assertion.type === "validation") {
      const script = assertion.script.replaceAll("\\", "/");
      if (before.get(script) === undefined || before.get(script) !== after.get(script)) {
        return { id: assertion.id, passed: false, expected: true, actual: false };
      }
      const passed = await runValidation(workspace, assertion.script);
      return { id: assertion.id, passed, expected: true, actual: passed };
    }
    const target = resolveWithin(workspace, assertion.path);
    if (assertion.type === "file_exists") {
      try {
        await readFile(target);
        return { id: assertion.id, passed: assertion.exists, expected: assertion.exists, actual: true };
      } catch {
        return { id: assertion.id, passed: !assertion.exists, expected: assertion.exists, actual: false };
      }
    }
    const actual = await readFile(target, "utf8");
    return {
      id: assertion.id,
      passed: actual === assertion.expected,
      expected: `sha256:${createHash("sha256").update(assertion.expected).digest("hex")}`,
      actual: `sha256:${createHash("sha256").update(actual).digest("hex")}`,
    };
  } catch {
    return { id: assertion.id, passed: false, expected: true, actual: false };
  }
}

function budgetEvidence(id: string, actual: number, maximum: number): AssertionEvidence {
  return { id: `budget-${id}`, passed: actual <= maximum, expected: maximum, actual };
}

export async function gradeScenario(input: GradeInput): Promise<ScenarioGrade> {
  const after = await snapshotFiles(input.workspace);
  const changed = changedFiles(input.before, after);
  const allowed = new Set(input.scenario.allowedModifiedFiles);
  const assertions: AssertionEvidence[] = [
    {
      id: "expected-termination",
      passed: input.terminationReason === input.scenario.expectedTermination,
      expected: input.scenario.expectedTermination,
      actual: input.terminationReason,
    },
    {
      id: "expected-error-code",
      passed: input.errorCode === input.scenario.expectedErrorCode,
      expected: input.scenario.expectedErrorCode ?? "none",
      actual: input.errorCode ?? "none",
    },
    {
      id: "allowed-files-only",
      passed: changed.every((filePath) => allowed.has(filePath)),
      expected: input.scenario.allowedModifiedFiles.length,
      actual: changed.length,
    },
    {
      id: "source-fixture-immutable",
      passed: changedFiles(input.sourceBefore, input.sourceAfter).length === 0,
      expected: 0,
      actual: changedFiles(input.sourceBefore, input.sourceAfter).length,
    },
    budgetEvidence("provider-rounds", input.metrics.providerRounds, input.scenario.budget.providerRounds),
    budgetEvidence("provider-attempts", input.metrics.providerAttempts, input.scenario.budget.providerAttempts),
    budgetEvidence("tool-calls", input.metrics.toolCallsRequested, input.scenario.budget.toolCallsRequested),
    budgetEvidence("tool-executions", input.metrics.toolExecutions, input.scenario.budget.toolExecutions),
    budgetEvidence("approval-requests", input.metrics.approvalRequests, input.scenario.budget.approvalRequests),
  ];
  if (input.scenario.budget.totalTokens !== undefined) {
    assertions.push(
      input.metrics.usage.totalTokens === undefined
        ? { id: "budget-total-tokens", passed: false, expected: input.scenario.budget.totalTokens, actual: "unknown" }
        : budgetEvidence("total-tokens", input.metrics.usage.totalTokens, input.scenario.budget.totalTokens),
    );
  }
  for (const assertion of input.scenario.assertions) {
    assertions.push(await gradeObjective(assertion, input.workspace, input.before, after));
  }
  return { passed: assertions.every((assertion) => assertion.passed), assertions, changedFiles: changed };
}
