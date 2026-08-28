import { access, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ApplyPatchTool } from "../../src/tools/apply-patch.js";
import { ListDirectoryTool } from "../../src/tools/list-directory.js";
import { ReadFileTool } from "../../src/tools/read-file.js";
import { RunCommandTool } from "../../src/tools/run-command.js";
import { SearchFilesTool } from "../../src/tools/search-files.js";
import { normalizeWorkspacePath, WorkspaceBoundary } from "../../src/tools/workspace.js";
import { createTemporaryWorkspace, type TemporaryWorkspace } from "../temp-workspace.js";

const workspaces: TemporaryWorkspace[] = [];

async function workspace(): Promise<TemporaryWorkspace> {
  const created = await createTemporaryWorkspace();
  workspaces.push(created);
  return created;
}

afterEach(async () => {
  for (const item of workspaces.splice(0)) {
    await item.cleanup();
  }
});

describe("workspace path boundary", () => {
  it.each(["../outside", "safe/../outside", "safe\\..\\outside", "/absolute", "C:\\absolute", "\\\\server\\share"])(
    "拒绝穿越或绝对路径：%s",
    (candidate) => {
      expect(() => normalizeWorkspacePath(candidate, true)).toThrow();
    },
  );

  it.each([".git/config", ".GIT/config", ".env", ".env.local", ".easycode/session.json", "nested/.env"])(
    "拒绝保留路径：%s",
    (candidate) => {
      expect(() => normalizeWorkspacePath(candidate, true)).toThrow();
    },
  );

  it("允许显式 workspace root，并对文件工具拒绝 root", () => {
    expect(normalizeWorkspacePath(".", true)).toBe(".");
    expect(() => normalizeWorkspacePath(".", false)).toThrow();
  });

  it("拒绝 Windows device、ADS、尾随点和空格语义", () => {
    for (const candidate of ["NUL", "con.txt", "file:stream", "name.", "name "]) {
      expect(() => normalizeWorkspacePath(candidate, true)).toThrow();
    }
  });

  it("现有文件、目录和不存在父目录具有明确类型边界", async () => {
    const fixture = await workspace();
    await fixture.write("src/main.ts", "export {};\n");
    const boundary = await WorkspaceBoundary.create(fixture.root);

    await expect(boundary.resolveExisting("src/main.ts", "file")).resolves.toMatchObject({
      relativePath: "src/main.ts",
      type: "file",
    });
    await expect(boundary.resolveExisting("src", "directory")).resolves.toMatchObject({ type: "directory" });
    await expect(boundary.resolveExisting("src", "file")).rejects.toMatchObject({ code: "wrong_type" });
    await expect(boundary.resolveExisting("missing", "file")).rejects.toMatchObject({ code: "not_found" });
    await expect(boundary.resolveNewFile("missing/file.ts")).rejects.toMatchObject({ code: "not_found" });
  });

  it("外部 junction/symlink 不能用于读取、搜索、列举、写入或 command cwd", async () => {
    const fixture = await workspace();
    const outside = await workspace();
    await outside.write("secret.txt", "outside\n");
    await symlink(outside.root, fixture.resolve("escape"), process.platform === "win32" ? "junction" : "dir");
    const context = { cwd: fixture.root, signal: new AbortController().signal };

    const results = await Promise.all([
      new ListDirectoryTool().execute({ path: "escape", depth: 1 }, context),
      new SearchFilesTool().execute({ path: "escape", query: "outside", caseSensitive: false }, context),
      new ReadFileTool().execute({ path: "escape/secret.txt" }, context),
      new ApplyPatchTool().execute({ operation: "create", path: "escape/new.txt", content: "blocked" }, context),
      new RunCommandTool().execute(
        { executable: process.execPath, args: ["missing.mjs"], cwd: "escape", timeoutMs: 1000 },
        context,
      ),
    ]);

    expect(results.every((result) => result.isError)).toBe(true);
    expect(JSON.stringify(results)).not.toContain(outside.root);
    await expect(readFile(outside.resolve("secret.txt"), "utf8")).resolves.toBe("outside\n");
  });

  it("内部 symlink 只作为条目展示、不递归；内部 symlink parent 可在 canonical 检查后写入", async () => {
    const fixture = await workspace();
    await fixture.mkdir("real");
    await symlink(fixture.resolve("real"), fixture.resolve("link"), process.platform === "win32" ? "junction" : "dir");
    const context = { cwd: fixture.root, signal: new AbortController().signal };

    const listing = await new ListDirectoryTool().execute({ path: ".", depth: 2 }, context);
    expect(listing.output).toContain("symlink\tlink");
    expect(listing.output).not.toContain("link/");
    await expect(new ListDirectoryTool().execute({ path: "link", depth: 1 }, context)).resolves.toMatchObject({
      isError: true,
      metadata: { kind: "symlink_not_allowed" },
    });

    const created = await new ApplyPatchTool().execute(
      { operation: "create", path: "link/new.txt", content: "inside" },
      context,
    );
    expect(created.isError).toBe(false);
    await expect(readFile(fixture.resolve("real/new.txt"), "utf8")).resolves.toBe("inside");
  });

  it("所有工具 parse 失败均不创建 workspace 或其他副作用", async () => {
    const marker = path.join(tmpdir(), `easycode-parse-marker-${process.pid}-${Date.now()}`);
    const invalidCalls = [
      () => new ListDirectoryTool().parse({ path: "../outside" }),
      () => new SearchFilesTool().parse({ query: " ", path: marker }),
      () => new ReadFileTool().parse({ path: marker, startLine: 0 }),
      () => new ApplyPatchTool().parse({ operation: "create", path: marker, content: "x" }),
      () => new RunCommandTool().parse({ executable: "sh", args: [], cwd: marker }),
    ];

    for (const call of invalidCalls) {
      expect(call).toThrow();
    }
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("五个工具都保持预先触发的 abort，不包装为普通失败", async () => {
    const fixture = await workspace();
    await fixture.write("file.txt", "value\n");
    const controller = new AbortController();
    controller.abort();
    const abortedContext = { cwd: fixture.root, signal: controller.signal };
    const executions = [
      () => new ListDirectoryTool().execute({ path: ".", depth: 1 }, abortedContext),
      () => new SearchFilesTool().execute({ path: ".", query: "value", caseSensitive: true }, abortedContext),
      () => new ReadFileTool().execute({ path: "file.txt" }, abortedContext),
      () =>
        new ApplyPatchTool().execute(
          { operation: "update", path: "file.txt", oldText: "value", newText: "next" },
          abortedContext,
        ),
      () =>
        new RunCommandTool().execute(
          { executable: process.execPath, args: ["file.txt"], cwd: ".", timeoutMs: 1000 },
          abortedContext,
        ),
    ];

    for (const execution of executions) {
      await expect(execution()).rejects.toMatchObject({ name: "AbortError" });
    }
    await expect(readFile(fixture.resolve("file.txt"), "utf8")).resolves.toBe("value\n");
  });
});
