import { spawn } from "node:child_process";
import * as path from "node:path";
import { performance } from "node:perf_hooks";

import { DEFAULT_REDACTOR } from "../security/redaction.js";
import { domainFailure, ToolDomainError, ToolInputError } from "./errors.js";
import type { Tool, ToolContext, ToolExecutionResult } from "./tool.js";
import { optionalInteger, optionalString, rejectUnknownKeys, requireRecord, requireString } from "./validation.js";
import { normalizeWorkspacePath, WorkspaceBoundary } from "./workspace.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 60_000;
const MAX_ARGUMENTS = 64;
const MAX_ARGUMENT_BYTES = 4096;
const MAX_STDIN_BYTES = 16 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;

const SHELL_EXECUTABLES = new Set(["bash", "cmd", "fish", "powershell", "pwsh", "sh", "wsl", "zsh"]);
const SYSTEM_DANGEROUS_EXECUTABLES = new Set([
  "del",
  "diskpart",
  "erase",
  "format",
  "halt",
  "mkfs",
  "poweroff",
  "reboot",
  "rm",
  "rmdir",
  "shutdown",
]);
const DEPLOY_EXECUTABLES = new Set(["helm", "kubectl", "netlify", "terraform", "vercel"]);

export interface RunCommandInput {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly stdin?: string;
}

interface OutputCapture {
  readonly stdout: Buffer[];
  readonly stderr: Buffer[];
  remaining: number;
  truncated: boolean;
  accepting: boolean;
}

function executableBase(executable: string): string {
  const basename = path.win32.basename(executable).toLowerCase();
  return basename.endsWith(".exe") ? basename.slice(0, -4) : basename;
}

function hasFlag(args: readonly string[], flags: ReadonlySet<string>): boolean {
  return args.some(
    (argument) =>
      flags.has(argument.toLowerCase()) || [...flags].some((flag) => argument.toLowerCase().startsWith(`${flag}=`)),
  );
}

function validateCommand(executable: string, args: readonly string[]): void {
  const lowerExecutable = executable.toLowerCase();
  if (lowerExecutable.endsWith(".cmd") || lowerExecutable.endsWith(".bat")) {
    throw new ToolInputError("run_command 不执行需要 shell 的 .cmd 或 .bat shim");
  }
  const base = executableBase(executable);
  if (SHELL_EXECUTABLES.has(base)) {
    throw new ToolInputError("run_command 不允许启动 shell");
  }
  if (SYSTEM_DANGEROUS_EXECUTABLES.has(base) || DEPLOY_EXECUTABLES.has(base)) {
    throw new ToolInputError("run_command 拒绝系统级危险或部署命令");
  }
  if (
    (base === "node" || base === "nodejs" || base === "bun" || base === "deno") &&
    hasFlag(args, new Set(["-e", "--eval", "-p", "--print"]))
  ) {
    throw new ToolInputError("run_command 不允许 JavaScript inline eval/print 入口");
  }
  if ((base === "python" || base === "python3" || base === "py") && hasFlag(args, new Set(["-c"]))) {
    throw new ToolInputError("run_command 不允许 Python inline code 入口");
  }
  if (
    base === "git" &&
    args.some((argument) =>
      ["clean", "commit", "merge", "push", "rebase", "reset", "restore", "switch", "tag"].includes(
        argument.toLowerCase(),
      ),
    )
  ) {
    throw new ToolInputError("run_command 拒绝会修改历史、工作区或远端状态的 Git 子命令");
  }
  if (
    ["npm", "pnpm", "yarn"].includes(base) &&
    args.some((argument) =>
      ["adduser", "deploy", "login", "logout", "publish", "token"].includes(argument.toLowerCase()),
    )
  ) {
    throw new ToolInputError("run_command 拒绝 package publish、登录、token 管理和部署命令");
  }
}

