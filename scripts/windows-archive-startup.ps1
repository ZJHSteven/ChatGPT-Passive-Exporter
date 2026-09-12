param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Install', 'Uninstall', 'Status')]
  [string]$Action,

  [string]$TaskName = 'ChatGPT Archive Daemon',
  [string]$NodeExe,
  [string]$DaemonScript,
  [string]$LauncherScript,
  [string]$ProjectRoot,
  [string]$DbPath
)

# Windows 登录自启动只负责“进程级高可用”，不参与 ChatGPT 协议逻辑：
# - AtLogOn 启动 daemon；
# - daemon 非正常退出时，Task Scheduler 每 1 分钟重试，最多 999 次；
# - daemon 自己再负责 Chrome/Guardian/WSS/SQLite 的恢复。
# 这样把 Windows 进程监督与业务逻辑分层，后续即使改用 AHK 做二次健康监视也不会互相绑死。

$ErrorActionPreference = 'Stop'

if ($Action -eq 'Status') {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($null -eq $task) {
    [pscustomobject]@{ Installed = $false; TaskName = $TaskName } | ConvertTo-Json -Compress
    exit 0
  }

  $info = Get-ScheduledTaskInfo -TaskName $TaskName
  [pscustomobject]@{
    Installed = $true
    TaskName = $TaskName
    State = [string]$task.State
    LastRunTime = $info.LastRunTime
    LastTaskResult = $info.LastTaskResult
    NextRunTime = $info.NextRunTime
  } | ConvertTo-Json -Compress
  exit 0
}

if ($Action -eq 'Uninstall') {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($null -ne $task) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  }
  [pscustomobject]@{ Installed = $false; TaskName = $TaskName } | ConvertTo-Json -Compress
  exit 0
}

foreach ($required in @('NodeExe', 'DaemonScript', 'LauncherScript', 'ProjectRoot', 'DbPath')) {
  if ([string]::IsNullOrWhiteSpace((Get-Variable -Name $required -ValueOnly))) {
    throw "Install 缺少参数：$required"
  }
}

$wscriptExe = Join-Path $env:WINDIR 'System32\wscript.exe'

# 计划任务本体执行 wscript，而不是直接执行 node.exe：wscript 会隐藏 Node 的控制台，
# 并等待 Node 退出后把退出码原样传回 Task Scheduler，因此失败重启语义仍然成立。
$arguments = @(
  '//B',
  '//NoLogo',
  ('"{0}"' -f $LauncherScript),
  ('"{0}"' -f $NodeExe),
  ('"{0}"' -f $DaemonScript),
  '--db', ('"{0}"' -f $DbPath)
) -join ' '

$actionParams = @{
  Execute = $wscriptExe
  Argument = $arguments
  WorkingDirectory = $ProjectRoot
}
$taskAction = New-ScheduledTaskAction @actionParams

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

# 任务本身就是 daemon，因此可直接使用 Task Scheduler 原生失败重启。
# ExecutionTimeLimit=0 表示允许无限运行；StartWhenAvailable 处理登录瞬间调度服务尚未准备好的情况。
$settingsParams = @{
  StartWhenAvailable = $true
  MultipleInstances = 'IgnoreNew'
  RestartCount = 999
  RestartInterval = (New-TimeSpan -Minutes 1)
  ExecutionTimeLimit = [TimeSpan]::Zero
}
$settings = New-ScheduledTaskSettingsSet @settingsParams

$principalParams = @{
  UserId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  LogonType = 'Interactive'
  RunLevel = 'Limited'
}
$principal = New-ScheduledTaskPrincipal @principalParams

$taskParams = @{
  Action = $taskAction
  Trigger = $trigger
  Settings = $settings
  Principal = $principal
}
$task = New-ScheduledTask @taskParams

Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null

[pscustomobject]@{
  Installed = $true
  TaskName = $TaskName
  Launcher = $LauncherScript
  NodeExe = $NodeExe
  DaemonScript = $DaemonScript
  WorkingDirectory = $ProjectRoot
  Database = $DbPath
} | ConvertTo-Json -Compress
