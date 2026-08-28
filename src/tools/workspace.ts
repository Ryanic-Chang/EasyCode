import { lstat, realpath, stat } from "node:fs/promises";
import * as path from "node:path";

import { ToolDomainError, ToolInputError } from "./errors.js";

const RESERVED_SEGMENTS = new Set([".git", ".easycode"]);
const WINDOWS_DEVICE_NAME = /^(aux|con|nul|prn|com[1-9]|lpt[1-9])(\..*)?$/i;

export const DEFAULT_IGNORED_DIRECTORY_NAMES = new Set([".git", ".easycode", "node_modules", "dist", "coverage"]);

export type WorkspaceEntryType = "file" | "directory" | "symlink" | "other";

export interface ResolvedWorkspaceEntry {
  readonly absolutePath: string;
  readonly canonicalPath: string;
  readonly relativePath: string;
  readonly type: WorkspaceEntryType;
}

function isReservedSegment(segment: string): boolean {
  const normalized = segment.toLowerCase();
  return RESERVED_SEGMENTS.has(normalized) || normalized === ".env" || normalized.startsWith(".env.");
}

export function isReservedPathName(name: string): boolean {
  return isReservedSegment(name);
}

export function isIgnoredDirectoryName(name: string): boolean {
  return DEFAULT_IGNORED_DIRECTORY_NAMES.has(name.toLowerCase());
}

function validateSegment(segment: string): void {
  if (segment.includes(":")) {
    throw new ToolInputError("workspace 相对路径不能包含冒号");
  }
  if (segment.endsWith(".") || segment.endsWith(" ") || WINDOWS_DEVICE_NAME.test(segment)) {
    throw new ToolInputError("workspace 相对路径包含不受支持的 Windows 路径片段");
  }
  if (isReservedSegment(segment)) {
    throw new ToolInputError("不允许访问保留路径");
  }
}

export function normalizeWorkspacePath(value: string, allowRoot: boolean): string {
  if (value.length === 0 || value.includes("\0")) {
    throw new ToolInputError("path 必须是非空且不含 NUL 的 workspace 相对路径");
  }
  const unified = value.replaceAll("\\", "/");
  if (path.posix.isAbsolute(unified) || path.win32.isAbsolute(value) || /^[a-zA-Z]:/.test(unified)) {
    throw new ToolInputError("path 只接受 workspace 相对路径");
  }

  const rawSegments = unified.split("/");
  if (rawSegments.includes("..")) {
    throw new ToolInputError("path 不允许包含路径穿越片段");
  }
  for (const segment of rawSegments) {
    if (segment.length > 0 && segment !== ".") {
      validateSegment(segment);
    }
  }

  const normalized = path.posix.normalize(unified);
  if (normalized === ".") {
    if (!allowRoot) {
      throw new ToolInputError("该工具的 path 不能指向 workspace root");
    }
    return normalized;
  }
  if (normalized.startsWith("../") || normalized === "..") {
    throw new ToolInputError("path 不允许离开 workspace");
  }
  return normalized;
}

function entryType(stats: Awaited<ReturnType<typeof lstat>>): WorkspaceEntryType {
  if (stats.isSymbolicLink()) {
    return "symlink";
  }
  if (stats.isFile()) {
    return "file";
  }
  if (stats.isDirectory()) {
    return "directory";
  }
  return "other";
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function mapFilesystemError(error: unknown): never {
  const code = errorCode(error);
  if (code === "ENOENT") {
    throw new ToolDomainError("not_found", "目标不存在。");
  }
  if (code === "EACCES" || code === "EPERM") {
    throw new ToolDomainError("unreadable", "目标不可访问。");
  }
  throw error;
}

export class WorkspaceBoundary {
  readonly #root: string;

  private constructor(root: string) {
    this.#root = root;
  }

  static async create(root: string): Promise<WorkspaceBoundary> {
    let canonicalRoot: string;
    try {
      canonicalRoot = await realpath(root);
      const rootStats = await stat(canonicalRoot);
      if (!rootStats.isDirectory()) {
        throw new ToolDomainError("invalid_workspace", "workspace root 不是目录。");
      }
    } catch (error) {
      if (error instanceof ToolDomainError) {
        throw error;
      }
      mapFilesystemError(error);
    }
    return new WorkspaceBoundary(canonicalRoot);
  }

  get root(): string {
    return this.#root;
  }

  #assertInside(canonicalPath: string): void {
    const relative = path.relative(this.#root, canonicalPath);
    if (relative === "") {
      return;
    }
    if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
      throw new ToolDomainError("outside_workspace", "目标位于 workspace 之外。");
    }
  }

  #assertCanonicalPathAllowed(canonicalPath: string): void {
    const relative = path.relative(this.#root, canonicalPath);
    if (relative === "") {
      return;
    }
    for (const segment of relative.split(path.sep)) {
      if (isReservedSegment(segment)) {
        throw new ToolDomainError("reserved_path", "不允许访问保留路径。");
      }
    }
  }

  async resolveExisting(relativePath: string, expectedType?: "file" | "directory"): Promise<ResolvedWorkspaceEntry> {
    const normalized = normalizeWorkspacePath(relativePath, true);
    const absolutePath = normalized === "." ? this.#root : path.join(this.#root, ...normalized.split(path.posix.sep));

    try {
      const targetStats = await lstat(absolutePath);
      const canonicalPath = await realpath(absolutePath);
      this.#assertInside(canonicalPath);
      this.#assertCanonicalPathAllowed(canonicalPath);
      const type = entryType(targetStats);
      if (expectedType !== undefined && type !== expectedType) {
        throw new ToolDomainError(
          type === "symlink" ? "symlink_not_allowed" : "wrong_type",
          expectedType === "file" ? "目标不是普通文件。" : "目标不是目录。",
        );
      }
      return { absolutePath, canonicalPath, relativePath: normalized, type };
    } catch (error) {
      if (error instanceof ToolDomainError) {
        throw error;
      }
      mapFilesystemError(error);
    }
  }

  async resolveNewFile(
    relativePath: string,
  ): Promise<{ readonly absolutePath: string; readonly relativePath: string }> {
    const normalized = normalizeWorkspacePath(relativePath, false);
    const logicalPath = path.join(this.#root, ...normalized.split(path.posix.sep));

    try {
      await lstat(logicalPath);
      throw new ToolDomainError("already_exists", "目标已经存在，create 不会覆盖它。");
    } catch (error) {
      if (error instanceof ToolDomainError) {
        throw error;
      }
      if (errorCode(error) !== "ENOENT") {
        mapFilesystemError(error);
      }
    }

    const logicalParent = path.dirname(logicalPath);
    try {
      const canonicalParent = await realpath(logicalParent);
      const parentStats = await stat(canonicalParent);
      this.#assertInside(canonicalParent);
      this.#assertCanonicalPathAllowed(canonicalParent);
      if (!parentStats.isDirectory()) {
        throw new ToolDomainError("wrong_type", "目标父路径不是目录。");
      }
      return { absolutePath: path.join(canonicalParent, path.basename(logicalPath)), relativePath: normalized };
    } catch (error) {
      if (error instanceof ToolDomainError) {
        throw error;
      }
      mapFilesystemError(error);
    }
  }
}
