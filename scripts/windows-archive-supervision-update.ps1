param(
  [ValidateSet('Validate', 'Apply')]
  [string]$Action = 'Validate'
)

<#
.SYNOPSIS
  对已经存在的 ChatGPT Archive Daemon 计划任务做监督设置原位升级。

.DESCRIPTION
  这个脚本不是运行时 helper，也不会常驻。它只在安装/升级阶段执行一次。

  与完整 Install 脚本不同，本脚本的授权边界非常窄：
  1. 任务名固定为 ChatGPT Archive Daemon；
  2. 必须已经存在；
  3. 必须已经以当前用户、Interactive、Limited 运行；
  4. 当前 action 必须已经指向本仓库固定的 launcher / node / daemon / db；
  5. 只接受旧参数格式或已经升级的新参数格式；
  6. Apply 只更新同一个 action 的 maintenance 参数、trigger/settings，不允许换 payload。

  因此管理员权限只用于更新 Task Scheduler 定义，不用于部署新的 daemon 代码。
#>

$ErrorActionPreference = 'Stop'

$taskName = 'ChatGPT Archive Daemon'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$launcher = [IO.Path]::GetFullPath((Join-Path $projectRoot 'scripts\windows-archive-daemon-launcher.vbs'))
$daemon = [IO.Path]::GetFullPath((Join-Path $projectRoot 'scripts\chatgpt-archive-daemon.mjs'))
$db = [IO.Path]::GetFullPath((Join-Path $projectRoot 'data\chatgpt-archive.sqlite'))
$maintenance = [IO.Path]::GetFullPath((Join-Path $projectRoot 'data\archive-daemon-maintenance.json'))
$startOnce = [IO.Path]::GetFullPath((Join-Path $projectRoot 'data\archive-daemon-start-once.flag'))
$nodeExe = [IO.Path]::GetFullPath('D:\App\nodejs\nodejs\node.exe')
$wscriptExe = [IO.Path]::GetFullPath((Join-Path $env:WINDIR 'System32\wscript.exe'))
$currentIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$currentUserName = [string]$currentIdentity.Name
$currentUserSid = [string]$currentIdentity.User.Value

foreach ($requiredFile in @($launcher, $daemon, $nodeExe)) {
  if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
    throw "监督设置升级失败：缺少固定 payload 文件：$requiredFile"
  }
}

function Quote-TaskArgument([string]$Value) {
  return ('"{0}"' -f $Value)
}

$legacyArguments = @(
  '//B',
  '//NoLogo',
  (Quote-TaskArgument $launcher),
  (Quote-TaskArgument $nodeExe),
  (Quote-TaskArgument $daemon),
  '--db',
  (Quote-TaskArgument $db),
  '--no-reconcile-on-start'
) -join ' '

$supervisedArguments = @(
  '//B',
  '//NoLogo',
  (Quote-TaskArgument $launcher),
  (Quote-TaskArgument $maintenance),
  (Quote-TaskArgument $startOnce),
  (Quote-TaskArgument $nodeExe),
  (Quote-TaskArgument $daemon),
  '--db',
  (Quote-TaskArgument $db),
  '--no-reconcile-on-start'
) -join ' '

