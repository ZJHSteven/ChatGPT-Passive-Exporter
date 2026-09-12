' Hidden launcher for the ChatGPT Archive daemon.
'
' Task Scheduler runs wscript.exe. This script starts node.exe with
' windowStyle=0 and waits for it to exit. The child exit code is forwarded
' to Task Scheduler so restart-on-failure still works.
'
' Keep this file ASCII-only: Windows Script Host may read UTF-8-without-BOM
' using the system code page and silently corrupt non-ASCII source text.

Option Explicit

If WScript.Arguments.Count < 2 Then
    WScript.Quit 64
End If

Dim shell, commandLine, i, exitCode
Set shell = CreateObject("WScript.Shell")

commandLine = QuoteArg(WScript.Arguments(0)) & " " & QuoteArg(WScript.Arguments(1))
For i = 2 To WScript.Arguments.Count - 1
    commandLine = commandLine & " " & QuoteArg(WScript.Arguments(i))
Next

exitCode = shell.Run(commandLine, 0, True)
WScript.Quit exitCode

Function QuoteArg(value)
    QuoteArg = Chr(34) & Replace(CStr(value), Chr(34), Chr(34) & Chr(34)) & Chr(34)
End Function
