using System.Diagnostics;
using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        using var progress = new Form
        {
            Text = "Cobalt Studio", Width = 420, Height = 140,
            StartPosition = FormStartPosition.CenterScreen,
            FormBorderStyle = FormBorderStyle.FixedDialog,
            MaximizeBox = false, MinimizeBox = false, ControlBox = false
        };
        progress.Controls.Add(new Label { Text = "正在准备运行环境，首次启动需要片刻…", AutoSize = true, Left = 22, Top = 20 });
        progress.Controls.Add(new ProgressBar { Style = ProgressBarStyle.Marquee, Left = 22, Top = 55, Width = 360 });
        progress.Shown += async (_, _) =>
        {
            try
            {
                var home = Path.GetFullPath(Environment.GetEnvironmentVariable("COBALT_STANDALONE_HOME") ??
                    Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Cobalt Studio"));
                var runtime = await Task.Run(() => PrepareRuntime(home));
                var start = new ProcessStartInfo(Path.Combine(runtime, "Cobalt Studio.exe"))
                {
                    WorkingDirectory = runtime, UseShellExecute = false
                };
                start.Environment["COBALT_STUDIO_ROOT"] = runtime;
                start.Environment["COBALT_STUDIO_DATA_DIR"] = Path.Combine(home, "data");
                using var child = Process.Start(start) ?? throw new IOException("无法启动客户端。");
                progress.Hide();
                await child.WaitForExitAsync();
            }
            catch (Exception error)
            {
                try
                {
                    var home = Environment.GetEnvironmentVariable("COBALT_STANDALONE_HOME") ??
                        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Cobalt Studio");
                    Directory.CreateDirectory(home);
                    File.AppendAllText(Path.Combine(home, "launcher.log"), DateTimeOffset.Now + " " + error + Environment.NewLine);
                }
                catch { }
                MessageBox.Show(error.Message, "Cobalt Studio 启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
                Environment.ExitCode = 1;
            }
            finally { progress.Close(); }
        };
        Application.Run(progress);
    }

    private static string PrepareRuntime(string home)
    {
        var assembly = Assembly.GetExecutingAssembly();
        using var hashResource = assembly.GetManifestResourceStream("payload.sha256") ?? throw new IOException("缺少内置校验数据。");
        using var reader = new StreamReader(hashResource);
        var hash = reader.ReadToEnd().Trim();
        if (hash.Length != 64 || !hash.All(Uri.IsHexDigit)) throw new IOException("内置校验数据无效。");
        var version = assembly.GetName().Version?.ToString(3) ?? "unknown";
        var runtimes = Path.Combine(home, "runtimes");
        Directory.CreateDirectory(runtimes);
        var runtime = Path.Combine(runtimes, version + "-" + hash[..16]);
        using var mutex = new Mutex(false, "Local\\CobaltStudio.Extract." + hash[..24]);
        try { mutex.WaitOne(); } catch (AbandonedMutexException) { }
        try
        {
            if (IsComplete(runtime, hash)) return runtime;
            var temporary = runtime + ".tmp-" + Guid.NewGuid().ToString("N");
            Directory.CreateDirectory(temporary);
            try
            {
                var payload = Path.Combine(temporary, "payload.zip");
                using (var resource = assembly.GetManifestResourceStream("payload.zip") ?? throw new IOException("缺少内置运行环境。"))
                using (var output = File.Create(payload)) resource.CopyTo(output);
                using (var input = File.OpenRead(payload))
                    if (!Convert.ToHexString(SHA256.HashData(input)).Equals(hash, StringComparison.OrdinalIgnoreCase))
                        throw new IOException("运行环境校验失败，请重新获取 EXE。");
                ZipFile.ExtractToDirectory(payload, temporary);
                File.Delete(payload);
                var files = Directory.EnumerateFiles(temporary, "*", SearchOption.AllDirectories)
                    .Select(file => new CachedFile(Path.GetRelativePath(temporary, file), new FileInfo(file).Length)).ToArray();
                File.WriteAllText(Path.Combine(temporary, ".complete.json"), JsonSerializer.Serialize(new CacheManifest(hash, files)));
                if (Directory.Exists(runtime)) DeleteRuntime(runtime);
                Directory.Move(temporary, runtime);
                return runtime;
            }
            finally { if (Directory.Exists(temporary)) DeleteRuntime(temporary); }
        }
        finally { mutex.ReleaseMutex(); }
    }

    private static bool IsComplete(string runtime, string hash)
    {
        try
        {
            var manifest = JsonSerializer.Deserialize<CacheManifest>(File.ReadAllText(Path.Combine(runtime, ".complete.json")));
            return manifest?.Hash == hash && manifest.Files.Length > 0 && manifest.Files.All(entry =>
            {
                var file = new FileInfo(Path.Combine(runtime, entry.Path));
                return file.Exists && file.Length == entry.Bytes;
            });
        }
        catch { return false; }
    }

    private static void DeleteRuntime(string path)
    {
        foreach (var file in Directory.EnumerateFiles(path, "*", SearchOption.AllDirectories))
            File.SetAttributes(file, FileAttributes.Normal);
        Directory.Delete(path, true);
    }

    private sealed record CachedFile(string Path, long Bytes);
    private sealed record CacheManifest(string Hash, CachedFile[] Files);
}