function optionalStdin(input: Readonly<Record<string, unknown>>): string | undefined {
  const value = input.stdin;
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.includes("\0") || Buffer.byteLength(value, "utf8") > MAX_STDIN_BYTES) {
    throw new ToolInputError(`stdin 必须是不含 NUL 且不超过 ${MAX_STDIN_BYTES} bytes 的字符串`);
  }
  return value;
}

function sanitizeEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};
  const sensitive = /(^|_)(api_?key|access_?key|authorization|password|passwd|private_?key|secret|token)(_|$)/i;
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined && key.toUpperCase() !== "EASYCODE_API_KEY" && !sensitive.test(key)) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

function appendOutput(capture: OutputCapture, target: Buffer[], chunk: Buffer): void {
  if (!capture.accepting) {
    return;
  }
  if (chunk.length <= capture.remaining) {
    target.push(chunk);
    capture.remaining -= chunk.length;
    return;
  }
  if (capture.remaining > 0) {
    target.push(chunk.subarray(0, capture.remaining));
    capture.remaining = 0;
  }
  capture.truncated = true;
}

function decodeCaptured(chunks: readonly Buffer[]): string {
  const contents = Buffer.concat(chunks);
  for (let trim = 0; trim <= Math.min(3, contents.length); trim += 1) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(contents.subarray(0, contents.length - trim));
    } catch {
      // 只允许丢弃上限恰好切断的 UTF-8 尾字节。
    }
  }
  return new TextDecoder("utf-8").decode(contents);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("操作已取消", "AbortError");
}

async function executeProcess(input: RunCommandInput, cwd: string, signal: AbortSignal): Promise<ToolExecutionResult> {
  signal.throwIfAborted();
  const startedAt = performance.now();
  const capture: OutputCapture = {
    stdout: [],
    stderr: [],
    remaining: MAX_COMMAND_OUTPUT_BYTES,
    truncated: false,
    accepting: true,
  };

  return await new Promise<ToolExecutionResult>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(input.executable, [...input.args], {
        cwd,
        env: sanitizeEnvironment(process.env),
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      resolve({
        output: "无法启动命令。",
        isError: true,
        metadata: {
          kind: "spawn_error",
          exitCode: null,
          signal: null,
          stdout: "",
          stderr: "",
          durationMs: Math.round(performance.now() - startedAt),
          timedOut: false,
          truncated: false,
        },
      });
      return;
    }

    let spawnFailed = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const stop = (reason: "timeout" | "abort"): void => {
      if (settled || aborted || timedOut || child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      capture.accepting = false;
      timedOut = reason === "timeout";
      aborted = reason === "abort";
      child.kill("SIGKILL");
    };
    const timeout = setTimeout(() => stop("timeout"), input.timeoutMs);
    const onAbort = (): void => stop("abort");
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }

    child.stdout?.on("data", (chunk: Buffer) => appendOutput(capture, capture.stdout, chunk));
    child.stderr?.on("data", (chunk: Buffer) => appendOutput(capture, capture.stderr, chunk));
    child.stdin?.on("error", () => {
      // 子进程提前关闭 stdin 时，最终 close 结果仍是唯一执行结果。
    });
    child.stdin?.end(input.stdin ?? "");
    child.on("error", () => {
      spawnFailed = true;
    });
    child.on("close", (exitCode, exitSignal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      if (aborted || signal.aborted) {
        reject(abortReason(signal));
        return;
      }

      const stdout = decodeCaptured(capture.stdout);
      const stderr = decodeCaptured(capture.stderr);
      const durationMs = Math.round(performance.now() - startedAt);
      if (spawnFailed) {
        resolve({
          output: "无法启动命令。",
          isError: true,
          metadata: {
            kind: "spawn_error",
            exitCode: null,
            signal: null,
            stdout,
            stderr,
            durationMs,
            timedOut: false,
            truncated: capture.truncated,
          },
        });
        return;
      }

      const isError = timedOut || exitCode !== 0;
      resolve({
        output: timedOut
          ? "命令执行超时。"
          : exitCode === 0
            ? "命令执行成功。"
            : `命令执行失败，exit code 为 ${exitCode ?? "unknown"}。`,
        isError,
        metadata: {
          kind: timedOut ? "timeout" : exitCode === 0 ? "completed" : "nonzero_exit",
          exitCode,
          signal: exitSignal,
          stdout,
          stderr,
          durationMs,
          timedOut,
          truncated: capture.truncated,
        },
      });
    });
  });
}

