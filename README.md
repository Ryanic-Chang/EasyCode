# EasyCode

EasyCode v0.1.0 是一个中文优先、可解释、可验证的轻量 Coding Agent。它独立实现 Agent Loop，通过 OpenAI-compatible Provider 流式调用模型，并在显式 workspace 内受控地搜索、读取、精确修改代码和运行命令。

项目保持 `private: true`，当前只支持从源码或本地 tarball 安装，禁止 `npm publish`。

## 环境要求

- Node.js >= 22；
- 随 Node.js 安装的 npm；
- Windows、macOS 或 Linux 终端。

## 从源码安装与启动

```bash
git clone https://github.com/Ryanic-Chang/EasyCode.git
cd EasyCode
npm ci
npm run build
npm start
```

`npm start` 与无参数 `easycode` 都会启动 Ink TUI，并将启动时的 `process.cwd()` 作为唯一 workspace root。项目不会隐式切换目录，也不会自动读取 `.env`。

无需 Provider 配置即可查看交付面：

```bash
node dist/main.js --help
node dist/main.js --version
```

## tarball 安装验证

正式打包前会自动执行最新构建。以下命令只预览 allowlist，不发布 package：

```bash
npm pack --dry-run --json --cache .easycode/pack-cache
npm run test:package
```

`test:package` 使用系统临时目录中的隔离 cache 生成 tarball，在空目录安装生产依赖，并通过安装后的 `easycode` bin 验证 `--version`、`--help`、未知参数和无配置启动；CLI 阶段有网络请求防线，结束后清理 tarball、安装目录和 cache。

如需手工安装已生成的 tarball：

```bash
npm install ./easycode-0.1.0.tgz
npx easycode --help
```

## Provider 配置

启动交互界面前必须在当前进程环境提供：

```text
EASYCODE_API_KEY
EASYCODE_BASE_URL
EASYCODE_MODEL
```

`EASYCODE_BASE_URL` 是包含服务 API 前缀的绝对 `http` 或 `https` URL；Provider 会保留路径并追加 `/chat/completions`。不要把真实值写入 `.env`、源码、终端历史、issue 或日志。

可选配置：

| 环境变量 | 默认值 | 范围 |
| --- | ---: | ---: |
| `EASYCODE_MAX_RETRIES` | `2` | `0–5` |
| `EASYCODE_RETRY_BASE_DELAY_MS` | `500` | `50–5000` ms |
| `EASYCODE_REQUEST_TIMEOUT_MS` | `30000` | `1000–120000` ms |

缺失或非法配置会在 Ink 启动前以稳定中文错误非零退出。`--help` 和 `--version` 在读取配置前完成，不接触网络或凭据。

## 中文交互与命令确认

- 输入中文任务并按 Enter；运行期间输入暂停，完成后可继续下一条；
- 助手文本流式显示，工具开始、成功、失败与终止原因有独立状态；
- 每个 `run_command` ToolCall 都会请求一次确认，只有按 `y` 才执行，按 `n` 或 Enter 默认拒绝；确认不能解锁工具硬拒绝的危险命令；
- 运行中第一次 Ctrl+C 请求取消并等待 Provider/工具清理，第二次表示清理后退出；空闲时 Ctrl+C 直接退出；
- 设置 `NO_COLOR=1` 可关闭颜色，状态文字仍保持完整。

Windows 上 `.cmd`/`.bat` 不能作为 Agent 的 `run_command` executable，是因为该工具坚持 `shell:false`；这不表示用户不能在 PowerShell 或 cmd 中使用 `npm` 管理项目。

## 测试、评测与真实调用

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm run check
npm run eval:offline
npm run test:package
npm run license:check
```

- `npm test`：fake、fixture、临时 workspace 驱动的模块与集成契约，不请求真实服务；
- `npm run eval:offline`：scripted Provider 驱动 7 个版本化 coding 场景，客观 grader 检查文件/hash、非预期修改、验证程序、终止与预算；进入普通 CI；
- `npm run test:package`：最小 tarball 的隔离安装与 CLI 交付验证；
- `npm run test:smoke`：真实 Provider 的最小协议 smoke，只有 `EASYCODE_SMOKE=1` 时启用；
- `npm run eval:real`：可选真实 Provider 评测，只有 `EASYCODE_REAL_EVAL=1` 和完整配置同时存在才启用。

后两项会访问网络，可能产生费用、限流或凭据风险，不进入 `npm test`、`npm run check` 或普通 CI。v0.1.0 交付验收不运行它们。

offline/real eval 报告写入被 Git 忽略的 `.easycode/evals/<runId>.json`。报告包含 schema、revision、环境、依赖、模型配置、客观断言、终止与聚合指标，但不保存任务、消息正文、ToolCall arguments、ToolResult 正文、API key、Authorization、完整 URL query 或环境变量。

## 安全边界与费用提醒

- 模型输出是不可信输入；整轮 ToolCall 完整组装、工具存在、JSON 与 schema 全部通过后才可能执行；
- 文件工具只接受 workspace 内相对路径，通过 canonical 路径拒绝穿越和外部 symlink/junction，并保护 `.git`、`.easycode` 与 `.env*`；
- `apply_patch` 只做唯一精确替换或排他创建；`run_command` 使用 executable + argv、限长结构化 stdin、`shell:false`、cwd、timeout、abort、输出上限和敏感环境过滤；
- Provider 只在成功流开始前对 network、timeout、408/409/429/5xx 有界重试，不在流开始后重放。一次逻辑请求的重试仍可能产生重复 API 计费；
- 这些边界不是容器或 OS 级强沙箱。允许的进程仍拥有当前用户权限，可能访问网络、workspace 外资源或创建后代进程；Session 回滚也不会撤销已完成的文件或命令副作用。

## 故障排查与已知限制

配置、鉴权、限流、timeout、窄终端、Windows executable 和 pack/cache 问题见 [故障排查](docs/TROUBLESHOOTING.md)。

v0.1.0 主动不提供：Session 持久化或恢复、长期记忆、context compression、OpenTelemetry、远程日志/dashboard、多 Provider 路由、自动选模、Git push/PR 工具、插件、GUI、容器沙箱或完整进程树隔离。也不执行 npm 发布、Git tag 或 GitHub Release。

## 工程文档

- [架构说明](docs/ARCHITECTURE.md)
- [开发路线图](docs/ROADMAP.md)
- [设计决策](docs/DECISIONS.md)
- [验收标准](docs/ACCEPTANCE.md)
- [安全边界](docs/SECURITY.md)
- [离线演示](docs/DEMO.md)
- [故障排查](docs/TROUBLESHOOTING.md)
- [第三方软件声明](docs/THIRD_PARTY_NOTICES.md)
- [交付检查清单](docs/RELEASE_CHECKLIST.md)
- [更新日志](CHANGELOG.md)

许可证：MIT，见 [LICENSE](LICENSE)。
