# Agent Loop 场景目录

M1 已通过 `tests/unit/agent-loop.test.ts` 对下列行为进行确定性自动化验证。本目录仍不保存真实 Provider 评测结果。

1. Provider 不返回工具调用，Agent 正常 `complete`。
2. Provider 返回一个完整 ToolCall，工具成功后下一轮正常 `complete`。
3. Provider 连续多轮请求工具，Agent 按顺序执行并在最终响应后结束。
4. 工具发生可恢复错误，Agent 将失败 `ToolResult` 反馈给 Provider 并继续。
5. Provider 返回错误，Agent 产生错误事件并终止。
6. 调用方触发 abort，Provider 与工具都停止，Agent 以 `aborted` 结束。
7. 达到 `maxSteps`，Agent 不再请求 Provider 或执行工具。
8. ToolCall 缺失字段、参数截断或无法解析时，Agent 以协议错误结束，且绝不执行工具。

未来真实评测仍应记录 fixture、配置、执行命令、代码 revision 和原始结果，并与这些离线单元测试分离。
