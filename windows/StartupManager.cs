using Microsoft.Win32;

namespace CobaltStudio.Desktop;

internal static class StartupManager
{
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string ValueName = "Cobalt Studio";

    public static bool IsEnabled()
    {
        using var key = Registry.CurrentUser.OpenSubKey(RunKey, false);
        return key?.GetValue(ValueName) is string value && !string.IsNullOrWhiteSpace(value);
    }

    public static void Set(bool enabled, string executable)
    {
        using var key = Registry.CurrentUser.CreateSubKey(RunKey, true);
        if (enabled)
            key.SetValue(ValueName, $"\"{executable}\" --minimized");
        else
            key.DeleteValue(ValueName, false);
    }
}
