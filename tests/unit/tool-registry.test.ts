import { describe, expect, it } from "vitest";

import { ToolRegistry } from "../../src/tools/registry.js";
import { FakeTool } from "../fake-tool.js";

describe("ToolRegistry", () => {
  it("按注册顺序公开工具描述，并把解析后的输入封装为待执行工具", async () => {
    const registry = new ToolRegistry();
    const tool = new FakeTool({
      name: "echo",
      description: "回显文本",
      inputSchema: { type: "object", required: ["value"] },
      parse(input) {
        return String(input);
      },
      execute(input) {
        return { output: input, isError: false };
      },
    });
    registry.register(tool);

    expect(registry.list()).toEqual([
      { name: "echo", description: "回显文本", inputSchema: { type: "object", required: ["value"] } },
    ]);
    const prepared = registry.prepare("echo", 42);
    expect(prepared).toBeDefined();
    await expect(prepared?.execute({ cwd: "workspace", signal: new AbortController().signal })).resolves.toEqual({
      output: "42",
      isError: false,
    });
    expect(tool.parseInputs).toEqual([42]);
    expect(tool.executions.map(({ input }) => input)).toEqual(["42"]);
  });

  it("拒绝重复或带首尾空白的工具名称", () => {
    const registry = new ToolRegistry();
    const createTool = (name: string) =>
      new FakeTool({
        name,
        parse: (input) => input,
        execute: () => ({ output: "", isError: false }),
      });

    registry.register(createTool("echo"));
    expect(() => registry.register(createTool("echo"))).toThrow("工具名称重复");
    expect(() => registry.register(createTool(" invalid "))).toThrow("工具名称必须");
  });
});
