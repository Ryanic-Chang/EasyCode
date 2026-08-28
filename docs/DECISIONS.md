# EasyCode 设计决策记录

本文记录会长期影响实现方式的 M0–M4 决策。每项决策都说明理由、被放弃的方案和当前代价；如果未来条件变化，应新增或修订记录，而不是让代码静默偏离。

## ADR-001：使用 TypeScript + Node.js >= 22

- **状态**：已接受
- **决策**：生产代码使用 TypeScript、ESM 和 strict 模式，最低运行时为 Node.js 22。
- **理由**：Node.js 对流式网络、异步迭代器、AbortSignal、文件系统和子进程有直接支持；TypeScript 能把 Provider、事件和工具边界变成可检查契约。Node.js 22 是长期支持版本，并提供实现轻量客户端所需的内建 `fetch`。
- **备选方案**：Python 开发快但终端 UI 与分发路径不同；Rust 的安全性强但会显著增加首版开发成本；纯 JavaScript 缺少边界类型检查。
- **后果**：需要维护 tsconfig 与构建步骤；运行环境必须满足 Node.js 版本要求。

## ADR-002：统一使用 npm 与 package-lock.json

- **状态**：已接受
- **决策**：开发和 CI 使用 npm，提交 `package-lock.json`，CI 安装命令为 `npm ci`。
- **理由**：npm 随 Node.js 生态最常见，考核环境理解成本低；锁文件可提供可复现依赖树，无需额外要求全局包管理器。
- **备选方案**：pnpm 更节省磁盘，Yarn 也可锁定依赖，但都会增加环境前置条件和说明成本。
- **后果**：不使用 workspace 特性做过早的 monorepo 拆分；依赖变更必须同步更新锁文件。

## ADR-003：独立实现 Agent Loop，不采用 Agent Framework

- **状态**：已接受
- **决策**：Agent Loop、上下文推进、工具调度、错误和终止逻辑由 EasyCode 自行实现；禁止引入 LangChain、LlamaIndex、OpenAI Agents SDK、Claude Agent SDK、AutoGen、CrewAI 等 Agent Framework。
- **理由**：项目考察重点是关键逻辑和工程理解。显式状态机更容易解释、调试、测试，也避免框架隐式重试、消息转换和生命周期钩子遮蔽行为。
- **备选方案**：成熟框架能快速提供工具调用与 tracing，但核心行为会受框架抽象和版本变化支配；复制参考项目同样不满足独立实现要求。
- **后果**：需要自行承担协议边界、错误分类和循环测试；因此必须保持首版功能克制。

## ADR-004：Provider 使用窄接口，首个实现面向 OpenAI-compatible API

- **状态**：已接受
- **决策**：核心只依赖返回 `AsyncIterable<ProviderEvent>` 的 `Provider` 接口；首个真实适配器使用 OpenAI-compatible HTTP API，不让核心直接依赖 SDK 类型。
- **理由**：窄接口足以支持 streaming、ToolCall 和取消，也方便 scripted fake。OpenAI-compatible 端点覆盖常见服务，但兼容仅限本项目明确测试的协议子集。
- **备选方案**：直接调用某个官方 SDK 开发更快，但会把消息、错误和流事件形状泄漏到 Agent；一开始支持多家原生协议会扩大测试矩阵。
- **后果**：适配层需要自行解析流和归一化错误；M2 之前不引入 HTTP 或 SDK 依赖。

## ADR-005：ProviderEvent 与 AgentEvent 分层

- **状态**：已接受
- **决策**：模型原始语义归一化为 `ProviderEvent`，Agent 执行过程另行发布稳定的 `AgentEvent`，UI 只消费后者。
- **理由**：Provider 流包含协议级增量，而 UI 关心轮次、文本、工具状态、错误和完成。分层可以阻止 API chunk 格式渗入视图，也使 fake 测试和 UI 替换更简单。
- **备选方案**：让 UI 直接渲染 Provider chunk 代码少，但工具执行与终止状态会散落在 UI；使用单一万能事件会混淆协议和产品语义。
- **后果**：Agent 需要进行一次明确的事件映射；事件新增必须评估是否属于 Provider 还是产品层。

