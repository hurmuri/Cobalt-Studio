using System.Drawing.Drawing2D;

namespace CobaltStudio.Desktop;

internal sealed class ToastWindow : Form
{
    private readonly System.Windows.Forms.Timer timer;

    public ToastWindow(string title, string message)
    {
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        BackColor = Color.FromArgb(16, 34, 29);
        Size = new Size(360, 104);
        Padding = new Padding(18);
        DoubleBuffered = true;

        var heading = new Label
        {
            Text = title,
            ForeColor = Color.FromArgb(244, 239, 227),
            Font = new Font("Microsoft YaHei UI", 10, FontStyle.Bold),
            AutoSize = false,
            Dock = DockStyle.Top,
            Height = 25,
        };
        var body = new Label
        {
            Text = message,
            ForeColor = Color.FromArgb(185, 196, 189),
            Font = new Font("Microsoft YaHei UI", 9),
            AutoSize = false,
            Dock = DockStyle.Fill,
            AutoEllipsis = true,
        };
        var accent = new Panel { BackColor = Color.FromArgb(239, 179, 75), Dock = DockStyle.Left, Width = 4 };
        Controls.Add(body);
        Controls.Add(heading);
        Controls.Add(accent);

        var screen = Screen.PrimaryScreen?.WorkingArea ?? new Rectangle(0, 0, 1920, 1080);
        Location = new Point(screen.Right - Width - 22, screen.Bottom - Height - 22);
        timer = new System.Windows.Forms.Timer { Interval = 4200 };
        timer.Tick += (_, _) => Close();
        Opacity = 0;
    }

    protected override void OnShown(EventArgs e)
    {
        base.OnShown(e);
        var fade = new System.Windows.Forms.Timer { Interval = 18 };
        fade.Tick += (_, _) =>
        {
            Opacity = Math.Min(1, Opacity + 0.12);
            if (Opacity >= 1) fade.Stop();
        };
        fade.Start();
        timer.Start();
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        using var pen = new Pen(Color.FromArgb(70, 244, 239, 227));
        e.Graphics.DrawRectangle(pen, 0, 0, Width - 1, Height - 1);
    }
}
