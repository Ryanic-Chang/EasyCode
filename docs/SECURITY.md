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

## 明确限制

EasyCode 的 workspace、命令白/黑名单、timeout、取消和确认门不是容器或 OS 级强沙箱。被允许的进程仍具有当前用户权限，可能访问网络、workspace 外资源或创建后代进程；当前实现不保证完整进程树隔离。Session 回滚只恢复模型历史，不能撤销已经完成的文件或命令副作用。
