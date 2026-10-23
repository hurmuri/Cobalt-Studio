using System.Diagnostics;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace CobaltStudio.Desktop;

internal sealed class MainForm : Form
{
    private readonly AppPaths paths;
    private readonly DesktopSettings settings;
    private readonly ProcessRunner runner;
    private readonly Icon appIcon;
    private readonly WebView2 webView;
    private readonly Panel loadingPanel;
    private readonly Label loadingTitle;
    private readonly Label loadingDetail;
    private readonly ProgressBar loadingBar;
    private readonly Button retryButton;
    private readonly NotifyIcon tray;
    private readonly ToolStripMenuItem startMenu;
    private readonly ToolStripMenuItem startupMenu;
    private readonly ToolStripMenuItem closeToTrayMenu;
    private readonly ToolStripMenuItem launchMinimizedMenu;
    private readonly System.Windows.Forms.Timer healthTimer;
    private bool? lastCobaltOnline;
    private bool exitInProgress;
    private bool forceExit;
    private bool webViewSuspended;

    public MainForm()
    {
        paths = AppPaths.Discover();
        settings = DesktopSettings.Load(paths.SettingsFile);
        runner = new ProcessRunner(paths, settings);
        runner.ProcessFailed += (_, _) =>
        {
            if (!IsHandleCreated || IsDisposed) return;
            try
            {
                BeginInvoke(() =>
                {
                    if (exitInProgress) return;
                    tray?.ShowBalloonTip(5000, "Cobalt Studio", "下载服务意外退出，右键托盘可重新启动。", ToolTipIcon.Error);
                });
            }
            catch (InvalidOperationException) { }
        };
        appIcon = IconFactory.Create();

        Text = "Cobalt Studio";
        Icon = appIcon;
        BackColor = Color.FromArgb(246, 247, 248);
        MinimumSize = new Size(900, 640);
        Size = new Size(Math.Max(900, settings.WindowWidth), Math.Max(640, settings.WindowHeight));
        StartPosition = FormStartPosition.CenterScreen;
        AutoScaleMode = AutoScaleMode.Dpi;
        KeyPreview = true;

        webView = new WebView2
        {
            Dock = DockStyle.Fill,
            DefaultBackgroundColor = Color.FromArgb(246, 247, 248),
            CreationProperties = new CoreWebView2CreationProperties
            {
                UserDataFolder = paths.WebViewData,
                IsInPrivateModeEnabled = false,
                AdditionalBrowserArguments = "--disable-background-networking --disable-component-update --disable-sync --disable-extensions --disable-features=msEdgeSidebarV2,msEdgeShoppingAssistant",
            },
        };
        loadingPanel = CreateLoadingPanel(out loadingTitle, out loadingDetail, out loadingBar, out retryButton);
        Controls.Add(webView);
        Controls.Add(loadingPanel);

        var menu = new ContextMenuStrip();
        var open = new ToolStripMenuItem("打开 Cobalt Studio", null, (_, _) => ShowFromTray());
        open.Font = new Font(open.Font, FontStyle.Bold);
        startMenu = new ToolStripMenuItem("重新启动下载服务", null, async (_, _) => await RestartServicesAsync());
        startupMenu = new ToolStripMenuItem("开机启动", null, (_, _) => ToggleStartup())
        {
            CheckOnClick = false,
        };
        closeToTrayMenu = new ToolStripMenuItem("关闭到托盘", null, (_, _) => ToggleCloseToTray())
        {
            CheckOnClick = false,
        };
        launchMinimizedMenu = new ToolStripMenuItem("启动时最小化", null, (_, _) => ToggleLaunchMinimized())
        {
            CheckOnClick = false,
        };
        var openFolder = new ToolStripMenuItem("打开下载文件夹", null, (_, _) => OpenDownloads());
        var logs = new ToolStripMenuItem("打开日志目录", null, (_, _) => OpenFolder(paths.LogDirectory));
        var exit = new ToolStripMenuItem("退出", null, (_, _) => ExitApplication());
        menu.Items.Add(open);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(startMenu);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(startupMenu);
        menu.Items.Add(closeToTrayMenu);
        menu.Items.Add(launchMinimizedMenu);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(openFolder);
        menu.Items.Add(logs);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(exit);
        tray = new NotifyIcon
        {
            Icon = appIcon,
            Text = "Cobalt Studio",
            Visible = true,
            ContextMenuStrip = menu,
        };
        tray.MouseDoubleClick += (_, _) => ShowFromTray();
        RefreshDesktopMenus();
        healthTimer = new System.Windows.Forms.Timer { Interval = 15000 };
        healthTimer.Tick += async (_, _) => await UpdateTrayHealthAsync();
        healthTimer.Start();

        FormClosing += OnFormClosing;
        Resize += (_, _) => UpdateWebViewMemory();
        VisibleChanged += (_, _) => UpdateWebViewMemory();
        Shown += (_, _) =>
        {
            BeginInvoke(async () => await StartAsync());
        };
    }

