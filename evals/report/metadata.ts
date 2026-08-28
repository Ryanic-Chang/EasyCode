import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as path from "node:path";

import type { EvaluationMode, ReproductionMetadata } from "../core/types.js";

async function capture(executable: string, args: readonly string[], cwd: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(executable, [...args], {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes <= 64 * 1024) {
        chunks.push(chunk);
      }
    });
    child.stderr.resume();
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0 || bytes > 64 * 1024) {
        reject(new Error("无法读取评测复现元数据"));
        return;
      }
      resolve(Buffer.concat(chunks).toString("utf8").trim());
    });
  });
}

export interface MetadataOptions {
  readonly root: string;
  readonly mode: EvaluationMode;
  readonly model: string;
  readonly seed: number;
  readonly command: string;
  readonly retry: ReproductionMetadata["retry"];
  readonly now?: () => Date;
  readonly runId?: () => string;
}

export async function collectMetadata(options: MetadataOptions): Promise<ReproductionMetadata> {
  const [gitCommit, dirtyOutput, packageLock] = await Promise.all([
    capture("git", ["rev-parse", "HEAD"], options.root),
    capture("git", ["status", "--porcelain"], options.root),
    readFile(path.join(options.root, "package-lock.json")),
  ]);
  const lock = JSON.parse(packageLock.toString("utf8")) as {
    readonly packages?: Readonly<
      Record<
        string,
        {
          readonly version?: string;
          readonly dependencies?: Readonly<Record<string, string>>;
          readonly devDependencies?: Readonly<Record<string, string>>;
        }
      >
    >;
  };
  const rootPackage = lock.packages?.[""];
  const declared = { ...(rootPackage?.dependencies ?? {}), ...(rootPackage?.devDependencies ?? {}) };
  const topLevelDependencies = Object.fromEntries(
    Object.keys(declared)
      .sort((left, right) => left.localeCompare(right, "en"))
      .map((name) => [name, lock.packages?.[`node_modules/${name}`]?.version ?? declared[name] ?? "unknown"]),
  );
  return {
    runId: (options.runId ?? randomUUID)(),
    startedAt: (options.now ?? (() => new Date()))().toISOString(),
    mode: options.mode,
    gitCommit,
    gitDirty: dirtyOutput.length > 0,
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    packageLockSha256: createHash("sha256").update(packageLock).digest("hex"),
    topLevelDependencies,
    model: options.model,
    maxStepsPolicy: "scenario",
    retry: options.retry,
    seed: options.seed,
    command: options.command,
  };
}
