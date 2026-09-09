param(
  [Parameter(Mandatory = $true)]
  [string]$TitleMarker
)

# ChatGPT Archive 的 Guardian 需要和用户日常 Chrome 共用同一个 browser process/profile，
# 但它不应该出现在任务栏/Alt-Tab 里。Chrome DevTools Protocol 只能最小化窗口，不能真正
# 从桌面 Shell 隐藏顶层 HWND，因此这里用一次性的 Win32 ShowWindowAsync(SW_HIDE)。
# PowerShell 只在 Guardian 创建/接管时运行几百毫秒，随后立即退出，不形成第二个常驻进程。

$typeDefinition = @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class ChatGptArchiveWindowHider
{
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool ShowWindowAsync(IntPtr hWnd, int command);

    public static string Hide(string marker)
    {
        IntPtr found = IntPtr.Zero;
        string foundTitle = null;
        bool visibleBefore = false;

        EnumWindows((hWnd, _) =>
        {
            var buffer = new StringBuilder(1024);
            GetWindowText(hWnd, buffer, buffer.Capacity);
            var title = buffer.ToString();
            if (String.IsNullOrEmpty(title) || !title.Contains(marker)) return true;

            uint processId;
            GetWindowThreadProcessId(hWnd, out processId);
            try
            {
                var process = Process.GetProcessById((int)processId);
                if (!String.Equals(process.ProcessName, "chrome", StringComparison.OrdinalIgnoreCase)) return true;
            }
            catch
            {
                return true;
            }

            found = hWnd;
            foundTitle = title;
            visibleBefore = IsWindowVisible(hWnd);
            return false;
        }, IntPtr.Zero);

        if (found == IntPtr.Zero) return null;

        // SW_HIDE = 0. The renderer/network process remains alive and CDP-accessible.
        ShowWindowAsync(found, 0);
        System.Threading.Thread.Sleep(80);
        var visibleAfter = IsWindowVisible(found);
        // Return only an ASCII-safe primitive string for Windows PowerShell 5.1.
        return found.ToInt64().ToString()
            + "\t" + visibleBefore.ToString()
            + "\t" + visibleAfter.ToString();
    }
}
"@

if (-not ('ChatGptArchiveWindowHider' -as [type])) {
  Add-Type -TypeDefinition $typeDefinition -Language CSharp
}

$result = [ChatGptArchiveWindowHider]::Hide($TitleMarker)
if ([string]::IsNullOrWhiteSpace($result)) {
  Write-Error "没有找到标题包含 Guardian marker 的 Chrome 顶层窗口：$TitleMarker"
  exit 2
}

Write-Output $result
