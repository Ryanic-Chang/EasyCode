import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

export interface TemporaryWorkspace {
  readonly root: string;
  resolve(relativePath: string): string;
  mkdir(relativePath: string): Promise<void>;
  write(relativePath: string, contents: string | Uint8Array): Promise<void>;
  cleanup(): Promise<void>;
}

export async function createTemporaryWorkspace(): Promise<TemporaryWorkspace> {
  const root = await mkdtemp(path.join(tmpdir(), "easycode-m3-"));
  return {
    root,
    resolve(relativePath) {
      return path.join(root, ...relativePath.replaceAll("\\", "/").split("/"));
    },
    async mkdir(relativePath) {
      await mkdir(path.join(root, ...relativePath.split("/")), { recursive: true });
    },
    async write(relativePath, contents) {
      const target = path.join(root, ...relativePath.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, contents);
    },
    async cleanup() {
      await rm(root, { force: true, recursive: true });
    },
  };
}
