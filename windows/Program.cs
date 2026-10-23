using CobaltStudio.Desktop;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        using var singleInstance = SingleInstance.Create();
        if (!singleInstance.IsPrimary)
        {
            singleInstance.NotifyPrimary();
            return;
        }
        var form = new MainForm();
        singleInstance.Attach(form);
        singleInstance.Listen(() =>
        {
            if (!form.IsHandleCreated || form.IsDisposed) return;
            form.BeginInvoke(form.ShowFromTray);
        });
        Application.Run(form);
    }
}
