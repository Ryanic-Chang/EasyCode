# 更新日志

本项目的版本号以 `package.json` 为唯一运行时来源；CLI 版本与本文件版本标题由自动化测试校验一致。

## [0.2.0] - 2026-09-01

### 展示与兼容

- 增加严格可选的 `EASYCODE_ENABLE_THINKING`；仅显式配置时发送 `enable_thinking`，百炼/Qwen 演示使用 `false`；
- 根据真实百炼流修正 smoke 对 finish 后 usage-only chunk 的验收，并为 real eval 使用独立、可解释的真实模型预算；
- 强化“先观察、最小修改、结构化 stdin、失败后修正、如实验证”的 system prompt 和命令工具描述；
- 重做中文 Ink TUI 的品牌状态栏、时间线、中文工具动作、确认区和完成统计，并覆盖 120/80/60/40 columns 与 `NO_COLOR`。

### 文档与边界

- 重组 README 首屏，新增两分钟演示、设计答辩与考核提交说明；
- 保持 ToolCall 全轮预验证、workspace canonical 边界、`shell:false`、逐调用确认和危险命令硬拒绝；
- 仍不提供持久化、多 Provider、远程 telemetry、Git push/PR 工具、插件、GUI 或强沙箱。

## [0.1.3] - 2026-08-28

### 新增

- `run_command` 支持最多 16 KiB 的结构化 UTF-8 `stdin`，可在保持 `shell:false` 的前提下验证需要标准输入的程序；确认摘要只显示 byte 数，不显示正文。

## [0.1.2] - 2026-08-28

### 修复

- 允许 `run_command` 在无参数命令中省略 `args`，并安全规范化为空数组，避免模型运行 workspace 内生成程序时发生工具参数协议错误。

## [0.1.1] - 2026-08-28

### 修复

- 兼容百炼 OpenAI-compatible 流式 ToolCall continuation chunk 中的空 `id`/`name` 身份字段，同时保留最终非空身份与参数校验。

## [0.1.0] - 2026-08-28

首个可演示版本，完成 M0–M7。

### 能力

- 中文 Ink TUI、流式回答、结构化 Agent Loop 与 OpenAI-compatible Provider；
- workspace 内的目录、搜索、读取、精确修改和受控命令工具；
- 离线确定性测试、7 个 synthetic coding eval 场景、客观 grader 与隐私最小化报告；
- `easycode --help`、`easycode --version`、最小 tarball 与三平台 Node.js 22 兼容性 CI。

### 安全边界

- ToolCall 完整校验后才能执行，`run_command` 每次调用都需一次性确认；
- workspace canonical 边界、`shell:false`、timeout、abort、输出上限和统一脱敏；
- 默认测试、offline eval、帮助和版本查询不读取凭据或请求真实 API。

### 已知限制

- 不是容器或 OS 级沙箱，不保证完整进程树隔离；
- Session 只存在于内存，不提供恢复、长期记忆或 context compression；
- 只支持一个显式配置的 OpenAI-compatible Provider，不提供多 Provider 路由或自动选模；
- 不提供插件、GUI、远程 telemetry、自动 Git push/PR、发布或部署工具。
