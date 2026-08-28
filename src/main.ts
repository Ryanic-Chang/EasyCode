#!/usr/bin/env node

import * as path from "node:path";
import { render } from "ink";
import { createElement } from "react";

import { AgentLoop } from "./agent/loop.js";
import { AgentSession } from "./agent/session.js";
import { ConfigError, type EasyCodeConfig, loadEasyCodeConfig } from "./config/config.js";
import { OpenAICompatibleProvider } from "./llm/openai-compatible/provider.js";
import { createCodingToolRegistry } from "./tools/coding-tools.js";
import { EasyCodeApp } from "./ui/app.js";

const MAX_STEPS = 12;

function writeStartupError(message: string): void {
  process.stderr.write(`EasyCode：${message}\n`);
}

async function main(): Promise<void> {
  let config: EasyCodeConfig;
  try {
    config = loadEasyCodeConfig(process.env);
  } catch (error) {
    writeStartupError(error instanceof ConfigError ? error.message : "启动配置无效");
    process.exitCode = 1;
    return;
  }

  const cwd = process.cwd();
  const provider = new OpenAICompatibleProvider(config);
  const tools = createCodingToolRegistry();
  const agent = new AgentLoop({ provider, tools, model: config.model, cwd, maxSteps: MAX_STEPS });
  const session = new AgentSession(agent);
  const workspace = path.basename(cwd) || "workspace";
  const instance = render(
    createElement(EasyCodeApp, {
      runner: session,
      model: config.model,
      workspace,
      colorEnabled: process.env.NO_COLOR === undefined,
      onFatalError: () => {
        process.exitCode = 1;
      },
    }),
    { exitOnCtrlC: false },
  );

  try {
    await instance.waitUntilExit();
    process.exitCode ??= 0;
  } catch {
    writeStartupError("运行时发生内部错误，应用已安全退出");
    process.exitCode = 1;
  }
}

void main();
