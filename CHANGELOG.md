# 更新日志

本项目的版本号以 `package.json` 为唯一运行时来源；CLI 版本与本文件版本标题由自动化测试校验一致。

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
