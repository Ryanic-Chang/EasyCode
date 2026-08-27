# EasyCode

EasyCode 是一个中文优先、可解释、可验证的轻量 Coding Agent 项目。

当前仓库已完成 **M2 OpenAI-compatible Provider**：在 M1 可验证 Agent Loop 之上，增加了基于 Node.js 内建 `fetch` 的 Chat Completions 流式适配、消息与工具协议映射、SSE 边界解析、错误分类及取消传播。默认测试完全离线；仓库仍未实现代码工具、交互式入口或 TUI。

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

`EASYCODE_BASE_URL` 应为包含服务 API 前缀的绝对 `http` 或 `https` URL。Provider 会在保留该路径的前提下追加 `/chat/completions`。当前 `src/main.ts` 仍只是 composition root 占位，M2 不提供交互式 CLI。

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
