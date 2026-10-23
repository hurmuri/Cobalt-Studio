using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Runtime.InteropServices;

namespace CobaltStudio.Desktop;

internal sealed class SingleInstance : IDisposable
{
    private readonly Mutex mutex;
    private readonly string wakeEventName;
    private EventWaitHandle? wakeEvent;
    private CancellationTokenSource? cancellation;
    private Form? targetForm;
    private bool ownsMutex;

    private SingleInstance(Mutex mutex, string wakeEventName, bool ownsMutex)
    {
        this.mutex = mutex;
        this.wakeEventName = wakeEventName;
        this.ownsMutex = ownsMutex;
    }

    public bool IsPrimary => ownsMutex;

    public static SingleInstance Create()
    {
        var identity = Environment.GetEnvironmentVariable("COBALT_STUDIO_DATA_DIR") ?? AppContext.BaseDirectory;
        var id = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(Path.GetFullPath(identity).ToUpperInvariant())))[..16];
        var mutexName = $"Local\\CobaltStudio.{id}";
        var eventName = $"Local\\CobaltStudio.Wake.{id}";
        var mutex = new Mutex(true, mutexName, out var created);
        return new SingleInstance(mutex, eventName, created);
    }

    public bool NotifyPrimary()
    {
        try
        {
            using var handle = EventWaitHandle.OpenExisting(wakeEventName);
            handle.Set();
            return true;
        }
        catch
        {
            return false;
        }
    }

    public void Listen(Action onActivate)
    {
        if (!ownsMutex) return;
        wakeEvent = new EventWaitHandle(false, EventResetMode.AutoReset, wakeEventName);
        cancellation = new CancellationTokenSource();
        var cancellationToken = cancellation.Token;
        _ = Task.Run(() =>
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                try
                {
                    wakeEvent.WaitOne();
                    if (!cancellationToken.IsCancellationRequested) ActivateForm(onActivate, cancellationToken);
                }
                catch (ObjectDisposedException) { break; }
                catch (AbandonedMutexException) { }
                catch { }
            }
        }, cancellationToken);
    }

    public void Attach(Form form) => targetForm = form;

    private void ActivateForm(Action fallback, CancellationToken cancellationToken)
    {
        var form = targetForm;
        if (form is null || form.IsDisposed)
        {
            fallback();
            return;
        }
        if (!form.IsHandleCreated) return;
        PostActivate(form);
    }

    private static void PostActivate(Form form)
    {
        try
        {
            if (form.IsDisposed) return;
            PostMessage(form.Handle, WM_APP_ACTIVATE, IntPtr.Zero, IntPtr.Zero);
        }
        catch (ObjectDisposedException) { }
    }

    private const uint WM_APP_ACTIVATE = 0x8000 + 1;

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    public void Dispose()
    {
        cancellation?.Cancel();
        try { wakeEvent?.Set(); } catch { }
        wakeEvent?.Dispose();
        cancellation?.Dispose();
        if (ownsMutex)
        {
            try { mutex.ReleaseMutex(); } catch { }
            ownsMutex = false;
        }
        mutex.Dispose();
    }
}