    protected override void WndProc(ref Message message)
    {
        if (message.Msg == 0x8001)
        {
            ShowFromTray();
            return;
        }
        base.WndProc(ref message);
    }

    protected override void OnLoad(EventArgs e)
    {
        base.OnLoad(e);
        if (settings.LaunchMinimized ||
            Environment.GetCommandLineArgs().Any(arg => arg.Equals("--minimized", StringComparison.OrdinalIgnoreCase)))
        {
            WindowState = FormWindowState.Minimized;
            Hide();
        }
        if (settings.Maximized) WindowState = FormWindowState.Maximized;
    }

    private Panel CreateLoadingPanel(
        out Label title,
        out Label detail,
        out ProgressBar progress,
        out Button retry)
    {
        var panel = new Panel
        {
            Dock = DockStyle.Fill,
            BackColor = Color.FromArgb(246, 247, 248),
            Padding = new Padding(48),
        };
        var inner = new Panel { Dock = DockStyle.Fill, BackColor = Color.Transparent };
        title = new Label
        {
            Text = "正在启动服务",
            Font = new Font("Microsoft YaHei UI", 14, FontStyle.Bold),
            ForeColor = Color.FromArgb(30, 38, 43),
            AutoSize = false,
            Dock = DockStyle.Top,
            Height = 40,
        };
        detail = new Label
        {
            Text = "检查运行文件…",
            Font = new Font("Microsoft YaHei UI", 9),
            ForeColor = Color.FromArgb(96, 106, 112),
            AutoSize = false,
            Dock = DockStyle.Top,
            Height = 48,
        };
        progress = new ProgressBar
        {
            Style = ProgressBarStyle.Marquee,
            MarqueeAnimationSpeed = 24,
            Width = 240,
            Height = 3,
            Dock = DockStyle.Top,
        };
        retry = new Button
        {
            Text = "重试启动",
            Visible = false,
            Width = 110,
            Height = 34,
            FlatStyle = FlatStyle.Flat,
            BackColor = Color.FromArgb(31, 111, 235),
            ForeColor = Color.White,
            Margin = new Padding(0, 20, 0, 0),
        };
        retry.FlatAppearance.BorderSize = 0;
        retry.Click += async (_, _) => await StartAsync();
        inner.Controls.Add(retry);
        inner.Controls.Add(progress);
        inner.Controls.Add(detail);
        inner.Controls.Add(title);
        panel.Controls.Add(inner);
        return panel;
    }

