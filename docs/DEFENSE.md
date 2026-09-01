# EasyCode v0.2.0 设计答辩

## 1. 为什么不用 Agent Framework？

考核要求关键逻辑独立实现。项目还需要直接证明 step、ToolCall 组装、全轮校验、上下文追加、取消和终止顺序。自有的小型状态机让每个边界可见、可测试；引入框架会增加隐式状态、依赖和答辩解释成本。

## 2. Agent Loop 如何推进上下文？

每次模型轮次递增 step，并发送当前规范消息和工具定义。文本与 ToolCall 增量先在内存组装；最终文本提交 assistant 消息并结束。工具轮先提交含全部调用的 assistant 消息，再按响应顺序串行执行并追加 ToolResult，之后进入下一轮。Session 只在 `complete` 时提交候选历史。

## 3. 为什么 ToolCall 必须全轮预验证？

一个响应可含多个 ToolCall。若边解析边执行，后面的截断 JSON、缺 ID、未知工具或 schema 错误出现时，前面的副作用已经发生。EasyCode 等流完整结束后验证整轮；任一不合法则本轮零执行、零 `tool_start`，以 `protocol_error` 终止。

## 4. 为什么 run_command 坚持 shell:false？

shell 会把 `|`、`>`、`&&`、变量展开和命令替换解释为另一层语言，使参数验证与确认摘要不再等价于实际执行。`executable + args` 直接启动单个程序，边界更窄、跨平台语义更稳定。

## 5. 确认门能防什么、不能防什么？

它防止模型未经用户逐次同意就执行命令；Enter、拒绝、取消、重复或错误 approval ID 都不启动进程。它不能替代 OS 沙箱，也不能保证获准程序不访问网络、外部文件或创建后代进程。硬拒绝先于确认，因此 shell、危险 Git、发布部署和 workspace 外访问不能靠按 `y` 解锁。

## 6. 为什么失败 Session 回滚但文件副作用不回滚？

Session 的事务对象是模型历史：失败轮次可能含未闭合 ToolCall，继续复用会破坏协议，所以候选历史回滚。文件和进程属于外部世界，可靠回滚需要快照、VCS 或容器事务，并可能覆盖用户并发修改。当前版本明确展示副作用但不伪装能撤销。

## 7. fake eval 与真实 eval 各自证明什么？

fake eval 证明控制流、计数、fixture 隔离、grader 和安全边界可确定性回归；它不证明某个模型会选择正确工具。真实 eval 证明具体 Provider、流协议、Function Calling 与模型策略能在客观场景上工作，但受模型波动、限流和费用影响。两者共享 grader，不共享不现实的 token 预算。

## 8. 百炼兼容问题如何定位和修复？

先保留真实 baseline，再把失败分成协议、模型行为和评测预算。真实流显示 Qwen continuation chunk 可能以空 `id`/`name` 表示本 chunk 未重复身份，finish 后还有 usage-only chunk。修复只在 wire 层归一化差异，Agent 最终校验不变；`enable_thinking=false` 是严格可选厂商字段。

## 9. 为什么 stdin 是结构化字段而不是 shell pipe？

stdin 是子进程 API 的独立输入通道，可以限制为 16 KiB、计算 byte 数、在 TUI 隐藏正文，并与 executable/args 一起进入精确确认。shell pipe 会引入第二个进程和 shell 解析，扩大权限与歧义。

## 10. 当前版本最重要的限制是什么？

最重要的限制是它不是强沙箱：workspace 边界约束 EasyCode 自身工具，但获准子进程仍使用当前用户权限，且不保证完整进程树隔离。此外，Session 仅内存存在，没有持久化、长期记忆、context compression、多 Provider、插件或自动 Git push/PR。

## 结论

EasyCode 的重点不是功能数量，而是一条可解释、可验证的链路：不可信模型输出 → 完整协议校验 → 工具与 workspace 边界 → 单次授权 → 结构化结果回传 → 客观测试与评测证据。
