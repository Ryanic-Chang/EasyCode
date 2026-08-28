import { chmod, readdir, readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";

import { ApplyPatchTool } from "../../src/tools/apply-patch.js";
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

async function temporaryFiles(fixture: TemporaryWorkspace, directory = "."): Promise<string[]> {
  return (await readdir(fixture.resolve(directory))).filter((name) => name.includes(".easycode-tmp-"));
}

afterEach(async () => {
  for (const item of workspaces.splice(0)) {
    await item.cleanup();
  }
});

describe("apply_patch update", () => {
  it("唯一精确匹配成功，并保留 CRLF 换行风格和未修改内容", async () => {
    const fixture = await workspace();
    await fixture.write("src/value.ts", "const before = 1;\r\nconst keep = 2;\r\n");
    const tool = new ApplyPatchTool();
    const input = tool.parse({
      operation: "update",
      path: "src/value.ts",
      oldText: "const before = 1;\r\n",
      newText: "const after = 3;\nconst added = 4;\n",
    });

    const result = await tool.execute(input, context(fixture.root));

    expect(result.isError).toBe(false);
    expect(result.output).toBe("已更新 src/value.ts：精确替换 1 处。");
    expect(metadata(result)).toMatchObject({
      path: "src/value.ts",
      changeType: "update",
      replacements: 1,
      removedLines: 2,
      addedLines: 3,
    });
    await expect(readFile(fixture.resolve("src/value.ts"), "utf8")).resolves.toBe(
      "const after = 3;\r\nconst added = 4;\r\nconst keep = 2;\r\n",
    );
    await expect(temporaryFiles(fixture, "src")).resolves.toEqual([]);
  });

  it.each([
    ["零匹配", "missing", "replacement", "no_match"],
    ["多匹配", "same", "replacement", "ambiguous_match"],
    ["no-op", "same", "same", "no_op"],
  ])("%s 时拒绝写入", async (_label, oldText, newText, kind) => {
    const fixture = await workspace();
    const original = "same\nsame\n";
    await fixture.write("value.txt", original);
    const result = await new ApplyPatchTool().execute(
      { operation: "update", path: "value.txt", oldText, newText },
      context(fixture.root),
    );

    expect(result).toMatchObject({ isError: true, metadata: { kind } });
    await expect(readFile(fixture.resolve("value.txt"), "utf8")).resolves.toBe(original);
    await expect(temporaryFiles(fixture)).resolves.toEqual([]);
  });

  it("拒绝更新二进制、无效 UTF-8 和过大文件", async () => {
    const fixture = await workspace();
    await fixture.write("binary.bin", new Uint8Array([0x41, 0x00, 0x42]));
    await fixture.write("invalid.txt", new Uint8Array([0xff, 0xfe]));
    await fixture.write("large.txt", new Uint8Array(MAX_TEXT_FILE_BYTES + 1));
    const tool = new ApplyPatchTool();

    for (const [target, kind] of [
      ["binary.bin", "binary_file"],
      ["invalid.txt", "invalid_utf8"],
      ["large.txt", "file_too_large"],
    ] as const) {
      await expect(
        tool.execute(
          { operation: "update", path: target, oldText: "missing", newText: "replacement" },
          context(fixture.root),
        ),
      ).resolves.toMatchObject({ isError: true, metadata: { kind } });
    }
    await expect(temporaryFiles(fixture)).resolves.toEqual([]);
  });
});

describe("apply_patch create", () => {
  it("在既有父目录中排他创建文件且不遗留临时文件", async () => {
    const fixture = await workspace();
    await fixture.mkdir("src");
    const result = await new ApplyPatchTool().execute(
      { operation: "create", path: "src/new.ts", content: "export const value = 1;\n" },
      context(fixture.root),
    );

    expect(result.isError).toBe(false);
    expect(metadata(result)).toMatchObject({ path: "src/new.ts", changeType: "create", replacements: 0 });
    await expect(readFile(fixture.resolve("src/new.ts"), "utf8")).resolves.toBe("export const value = 1;\n");
    await expect(temporaryFiles(fixture, "src")).resolves.toEqual([]);
  });

  it("拒绝覆盖现有文件或隐式创建父目录", async () => {
    const fixture = await workspace();
    await fixture.write("existing.txt", "keep");
    const tool = new ApplyPatchTool();

    await expect(
      tool.execute({ operation: "create", path: "existing.txt", content: "replace" }, context(fixture.root)),
    ).resolves.toMatchObject({ isError: true, metadata: { kind: "already_exists" } });
    await expect(
      tool.execute({ operation: "create", path: "missing/new.txt", content: "new" }, context(fixture.root)),
    ).resolves.toMatchObject({ isError: true, metadata: { kind: "not_found" } });
    await expect(readFile(fixture.resolve("existing.txt"), "utf8")).resolves.toBe("keep");
    await expect(temporaryFiles(fixture)).resolves.toEqual([]);
  });

  it.skipIf(process.platform === "win32")("写入权限失败后不留下目标或临时文件", async () => {
    const fixture = await workspace();
    await fixture.mkdir("readonly");
    const directory = fixture.resolve("readonly");
    await chmod(directory, 0o500);
    try {
      const result = await new ApplyPatchTool().execute(
        { operation: "create", path: "readonly/new.txt", content: "blocked" },
        context(fixture.root),
      );
      expect(result).toMatchObject({ isError: true, metadata: { kind: "write_failed" } });
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await chmod(directory, 0o700);
    }
  });
});

describe("apply_patch parse", () => {
  it.each([
    { operation: "update", path: "file.txt", oldText: "", newText: "x" },
    { operation: "create", path: "file.txt", content: "x", extra: true },
    { operation: "delete", path: "file.txt" },
    { operation: "create", path: ".env", content: "secret" },
  ])("拒绝无效、扩展或保留路径参数", (input) => {
    expect(() => new ApplyPatchTool().parse(input)).toThrow();
  });
});