    private async Task StartAsync()
    {
        retryButton.Visible = false;
        loadingBar.Visible = true;
        loadingTitle.Text = "正在启动服务";
        loadingDetail.Text = "检查运行文件…";
        SetLoadingVisible(true);
        try
        {
            paths.Validate();
            loadingDetail.Text = "启动下载引擎…";
            await runner.StartAsync(CancellationToken.None);
            loadingDetail.Text = "加载界面…";
            await webView.EnsureCoreWebView2Async();
            ConfigureWebView();
            webView.Source = new Uri(runner.AppUrl);
            webView.Visible = true;
            loadingPanel.Visible = false;
        UpdateWebViewMemory();
            UpdateTrayStatus(await runner.GetHealthAsync(CancellationToken.None));
        }
        catch (Exception ex)
        {
            ShowStartupError(ex);
        }
    }

    private void ConfigureWebView()
    {
        var core = webView.CoreWebView2;
        core.Settings.AreDefaultContextMenusEnabled = false;
        core.Settings.AreDevToolsEnabled = false;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.AreBrowserAcceleratorKeysEnabled = true;
        core.Settings.IsSwipeNavigationEnabled = false;
        core.Settings.IsGeneralAutofillEnabled = false;
        core.Settings.IsPasswordAutosaveEnabled = false;
        core.Settings.IsPinchZoomEnabled = false;
        core.Settings.IsBuiltInErrorPageEnabled = false;
        core.Settings.IsZoomControlEnabled = false;
        core.Settings.IsWebMessageEnabled = true;
        core.Settings.IsNonClientRegionSupportEnabled = false;
        try { core.Settings.IsReputationCheckingRequired = false; } catch { }
        core.NewWindowRequested += (_, e) =>
        {
            e.Handled = true;
            OpenExternal(e.Uri);
        };
        core.WebMessageReceived += async (_, e) =>
        {
            string? requestId = null;
            try
            {
                if (!Uri.TryCreate(e.Source, UriKind.Absolute, out var source) ||
                    source.GetLeftPart(UriPartial.Authority) != runner.AppUrl) return;
                using var document = JsonDocument.Parse(e.WebMessageAsJson);
                if (document.RootElement.TryGetProperty("requestId", out var request)) requestId = request.GetString();
                if (!document.RootElement.TryGetProperty("type", out var type))
                    return;
                var messageType = type.GetString();
                if (messageType == "open-downloads")
                {
                    await ShellFolders.OpenAsync(ReadDownloadDirectory());
                }
                else if (messageType == "open-task")
                {
                    var id = document.RootElement.GetProperty("id").GetString() ?? "";
                    using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
                    using var response = await client.GetAsync($"{runner.AppUrl}/api/tasks/{Uri.EscapeDataString(id)}");
                    response.EnsureSuccessStatusCode();
                    using var task = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
                    var files = task.RootElement.GetProperty("task").GetProperty("files");
                    var file = files.EnumerateArray().Select(item => item.GetProperty("path").GetString()).FirstOrDefault(File.Exists);
                    if (file is null) throw new FileNotFoundException("下载文件不存在");
                    await ShellFolders.OpenAsync(file, selectFile: true);
                }
                else if (messageType == "repair-lan")
                {
                    _ = RepairLanAccessAsync();
                }
                if (requestId is not null) core.PostWebMessageAsJson(JsonSerializer.Serialize(new { requestId, ok = true }));
            }
            catch (Exception error)
            {
                if (requestId is not null) core.PostWebMessageAsJson(JsonSerializer.Serialize(new { requestId, ok = false, error = error.Message }));
            }
        };
    }

    private void ShowStartupError(Exception error)
    {
        loadingBar.Visible = false;
        loadingTitle.Text = "启动失败";
        loadingDetail.Text = $"{error.Message}\n\n日志：{paths.LogDirectory}";
        retryButton.Visible = true;
        tray.ShowBalloonTip(5000, "Cobalt Studio", "下载服务启动失败，请打开客户端查看日志。", ToolTipIcon.Error);
    }

