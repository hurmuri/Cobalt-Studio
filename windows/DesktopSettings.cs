using System.Text.Json;

namespace CobaltStudio.Desktop;

internal sealed class DesktopSettings
{
    public bool CloseToTray { get; set; } = true;
    public bool StartWithWindows { get; set; }
    public bool LaunchMinimized { get; set; }
    public int PreferredUiPort { get; set; } = 8787;
    public int PreferredCobaltPort { get; set; } = 9000;
    public int WindowWidth { get; set; } = 1280;
    public int WindowHeight { get; set; } = 860;
    public bool Maximized { get; set; }

    public static DesktopSettings Load(string file)
    {
        try
        {
            if (File.Exists(file))
                return JsonSerializer.Deserialize<DesktopSettings>(File.ReadAllText(file)) ?? new DesktopSettings();
        }
        catch { }
        return new DesktopSettings();
    }

    public void Save(string file)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        File.WriteAllText(file, JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true }));
    }
}
