# EasyCode

**中文优先、能真实读代码、改代码并验证结果的轻量 Coding Agent。**

EasyCode v0.2.0 独立实现 Agent Loop，不依赖 Agent Framework。它通过 OpenAI-compatible 流式 Provider 驱动五个本地工具，在明确的 workspace 内完成“观察 → 修改 → 验证 → 根据结果继续”的闭环。

四项核心能力：

- 真实 Agent Loop：多轮上下文、流式文本、ToolCall 增量组装、结构化终止；
- 五个本地工具：列目录、搜索、读文件、精确修改、执行单个命令；
- 安全确认：`run_command` 坚持 `shell:false`，每次调用单独确认，Enter 默认拒绝；
- 真实评测：离线 scripted 回归与可选真实 Provider eval 分离，成功由客观 grader 判断。

```text
中文 Ink TUI → Agent Session → Agent Loop ┬→ OpenAI-compatible Provider
                                          └→ Tool Registry → 5 个受控工具
                         AgentEvent → TUI / Metrics
```

项目保持 `private: true`，支持源码运行和本地 tarball 验证，不执行 `npm publish`。

## 30 秒安装与启动

要求 Node.js >= 22 与 npm。

```bash
git clone https://github.com/Ryanic-Chang/EasyCode.git
cd EasyCode
npm ci
npm run build
npm start
```

无网络、无配置也可查看交付面：

```bash
node dist/main.js --help
node dist/main.js --version
```

无参数启动会把当前 `process.cwd()` 作为唯一 workspace root。项目不会自动读取 `.env`。

## Provider 配置

启动 TUI 前，在当前进程环境提供：

```text
EASYCODE_API_KEY
EASYCODE_BASE_URL
EASYCODE_MODEL
```

`EASYCODE_BASE_URL` 是 OpenAI-compatible API 前缀，EasyCode 会保留路径并追加 `/chat/completions`。项目已用阿里云百炼兼容地址与 Qwen Function Calling 做过真实 smoke/eval；百炼演示建议显式设置 `EASYCODE_ENABLE_THINKING=false`。该变量只接受 `true` 或 `false`，未配置时请求中完全省略 `enable_thinking`，不影响其他 OpenAI-compatible 服务。

| 可选变量 | 默认值 | 范围 |
| --- | ---: | ---: |
| `EASYCODE_MAX_RETRIES` | `2` | `0–5` |
| `EASYCODE_RETRY_BASE_DELAY_MS` | `500` | `50–5000` ms |
| `EASYCODE_REQUEST_TIMEOUT_MS` | `30000` | `1000–120000` ms |
| `EASYCODE_ENABLE_THINKING` | 省略 | `true` / `false` |

不要把真实 key 写入 `.env`、源码、终端记录、issue 或日志。真实调用可能产生费用，重试也可能重复计费。

## 中文交互与安全确认

- 输入任务并按 Enter；助手文本与工具状态流式呈现；
- 每个 `run_command` 都出现一次性授权框：`y` 允许，`n` 或 Enter 拒绝；
- 命令使用 `executable + args + 可选 stdin`，不启动 shell；`|`、`>`、`&&` 不具有 shell 语义；
- stdin 正文不会显示在 TUI，只显示 UTF-8 byte 数；
- 运行中第一次 Ctrl+C 请求取消并等待清理，空闲时 Ctrl+C 退出；
- `NO_COLOR=1` 可关闭颜色，文字状态仍完整。

确认门不能把硬拒绝的 shell、危险 Git、发布/部署、workspace 外访问变成允许操作；它也不是容器或 OS 级沙箱。允许的进程仍拥有当前用户权限，Session 回滚不会撤销已完成的文件或命令副作用。

Windows 上 `.cmd`/`.bat` 不能作为 Agent 工具的 executable，是 `shell:false` 的安全限制，不表示用户不能在 PowerShell 或 cmd 中用 npm 管理项目。

## 测试、评测与演示

```bash
npm run check
npm run eval:offline
npm run test:package
npm run license:check
```

- `npm test`：fake、fixture 与临时 workspace 驱动的确定性测试，无网络；
- `npm run eval:offline`：7 个版本化场景，客观检查文件/hash、修改集合、验证脚本、终止与预算，进入普通 CI；
- `npm run test:smoke`：仅 `EASYCODE_SMOKE=1` 时请求真实 Provider；
- `npm run eval:real`：仅 `EASYCODE_REAL_EVAL=1` 且配置完整时运行，使用独立真实模型预算，不进入普通 CI；
- `npm run test:package`：在临时空目录安装最小 tarball 并验证 CLI。

评测报告写入被忽略的 `.easycode/evals/`，只含复现元数据、聚合指标和安全断言，不保存 prompt、消息、ToolCall arguments、ToolResult 正文、凭据或环境变量。

两分钟演示见 [docs/DEMO.md](docs/DEMO.md)，设计答辩见 [docs/DEFENSE.md](docs/DEFENSE.md)。

## 打包验证

```bash
npm pack --dry-run --json --cache .easycode/pack-cache
npm run test:package
```

tarball 只包含 `dist`、`package.json`、README、LICENSE、CHANGELOG 和必要公开文档，不含源码、测试、eval fixture、CI、`.env`、报告或 cache。

## 已知限制

v0.2.0 不提供 Session 持久化、长期记忆、context compression、远程 telemetry/dashboard、多 Provider 路由、自动选模、Git push/PR 工具、插件、GUI、容器沙箱或完整进程树隔离；不执行 npm publish、tag 或 GitHub Release。

工程文档：[架构](docs/ARCHITECTURE.md) · [安全](docs/SECURITY.md) · [验收](docs/ACCEPTANCE.md) · [路线图](docs/ROADMAP.md) · [设计决策](docs/DECISIONS.md) · [故障排查](docs/TROUBLESHOOTING.md) · [交付清单](docs/RELEASE_CHECKLIST.md) · [更新日志](CHANGELOG.md)

许可证：MIT，见 [LICENSE](LICENSE)。