## ADR-006：Tool 将 schema、解析和执行封装在同一边界

- **状态**：已接受
- **决策**：每个 Tool 暴露 name、description、inputSchema、`parse` 和 `execute`；只有 `parse` 成功的输入才能执行。
- **理由**：模型生成的数据不可信。把校验门放在接口中可以让“不完整 ToolCall 不执行”成为结构要求，也便于注册表生成 Provider 工具定义。
- **备选方案**：Agent 中集中写 switch 与手工断言实现简单但会随工具增加膨胀；仅使用 TypeScript 类型无法校验运行时 JSON；M0 预装 schema 库则过早。
- **后果**：工具实现必须维护运行时解析；是否引入轻量 schema 库延后到真实工具出现时决定。

## ADR-007：Agent 核心以事件流驱动 UI，TUI 计划采用 Ink

- **状态**：已接受
- **决策**：Agent 对外提供异步事件流；M4 使用 Ink 构建中文 TUI，但 Ink 组件不进入 Agent、Provider 或 Tool 模块。
- **理由**：事件流天然适配模型 token 增量和工具生命周期。Ink 基于 React 的声明式模型能较快实现稳定布局、状态组件和测试，同时适合当前 TypeScript 技术栈。
- **备选方案**：原生 ANSI 控制依赖少但焦点、重绘和跨平台成本高；Blessed 体系能力完整但首版体量偏重；全屏 TUI framework 会扩大交互状态面。
- **后果**：M4 锁定 Ink 7.1.1、React 19.2.8 与兼容测试库；无颜色和窄终端必须有可读降级；UI 不得成为循环状态的事实来源。

## ADR-008：本地工具默认最小权限且不通过 shell 拼接命令

- **状态**：已接受
- **决策**：文件访问限制在显式 workspace root；命令工具使用 executable + argv、显式 cwd、timeout、AbortSignal 和输出上限。高风险外部动作需要明确确认。
- **理由**：模型可能产生错误或恶意参数。路径解析、无 shell 执行和资源上限能降低路径穿越、命令注入、挂起与海量输出风险。
- **备选方案**：把模型文本直接交给 shell 最灵活，但安全性与跨平台可预测性最差；容器沙箱更强但超出首版体量和截止时间。
- **后果**：部分复杂 shell 任务需要拆成明确命令；首版是边界控制而不是强隔离，文档必须如实说明。

## ADR-009：第一版 Session 仅保存在内存

- **状态**：已接受
- **决策**：Session 由 Agent 所有，首版只保存进程内 Message 历史、step、取消控制和必要诊断信息，不自动写入磁盘。
- **理由**：持久化会立即引入格式迁移、隐私、恢复一致性和历史压缩问题。先验证单会话自主闭环能降低无关风险。
- **备选方案**：JSONL 会话文件容易实现但仍需处理敏感内容和损坏；数据库与向量存储明显过度设计。
- **后果**：进程退出后会话丢失；需要在 M7 前根据考核和实际使用再评估是否增加显式保存。

## ADR-010：测试以 Vitest、scripted fake 和临时 workspace 为核心

- **状态**：已接受
- **决策**：使用 Vitest；Agent 测试由 scripted Fake Provider/Fake Tool 驱动，文件与命令集成测试只使用临时 workspace，真实 API 评测与 CI 分离。
- **理由**：核心循环需要断言事件顺序、请求历史、错误和停止边界，确定性 fake 比网络 mock 更清楚。Vitest 与 TypeScript/ESM 集成直接，启动速度适合小项目。
- **备选方案**：Node.js test runner 依赖更少，但首版需要较完整的断言、mock 与测试筛选体验；真实模型端到端测试不稳定、有成本且需要密钥。
- **后果**：fake 脚本必须保持简单，不能演变成第二套模型实现；真实 Provider 的兼容性仍需独立 fixture 与可选 smoke test 验证。

