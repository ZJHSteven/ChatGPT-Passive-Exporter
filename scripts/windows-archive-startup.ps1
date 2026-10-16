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
# - 另加 5 分钟一次的低频 health trigger；Running 时由 IgnoreNew 丢弃，死亡时补拉起；
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
  '--db', ('"{0}"' -f $DbPath),
  # 登录/进程恢复首先恢复 WSS + 被动观察。历史缺口由后续 gap-repair / periodic 路径补齐；
  # 不要在每次 Windows 登录、任务失败重启时立刻主动扫 catalog，以免把“进程高可用”
  # 变成一个绕过 cooldown / slow-start 的额外 REST 请求源。
  '--no-reconcile-on-start'
) -join ' '

$actionParams = @{
  Execute = $wscriptExe
  Argument = $arguments
  WorkingDirectory = $ProjectRoot
}
$taskAction = New-ScheduledTaskAction @actionParams

$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

# RestartOnFailure 在普通前台状态下可靠，但真实生产曾出现“屏幕关闭低功耗阶段 daemon
# 退出后没有排队 restart”的样本。增加一个低频重复 trigger 作为独立第二道保险：
# - daemon 正常运行：MultipleInstances=IgnoreNew，不会创建第二个实例；
# - daemon 已退出：最迟下一次 5 分钟 tick 重新拉起；
# - 不依赖应用自己还能发 heartbeat，因此能覆盖真正的进程死亡。
$healthTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) -RepetitionInterval (New-TimeSpan -Minutes 5)

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
# Windows 11 当前 ScheduledTasks 模块并不把这两个字段暴露成 cmdlet 命名参数，
# 但返回的 CIM settings 对象本身支持直接赋值。Archive 是持续监控服务，不能继承
# 默认“电池上禁止启动 / 切电池停止”的行为。
$settings.DisallowStartIfOnBatteries = $false
$settings.StopIfGoingOnBatteries = $false

$principalParams = @{
  UserId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  LogonType = 'Interactive'
  RunLevel = 'Limited'
}
$principal = New-ScheduledTaskPrincipal @principalParams

$taskParams = @{
  Action = $taskAction
  Trigger = @($logonTrigger, $healthTrigger)
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
