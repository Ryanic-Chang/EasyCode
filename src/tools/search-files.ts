import type { Dirent } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import * as path from "node:path";

import { domainFailure, ToolDomainError, ToolInputError } from "./errors.js";
import { MAX_TEXT_FILE_BYTES, MAX_TOOL_OUTPUT_BYTES, readUtf8File, truncateUtf8 } from "./text.js";
import type { Tool, ToolContext, ToolExecutionResult } from "./tool.js";
import { optionalBoolean, optionalString, rejectUnknownKeys, requireRecord, requireString } from "./validation.js";
import { isIgnoredDirectoryName, isReservedPathName, normalizeWorkspacePath, WorkspaceBoundary } from "./workspace.js";

const MAX_SEARCH_DEPTH = 8;
const MAX_SCANNED_FILES = 1000;
const MAX_MATCHES = 100;
const MAX_QUERY_LENGTH = 256;
const MAX_SUMMARY_BYTES = 300;

export interface SearchFilesInput {
  readonly query: string;
  readonly path: string;
  readonly caseSensitive: boolean;
}

interface SearchState {
  readonly input: SearchFilesInput;
  readonly signal: AbortSignal;
  readonly lines: string[];
  readonly skipped: Array<{ readonly path: string; readonly reason: string }>;
  matches: number;
  scannedFiles: number;
  skippedFiles: number;
  outputBytes: number;
  truncated: boolean;
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function safeSummary(line: string): string {
  const normalized = [...line]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || codePoint === 127 ? " " : character;
    })
    .join("")
    .trim();
  return truncateUtf8(normalized, MAX_SUMMARY_BYTES).value;
}

function appendMatch(state: SearchState, relativePath: string, lineNumber: number, line: string): boolean {
  const output = `${relativePath}:${lineNumber}: ${safeSummary(line)}`;
  const bytes = Buffer.byteLength(`${output}\n`, "utf8");
  if (state.matches >= MAX_MATCHES || state.outputBytes + bytes > MAX_TOOL_OUTPUT_BYTES) {
    state.truncated = true;
    return false;
  }
  state.lines.push(output);
  state.matches += 1;
  state.outputBytes += bytes;
  return true;
}

async function searchFile(absolutePath: string, relativePath: string, state: SearchState): Promise<void> {
  if (state.scannedFiles >= MAX_SCANNED_FILES) {
    state.truncated = true;
    return;
  }
  state.scannedFiles += 1;

  let text: string;
  try {
    text = (await readUtf8File(absolutePath, state.signal, MAX_TEXT_FILE_BYTES)).text;
  } catch (error) {
    state.signal.throwIfAborted();
    state.skippedFiles += 1;
    if (state.skipped.length < 20) {
      state.skipped.push({
        path: relativePath,
        reason: error instanceof ToolDomainError ? error.code : "unreadable",
      });
    }
    return;
  }

  const needle = state.input.caseSensitive ? state.input.query : state.input.query.toLowerCase();
  const lines = text.split(/\r\n|\n|\r/);
  for (const [index, line] of lines.entries()) {
    state.signal.throwIfAborted();
    const haystack = state.input.caseSensitive ? line : line.toLowerCase();
    if (haystack.includes(needle) && !appendMatch(state, relativePath, index + 1, line)) {
      return;
    }
  }
}

async function walk(
  absoluteDirectory: string,
  logicalDirectory: string,
  remainingDepth: number,
  state: SearchState,
): Promise<void> {
  state.signal.throwIfAborted();
  let entries: Dirent<string>[];
  try {
    entries = await readdir(absoluteDirectory, { withFileTypes: true });
  } catch {
    state.signal.throwIfAborted();
    state.skippedFiles += 1;
    if (state.skipped.length < 20) {
      state.skipped.push({ path: logicalDirectory, reason: "unreadable" });
    }
    return;
  }
  entries.sort((left, right) => compareNames(left.name, right.name));

  for (const entry of entries) {
    state.signal.throwIfAborted();
    if (state.truncated) {
      return;
    }
    if (isReservedPathName(entry.name) || (entry.isDirectory() && isIgnoredDirectoryName(entry.name))) {
      continue;
    }
    const absolutePath = path.join(absoluteDirectory, entry.name);
    const relativePath = logicalDirectory === "." ? entry.name : `${logicalDirectory}/${entry.name}`;
    let stats: Awaited<ReturnType<typeof lstat>>;
    try {
      stats = await lstat(absolutePath);
    } catch {
      state.signal.throwIfAborted();
      state.skippedFiles += 1;
      if (state.skipped.length < 20) {
        state.skipped.push({ path: relativePath, reason: "unreadable" });
      }
      continue;
    }
    if (stats.isSymbolicLink()) {
      state.skippedFiles += 1;
      if (state.skipped.length < 20) {
        state.skipped.push({ path: relativePath, reason: "symlink" });
      }
    } else if (stats.isFile()) {
      await searchFile(absolutePath, relativePath, state);
    } else if (stats.isDirectory()) {
      if (remainingDepth > 1) {
        await walk(absolutePath, relativePath, remainingDepth - 1, state);
      } else {
        state.truncated = true;
      }
    }
  }
}

export class SearchFilesTool implements Tool<SearchFilesInput> {
  readonly name = "search_files";
  readonly description = "在 workspace 内对 UTF-8 文本执行有界 literal 搜索，返回相对路径、行号和安全摘要。";
  readonly inputSchema = {
    type: "object",
    additionalProperties: false,
    required: ["query"],
    properties: {
      query: { type: "string", minLength: 1, maxLength: MAX_QUERY_LENGTH },
      path: { type: "string", description: "workspace 相对目录；默认为 ." },
      caseSensitive: { type: "boolean", description: "是否区分大小写；默认 false" },
    },
  } as const;

  parse(input: unknown): SearchFilesInput {
    const record = requireRecord(input);
    rejectUnknownKeys(record, ["query", "path", "caseSensitive"]);
    const query = requireString(record, "query", MAX_QUERY_LENGTH);
    if (query.trim().length === 0 || query.includes("\n") || query.includes("\r")) {
      throw new ToolInputError("query 必须包含可搜索的单行 literal 文本");
    }
    const relativePath = optionalString(record, "path", 1024) ?? ".";
    return {
      query,
      path: normalizeWorkspacePath(relativePath, true),
      caseSensitive: optionalBoolean(record, "caseSensitive", false),
    };
  }

  async execute(input: SearchFilesInput, context: ToolContext): Promise<ToolExecutionResult> {
    context.signal.throwIfAborted();
    try {
      const workspace = await WorkspaceBoundary.create(context.cwd);
      const target = await workspace.resolveExisting(input.path, "directory");
      const state: SearchState = {
        input,
        signal: context.signal,
        lines: [],
        skipped: [],
        matches: 0,
        scannedFiles: 0,
        skippedFiles: 0,
        outputBytes: 0,
        truncated: false,
      };
      await walk(target.canonicalPath, input.path, MAX_SEARCH_DEPTH, state);
      return {
        output: state.lines.length === 0 ? "未找到匹配。" : state.lines.join("\n"),
        isError: false,
        metadata: {
          path: input.path,
          caseSensitive: input.caseSensitive,
          matches: state.matches,
          scannedFiles: state.scannedFiles,
          skippedFiles: state.skippedFiles,
          skipped: state.skipped,
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
