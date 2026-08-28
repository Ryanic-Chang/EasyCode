import { afterEach, describe, expect, it } from "vitest";

import { ListDirectoryTool } from "../../src/tools/list-directory.js";
import { ReadFileTool } from "../../src/tools/read-file.js";
import { SearchFilesTool } from "../../src/tools/search-files.js";
import { MAX_TEXT_FILE_BYTES } from "../../src/tools/text.js";
import type { ToolExecutionResult } from "../../src/tools/tool.js";
import { createTemporaryWorkspace, type TemporaryWorkspace } from "../temp-workspace.js";

const workspaces: TemporaryWorkspace[] = [];

async function workspace(): Promise<TemporaryWorkspace> {
  const created = await createTemporaryWorkspace();
  workspaces.push(created);
  return created;
}

function context(root: string) {
  return { cwd: root, signal: new AbortController().signal };
}

function metadata(result: ToolExecutionResult): Readonly<Record<string, unknown>> {
  expect(result.metadata).toBeDefined();
  return result.metadata ?? {};
}

afterEach(async () => {
  for (const item of workspaces.splice(0)) {
    await item.cleanup();
  }
});

describe("list_directory", () => {
  it("稳定排序、区分类型、遵守深度并忽略保留和生成目录", async () => {
    const fixture = await workspace();
    await fixture.write("z.txt", "z");
    await fixture.write("a.txt", "a");
    await fixture.write("src/nested/file.ts", "export {};\n");
    await fixture.write("node_modules/pkg/index.js", "ignored");
    await fixture.write("dist/out.js", "ignored");
    await fixture.write("coverage/report.txt", "ignored");
    await fixture.write(".git/config", "ignored");
    await fixture.write(".env", "ignored");

    const shallow = await new ListDirectoryTool().execute({ path: ".", depth: 1 }, context(fixture.root));
    expect(shallow.output.split("\n")).toEqual(["file\ta.txt", "directory\tsrc/", "file\tz.txt"]);
    expect(metadata(shallow)).toMatchObject({ entries: 3, truncated: true });

    const deep = await new ListDirectoryTool().execute({ path: ".", depth: 3 }, context(fixture.root));
    expect(deep.output).toContain("file\tsrc/nested/file.ts");
    expect(deep.output).not.toContain("node_modules");
    expect(deep.output).not.toContain(".env");
    expect(metadata(deep)).toMatchObject({ truncated: false });
  });

  it("目录不存在或类型错误形成可恢复失败", async () => {
    const fixture = await workspace();
    await fixture.write("file.txt", "x");
    const tool = new ListDirectoryTool();

    await expect(tool.execute({ path: "missing", depth: 1 }, context(fixture.root))).resolves.toMatchObject({
      isError: true,
      metadata: { kind: "not_found" },
    });
    await expect(tool.execute({ path: "file.txt", depth: 1 }, context(fixture.root))).resolves.toMatchObject({
      isError: true,
      metadata: { kind: "wrong_type" },
    });
  });

  it("达到输出 bytes 上限时返回稳定截断结果", async () => {
    const fixture = await workspace();
    await fixture.mkdir("many");
    for (let index = 0; index < 500; index += 1) {
      await fixture.write(`many/${String(index).padStart(3, "0")}-${"x".repeat(55)}.txt`, "x");
    }

    const result = await new ListDirectoryTool().execute({ path: "many", depth: 1 }, context(fixture.root));

    expect(Buffer.byteLength(result.output, "utf8")).toBeLessThanOrEqual(32 * 1024);
    expect(metadata(result)).toMatchObject({ truncated: true });
  });
});

