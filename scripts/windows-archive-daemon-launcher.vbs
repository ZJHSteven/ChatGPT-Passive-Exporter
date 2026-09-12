' ChatGPT Archive daemon 的 Windows 无窗口启动器。
'
' 为什么不让 Task Scheduler 直接执行 node.exe：
' - 在“仅当用户登录时运行”的 Interactive 会话里，node.exe 是 console subsystem 程序；
' - Windows Terminal 可能接管它的控制台，于是桌面会永久多出一个黑色 Terminal 窗口；
' - 这和隐藏 Guardian Chrome 的目标冲突。
'
' 这里使用 WScript.Shell.Run(windowStyle=0, waitOnReturn=True)：
' 1) windowStyle=0：Node 没有任何可见控制台窗口；
' 2) waitOnReturn=True：wscript 会一直等待真正 daemon 退出；
' 3) 最后把 Node 的退出码原样返回给 Task Scheduler，因此“异常退出后自动重启”仍然有效。

Option Explicit

If WScript.Arguments.Count < 2 Then
    WScript.Quit 64
End If

Dim shell, nodeExe, daemonScript, commandLine, i, exitCode
Set shell = CreateObject("WScript.Shell")

nodeExe = WScript.Arguments(0)
daemonScript = WScript.Arguments(1)

' 对每个参数单独做 Windows 命令行双引号转义，避免项目路径中空格导致参数错位。
commandLine = QuoteArg(nodeExe) & " " & QuoteArg(daemonScript)
For i = 2 To WScript.Arguments.Count - 1
    commandLine = commandLine & " " & QuoteArg(WScript.Arguments(i))
Next

' 0 = hidden；True = 等待子进程退出。
exitCode = shell.Run(commandLine, 0, True)
WScript.Quit exitCode

Function QuoteArg(value)
    QuoteArg = Chr(34) & Replace(CStr(value), Chr(34), Chr(34) & Chr(34)) & Chr(34)
End Function
