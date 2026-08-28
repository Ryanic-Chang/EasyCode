import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJsonPath = path.join(projectRoot, "package.json");
const packageLockPath = path.join(projectRoot, "package-lock.json");
const licensePath = path.join(projectRoot, "LICENSE");
const noticesPath = path.join(projectRoot, "docs", "THIRD_PARTY_NOTICES.md");
const writeMode = process.argv.slice(2).includes("--write");

const compatibleLicenses = new Set([
  "MIT",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "Apache-2.0",
  "MIT OR Apache-2.0",
  "(MIT OR CC0-1.0)",
]);

function parseJson(text, source) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${source} 不是有效 JSON`);
  }
}

function renderNotices(entries) {
  const rows = entries.map(({ name, version, license }) => `| ${name} | ${version} | ${license} |`).join("\n");
  return `# 第三方软件声明

本文件由 \`npm run license:update\` 根据当前实际安装的生产依赖 metadata 生成。依赖发生变化后必须重新生成，并由 \`npm run license:check\` 防止清单漂移。

EasyCode 本身采用 MIT License。以下许可证标识来自对应 npm package 的 \`package.json\`；完整许可证文本随各 package 发布内容提供。

| Package | Version | License |
| --- | --- | --- |
${rows}
`;
}

const rootPackage = parseJson(await readFile(packageJsonPath, "utf8"), "package.json");
const packageLock = parseJson(await readFile(packageLockPath, "utf8"), "package-lock.json");
const rootLicense = await readFile(licensePath, "utf8");

if (rootPackage.license !== "MIT" || !rootLicense.startsWith("MIT License")) {
  throw new Error("package.json license 字段必须与 LICENSE 的 MIT License 一致");
}

const lockPackages = packageLock.packages;
if (typeof lockPackages !== "object" || lockPackages === null) {
  throw new Error("package-lock.json 缺少 packages 索引");
}

const entries = [];
const problems = [];
for (const [relativePath, lockEntry] of Object.entries(lockPackages)) {
  if (!relativePath.includes("node_modules/") && !relativePath.startsWith("node_modules/")) {
    continue;
  }
  if (typeof lockEntry !== "object" || lockEntry === null || lockEntry.dev === true) {
    continue;
  }

  const installedPackagePath = path.join(projectRoot, relativePath, "package.json");
  let installedPackage;
  try {
    installedPackage = parseJson(await readFile(installedPackagePath, "utf8"), installedPackagePath);
  } catch (error) {
    if (lockEntry.optional === true) {
      continue;
    }
    problems.push(error instanceof Error ? error.message : `无法读取 ${relativePath}`);
    continue;
  }

  const { name, version, license } = installedPackage;
  if (typeof name !== "string" || typeof version !== "string") {
    problems.push(`${relativePath} 缺少有效的 name 或 version`);
    continue;
  }
  if (typeof license !== "string" || license.length === 0) {
    problems.push(`${name}@${version} 缺少 license`);
    continue;
  }
  if (!compatibleLicenses.has(license)) {
    problems.push(`${name}@${version} 使用未审查或不兼容的许可证：${license}`);
    continue;
  }
  entries.push({ name, version, license });
}

entries.sort((left, right) => {
  const leftId = `${left.name}@${left.version}`;
  const rightId = `${right.name}@${right.version}`;
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
});

if (problems.length > 0) {
  throw new Error(`生产依赖许可证检查失败：\n- ${problems.join("\n- ")}`);
}

const expected = renderNotices(entries);
if (writeMode) {
  await writeFile(noticesPath, expected, "utf8");
  process.stdout.write(`已更新 ${path.relative(projectRoot, noticesPath)}（${entries.length} 个生产依赖）\n`);
} else {
  let actual;
  try {
    actual = await readFile(noticesPath, "utf8");
  } catch {
    throw new Error("缺少 docs/THIRD_PARTY_NOTICES.md；请运行 npm run license:update");
  }
  if (actual !== expected) {
    throw new Error("docs/THIRD_PARTY_NOTICES.md 与当前生产依赖不一致；请运行 npm run license:update");
  }
  process.stdout.write(`许可证检查通过：${entries.length} 个生产依赖，清单无漂移。\n`);
}