describe("search_files", () => {
  it("执行 literal 搜索，返回稳定相对路径和 1-based 行号，并支持大小写开关", async () => {
    const fixture = await workspace();
    await fixture.write("b.txt", "Agent\nother\n");
    await fixture.write("a.txt", "agent first\nAgent second\n");
    const tool = new SearchFilesTool();

    const insensitive = await tool.execute({ query: "agent", path: ".", caseSensitive: false }, context(fixture.root));
    expect(insensitive.output.split("\n")).toEqual(["a.txt:1: agent first", "a.txt:2: Agent second", "b.txt:1: Agent"]);

    const sensitive = await tool.execute({ query: "agent", path: ".", caseSensitive: true }, context(fixture.root));
    expect(sensitive.output).toBe("a.txt:1: agent first");
  });

  it("跳过二进制、无效 UTF-8、过大文件和保留目录", async () => {
    const fixture = await workspace();
    await fixture.write("binary.bin", new Uint8Array([0x41, 0x00, 0x42]));
    await fixture.write("invalid.txt", new Uint8Array([0xff, 0xfe]));
    await fixture.write("large.txt", new Uint8Array(MAX_TEXT_FILE_BYTES + 1));
    await fixture.write(".git/secret.txt", "needle");
    await fixture.write("ok.txt", "needle\n");
    const result = await new SearchFilesTool().execute(
      { query: "needle", path: ".", caseSensitive: false },
      context(fixture.root),
    );

    expect(result.output).toBe("ok.txt:1: needle");
    expect(metadata(result)).toMatchObject({ matches: 1, scannedFiles: 4, skippedFiles: 3 });
  });

  it("达到匹配上限时返回截断 metadata", async () => {
    const fixture = await workspace();
    await fixture.write("many.txt", Array.from({ length: 120 }, (_, index) => `needle ${index}`).join("\n"));
    const result = await new SearchFilesTool().execute(
      { query: "needle", path: ".", caseSensitive: true },
      context(fixture.root),
    );

    expect(result.output.split("\n")).toHaveLength(100);
    expect(metadata(result)).toMatchObject({ matches: 100, truncated: true });
  });

  it("query 按 literal 处理而不是 regex 或 shell", async () => {
    const fixture = await workspace();
    await fixture.write("literal.txt", "a.*b\naZZb\n$(touch escaped)\n");
    const tool = new SearchFilesTool();
    const regexLike = await tool.execute({ query: "a.*b", path: ".", caseSensitive: true }, context(fixture.root));
    const shellLike = await tool.execute(
      { query: "$(touch escaped)", path: ".", caseSensitive: true },
      context(fixture.root),
    );

    expect(regexLike.output).toBe("literal.txt:1: a.*b");
    expect(shellLike.output).toBe("literal.txt:3: $(touch escaped)");
  });
});

describe("read_file", () => {
  it("读取带稳定行号的 inclusive 行范围", async () => {
    const fixture = await workspace();
    await fixture.write("notes.txt", "第一行\r\n第二行\r\n第三行");
    const result = await new ReadFileTool().execute(
      { path: "notes.txt", startLine: 2, endLine: 3 },
      context(fixture.root),
    );

    expect(result.output).toBe("2: 第二行\n3: 第三行");
    expect(metadata(result)).toMatchObject({ startLine: 2, endLine: 3, totalLines: 3, truncated: false });
  });

  it.each([
    ["missing.txt", "not_found"],
    ["directory", "wrong_type"],
  ])("区分不可读取目标 %s", async (target, kind) => {
    const fixture = await workspace();
    await fixture.mkdir("directory");
    const result = await new ReadFileTool().execute({ path: target }, context(fixture.root));
    expect(result).toMatchObject({ isError: true, metadata: { kind } });
  });

  it("区分二进制、无效 UTF-8、文件过大和越界范围", async () => {
    const fixture = await workspace();
    await fixture.write("binary.bin", new Uint8Array([0x41, 0x00, 0x42]));
    await fixture.write("invalid.txt", new Uint8Array([0xff, 0xfe]));
    await fixture.write("large.txt", new Uint8Array(MAX_TEXT_FILE_BYTES + 1));
    await fixture.write("short.txt", "only");
    const tool = new ReadFileTool();

    for (const [target, kind] of [
      ["binary.bin", "binary_file"],
      ["invalid.txt", "invalid_utf8"],
      ["large.txt", "file_too_large"],
    ] as const) {
      await expect(tool.execute({ path: target }, context(fixture.root))).resolves.toMatchObject({
        isError: true,
        metadata: { kind },
      });
    }
    await expect(
      tool.execute({ path: "short.txt", startLine: 2, endLine: 2 }, context(fixture.root)),
    ).resolves.toMatchObject({ isError: true, metadata: { kind: "range_out_of_bounds" } });
  });

  it("达到输出 bytes 上限时不破坏 UTF-8 并标记 truncated", async () => {
    const fixture = await workspace();
    await fixture.write("long.txt", "界".repeat(20_000));
    const result = await new ReadFileTool().execute({ path: "long.txt" }, context(fixture.root));

    expect(Buffer.byteLength(result.output, "utf8")).toBeLessThanOrEqual(32 * 1024);
    expect(result.output.endsWith("界")).toBe(true);
    expect(metadata(result)).toMatchObject({ truncated: true });
  });
});
