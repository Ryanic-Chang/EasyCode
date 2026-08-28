# EasyCode

EasyCode 是一个中文优先、可解释、可验证的轻量 Coding Agent 项目。

当前仓库已完成 **M3 最小代码工具集**：在可验证 Agent Loop 与 OpenAI-compatible Provider 之上，增加了 `list_directory`、`search_files`、`read_file`、`apply_patch`、`run_command` 五个受控工具。默认测试使用 Fake Provider 和临时 workspace 完全离线验证“观察—修改—执行验证”闭环；仓库仍未提供交互式入口或 TUI。

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

`EASYCODE_BASE_URL` 应为包含服务 API 前缀的绝对 `http` 或 `https` URL。Provider 会在保留该路径的前提下追加 `/chat/completions`。当前 `src/main.ts` 仍只是 composition root 占位，M3 不提供交互式 CLI。

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

这些措施是边界控制，不是容器或 OS 级强沙箱。允许的命令仍具有当前用户权限，也可能自行访问 workspace 外资源或创建后代进程；canonical 检查也不能完全消除恶意本地进程造成的 TOCTOU 竞态。M3 不提供删除/重命名、任意 shell 字符串、Windows `.cmd`/`.bat` shim、确认 UI 或完整进程树隔离。
