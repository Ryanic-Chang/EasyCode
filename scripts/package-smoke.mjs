import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npmCli = process.env.npm_execpath;
if (npmCli === undefined || npmCli.length === 0) {
  throw new Error("缺少 npm_execpath；请通过 npm run test:package 运行");
}

function run(command, arguments_, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd: options.cwd ?? projectRoot,
      env: options.env ?? process.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code: code ?? (signal === null ? 1 : 128), stdout, stderr }));
  });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function cleanProviderEnvironment(environment) {
  const result = { ...environment };
  for (const name of Object.keys(result)) {
    if (name.startsWith("EASYCODE_")) {
      delete result[name];
    }
  }
  return result;
}

const temporaryRoot = await mkdtemp(path.join(tmpdir(), "easycode-package-smoke-"));
const cacheDirectory = path.join(temporaryRoot, "npm-cache");
const tarballDirectory = path.join(temporaryRoot, "tarball");
const installDirectory = path.join(temporaryRoot, "install");
const networkMarker = path.join(temporaryRoot, "network-attempted");
const networkGuard = path.join(temporaryRoot, "network-guard.mjs");
const npmEnvironment = cleanProviderEnvironment(process.env);

try {
  const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
  await mkdir(tarballDirectory, { recursive: true });
  await mkdir(installDirectory, { recursive: true });
  await writeFile(
    networkGuard,
    `import { appendFileSync } from "node:fs";\nconst originalFetch = globalThis.fetch;\nglobalThis.fetch = async (input, init) => { const candidate = typeof input === "string" || input instanceof URL ? input : input.url; const protocol = new URL(candidate, "http://relative.invalid").protocol; if (protocol === "http:" || protocol === "https:") { appendFileSync(process.env.EASYCODE_NETWORK_MARKER, "network\\n"); throw new Error("package smoke 禁止网络请求"); } return originalFetch(input, init); };\n`,
    "utf8",
  );

  const packResult = await run(
    process.execPath,
    [npmCli, "pack", "--json", "--pack-destination", tarballDirectory, "--cache", cacheDirectory],
    { env: npmEnvironment },
  );
  assert(packResult.code === 0, `npm pack 失败：${packResult.stderr || packResult.stdout}`);
  const packOutput = JSON.parse(packResult.stdout);
  assert(Array.isArray(packOutput) && packOutput.length === 1, "npm pack 未返回唯一 tarball");
  const packed = packOutput[0];
  assert(typeof packed.filename === "string" && Array.isArray(packed.files), "npm pack JSON 结构无效");

  const packedFiles = packed.files.map((entry) => entry.path.replaceAll("\\", "/")).sort();
  const requiredFiles = [
    "CHANGELOG.md",
    "LICENSE",
    "README.md",
    "dist/main.js",
    "docs/SECURITY.md",
    "docs/THIRD_PARTY_NOTICES.md",
    "docs/TROUBLESHOOTING.md",
    "package.json",
  ];
  for (const required of requiredFiles) {
    assert(packedFiles.includes(required), `tarball 缺少运行或交付文件：${required}`);
  }
  const forbidden = packedFiles.filter(
    (file) =>
      /(^|\/)(?:src|tests|evals|fixtures?|coverage|\.easycode|\.github|scripts|cache)(?:\/|$)/.test(file) ||
      /(?:^|\/)(?:AGENTS\.md|tsconfig[^/]*\.json|vitest\.config\.ts|biome\.json|\.env(?:\..*)?)$/.test(file) ||
      /\.(?:map|ts|tsx|tgz)$/.test(file),
  );
  assert(forbidden.length === 0, `tarball 含禁止文件：${forbidden.join(", ")}`);

  const tarballPath = path.join(tarballDirectory, packed.filename);
  await access(tarballPath, constants.R_OK);
  await writeFile(path.join(temporaryRoot, "empty-package.json"), "{}\n", "utf8");
  await copyFile(path.join(temporaryRoot, "empty-package.json"), path.join(installDirectory, "package.json"));

  const installResult = await run(
    process.execPath,
    [
      npmCli,
      "install",
      tarballPath,
      "--omit=dev",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--cache",
      cacheDirectory,
    ],
    { cwd: installDirectory, env: npmEnvironment },
  );
  assert(installResult.code === 0, `tarball 安装失败：${installResult.stderr || installResult.stdout}`);

  const dependencyResult = await run(process.execPath, [npmCli, "ls", "--omit=dev", "--all", "--json"], {
    cwd: installDirectory,
    env: npmEnvironment,
  });
  assert(dependencyResult.code === 0, `生产依赖不完整：${dependencyResult.stderr || dependencyResult.stdout}`);

  const installedRoot = path.join(installDirectory, "node_modules", packageJson.name);
  const installedPackage = JSON.parse(await readFile(path.join(installedRoot, "package.json"), "utf8"));
  assert(installedPackage.version === packageJson.version, "安装后版本与源码 package.json 不一致");
  assert(installedPackage.bin?.easycode === "./dist/main.js", "安装后 bin 映射不正确");
  const installedEntry = path.join(installedRoot, "dist", "main.js");
  const entryText = await readFile(installedEntry, "utf8");
  assert(entryText.startsWith("#!/usr/bin/env node\n"), "CLI 入口缺少 POSIX shebang");

  const launcher = path.join(
    installDirectory,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "easycode.cmd" : "easycode",
  );
  await access(launcher, constants.R_OK);
  if (process.platform !== "win32") {
    const launcherMode = (await stat(launcher)).mode;
    assert((launcherMode & 0o111) !== 0, "POSIX bin 不可执行");
  }

  const cliEnvironment = { ...npmEnvironment };
  cliEnvironment.NO_COLOR = "1";
  cliEnvironment.EASYCODE_NETWORK_MARKER = networkMarker;
  cliEnvironment.NODE_OPTIONS = `--import=${pathToFileURL(networkGuard).href}`;

  async function runInstalled(arguments_) {
    const command = process.platform === "win32" ? process.execPath : launcher;
    const cliArguments = process.platform === "win32" ? [installedEntry, ...arguments_] : arguments_;
    return run(command, cliArguments, {
      cwd: installDirectory,
      env: cliEnvironment,
    });
  }

  const versionResult = await runInstalled(["--version"]);
  assert(versionResult.code === 0, `--version exit code 应为 0，实际为 ${versionResult.code}`);
  assert(versionResult.stdout === `${packageJson.version}\n`, "--version stdout 不稳定或版本漂移");
  assert(versionResult.stderr === "", "--version 不应写 stderr");

  const helpResult = await runInstalled(["--help"]);
  assert(helpResult.code === 0, `--help exit code 应为 0，实际为 ${helpResult.code}`);
  assert(
    helpResult.stdout.includes("用法：") && helpResult.stdout.includes("easycode --version"),
    "--help 缺少中文用法",
  );
  assert(helpResult.stderr === "", "--help 不应写 stderr");

  const unknownResult = await runInstalled(["--unknown-package-smoke"]);
  assert(unknownResult.code === 2, `未知参数 exit code 应为 2，实际为 ${unknownResult.code}`);
  assert(unknownResult.stdout === "", "未知参数不应写 stdout");
  assert(unknownResult.stderr === "EasyCode：未知参数。请运行 easycode --help 查看用法。\n", "未知参数错误不稳定");

  const noConfigResult = await runInstalled([]);
  assert(noConfigResult.code === 1, `无配置启动 exit code 应为 1，实际为 ${noConfigResult.code}`);
  assert(noConfigResult.stdout === "", "无配置启动不应写 stdout");
  assert(noConfigResult.stderr === "EasyCode：缺少必需配置：EASYCODE_API_KEY\n", "无配置启动错误不稳定");

  let networkEvidence;
  try {
    networkEvidence = await readFile(networkMarker, "utf8");
  } catch {}
  assert(networkEvidence === undefined, "CLI smoke 期间发生了 http(s) 网络请求");

  process.stdout.write(
    `package smoke 通过：${packedFiles.length} 个 tarball 文件，${packageJson.name}@${packageJson.version} 可安装且 CLI 行为稳定。\n`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
