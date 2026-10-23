using System.Runtime.InteropServices;

namespace CobaltStudio.Desktop;

internal static class IconFactory
{
    public static Icon Create()
    {
        using var bitmap = new Bitmap(64, 64);
        using (var g = Graphics.FromImage(bitmap))
        {
            g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            g.Clear(Color.Transparent);
            using var background = new SolidBrush(Color.FromArgb(16, 34, 29));
            using var accent = new SolidBrush(Color.FromArgb(241, 182, 80));
            using var rounded = new System.Drawing.Drawing2D.GraphicsPath();
            const float radius = 14f;
            rounded.AddArc(0, 0, radius * 2, radius * 2, 180, 90);
            rounded.AddArc(64 - radius * 2, 0, radius * 2, radius * 2, 270, 90);
            rounded.AddArc(64 - radius * 2, 64 - radius * 2, radius * 2, radius * 2, 0, 90);
            rounded.AddArc(0, 64 - radius * 2, radius * 2, radius * 2, 90, 90);
            rounded.CloseFigure();
            g.FillPath(background, rounded);
            g.FillRectangle(accent, 20, 15, 9, 34);
            g.FillRectangle(accent, 35, 15, 9, 13);
            g.FillRectangle(accent, 35, 34, 9, 15);
        }
        var handle = bitmap.GetHicon();
        try { return Icon.FromHandle(handle).Clone() as Icon ?? SystemIcons.Application; }
        finally { DestroyIcon(handle); }
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool DestroyIcon(IntPtr handle);
}
