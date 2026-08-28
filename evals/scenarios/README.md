# 离线 Agent 场景目录

M1 已通过 `tests/unit/agent-loop.test.ts` 对下列行为进行确定性自动化验证。本目录仍不保存真实 Provider 评测结果。

1. Provider 不返回工具调用，Agent 正常 `complete`。
2. Provider 返回一个完整 ToolCall，工具成功后下一轮正常 `complete`。
3. Provider 连续多轮请求工具，Agent 按顺序执行并在最终响应后结束。
4. 工具发生可恢复错误，Agent 将失败 `ToolResult` 反馈给 Provider 并继续。
5. Provider 返回错误，Agent 产生错误事件并终止。
6. 调用方触发 abort，Provider 与工具都停止，Agent 以 `aborted` 结束。
7. 达到 `maxSteps`，Agent 不再请求 Provider 或执行工具。
8. ToolCall 缺失字段、参数截断或无法解析时，Agent 以协议错误结束，且绝不执行工具。

M3 通过 `tests/integration/coding-tools-agent.test.ts` 在每个测试自行创建并清理的临时 workspace 中增加三条离线闭环：

1. Fake Provider 驱动真实 Agent 与五工具注册表，依次搜索/读取 fixture、唯一精确 patch、执行当前 Node.js 验证脚本，并在 ToolResult 回传后正常 `complete`；
2. patch 零匹配形成 `isError: true` 的可恢复 ToolResult，文件保持不变，Agent 可继续完成；
3. 验证命令非零退出形成包含 exit code 与 stderr 的结构化失败 ToolResult，Agent 不崩溃或伪装成功。

这些场景不访问网络、真实 API、用户项目或用户主目录，也不使用 shell、npm 或全局命令。

未来真实评测仍应记录 fixture、配置、执行命令、代码 revision 和原始结果，并与这些离线单元测试分离。
