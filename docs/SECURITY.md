# EasyCode 安全边界

## 信任模型

模型输出、Provider 响应、异常、HTTP headers、工具输出和 metadata 均是不可信输入。ToolCall 先完整组装并通过注册表与 `Tool.parse`；ToolResult 再经 Agent 边界清理，才可进入规范历史、下一轮 Provider 请求、AgentEvent 和 TUI。

## 密钥与日志

- API key 只从进程环境进入 composition root，不写入仓库或 `.env.example`。
- `Redactor` 统一过滤显式 secret、Authorization/Bearer、`sk-...`、常见 key/value、URL userinfo/query 和敏感 metadata key。
- metadata 只保留 JSON-safe、有界深度/字段/数组/bytes 的副本；不读取 getter，不修改原对象，循环引用与截断会明确标记。
- 默认 logger 为 silent；可注入 logger 只能接收 method、安全 path、status、attempt、duration、稳定错误 code 和有界 request ID，不接收 prompt、headers、正文、ToolCall arguments 或 ToolResult 原文。

## 重试与副作用

Provider 只在成功 SSE stream 发布 `start` 前对瞬时候选错误有界重试。流开始、协议错误、用户 abort、确定性客户端错误和任何工具执行之后都不重试。重试不会自动重放本地工具，但可能导致模型 API 重复计费。`X-Client-Request-Id` 是诊断标识，不是幂等键。

## 确认语义

`run_command` 每次执行都需要一次性确认，decision 必须匹配 Agent 生成的当前 approval ID。按 `y` 才允许；`n`、Enter、abort、unmount、dispose、未知或重复 ID 均不允许执行。确认发生在参数解析和硬拒绝之后，因此不能解锁 shell、inline eval、危险 Git、发布、部署、账号/权限或 workspace 外访问。

命令标准输入只能通过最多 16 KiB 的结构化 UTF-8 `stdin` 提供，不解释 shell 管道或重定向。确认摘要只显示 stdin byte 数，不显示正文；stdin 仍会作为模型提供的 ToolCall 参数存在于当前内存会话，因此不得用于传递凭据。

评测使用独立确认策略：只允许场景预声明且在 executable、argv、cwd、timeout 和安全摘要上精确匹配的 fixture 内命令，每条声明最多消费一次；批准前还会确认验证脚本与初始 fixture 的 SHA-256 相同，任一偏差默认拒绝。该策略仅存在于 `evals/`，不会改变产品 TUI 的逐调用人工确认。

## 评测隔离与报告隐私

- offline eval 不读取 Provider 环境变量，不使用 HTTP Provider；每次先把受版本控制的 fixture 复制到系统临时目录，工具只接收该副本作为 workspace，结束后清理。
- grader 只持久化断言 ID、真假、hash/数量、终止、错误码和聚合指标。任务、用户/模型消息、ToolCall arguments、ToolResult 正文、API key、Authorization、完整 URL query、环境变量和 workspace diff 正文不进入报告。
- 报告写入 `.easycode/evals/`，先写同目录临时文件再 rename，并以 payload SHA-256 校验完整性；该目录被 Git 忽略。
- `eval:real` 默认关闭，开关检查先于 Provider 配置读取。真实 Provider 输出不会进入受版本控制的 fixture 或报告正文，也不会自动替换任何基线。

## CLI 与交付卫生

- `--help` 与 `--version` 在 Provider 配置读取前完成；未知参数不回显输入。package smoke 清除全部 `EASYCODE_*` 环境变量，并为安装后 CLI 注入 `fetch` 网络防线。
- tarball 使用 `files` allowlist，只包含编译后的运行文件与必要公开文档；不包含源码、测试、eval fixture、CI、`.env`、`.easycode`、cache、coverage、报告、source map 或内部协作文件。
- `prepack` 只清理经过项目根路径校验的 `dist` 并离线编译，不读取 Provider 配置、不修改源码、不运行真实评测。
- 生产依赖许可证从实际安装 package metadata 枚举；缺失、未知、未审查或明显不兼容标识会失败。版本化 notices 与安装事实不一致同样失败。
- 项目保持 `private: true`。打包和安装 smoke 不授权 npm publish、Git tag 或 GitHub Release。

## 明确限制

EasyCode 的 workspace、命令白/黑名单、timeout、取消和确认门不是容器或 OS 级强沙箱。被允许的进程仍具有当前用户权限，可能访问网络、workspace 外资源或创建后代进程；当前实现不保证完整进程树隔离。Session 回滚只恢复模型历史，不能撤销已经完成的文件或命令副作用。v0.1.0 不包含 Session 持久化、长期记忆、context compression、远程 telemetry、dashboard、多 Provider、自动选模、Git push/PR 工具、插件或 GUI。
