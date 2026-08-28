# EasyCode v0.1.0 离线演示

## 目标

默认演示不需要 API key、网络或费用。它使用 scripted Provider、版本化 synthetic fixture、真实 Agent Loop 与真实受控工具，成功由客观 grader 判定，而不是由自然语言回答判定。

## 环境

- Node.js >= 22；
- npm；
- 仓库根目录为当前目录。

## 演示步骤

```bash
npm ci
npm run check
npm run eval:offline
npm run test:package
```

预期结果：质量门全部通过；offline eval 摘要显示 7/7 场景成功；报告写入 `.easycode/evals/<runId>.json`；package smoke 显示 tarball 可在临时空目录安装，且帮助、版本、未知参数和无配置启动行为稳定。临时 fixture、安装目录、tarball 与隔离 npm cache 会被清理。

可单独展示无需配置的 CLI：

```bash
npm run build
node dist/main.js --help
node dist/main.js --version
```

## 结果解释

- `npm test` 是模块和离线集成契约；
- `eval:offline` 是固定 coding 场景的功能证据，不能由 `complete` 单独判成功；
- `test:package` 是安装与 CLI 交付证据；
- `.easycode/evals/` 报告只含复现元数据、指标与安全断言，不含消息、工具参数或结果正文。

## 可选真实演示

`npm run test:smoke` 与 `npm run eval:real` 会请求真实 Provider，可能产生费用和限流。它们分别要求显式开关 `EASYCODE_SMOKE=1` 或 `EASYCODE_REAL_EVAL=1` 以及完整 Provider 配置，不进入普通 CI。本版本发布验收不运行这两项；如需演示，先阅读 `README.md` 与 `docs/SECURITY.md`，只通过当前进程环境注入凭据。
