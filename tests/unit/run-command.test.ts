import { access } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RunCommandTool } from "../../src/tools/run-command.js";
import type { ToolExecutionResult } from "../../src/tools/tool.js";
import { createTemporaryWorkspace, type TemporaryWorkspace } from "../temp-workspace.js";

const workspaces: TemporaryWorkspace[] = [];

async function workspace(): Promise<TemporaryWorkspace> {
  const created = await createTemporaryWorkspace();
  workspaces.push(created);
  return created;
}

function context(root: string, signal = new AbortController().signal) {
  return { cwd: root, signal };
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

describe("run_command", () => {
  it("以 executable + argv、shell:false 分别捕获 stdout/stderr", async () => {
    const fixture = await workspace();
    await fixture.write(
      "report.mjs",
      'process.stdout.write("标准输出：中文\\n"); process.stderr.write("标准错误：中文\\n");\n',
    );
    const result = await new RunCommandTool().execute(
      { executable: process.execPath, args: ["report.mjs"], cwd: ".", timeoutMs: 5000 },
      context(fixture.root),
    );

    expect(result).toMatchObject({ isError: false, output: "命令执行成功。" });
    expect(metadata(result)).toMatchObject({
      kind: "completed",
      exitCode: 0,
      signal: null,
      stdout: "标准输出：中文\n",
      stderr: "标准错误：中文\n",
      timedOut: false,
      truncated: false,
    });
  });

  it("shell metacharacter 只作为普通 argv，不执行第二条命令", async () => {
    const fixture = await workspace();
    await fixture.write("argv.mjs", "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
    const args = ["argv.mjs", "safe", ";", "touch", "injected.txt", "$(echo bad)", "a|b"];
    const result = await new RunCommandTool().execute(
      { executable: process.execPath, args, cwd: ".", timeoutMs: 5000 },
      context(fixture.root),
    );

    expect(metadata(result).stdout).toBe(JSON.stringify(args.slice(1)));
    await expect(access(fixture.resolve("injected.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("非零退出和不存在 executable 返回结构化可恢复失败", async () => {
    const fixture = await workspace();
    await fixture.write("fail.mjs", 'process.stderr.write("fixture failure\\n"); process.exitCode = 7;\n');
    const tool = new RunCommandTool();
    const nonzero = await tool.execute(
      { executable: process.execPath, args: ["fail.mjs"], cwd: ".", timeoutMs: 5000 },
      context(fixture.root),
    );
    const missing = await tool.execute(
      { executable: fixture.resolve("missing-executable"), args: [], cwd: ".", timeoutMs: 5000 },
      context(fixture.root),
    );

    expect(nonzero.isError).toBe(true);
    expect(metadata(nonzero)).toMatchObject({ kind: "nonzero_exit", exitCode: 7, stderr: "fixture failure\n" });
    expect(missing.isError).toBe(true);
    expect(metadata(missing)).toMatchObject({ kind: "spawn_error", exitCode: null });
    expect(JSON.stringify(missing)).not.toContain(fixture.root);
  });

  it("timeout 终止进程并返回 timedOut 结果", async () => {
    const fixture = await workspace();
    await fixture.write("wait.mjs", "setInterval(() => undefined, 10_000);\n");
    const result = await new RunCommandTool().execute(
      { executable: process.execPath, args: ["wait.mjs"], cwd: ".", timeoutMs: 100 },
      context(fixture.root),
    );

    expect(result).toMatchObject({ isError: true, output: "命令执行超时。" });
    expect(metadata(result)).toMatchObject({ kind: "timeout", timedOut: true });
  });

  it("external abort 终止已启动进程并继续表现为 AbortError", async () => {
    const fixture = await workspace();
    await fixture.write(
      "abort.mjs",
      'import { writeFileSync } from "node:fs"; writeFileSync("started", "yes"); setInterval(() => undefined, 10_000);\n',
    );
    const controller = new AbortController();
    const running = new RunCommandTool().execute(
      { executable: process.execPath, args: ["abort.mjs"], cwd: ".", timeoutMs: 10_000 },
      context(fixture.root, controller.signal),
    );
    await vi.waitFor(async () => {
      await expect(access(fixture.resolve("started"))).resolves.toBeUndefined();
    });

    controller.abort();
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
  });

  it("按 bytes 限制总输出并继续 drain", async () => {
    const fixture = await workspace();
    await fixture.write(
      "large-output.mjs",
      'process.stdout.write("界".repeat(30_000)); process.stderr.write("tail");\n',
    );
    const result = await new RunCommandTool().execute(
      { executable: process.execPath, args: ["large-output.mjs"], cwd: ".", timeoutMs: 5000 },
      context(fixture.root),
    );
    const details = metadata(result);

    expect(result.isError).toBe(false);
    expect(
      Buffer.byteLength(String(details.stdout), "utf8") + Buffer.byteLength(String(details.stderr), "utf8"),
    ).toBeLessThanOrEqual(64 * 1024);
    expect(details.truncated).toBe(true);
    expect(String(details.stdout).endsWith("界")).toBe(true);
  });

  it("子进程不继承 API key、secret、token 和 password 变量", async () => {
    const fixture = await workspace();
    await fixture.write(
      "environment.mjs",
      'const keys = ["EASYCODE_API_KEY", "OPENAI_API_KEY", "GITHUB_TOKEN", "DB_PASSWORD", "NORMAL_VALUE"]; process.stdout.write(JSON.stringify(Object.fromEntries(keys.map((key) => [key, process.env[key] ?? null]))));\n',
    );
    const previous = {
      EASYCODE_API_KEY: process.env.EASYCODE_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      GITHUB_TOKEN: process.env.GITHUB_TOKEN,
      DB_PASSWORD: process.env.DB_PASSWORD,
      NORMAL_VALUE: process.env.NORMAL_VALUE,
    };
    Object.assign(process.env, {
      EASYCODE_API_KEY: "fixture-secret",
      OPENAI_API_KEY: "fixture-secret",
      GITHUB_TOKEN: "fixture-token",
      DB_PASSWORD: "fixture-password",
      NORMAL_VALUE: "visible",
    });
    try {
      const result = await new RunCommandTool().execute(
        { executable: process.execPath, args: ["environment.mjs"], cwd: ".", timeoutMs: 5000 },
        context(fixture.root),
      );
      expect(JSON.parse(String(metadata(result).stdout))).toEqual({
        EASYCODE_API_KEY: null,
        OPENAI_API_KEY: null,
        GITHUB_TOKEN: null,
        DB_PASSWORD: null,
        NORMAL_VALUE: "visible",
      });
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  it("cwd 被 canonical boundary 限制在 workspace 目录", async () => {
    const fixture = await workspace();
    await fixture.mkdir("sub");
    await fixture.write("sub/cwd.mjs", "process.stdout.write(process.cwd().endsWith('sub') ? 'inside' : 'wrong');\n");
    const result = await new RunCommandTool().execute(
      { executable: process.execPath, args: ["cwd.mjs"], cwd: "sub", timeoutMs: 5000 },
      context(fixture.root),
    );
    expect(metadata(result).stdout).toBe("inside");
  });
});

describe("run_command parse 安全门", () => {
  it("将省略的 args 规范化为空数组", () => {
    expect(new RunCommandTool().parse({ executable: "fixture.exe" })).toEqual({
      executable: "fixture.exe",
      args: [],
      cwd: ".",
      timeoutMs: 30_000,
    });
  });

  it.each([
    ["shell", { executable: "sh", args: ["-c", "echo bad"] }],
    ["Windows shell", { executable: "cmd.exe", args: ["/c", "echo bad"] }],
    ["npm shim", { executable: "npm.cmd", args: ["test"] }],
    ["Node inline eval", { executable: "node", args: ["-e", "code"] }],
    ["Python inline code", { executable: "python", args: ["-c", "code"] }],
    ["Git push", { executable: "git", args: ["push", "origin", "main"] }],
    ["Git reset", { executable: "git", args: ["reset", "--hard"] }],
    ["package publish", { executable: "npm", args: ["publish"] }],
    ["部署命令", { executable: "kubectl", args: ["apply", "-f", "x"] }],
    ["系统危险命令", { executable: "shutdown", args: ["-h", "now"] }],
  ])("拒绝%s", (_label, input) => {
    expect(() => new RunCommandTool().parse(input)).toThrow();
  });

  it.each([
    { executable: "node", args: [], cwd: "../outside" },
    { executable: "node", args: [], cwd: "safe\\..\\outside" },
    { executable: "node", args: "script.mjs" },
    { executable: "node", args: [], timeoutMs: 0 },
    { executable: "node", args: [], environment: { SECRET: "x" } },
  ])("拒绝 cwd 穿越、非数组参数、无限 timeout 和额外环境字段", (input) => {
    expect(() => new RunCommandTool().parse(input)).toThrow();
  });
});
