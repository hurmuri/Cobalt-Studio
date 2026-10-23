using System.Diagnostics;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using Microsoft.Win32;
using System.Text;
using System.Text.Json;

namespace CobaltStudio.Desktop;

internal sealed class ProcessRunner : IAsyncDisposable
{
    private readonly AppPaths paths;
    private readonly DesktopSettings settings;
    private readonly StringBuilder startupErrors = new();
    private readonly List<Process> processes = [];
    private readonly SemaphoreSlim gate = new(1, 1);
    private JobObject? job;
    private bool started;
    private bool serverReady;
    private bool lanAccessReady;
    private int uiPort;
    private int cobaltPort;
    private bool stopping;

    public ProcessRunner(AppPaths paths, DesktopSettings settings)
    {
        this.paths = paths;
        this.settings = settings;
    }

    public string StartupErrors => startupErrors.ToString();
    public event EventHandler? ProcessFailed;
    public bool Stopping => stopping;
    public int UiPort => uiPort;
    public string AppUrl => $"http://127.0.0.1:{uiPort}";
    public bool LanAccessReady => lanAccessReady;

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        await gate.WaitAsync(cancellationToken);
        try
        {
            if (started) return;
            job ??= JobObject.Create();
            uiPort = FindFreePort(settings.PreferredUiPort);
            cobaltPort = FindFreePort(settings.PreferredCobaltPort);
            lanAccessReady = EnsureLanAccess(uiPort);
            await StartCobaltAsync(cancellationToken);
            await StartServerAsync(cancellationToken);
            serverReady = true;
            started = true;
        }
        finally
        {
            gate.Release();
        }
    }

    public async Task StopAsync()
    {
        stopping = true;
        foreach (var process in processes.AsEnumerable().Reverse())
        {
            try
            {
                if (!process.HasExited)
                {
                    process.Kill(entireProcessTree: true);
                    await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(4));
                }
            }
            catch { }
        }
        processes.Clear();
        started = false;
        serverReady = false;
        lanAccessReady = false;
        stopping = false;
    }

    public async Task<bool> RestartAsync(CancellationToken cancellationToken)
    {
        await gate.WaitAsync(cancellationToken);
        try
        {
            await StopAsync();
            startupErrors.Clear();
            uiPort = FindFreePort(settings.PreferredUiPort);
            cobaltPort = FindFreePort(settings.PreferredCobaltPort);
            lanAccessReady = EnsureLanAccess(uiPort);
            await StartCobaltAsync(cancellationToken);
            await StartServerAsync(cancellationToken);
            serverReady = true;
            started = true;
            return true;
        }
        finally
        {
            gate.Release();
        }
    }

    public async Task<bool> RefreshLanAccessAsync()
    {
        if (!started || uiPort <= 0) return false;
        var ready = EnsureLanAccess(uiPort);
        try
        {
            using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
            using var response = await client.PostAsync(
                $"{AppUrl}/api/lan-access",
                new StringContent(
                    JsonSerializer.Serialize(new { ready }),
                    Encoding.UTF8,
                    "application/json"));
            if (response.IsSuccessStatusCode) lanAccessReady = ready;
        }
        catch
        {
            // The native menus still reflect the firewall result. The web
            // endpoint is best-effort if the local server is mid-restart.
        }
        return lanAccessReady;
    }

    public async ValueTask DisposeAsync()
    {
        await StopAsync();
        gate.Dispose();
        job?.Dispose();
    }

    private async Task StartCobaltAsync(CancellationToken cancellationToken)
    {
        // Pass per-launch settings directly; cached application resources stay immutable.
        var env = new Dictionary<string, string?>
        {
            ["API_URL"] = $"http://127.0.0.1:{cobaltPort}/",
            ["API_PORT"] = cobaltPort.ToString(),
            ["API_LISTEN_ADDRESS"] = "127.0.0.1",
            ["CORS_WILDCARD"] = "1",
            ["RATELIMIT_WINDOW"] = "60",
            ["RATELIMIT_MAX"] = "200",
            ["TUNNEL_RATELIMIT_WINDOW"] = "60",
            ["TUNNEL_RATELIMIT_MAX"] = "80",
            ["DURATION_LIMIT"] = "10800",
            ["FFMPEG_BIN"] = paths.Ffmpeg,
            ["FFMPEG_PATH"] = paths.Ffmpeg,
        };
        AddSystemProxy(env);
        var process = Start(paths.Node, $"\"{paths.CobaltEntry}\"", paths.CobaltWorkingDirectory, paths.CobaltLog, paths.CobaltErrorLog, env);
        processes.Add(process);
        var deadline = DateTime.UtcNow.AddSeconds(30);
        while (DateTime.UtcNow < deadline)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (process.HasExited)
                throw new InvalidOperationException($"cobalt API 启动失败：{Tail(paths.CobaltErrorLog)}");
            if (await IsCobaltReadyAsync(cancellationToken)) return;
            await Task.Delay(250, cancellationToken);
        }
        throw new TimeoutException("cobalt API 启动超过 30 秒，请查看日志。");
    }

    public async Task<(bool Online, string Version, int Services)> GetHealthAsync(CancellationToken cancellationToken)
    {
        if (!serverReady) return (false, "", 0);
        try
        {
            using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
            using var response = await client.GetAsync($"{AppUrl}/api/bootstrap", cancellationToken);
            if (!response.IsSuccessStatusCode) return (false, "", 0);
            await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
            using var json = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
            var cobalt = json.RootElement.GetProperty("cobalt");
            return (
                cobalt.TryGetProperty("online", out var online) && online.GetBoolean(),
                cobalt.TryGetProperty("version", out var version) ? version.GetString() ?? "" : "",
                cobalt.TryGetProperty("services", out var services) ? services.GetInt32() : 0);
        }
        catch
        {
            return (false, "", 0);
        }
    }

    private async Task StartServerAsync(CancellationToken cancellationToken)
    {
        // server.mjs listens on all interfaces, so binding loopback is not
        // enough to prove the preferred port is available.
        if (!IsPortFreeOnAny(uiPort)) uiPort = FindFreePort(0);
        // Always verify the exact port the server will bind. The first check
        // happens before cobalt starts, but a port can become occupied in
        // between and this final check must remain authoritative.
        lanAccessReady = EnsureLanAccess(uiPort);
        var env = new Dictionary<string, string?>
        {
            ["HOST"] = "0.0.0.0",
            ["PORT"] = uiPort.ToString(),
            ["COBALT_API_URL"] = $"http://127.0.0.1:{cobaltPort}/",
            ["APP_ROOT"] = paths.Root,
            ["APP_DATA_DIR"] = paths.DataDirectory,
            ["APP_PORTABLE"] = "1",
            ["FFMPEG_PATH"] = paths.Ffmpeg,
            ["LAN_ACCESS_READY"] = lanAccessReady ? "1" : "0",
        };
        // Undici only reads HTTP_PROXY/HTTPS_PROXY when this Node switch is
        // enabled. Respect the user's proxy for media CDNs while keeping the
        // loopback cobalt endpoint in NO_PROXY.
        var process = Start(paths.Node, $"--use-env-proxy \"{paths.Server}\"", paths.Root, paths.ServerLog, paths.ServerErrorLog, env);
        processes.Add(process);
        var deadline = DateTime.UtcNow.AddSeconds(20);
        while (DateTime.UtcNow < deadline)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (process.HasExited)
                throw new InvalidOperationException($"Web 服务启动失败：{Tail(paths.ServerErrorLog)}");
            if (await IsServerReadyAsync(cancellationToken)) return;
            await Task.Delay(200, cancellationToken);
        }
        throw new TimeoutException("Web 服务启动超过 20 秒，请查看日志。");
    }

    private bool EnsureLanAccess(int port)
    {
        if (FirewallManager.RuleCoversProgram(paths.Node, port) &&
            FirewallManager.HasSingleCurrentRule(paths.Node, port))
        {
            return true;
        }
        return FirewallManager.EnsurePrivateRule(paths.Node, paths.LogDirectory, port);
    }

    private Process Start(
        string file,
        string arguments,
        string workingDirectory,
        string outputLog,
        string errorLog,
        IReadOnlyDictionary<string, string?> environment)
    {
        var info = new ProcessStartInfo(file, arguments)
        {
            WorkingDirectory = workingDirectory,
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        foreach (var pair in environment) info.Environment[pair.Key] = pair.Value;
        // Explicitly opt into Node's environment-proxy support. This keeps
        // downloads working when the user's HTTP_PROXY is inherited by the
        // desktop app, including Node versions where fetch() ignores it.
        info.Environment["NODE_USE_ENV_PROXY"] = "1";
        var inheritedPath = info.Environment.TryGetValue("PATH", out var existingPath) ? existingPath : "";
        info.Environment["PATH"] = $"{Path.GetDirectoryName(paths.Ffmpeg)};{Path.GetDirectoryName(paths.Node)};{inheritedPath}";

        var process = new Process { StartInfo = info, EnableRaisingEvents = true };
        process.OutputDataReceived += (_, e) => Append(outputLog, e.Data);
        process.ErrorDataReceived += (_, e) => Append(errorLog, e.Data);
        process.EnableRaisingEvents = true;
        process.Exited += (_, _) =>
        {
            if (stopping) return;
            try
            {
                Append(errorLog, $"[supervisor] process exited unexpectedly ({process.ExitCode})");
                ProcessFailed?.Invoke(this, EventArgs.Empty);
            }
            catch { }
        };
        if (!process.Start()) throw new InvalidOperationException($"进程启动失败：{file}");
        if (job is null) throw new InvalidOperationException("下载服务未准备好。");
        try
        {
            job.Assign(process);
        }
        catch
        {
            try { process.Kill(entireProcessTree: true); } catch { }
            throw;
        }
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        return process;
    }

    private static void AddSystemProxy(IDictionary<string, string?> environment)
    {
        if (!string.IsNullOrWhiteSpace(environment.TryGetValue("HTTP_PROXY", out var existingProxy) ? existingProxy : null))
            return;

        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(
                @"Software\Microsoft\Windows\CurrentVersion\Internet Settings");
            if (key?.GetValue("ProxyEnable") is not int enabled || enabled == 0)
                return;
            var server = key.GetValue("ProxyServer") as string;
            if (string.IsNullOrWhiteSpace(server))
                return;
            var proxy = server.Contains('=')
                ? server.Split(';', StringSplitOptions.RemoveEmptyEntries)
                    .Select(value => value.Split('=', 2))
                    .FirstOrDefault(parts => parts.Length == 2 &&
                        (parts[0].Equals("http", StringComparison.OrdinalIgnoreCase) ||
                         parts[0].Equals("https", StringComparison.OrdinalIgnoreCase)))
                    ?[1]
                : server;
            if (string.IsNullOrWhiteSpace(proxy))
                return;
            if (!proxy.Contains("://", StringComparison.Ordinal))
                proxy = $"http://{proxy}";
            environment["HTTP_PROXY"] = proxy;
            environment["HTTPS_PROXY"] = proxy;
        }
        catch
        {
            // Proxy discovery is best-effort. Downloads still work without it.
        }
    }

    private async Task<bool> IsCobaltReadyAsync(CancellationToken cancellationToken)
    {
        try
        {
            using var client = new HttpClient { Timeout = TimeSpan.FromMilliseconds(900) };
            using var request = new HttpRequestMessage(HttpMethod.Get, $"http://127.0.0.1:{cobaltPort}/");
            request.Headers.Accept.ParseAdd("application/json");
            using var response = await client.SendAsync(request, cancellationToken);
            return response.IsSuccessStatusCode;
        }
        catch { return false; }
    }

    private async Task<bool> IsServerReadyAsync(CancellationToken cancellationToken)
    {
        try
        {
            using var client = new HttpClient { Timeout = TimeSpan.FromMilliseconds(900) };
            using var response = await client.GetAsync($"http://127.0.0.1:{uiPort}/api/health", cancellationToken);
            return response.IsSuccessStatusCode;
        }
        catch { return false; }
    }

    private static int FindFreePort(int preferred)
    {
        if (preferred > 0 && IsPortFreeOnAny(preferred)) return preferred;
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        try { return ((IPEndPoint)listener.LocalEndpoint).Port; }
        finally { listener.Stop(); }
    }

    private static bool IsPortFreeOnAny(int port)
    {
        // Windows can allow an Any bind even while another process listens on
        // loopback, so first consult listeners across every local address.
        if (IPGlobalProperties.GetIPGlobalProperties().GetActiveTcpListeners().Any(endpoint => endpoint.Port == port))
            return false;

        var listener = new TcpListener(IPAddress.Any, port);
        try
        {
            listener.Start();
            return true;
        }
        catch (SocketException)
        {
            return false;
        }
        finally
        {
            listener.Stop();
        }
    }

    private static void Append(string path, string? line)
    {
        if (string.IsNullOrEmpty(line)) return;
        try
        {
            File.AppendAllText(path, $"{DateTime.Now:HH:mm:ss} {line}{Environment.NewLine}");
        }
        catch { }
    }

    private static string Tail(string file)
    {
        try
        {
            if (!File.Exists(file)) return "没有错误日志";
            var lines = File.ReadAllLines(file);
            return string.Join(Environment.NewLine, lines.TakeLast(12));
        }
        catch { return "无法读取错误日志"; }
    }
}
