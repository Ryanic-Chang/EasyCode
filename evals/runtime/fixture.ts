import { createHash } from "node:crypto";
import { cp, lstat, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

export type FileSnapshot = ReadonlyMap<string, string>;

export interface IsolatedFixture {
  readonly root: string;
  cleanup(): Promise<void>;
}

function relativePath(root: string, filePath: string): string {
  return path.relative(root, filePath).split(path.sep).join("/");
}

export async function snapshotFiles(root: string): Promise<FileSnapshot> {
  const result = new Map<string, string>();
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const fileStat = await lstat(absolutePath);
      if (fileStat.isSymbolicLink()) {
        throw new Error("fixture 不允许包含符号链接");
      }
      if (fileStat.isDirectory()) {
        await visit(absolutePath);
      } else if (fileStat.isFile()) {
        const digest = createHash("sha256")
          .update(await readFile(absolutePath))
          .digest("hex");
        result.set(relativePath(root, absolutePath), digest);
      }
    }
  }
  await visit(root);
  return result;
}

export function changedFiles(before: FileSnapshot, after: FileSnapshot): string[] {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((filePath) => before.get(filePath) !== after.get(filePath)).sort();
}

export async function createIsolatedFixture(fixturesRoot: string, fixture: string): Promise<IsolatedFixture> {
  if (!/^[a-z0-9-]+$/.test(fixture)) {
    throw new Error("fixture 名称无效");
  }
  const source = path.join(fixturesRoot, fixture);
  const tempRoot = await mkdtemp(path.join(tmpdir(), "easycode-eval-"));
  const workspace = path.join(tempRoot, "workspace");
  try {
    await cp(source, workspace, { recursive: true, errorOnExist: true });
  } catch (error) {
    await rm(tempRoot, { recursive: true, force: true });
    throw error;
  }
  return {
    root: workspace,
    async cleanup(): Promise<void> {
      await rm(tempRoot, { recursive: true, force: true });
    },
  };
}
