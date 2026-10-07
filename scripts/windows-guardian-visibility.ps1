param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('show-offscreen', 'hide')]
  [string]$Action,

  [Parameter(Mandatory = $true)]
  [long]$Hwnd
)

# Windows PowerShell 5.1 的很多错误（尤其 Add-Type 编译错误）默认只是 non-terminating error。
# Actor 必须把“窗口租约没有真正建立”视为失败，因此脚本统一提升为 terminating error，
# 让 Node 的 execFileSync 能可靠得到非零退出状态，而不是继续在 hidden page 上误发送。
$ErrorActionPreference = 'Stop'

# ChatGPT Archive 的 Guardian 在 Windows 上默认用 SW_HIDE 真隐藏，从而不占任务栏/Alt-Tab。
# 但 2026-10-07 真实 E2E 发现：ChatGPT 某些 conversation 路由在“窗口一直处于 hidden”时只完成
# URL / app-shell，conversation body 与 composer 不继续 hydration。Phase 4 Actor 因而需要一个很窄的
# 临时租约：发送期间把既有 Guardian HWND 显示到屏幕外、且不抢焦点；无论成功失败都立即再隐藏。
#
# 这里故意只接受调用方已经从 daemon state 取得的 HWND，不做窗口枚举、不接收任意命令字符串。
# Node 端也通过 execFileSync + 独立参数调用，不经过 shell 拼接。

$typeDefinition = @"
using System;
using System.Runtime.InteropServices;

public static class ChatGptArchiveGuardianVisibility
{
    [DllImport("user32.dll")]
    private static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool ShowWindowAsync(IntPtr hWnd, int command);

    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(
        IntPtr hWnd,
        IntPtr hWndInsertAfter,
        int x,
        int y,
        int width,
        int height,
        uint flags
    );

    public static string Run(long hwndValue, string action)
    {
        var hWnd = new IntPtr(hwndValue);
        if (!IsWindow(hWnd)) throw new InvalidOperationException("Guardian HWND is no longer valid.");

        var visibleBefore = IsWindowVisible(hWnd);

        if (String.Equals(action, "show-offscreen", StringComparison.OrdinalIgnoreCase))
        {
            // 先把窗口移到经典 Win32 屏幕外坐标，再 SW_SHOWNOACTIVATE。
            // SWP_NOZORDER(0x0004) | SWP_NOACTIVATE(0x0010)：不改 z-order，也不抢用户焦点。
            if (!SetWindowPos(hWnd, IntPtr.Zero, -32000, -32000, 900, 700, 0x0004 | 0x0010))
                throw new InvalidOperationException("SetWindowPos failed for Guardian HWND.");

            // SW_SHOWNOACTIVATE = 4。窗口对 Chromium 来说重新进入 visible 生命周期，
            // 但不会成为前台激活窗口；实际位置已经在屏幕外。
            ShowWindowAsync(hWnd, 4);
            System.Threading.Thread.Sleep(120);
        }
        else if (String.Equals(action, "hide", StringComparison.OrdinalIgnoreCase))
        {
            // SW_HIDE = 0。renderer/network/CDP 会话保持存活，只从桌面 Shell 隐藏。
            ShowWindowAsync(hWnd, 0);
            System.Threading.Thread.Sleep(80);
        }
        else
        {
            // Windows PowerShell 5.1 的 Add-Type 仍可能使用较老 C# 编译器，不依赖 nameof()。
            throw new ArgumentOutOfRangeException("action");
        }

        var visibleAfter = IsWindowVisible(hWnd);
        return hwndValue.ToString()
            + "\t" + action
            + "\t" + visibleBefore.ToString()
            + "\t" + visibleAfter.ToString();
    }
}
"@

if (-not ('ChatGptArchiveGuardianVisibility' -as [type])) {
  Add-Type -TypeDefinition $typeDefinition -Language CSharp
}

$result = [ChatGptArchiveGuardianVisibility]::Run($Hwnd, $Action)
Write-Output $result