## ADR-011：Provider history 使用结构化工具消息

- **状态**：已接受
- **决策**：`ProviderMessage` 使用判别联合；assistant 消息携带结构化 ToolCall，tool 消息携带关联 ID、工具名、内容、`isError` 和可选 metadata，不把工具协议编码进普通字符串。
- **理由**：下一模型轮次必须无损获得调用与结果的对应关系。结构化表示可以被具体适配器可靠转换，也能让 fake 测试直接断言上下文。
- **备选方案**：把 ToolCall 或 ToolResult 拼成 JSON 文本实现更快，但会丢失角色语义、引入二次解析和厂商格式泄漏；让 Provider 直接接受 Agent Message 则会反转模块依赖。
- **后果**：Agent 需要执行一次显式 Message 映射；M2 Provider 适配器必须覆盖判别联合的全部分支。

## ADR-012：整轮工具调用先验证、后串行执行

- **状态**：已接受
- **决策**：一轮响应中的 ToolCall 先按连续 `index` 完整组装，并全部通过字段、JSON、注册表和 `Tool.parse` 校验；只有整轮有效才追加 assistant 历史并按 index 串行执行。
- **理由**：如果边解析边执行，后续非法调用会导致半轮副作用，且无法满足“非法 ToolCall 的 execute 次数为零”。先验证全部调用能提供清晰、确定且可测试的安全边界。
- **备选方案**：每个调用验证后立即执行延迟更低，但可能形成部分执行；并行执行更快，但事件、错误归属、取消和副作用顺序更难解释。
- **后果**：所有 Tool 的 `parse` 必须无副作用；一轮中任一调用无效会拒绝整轮；执行吞吐低于并行方案，但第一版更安全可控。

## ADR-013：使用内建 fetch、手写窄 SSE 解析器并注入 transport

- **状态**：已接受
- **决策**：`OpenAICompatibleProvider` 使用 Node.js 22 内建 `fetch`；SSE 只实现 Chat Completions 所需的 UTF-8、行、`data` 与事件边界；构造器允许注入 `FetchTransport` 供离线测试使用。
- **理由**：M2 所需协议面很小，标准能力已经支持流和取消。显式解析器便于逐条验证跨字节、CRLF、EOF 与 reader 清理，不需要引入 SDK 或 SSE 生产依赖；注入 transport 让普通测试不接触网络。
- **备选方案**：厂商 SDK 或通用 SSE 库能减少部分代码，但会增加生产依赖与隐式行为；全量实现 EventSource 的重连、event/id/retry 语义超出单次 POST 响应需求。
- **后果**：需要自行维护已声明子集及 fixture；协议扩展必须先增加失败用例。Provider 不自动重连或重试。

## ADR-014：严格限定 Chat Completions 子集并显式保留 ToolResult 语义

- **状态**：已接受
- **决策**：适配器只消费 `choice.index === 0`，只接受 `stop`、`tool_calls`、`length`，拒绝旧式 `function_call`、未知原因和异常 EOF。assistant ToolCall 映射为标准 `tool_calls`；ToolResult 在 `tool` 消息 content 中使用带 `easycode_tool_result` 命名空间的确定性 JSON envelope 保存工具名、成功/失败、输出和 metadata。
- **理由**：Agent 需要稳定且无歧义的完成信号；静默接受未知协议会使半截 ToolCall 进入执行边界。OpenAI-compatible tool message 没有可移植字段承载 EasyCode 的 `isError` 与 metadata，显式 envelope 能往返保留语义，也便于测试与未来迁移。
- **备选方案**：忽略未知 choice/finish 会掩盖兼容问题；只发送纯文本工具输出会丢失可恢复失败语义；把厂商 wire 类型直接暴露给 Agent 会破坏 Provider 边界。
- **后果**：部分声称兼容但行为不同的服务会明确报 `protocol_error`，需要用 fixture 评估后再扩展；模型会看到一层稳定 JSON envelope。

