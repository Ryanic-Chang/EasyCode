# EasyCode 验收标准

## 1. 使用说明

本文件定义可以被自动化测试或可复现命令证明的验收标准。`[ ]` 表示尚未验收，不等于计划遗漏。M1 已根据具名自动化测试更新状态，M2 之后的行为不会提前标记为完成。

验收证据必须包含实际命令与结果；真实 Provider 场景还应记录代码 revision、Node.js/依赖版本、模型、配置、时间和原始输出。不得以截图或口头描述替代可重复检查。

## 2. M0 工程基线

| 状态 | 验收项 | 证据入口 |
| --- | --- | --- |
| [x] | 仓库包含中文协作、架构、路线图、决策和验收文档 | 人工审查 `AGENTS.md`、`docs/*.md` |
| [x] | `package.json` 使用 Node.js >= 22、npm、ESM、TypeScript strict、Vitest 和最小 lint | `package.json`、`tsconfig.json`、`package-lock.json` |
| [x] | M0 不含真实 Agent Loop、HTTP Provider、本地工具、命令执行或 Ink UI | 源码与依赖树审查 |
| [x] | 依赖树不含禁止的 Agent Framework | `npm ls --all` 与名称扫描 |
| [x] | `.env.example` 只含变量名，仓库不含真实密钥或 `.env` | Git diff 与敏感信息扫描 |
| [x] | 类型检查、静态检查、单元测试和构建全部通过 | `npm run check` |
| [x] | CI 在 push 和 pull request 上执行 `npm ci` 及全部质量检查，不使用 secrets | `.github/workflows/ci.yml` |

上述状态由完成 M0 的实际验证结果更新；创建文件本身不是通过证据。

## 3. M1 Agent Loop 核心场景

| ID | 状态 | 给定条件 | 预期行为 | 关键断言 |
| --- | --- | --- | --- | --- |
| AL-01 | [x] 已验证 | Provider 只返回文本并以 `stop` 结束 | Agent 流式发布文本并正常完成 | 无工具事件；终止原因为 `complete`；仅一次 Provider 请求 |
| AL-02 | [x] 已验证 | 第一轮返回一个完整 ToolCall，工具成功，第二轮返回最终文本 | Agent 执行一次工具、追加 ToolResult 后继续 | 事件顺序正确；第二次请求含 assistant ToolCall 与对应 ToolResult |
| AL-03 | [x] 已验证 | Provider 连续多轮请求工具，最后返回文本 | Agent 按轮次与响应顺序执行并最终完成 | 无遗漏或重复调用；上下文顺序稳定；step 计数正确 |
| AL-04 | [x] 已验证 | 工具返回可恢复错误 | Agent 将失败 ToolResult 反馈给 Provider 并允许下一轮修正 | `tool_end` 明确失败；循环不因领域错误直接崩溃 |
| AL-05 | [x] 已验证 | Provider 返回结构化错误或抛出 Provider 异常 | Agent 发布脱敏错误并终止 | 不执行工具；终止原因为 `provider_error`；不伪造 assistant 消息 |
| AL-06 | [x] 已验证 | 调用方在模型流或工具执行中 abort | 当前操作停止且 Agent 结束 | Provider/Tool 收到同一取消信号；终止原因为 `aborted`；无后续调用 |
| AL-07 | [x] 已验证 | 继续循环将超过 `maxSteps` | Agent 在边界处停止 | 不多发一次 Provider 请求；不多执行一个工具；终止原因为 `max_steps` |
| AL-08 | [x] 已验证 | ToolCall 缺 ID/name、参数截断、JSON 无法解析或 schema 不匹配 | Agent 拒绝执行并安全终止 | `Tool.execute` 调用次数为 0；无 `tool_start`；终止原因为 `protocol_error` |

AL-01 至 AL-08 的直接证据位于 `tests/unit/agent-loop.test.ts`；Provider 两种失败、Provider/Tool 两个取消阶段以及多类非法 ToolCall 均有独立子测试。

## 4. M2 Provider 验收

| 状态 | 验收项 |
| --- | --- |
| [ ] | OpenAI-compatible 文本增量被稳定归一化为 `text_delta` |
| [ ] | 跨多个 chunk 的 ToolCall ID、name 和 arguments 可完整组装，截断时不提交 |
| [ ] | `stop`、`tool_calls`、`length` 与异常结束均有明确语义 |
| [ ] | 鉴权、限流、网络、协议和取消错误可区分，且不泄露 key 或认证 header |
| [ ] | 协议测试使用本地 fixture；默认 CI 不请求真实 API、不读取 secrets |

## 5. M3 工具验收

| 状态 | 验收项 |
| --- | --- |
| [ ] | 所有工具在执行前完成运行时参数校验；失败输入不会调用副作用代码 |
| [ ] | 文件读取、搜索和修改被限制在显式 workspace root，路径穿越被拒绝 |
| [ ] | 文件修改使用明确 patch 或同等可审查机制，不静默覆盖未知内容 |
| [ ] | 命令使用 executable + argv 执行，具有 cwd、timeout、abort 和输出上限 |
| [ ] | 命令非零退出、超时与截断作为结构化结果或错误呈现 |
| [ ] | 集成测试只操作临时 workspace，不读取或修改用户真实项目 |

## 6. M4 TUI 验收

| 状态 | 验收项 |
| --- | --- |
| [ ] | 默认用户可见文案为自然简体中文，技术标识保留必要英文 |
| [ ] | 助手文本可流式显示，工具开始、结束、失败和最终终止状态可区分 |
| [ ] | UI 只消费 Agent 接口和 `AgentEvent`，不直接调用 Provider 或 Tool |
| [ ] | Ctrl+C 能取消当前操作；退出行为明确且不会留下子进程 |
| [ ] | 窄终端、无颜色环境和长输出下仍可阅读，不依赖颜色表达唯一信息 |

## 7. M5–M7 交付验收

| 状态 | 验收项 |
| --- | --- |
| [ ] | 已知错误路径具有中文、脱敏、可操作的提示，自动重试有上限与退避 |
| [ ] | 删除、发布、部署、推送和权限扩大等高风险动作需要明确确认 |
| [ ] | 场景评测记录 revision、环境、依赖、模型、配置、命令和原始结果 |
| [ ] | Windows、macOS、Linux 的最低支持范围经过实际验证或明确标注限制 |
| [ ] | 从干净环境执行 `npm ci` 和 `npm run check` 可复现通过结果 |
| [ ] | README 包含安装、配置、使用、安全边界、故障排查和已知限制 |
| [ ] | 仓库与 Git 历史不含密钥、`.env`、会话内容或不必要运行产物 |
