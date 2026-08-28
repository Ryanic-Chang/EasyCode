# EasyCode

EasyCode 是一个中文优先、可解释、可验证的轻量 Coding Agent 项目。

当前仓库已完成 **M4 中文 Ink TUI**：用户可以在终端连续提交编程任务，查看流式回答、工具状态、错误和结构化终止原因，并通过 Ctrl+C 取消或退出。会话、Agent、Provider 与五个受控代码工具已由真实 composition root 装配；默认测试仍完全离线。

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
```

## Provider 配置

应用边界通过以下环境变量创建配置；不要把真实值写进仓库或 `.env.example`：

```text
EASYCODE_API_KEY
EASYCODE_BASE_URL
EASYCODE_MODEL
```

`EASYCODE_BASE_URL` 应为包含服务 API 前缀的绝对 `http` 或 `https` URL。Provider 会在保留该路径的前提下追加 `/chat/completions`。任一配置缺失或无效时，CLI 会在 Ink 启动前向 stderr 输出简洁中文错误并以非零状态结束。

## 交互

- 输入任务并按 Enter 提交；运行期间输入暂停，完成后可继续下一条任务。
- 运行中第一次 Ctrl+C 请求取消并等待 Provider/工具清理；取消尚未完成时再次 Ctrl+C 会在清理完成后退出。
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
- [协作约定](AGENTS.md)

## 安全提示

不要提交 API key、`.env`、会话记录或工具执行产生的临时文件。仓库只提供 `.env.example` 作为环境变量名称示例；HTTP 错误正文和底层网络异常也不会直接进入对外错误事件。

M3 文件工具只接受显式 workspace root 内的相对路径，通过 canonical 路径拒绝穿越和外部 symlink/junction，并保护 `.git`、`.easycode`、`.env*`。`apply_patch` 只允许唯一精确替换或排他创建；`run_command` 使用 `executable + args`、`shell:false`、相对 cwd、timeout、abort、输出上限和敏感环境变量过滤，并拒绝 shell、inline eval、危险 Git、发布、部署及系统级命令。

这些措施是边界控制，不是容器或 OS 级强沙箱。允许的命令仍具有当前用户权限，也可能自行访问 workspace 外资源或创建后代进程；canonical 检查也不能完全消除恶意本地进程造成的 TOCTOU 竞态。M4 不提供删除/重命名、任意 shell 字符串、Windows `.cmd`/`.bat` shim、操作确认门、session 持久化或完整进程树隔离。失败/取消会回滚模型会话历史，但不会撤销已完成的文件或命令副作用。