## ADR-015：M3 使用固定工具集、canonical workspace 边界与窄命令协议

- **状态**：已接受
- **决策**：M3 只显式注册 `list_directory`、`search_files`、`read_file`、`apply_patch`、`run_command`。文件工具只接受 workspace 相对路径，并在执行时通过 canonical 路径阻止 symlink/junction 越界；修改只提供唯一精确替换与排他创建。命令只接受 executable + argv、相对 cwd 与有界 timeout，使用 `shell:false`，并过滤敏感环境变量及拒绝已知高风险入口。
- **理由**：固定协议便于模型理解、运行时校验和离线验收。词法路径检查不足以阻止链接越界，canonical 检查是必要的第二道边界；精确 patch 能检测陈旧上下文，避免整文件盲写。Windows 的 `npm.cmd`/`.bat` 依赖命令解释器，Node.js 在 `shell:false` 下不能把它当作可移植 binary，因此 M3 明确拒绝 shim，而不为 package scripts 打开 shell。
- **备选方案**：递归调用外部搜索工具会增加平台和安装依赖；整文件覆盖、shell 字符串或自动批准任意命令更灵活，但审查性和安全边界明显更差；容器或 OS sandbox 的隔离更强，但超出 M3 范围。
- **后果**：目录、搜索、文件和输出均受固定上限约束；不支持删除、重命名、shell pipeline、Windows npm shim 或 package script 专用入口。当前控制不是强沙箱，允许的进程仍拥有宿主用户权限，直接子进程之外的进程树终止能力需要后续单独设计。

## ADR-016：Agent Session 以成功提交、其他终止回滚管理内存历史

- **状态**：已接受
- **决策**：`AgentSession` 在进程内持有一份以简洁系统消息初始化的规范历史。每次任务在候选副本上运行，只有 `complete` 才提交 Agent 返回的完整消息；`aborted`、`provider_error`、`protocol_error`、`internal_error` 与 `max_steps` 均回滚候选历史。Session 同时拒绝并发提交，并为每次事件流分配单调 `runId`。
- **理由**：工具轮次可能产生 assistant ToolCall 与 ToolResult；失败或取消时提交半截历史会让下一轮携带无法闭合的协议状态。候选副本提供明确、可测试的事务边界，`runId` 让 UI 能忽略旧运行事件。
- **备选方案**：让 React 持有消息会使视图成为会话事实来源；无条件提交 Agent 快照会固化失败中间态；持久化 JSONL 会引入隐私、迁移与恢复一致性问题。
- **后果**：失败任务的 user message 也不会进入模型历史，但 UI transcript 仍保留可见记录；已经完成的文件或命令副作用无法由历史回滚撤销。Session 不持久化、不压缩，也不自动重试。

## ADR-017：TUI 使用纯事件投影并显式管理 Ctrl+C 生命周期

- **状态**：已接受
- **决策**：UI 将 `AgentEvent` 投影到纯 reducer/view-model，React 只负责输入和渲染；工具参数与结果经按工具白名单摘要。Ink 的 `exitOnCtrlC` 关闭：运行中第一次 Ctrl+C abort UI 创建并传给 Session 的 controller，第二次仅登记清理后退出；空闲时直接退出。
- **理由**：纯投影可以确定性验证 delta 顺序、工具关联、失败状态、迟到事件与 transcript 上限。显式取消生命周期确保同一 signal 继续进入 Provider/Tool，不会绕过 Agent 边界或在清理完成前伪称退出。
- **备选方案**：UI 直接读取 Provider chunk 或 Agent history 会破坏模块边界；Ink 默认 Ctrl+C 会立即 unmount；用颜色或动画作为唯一状态会损害无颜色与窄终端可读性。
- **后果**：界面固定单列、纯文本、无 Markdown 渲染，以 `[运行]`、`[完成]`、`[失败]` 表达语义；transcript、assistant 文本和摘要均有上限。M4 不实现完整滚动容器、主题、确认门或完整进程树强制终止。
