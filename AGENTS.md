# EasyCode 协作约定

## 适用范围

本文件适用于 EasyCode 仓库根目录及全部子目录。开始工作前，应先阅读本文件、`docs/` 下的架构与路线图、当前 Git 状态以及现有验证命令。

## 产品边界

- EasyCode 是独立实现的轻量 Coding Agent，不复制、改装或包装其他 Agent 项目源码。
- 不得引入 LangChain、LlamaIndex、OpenAI Agents SDK、Claude Agent SDK、AutoGen、CrewAI 等 Agent Framework。
- M0 只建立工程基线和类型契约，不实现真实 Agent Loop、HTTP Provider、本地工具、命令执行或 Ink TUI。
- 新功能必须对应 `docs/ROADMAP.md` 中的当前里程碑；不得借机扩大范围。

## 语言与文档

- 面向人的内容默认使用简体中文，包括文档、README、TUI 文案、错误提示和自然语言测试描述。
- 代码标识符、文件名、命令、协议字段和约定俗成的英文技术术语保持英文。
- 架构、行为或验收标准变化时，同步更新相应 `docs/*.md`，避免代码与文档形成两套事实。

## 模块依赖规则

- `src/main.ts` 是 composition root，只负责装配依赖和启动应用，不承载业务逻辑。
- `src/ui/` 只提交用户意图、订阅 `AgentEvent` 并渲染状态；不得直接调用 Provider、文件系统或子进程。
- `src/agent/` 只负责 Agent Loop、上下文推进、工具调度和终止判断；不得包含 HTTP、终端渲染或具体工具实现。
- `src/llm/` 负责 Provider 抽象、协议适配和流式事件归一化；不得决定 Agent Loop 或执行工具。
- `src/tools/` 负责工具定义、输入验证与受控执行；不得依赖 UI 或具体 Provider。
- `src/config/` 负责配置读取与校验；配置对象由 composition root 显式注入，业务模块不得散落读取环境变量。
- 生产代码不得从 `tests/` 或 `evals/` 导入。
- 跨模块共享应通过最小公开类型完成；禁止为图省事而导入其他模块的内部实现。

## Agent 与 Tool 安全规则

- 模型输出始终视为不可信输入；ToolCall 必须结构完整、工具存在且参数校验通过后才能执行。
- 缺失、截断或格式错误的 ToolCall 永远不得进入工具执行函数。
- 命令工具未来必须使用参数数组调用进程，默认禁用 shell 字符串拼接，并设置工作目录、超时、取消信号和输出上限。
- 文件工具未来必须将目标路径解析到允许的 workspace root 内，拒绝路径穿越、仓库外写入和隐式覆盖。
- 删除、发布、部署、推送、权限扩大、账号变更等高风险动作必须获得针对该动作的明确授权。
- 可恢复的工具错误应作为结构化 `ToolResult` 返回 Agent；Provider、协议和内部错误不得伪装成成功结果。

## 密钥与日志

- 不创建、不读取、不提交真实 `.env`；只维护不含值的 `.env.example`。
- 不在源码、测试 fixture、日志、异常、快照或 Git 历史中记录 API key。
- 用户输入、模型内容、工具参数和工具输出均可能含敏感信息；默认只保留完成当前会话所需的最少数据。
- 日志必须经过脱敏，不记录完整密钥、认证 header 或不必要的文件内容。

## 依赖政策

- 添加生产依赖前先说明必要性，并优先使用 Node.js 标准库或现有依赖。
- 依赖必须职责单一、维护活跃、许可证可接受，并在 `package-lock.json` 中锁定。
- 不得以“以后可能需要”为理由预装 SDK、UI 库、schema 库或 Agent Framework。
- 包管理器统一使用 npm；CI 使用 `npm ci`。

## 测试与验证

- 测试优先使用确定性的 fake、fixture 和临时目录，不依赖真实 API、网络或用户主目录。
- 每个 Agent Loop 分支都应能由 scripted fake Provider 重现。
- 修改后至少运行与风险相称的检查；提交前运行 `npm run check`。
- 不得声称未实际运行的命令、测试或评测已通过。
- `evals/` 记录端到端场景与原始结果；结果必须可追溯到代码 revision、配置和命令。

## Git 与变更纪律

- 先检查 `git status --short`，保留用户已有改动，避免无关格式化和重构。
- 每次提交应聚焦一个里程碑或一个可解释变更；使用 Conventional Commits。
- 未经明确授权不得 amend、rebase、force push 或 push。
- 提交前检查 `git diff --check`、依赖树、敏感信息和禁用框架。
