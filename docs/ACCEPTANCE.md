# EasyCode 验收标准

## 1. 使用说明

本文件定义可以被自动化测试或可复现命令证明的验收标准。`[ ]` 表示尚未验收，不等于计划遗漏。M1–M6 已根据自动化测试和提交前质量门更新状态，M7 行为不会提前标记为完成。

验收证据必须包含实际命令与结果；真实 Provider 场景还应记录代码 revision、Node.js/依赖版本、模型、安全配置、时间和客观断言结果。不得以截图或口头描述替代可重复检查，也不得为“原始证据”持久化会话或工具正文。

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
| [x] 已验证 | OpenAI-compatible 文本增量被稳定归一化为 `text_delta` |
| [x] 已验证 | 跨多个 chunk 的 ToolCall ID、name 和 arguments 可完整组装，截断时不提交 |
| [x] 已验证 | `stop`、`tool_calls`、`length` 与异常结束均有明确语义 |
| [x] 已验证 | 鉴权、限流、网络、协议和取消错误可区分，且不泄露 key 或认证 header |
| [x] 已验证 | 协议测试使用本地 fixture；默认 CI 不请求真实 API、不读取 secrets |

M2 的直接证据位于 `tests/unit/config.test.ts`、`tests/unit/openai-compatible-provider.test.ts` 与 `tests/integration/openai-compatible-agent.test.ts`。`tests/smoke/openai-compatible.smoke.test.ts` 只有在显式设置 `EASYCODE_SMOKE=1` 时才读取 Provider 配置并请求真实服务；默认测试对其标记为 skipped。

## 5. M3 工具验收

| 状态 | 验收项 |
| --- | --- |
| [x] 已验证 | 所有工具在执行前完成运行时参数校验；失败输入不会调用副作用代码 |
| [x] 已验证 | 文件读取、搜索和修改被限制在显式 workspace root，路径穿越及 symlink/junction 越界被拒绝 |
| [x] 已验证 | 文件修改使用唯一精确替换或排他创建，不静默覆盖未知内容 |
| [x] 已验证 | 命令使用 executable + argv 与 `shell:false` 执行，具有 cwd、timeout、abort 和输出上限 |
| [x] 已验证 | 命令非零退出、超时与截断作为结构化结果或错误呈现 |
| [x] 已验证 | 集成测试只操作临时 workspace，不读取或修改用户真实项目 |

M3 的直接证据位于 `tests/unit/tool-registry.test.ts`、`tests/unit/workspace-boundary.test.ts`、`tests/unit/file-tools.test.ts`、`tests/unit/apply-patch.test.ts`、`tests/unit/run-command.test.ts` 与 `tests/integration/coding-tools-agent.test.ts`。默认测试不请求网络；集成测试使用 Fake Provider 和临时 workspace，分别覆盖成功闭环、patch 冲突和命令非零退出的 ToolResult 回传。

## 6. M4 TUI 验收

| 状态 | 验收项 |
| --- | --- |
| [x] 已验证 | 默认用户可见文案为自然简体中文，技术标识保留必要英文 |
| [x] 已验证 | 助手文本可流式显示，工具开始、结束、失败和最终终止状态可区分 |
| [x] 已验证 | UI 只消费 Agent 接口和 `AgentEvent`，不直接调用 Provider 或 Tool |
| [x] 已验证 | Ctrl+C 能取消当前操作；退出行为明确并等待当前 Provider/工具清理 |
| [x] 已验证 | 120、80、60、40 columns、无颜色和长输出下仍可阅读，不依赖颜色表达唯一信息 |

M4 的直接证据位于 `tests/unit/agent-session.test.ts`、`tests/unit/ui-input.test.ts`、`tests/unit/ui-format.test.ts`、`tests/unit/ui-model.test.ts`、`tests/unit/ui-app.test.tsx` 与 `tests/integration/tui-agent.test.tsx`。组件测试通过内存 stdin/stdout 驱动 Ink；集成测试组合 Fake Provider、真实 Agent Loop、Agent Session、fake Tool 与 Ink App，不访问网络、真实 API 或用户 workspace。

## 7. M5 安全性与可恢复性验收

