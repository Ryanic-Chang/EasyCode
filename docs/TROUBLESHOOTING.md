# EasyCode 故障排查

## 启动提示缺少配置

无参数启动 TUI 必须提供 `EASYCODE_API_KEY`、`EASYCODE_BASE_URL` 和 `EASYCODE_MODEL`。`--help` 与 `--version` 不需要任何配置。项目不会自动读取 `.env`；请在当前进程环境中设置值，不要把真实凭据写入仓库。

## 鉴权失败或模型不可用

确认 key、模型名和账号权限属于同一服务；确认 `EASYCODE_BASE_URL` 是服务的 OpenAI-compatible API 前缀，而不是完整 `/chat/completions` 地址。401/403 不自动重试。不要把 Authorization header、完整 URL query 或响应正文粘贴到公开日志。

百炼/Qwen Function Calling 演示建议设置 `EASYCODE_ENABLE_THINKING=false`。该值区分大小写且只接受 `true` 或 `false`；`0`、`TRUE`、空字符串和带空格值都会安全拒绝。其他 OpenAI-compatible 服务可不配置，此时请求完全不含 `enable_thinking`。

## 限流、服务错误和 timeout

连接成功并开始流式输出前，408/409/429/5xx、network 和 timeout 可有界重试；流开始后不会重放。可在允许范围内调整 `EASYCODE_MAX_RETRIES`、`EASYCODE_RETRY_BASE_DELAY_MS` 和 `EASYCODE_REQUEST_TIMEOUT_MS`。重试可能重复计费，不保证服务端幂等。

## 终端过窄、颜色或 Ctrl+C

界面支持窄终端降级；若内容难读，请将终端扩至至少 60 列。设置 `NO_COLOR=1` 可关闭颜色，文字状态仍完整。运行中第一次 Ctrl+C 请求取消并等待清理，第二次表示清理后退出；空闲时 Ctrl+C 直接退出。

## Windows executable 与 npm.cmd

EasyCode 的 `run_command` 工具使用 `shell:false`，因此不会执行依赖命令解释器的 `.cmd`/`.bat` shim；这是 Agent 工具的安全限制，不表示 Windows 用户不能在 PowerShell 或 cmd 中使用 `npm` 管理、构建或测试项目。package smoke 通过 Node.js 启动当前 `npm_execpath`，不会设置 `shell:true`。

`|`、`>`、`&&` 等 shell 元字符作为 `args` 时只会成为普通参数。需要向程序提供标准输入时，应使用结构化 `stdin` 字段；EasyCode 不会为管道或重定向启动 shell。

## npm pack、cache 或临时目录失败

先确认系统临时目录和 npm cache 可写，并关闭占用 tarball 或临时安装目录的程序。可用被 Git 忽略的隔离 cache 检查内容：

```bash
npm pack --dry-run --json --cache .easycode/pack-cache
```

`npm run test:package` 会自行创建并清理隔离 cache、tarball 和安装目录。异常退出后若操作系统仍持有文件句柄，可安全删除系统临时目录中以 `easycode-package-smoke-` 开头的残留；不要递归删除不明确的路径。

## package-lock 或依赖许可证漂移

CI 的 `npm ci` 后若 `package-lock.json` 变化，应检查 npm 版本和锁文件是否由依赖变更正确更新。生产依赖变化后运行 `npm run license:update`，人工复核新许可证，再运行 `npm run license:check`。不要只为消除 audit 输出而盲目升级 major 版本。
