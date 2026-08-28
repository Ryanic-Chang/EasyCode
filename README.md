# EasyCode

EasyCode 是一个中文优先、可解释、可验证的轻量 Coding Agent 项目。

当前仓库已完成 **M6 评测与可观测性**：除中文 Ink TUI、Agent Loop、OpenAI-compatible Provider、五个受控代码工具及 M5 安全恢复边界外，现已具备版本化 synthetic fixture、客观 grader、公开事件指标和原子 JSON 报告。默认测试与 offline eval 均完全离线。

## 安装与启动

```bash
npm install
npm run build
npm start
```

也可以在安装/打包后使用 `easycode` bin。应用把启动时的 `process.cwd()` 作为唯一 workspace root，不会隐式切换目录或读取 `.env` 文件。

## 开发命令

```bash
npm install
npm run check
```

单项检查命令：

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm run eval:offline
```

## 测试与评测

- `npm test` 验证模块和集成契约，使用 fake、fixture 与临时目录，不调用真实服务。
- `npm run eval:offline` 运行 7 个版本化 coding 场景，以 scripted Provider 驱动真实 Agent Loop 和代码工具；场景副本位于独立临时 workspace，固定 fixture 不会被修改。该命令进入普通 CI。
- `npm run eval:real` 是可选真实 Provider 评测，默认安全拒绝。只有显式设置 `EASYCODE_REAL_EVAL=1` 且 Provider 配置完整时才会启动；它不进入 `npm test` 或 CI，本仓库验收不运行该命令。

offline/real 报告写入被 `.gitignore` 排除的 `.easycode/evals/<runId>.json`。报告带 `schemaVersion` 和 SHA-256 `reportHash`，记录 revision、dirty 状态、Node/平台、lockfile hash、顶层依赖、模型、重试配置、seed、规范化命令、客观断言、终止与聚合指标。报告不保存任务、模型消息、工具参数或结果正文、API key、Authorization、URL query 和环境变量。

真实评测会调用外部模型并可能产生费用；启用示例（值仅放在当前进程环境）：

```powershell
$env:EASYCODE_REAL_EVAL = "1"
npm run eval:real
```

## Provider 配置

应用边界通过以下环境变量创建配置；不要把真实值写进仓库或 `.env.example`：

```text
EASYCODE_API_KEY
EASYCODE_BASE_URL
EASYCODE_MODEL
EASYCODE_MAX_RETRIES
EASYCODE_RETRY_BASE_DELAY_MS
EASYCODE_REQUEST_TIMEOUT_MS
```

`EASYCODE_BASE_URL` 应为包含服务 API 前缀的绝对 `http` 或 `https` URL。Provider 会在保留该路径的前提下追加 `/chat/completions`。任一配置缺失或无效时，CLI 会在 Ink 启动前向 stderr 输出简洁中文错误并以非零状态结束。

后三项为可选严格十进制整数：`EASYCODE_MAX_RETRIES` 默认 `2`、范围 `0–5`；`EASYCODE_RETRY_BASE_DELAY_MS` 默认 `500`、范围 `50–5000`；`EASYCODE_REQUEST_TIMEOUT_MS` 默认 `30000`、范围 `1000–120000`。退避最大等待为代码常量 `10000 ms`，并加入 ±20% jitter；合法 `Retry-After` 会参与计算但同样受此上限约束。

## 交互

- 输入任务并按 Enter 提交；运行期间输入暂停，完成后可继续下一条任务。
- 运行中第一次 Ctrl+C 请求取消并等待 Provider/工具清理；取消尚未完成时再次 Ctrl+C 会在清理完成后退出。
- 每次 `run_command` 都会显示一次性确认；只有按 `y` 才允许，按 `n` 或 Enter 默认拒绝。拒绝会作为失败 ToolResult 回传模型，使其可改用安全方案。
- 空闲时 Ctrl+C 直接安全退出。
- 设置 `NO_COLOR` 可关闭语义颜色；`[运行]`、`[完成]`、`[失败]` 等文字始终保留。

仓库提供默认关闭的真实服务 smoke test。请先通过安全的进程环境配置上述三个变量，再显式启用；该命令会请求真实 API，可能产生费用：

```powershell
$env:EASYCODE_SMOKE = "1"
npm run test:smoke
```

普通 `npm test` 和 CI 会跳过此 smoke test，不读取 Provider 配置，也不访问网络。

## 工程文档

- [架构说明](docs/ARCHITECTURE.md)
- [开发路线图](docs/ROADMAP.md)
- [设计决策](docs/DECISIONS.md)
- [验收标准](docs/ACCEPTANCE.md)
- [安全边界](docs/SECURITY.md)
- [协作约定](AGENTS.md)

## 安全提示

不要提交 API key、`.env`、会话记录或工具执行产生的临时文件。仓库只提供 `.env.example` 作为环境变量名称示例；HTTP 错误正文和底层网络异常不会直接进入对外错误事件。Provider、ToolResult、metadata、日志与 TUI 摘要共用统一脱敏边界，默认 logger 不记录正文。

M3 文件工具只接受显式 workspace root 内的相对路径，通过 canonical 路径拒绝穿越和外部 symlink/junction，并保护 `.git`、`.easycode`、`.env*`。`apply_patch` 只允许唯一精确替换或排他创建；`run_command` 使用 `executable + args`、`shell:false`、相对 cwd、timeout、abort、输出上限和敏感环境变量过滤，并拒绝 shell、inline eval、危险 Git、发布、部署及系统级命令。

自动重试只发生在成功 SSE stream 开始之前，候选为 network、timeout、HTTP 408/409/429/5xx；401/403、确定性客户端错误、协议错误、用户 abort 和流开始后的断流不重试。一个逻辑请求的 attempts 共用诊断 request ID，但它不是幂等键；重试仍可能产生重复 API 计费。只有完整成功响应才可能进入本地工具执行，因此 transport 重试不会重放本地工具副作用。

这些措施是边界控制，不是容器或 OS 级强沙箱。允许的命令仍具有当前用户权限，也可能自行访问 workspace 外资源或创建后代进程；canonical 检查也不能完全消除恶意本地进程造成的 TOCTOU 竞态。M5 不提供删除/重命名、任意 shell 字符串、Windows `.cmd`/`.bat` shim、session 持久化或完整进程树隔离。失败/取消会回滚模型会话历史，但不会撤销已完成的文件或命令副作用。
