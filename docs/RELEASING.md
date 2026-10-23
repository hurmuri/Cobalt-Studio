# 发版流程

唯一发版入口是 `scripts/release.ps1`，根目录 `release.cmd` 只是便捷包装。需要 PowerShell 7、Node.js 20+、.NET 10 SDK、Git 和已安装的 cobalt/ffmpeg 依赖。

```powershell
.\release.cmd
# 或明确填写发版说明
pwsh -NoProfile -File .\scripts\release.ps1 -Bump patch -Notes "本次实际改动"
# 仅预览，不修改版本或文件
pwsh -NoProfile -File .\scripts\release.ps1 -Bump patch -DryRun
```

固定目录：

- 可运行程序：`release\Cobalt Studio\Cobalt Studio.exe`
- 每版目录：`release\artifacts\<版本>\`
- 便携 ZIP：版本目录内 `Cobalt-Studio-v<版本>-win-x64.zip`
- 独立 EXE：版本目录内 `Cobalt-Studio-v<版本>-win-x64.exe`
- 发布记录：同目录 `Cobalt-Studio-v<版本>.json`
- 校验文件：同目录 `SHA256SUMS.txt`
- 最新已验证包：`release\artifacts\latest.json`、`LATEST.md`
- 构建暂存：`.build\portable\`
- 待恢复用户状态：`.build\runtime-state\`

脚本依次执行版本同步、完整测试、停止本项目客户端及其子进程、备份用户状态、便携构建、便携版 UI 验证、清理验证状态、ZIP 打包、生成清单与 SHA256、恢复用户状态并比对哈希、重新启动程序。任何一步失败均不得声明发版完成；恢复失败时保留备份并明确报告。

ZIP 打包后，`build-standalone.ps1` 将完整 ZIP 嵌入自包含 .NET 启动器。发版必须把 EXE 单独复制到空目录，使用隔离的缓存与用户状态完成真实下载，再重启验证任务保留；通过后才写入最终清单和最新链接。单文件版首次启动会校验并解包，不需要旁边附带 ZIP、Node.js、ffmpeg 或资源目录。电脑仍需 WebView2 Runtime，与便携版要求相同。

单文件版运行环境位于 `%LOCALAPPDATA%\Cobalt Studio\runtimes\<版本>-<内容哈希>`，任务和设置位于同级 `data\`，升级不会覆盖。缓存使用互斥锁、临时目录、完整 ZIP SHA256 和完成清单；中断解包不会成为可用缓存。默认下载目录仍是 `D:\downloads\cobalt`。验证用 `COBALT_STANDALONE_HOME` 隔离状态，桌面宿主用 `COBALT_STUDIO_DATA_DIR` 指定状态目录。

不要直接运行底层 `build-portable.ps1` 交付新包，不使用 `-SkipTests` 或 `-SkipReleaseSmoke` 交付，不在清理脚本中删除恢复备份。不得为腾位置删除用户媒体或旧版产物。重打同版本必须得到用户明确要求，并使用 `-AllowOverwrite`。

发布后再读取 `/api/bootstrap` 核对版本、原任务 ID、保存位置和并发数。UI 检查须包含工具栏文字与图标中心、设置表单、900px 小窗口、任务列表。浏览器模拟手机检查不等于真机连通验收。

每次交付必须提供：版本、实际改动、ZIP 和独立 EXE 各自的完整绝对路径及可点击 Markdown 链接、验证结果。脚本会打印两种文件的路径与链接，并更新 `LATEST.md`，最终回复也必须包含它们。
