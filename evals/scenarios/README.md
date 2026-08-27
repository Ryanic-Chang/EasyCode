# Agent Loop 场景目录

M0 只登记未来必须覆盖的行为，不实现 Agent Loop，也不把这些场景标记为已通过。

1. Provider 不返回工具调用，Agent 正常 `complete`。
2. Provider 返回一个完整 ToolCall，工具成功后下一轮正常 `complete`。
3. Provider 连续多轮请求工具，Agent 按顺序执行并在最终响应后结束。
4. 工具发生可恢复错误，Agent 将失败 `ToolResult` 反馈给 Provider 并继续。
5. Provider 返回错误，Agent 产生错误事件并终止。
6. 调用方触发 abort，Provider 与工具都停止，Agent 以 `aborted` 结束。
7. 达到 `maxSteps`，Agent 不再请求 Provider 或执行工具。
8. ToolCall 缺失字段、参数截断或无法解析时，Agent 以协议错误结束，且绝不执行工具。

未来每个场景应记录 fixture、配置、执行命令、代码 revision 和原始结果，真实 API 评测必须与单元测试分离。
