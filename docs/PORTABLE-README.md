# Cobalt Studio 便携版

运行同目录 `Cobalt Studio.exe`。程序会启动自带的下载服务、cobalt API 和 ffmpeg，不需要另装 Node.js 或登录外部账号。

## 下载

顶部输入链接，点击“下载”或按回车，按已保存的默认选项创建任务。“新建”用于批量输入或单独选择类型、画质、音频格式。任务列表可查看进度、原帖信息、源链接，完成后可打开文件位置。

Windows 默认保存到 `D:\downloads\cobalt`，默认同时下载 5 个任务。设置中可修改保存位置并选择 1–10 个并发任务，也可关闭缩略图。保存位置变化只影响后续下载；旧文件仍在原位置。

任务与设置保存在本程序目录 `.data` 中。请不要把 `.data` 或已有下载文件当作缓存删除。关闭窗口默认进入托盘，可从托盘菜单退出、重启服务或更改启动行为。

## 手机页面

电脑和手机连接同一局域网后，使用右上二维码打开手机页面。手机可以提交、查看、重试和取消任务，也可以保存已完成文件。修改设置和打开电脑文件夹仅允许电脑本机操作。不要将该服务端口映射到公网。

## 发布文件

发行 ZIP 使用 `Cobalt-Studio-v<版本>-win-x64.zip` 命名，并附带发布清单与 SHA256。开发项目的固定输出目录为 `release\artifacts\`，`latest.json`、`LATEST.md` 指向最新已验证包。

## 许可证

Cobalt Studio 以 AGPL-3.0-only 发布。完整源码、cobalt 的锁定版本和兼容补丁见 <https://github.com/hurmuri/Cobalt-Studio>。

本包同时包含 cobalt API 源码（AGPL-3.0）、Node.js（MIT）、FFmpeg（GPL-3.0）以及各自的许可证文件。GSAP 和 Cabinet Grotesk 字体不因本项目而改许可。详见 `LICENSE`、`NOTICE`、`THIRD-PARTY-NOTICES.md` 和 `THIRD-PARTY-NOTICES.txt`。

只下载你有权保存的公开内容。本程序不提供绕过登录、付费或 DRM 的功能。
