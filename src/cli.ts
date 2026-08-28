import { readFileSync } from "node:fs";

export type CliAction = "run" | "help" | "version" | "invalid";

export const HELP_TEXT = `EasyCode — 中文优先的轻量 Coding Agent

用法：
  easycode              启动交互界面
  easycode --help       显示帮助
  easycode --version    显示版本

启动交互界面前需配置 EASYCODE_API_KEY、EASYCODE_BASE_URL 和 EASYCODE_MODEL。
`;

export const UNKNOWN_ARGUMENT_TEXT = "EasyCode：未知参数。请运行 easycode --help 查看用法。\n";

export function parseCliArguments(arguments_: readonly string[]): CliAction {
  if (arguments_.length === 0) {
    return "run";
  }
  if (arguments_.length === 1 && arguments_[0] === "--help") {
    return "help";
  }
  if (arguments_.length === 1 && arguments_[0] === "--version") {
    return "version";
  }
  return "invalid";
}

export function readPackageVersion(): string {
  const packageJsonUrl = new URL("../package.json", import.meta.url);
  const parsed: unknown = JSON.parse(readFileSync(packageJsonUrl, "utf8"));
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("version" in parsed) ||
    typeof parsed.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(parsed.version)
  ) {
    throw new Error("package.json version is invalid");
  }
  return parsed.version;
}
