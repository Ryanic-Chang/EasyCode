import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";

import { AgentLoop } from "../../src/agent/loop.js";
import { createCodingToolRegistry } from "../../src/tools/coding-tools.js";
import { collectAgentRun } from "../agent-run.js";
import { FakeProvider } from "../fake-provider.js";
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

describe("M3 Agent 离线闭环", () => {
  it("真实工具完成搜索、读取、patch、命令验证、结果回传和最终回答", async () => {
    const fixture = await workspace();
    await fixture.write("src/value.txt", "TODO\n");
    await fixture.write(
      "verify.mjs",
      'import { readFileSync } from "node:fs"; const value = readFileSync("src/value.txt", "utf8"); if (value !== "DONE\\n") { process.stderr.write("not updated\\n"); process.exit(7); } process.stdout.write("verified\\n");\n',
    );
    const provider = new FakeProvider([
      [
        {
          type: "tool_call",
          index: 0,
          id: "search-1",
          name: "search_files",
          arguments: { query: "TODO", path: ".", caseSensitive: true },
        },
        {
          type: "tool_call",
          index: 1,
          id: "read-1",
          name: "read_file",
          arguments: { path: "src/value.txt" },
        },
        { type: "finish", reason: "tool_calls" },
      ],
      [
        {
          type: "tool_call",
          index: 0,
          id: "patch-1",
          name: "apply_patch",
          arguments: { operation: "update", path: "src/value.txt", oldText: "TODO", newText: "DONE" },
        },
        { type: "finish", reason: "tool_calls" },
      ],
      [
        {
          type: "tool_call",
          index: 0,
          id: "command-1",
          name: "run_command",
          arguments: { executable: process.execPath, args: ["verify.mjs"], cwd: ".", timeoutMs: 5000 },
        },
        { type: "finish", reason: "tool_calls" },
      ],
      [
        { type: "text_delta", delta: "修改并验证完成" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const agent = new AgentLoop({
      provider,
      tools: createCodingToolRegistry(),
      model: "fake-model",
      cwd: fixture.root,
      maxSteps: 4,
    });

    const run = await collectAgentRun(agent.run([{ role: "user", content: "将 TODO 改为 DONE 并验证" }]));

    expect(run.result.reason).toBe("complete");
    expect(run.result.step).toBe(4);
    await expect(readFile(fixture.resolve("src/value.txt"), "utf8")).resolves.toBe("DONE\n");
    expect(provider.requests).toHaveLength(4);
    expect(provider.requests[1]?.messages.filter((message) => message.role === "tool")).toHaveLength(2);
    expect(provider.requests[1]?.messages.at(-2)).toMatchObject({
      role: "tool",
      toolName: "search_files",
      isError: false,
    });
    expect(provider.requests[1]?.messages.at(-1)).toMatchObject({
      role: "tool",
      toolName: "read_file",
      isError: false,
    });
    expect(provider.requests[3]?.messages.at(-1)).toMatchObject({
      role: "tool",
      toolName: "run_command",
      isError: false,
      metadata: { kind: "completed", stdout: "verified\n", exitCode: 0 },
    });
    expect(run.events.map((event) => event.type)).toEqual([
      "turn_start",
      "tool_start",
      "tool_end",
      "tool_start",
      "tool_end",
      "turn_start",
      "tool_start",
      "tool_end",
      "turn_start",
      "tool_start",
      "tool_end",
      "turn_start",
      "assistant_delta",
      "complete",
    ]);
    expect(run.events.filter((event) => event.type === "tool_start").map((event) => event.toolCall.name)).toEqual([
      "search_files",
      "read_file",
      "apply_patch",
      "run_command",
    ]);
  });

  it("patch 冲突作为失败 ToolResult 回传，Agent 可继续完成", async () => {
    const fixture = await workspace();
    await fixture.write("value.txt", "original\n");
    const provider = new FakeProvider([
      [
        {
          type: "tool_call",
          index: 0,
          id: "patch-fail",
          name: "apply_patch",
          arguments: { operation: "update", path: "value.txt", oldText: "missing", newText: "new" },
        },
        { type: "finish", reason: "tool_calls" },
      ],
      [
        { type: "text_delta", delta: "检测到冲突，未覆盖文件" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const agent = new AgentLoop({
      provider,
      tools: createCodingToolRegistry(),
      model: "fake-model",
      cwd: fixture.root,
      maxSteps: 2,
    });

    const run = await collectAgentRun(agent.run([{ role: "user", content: "尝试修改" }]));

    expect(run.result.reason).toBe("complete");
    expect(provider.requests[1]?.messages.at(-1)).toMatchObject({
      role: "tool",
      toolName: "apply_patch",
      isError: true,
      metadata: { kind: "no_match" },
    });
    await expect(readFile(fixture.resolve("value.txt"), "utf8")).resolves.toBe("original\n");
  });

  it("命令非零退出作为结构化失败 ToolResult 回传，Agent 不崩溃", async () => {
    const fixture = await workspace();
    await fixture.write("fail.mjs", 'process.stderr.write("validation failed\\n"); process.exitCode = 9;\n');
    const provider = new FakeProvider([
      [
        {
          type: "tool_call",
          index: 0,
          id: "command-fail",
          name: "run_command",
          arguments: { executable: process.execPath, args: ["fail.mjs"], cwd: ".", timeoutMs: 5000 },
        },
        { type: "finish", reason: "tool_calls" },
      ],
      [
        { type: "text_delta", delta: "验证失败已报告" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const agent = new AgentLoop({
      provider,
      tools: createCodingToolRegistry(),
      model: "fake-model",
      cwd: fixture.root,
      maxSteps: 2,
    });

    const run = await collectAgentRun(agent.run([{ role: "user", content: "运行验证" }]));

    expect(run.result.reason).toBe("complete");
    expect(provider.requests[1]?.messages.at(-1)).toMatchObject({
      role: "tool",
      toolName: "run_command",
      isError: true,
      metadata: { kind: "nonzero_exit", exitCode: 9, stderr: "validation failed\n" },
    });
    expect(run.events.filter((event) => event.type === "error")).toHaveLength(0);
  });
});