export class RunCommandTool implements Tool<RunCommandInput> {
  readonly name = "run_command";
  readonly description =
    "以 executable + args、shell:false 在 workspace 内执行单个程序；禁止管道、重定向和 shell 包装，需要输入时使用 stdin 字段。每次执行都需单独确认。";
  readonly inputSchema = {
    type: "object",
    additionalProperties: false,
    required: ["executable"],
    properties: {
      executable: { type: "string", minLength: 1, maxLength: 1024 },
      args: {
        type: "array",
        description: "参数数组；无参数时可省略",
        maxItems: MAX_ARGUMENTS,
        items: { type: "string", maxLength: MAX_ARGUMENT_BYTES },
      },
      cwd: { type: "string", description: "workspace 相对目录；默认为 ." },
      timeoutMs: { type: "integer", minimum: MIN_TIMEOUT_MS, maximum: MAX_TIMEOUT_MS },
      stdin: {
        type: "string",
        description: `写入子进程的 UTF-8 标准输入；可省略，最多 ${MAX_STDIN_BYTES} bytes`,
        maxLength: MAX_STDIN_BYTES,
      },
    },
  } as const;

  parse(input: unknown): RunCommandInput {
    const record = requireRecord(input);
    rejectUnknownKeys(record, ["executable", "args", "cwd", "timeoutMs", "stdin"]);
    const executable = requireString(record, "executable", 1024);
    const rawArgs = record.args ?? [];
    if (!Array.isArray(rawArgs) || rawArgs.length > MAX_ARGUMENTS) {
      throw new ToolInputError(`args 必须是至多 ${MAX_ARGUMENTS} 项的字符串数组`);
    }
    const args = rawArgs.map((argument) => {
      if (
        typeof argument !== "string" ||
        Buffer.byteLength(argument, "utf8") > MAX_ARGUMENT_BYTES ||
        argument.includes("\0")
      ) {
        throw new ToolInputError(`每个 args 项必须是不含 NUL 且不超过 ${MAX_ARGUMENT_BYTES} bytes 的字符串`);
      }
      return argument;
    });
    validateCommand(executable, args);
    const stdin = optionalStdin(record);
    return {
      executable,
      args,
      cwd: normalizeWorkspacePath(optionalString(record, "cwd", 1024) ?? ".", true),
      timeoutMs: optionalInteger(record, "timeoutMs", DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
      ...(stdin === undefined ? {} : { stdin }),
    };
  }

  approval(input: RunCommandInput) {
    const executable = DEFAULT_REDACTOR.redactText(input.executable, 512);
    const args = input.args
      .slice(0, 12)
      .map((argument) => DEFAULT_REDACTOR.redactText(argument, 256))
      .join(" ");
    const suffix = input.args.length > 12 ? " …[参数已截断]" : "";
    const stdinSummary = input.stdin === undefined ? "" : ` · stdin ${Buffer.byteLength(input.stdin, "utf8")} bytes`;
    return {
      riskCategory: "command_execution",
      actionSummary: `executable ${executable} · args ${args}${suffix} · cwd ${DEFAULT_REDACTOR.redactText(input.cwd, 512)} · timeout ${input.timeoutMs} ms${stdinSummary}`,
    };
  }

  async execute(input: RunCommandInput, context: ToolContext): Promise<ToolExecutionResult> {
    context.signal.throwIfAborted();
    try {
      const workspace = await WorkspaceBoundary.create(context.cwd);
      const cwd = await workspace.resolveExisting(input.cwd, "directory");
      return await executeProcess(input, cwd.canonicalPath, context.signal);
    } catch (error) {
      if (error instanceof ToolDomainError) {
        return domainFailure(error);
      }
      throw error;
    }
  }
}
