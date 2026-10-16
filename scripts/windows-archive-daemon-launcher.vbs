' Hidden launcher for the ChatGPT Archive daemon.
'
' Task Scheduler runs wscript.exe. This script gates daemon startup during
' intentional maintenance, then starts node.exe hidden and waits for it.
'
' Keep this file ASCII-only: Windows Script Host may read UTF-8-without-BOM
' using the system code page and silently corrupt non-ASCII source text.

Option Explicit

If WScript.Arguments.Count < 2 Then
    WScript.Quit 64
End If

Dim shell, fso, maintenancePath, permitPath, commandLine, i, exitCode, legacyMode
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

legacyMode = False

' Backward compatibility for the currently installed production task:
' old task args start directly with node.exe + daemon.mjs. Keep accepting that
' shape until the scheduled task definition is upgraded.
If LCase(Right(CStr(WScript.Arguments(0)), 4)) = ".exe" And _
   LCase(Right(CStr(WScript.Arguments(1)), 4)) = ".mjs" Then
    legacyMode = True
End If

If legacyMode Then
    commandLine = QuoteArg(WScript.Arguments(0)) & " " & QuoteArg(WScript.Arguments(1))
    For i = 2 To WScript.Arguments.Count - 1
        commandLine = commandLine & " " & QuoteArg(WScript.Arguments(i))
    Next
Else
    If WScript.Arguments.Count < 4 Then
        WScript.Quit 64
    End If

    maintenancePath = CStr(WScript.Arguments(0))
    permitPath = CStr(WScript.Arguments(1))

    ' Intentional maintenance blocks scheduled restarts. A resume operation can
    ' grant exactly one start by creating permitPath; consume it before launch.
    If fso.FileExists(maintenancePath) Then
        If Not fso.FileExists(permitPath) Then
            WScript.Quit 0
        End If

        On Error Resume Next
        fso.DeleteFile permitPath, True
        If Err.Number <> 0 Then
            WScript.Quit 75
        End If
        On Error GoTo 0
    ElseIf fso.FileExists(permitPath) Then
        ' A stale permit is meaningless once maintenance has already ended.
        On Error Resume Next
        fso.DeleteFile permitPath, True
        On Error GoTo 0
    End If

    commandLine = QuoteArg(WScript.Arguments(2)) & " " & QuoteArg(WScript.Arguments(3))
    For i = 4 To WScript.Arguments.Count - 1
        commandLine = commandLine & " " & QuoteArg(WScript.Arguments(i))
    Next
End If

exitCode = shell.Run(commandLine, 0, True)
WScript.Quit exitCode

Function QuoteArg(value)
    QuoteArg = Chr(34) & Replace(CStr(value), Chr(34), Chr(34) & Chr(34)) & Chr(34)
End Function
