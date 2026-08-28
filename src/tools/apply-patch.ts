import { randomUUID } from "node:crypto";
import { chmod, link, rename, stat, unlink, writeFile } from "node:fs/promises";
import * as path from "node:path";

import { domainFailure, ToolDomainError, ToolInputError } from "./errors.js";
import { lineCount, MAX_TEXT_FILE_BYTES, readUtf8File } from "./text.js";
import type { Tool, ToolContext, ToolExecutionResult } from "./tool.js";
import { rejectUnknownKeys, requireRecord, requireString } from "./validation.js";
import { normalizeWorkspacePath, WorkspaceBoundary } from "./workspace.js";

interface UpdatePatchInput {
  readonly operation: "update";
  readonly path: string;
  readonly oldText: string;
  readonly newText: string;
}

interface CreatePatchInput {
  readonly operation: "create";
  readonly path: string;
  readonly content: string;
}

export type ApplyPatchInput = UpdatePatchInput | CreatePatchInput;

function requireText(input: Readonly<Record<string, unknown>>, key: string, allowEmpty: boolean): string {
  const value = input[key];
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || value.includes("\0")) {
    throw new ToolInputError(`${key} 必须是${allowEmpty ? "不含 NUL 的" : "非空且不含 NUL 的"}字符串`);
  }
  if (Buffer.byteLength(value, "utf8") > MAX_TEXT_FILE_BYTES) {
    throw new ToolInputError(`${key} 超过 ${MAX_TEXT_FILE_BYTES} bytes 上限`);
  }
  return value;
}

function detectLineEnding(value: string): "\r\n" | "\n" | "\r" {
  if (value.includes("\r\n")) {
    return "\r\n";
  }
  if (value.includes("\n")) {
    return "\n";
  }
  if (value.includes("\r")) {
    return "\r";
  }
  return "\n";
}

function normalizeLineEndings(value: string, lineEnding: string): string {
  return value.replace(/\r\n|\n|\r/g, lineEnding);
}

function countMatches(contents: string, oldText: string): number {
  let matches = 0;
  let offset = 0;
  while (true) {
    const index = contents.indexOf(oldText, offset);
    if (index === -1) {
      return matches;
    }
    matches += 1;
    offset = index + oldText.length;
  }
}