    private void UpdateWebViewMemory()
    {
        if (webView.CoreWebView2 is null) return;
        var hidden = !Visible || WindowState == FormWindowState.Minimized;
        if (hidden && !webViewSuspended)
        {
            webViewSuspended = true;
            try { webView.CoreWebView2.MemoryUsageTargetLevel = CoreWebView2MemoryUsageTargetLevel.Low; } catch { }
            _ = webView.CoreWebView2.TrySuspendAsync();
        }
        else if (!hidden && webViewSuspended)
        {
            webViewSuspended = false;
            webView.CoreWebView2.Resume();
            try { webView.CoreWebView2.MemoryUsageTargetLevel = CoreWebView2MemoryUsageTargetLevel.Normal; } catch { }
        }
    }

    private async Task RepairLanAccessAsync()
    {
        try
        {
            var ready = await runner.RefreshLanAccessAsync();
            if (!IsHandleCreated || IsDisposed) return;
            BeginInvoke(() =>
            {
                tray.ShowBalloonTip(
                    ready ? 2200 : 5000,
                    "Cobalt Studio",
                    ready
                        ? "局域网防火墙规则已配置，请在手机系统浏览器中刷新验证。"
                        : "局域网访问仍未放通，请检查 Windows 防火墙。",
                    ready ? ToolTipIcon.Info : ToolTipIcon.Warning);
            });
        }
        catch (Exception error)
        {
            if (!IsHandleCreated || IsDisposed) return;
            BeginInvoke(() => tray.ShowBalloonTip(
                5000,
                "Cobalt Studio",
                $"修复失败：{error.Message}",
                ToolTipIcon.Error));
        }
    }

    private void SetLoadingVisible(bool visible)
    {
        loadingPanel.Visible = visible;
        loadingPanel.BringToFront();
    }

    private async Task RestartServicesAsync()
    {
        SetLoadingVisible(true);
        loadingBar.Visible = true;
        loadingTitle.Text = "正在重启服务";
        loadingDetail.Text = "保存任务状态并重新启动…";
        try
        {
            await runner.RestartAsync(CancellationToken.None);
            webView.Source = new Uri($"{runner.AppUrl}/?restart={DateTimeOffset.UtcNow.ToUnixTimeSeconds()}");
            loadingPanel.Visible = false;
            UpdateWebViewMemory();
            tray.ShowBalloonTip(2500, "Cobalt Studio", runner.LanAccessReady
                ? "下载服务已重新启动。"
                : "服务已启动，但手机访问尚未获得 Windows 防火墙授权。", ToolTipIcon.Info);
        }
        catch (Exception ex)
        {
            ShowStartupError(ex);
        }
    }

    internal void ShowFromTray()
    {
        Show();
        if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
        UpdateWebViewMemory();
        Activate();
        NativeMethods.SetForegroundWindow(Handle);
    }

    private async Task UpdateTrayHealthAsync()
    {
        if (WindowState != FormWindowState.Minimized && Visible) return;
        var health = await runner.GetHealthAsync(CancellationToken.None);
        UpdateTrayStatus(health);
    }

    private void UpdateTrayStatus((bool Online, string Version, int Services) health)
    {
        var online = health.Online && health.Services > 0;
        var text = online
            ? $"Cobalt Studio - cobalt {health.Version} ({health.Services} 站点)"
            : "Cobalt Studio - cobalt 未连接";
        tray.Text = text[..Math.Min(text.Length, 63)];
        if (lastCobaltOnline == true && !online)
            tray.ShowBalloonTip(4000, "Cobalt Studio", "cobalt 下载引擎已断开，右键托盘可重启服务。", ToolTipIcon.Warning);
        lastCobaltOnline = online;
    }

    private async void OpenDownloads()
    {
        try
        {
            var folder = ReadDownloadDirectory();
            Directory.CreateDirectory(folder);
            await ShellFolders.OpenAsync(folder);
        }
        catch (Exception error)
        {
            tray.ShowBalloonTip(4000, "Cobalt Studio", $"无法打开下载文件夹：{error.Message}", ToolTipIcon.Error);
        }
    }

