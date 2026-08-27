# EasyCode

EasyCode 是一个中文优先、可解释、可验证的轻量 Coding Agent 项目。

当前仓库处于 **M0 工程基线阶段**：仅建立架构契约、工程治理、类型边界和确定性测试基础，尚未实现真实的 Agent Loop、模型调用、代码工具或 TUI。

## 开发命令

```bash
npm install
npm run check
```

单项检查命令：

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

## 工程文档

- [架构说明](docs/ARCHITECTURE.md)
- [开发路线图](docs/ROADMAP.md)
- [设计决策](docs/DECISIONS.md)
- [验收标准](docs/ACCEPTANCE.md)
- [协作约定](AGENTS.md)

## 安全提示

不要提交 API key、`.env`、会话记录或工具执行产生的临时文件。仓库只提供 `.env.example` 作为环境变量名称示例。