function Assert-ExistingArchiveTask {
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($null -eq $task) {
    throw '监督设置升级只允许更新已经存在的 ChatGPT Archive Daemon 任务'
  }

  $actions = @($task.Actions)
  if ($actions.Count -ne 1) {
    throw "现有任务 action 数量异常：$($actions.Count)"
  }
  $taskAction = $actions[0]

  if (-not [string]::Equals(
      [IO.Path]::GetFullPath([string]$taskAction.Execute),
      $wscriptExe,
      [StringComparison]::OrdinalIgnoreCase
    )) {
    throw '现有任务 Execute 已漂移，不允许原位升级'
  }

  if (-not [string]::Equals(
      [IO.Path]::GetFullPath([string]$taskAction.WorkingDirectory).TrimEnd('\'),
      $projectRoot,
      [StringComparison]::OrdinalIgnoreCase
    )) {
    throw '现有任务 WorkingDirectory 已漂移，不允许原位升级'
  }

  $actualArguments = [string]$taskAction.Arguments
  $argumentsAreLegacy = [string]::Equals($actualArguments, $legacyArguments, [StringComparison]::OrdinalIgnoreCase)
  $argumentsAreSupervised = [string]::Equals($actualArguments, $supervisedArguments, [StringComparison]::OrdinalIgnoreCase)
  if (-not ($argumentsAreLegacy -or $argumentsAreSupervised)) {
    throw '现有任务 Arguments 已漂移，不允许原位升级'
  }

  $principal = $task.Principal
  $principalUser = [string]$principal.UserId
  $principalSid = try {
    (New-Object System.Security.Principal.NTAccount($principalUser)).
      Translate([System.Security.Principal.SecurityIdentifier]).
      Value
  }
  catch {
    $null
  }
  $userMatches = (
    -not [string]::IsNullOrWhiteSpace($principalSid) -and
    [string]::Equals($principalSid, $currentUserSid, [StringComparison]::OrdinalIgnoreCase)
  )
  if (-not $userMatches) {
    throw '现有任务 UserId 已漂移，不允许原位升级'
  }
  if ([string]$principal.LogonType -ne 'Interactive') {
    throw '现有任务 LogonType 不是 Interactive，不允许原位升级'
  }
  if ([string]$principal.RunLevel -ne 'Limited') {
    throw '现有任务 RunLevel 不是 Limited，不允许原位升级'
  }

  return [pscustomobject]@{
    Task = $task
    ArgumentsMode = if ($argumentsAreSupervised) { 'supervised' } else { 'legacy' }
  }
}

$validated = Assert-ExistingArchiveTask

if ($Action -eq 'Validate') {
  [pscustomobject]@{
    Valid = $true
    TaskName = $taskName
    CurrentArgumentsMode = $validated.ArgumentsMode
    ProjectRoot = $projectRoot
    Launcher = $launcher
    Daemon = $daemon
    Database = $db
    MaintenanceFlag = $maintenance
    StartOnceFlag = $startOnce
  } | ConvertTo-Json -Compress
  exit 0
}

# Apply 只更新“同一个既有 payload”的监督元数据。
#
# 不使用 Set-ScheduledTask：
# 本机已隔离复现，当旧任务存在 RestartOnFailure、而新 Settings 想移除它时，
# ScheduledTasks PowerShell 模块会序列化出非法的 Count 节点并报 XML 错误。
# Task Scheduler 原生 COM Definition 则能正确把 RestartCount=0 表达为“删除整个
# RestartOnFailure 节点”，因此这里直接修改既有 Definition，再原位注册回同名任务。
$TASK_ACTION_EXEC = 0
$TASK_TRIGGER_TIME = 1
$TASK_TRIGGER_LOGON = 9
$TASK_CREATE_OR_UPDATE = 6
$TASK_LOGON_INTERACTIVE_TOKEN = 3
$TASK_RUNLEVEL_LUA = 0
$TASK_INSTANCES_IGNORE_NEW = 2

$service = New-Object -ComObject 'Schedule.Service'
$service.Connect()
$rootFolder = $service.GetFolder('\')
$registeredTask = $rootFolder.GetTask($taskName)
$definition = $registeredTask.Definition

$definition.Actions.Clear()
$newAction = $definition.Actions.Create($TASK_ACTION_EXEC)
$newAction.Path = $wscriptExe
$newAction.Arguments = $supervisedArguments
$newAction.WorkingDirectory = $projectRoot

$definition.Triggers.Clear()
$logonTrigger = $definition.Triggers.Create($TASK_TRIGGER_LOGON)
$logonTrigger.UserId = $currentUserName

$healthTrigger = $definition.Triggers.Create($TASK_TRIGGER_TIME)
$healthTrigger.StartBoundary = (Get-Date).AddMinutes(1).ToString('yyyy-MM-ddTHH:mm:ss')
$healthTrigger.Repetition.Interval = 'PT1M'
$healthTrigger.Repetition.StopAtDurationEnd = $false

$definition.Settings.StartWhenAvailable = $true
$definition.Settings.MultipleInstances = $TASK_INSTANCES_IGNORE_NEW
$definition.Settings.ExecutionTimeLimit = 'PT0S'
$definition.Settings.DisallowStartIfOnBatteries = $false
$definition.Settings.StopIfGoingOnBatteries = $false

# 旧定义中的 RestartOnFailure=999 在本机对“子进程 exit 1”本来就不会生效；
# 设为 0 + 空 interval 会让 COM 正确移除整个 RestartOnFailure XML 节点。
$definition.Settings.RestartCount = 0
$definition.Settings.RestartInterval = ''

$definition.Principal.UserId = $currentUserName
$definition.Principal.LogonType = $TASK_LOGON_INTERACTIVE_TOKEN
$definition.Principal.RunLevel = $TASK_RUNLEVEL_LUA

$rootFolder.RegisterTaskDefinition(
  $taskName,
  $definition,
  $TASK_CREATE_OR_UPDATE,
  $null,
  $null,
  $TASK_LOGON_INTERACTIVE_TOKEN,
  $null
) | Out-Null

# 写完后再次从系统读取并 fail-closed 验证，避免“命令成功但任务定义不是预期”。
$after = Assert-ExistingArchiveTask
$taskAfter = $after.Task
$infoAfter = Get-ScheduledTaskInfo -TaskName $taskName

if ($after.ArgumentsMode -ne 'supervised') {
  throw '监督设置升级后 action 参数没有切换到 supervised 模式'
}
if ([string]$taskAfter.Settings.MultipleInstances -ne 'IgnoreNew') {
  throw '监督设置升级后 MultipleInstances 不是 IgnoreNew'
}
if (@($taskAfter.Triggers).Count -ne 2) {
  throw "监督设置升级后 trigger 数量异常：$(@($taskAfter.Triggers).Count)"
}

[pscustomobject]@{
  Updated = $true
  TaskName = $taskName
  State = [string]$taskAfter.State
  CurrentArgumentsMode = $after.ArgumentsMode
  TriggerCount = @($taskAfter.Triggers).Count
  MultipleInstances = [string]$taskAfter.Settings.MultipleInstances
  DisallowStartIfOnBatteries = [bool]$taskAfter.Settings.DisallowStartIfOnBatteries
  StopIfGoingOnBatteries = [bool]$taskAfter.Settings.StopIfGoingOnBatteries
  RestartCount = [int]$taskAfter.Settings.RestartCount
  RestartInterval = [string]$taskAfter.Settings.RestartInterval
  LastRunTime = $infoAfter.LastRunTime
  LastTaskResult = $infoAfter.LastTaskResult
} | ConvertTo-Json -Compress