    private string ReadDownloadDirectory()
    {
        try
        {
            var settingsFile = Path.Combine(paths.DataDirectory, "settings.json");
            if (File.Exists(settingsFile))
            {
                using var json = JsonDocument.Parse(File.ReadAllText(settingsFile));
                if (json.RootElement.TryGetProperty("downloadDir", out var value))
                {
                    var configured = value.GetString();
                    if (!string.IsNullOrWhiteSpace(configured))
                        return Path.GetFullPath(configured);
                }
            }
        }
        catch { }
        return @"D:\downloads\cobalt";
    }

    private void ToggleStartup()
    {
        try
        {
            var next = !StartupManager.IsEnabled();
            StartupManager.Set(next, Application.ExecutablePath);
            settings.StartWithWindows = next;
            settings.Save(paths.SettingsFile);
            RefreshDesktopMenus();
        }
        catch (Exception error)
        {
            tray.ShowBalloonTip(4000, "Cobalt Studio", $"无法修改开机启动：{error.Message}", ToolTipIcon.Error);
        }
    }

    private void ToggleCloseToTray()
    {
        settings.CloseToTray = !settings.CloseToTray;
        SaveSettings();
        RefreshDesktopMenus();
    }

    private void ToggleLaunchMinimized()
    {
        settings.LaunchMinimized = !settings.LaunchMinimized;
        SaveSettings();
        RefreshDesktopMenus();
    }

    private void SaveSettings()
    {
        try { settings.Save(paths.SettingsFile); } catch { }
    }

    private void RefreshDesktopMenus()
    {
        var startup = false;
        try { startup = StartupManager.IsEnabled(); } catch { }
        settings.StartWithWindows = startup;
        startupMenu.Checked = startup;
        closeToTrayMenu.Checked = settings.CloseToTray;
        launchMinimizedMenu.Checked = settings.LaunchMinimized;
    }

    private static async void OpenFolder(string folder)
    {
        try
        {
            Directory.CreateDirectory(folder);
            await ShellFolders.OpenAsync(folder);
        }
        catch { }
    }

    private static void OpenExternal(string uri)
    {
        if (!Uri.TryCreate(uri, UriKind.Absolute, out var parsed)) return;
        if (parsed.Scheme is not ("http" or "https")) return;
        try { Process.Start(new ProcessStartInfo(parsed.AbsoluteUri) { UseShellExecute = true }); } catch { }
    }

    private void OnFormClosing(object? sender, FormClosingEventArgs e)
    {
        if (!forceExit && settings.CloseToTray && e.CloseReason == CloseReason.UserClosing)
        {
            e.Cancel = true;
            SaveWindowState();
            Hide();
            tray.ShowBalloonTip(1800, "Cobalt Studio", "仍在后台下载。单击托盘图标可以重新打开。", ToolTipIcon.Info);
            return;
        }
        if (!exitInProgress)
        {
            e.Cancel = true;
            ExitApplication();
            return;
        }
        SaveWindowState();
        tray.Visible = false;
    }

    private void SaveWindowState()
    {
        settings.Maximized = WindowState == FormWindowState.Maximized;
        if (WindowState == FormWindowState.Normal)
        {
            settings.WindowWidth = Width;
            settings.WindowHeight = Height;
        }
        try { settings.Save(paths.SettingsFile); } catch { }
    }

    private void ExitApplication()
    {
        if (exitInProgress) return;
        exitInProgress = true;
        Hide();
        _ = ShutdownAndCloseAsync();
    }

    private async Task ShutdownAndCloseAsync()
    {
        try { await runner.DisposeAsync(); } catch { }
        forceExit = true;
        Close();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            healthTimer.Dispose();
            tray.Dispose();
            appIcon.Dispose();
            webView.Dispose();
        }
        base.Dispose(disposing);
    }
}
