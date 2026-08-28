import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(projectRoot, "dist");
const compiler = path.join(projectRoot, "node_modules", "typescript", "bin", "tsc");

if (path.dirname(outputDirectory) !== projectRoot || path.basename(outputDirectory) !== "dist") {
  throw new Error("拒绝清理非预期构建目录");
}

await rm(outputDirectory, { recursive: true, force: true });

const exitCode = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [compiler, "-p", "tsconfig.build.json"], {
    cwd: projectRoot,
    stdio: "inherit",
    shell: false,
    windowsHide: true,
  });
  child.once("error", reject);
  child.once("exit", (code, signal) => resolve(code ?? (signal === null ? 1 : 128)));
});

if (exitCode !== 0) {
  process.exitCode = exitCode;
}
