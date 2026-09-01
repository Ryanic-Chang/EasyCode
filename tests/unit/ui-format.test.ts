import { describe, expect, it } from "vitest";

import type { ToolCall, ToolResult } from "../../src/agent/messages.js";
import { summarizeText, summarizeToolCall, summarizeToolResult, terminationReasonText } from "../../src/ui/format.js";

describe("TUI 安全摘要", () => {
  it.each([
    ["list_directory", { path: "src", depth: 2 }, "src · depth 2"],
    ["search_files", { query: "AgentLoop", path: "src" }, "“AgentLoop” · src"],
    ["read_file", { path: "src/main.ts", startLine: 2, endLine: 8 }, "src/main.ts · 2–8 行"],
    [
      "apply_patch",
      { operation: "update", path: "src/main.ts", oldText: "SECRET", newText: "x" },
      "update · src/main.ts",
    ],
    ["run_command", { executable: "node", args: ["verify.mjs"], cwd: "." }, "node verify.mjs · ."],
  ])("为 %s 只显示允许字段", (name, argumentsValue, expected) => {
    const call: ToolCall = { id: "call", name, arguments: argumentsValue };
    const summary = summarizeToolCall(call);
    expect(summary).toBe(expected);
    expect(summary).not.toContain("SECRET");
  });

  it("命令摘要只显示 stdin 字节数，不显示正文", () => {
    const summary = summarizeToolCall({
      id: "stdin-call",
      name: "run_command",
      arguments: { executable: "fixture.exe", stdin: "SENSITIVE_STDIN\n" },
    });
    expect(summary).toContain("stdin 16 bytes");
    expect(summary).not.toContain("SENSITIVE_STDIN");
  });

  it("对长文本保留首尾、省略中间并脱敏", () => {
    const summary = summarizeText(`begin ${"x".repeat(500)} sk-example_secret_123456789 end`, 80);
    expect(summary.length).toBeLessThanOrEqual(81);
    expect(summary).toContain("[已省略]");
    expect(summary).toContain("[已隐藏]");
    expect(summary).not.toContain("sk-example");
    expect(summarizeText("--token=TOP_SECRET_VALUE")).toBe("--token=[已隐藏]");
  });

  it("截断时不拆分 Unicode 字素", () => {
    const summary = summarizeText(`开头${"中".repeat(20)}👩‍💻${"文".repeat(20)}结尾`, 20);
    expect(summary).not.toContain("�");
    expect(summary).toContain("[已省略]");
  });

  it("工具失败优先显示有界 stderr，成功优先使用 metadata", () => {
    const failed: ToolResult = {
      toolCallId: "call",
      toolName: "run_command",
      output: "命令失败",
      isError: true,
      metadata: { stderr: "validation failed", exitCode: 7 },
    };
    const succeeded: ToolResult = {
      toolCallId: "read",
      toolName: "read_file",
      output: "完整文件内容不应展示",
      isError: false,
      metadata: { startLine: 2, endLine: 9, truncated: true },
    };
    expect(summarizeToolResult(failed)).toBe("validation failed");
    expect(summarizeToolResult(succeeded)).toBe("读取 2–9 行，内容已截断");
  });

  it("所有终止原因都有中文映射", () => {
    expect(
      ["complete", "aborted", "provider_error", "protocol_error", "internal_error", "max_steps"].map((reason) =>
        terminationReasonText(reason as Parameters<typeof terminationReasonText>[0]),
      ),
    ).toEqual(["任务完成", "任务已取消", "模型服务错误", "模型协议错误", "内部执行错误", "达到最大轮次"]);
  });
});
