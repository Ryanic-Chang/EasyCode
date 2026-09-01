# v0.2.0 交付检查清单

## 本地检查

- [ ] Git 基线、分支、远端和用户已有变更已核对；
- [ ] Node.js >= 22，执行 `npm ci` 后 `package-lock.json` 不变；
- [ ] `npm run check`、`npm run eval:offline`、`npm run test:package`、`npm run license:check` 通过；
- [ ] `npm ls --all`、两项 `npm audit` 的真实结果已审查；
- [ ] `npm pack --dry-run --json` 只含 allowlist 文件；
- [ ] `git diff --check`、secret/产物/禁用框架/真实网络/M7 越界扫描通过；
- [ ] 未运行 `test:smoke`、`eval:real` 或真实 Provider。

## Git 与 CI

- [ ] 只创建聚焦提交 `feat(demo): polish real-provider experience`；
- [ ] 普通 push `origin main`，不 amend、rebase、force push；
- [ ] Ubuntu Node.js 24 quality job 通过；
- [ ] Windows、Ubuntu、macOS Node.js 22 compatibility jobs 全部通过；
- [ ] CI 未配置 Provider secrets、真实评测开关或写权限。

## 明确不执行

- `npm publish`；
- 创建或推送 Git tag；
- 创建 GitHub Release；
- 真实 API smoke 或 real eval。
