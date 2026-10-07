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
    public static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool ShowWindowAsync(IntPtr hWnd, int command);

    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(
        IntPtr hWnd,
        IntPtr hWndInsertAfter,
        int x,
        int y,
        int width,
        int height,
        uint flags
    );
}
"@

try {
  # 内嵌 C# 保持纯 ASCII、只声明 P/Invoke；所有分支、异常和等待都放在 PowerShell 层，
  # 避免 Windows PowerShell 5.1 的旧 Add-Type 编译器把新语法/警告提升成编译失败。
  if (-not ('ChatGptArchiveGuardianVisibility' -as [type])) {
    Add-Type -TypeDefinition $typeDefinition -Language CSharp -ErrorAction Stop
  }

  $handle = [IntPtr]$Hwnd
  if (-not [ChatGptArchiveGuardianVisibility]::IsWindow($handle)) {
    throw 'Guardian HWND is no longer valid.'
  }

  $visibleBefore = [ChatGptArchiveGuardianVisibility]::IsWindowVisible($handle)
  if ($Action -eq 'show-offscreen') {
    # SWP_NOZORDER(0x0004) | SWP_NOACTIVATE(0x0010)：先挪到屏幕外，再显示且不抢焦点。
    $moved = [ChatGptArchiveGuardianVisibility]::SetWindowPos(
      $handle,
      [IntPtr]::Zero,
      -32000,
      -32000,
      900,
      700,
      (0x0004 -bor 0x0010)
    )
    if (-not $moved) { throw 'SetWindowPos failed for Guardian HWND.' }

    # SW_SHOWNOACTIVATE = 4。
    [void][ChatGptArchiveGuardianVisibility]::ShowWindowAsync($handle, 4)
    Start-Sleep -Milliseconds 150
  }
  else {
    # SW_HIDE = 0。
    [void][ChatGptArchiveGuardianVisibility]::ShowWindowAsync($handle, 0)
    Start-Sleep -Milliseconds 100
  }

  $visibleAfter = [ChatGptArchiveGuardianVisibility]::IsWindowVisible($handle)
  Write-Output ($Hwnd.ToString()
    + "`t" + $Action
    + "`t" + $visibleBefore.ToString()
    + "`t" + $visibleAfter.ToString())
  exit 0
}
catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
