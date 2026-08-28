import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { HELP_TEXT, parseCliArguments, readPackageVersion, UNKNOWN_ARGUMENT_TEXT } from "../../src/cli.js";

describe("CLI 交付面", () => {
  it("无参数启动 TUI，帮助和版本参数可离线识别", () => {
    expect(parseCliArguments([])).toBe("run");
    expect(parseCliArguments(["--help"])).toBe("help");
    expect(parseCliArguments(["--version"])).toBe("version");
    expect(HELP_TEXT).toContain("中文优先");
  });

  it("未知参数和组合参数稳定拒绝且不回显输入", () => {
    expect(parseCliArguments(["--unknown-secret"])).toBe("invalid");
    expect(parseCliArguments(["--help", "extra"])).toBe("invalid");
    expect(UNKNOWN_ARGUMENT_TEXT).toBe("EasyCode：未知参数。请运行 easycode --help 查看用法。\n");
    expect(UNKNOWN_ARGUMENT_TEXT).not.toContain("unknown-secret");
  });

  it("CLI 版本以 package.json 为唯一来源", async () => {
    const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as {
      version: string;
    };
    const changelog = await readFile(new URL("../../CHANGELOG.md", import.meta.url), "utf8");
    const firstChangelogVersion = /^## \[([^\]]+)\]/m.exec(changelog)?.[1];
    expect(readPackageVersion()).toBe(packageJson.version);
    expect(firstChangelogVersion).toBe(packageJson.version);
  });
});
