# EasyCode v0.2.0 两分钟演示

## 0:00–0:20：一句话与架构

EasyCode 是中文优先、独立实现的轻量 Coding Agent。展示 README 首屏架构：TUI 把任务交给 Session 与 Agent Loop；Loop 流式请求 Provider、调用五个受控工具，再把结果写回上下文继续推理。强调没有使用 Agent Framework。

## 0:20–0:45：完全离线证据

```bash
npm ci
npm run check
npm run eval:offline
```

预期：质量门通过；7/7 固定场景成功。打开 `.easycode/evals/<runId>.json`，只指出 revision、场景断言、rounds、tools、tokens 与终止原因，不展示或保存会话正文。说明 `complete` 不是成功条件，grader 还检查文件/hash、非预期修改、验证脚本和预算。

## 0:45–1:25：真实库存修复

在 `demo-workspace/scenarios/01-inventory-atomicity` 启动 TUI。任务要求先读代码，只修改 `src/inventory.mjs`，运行 `node verify.mjs`。展示：

1. 顶部品牌、v0.2.0、Qwen 模型、workspace 和状态；
2. “读取文件 → 修改文件 → 执行命令”的中文时间线；
3. 命令的一次性授权框；按 `y` 只允许当前 ToolCall；
4. 验证结果 4/4 后的简短回答，以及 rounds、工具成功/失败统计。

## 1:25–1:45：结构化 stdin

在隔离 A+B workspace 中要求创建并编译 C++ 程序，再以 `stdin` 输入 `3 5`。每条编译/运行命令分别确认；界面只显示 stdin byte 数，不显示正文。客观检查 executable stdout 为 `8`。强调没有 `echo | program`、重定向、`cmd`、PowerShell 或 `shell:true`。

## 1:45–2:00：默认拒绝与限制

让 Agent 请求一个安全的验证命令，在确认框直接按 Enter：默认拒绝，进程不执行。说明即使按 `y`，shell pipe、危险 Git、发布/部署和 workspace 外访问仍会在确认前硬拒绝。

最后说明限制：当前不是 OS 级沙箱；Session 只在内存中，失败回滚模型历史但不撤销已发生的文件副作用；没有多 Provider、长期记忆、插件或 Git push/PR 工具。

## 可复现配置与注意事项

默认演示使用 `npm run eval:offline`，不需要 key、网络或费用。可选百炼演示必须通过当前进程环境设置 Provider 变量，并设置：

```text
EASYCODE_ENABLE_THINKING=false
```

真实 smoke 需 `EASYCODE_SMOKE=1`，真实 eval 需 `EASYCODE_REAL_EVAL=1`。两者可能产生费用、限流和重复重试计费，不进入普通 CI。不得把 key 写入命令记录、文档、截图或报告。