function temporaryPath(targetPath: string): string {
  return path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.easycode-tmp-${randomUUID()}`);
}

async function removeTemporaryFile(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
}

async function writeTemporaryFile(
  targetPath: string,
  contents: string,
  signal: AbortSignal,
  mode?: number,
): Promise<string> {
  const tempPath = temporaryPath(targetPath);
  try {
    await writeFile(tempPath, contents, { encoding: "utf8", flag: "wx", signal });
    signal.throwIfAborted();
    if (mode !== undefined) {
      await chmod(tempPath, mode);
    }
    return tempPath;
  } catch (error) {
    try {
      await removeTemporaryFile(tempPath);
    } catch {
      // 清理失败不能把 abort 或原始写入错误替换成另一条异常。
    }
    throw error;
  }
}

function writeFailure(): ToolExecutionResult {
  return {
    output: "文件修改失败，原目标未被确认更新。",
    isError: true,
    metadata: { kind: "write_failed" },
  };
}

export class ApplyPatchTool implements Tool<ApplyPatchInput> {
  readonly name = "apply_patch";
  readonly description = "对单个 workspace 文本文件执行唯一精确替换，或在已存在父目录中排他创建新文件。";
  readonly inputSchema = {
    oneOf: [
      {
        type: "object",
        additionalProperties: false,
        required: ["operation", "path", "oldText", "newText"],
        properties: {
          operation: { const: "update" },
          path: { type: "string" },
          oldText: { type: "string", minLength: 1 },
          newText: { type: "string" },
        },
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["operation", "path", "content"],
        properties: {
          operation: { const: "create" },
          path: { type: "string" },
          content: { type: "string" },
        },
      },
    ],
  } as const;

  parse(input: unknown): ApplyPatchInput {
    const record = requireRecord(input);
    const operation = record.operation;
    if (operation === "update") {
      rejectUnknownKeys(record, ["operation", "path", "oldText", "newText"]);
      return {
        operation,
        path: normalizeWorkspacePath(requireString(record, "path", 1024), false),
        oldText: requireText(record, "oldText", false),
        newText: requireText(record, "newText", true),
      };
    }
    if (operation === "create") {
      rejectUnknownKeys(record, ["operation", "path", "content"]);
      return {
        operation,
        path: normalizeWorkspacePath(requireString(record, "path", 1024), false),
        content: requireText(record, "content", true),
      };
    }
    throw new ToolInputError("operation 必须是 update 或 create");
  }

  async execute(input: ApplyPatchInput, context: ToolContext): Promise<ToolExecutionResult> {
    context.signal.throwIfAborted();
    try {
      const workspace = await WorkspaceBoundary.create(context.cwd);
      return input.operation === "update"
        ? await this.#update(workspace, input, context.signal)
        : await this.#create(workspace, input, context.signal);
    } catch (error) {
      if (error instanceof ToolDomainError) {
        return domainFailure(error);
      }
      throw error;
    }
  }

  async #update(
    workspace: WorkspaceBoundary,
    input: UpdatePatchInput,
    signal: AbortSignal,
  ): Promise<ToolExecutionResult> {
    const target = await workspace.resolveExisting(input.path, "file");
    const original = await readUtf8File(target.canonicalPath, signal);
    const replacement = normalizeLineEndings(input.newText, detectLineEnding(original.text));
    if (input.oldText === replacement) {
      throw new ToolDomainError("no_op", "patch 不会改变文件，已拒绝 no-op 修改。");
    }
    const matches = countMatches(original.text, input.oldText);
    if (matches === 0) {
      throw new ToolDomainError("no_match", "oldText 未在目标文件中精确出现。");
    }
    if (matches !== 1) {
      throw new ToolDomainError("ambiguous_match", `oldText 在目标文件中出现 ${matches} 次，拒绝歧义修改。`);
    }

    const index = original.text.indexOf(input.oldText);
    const updated = `${original.text.slice(0, index)}${replacement}${original.text.slice(index + input.oldText.length)}`;
    if (Buffer.byteLength(updated, "utf8") > MAX_TEXT_FILE_BYTES) {
      throw new ToolDomainError("file_too_large", `修改结果超过 ${MAX_TEXT_FILE_BYTES} bytes 上限。`);
    }

    const mode = (await stat(target.canonicalPath)).mode;
    let tempPath: string;
    try {
      signal.throwIfAborted();
      tempPath = await writeTemporaryFile(target.canonicalPath, updated, signal, mode);
    } catch {
      signal.throwIfAborted();
      return writeFailure();
    }
    try {
      signal.throwIfAborted();
      const currentTarget = await workspace.resolveExisting(input.path, "file");
      const current = await readUtf8File(currentTarget.canonicalPath, signal);
      if (currentTarget.canonicalPath !== target.canonicalPath || current.text !== original.text) {
        throw new ToolDomainError("patch_conflict", "文件在 patch 提交前发生变化，已拒绝覆盖。");
      }
      await rename(tempPath, target.canonicalPath);
    } catch (error) {
      await removeTemporaryFile(tempPath);
      if (error instanceof ToolDomainError) {
        throw error;
      }
      signal.throwIfAborted();
      return writeFailure();
    }

    return {
      output: `已更新 ${input.path}：精确替换 1 处。`,
      isError: false,
      metadata: {
        path: input.path,
        changeType: "update",
        replacements: 1,
        removedLines: lineCount(input.oldText),
        addedLines: lineCount(replacement),
      },
    };
  }

  async #create(
    workspace: WorkspaceBoundary,
    input: CreatePatchInput,
    signal: AbortSignal,
  ): Promise<ToolExecutionResult> {
    const target = await workspace.resolveNewFile(input.path);
    let tempPath: string;
    try {
      signal.throwIfAborted();
      tempPath = await writeTemporaryFile(target.absolutePath, input.content, signal);
    } catch {
      signal.throwIfAborted();
      return writeFailure();
    }
    let linked = false;
    try {
      signal.throwIfAborted();
      const currentTarget = await workspace.resolveNewFile(input.path);
      if (currentTarget.absolutePath !== target.absolutePath) {
        throw new ToolDomainError("patch_conflict", "目标父目录在 create 提交前发生变化，已拒绝写入。");
      }
      await link(tempPath, target.absolutePath);
      linked = true;
      await removeTemporaryFile(tempPath);
    } catch (error) {
      try {
        await removeTemporaryFile(tempPath);
      } catch {
        // 保留原始领域错误；临时文件清理失败会在成功路径上作为未知错误暴露。
      }
      if (error instanceof ToolDomainError) {
        throw error;
      }
      signal.throwIfAborted();
      if (!linked) {
        return writeFailure();
      }
      throw error;
    }

    return {
      output: `已创建 ${input.path}。`,
      isError: false,
      metadata: {
        path: input.path,
        changeType: "create",
        replacements: 0,
        bytes: Buffer.byteLength(input.content, "utf8"),
        addedLines: lineCount(input.content),
      },
    };
  }
}
