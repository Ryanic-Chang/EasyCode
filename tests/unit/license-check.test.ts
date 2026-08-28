import { spawn } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("生产依赖许可证清单", () => {
  it("与实际安装依赖保持一致且许可证已审查", async () => {
    const result = await new Promise<{ code: number; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [path.resolve("scripts/check-licenses.mjs")], {
        cwd: process.cwd(),
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code: code ?? 1, stderr }));
    });

    expect(result.code, result.stderr).toBe(0);
  });
});
