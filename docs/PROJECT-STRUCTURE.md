# 项目目录

| 路径 | 用途 |
|---|---|
| `server.mjs` | Web/API/SSE 服务入口 |
| `cobalt.mjs`、`mcp.mjs`、`lib.mjs` | CLI、MCP 和媒体客户端 |
| `lib/` | 配置、任务持久化、队列、下载、缩略图 |
| `public/` | 桌面和手机界面及本地字体、动画资源 |
| `windows/` | WinForms、WebView2、Shell、进程管理 |
| `launcher/` | 内嵌完整 ZIP 的独立 EXE 启动器 |
| `scripts/` | 发版、构建、版本同步、启动、依赖准备 |
| `scripts/diagnostics/` | 独立诊断脚本，不进入发版主流程 |
| `test/` | 维护中的功能、UI、桌面和发版检查 |
| `docs/` | 发版、结构和合规说明 |
| `LICENSE`、`NOTICE`、`THIRD-PARTY-NOTICES.md` | 本项目 AGPL-3.0 与上游、依赖许可 |
| `release/artifacts/<版本>/` | 每版 ZIP、独立 EXE、发布清单和哈希 |
| `release/artifacts/` | 最新交付指针；历史版本保留原文件 |
| `release/Cobalt Studio/` | 可运行便携版，包含本机运行状态 |
| `.build/portable/` | 当前构建暂存，不能作为交付包 |
| `.build/diagnostics/` | 历史实验、零散脚本、截图归档 |
| `.build/verification/` | 新的截图和验证报告 |
| `.data/`、`downloads/` | 源码运行状态和历史下载，不能当垃圾清理 |
| `cobalt-api/`、`node_modules/` | 按 `UPSTREAM.json` 获取的上游源码和已安装依赖，不进入 Git |

根目录只保留明确的入口、包清单、环境示例、版本和项目约定。`AGENTS.md` 是项目 agent 工作说明，`DESIGN.md` 记录视觉规则，`UX-CONTRACT.md` 记录交互行为。可删除确认不用的构建实验和缓存；保留原任务、用户媒体、恢复快照及历史发布包。
