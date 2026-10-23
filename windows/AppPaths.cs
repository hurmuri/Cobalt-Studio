namespace CobaltStudio.Desktop;

internal sealed class AppPaths
{
    public required string Root { get; init; }
    public required string Node { get; init; }
    public required string Server { get; init; }
    public required string CobaltEntry { get; init; }
    public required string CobaltWorkingDirectory { get; init; }
    public required string Ffmpeg { get; init; }
    public required string DataDirectory { get; init; }
    public required string LogDirectory { get; init; }
    public required string SettingsFile { get; init; }
    public required string WebViewData { get; init; }
    public required string ServerLog { get; init; }
    public required string ServerErrorLog { get; init; }
    public required string CobaltLog { get; init; }
    public required string CobaltErrorLog { get; init; }

    public static AppPaths Discover()
    {
        var root = FindRoot();
        var cobaltDirectory = Path.Combine(root, "cobalt-api", "api");
        var data = Path.Combine(root, ".data");
        if (IsInstalledLocation(root))
            data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Cobalt Studio");
        var dataOverride = Environment.GetEnvironmentVariable("COBALT_STUDIO_DATA_DIR");
        if (!string.IsNullOrWhiteSpace(dataOverride)) data = Path.GetFullPath(dataOverride);
        var logs = Path.Combine(data, "logs");
        Directory.CreateDirectory(data);
        Directory.CreateDirectory(logs);
        return new AppPaths
        {
            Root = root,
            Node = FindNode(root),
            Server = Path.Combine(root, "server.mjs"),
            CobaltEntry = Path.Combine(cobaltDirectory, "src", "cobalt.js"),
            CobaltWorkingDirectory = cobaltDirectory,
            Ffmpeg = FindFfmpeg(root, cobaltDirectory),
            DataDirectory = data,
            LogDirectory = logs,
            SettingsFile = Path.Combine(data, "desktop.json"),
            WebViewData = Path.Combine(data, "webview2"),
            ServerLog = Path.Combine(logs, "server.log"),
            ServerErrorLog = Path.Combine(logs, "server-error.log"),
            CobaltLog = Path.Combine(logs, "cobalt.log"),
            CobaltErrorLog = Path.Combine(logs, "cobalt-error.log"),
        };
    }

    public void Validate()
    {
        RequireFile(Node, "Node.js 运行时");
        RequireFile(Server, "Cobalt Studio 服务端");
        RequireFile(CobaltEntry, "cobalt API");
        RequireFile(Ffmpeg, "ffmpeg");
        if (!Directory.Exists(Path.Combine(CobaltWorkingDirectory, "node_modules")))
            throw new DirectoryNotFoundException($"cobalt API 依赖缺失：{Path.Combine(CobaltWorkingDirectory, "node_modules")}");
    }

    private static string FindRoot()
    {
        var env = Environment.GetEnvironmentVariable("COBALT_STUDIO_ROOT");
        if (!string.IsNullOrWhiteSpace(env) && File.Exists(Path.Combine(env, "server.mjs")))
            return Path.GetFullPath(env);

        // A single-file host may not expose the package directory through
        // AppContext.BaseDirectory, so the process image is authoritative.
        var processDirectory = Path.GetDirectoryName(Environment.ProcessPath);
        if (!string.IsNullOrWhiteSpace(processDirectory))
        {
            var processRoot = LookupRoot(processDirectory);
            if (processRoot is not null) return processRoot;
        }

        var baseDirectory = LookupRoot(AppContext.BaseDirectory);
        if (baseDirectory is not null) return baseDirectory;

        foreach (var start in new[] { Environment.CurrentDirectory })
        {
            var dir = new DirectoryInfo(start);
            while (dir is not null)
            {
                var candidate = LookupRoot(dir.FullName);
                if (candidate is not null) return candidate;
                dir = dir.Parent;
            }
        }
        throw new DirectoryNotFoundException("找不到应用资源目录。请将客户端放在 Cobalt Studio 文件夹内运行。");
    }

    private static string? LookupRoot(string start)
    {
        var dir = new DirectoryInfo(start);
        while (dir is not null)
        {
            if (File.Exists(Path.Combine(dir.FullName, "Cobalt Studio.exe")) &&
                File.Exists(Path.Combine(dir.FullName, "server.mjs")) &&
                File.Exists(Path.Combine(dir.FullName, "cobalt-api", "api", "package.json")))
                return dir.FullName;
            dir = dir.Parent;
        }
        return null;
    }

    private static bool IsInstalledLocation(string root)
    {
        var normalized = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        var programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        var programFilesX86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
        return (!string.IsNullOrWhiteSpace(programFiles) &&
                normalized.StartsWith(Path.GetFullPath(programFiles).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) ||
               (!string.IsNullOrWhiteSpace(programFilesX86) &&
                normalized.StartsWith(Path.GetFullPath(programFilesX86).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase));
    }

    private static string FindNode(string root)
    {
        var candidates = new[]
        {
            Path.Combine(root, "runtime", "node.exe"),
            Path.Combine(AppContext.BaseDirectory, "runtime", "node.exe"),
            Environment.GetEnvironmentVariable("COBALT_STUDIO_NODE"),
        };
        foreach (var candidate in candidates)
        {
            if (!string.IsNullOrWhiteSpace(candidate) && File.Exists(candidate))
                return candidate;
        }
        var path = (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator)
            .Select(part => Path.Combine(part.Trim(), "node.exe"))
            .FirstOrDefault(File.Exists);
        return path ?? throw new FileNotFoundException("找不到 node.exe。请安装 Node.js 20+ 或打包 runtime/node.exe。");
    }

    private static string FindFfmpeg(string root, string cobaltDirectory)
    {
        var candidates = new[]
        {
            Path.Combine(root, "runtime", "ffmpeg.exe"),
            Path.Combine(AppContext.BaseDirectory, "runtime", "ffmpeg.exe"),
            Environment.GetEnvironmentVariable("FFMPEG_PATH"),
            Path.Combine(cobaltDirectory, "node_modules", "ffmpeg-static", "ffmpeg.exe"),
        };
        foreach (var candidate in candidates)
        {
            if (!string.IsNullOrWhiteSpace(candidate) && File.Exists(candidate))
                return candidate;
        }
        var path = Environment.GetEnvironmentVariable("PATH")?.Split(Path.PathSeparator)
            .Select(part => Path.Combine(part.Trim(), "ffmpeg.exe"))
            .FirstOrDefault(File.Exists);
        return path ?? throw new FileNotFoundException("找不到 ffmpeg.exe。");
    }

    private static void RequireFile(string file, string label)
    {
        if (!File.Exists(file)) throw new FileNotFoundException($"{label}不存在：{file}");
    }
}
