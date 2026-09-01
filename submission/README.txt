EasyCode v0.2.0

公开仓库：https://github.com/Ryanic-Chang/EasyCode

EasyCode 是中文优先、可解释、可验证的轻量 Coding Agent。项目独立实现 Agent Loop，不依赖 Agent Framework；支持 OpenAI-compatible 流式 Provider，并已针对阿里云百炼/Qwen Function Calling 的增量 ToolCall、usage-only chunk 与可选 enable_thinking 做兼容验证。

运行要求：Node.js >= 22 与 npm。

从源码运行：
1. npm ci
2. npm run build
3. 在当前进程环境设置 EASYCODE_API_KEY、EASYCODE_BASE_URL、EASYCODE_MODEL；百炼演示另设 EASYCODE_ENABLE_THINKING=false
4. npm start

完全离线演示：npm run eval:offline
完整质量检查：npm run check
安装包验证：npm run test:package

特色功能：
- 中文 Ink TUI，流式展示用户、分析轮次、工具、授权与结果；
- 五个本地工具，支持搜索、读取、唯一精确修改、命令验证及有界结构化 stdin；
- ToolCall 全轮预验证、workspace 路径边界、shell:false、每次命令单独确认且 Enter 默认拒绝；
- scripted fake 确定性测试与真实 Provider eval 分离，成功由文件/hash、验证程序、修改范围和预算等客观 grader 判定；
- 报告只保存安全复现元数据、指标和断言，不保存会话、工具正文或凭据。

当前限制：不是 OS 级强沙箱；Session 不持久化，失败回滚历史但不撤销已发生的文件副作用；不提供多 Provider、插件、GUI、长期记忆、自动 Git push/PR 或发布部署能力。
