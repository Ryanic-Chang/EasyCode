import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as path from "node:path";

import type { ApprovalDecision, ApprovalGate, ApprovalRequest } from "../../src/agent/approval.js";
import { RunCommandTool } from "../../src/tools/run-command.js";
import type { AllowedCommand } from "../core/types.js";
import type { FileSnapshot } from "./fixture.js";

function expectedRequest(
  command: AllowedCommand,
  nodeExecutable: string,
): {
  readonly riskCategory: string;
  readonly actionSummary: string;
} {
  const tool = new RunCommandTool();
  return tool.approval(
    tool.parse({
      executable: nodeExecutable,
      args: command.args,
      cwd: command.cwd,
      timeoutMs: command.timeoutMs,
    }),
  );
}

export class ExactEvalApprovalGate implements ApprovalGate {
  readonly #allowed: Map<string, Array<{ readonly scriptPath: string; readonly expectedHash: string }>>;

  constructor(
    commands: readonly AllowedCommand[],
    nodeExecutable: string,
    workspace: string,
    initialSnapshot: FileSnapshot,
  ) {
    this.#allowed = new Map();
    for (const command of commands) {
      const expectation = expectedRequest(command, nodeExecutable);
      const key = this.#key("run_command", expectation.riskCategory, expectation.actionSummary);
      const script = command.args[0];
      if (script === undefined) {
        throw new Error("评测允许命令必须声明固定验证脚本");
      }
      const relativeScript = path.posix.normalize(path.posix.join(command.cwd.replaceAll("\\", "/"), script));
      const expectedHash = initialSnapshot.get(relativeScript);
      if (expectedHash === undefined) {
        throw new Error("评测允许命令的验证脚本不存在于初始 fixture");
      }
      const entries = this.#allowed.get(key) ?? [];
      entries.push({ scriptPath: path.resolve(workspace, relativeScript), expectedHash });
      this.#allowed.set(key, entries);
    }
  }

  async request(request: ApprovalRequest, options: { readonly signal: AbortSignal }): Promise<ApprovalDecision> {
    options.signal.throwIfAborted();
    const key = this.#key(request.toolName, request.riskCategory, request.actionSummary);
    const entries = this.#allowed.get(key);
    const entry = entries?.shift();
    if (entry !== undefined) {
      try {
        const currentHash = createHash("sha256")
          .update(await readFile(entry.scriptPath))
          .digest("hex");
        options.signal.throwIfAborted();
        if (currentHash === entry.expectedHash) {
          return { approvalId: request.approvalId, approved: true };
        }
      } catch {
        options.signal.throwIfAborted();
      }
    }
    return { approvalId: request.approvalId, approved: false };
  }

  #key(toolName: string, riskCategory: string, actionSummary: string): string {
    return JSON.stringify([toolName, riskCategory, actionSummary]);
  }
}
