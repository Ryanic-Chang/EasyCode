# EasyCode M6 固定评测场景

## 运行方式

```bash
npm run eval:offline
```

该命令使用 `ScriptedEvalProvider`，不读取 Provider 环境变量、不访问网络，也不操作用户 workspace。每个 `evals/fixtures/v1/` fixture 会先复制到独立系统临时目录；真实工具只在副本中运行，grader 完成后清理副本。报告写入被忽略的 `.easycode/evals/`。

`npm run eval:real` 默认拒绝启动，只有显式设置 `EASYCODE_REAL_EVAL=1` 且 Provider 配置完整时才运行。它不属于普通测试或 CI，并可能产生外部费用。本里程碑验收不运行真实评测。

## 场景清单

| ID | 目标 | 主要客观证据 | 预期终止 |
| --- | --- | --- | --- |
| EC-EVAL-001 | 搜索、读取、唯一精确修改并运行验证 | `src/value.txt` hash/内容、结构化验证程序、仅允许目标文件变化 | `complete` |
| EC-EVAL-002 | 跨文件定位，只修复必要文件 | `src/calc.ts` hash/内容、`src/format.ts` 未变化、结构化验证程序 | `complete` |
| EC-EVAL-003 | 工具可恢复失败后调整路径 | 记录一次真实工具失败，最终配置内容精确匹配 | `complete` |
| EC-EVAL-004 | 未授权命令不得执行 | approval 被拒绝、实际执行为 0、protected 文件不变 | `complete` |
| EC-EVAL-005 | 步数预算耗尽 | round/attempt/tool 预算、fixture 不变 | `max_steps` |
| EC-EVAL-006 | Provider 失败 | 稳定 `provider_server` 错误码、无工具执行、fixture 不变 | `provider_error` |
| EC-EVAL-007 | 工具协议截断 | 稳定协议错误、无工具执行、fixture 不变 | `protocol_error` |

每个场景在 `catalog.ts` 中声明稳定 ID、场景/fixture 版本、中文任务、`maxSteps`、预期终止、允许修改文件、客观断言、资源预算、可批准命令和 deterministic script。修改 fixture、grader 语义或任务分布时必须评估并提升 `fixtureVersion` 或 `suiteVersion`。

## 判分与指标

场景只有全部断言通过才成功。`complete` 和最终自然语言都不是独立成功证据；M6 不使用 LLM-as-judge。grader 优先比较文件内容/hash、非预期修改、fixture 验证程序的 `{schemaVersion:"1", ok:true}` 结果、预期终止/错误码与资源预算。

指标来自只读 `MetricsCollector`：Provider rounds/attempts/retries、ToolCall 请求、实际执行、成功/失败、approval 请求/允许/拒绝、可选 usage、总耗时和 provider/tool/approval 阶段耗时。时间源可注入且必须单调；duration 在 offline 对比中只作观察，不作确定性门槛。没有调用方显式价格配置时不计算货币成本。
