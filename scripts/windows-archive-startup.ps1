param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Install', 'Uninstall', 'Status')]
  [string]$Action,

  [string]$TaskName = 'ChatGPT Archive Daemon',
  [string]$NodeExe,
  [string]$DaemonScript,
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

foreach ($required in @('NodeExe', 'DaemonScript', 'ProjectRoot', 'DbPath')) {
  if ([string]::IsNullOrWhiteSpace((Get-Variable -Name $required -ValueOnly))) {
    throw "Install 缺少参数：$required"
  }
}

$arguments = @(
  ('"{0}"' -f $DaemonScript),
  '--db', ('"{0}"' -f $DbPath)
) -join ' '

$taskAction = New-ScheduledTaskAction `
  -Execute $NodeExe `
  -Argument $arguments `
  -WorkingDirectory $ProjectRoot

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

# 任务本身就是 daemon，因此可直接使用 Task Scheduler 原生失败重启。
# ExecutionTimeLimit=0 表示允许无限运行；StartWhenAvailable 处理登录瞬间调度服务尚未准备好的情况。
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero)

$principal = New-ScheduledTaskPrincipal `
  -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) `
  -LogonType Interactive `
  -RunLevel Limited

$task = New-ScheduledTask `
  -Action $taskAction `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal

Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null

[pscustomobject]@{
  Installed = $true
  TaskName = $TaskName
  NodeExe = $NodeExe
  DaemonScript = $DaemonScript
  WorkingDirectory = $ProjectRoot
  Database = $DbPath
} | ConvertTo-Json -Compress
