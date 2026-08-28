import type { Dirent } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import * as path from "node:path";

import { domainFailure, ToolDomainError } from "./errors.js";
import { MAX_TOOL_OUTPUT_BYTES } from "./text.js";
import type { Tool, ToolContext, ToolExecutionResult } from "./tool.js";
import { optionalInteger, optionalString, rejectUnknownKeys, requireRecord } from "./validation.js";
import {
  isIgnoredDirectoryName,
  isReservedPathName,
  normalizeWorkspacePath,
  WorkspaceBoundary,
  type WorkspaceEntryType,
} from "./workspace.js";

const MAX_DEPTH = 4;
const MAX_ENTRIES = 500;

export interface ListDirectoryInput {
  readonly path: string;
  readonly depth: number;
}

interface ListingState {
  readonly lines: string[];
  entries: number;
  outputBytes: number;
  unreadable: number;
  truncated: boolean;
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function classify(stats: Awaited<ReturnType<typeof lstat>>): WorkspaceEntryType {
  if (stats.isSymbolicLink()) {
    return "symlink";
  }
  if (stats.isDirectory()) {
    return "directory";
  }
  if (stats.isFile()) {
    return "file";
  }
  return "other";
}

function displayLine(type: WorkspaceEntryType | "unreadable", relativePath: string): string {
  return `${type}\t${relativePath}${type === "directory" ? "/" : ""}`;
}

function appendLine(state: ListingState, line: string): boolean {
  const bytes = Buffer.byteLength(`${line}\n`, "utf8");
  if (state.entries >= MAX_ENTRIES || state.outputBytes + bytes > MAX_TOOL_OUTPUT_BYTES) {
    state.truncated = true;
    return false;
  }
  state.lines.push(line);
  state.entries += 1;
  state.outputBytes += bytes;
  return true;
}

async function walkDirectory(
  absoluteDirectory: string,
  logicalDirectory: string,
  remainingDepth: number,
  signal: AbortSignal,
  state: ListingState,
): Promise<void> {
  signal.throwIfAborted();
  let entries: Dirent<string>[];
  try {
    entries = await readdir(absoluteDirectory, { withFileTypes: true });
  } catch {
    signal.throwIfAborted();
    state.unreadable += 1;
    appendLine(state, displayLine("unreadable", logicalDirectory));
    return;
  }

  entries.sort((left, right) => compareNames(left.name, right.name));
  for (const entry of entries) {
    signal.throwIfAborted();
    if (isReservedPathName(entry.name) || (entry.isDirectory() && isIgnoredDirectoryName(entry.name))) {
      continue;
    }

    const relativePath = logicalDirectory === "." ? entry.name : `${logicalDirectory}/${entry.name}`;
    const absolutePath = path.join(absoluteDirectory, entry.name);
    let type: WorkspaceEntryType;
    try {
      type = classify(await lstat(absolutePath));
    } catch {
      signal.throwIfAborted();
      state.unreadable += 1;
      if (!appendLine(state, displayLine("unreadable", relativePath))) {
        return;
      }
      continue;
    }

    if (!appendLine(state, displayLine(type, relativePath))) {
      return;
    }
    if (type === "directory" && !isIgnoredDirectoryName(entry.name)) {
      if (remainingDepth > 1) {
        await walkDirectory(absolutePath, relativePath, remainingDepth - 1, signal, state);
        if (state.truncated) {
          return;
        }
      } else {
        state.truncated = true;
      }
    }
  }
}

export class ListDirectoryTool implements Tool<ListDirectoryInput> {
  readonly name = "list_directory";
  readonly description = "按稳定顺序列出 workspace 内目录，区分 file、directory 与 symlink，不跟随 symlink。";
  readonly inputSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      path: { type: "string", description: "workspace 相对目录；默认为 ." },
      depth: { type: "integer", minimum: 1, maximum: MAX_DEPTH, description: "递归深度" },
    },
  } as const;

  parse(input: unknown): ListDirectoryInput {
    const record = requireRecord(input);
    rejectUnknownKeys(record, ["path", "depth"]);
    const relativePath = optionalString(record, "path", 1024) ?? ".";
    return {
      path: normalizeWorkspacePath(relativePath, true),
      depth: optionalInteger(record, "depth", 1, 1, MAX_DEPTH),
    };
  }

  async execute(input: ListDirectoryInput, context: ToolContext): Promise<ToolExecutionResult> {
    context.signal.throwIfAborted();
    try {
      const workspace = await WorkspaceBoundary.create(context.cwd);
      const target = await workspace.resolveExisting(input.path, "directory");
      const state: ListingState = {
        lines: [],
        entries: 0,
        outputBytes: 0,
        unreadable: 0,
        truncated: false,
      };
      await walkDirectory(target.canonicalPath, input.path, input.depth, context.signal, state);
      return {
        output: state.lines.length === 0 ? "（空目录）" : state.lines.join("\n"),
        isError: false,
        metadata: {
          path: input.path,
          depth: input.depth,
          entries: state.entries,
          unreadable: state.unreadable,
          truncated: state.truncated,
        },
      };
    } catch (error) {
      if (error instanceof ToolDomainError) {
        return domainFailure(error);
      }
      throw error;
    }
  }
}
