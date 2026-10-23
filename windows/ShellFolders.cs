using System.Runtime.InteropServices;

namespace CobaltStudio.Desktop;

internal static class ShellFolders
{
    public static Task OpenAsync(string target, bool selectFile = false)
    {
        var completion = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var thread = new Thread(() =>
        {
            IntPtr folder = IntPtr.Zero;
            IntPtr file = IntPtr.Zero;
            try
            {
                var fullPath = Path.GetFullPath(target);
                var directory = selectFile ? Path.GetDirectoryName(fullPath)! : fullPath;
                if (!selectFile) Directory.CreateDirectory(directory);
                Marshal.ThrowExceptionForHR(SHParseDisplayName(directory, IntPtr.Zero, out folder, 0, out _));
                if (selectFile)
                {
                    Marshal.ThrowExceptionForHR(SHParseDisplayName(fullPath, IntPtr.Zero, out file, 0, out _));
                    Marshal.ThrowExceptionForHR(SHOpenFolderAndSelectItems(folder, 1, [ILFindLastID(file)], 0));
                }
                else Marshal.ThrowExceptionForHR(SHOpenFolderAndSelectItems(folder, 0, null, 0));
                completion.SetResult();
            }
            catch (Exception error) { completion.SetException(error); }
            finally
            {
                if (file != IntPtr.Zero) Marshal.FreeCoTaskMem(file);
                if (folder != IntPtr.Zero) Marshal.FreeCoTaskMem(folder);
            }
        }) { IsBackground = true, Name = "Cobalt folder shell" };
        // Shell COM operations belong on an STA, away from the WebView UI thread.
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        return completion.Task;
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SHParseDisplayName(string name, IntPtr context, out IntPtr item, uint attributes, out uint result);

    [DllImport("shell32.dll")]
    private static extern int SHOpenFolderAndSelectItems(IntPtr folder, uint count, [In] IntPtr[]? items, uint flags);

    [DllImport("shell32.dll")]
    private static extern IntPtr ILFindLastID(IntPtr item);
}