| ID | 状态 | 验收项 | 证据入口 |
| --- | --- | --- | --- |
| M5-01 | [x] 已验证 | Provider、ToolCall 与内部错误使用稳定分类和中文可操作提示，未知内容不透传 | `agent-loop.test.ts`、`openai-compatible-provider.test.ts` |
| M5-02 | [x] 已验证 | network、timeout、408/409/429/5xx 有界重试；指数退避、jitter、Retry-After、abort 与 timeout 可确定性验证 | `retry-policy.test.ts`、`provider-retry.test.ts` |
| M5-03 | [x] 已验证 | 成功 SSE stream 发布 `start` 后的断流或协议错误不重放，不重复 step、ToolCall 或工具副作用 | `provider-retry.test.ts`、`m5-recovery.test.tsx` 场景 1/5 |
| M5-04 | [x] 已验证 | ToolResult、metadata、stdout/stderr、日志与 TUI 摘要经过统一脱敏、JSON-safe 收敛和 UTF-8 byte 上限 | `redaction.test.ts`、`m5-recovery.test.tsx` 场景 6 |
| M5-05 | [x] 已验证 | `run_command` 每次调用均需精确一次性确认，其他四工具无需确认，硬拒绝发生在确认前 | `approval.test.ts`、`ui-app.test.tsx`、`m5-recovery.test.tsx` 场景 2/3 |
| M5-06 | [x] 已验证 | 拒绝、abort、retry exhaustion、reader/timer/listener、broker dispose、TUI unmount 与 Session 回滚不产生悬空状态或重复执行 | `approval.test.ts`、`provider-retry.test.ts`、`m5-recovery.test.tsx` 场景 3/4/5 |

上述证据均为 fake transport、Fake Provider、fake Tool、内存 Ink 或临时 workspace 测试；普通 `npm test` 不访问网络、真实 API、用户 workspace 或已公开密钥。

## 8. M6 评测与可观测性验收

| ID | 状态 | 验收项 | 证据入口 |
| --- | --- | --- | --- |
| M6-01 | [x] 已验证 | 版本化 fixture 和客观 grader 可重复运行；每场景使用独立临时副本，`complete` 不单独代表成功 | `offline-eval.test.ts`、`eval-grader.test.ts`、`npm run eval:offline` |
| M6-02 | [x] 已验证 | round、attempt、retry、ToolCall、实际执行、成功/失败、approval、usage、阶段耗时和终止指标准确 | `metrics-collector.test.ts`、offline JSON 报告 |
| M6-03 | [x] 已验证 | usage-only 只在 finish 后发布一次；字段归一化为可选安全整数，缺失值不伪造为零 | `usage-protocol.test.ts`、`openai-compatible-provider.test.ts`、`openai-compatible-agent.test.ts` |
| M6-04 | [x] 已验证 | 报告含 revision、环境、lock hash、依赖、模型、配置、seed、命令和稳定 schema/hash；grader/预算失败产生非零退出 | `eval-report.test.ts`、`eval-grader.test.ts`、`npm run eval:offline` |
| M6-05 | [x] 已验证 | 报告、终端摘要和失败路径不保存 prompt、模型/工具正文、ToolCall arguments、secret、认证信息或环境变量 | `eval-report.test.ts`、报告 schema 审查、敏感信息扫描 |
| M6-06 | [x] 已验证 | offline 与 real 完全隔离；普通测试/CI 无网络、凭据和费用，real 必须显式开关且使用 exact command approval | `offline-eval.test.ts`、`eval-report.test.ts`、`.github/workflows/ci.yml` |

M6 固定场景定义见 `evals/scenarios/catalog.ts`，说明见 `evals/scenarios/README.md`。运行报告位于被忽略的 `.easycode/evals/`；它是本地验收产物，不提交到 Git。M6 验收未运行 `npm run eval:real` 或真实 smoke。

## 9. M7 交付验收

| 状态 | 验收项 |
| --- | --- |
| [ ] | Windows、macOS、Linux 的最低支持范围经过实际验证或明确标注限制 |
| [ ] | 从干净环境执行 `npm ci` 和 `npm run check` 可复现通过结果 |
| [ ] | README 包含安装、配置、使用、安全边界、故障排查和已知限制 |
| [ ] | 仓库与 Git 历史不含密钥、`.env`、会话内容或不必要运行产物 |
