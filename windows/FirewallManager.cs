using System.Diagnostics;

namespace CobaltStudio.Desktop;

internal static class FirewallManager
{
    private const string RuleName = "Cobalt Studio LAN";

    public static bool EnsurePrivateRule(string nodePath, string logDirectory, int port = 0)
    {
        if (RuleCoversProgram(nodePath, port) && HasSingleCurrentRule(nodePath, port))
            return true;
        if (IsTestMode()) return false;
        try
        {
            var program = Path.GetFullPath(nodePath);
            var portClause = port > 0 ? $" localport={port}" : "";
            var rule = $"netsh advfirewall firewall add rule name=\"{RuleName}\" dir=in action=allow protocol=TCP{portClause} program=\"{program}\" profile=private enable=yes";
            var startInfo = new ProcessStartInfo("powershell.exe")
            {
                UseShellExecute = true,
                Verb = "runas",
                WindowStyle = ProcessWindowStyle.Hidden,
                ArgumentList =
                {
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    BuildElevatedCommand(rule),
                },
            };
            using var process = Process.Start(startInfo);
            if (process is null) return false;
            if (!process.WaitForExit(20_000))
            {
                try { process.Kill(entireProcessTree: true); } catch { }
                WriteLog(logDirectory, "Firewall helper timed out.");
                return false;
            }
            var success = process.ExitCode == 0 &&
                          RuleCoversProgram(nodePath, port) &&
                          HasSingleCurrentRule(nodePath, port);
            if (!success) WriteLog(logDirectory, $"Firewall helper exited with {process.ExitCode}.");
            return success;
        }
        catch (Exception error)
        {
            WriteLog(logDirectory, $"Firewall rule was not added: {error.Message}");
            return false;
        }
    }

    public static bool RuleCoversProgram(string nodePath, int port)
    {
        var normalizedProgram = Path.GetFullPath(nodePath);
        for (var attempt = 0; attempt < 5; attempt++)
        {
            if (QueryStructuredRule(normalizedProgram, port)) return true;
            if (attempt < 4) Thread.Sleep(200);
        }
        return false;
    }

    public static bool HasSingleCurrentRule(string normalizedProgram, int port)
    {
        try
        {
            var policyType = Type.GetTypeFromProgID("HNetCfg.FwPolicy2");
            if (policyType is null) return false;
            dynamic policy = Activator.CreateInstance(policyType)!;
            var matching = 0;
            var total = 0;
            foreach (var candidate in policy.Rules)
            {
                if (!string.Equals((string)candidate.Name, RuleName, StringComparison.OrdinalIgnoreCase))
                    continue;
                total += 1;
                if (!(bool)candidate.Enabled) continue;
                if (Convert.ToInt32(candidate.Direction) != 1) continue;
                if (Convert.ToInt32(candidate.Action) != 1) continue;
                if ((Convert.ToInt32(candidate.Profiles) & 2) == 0) continue;
                if (Convert.ToInt32(candidate.Protocol) != 6) continue;
                if (!string.Equals((string)candidate.ApplicationName, normalizedProgram, StringComparison.OrdinalIgnoreCase))
                    continue;
                if (port > 0 && !PortsContain(candidate.LocalPorts, port)) continue;
                matching += 1;
            }
            return total == 1 && matching == 1;
        }
        catch
        {
            return false;
        }
    }

    private static bool PortsContain(object? configured, int port)
    {
        var ports = Convert.ToString(configured) ?? "";
        foreach (var value in ports.Split(',', StringSplitOptions.RemoveEmptyEntries))
        {
            if (value.Trim() == port.ToString()) return true;
        }
        return false;
    }

    private static bool QueryStructuredRule(string normalizedProgram, int port)
    {
        try
        {
            // netsh's output encoding changes with the Windows display
            // language, so it cannot prove the program path on every system.
            // The firewall COM API returns structured values independent of
            // the console code page and works without elevation for reads.
            var policyType = Type.GetTypeFromProgID("HNetCfg.FwPolicy2");
            if (policyType is null) return false;
            dynamic policy = Activator.CreateInstance(policyType)!;
            foreach (var candidate in policy.Rules)
            {
                if (!string.Equals((string)candidate.Name, RuleName, StringComparison.OrdinalIgnoreCase))
                    continue;
                if (!(bool)candidate.Enabled) continue;
                // 1 = inbound, 1 = allow, 6 = TCP. Profiles is a mask.
                if (Convert.ToInt32(candidate.Direction) != 1) continue;
                if (Convert.ToInt32(candidate.Action) != 1) continue;
                if ((Convert.ToInt32(candidate.Profiles) & 2) == 0) continue;
                if (Convert.ToInt32(candidate.Protocol) != 6) continue;
                if (!string.Equals((string)candidate.ApplicationName, normalizedProgram, StringComparison.OrdinalIgnoreCase))
                    continue;
                if (port <= 0) return true;
                if (PortsContain(candidate.LocalPorts, port)) return true;
            }
            return false;
        }
        catch
        {
            return false;
        }
    }

    private static bool IsTestMode()
    {
        return Environment.GetEnvironmentVariable("COBALT_UI_TEST_RELEASE") == "1" ||
               Environment.GetEnvironmentVariable("COBALT_STUDIO_SKIP_FIREWALL") == "1";
    }

    private static string BuildElevatedCommand(string addRule)
    {
        // Delete and re-create in one elevated process. Starting two elevated
        // processes causes two UAC prompts and can leave a stale rule if the
        // second prompt is canceled.
        var escapedName = RuleName.Replace("'", "''");
        return string.Join("; ", new[]
        {
            "$policy = New-Object -ComObject HNetCfg.FwPolicy2",
            "$rules = @($policy.Rules | Where-Object { $_.Name -eq '" + escapedName + "' })",
            "foreach ($rule in $rules) { $policy.Rules.Remove($rule.Name) }",
            addRule,
        });
    }

    private static void WriteLog(string directory, string message)
    {
        try
        {
            Directory.CreateDirectory(directory);
            File.AppendAllText(
                Path.Combine(directory, "firewall.log"),
                $"{DateTime.Now:HH:mm:ss} {message}{Environment.NewLine}");
        }
        catch { }
    }

}
