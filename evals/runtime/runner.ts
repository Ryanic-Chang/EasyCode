import * as path from "node:path";
import type { AgentTerminationReason } from "../../src/agent/events.js";
import { AgentLoop } from "../../src/agent/loop.js";
import type { Provider } from "../../src/llm/provider.js";
import { MetricsCollector, type MonotonicClock } from "../../src/metrics/collector.js";
import { createCodingToolRegistry } from "../../src/tools/coding-tools.js";
import type { EvaluationScenario, ScenarioEvaluationResult } from "../core/types.js";
import { ExactEvalApprovalGate } from "./approval.js";
import { createIsolatedFixture, snapshotFiles } from "./fixture.js";
import { gradeScenario } from "./grader.js";

export interface ScenarioRunOptions {
  readonly fixturesRoot: string;
  readonly model: string;
  readonly provider: Provider;
  readonly clock?: MonotonicClock;
  readonly nodeExecutable?: string;
}

export async function runScenario(
  scenario: EvaluationScenario,
  options: ScenarioRunOptions,
): Promise<ScenarioEvaluationResult> {
  const nodeExecutable = options.nodeExecutable ?? process.execPath;
  const sourceRoot = path.join(options.fixturesRoot, scenario.fixture);
  const sourceBefore = await snapshotFiles(sourceRoot);
  const fixture = await createIsolatedFixture(options.fixturesRoot, scenario.fixture);
  try {
    const before = await snapshotFiles(fixture.root);
    const metrics = new MetricsCollector(options.clock);
    const agent = new AgentLoop({
      provider: options.provider,
      tools: createCodingToolRegistry(),
      model: options.model,
      cwd: fixture.root,
      maxSteps: scenario.maxSteps,
      approvalGate: new ExactEvalApprovalGate(scenario.allowedCommands, nodeExecutable, fixture.root, before),
      approvalIdFactory: (() => {
        let next = 0;
        return () => `eval-approval-${++next}`;
      })(),
    });
    let terminationReason: AgentTerminationReason = "internal_error";
    const commandPolicy =
      scenario.allowedCommands.length === 0
        ? "本场景没有授权任何命令。"
        : `本场景只授权以下精确命令：${scenario.allowedCommands
            .map(
              (command) =>
                `${nodeExecutable} ${command.args.join(" ")}（cwd=${command.cwd}, timeoutMs=${command.timeoutMs}）`,
            )
            .join("；")}`;
    for await (const event of agent.run([
      { role: "system", content: `你正在隔离的 synthetic fixture 中接受客观评测。${commandPolicy}` },
      { role: "user", content: scenario.task },
    ])) {
      metrics.consume(event);
      if (event.type === "complete") {
        terminationReason = event.reason;
      }
    }
    const metricSnapshot = metrics.snapshot();
    const sourceAfter = await snapshotFiles(sourceRoot);
    const grade = await gradeScenario({
      scenario,
      workspace: fixture.root,
      before,
      sourceBefore,
      sourceAfter,
      terminationReason,
      ...(metricSnapshot.errorCode === undefined ? {} : { errorCode: metricSnapshot.errorCode }),
      metrics: metricSnapshot,
    });
    return {
      scenarioId: scenario.id,
      scenarioVersion: scenario.version,
      fixtureVersion: scenario.fixtureVersion,
      maxSteps: scenario.maxSteps,
      passed: grade.passed,
      terminationReason,
      ...(metricSnapshot.errorCode === undefined ? {} : { errorCode: metricSnapshot.errorCode }),
      grade,
      metrics: metricSnapshot,
    };
  } finally {
    await fixture.cleanup();
  }
}
