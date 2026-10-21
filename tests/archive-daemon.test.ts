import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  acquireArchiveDaemonSingleton,
  activeApiAllowed,
  buildDevSpaceCheckpointNotificationPayload,
  buildDevSpaceConclusionNotificationPayload,
  buildDevSpaceIdleDiagnosisNotificationPayload,
  buildDevSpaceIdleNotificationPayload,
  buildDevSpaceIdleUnboundDiagnosisNotificationPayload,
  buildCooldownNotificationPayload,
  buildTurnFinalNotificationPayload,
  buildUnboundWatchdogDiagnosisNotificationPayload,
  buildUnboundWatchdogNotificationPayload,
  buildWatchdogDeferredNotificationPayload,
  buildWatchdogDiagnosisNotificationPayload,
  buildWatchdogStartNotificationPayload,
  buildWatchdogTimeoutNotificationPayload,
  catalogStableOverlapTarget,
  classifyConversationBackendUrl,
  cooldownDeadlineFromRetryAfter,
  compactNotificationText,
  conversationNotificationGroup,
  crossedDevSpaceIdleThresholds,
  classifyCatalogAsyncStatus,
  effectiveActiveRequestGap,
  appendDaemonFatalLog,
  daemonFatalLogPath,
  formatDaemonFatalError,
  formatBeijingTime,
  isConversationTransportTopic,
  classifyConversationEvent,
  conversationIdFromTargetUrl,
  decodeCdpResponseBodyBytes,
  devSpaceIdleRepairMode,
  devSpaceFirstToolWatchdogState,
  planDevSpaceBindingProbes,
  extractDevSpaceCheckpoint,
  extractDevSpaceConclusion,
  estuaryFileIdFromUrl,
  resolvedEstuaryUrlForFile,
  extractConversationEvents,
  summarizeTurnTopicWssFrame,
  incidentKindForTrigger,
  isConfirmedTerminalTrigger,
  restoreCooldownUntil,
  resumeRetryDelayMs,
  shouldRetireIdleLiveTransport,
  shouldTripObserved429,
  terminalStateSupersedesResumeCredential,
  unboundWatchdogDiagnosisNotificationKey,
  sanitizeCapturedHeaders,
  passiveObservationMatchesReady,
  preferredWatchdogStartTitle,
  recordCatalogWatchdogProgress,
  shouldBlockGuardianConversationRest,
  shouldApplyGuardianConversationRestBlockCommand,
  shouldRetryConversationPageFetch,
  shouldRebuildGuardianAfterHealthFailures,
  guardianUiFailureKind,
  listPath,
  shouldRunDeferredGapRepair,
  shouldQueueWatchdogDiagnostic,
  shouldRetainSeenDevSpaceAudit,
  shouldRunHistoricalDevSpaceBackfill,
  shouldCloseWatchdogGenerationAfterSync,
  shouldRepairConversationTransport,
  shouldRetireWssSocketsForFrameNavigation,
  shouldAttachPassivePageObserver,
  shouldProbePassivePageObserver,
  passiveObserverRetryDelayMs,
  guardianCdpFailureScope,
  shouldReadGuardianProtocolBody,
  watchdogDiagnosticTurnKey,
  watchdogStartNotificationKey,
  unboundWatchdogStartNotificationKey,
  watchdogTurnStartedAtFromPayload,
  reconcileWatchdogDiagnosticTurn,
  shouldStartCatalogWatchdog,
  shouldNotifyHistoricalIncidentForTrigger,
  shouldNotifyIncidentTransition,
  shouldPromoteWatchdogTimeoutToActiveZombie,
  shouldNotifyTurnFinal,
  shouldRebuildGuardianForMissingWss,
  shouldSupersedeDevSpaceBinding,
  shortDevSpaceMetadataAlias,
  shouldClassifyTerminalForTrigger,
  shouldDeferConfirmedTerminalIncident,
  watchdogTriggerForStartType,
  syncSubrequestFetchOptions,
} from '../scripts/chatgpt-archive-daemon.mjs'
import { extractProjectCatalogPayload } from '../src/local/project-catalog.ts'

test('daemon fatal 记录 Error stack 与任意 rejection，并尊重 --log', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-daemon-fatal-'))
  const logPath = path.join(root, 'fatal.log')
  try {
    const error = new Error('fatal-smoke')
    const line = await appendDaemonFatalLog(logPath, 'uncaughtException', error, Date.UTC(2026, 9, 16, 2, 0, 0))
    expect(line).toContain('daemon fatal')
    expect(line).toContain('uncaughtException')
    expect(line).toContain('fatal-smoke')
    expect(await fs.readFile(logPath, 'utf8')).toBe(line)
    expect(formatDaemonFatalError({ code: 'E_SMOKE' })).toBe('{"code":"E_SMOKE"}')
    expect(daemonFatalLogPath(['--log', logPath])).toBe(path.resolve(logPath))
  }
  finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('Windows Archive startup task 由每分钟重复触发承担进程级自愈并保持单实例', async () => {
  const helper = await fs.readFile(
    new URL('../scripts/windows-archive-startup.ps1', import.meta.url),
    'utf8',
  )
  expect(helper).toContain("MultipleInstances = 'IgnoreNew'")
  expect(helper).not.toContain('RestartCount =')
  expect(helper).not.toContain('RestartInterval =')
  expect(helper).toContain('RepetitionInterval (New-TimeSpan -Minutes 1)')
  expect(helper).toContain('$settings.DisallowStartIfOnBatteries = $false')
  expect(helper).toContain('$settings.StopIfGoingOnBatteries = $false')
  expect(helper).toContain('Trigger = @($logonTrigger, $healthTrigger)')
  expect(helper).toContain('archive-daemon-maintenance.json')
  expect(helper).toContain('archive-daemon-start-once.flag')
  expect(helper).toContain("Install 只允许固定任务名：ChatGPT Archive Daemon")
  expect(helper).toContain('ExpectedDaemonSha256')
  expect(helper).toContain('ExpectedLauncherSha256')
  expect(helper).toContain('Get-FileHash -LiteralPath $canonicalDaemon -Algorithm SHA256')
  expect(helper).toContain('$currentUserName = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name')
  expect(helper).not.toContain('New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME')
})

test('Windows Archive supervision updater 只能原位升级固定既有任务', async () => {
  const helper = await fs.readFile(
    new URL('../scripts/windows-archive-supervision-update.ps1', import.meta.url),
    'utf8',
  )
  expect(helper).toContain("$taskName = 'ChatGPT Archive Daemon'")
  expect(helper).toContain('CurrentArgumentsMode = $validated.ArgumentsMode')
  expect(helper).toContain("throw '现有任务 Arguments 已漂移，不允许原位升级'")
  expect(helper).toContain("throw '现有任务 RunLevel 不是 Limited，不允许原位升级'")
  expect(helper).toContain('$currentUserSid = [string]$currentIdentity.User.Value')
  expect(helper).toContain('Translate([System.Security.Principal.SecurityIdentifier])')
  expect(helper).not.toContain('-AtLogOn -User $env:USERNAME')
  expect(helper).toContain("$definition.Settings.RestartCount = 0")
  expect(helper).toContain("$definition.Settings.RestartInterval = ''")
  expect(helper).toContain('$TASK_INSTANCES_IGNORE_NEW = 2')
  expect(helper).toContain('$rootFolder.RegisterTaskDefinition(')
  expect(helper).not.toContain('Set-ScheduledTask @setParams')
})

test('daemon 启动立即发布新 PID bootstrap state，resume 只接受本轮新实例', async () => {
  const daemon = await fs.readFile(
    new URL('../scripts/chatgpt-archive-daemon.mjs', import.meta.url),
    'utf8',
  )
  const cli = await fs.readFile(
    new URL('../scripts/chatgpt-archive.mjs', import.meta.url),
    'utf8',
  )
  expect(daemon.indexOf("startupPhase: 'initializing'")).toBeGreaterThan(-1)
  expect(daemon.indexOf("startupPhase: 'initializing'")).toBeLessThan(
    daemon.indexOf('const archive = new ChatArchiveDb(dbPath)'),
  )
  expect(daemon).toContain('devSpaceAuditBridge.pollAfter({')
  expect(daemon).toContain('archive.advanceDevSpaceAuditCursor({')
  expect(daemon).toContain('bootstrapDevSpaceAuditCursor()')
  expect(daemon).toContain('refreshPendingDevSpaceRecoveryAudits()')
  expect(daemon).not.toContain('Date.now() - DEVSPACE_INITIAL_LOOKBACK_MS')
  // Guardian 的页面导航只是“触发页面开始工作”，不是 daemon readiness 证据。
  // 如果这里重新变回同步 await，一次 CDP command ACK 抖动就会把首次 writeState 卡在
  // supervisor 的 90 秒窗口之外；因此用源码护栏明确禁止回归。
  const guardianStartupNavigation = daemon.slice(
    daemon.indexOf('guardianEstablishedOnce = true'),
    daemon.indexOf('const waitStarted = Date.now()'),
  )
  expect(guardianStartupNavigation).toContain("void guardian.page.send('Page.navigate'")
  expect(guardianStartupNavigation).toContain("void guardian.page.send('Page.reload'")
  expect(guardianStartupNavigation).not.toContain("await guardian.page.send('Page.navigate'")
  expect(guardianStartupNavigation).not.toContain("await guardian.page.send('Page.reload'")
  expect(cli).toContain('while (Date.now() - probeStartedAt < 90_000)')
  expect(cli).toContain('nextDemandStartAt = Date.now() + 750')
  expect(cli).toContain('Date.now() - probeStartedAt < 10_000')
  expect(cli).toContain('if (isNewProbeIdentity) sawNewProbeIdentity = true')
  expect(cli).toContain('observedPid !== previousPid')
  expect(cli).toContain('observedStartedAt >= probeStartedAt - 5000')
  expect(cli).toContain('could not be stopped; maintenance remains active')
})

test('不完整 SSE 只做 provisional union，绝不据此关闭 turn 或取消 Body fallback', async () => {
  const daemon = await fs.readFile(
    new URL('../scripts/chatgpt-archive-daemon.mjs', import.meta.url),
    'utf8',
  )
  const start = daemon.indexOf('const mergePartialLiveSseEvidence')
  const end = daemon.indexOf('const mirrorDevSpaceBinding', start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  const partial = daemon.slice(start, end)
  expect(partial).toContain("observationKind: 'live-sse-partial'")
  expect(partial).toContain('preserveObservedTextPrefix: true')
  expect(partial).toContain('updateCurrentState: false')
  expect(partial).toContain('updateIncidents: false')
  expect(partial).not.toContain('clearSyncDemand(')
  expect(partial).not.toContain('clearActiveTurn(')
  expect(partial).not.toContain('liveSseCanonicalSatisfied.set(')
})

test('所有 canonical ingress 都必须给 DevSpace binding 一次 reconcile 机会', async () => {
  const daemon = await fs.readFile(
    new URL('../scripts/chatgpt-archive-daemon.mjs', import.meta.url),
    'utf8',
  )

  const promotionStart = daemon.indexOf('const promoteCompleteLiveSse')
  const promotionEnd = daemon.indexOf('const mergePartialLiveSseEvidence', promotionStart)
  expect(promotionStart).toBeGreaterThan(-1)
  expect(promotionEnd).toBeGreaterThan(promotionStart)
  const promotion = daemon.slice(promotionStart, promotionEnd)
  expect(promotion).toContain("observationKind: 'live-sse-complete'")
  expect(promotion).toContain('publishDevSpaceBindingEvidenceFromBody(snapshot.conversationId')

  const passiveStart = daemon.indexOf('const rememberPassiveBodyResponse')
  const passiveEnd = daemon.indexOf('const rememberPassiveCatalogResponse', passiveStart)
  expect(passiveStart).toBeGreaterThan(-1)
  expect(passiveEnd).toBeGreaterThan(passiveStart)
  const passive = daemon.slice(passiveStart, passiveEnd)
  expect(passive).toContain("const observationKind = 'mapping-snapshot:passive-native'")
  expect(passive).toContain('const evidence = await prepareObservationEvidence({')
  expect(passive).toContain('skipLegacyObservation: evidence.skipLegacyObservation')
  expect(passive).toContain('publishHistoricalDevSpaceBindingEvidenceFromConversation(conversationId, { maxTurns: 64 })')
  expect(passive).toContain("const observationKind = 'body-page:passive-native'")
  expect(passive).toContain('const passiveDiagnostic = diagnoseLatestRun(normalized)')
  expect(passive).toContain('publishDevSpaceBindingEvidenceFromBody(conversationId, passiveDiagnostic)')
})

test('DevSpace recovery reconcile 只消费当前 canonical payload，不回扫全历史 recovery/messages', async () => {
  const daemon = await fs.readFile(
    new URL('../scripts/chatgpt-archive-daemon.mjs', import.meta.url),
    'utf8',
  )
  const start = daemon.indexOf('const reconcileDevSpaceRecoveryWithCanonical =')
  const end = daemon.indexOf('const notifyActorDomDrift', start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  const reconcile = daemon.slice(start, end)

  expect(reconcile).toContain('adaptConversation(payload)')
  expect(reconcile).toContain('supersedeDevSpaceRecoveryAudit({')
  expect(reconcile).toContain('supersedeDevSpaceCheckpointFromAssistant({')
  expect(reconcile).not.toContain('listDevSpaceRecoveryAudits(')
  expect(reconcile).not.toContain('FROM messages')
  expect(reconcile).not.toContain('result_json')
})

test('DevSpace binding uses one persistent Matching Queue for canonical evidence', async () => {
  const daemon = await fs.readFile(
    new URL('../scripts/chatgpt-archive-daemon.mjs', import.meta.url),
    'utf8',
  )

  expect(daemon.match(/matchDevSpaceCandidateForTurn\(\{/gu)?.length ?? 0).toBe(1)
  expect(daemon).not.toContain('backfillStoredDevSpaceBindings')
  expect(daemon).toContain('upsertDevSpaceBindingTurnEvidence({')
  expect(daemon).toContain('listPendingDevSpaceBindingTurnEvidence({')
  expect(daemon).toContain('markDevSpaceBindingTurnEvidenceMatched({')

  const auditStart = daemon.indexOf('const handleDevSpaceAuditEvent')
  const auditEnd = daemon.indexOf('const pollDevSpaceAudits', auditStart)
  expect(auditStart).toBeGreaterThan(-1)
  expect(auditEnd).toBeGreaterThan(auditStart)
  const audit = daemon.slice(auditStart, auditEnd)
  expect(audit).toContain('queueDevSpaceBindingWorkForAudit(event)')
  expect(audit).not.toContain('attemptDevSpaceBindingQueueEvidence(')

  const workerStart = daemon.indexOf('const scheduleDevSpaceBindingWorker')
  const workerEnd = daemon.indexOf('const queuePendingDevSpaceBindingQueue', workerStart)
  expect(workerStart).toBeGreaterThan(-1)
  expect(workerEnd).toBeGreaterThan(workerStart)
  const worker = daemon.slice(workerStart, workerEnd)
  expect(worker).toContain('setImmediate(')
  expect(worker).toContain('attemptDevSpaceBindingQueueEvidence(row')
  expect(worker).toContain('devSpaceBindingEvidenceWork.delete(key)')
  expect(worker).not.toContain('for (const row of rows) {\n      if (attemptDevSpaceBindingQueueEvidence')

  const enqueueStart = daemon.indexOf('const enqueueStoredDevSpaceTurnEvidence')
  const enqueueEnd = daemon.indexOf('const publishCanonicalDevSpaceBindingEvidence', enqueueStart)
  expect(enqueueStart).toBeGreaterThan(-1)
  expect(enqueueEnd).toBeGreaterThan(enqueueStart)
  const enqueue = daemon.slice(enqueueStart, enqueueEnd)
  expect(enqueue).toContain('devSpaceBindingEvidenceWork.set(key, queued.row)')
  expect(enqueue).toContain('scheduleDevSpaceBindingWorker()')
  expect(enqueue).not.toContain('attemptDevSpaceBindingQueueEvidence(')
  expect(daemon).toContain('bindingWorker: {')
  expect(daemon).toContain('maxItemMs:')
})

test('DevSpace audit backlog 必须分批让出 event loop，不能无界 drain', async () => {
  const daemon = await fs.readFile(
    new URL('../scripts/chatgpt-archive-daemon.mjs', import.meta.url),
    'utf8',
  )

  const scheduleStart = daemon.indexOf('const scheduleDevSpaceAuditPoll')
  const pollStart = daemon.indexOf('const pollDevSpaceAudits', scheduleStart)
  const pollEnd = daemon.indexOf('const bootstrapDevSpaceAuditCursor', pollStart)
  expect(scheduleStart).toBeGreaterThan(-1)
  expect(pollStart).toBeGreaterThan(scheduleStart)
  expect(pollEnd).toBeGreaterThan(pollStart)

  const schedule = daemon.slice(scheduleStart, pollStart)
  const poll = daemon.slice(pollStart, pollEnd)

  // continuation 必须跨 event-loop tick；同步递归/while 全量 drain 都会再次饿死同进程 Bridge。
  expect(schedule).toContain('setImmediate(')
  expect(schedule).toContain('devSpaceAuditPollScheduled')
  expect(poll).not.toContain('while (true)')
  expect(poll).toContain('DEVSPACE_AUDIT_BATCH_SIZE')
  expect(poll).toContain('scheduleDevSpaceAuditPoll()')
  expect(poll).toContain('advanceDevSpaceAuditCursor({')
  expect(poll.indexOf('handleDevSpaceAuditEvent(event)'))
    .toBeLessThan(poll.indexOf('advanceDevSpaceAuditCursor({'))

  // 状态面必须能看见是否在持续满批让路，以及单批本身是否已经异常变慢。
  expect(daemon).toContain('auditConsumer: {')
  expect(daemon).toContain('lastBatchMs:')
  expect(daemon).toContain('maxBatchMs:')
  expect(daemon).toContain('yields: devSpaceAuditPollYields')
})

test('daemon state 暴露控制平面 event-loop lag，避免把本机 starvation 误判成网络慢', async () => {
  const daemon = await fs.readFile(
    new URL('../scripts/chatgpt-archive-daemon.mjs', import.meta.url),
    'utf8',
  )

  expect(daemon).toContain('const CONTROL_PLANE_TICK_MS = 250')
  expect(daemon).toContain('controlPlaneLagMaxMs')
  expect(daemon).toContain('controlPlaneLagOver100Ms')
  expect(daemon).toContain('controlPlaneLagOver1000Ms')
  expect(daemon).toContain('controlPlane: {')
  expect(daemon).toContain('eventLoopLagLastMs: controlPlaneLagLastMs')
  expect(daemon).toContain('eventLoopLagMaxMs: controlPlaneLagMaxMs')
  expect(daemon).toContain('controlPlaneExpectedMono = performance.now() + CONTROL_PLANE_TICK_MS')
  expect(daemon).toContain('process.cpuUsage(controlPlanePreviousCpu)')
  expect(daemon).toContain('performance.eventLoopUtilization(controlPlanePreviousElu)')
  expect(daemon).toContain('cpuMs,')
  expect(daemon).toContain('elu: eluDelta.utilization')
  expect(daemon).toContain("controlPlaneStage = 'startup'")
  expect(daemon).toContain('recentSlowLags: controlPlaneRecentSlowLags.slice(-40)')
  expect(daemon).toContain("runControlPlaneStage(`conversation-merge:${trigger}`")
  expect(daemon).toContain("runControlPlaneStage('devspace-audit:poll'")
  expect(daemon).toContain("runControlPlaneStage('devspace-audit:metadata-state'")
  expect(daemon).toContain("runControlPlaneStage('devspace-audit:advance-cursor'")
  expect(daemon).toContain("runControlPlaneStage('devspace-binding-item'")
  expect(daemon).toContain("controlPlaneStage = 'idle'")
})

test('Critical 主循环只调度 Maintenance lane，不再直接等待后台重任务', async () => {
  const daemon = await fs.readFile(
    new URL('../scripts/chatgpt-archive-daemon.mjs', import.meta.url),
    'utf8',
  )
  const loopStart = daemon.indexOf('while (!stopping) {')
  const loopEnd = daemon.indexOf("await log('daemon stopping')", loopStart)
  expect(loopStart).toBeGreaterThan(-1)
  expect(loopEnd).toBeGreaterThan(loopStart)
  const loop = daemon.slice(loopStart, loopEnd)

  expect(loop).toContain('scheduleMaintenanceLane()')
  expect(loop).toContain('latestCdpTargets = Array.isArray(targets) ? targets : []')
  expect(loop).not.toContain('await refreshPassivePageObservers(targets)')
  expect(loop).not.toContain("await reconcileCatalog('periodic')")
  expect(loop).not.toContain('await drainDirty()')
  expect(loop).not.toContain('await drainCheckpointWatches()')
  expect(loop).not.toContain('await maybeRunGapRepair()')
  expect(loop).not.toContain('await hydratePendingGeneratedImageAssets()')
})

test('Maintenance lane 自己隔离错误，后台失败不得关闭 Guardian', async () => {
  const daemon = await fs.readFile(
    new URL('../scripts/chatgpt-archive-daemon.mjs', import.meta.url),
    'utf8',
  )
  const laneStart = daemon.indexOf('const runMaintenanceStep = async (step, work) =>')
  const loopStart = daemon.indexOf("controlPlaneStage = 'idle'", laneStart)
  expect(laneStart).toBeGreaterThan(-1)
  expect(loopStart).toBeGreaterThan(laneStart)
  const lane = daemon.slice(laneStart, loopStart)

  expect(lane).toContain("await log('daemon maintenance step failed'")
  expect(lane).toContain('maintenanceLaneLastError = `${step}: ${message}`')
  expect(lane).toContain('if (maintenanceLaneScheduled || maintenanceLaneInFlight || stopping) return false')
  expect(lane).toContain("await runMaintenanceStep('dirty-drain'")
  expect(lane).toContain("await runMaintenanceStep('periodic-reconcile'")
  expect(lane).not.toContain('guardian?.page?.close()')

  // state 面必须能直接判断“Critical 正常、Maintenance 慢/失败”，不能再只看到一个 daemon lastError。
  expect(daemon).toContain('maintenanceLane: {')
  expect(daemon).toContain('lastError: maintenanceLaneLastError')
  expect(daemon).toContain('maxMs: Math.round(maintenanceLaneMaxMs * 100) / 100')
})

test('同一条 DevSpace audit 内部分段 yield，durable cursor 仍只在整条处理成功后推进', async () => {
  const daemon = await fs.readFile(
    new URL('../scripts/chatgpt-archive-daemon.mjs', import.meta.url),
    'utf8',
  )
  expect(daemon).toContain('const handleDevSpaceAuditEvent = async (event) =>')
  expect(daemon).toContain('await yieldControlPlane()')
  expect(daemon).toContain('await handleDevSpaceAuditEvent(event)')
  const handledAt = daemon.indexOf('await handleDevSpaceAuditEvent(event)')
  const cursorAt = daemon.indexOf("runControlPlaneStage('devspace-audit:advance-cursor'", handledAt)
  expect(handledAt).toBeGreaterThan(-1)
  expect(cursorAt).toBeGreaterThan(handledAt)
})

test('daemon startup 只从 Archive 已知候选恢复 metadata，不全表扫描 DevSpace 最近 activity', async () => {
  const daemon = await fs.readFile(
    new URL('../scripts/chatgpt-archive-daemon.mjs', import.meta.url),
    'utf8',
  )
  const startupBegin = daemon.indexOf('const cursorBeforeBootstrap = devSpaceAuditCursor')
  const wakeBegin = daemon.indexOf('const devSpaceWakeListening = await devSpaceAuditWakeListener.start', startupBegin)
  expect(startupBegin).toBeGreaterThan(-1)
  expect(wakeBegin).toBeGreaterThan(startupBegin)
  const startup = daemon.slice(startupBegin, wakeBegin)
  expect(startup).toContain('pendingRecoveryAtStartup.metadataIds')
  expect(startup).toContain('archive.listDevSpaceMetadataBindings({')
  expect(startup).toContain("runControlPlaneStage('devspace-startup:metadata-state'")
  expect(startup).not.toContain('recentMetadataToolStates(')
})

test('Guardian Windows 窗口隐藏必须异步执行，不能用 execFileSync 冻结控制面', async () => {
  const daemon = await fs.readFile(
    new URL('../scripts/chatgpt-archive-daemon.mjs', import.meta.url),
    'utf8',
  )
  expect(daemon).toContain('const execFileAsync = promisify(execFile)')
  expect(daemon).toContain("await execFileAsync('powershell.exe'")
  expect(daemon).not.toContain('execFileSync(')
})

test('startup 直接信任 durable active_watchdogs，不再逐条扫描 messages 重算 startedAt', async () => {
  const daemon = await fs.readFile(
    new URL('../scripts/chatgpt-archive-daemon.mjs', import.meta.url),
    'utf8',
  )
  const start = daemon.indexOf('for (const persisted of archive.listActiveWatchdogs())')
  const end = daemon.indexOf('const unboundDevSpaceTurns = new Map()', start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  const restore = daemon.slice(start, end)
  expect(restore).toContain('startedAt: Number(persisted.startedAt)')
  expect(restore).not.toContain('SELECT MIN(create_time)')
  expect(restore).not.toContain('turn_exchange_id = ? OR request_id = ? OR message_id = ?')
})

test('startup binding recovery 复用 cooperative worker，不同步 drain pending queue', async () => {
  const daemon = await fs.readFile(
    new URL('../scripts/chatgpt-archive-daemon.mjs', import.meta.url),
    'utf8',
  )
  expect(daemon).toContain('const queuePendingDevSpaceBindingQueue =')
  expect(daemon).toContain('devSpaceBindingEvidenceWork.set(key, row)')
  expect(daemon).toContain('scheduleDevSpaceBindingWorker()')
  expect(daemon).not.toContain('const drainPendingDevSpaceBindingQueue =')
  expect(daemon).toContain('DevSpace matching queue recovery scheduled after startup')
})

test('DevSpace 全历史 metadata seed 只在首次迁移运行，稳态启动依赖 durable audit cursor', async () => {
  const daemon = await fs.readFile(
    new URL('../scripts/chatgpt-archive-daemon.mjs', import.meta.url),
    'utf8',
  )
  const start = daemon.indexOf('const hadExistingDevSpaceMetadataBindings')
  const end = daemon.indexOf('const devSpaceBackfilledBindings = 0', start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  const seed = daemon.slice(start, end)
  expect(seed).toContain('hadExistingDevSpaceMetadataBindings')
  expect(seed).toContain('? []')
  expect(seed).toContain(': devSpaceAuditBridge.metadataSummaries(10_000)')
})

test('DevSpace binding probe 在 canonical IDs 全已知时必须跳过 merge', async () => {
  const daemon = await fs.readFile(
    new URL('../scripts/chatgpt-archive-daemon.mjs', import.meta.url),
    'utf8',
  )

  const syncStart = daemon.indexOf('const syncConversation = async')
  const syncEnd = daemon.indexOf('const drainCheckpointWatches', syncStart)
  expect(syncStart).toBeGreaterThan(-1)
  expect(syncEnd).toBeGreaterThan(syncStart)
  const sync = daemon.slice(syncStart, syncEnd)

  const knownIndex = sync.indexOf('const allKnownBefore =')
  const probeFastPathIndex = sync.indexOf("trigger === 'devspace:binding-probe' && allKnownBefore")
  const mergeIndex = sync.indexOf('archive.mergeLiveMessagesPage(')
  expect(knownIndex).toBeGreaterThan(-1)
  expect(probeFastPathIndex).toBeGreaterThan(knownIndex)
  expect(mergeIndex).toBeGreaterThan(probeFastPathIndex)
  expect(sync).toContain('DevSpace binding probe reused stored canonical page; merge skipped')
  expect(sync).toContain('recoverySuperseded: 0')
  expect(daemon).toContain('bindingProbeMergesSkipped: devSpaceBindingProbeMergesSkipped')
})

test('unbound gap repair requires Project sidebar discovery before terminal unbound completion', async () => {
  const daemon = await fs.readFile(
    new URL('../scripts/chatgpt-archive-daemon.mjs', import.meta.url),
    'utf8',
  )
  const start = daemon.indexOf('const maybeRunGapRepair')
  const end = daemon.indexOf('const attachGuardianEvents', start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  const repair = daemon.slice(start, end)

  expect(repair).toContain("familyRateLimitAllowed(rateLimits, 'project-catalog'")
  expect(repair).toContain('no-passive-project-sidebar-after-gap')
  const globalIndex = repair.indexOf("await reconcileCatalog('gap-repair')")
  const projectIndex = repair.indexOf("await reconcileProjectSidebar('devspace-unbound-repair'")
  const completionIndex = repair.indexOf('pending.catalogRepairCompletedAt = completedAt')
  expect(globalIndex).toBeGreaterThan(-1)
  expect(projectIndex).toBeGreaterThan(globalIndex)
  expect(completionIndex).toBeGreaterThan(projectIndex)
})

test('global catalog replay 继承第一方 query 模板，只覆盖分页参数', () => {
  expect(listPath(28, 28, [
    ['order', 'updated'],
    ['is_archived', 'false'],
    ['is_starred', 'false'],
    ['expand', 'false'],
    ['hide_snorlax', 'false'],
  ])).toBe(
    '/backend-api/conversations?offset=28&limit=28&order=updated&is_archived=false&is_starred=false&expand=false&hide_snorlax=false',
  )
})

test('同一次 checkpoint sync 的子请求统一继承 turn-scoped extraHeaders', () => {
  const extraHeaders = { 'x-oai-turn-trace-id': 'trace-session-1' }
  expect(syncSubrequestFetchOptions({ extraHeaders })).toEqual({ extraHeaders })
  expect(syncSubrequestFetchOptions({ extraHeaders }, { skipRequestSlot: true })).toEqual({
    skipRequestSlot: true,
    extraHeaders,
  })
})

test('SSE 只有拿到 resume capability 且持续无任何 bytes 才判为 idle hang', () => {
  const state = {
    transport: 'conversation',
    conversationId: 'cid-1',
    lastDataAt: 10_000,
  }
  expect(shouldRetireIdleLiveTransport(state, {
    now: 55_000,
    idleMs: 45_000,
    hasResumeCredential: true,
  })).toBe(true)
  expect(shouldRetireIdleLiveTransport(state, {
    now: 54_999,
    idleMs: 45_000,
    hasResumeCredential: true,
  })).toBe(false)
  expect(shouldRetireIdleLiveTransport(state, {
    now: 60_000,
    idleMs: 45_000,
    hasResumeCredential: false,
  })).toBe(false)
  expect(shouldRetireIdleLiveTransport({ ...state, transport: 'turn-wss' }, {
    now: 60_000,
    idleMs: 45_000,
    hasResumeCredential: true,
  })).toBe(false)
  expect(shouldRetireIdleLiveTransport({ ...state, lastDataAt: null }, {
    now: 60_000,
    idleMs: 45_000,
    hasResumeCredential: true,
  })).toBe(false)
})

test('上一轮 conversation final 不能挡住更新的 resume token', () => {
  expect(terminalStateSupersedesResumeCredential({
    terminalState: 'final',
    lastSeenAt: 10_000,
  }, 12_000)).toBe(false)
  expect(terminalStateSupersedesResumeCredential({
    terminalState: 'final',
    lastSeenAt: 12_000,
  }, 12_000)).toBe(true)
  expect(terminalStateSupersedesResumeCredential({
    terminalState: 'none',
    lastSeenAt: 20_000,
  }, 12_000)).toBe(false)
})

describe('ChatGPT Archive daemon WSS parser', () => {
  test('DevSpace 全量历史 binding backfill 只在首次初始化执行', () => {
    expect(shouldRunHistoricalDevSpaceBackfill(false, 1)).toBe(true)
    expect(shouldRunHistoricalDevSpaceBackfill(false, 0)).toBe(false)
    expect(shouldRunHistoricalDevSpaceBackfill(true, 1)).toBe(false)
    expect(shouldRunHistoricalDevSpaceBackfill(true, 20)).toBe(false)
  })

  test('SSE resume 使用有限退避，不会无限加速重试', () => {
    expect(resumeRetryDelayMs(1)).toBe(2_000)
    expect(resumeRetryDelayMs(2)).toBe(5_000)
    expect(resumeRetryDelayMs(3)).toBe(15_000)
    expect(resumeRetryDelayMs(4)).toBe(30_000)
    expect(resumeRetryDelayMs(5)).toBe(60_000)
    expect(resumeRetryDelayMs(99)).toBe(60_000)
  })

  test('DevSpace metadata 手机别名只保留短前缀，便于口述回查', () => {
    expect(shortDevSpaceMetadataAlias('v1/31BvfaYkExI0xUrv4HwbKqFytFEJUAop')).toBe('meta/31BvfaYk')
    expect(shortDevSpaceMetadataAlias('server-handshake-a')).toBe('meta/server-h')
    expect(shortDevSpaceMetadataAlias('')).toBe('meta/unknown')
  })

  test('Conclusion 只接受非空字符串；手机仅展示压缩结论并按会话分组', () => {
    expect(extractDevSpaceConclusion('{"conclusion":"  已完成受控重启  "}')).toBe('已完成受控重启')
    expect(extractDevSpaceConclusion('{"conclusion":"   "}')).toBeNull()
    expect(extractDevSpaceConclusion('{broken')).toBeNull()
    expect(extractDevSpaceConclusion('{"conclusion":123}')).toBeNull()

    const bound = buildDevSpaceConclusionNotificationPayload({
      conversationId: 'conversation-a',
      title: '需求梳理',
      metadataId: 'v1/abcdefgh12345678',
      tool: 'exec_command',
      conclusion: '已经完成阶段一。',
    })
    expect(bound.title).toBe('DevSpace · 结论')
    expect(bound.subtitle).toBe('需求梳理')
    expect(bound.body).toContain('工具：exec_command')
    expect(bound.body).toContain('已经完成阶段一。')
    expect(bound.group).toBe('Chat/conversation-a')
    expect(bound.url).toContain('/c/conversation-a')

    const titled = buildDevSpaceConclusionNotificationPayload({
      title: '排查 Chrome 窗口',
      metadataId: 'v1/abcdefgh12345678',
      tool: 'read',
      conclusion: '已定位窗口坐标。',
    })
    expect(titled.subtitle).toBe('排查 Chrome 窗口 · 未绑定')
    expect(titled.group).toBe('Chat/meta/abcdefgh')
    expect(titled).not.toHaveProperty('url')

    const unnamed = buildDevSpaceConclusionNotificationPayload({
      metadataId: 'v1/abcdefgh12345678',
      tool: 'write_stdin',
      conclusion: '进程结束。',
    })
    expect(unnamed.subtitle).toBe('meta/abcdefgh · 未绑定')
    expect(unnamed.body).not.toContain('v1/abcdefgh12345678')
  })

  test('Checkpoint 解析 summary/next；手机正文只保留两行压缩摘要', () => {
    expect(extractDevSpaceCheckpoint(JSON.stringify({
      summary: '  已确认虚拟 conversation 可以在 binding 前持续积累。  ',
      next: '  转入 canonical supersede 验证。  ',
    }))).toEqual({
      summary: '已确认虚拟 conversation 可以在 binding 前持续积累。',
      next: '转入 canonical supersede 验证。',
    })
    expect(extractDevSpaceCheckpoint('{"summary":"   "}')).toBeNull()
    expect(extractDevSpaceCheckpoint('{broken')).toBeNull()

    const payload = buildDevSpaceCheckpointNotificationPayload({
      title: 'Archive 临时 Conversation',
      metadataId: 'v1/abcdefgh12345678',
      summary: '阶段一已经完成。',
      next: '开始生产 E2E。',
    })
    expect(payload.title).toContain('Checkpoint')
    expect(payload.subtitle).toBe('Archive 临时 Conversation · 未绑定')
    expect(payload.body).toContain('阶段一已经完成。')
    expect(payload.body).toContain('下一步：开始生产 E2E。')
    expect(payload.body.split('\n')).toHaveLength(3)
    expect(payload.group).toBe('Chat/meta/abcdefgh')
    expect(payload).not.toHaveProperty('url')
  })


  test('Checkpoint notification keeps full text until UTF-8 byte budget', () => {
    const summary = `stage:${'\u7532'.repeat(400)}`
    const next = `next:${'\u4e59'.repeat(120)}`
    const payload = buildDevSpaceCheckpointNotificationPayload({
      title: 'long checkpoint',
      metadataId: 'v1/abcdefgh12345678',
      summary,
      next,
    })
    expect(payload.body).toBe(`${summary}\n\n\u4e0b\u4e00\u6b65\uff1a${next}`)
    expect(payload.body).not.toContain('\u2026')

    const parsedLong = extractDevSpaceCheckpoint(JSON.stringify({
      summary: '\u7532'.repeat(1900),
      next: '\u4e59'.repeat(950),
    }))
    expect(parsedLong?.summary).toHaveLength(1900)
    expect(parsedLong?.next).toHaveLength(950)

    const huge = buildDevSpaceCheckpointNotificationPayload({
      title: 'oversized checkpoint',
      metadataId: 'v1/abcdefgh12345678',
      summary: '\u7532'.repeat(1500),
      next: '\u4e59'.repeat(800),
    })
    expect(Buffer.byteLength(huge.body, 'utf8')).toBeLessThanOrEqual(3000)
    expect(huge.body).toContain('\n\n\u4e0b\u4e00\u6b65\uff1a')
    expect(huge.body).toContain('\u2026')
    expect(huge.body).not.toContain('\uFFFD')
  })

  test('通知文本按 Unicode code point 安全压缩，不把换行带进锁屏单行摘要', () => {
    expect(compactNotificationText('第一行\n  第二行', 20)).toBe('第一行 第二行')
    expect(compactNotificationText('A😀BC', 4)).toBe('A😀BC')
    expect(compactNotificationText('A😀BCD', 4)).toBe('A😀B…')
  })

  test('conversation Bark group 只承担通知线程身份，不再按事件类别跨会话堆叠', () => {
    expect(conversationNotificationGroup({ conversationId: 'conversation-a' })).toBe('Chat/conversation-a')
    expect(conversationNotificationGroup({ metadataId: 'v1/abcdefgh12345678' })).toBe('Chat/meta/abcdefgh')
  })

  test('DevSpace idle 只在 1/3/5 分钟边界穿越时触发，重启不会补轰炸旧阈值', () => {
    expect(crossedDevSpaceIdleThresholds(59_000, 61_000)).toEqual([60_000])
    expect(crossedDevSpaceIdleThresholds(61_000, 179_000)).toEqual([])
    expect(crossedDevSpaceIdleThresholds(179_000, 181_000)).toEqual([180_000])
    expect(crossedDevSpaceIdleThresholds(181_000, 301_000)).toEqual([300_000])
    expect(crossedDevSpaceIdleThresholds(240_000, 241_000)).toEqual([])
  })

  test('只有 5 分钟 DevSpace idle 会升级为提前核验；bound 直读 body，unbound 才扫 catalog', () => {
    expect(devSpaceIdleRepairMode(60_000, 'conversation-a')).toBe('none')
    expect(devSpaceIdleRepairMode(180_000, 'conversation-a')).toBe('none')
    expect(devSpaceIdleRepairMode(300_000, 'conversation-a')).toBe('bound-body')
    expect(devSpaceIdleRepairMode(300_000, null)).toBe('unbound-catalog')
  })

  test('5 分钟 bound body probe 可识别显式异常，但本身不是 confirmed complete 证据', () => {
    expect(shouldClassifyTerminalForTrigger('devspace-idle:bound-probe')).toBe(true)
    expect(isConfirmedTerminalTrigger('devspace-idle:bound-probe')).toBe(false)
  })

  test('工具静默通知把事件放 title、会话放 subtitle，并按 conversation 分组', () => {
    const unbound = buildDevSpaceIdleNotificationPayload({
      metadataId: 'v1/abcdefghijklmnopqrstuvwxyz',
      title: '改造 DevSpace',
      thresholdMs: 180_000,
    })
    expect(unbound.title).toBe('工具静默 · 3m')
    expect(unbound.subtitle).toBe('改造 DevSpace · 未绑定')
    expect(unbound.body).toBe('等待绑定 canonical')
    expect(unbound.group).toBe('Chat/meta/abcdefgh')
    expect(unbound).not.toHaveProperty('url')

    const bound = buildDevSpaceIdleNotificationPayload({
      conversationId: 'conversation-a',
      metadataId: 'meta-a',
      title: 'Canonical title',
      thresholdMs: 300_000,
    })
    expect(bound.title).toBe('工具静默 · 5m')
    expect(bound.subtitle).toBe('Canonical title')
    expect(bound.body).toBe('仍在观察')
    expect(bound.group).toBe('Chat/conversation-a')
    expect(bound.url).toContain('/c/conversation-a')

    const unnamed = buildDevSpaceIdleNotificationPayload({
      metadataId: 'v1/abcdefgh12345678',
      thresholdMs: 60_000,
    })
    expect(unnamed.title).toBe('工具静默 · 1m')
    expect(unnamed.subtitle).toBe('meta/abcdefgh · 未绑定')
    expect(unnamed.body).toBe('等待绑定 canonical')
    expect(unnamed.body).not.toContain('v1/abcdefgh12345678')

    const longTitle = '这是一个非常非常非常非常非常长的聊天标题用于测试截断'
    const long = buildDevSpaceIdleNotificationPayload({
      conversationId: 'conversation-long',
      title: longTitle,
      thresholdMs: 180_000,
    })
    expect(long.title).toBe('工具静默 · 3m')
    expect(long.subtitle).toBe(longTitle)
    expect(long.body).toBe('仍在观察')
  })

  test('5 分钟诊断通知明确报告 Body 与 DevSpace audit 的 tail gap', () => {
    const payload = buildDevSpaceIdleDiagnosisNotificationPayload({
      conversationId: 'conversation-a',
      title: '恢复并继续 ClassFlow',
      diagnostic: { terminalEvidence: 'none', tailShape: 'tool-result-returned' },
      canonicalMessageCount: 5317,
      tailGap: {
        canonicalTailAt: Date.UTC(2026, 9, 10, 10, 0, 0),
        recoveryLastAt: Date.UTC(2026, 9, 10, 10, 21, 0),
        gapMs: 21 * 60_000,
        recoveryAuditCount: 67,
        recoveryToolCount: 66,
        checkpointCount: 1,
        hasTailGap: true,
      },
    })
    expect(payload.title).toBe('5m 核验 · Body 缺口')
    expect(payload.subtitle).toBe('恢复并继续 ClassFlow')
    expect(payload.group).toBe('Chat/conversation-a')
    expect(payload.body).toBe('Body 落后 21 分钟 · recovery 67')
    expect(payload.url).toContain('/c/conversation-a')
  })

  test('未绑定 5 分钟 gap-repair 也必须返回明确扫描结果', () => {
    const payload = buildDevSpaceIdleUnboundDiagnosisNotificationPayload({
      metadataId: 'v1/abcdefgh12345678',
      title: '未知聊天',
      recoveryAuditCount: 12,
      recoveryToolCount: 10,
      checkpointCount: 2,
    })
    expect(payload.title).toBe('5m 核验 · 未绑定')
    expect(payload.subtitle).toBe('未知聊天 · 未绑定')
    expect(payload.body).toBe('catalog repair 后仍未匹配 · recovery 12')
    expect(payload.group).toBe('Chat/meta/abcdefgh')
  })
  test('当前 exact body 只允许纠正历史 backfill，不覆盖另一个在线 exact binding', () => {
    expect(shouldSupersedeDevSpaceBinding(
      { conversationId: 'old', evidence: 'body:exact-tool-args-backfill' },
      { conversationId: 'new', evidence: 'body:exact-tool-args' },
    )).toBe(true)
    expect(shouldSupersedeDevSpaceBinding(
      { conversationId: 'old', evidence: 'body:exact-tool-args' },
      { conversationId: 'new', evidence: 'body:exact-tool-args' },
    )).toBe(false)
    expect(shouldSupersedeDevSpaceBinding(
      { conversationId: 'same', evidence: 'body:exact-tool-args-backfill' },
      { conversationId: 'same', evidence: 'body:exact-tool-args' },
    )).toBe(false)
  })

  test('只有顶层 ChatGPT document replacement 才淘汰旧 WSS；iframe/其它站点/SPA 不误判', () => {
    expect(shouldRetireWssSocketsForFrameNavigation({
      url: 'https://chatgpt.com/c/6ac5ebe1-c5c4-83ea-afc9-66a9cef1dd59',
    })).toBe(true)
    expect(shouldRetireWssSocketsForFrameNavigation({
      url: 'https://chatgpt.com/',
      parentId: '',
    })).toBe(true)
    expect(shouldRetireWssSocketsForFrameNavigation({
      url: 'https://chatgpt.com/some-frame',
      parentId: 'parent-frame-id',
    })).toBe(false)
    expect(shouldRetireWssSocketsForFrameNavigation({
      url: 'https://example.com/',
    })).toBe(false)
    expect(shouldRetireWssSocketsForFrameNavigation(null)).toBe(false)
  })

  test('Guardian 也属于被动页面 observer：物理合并后仍能抓 Actor SSE', () => {
    const guardian = {
      id: 'guardian-target',
      type: 'page',
      url: 'https://chatgpt.com/c/example?chatgpt-archive-guardian=1',
      webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/guardian-target',
    }
    expect(shouldAttachPassivePageObserver(guardian)).toBe(true)
    expect(shouldAttachPassivePageObserver({
      ...guardian,
      type: 'service_worker',
    })).toBe(false)
    expect(shouldAttachPassivePageObserver({
      ...guardian,
      url: 'https://example.com/',
    })).toBe(false)
    expect(shouldAttachPassivePageObserver({
      ...guardian,
      webSocketDebuggerUrl: '',
    })).toBe(false)
    const sleepingTarget = {
      ...guardian,
      title: '💤 ChatGPT',
      url: 'https://chatgpt.com/',
    }
    expect(shouldAttachPassivePageObserver(sleepingTarget)).toBe(false)
  })

  test('普通 passive target 连续 attach 失败仍保持固定低频探测', () => {
    expect(passiveObserverRetryDelayMs(1, 300_000, 3_600_000)).toBe(300_000)
    expect(passiveObserverRetryDelayMs(2, 300_000, 3_600_000)).toBe(300_000)
    expect(passiveObserverRetryDelayMs(5, 300_000, 3_600_000)).toBe(300_000)
    expect(passiveObserverRetryDelayMs(99, 300_000, 3_600_000)).toBe(300_000)
  })

  test('passive observer 仅在空闲且超过健康间隔时探测，active SSE 不被打扰', () => {
    expect(shouldProbePassivePageObserver({
      now: 100_000,
      lastHealthAt: 60_000,
      hasActiveTransport: false,
      clientClosed: false,
    }, 30_000)).toBe(true)
    expect(shouldProbePassivePageObserver({
      now: 100_000,
      lastHealthAt: 80_000,
      hasActiveTransport: false,
      clientClosed: false,
    }, 30_000)).toBe(false)
    expect(shouldProbePassivePageObserver({
      now: 100_000,
      lastHealthAt: 0,
      hasActiveTransport: true,
      clientClosed: false,
    }, 30_000)).toBe(false)
    expect(shouldProbePassivePageObserver({
      now: 100_000,
      lastHealthAt: 0,
      hasActiveTransport: false,
      clientClosed: true,
    }, 30_000)).toBe(false)
  })

  test('Guardian CDP timeout 可区分 target 与 browser 层级', () => {
    expect(guardianCdpFailureScope(true)).toBe('target')
    expect(guardianCdpFailureScope(false)).toBe('browser')
  })

  test('Guardian 协议指纹 body 读取遵守并发上限', () => {
    expect(shouldReadGuardianProtocolBody(0, 2)).toBe(true)
    expect(shouldReadGuardianProtocolBody(1, 2)).toBe(true)
    expect(shouldReadGuardianProtocolBody(2, 2)).toBe(false)
    expect(shouldReadGuardianProtocolBody(99, 2)).toBe(false)
  })

  test('429 cooldown 通知文案包含原因、路由与预计解除时间', () => {
    expect(buildCooldownNotificationPayload({
      reason: 'active body HTTP 429',
      cooldownUntil: Date.parse('2026-10-06T09:02:52.322Z'),
      route: '/backend-api/conversation/example',
      retryAfter: '120',
    })).toEqual({
      title: 'ChatGPT API 429 冷却',
      body: [
        '原因：active body HTTP 429',
        '请求：/backend-api/conversation/example',
        'Retry-After：120',
        '主动 API 冷却至：2026-10-06 17:02:52 北京时间',
        'WSS/CDP 被动监听继续运行；滑动延长只记日志，不重复通知。',
      ].join('\n'),
      group: 'Archive-Warning',
    })
  })

  test('人类可见时间统一格式化为北京时间，数据库仍可继续保存绝对时间戳', () => {
    expect(formatBeijingTime(Date.parse('2026-10-07T11:40:30.073Z')))
      .toBe('2026-10-07 19:40:30 北京时间')
  })

  test('conversation transport repair 只跟随 conversation carrier 换代', () => {
    expect(isConversationTransportTopic('conversations')).toBe(true)
    expect(isConversationTransportTopic('alder-conversations')).toBe(true)
    expect(isConversationTransportTopic('app_notifications')).toBe(false)
    expect(isConversationTransportTopic('resource-updates')).toBe(false)

    // Guardian 第一次建立 conversation carrier 是正常初始化，不应额外扫 catalog。
    expect(shouldRepairConversationTransport(false, null, 'socket-a')).toBe(false)
    // 同一 socket 重复订阅 conversations/alder 不算换代。
    expect(shouldRepairConversationTransport(true, 'socket-a', 'socket-a')).toBe(false)
    // 无论旧 carrier 已先关闭（current=null）还是 overlap handover，都应 repair。
    expect(shouldRepairConversationTransport(true, null, 'socket-b')).toBe(true)
    expect(shouldRepairConversationTransport(true, 'socket-a', 'socket-b')).toBe(true)
  })

  test('turn-topic WSS 只提取 subscribe/ACK/catchup/live 控制面，不泄露 encoded_item 正文', () => {
    const topic = 'conversation-turn-11111111-2222-3333-4444-555555555555'
    const sent = JSON.stringify([{ id: 5, command: { type: 'subscribe', topic_id: topic, offset: '0' } }])
    expect(summarizeTurnTopicWssFrame(sent)).toEqual([
      { source: 'subscribe', topic, offset: '0' },
    ])

    const catchup = {
      type: 'message',
      topic_id: topic,
      offset: 'opaque-1',
      payload: {
        type: 'conversation-turn-stream',
        payload: {
          type: 'stream-item',
          stream_item_id: 'item-1',
          parent_stream_item_id: 'parent-1',
          encoded_item: 'data: {"secret":"must-not-leak"}\n\n',
        },
      },
    }
    const received = JSON.stringify([
      { type: 'reply', reply: { type: 'subscribe', topic_id: topic, recovered: true, last_offset: 'opaque-1', catchups: [catchup] } },
      { ...catchup, offset: 'opaque-2' },
      { type: 'message', topic_id: topic, payload: { type: 'conversation-turn-stream', payload: { type: 'done' } } },
    ])
    const summary = summarizeTurnTopicWssFrame(received)
    expect(summary).toEqual([
      { source: 'reply', topic, recovered: true, catchupCount: 1, lastOffsetPresent: true },
      {
        source: 'catchup', topic, innerType: 'stream-item', hasEncodedItem: true,
        encodedBytes: Buffer.byteLength('data: {"secret":"must-not-leak"}\n\n'), offsetPresent: true,
        streamItemIdPresent: true, parentStreamItemIdPresent: true,
      },
      {
        source: 'message', topic, innerType: 'stream-item', hasEncodedItem: true,
        encodedBytes: Buffer.byteLength('data: {"secret":"must-not-leak"}\n\n'), offsetPresent: true,
        streamItemIdPresent: true, parentStreamItemIdPresent: true,
      },
      {
        source: 'message', topic, innerType: 'done', hasEncodedItem: false,
        encodedBytes: 0, offsetPresent: false, streamItemIdPresent: false, parentStreamItemIdPresent: false,
      },
    ])
    expect(JSON.stringify(summary)).not.toContain('must-not-leak')
  })

  test('图片下载辅助只提取稳定 conversation/file id，不依赖短期签名', () => {
    expect(conversationIdFromTargetUrl('https://chatgpt.com/c/6ab3d7db-3f04-83e9-bad2-8abd105c3898')).toBe('6ab3d7db-3f04-83e9-bad2-8abd105c3898')
    expect(conversationIdFromTargetUrl('https://chatgpt.com/?chatgpt-archive-guardian=1')).toBeNull()
    expect(conversationIdFromTargetUrl('https://example.com/c/not-chatgpt')).toBeNull()

    expect(estuaryFileIdFromUrl('https://chatgpt.com/backend-api/estuary/content?id=file_abc123&ts=1&sig=temporary')).toBe('file_abc123')
    expect(estuaryFileIdFromUrl('https://sub.chatgpt.com/backend-api/estuary/content?id=file_abc123&ts=1')).toBe('file_abc123')
    expect(estuaryFileIdFromUrl('https://chatgpt.com/backend-api/conversations/file_abc123')).toBeNull()
    expect(estuaryFileIdFromUrl('https://example.com/backend-api/estuary/content?id=file_abc123')).toBeNull()
  })

  test('CDP 图片响应按 base64 标记无损还原二进制', () => {
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff])
    expect(decodeCdpResponseBodyBytes({
      body: binary.toString('base64'),
      base64Encoded: true,
    })).toEqual(binary)
    expect(decodeCdpResponseBodyBytes({
      body: 'plain text',
      base64Encoded: false,
    })).toEqual(Buffer.from('plain text', 'utf8'))
  })

  test('files/download resolver 只接受同一 file id 的 ChatGPT estuary URL', () => {
    const fileId = 'file_abc123'
    const valid = 'https://chatgpt.com/backend-api/estuary/content?id=file_abc123&ts=1&sig=temporary'
    expect(resolvedEstuaryUrlForFile({ status: 'success', download_url: valid }, fileId)).toBe(valid)
    // 当前前端 bundle 兼容缺失 status；只要 download_url 合法仍可使用。
    expect(resolvedEstuaryUrlForFile({ download_url: valid }, fileId)).toBe(valid)
    expect(resolvedEstuaryUrlForFile({ status: 'error', download_url: valid }, fileId)).toBeNull()
    expect(resolvedEstuaryUrlForFile({ status: 'success', download_url: 'https://chatgpt.com/backend-api/estuary/content?id=file_other&sig=x' }, fileId)).toBeNull()
    expect(resolvedEstuaryUrlForFile({ status: 'success', download_url: 'https://example.com/backend-api/estuary/content?id=file_abc123&sig=x' }, fileId)).toBeNull()
    expect(resolvedEstuaryUrlForFile({ status: 'success', download_url: 'http://chatgpt.com/backend-api/estuary/content?id=file_abc123&sig=x' }, fileId)).toBeNull()
  })

  test('从 conversations / alder-conversations topic 中提取 conversation id、事件类型与来源 topic', () => {
    const frame = JSON.stringify([
      {
        type: 'message',
        topic_id: 'conversations',
        payload: {
          type: 'conversation-turn-complete',
          // 2026-09-13 当前第一方真实 frame：conversation_id 位于事件 payload 的下一层，
          // 不能假设它和 conversation-turn-complete 的 type 是兄弟字段。
          payload: {
            conversation_id: 'conversation-1',
            private_body: 'do not need to copy this into event queue',
          },
          metadata: null,
        },
      },
      {
        type: 'message',
        topic_id: 'conversations',
        payload: {
          type: 'conversation-created',
          payload: {
            conversation_id: 'conversation-2',
          },
        },
      },
      {
        type: 'message',
        topic_id: 'conversations',
        payload: {
          type: 'conversation-update',
          payload: {
            conversation_id: 'conversation-3',
            update_type: 'async-task-update-message',
            update_content: { private_body: 'must not be copied into event identity' },
          },
        },
      },
      {
        type: 'message',
        topic_id: 'alder-conversations',
        payload: {
          type: 'conversation-history-update',
          payload: {
            conversation_id: 'conversation-4',
          },
        },
      },
    ])

    expect(extractConversationEvents(frame)).toEqual([
      { conversationId: 'conversation-1', type: 'conversation-turn-complete', updateType: null, topic: 'conversations' },
      { conversationId: 'conversation-2', type: 'conversation-created', updateType: null, topic: 'conversations' },
      { conversationId: 'conversation-3', type: 'conversation-update', updateType: 'async-task-update-message', topic: 'conversations' },
      { conversationId: 'conversation-4', type: 'conversation-history-update', updateType: null, topic: 'alder-conversations' },
    ])
  })

  test('忽略非 conversation catalogue topic 与非法帧', () => {
    expect(extractConversationEvents('not-json')).toEqual([])
    expect(extractConversationEvents(JSON.stringify({
      topic_id: 'app_notifications',
      payload: { type: 'conversation-turn-complete', conversation_id: 'wrong-topic' },
    }))).toEqual([])
    expect(extractConversationEvents(JSON.stringify({
      topic_id: 'resource-updates',
      payload: { type: 'conversation-history-update', conversation_id: 'wrong-topic-2' },
    }))).toEqual([])
  })

  test('dirty 与 sync-ready 分离：真实 async update 建立 active，complete 才立即同步', () => {
    expect(classifyConversationEvent('conversation-turn-start')).toMatchObject({
      dirty: true,
      syncReady: false,
      startsTurn: true,
      completesTurn: false,
    })
    expect(classifyConversationEvent('conversation-created')).toMatchObject({
      dirty: true,
      syncReady: false,
      startsTurn: false,
    })
    expect(classifyConversationEvent('conversation-update', 'async-task-update-message')).toMatchObject({
      dirty: true,
      syncReady: false,
      startsTurn: true,
      asyncProgress: true,
    })
    // 2026-09-13 的统一桌面 App 逆向表明该事件会使 Chat history source refresh；
    // 但同日两次当前 Web 普通 turn 实验均未收到它，因此暂时只作为 stale/dirty 信号。
    // 在拿到“远端设备发消息 → Guardian 收到 history-update”的真实 frame 前，不擅自当 turn start。
    expect(classifyConversationEvent('conversation-history-update')).toMatchObject({
      dirty: true,
      syncReady: false,
      startsTurn: false,
    })
    expect(classifyConversationEvent('conversation-turn-complete')).toMatchObject({
      dirty: true,
      syncReady: true,
      completesTurn: true,
    })
    expect(classifyConversationEvent('conversation-title-generated')).toMatchObject({
      dirty: true,
      syncReady: false,
      startsTurn: false,
    })
  })

  test('realtime complete/watchdog/gap repair 允许 incident；startup 历史补账不允许', () => {
    expect(shouldClassifyTerminalForTrigger('wss:conversation-turn-complete')).toBe(true)
    expect(shouldClassifyTerminalForTrigger('watchdog:active-timeout')).toBe(true)
    expect(shouldClassifyTerminalForTrigger('reconcile:startup')).toBe(false)
    expect(shouldClassifyTerminalForTrigger('reconcile:periodic')).toBe(true)
    expect(shouldClassifyTerminalForTrigger('reconcile:wss-reconnect')).toBe(true)
    expect(shouldClassifyTerminalForTrigger('reconcile:guardian-recover')).toBe(true)
    expect(shouldClassifyTerminalForTrigger('reconcile:gap-repair')).toBe(true)
    expect(shouldClassifyTerminalForTrigger('reconcile:cooldown-recover')).toBe(true)
    expect(shouldClassifyTerminalForTrigger('wss:conversation-created')).toBe(false)

    expect(isConfirmedTerminalTrigger('wss:conversation-turn-complete')).toBe(true)
    expect(isConfirmedTerminalTrigger('reconcile:periodic:async-complete')).toBe(true)
    expect(isConfirmedTerminalTrigger('reconcile:periodic:async-complete:settle')).toBe(true)
    expect(isConfirmedTerminalTrigger('watchdog:active-timeout')).toBe(false)
    expect(isConfirmedTerminalTrigger('reconcile:wss-reconnect')).toBe(false)
    expect(shouldNotifyHistoricalIncidentForTrigger('reconcile:startup')).toBe(false)
    expect(shouldNotifyHistoricalIncidentForTrigger('watchdog:active-timeout')).toBe(false)
    expect(shouldNotifyHistoricalIncidentForTrigger('reconcile:gap-repair')).toBe(false)
  })

  test('complete 首次 body 未收敛时只延迟立案一次，settle 复核不再循环', () => {
    expect(shouldDeferConfirmedTerminalIncident(
      'wss:conversation-turn-complete',
      { terminalEvidence: 'none' },
    )).toBe(true)
    expect(shouldDeferConfirmedTerminalIncident(
      'wss:conversation-turn-complete:settle',
      { terminalEvidence: 'none' },
    )).toBe(false)
    expect(shouldDeferConfirmedTerminalIncident(
      'reconcile:periodic:async-complete',
      { terminalEvidence: 'none' },
    )).toBe(true)
    expect(shouldDeferConfirmedTerminalIncident(
      'wss:conversation-turn-complete',
      { terminalEvidence: 'final' },
    )).toBe(false)
    expect(shouldDeferConfirmedTerminalIncident(
      'wss:conversation-turn-complete',
      { terminalEvidence: 'interrupted' },
    )).toBe(false)
    expect(shouldDeferConfirmedTerminalIncident(
      'watchdog:active-timeout',
      { terminalEvidence: 'none' },
    )).toBe(false)
  })

  test('conversation list async_status 只把已实测值分类为 active/complete', () => {
    expect(classifyCatalogAsyncStatus(3)).toBe('active')
    expect(classifyCatalogAsyncStatus('3')).toBe('active')
    expect(classifyCatalogAsyncStatus(5)).toBe('active')
    expect(classifyCatalogAsyncStatus(4)).toBe('complete')
    expect(classifyCatalogAsyncStatus(null)).toBe('unknown')
    expect(classifyCatalogAsyncStatus(0)).toBe('unknown')
    expect(classifyCatalogAsyncStatus('garbled')).toBe('unknown')
  })

  test('catalog active 建立保守 late-start，并抑制同一已终止 update 的重复 watchdog', () => {
    expect(shouldStartCatalogWatchdog({
      alreadyActive: false,
      catalogUpdateTime: 200,
      archivedUpdateTime: 100,
      archivedTerminalState: 'final',
    })).toBe(true)
    expect(shouldStartCatalogWatchdog({
      alreadyActive: false,
      catalogUpdateTime: 100,
      archivedUpdateTime: 100,
      archivedTerminalState: 'final',
    })).toBe(false)
    expect(shouldStartCatalogWatchdog({
      alreadyActive: false,
      catalogUpdateTime: 100,
      archivedUpdateTime: 100,
      archivedTerminalState: 'none',
    })).toBe(true)
    expect(shouldStartCatalogWatchdog({ alreadyActive: true })).toBe(false)

    expect(watchdogTriggerForStartType('catalog:async-active:wss-reconnect')).toBe('watchdog:catalog-active-timeout')
    expect(watchdogTriggerForStartType('conversation-update:async-task-update-message')).toBe('watchdog:active-timeout')
    expect(incidentKindForTrigger('watchdog:catalog-active-timeout')).toBe('watchdog-timeout')
    expect(incidentKindForTrigger('watchdog:catalog-active-timeout', { catalogStillActive: true })).toBe('active-zombie')
    expect(incidentKindForTrigger('watchdog:active-timeout', { catalogStillActive: true })).toBe('active-zombie')
    expect(incidentKindForTrigger('watchdog:active-timeout')).toBe('watchdog-timeout')
    expect(incidentKindForTrigger('wss:conversation-turn-complete')).toBe('abnormal-terminal')
  })

  test('Watchdog 来源不决定 lifecycle；同 turn timeout + 后续 catalog active 才 promotion 为 Active Zombie', () => {
    const active = {
      lastWatchdogAt: 10_000,
      lastDiagnosticTurnKey: 'turn-a',
      startType: 'devspace:first-tool',
    }
    const incident = {
      turnKey: 'turn-a',
      status: 'open',
      lifecycleClass: 'watchdog-timeout',
      terminalEvidence: 'none',
    }
    expect(shouldPromoteWatchdogTimeoutToActiveZombie(active, incident, true)).toBe(true)
    expect(shouldPromoteWatchdogTimeoutToActiveZombie(active, incident, false)).toBe(false)
    expect(shouldPromoteWatchdogTimeoutToActiveZombie(active, { ...incident, turnKey: 'turn-b' }, true)).toBe(false)
    expect(shouldPromoteWatchdogTimeoutToActiveZombie(active, { ...incident, terminalEvidence: 'final' }, true)).toBe(false)
  })

  test('catalog generation 已诊断后保持 tombstone；真实 progress 只能记证据，不能重新武装', () => {
    expect(shouldCloseWatchdogGenerationAfterSync('watchdog:catalog-active-timeout', {
      watchdogTurnChanged: false,
      watchdogTurnAlreadyTimedOut: false,
    })).toBe(false)

    const diagnosed = {
      startedAt: 1_000,
      lastEventAt: 1_000,
      lastWatchdogAt: 46 * 60_000,
      watchdogPendingAt: null,
      startType: 'catalog:async-active:gap-repair',
      lastDiagnosticTurnKey: 'turn-a',
    }
    const progressed = recordCatalogWatchdogProgress(diagnosed, 100 * 60_000)
    expect(progressed).toEqual({
      ...diagnosed,
      lastEventAt: 100 * 60_000,
    })
    expect(shouldQueueWatchdogDiagnostic(progressed, 100 * 60_000 + 45 * 60_000, 45 * 60_000)).toBe(false)
  })

  test('DevSpace audit overlap 的 seen-id 只在 cursor 已越过查询下界后删除', () => {
    // 即使这条事件现实中已经过去很多小时，只要 cursor 仍停在它附近，下一轮 overlap
    // 仍会把它查出来，所以必须继续保留去重。
    expect(shouldRetainSeenDevSpaceAudit(1_000, 1_001, 10_000)).toBe(true)
    expect(shouldRetainSeenDevSpaceAudit(10_000, 20_000, 10_000)).toBe(true)
    // cursor 前进到查询下界已经严格越过该事件后，才可安全释放 seen-id。
    expect(shouldRetainSeenDevSpaceAudit(9_999, 20_000, 10_000)).toBe(false)
  })

  test('watchdog 首次超时只调查一次；同 turn 后续新进展也绝不重新武装', () => {
    const watchdogMs = 30 * 60_000
    const active = { startedAt: 0, lastEventAt: 0, lastWatchdogAt: null }
    expect(shouldQueueWatchdogDiagnostic(active, watchdogMs - 1, watchdogMs)).toBe(false)
    expect(shouldQueueWatchdogDiagnostic(active, watchdogMs, watchdogMs)).toBe(true)

    const diagnosed = { ...active, lastWatchdogAt: watchdogMs }
    // 没有任何新进展时，即使又过很多个 watchdog 窗口也不重复抓 body。
    expect(shouldQueueWatchdogDiagnostic(diagnosed, watchdogMs * 2, watchdogMs)).toBe(false)
    expect(shouldQueueWatchdogDiagnostic(diagnosed, watchdogMs * 20, watchdogMs)).toBe(false)

    const progressed = { ...diagnosed, lastEventAt: watchdogMs + 5_000 }
    expect(shouldQueueWatchdogDiagnostic(progressed, watchdogMs * 2, watchdogMs)).toBe(false)
    expect(shouldQueueWatchdogDiagnostic(progressed, watchdogMs * 20, watchdogMs)).toBe(false)
  })

  test('同一 unbound timeout generation 对每个 CID 只做一次 bounded body probe', () => {
    const first = planDevSpaceBindingProbes({
      generation: 'meta-a:1000',
      previousGeneration: '',
      probedConversationIds: [],
      candidateConversationIds: ['c1', 'c2'],
    })
    expect(first.targets).toEqual(['c1', 'c2'])

    const repeated = planDevSpaceBindingProbes({
      generation: 'meta-a:1000',
      previousGeneration: first.generation,
      probedConversationIds: first.probedConversationIds,
      candidateConversationIds: ['c1', 'c2'],
    })
    expect(repeated.targets).toEqual([])

    const newCandidate = planDevSpaceBindingProbes({
      generation: 'meta-a:1000',
      previousGeneration: repeated.generation,
      probedConversationIds: repeated.probedConversationIds,
      candidateConversationIds: ['c1', 'c2', 'c3'],
    })
    expect(newCandidate.targets).toEqual(['c3'])

    const nextGeneration = planDevSpaceBindingProbes({
      generation: 'meta-a:1000|meta-b:2000',
      previousGeneration: newCandidate.generation,
      probedConversationIds: newCandidate.probedConversationIds,
      candidateConversationIds: ['c1', 'c2'],
    })
    expect(nextGeneration.targets).toEqual(['c1', 'c2'])
  })

  test('DevSpace first-tool 新 turn 不能继承上一轮 binding 的 turn key', () => {
    const active = devSpaceFirstToolWatchdogState(1_000)
    expect(active).toEqual({
      startedAt: 1_000,
      lastEventAt: 1_000,
      lastWatchdogAt: null,
      watchdogPendingAt: null,
      startType: 'devspace:first-tool',
      lastDiagnosticTurnKey: null,
    })

    // 第一次 45min body 才认识本轮 turn；这不是“换 turn”，因此 startedAt 不得重置。
    const firstDiagnostic = reconcileWatchdogDiagnosticTurn(
      { ...active, lastWatchdogAt: 46_000 },
      { turnExchangeId: 'turn-current' },
      50_000,
    )
    expect(firstDiagnostic.changed).toBe(false)
    expect(firstDiagnostic.nextActive).toMatchObject({
      startedAt: 1_000,
      lastDiagnosticTurnKey: 'turn-current',
    })
  })

  test('catalog watchdog 不能把旧 turn 的计时跨到同 conversation 的新 turn', () => {
    const active = {
      startedAt: 0,
      lastEventAt: 0,
      lastWatchdogAt: 30 * 60_000,
      lastDiagnosticTurnKey: 'turn-a',
      startType: 'catalog:async-active:periodic',
    }
    expect(watchdogDiagnosticTurnKey({
      turnExchangeId: 'turn-b', requestId: 'req-b', userMessageId: 'user-b', lastMessageId: 'last-b',
    })).toBe('turn-b')

    const changed = reconcileWatchdogDiagnosticTurn(active, { turnExchangeId: 'turn-b' }, 40 * 60_000)
    expect(changed).toMatchObject({ changed: true, turnKey: 'turn-b' })
    expect(changed.nextActive).toMatchObject({
      startedAt: 40 * 60_000,
      lastEventAt: 40 * 60_000,
      lastWatchdogAt: null,
      lastDiagnosticTurnKey: 'turn-b',
    })
    expect(shouldQueueWatchdogDiagnostic(changed.nextActive, 70 * 60_000 - 1, 30 * 60_000)).toBe(false)
    expect(shouldQueueWatchdogDiagnostic(changed.nextActive, 70 * 60_000, 30 * 60_000)).toBe(true)

    const same = reconcileWatchdogDiagnosticTurn(changed.nextActive, { turnExchangeId: 'turn-b' }, 71 * 60_000)
    expect(same.changed).toBe(false)
    expect(same.nextActive.startedAt).toBe(40 * 60_000)
  })

  test('晚发现新 turn 时优先使用 body 里的真实 user create_time，而不是发现时刻重新计 45 分钟', () => {
    const userStartedAtMs = 100_000
    const payload = {
      messages: [{
        id: 'user-b',
        author: { role: 'user' },
        create_time: userStartedAtMs / 1000,
        metadata: { turn_exchange_id: 'turn-b', request_id: 'req-b' },
      }],
    }
    const diagnostic = { turnExchangeId: 'turn-b', requestId: 'req-b', userMessageId: 'user-b' }
    expect(watchdogTurnStartedAtFromPayload(payload, diagnostic)).toBe(userStartedAtMs)

    const reconciled = reconcileWatchdogDiagnosticTurn({
      startedAt: 0,
      lastEventAt: 120_000,
      lastWatchdogAt: 90_000,
      watchdogPendingAt: 90_000,
      lastDiagnosticTurnKey: 'turn-a',
      startType: 'catalog:async-active:gap-repair',
    }, diagnostic, 4_000_000, userStartedAtMs)

    expect(reconciled).toMatchObject({
      changed: true,
      turnKey: 'turn-b',
      turnStartedAt: userStartedAtMs,
      turnStartSource: 'body-user-create-time',
    })
    expect(reconciled.nextActive).toMatchObject({
      startedAt: userStartedAtMs,
      lastEventAt: 120_000,
      lastWatchdogAt: null,
      watchdogPendingAt: null,
      lastDiagnosticTurnKey: 'turn-b',
    })
  })

  test('watchdog 诊断后保留 tombstone；明确 terminal/new turn 再由其它路径结束或替换', () => {
    expect(shouldCloseWatchdogGenerationAfterSync('watchdog:active-timeout', {
      watchdogTurnChanged: false,
      watchdogTurnAlreadyTimedOut: false,
    })).toBe(false)
    expect(shouldCloseWatchdogGenerationAfterSync('watchdog:catalog-active-timeout', {
      watchdogTurnChanged: true,
      watchdogTurnAlreadyTimedOut: false,
    })).toBe(false)
    expect(shouldCloseWatchdogGenerationAfterSync('watchdog:catalog-active-timeout', {
      watchdogTurnChanged: true,
      watchdogTurnAlreadyTimedOut: true,
    })).toBe(false)
    expect(shouldCloseWatchdogGenerationAfterSync('wss:conversation-turn-complete', {
      watchdogTurnChanged: false,
      watchdogTurnAlreadyTimedOut: true,
    })).toBe(false)
  })

  test('daemon 重启继承未过期的 429 cooldown，但不复活旧 cooldown', () => {
    expect(restoreCooldownUntil({ cooldownUntil: 2000 }, 1000)).toBe(2000)
    expect(restoreCooldownUntil({ cooldownUntil: 1000 }, 1000)).toBe(0)
    expect(restoreCooldownUntil({ cooldownUntil: 999 }, 1000)).toBe(0)
    expect(restoreCooldownUntil({ cooldownUntil: 'garbled' }, 1000)).toBe(0)
    expect(restoreCooldownUntil(null, 1000)).toBe(0)
    expect(activeApiAllowed(2000, 1000)).toBe(false)
    expect(activeApiAllowed(1000, 1000)).toBe(true)
    expect(activeApiAllowed(0, 1000)).toBe(true)
  })

  test('429 cooldown 优先服从 Retry-After，并保留短安全下限与 fallback', () => {
    const now = Date.parse('2026-10-10T19:35:31.000Z')
    expect(cooldownDeadlineFromRetryAfter('16', { now })).toBe(now + 30_000)
    expect(cooldownDeadlineFromRetryAfter('120', { now })).toBe(now + 125_000)
    expect(cooldownDeadlineFromRetryAfter('Fri, 10 Oct 2026 19:36:31 GMT', { now }))
      .toBe(Date.parse('2026-10-10T19:36:36.000Z'))
    expect(cooldownDeadlineFromRetryAfter(null, { now, fallbackMs: 90_000 })).toBe(now + 90_000)
    expect(cooldownDeadlineFromRetryAfter('garbled', { now, fallbackMs: 90_000 })).toBe(now + 90_000)
  })

  test('passive observer 不重复熔断 daemon 自己的 active replay 429', () => {
    const active = '/backend-api/conversations/c1?include_has_versions=true&num_turns=10'
    expect(shouldTripObserved429(
      'https://chatgpt.com/backend-api/conversations/c1?include_has_versions=true&num_turns=10',
      active,
    )).toBe(false)
    expect(shouldTripObserved429(
      'https://chatgpt.com/backend-api/conversations/c2?include_has_versions=true&num_turns=10',
      active,
    )).toBe(true)
    expect(shouldTripObserved429(
      'https://chatgpt.com/backend-api/conversations/c1?include_has_versions=true&num_turns=20',
      active,
    )).toBe(true)
  })

  test('Watchdog cooldown deferred 通知明确“已到点但尚未归因”并带聊天链接', () => {
    const payload = buildWatchdogDeferredNotificationPayload({
      conversationId: 'conversation-a',
      title: '继续处理异常终止',
      startedAt: 1_000,
      now: 46 * 60_000 + 1_000,
      cooldownUntil: 60 * 60_000,
    })
    expect(payload.title).toBe('Watchdog · 超时待诊断')
    expect(payload.subtitle).toBe('继续处理异常终止')
    expect(payload.body).toContain('46m')
    expect(payload.body).toContain('429 冷却至')
    expect(payload.group).toBe('Chat/conversation-a')
    expect(payload.url).toContain('/c/conversation-a')
  })

  test('Watchdog 到点通知与诊断结果通知是两条独立稳定文案', () => {
    const timeout = buildWatchdogTimeoutNotificationPayload({
      conversationId: 'conversation-a',
      title: '长任务',
      startedAt: 1_000,
      now: 46 * 60_000 + 1_000,
    })
    expect(timeout.title).toBe('Watchdog · 超时')
    expect(timeout.subtitle).toBe('长任务')
    expect(timeout.body).toContain('46m')
    expect(timeout.body).toContain('起点')
    expect(timeout.body).not.toContain('不会重新启动 Watchdog')
    expect(timeout.group).toBe('Chat/conversation-a')

    const longTimeoutTitle = '这是一个特别特别特别特别特别长的Watchdog聊天标题'
    const longTimeout = buildWatchdogTimeoutNotificationPayload({
      conversationId: 'conversation-long',
      title: longTimeoutTitle,
      startedAt: 1_000,
      now: 46 * 60_000 + 1_000,
    })
    expect(longTimeout.title).toBe('Watchdog · 超时')
    expect(longTimeout.subtitle).toBe(longTimeoutTitle)

    const diagnosis = buildWatchdogDiagnosisNotificationPayload({
      conversationId: 'conversation-a',
      title: '长任务',
      diagnostic: { terminalEvidence: 'none', tailShape: 'tool-result-returned', headState: 'aligned' },
      incident: {
        reason: '最新工具结果已经回来，但尚无 final。',
        lifecycleClass: 'active-zombie',
        headState: 'aligned',
        evidenceTypes: ['canonical-tail-gap'],
      },
    })
    expect(diagnosis.title).toBe('Watchdog · Body 缺口')
    expect(diagnosis.subtitle).toBe('长任务')
    expect(diagnosis.body).toBe('DevSpace 审计晚于 canonical')
    expect(diagnosis.body).not.toContain('active-zombie')
    expect(diagnosis.body).not.toContain('watchdog-timeout')
    expect(diagnosis.body).not.toContain('terminal：')
    expect(diagnosis.body).not.toContain('tail：')
    expect(diagnosis.body).not.toContain('head：')
    expect(diagnosis.group).toBe('Chat/conversation-a')

    const finalDiagnosis = buildWatchdogDiagnosisNotificationPayload({
      conversationId: 'conversation-a',
      title: '长任务',
      diagnostic: { terminalEvidence: 'final', tailShape: 'final' },
    })
    expect(finalDiagnosis.title).toBe('Watchdog · Final 已确认')
    expect(finalDiagnosis.subtitle).toBe('长任务')
    expect(finalDiagnosis.body).toBe('未发现 Body 缺口')
    expect(finalDiagnosis.group).toBe('Chat/conversation-a')

    const noFinalNoGap = buildWatchdogDiagnosisNotificationPayload({
      conversationId: 'conversation-a',
      title: '长任务',
      diagnostic: { terminalEvidence: 'none', tailShape: 'reasoning-open' },
      incident: { lifecycleClass: 'watchdog-timeout', evidenceTypes: [] },
    })
    expect(noFinalNoGap.title).toBe('Watchdog · 未确认 Final')
    expect(noFinalNoGap.body).toBe('未发现 Body 缺口')

    const longDiagnosisTitle = '这是一个特别特别特别特别特别长的Watchdog聊天标题'
    const longDiagnosis = buildWatchdogDiagnosisNotificationPayload({
      conversationId: 'conversation-long',
      title: longDiagnosisTitle,
      diagnostic: { terminalEvidence: 'none', tailShape: 'tool-result-returned' },
      incident: { lifecycleClass: 'active-zombie', evidenceTypes: ['canonical-tail-gap'] },
    })
    expect(longDiagnosis.title).toBe('Watchdog · Body 缺口')
    expect(longDiagnosis.subtitle).toBe(longDiagnosisTitle)
    expect(longDiagnosis.body).toBe('DevSpace 审计晚于 canonical')
  })

  test('Watchdog generation 建立时给出可直接估算超时点的起点通知', () => {
    const start = buildWatchdogStartNotificationPayload({
      conversationId: 'conversation-a',
      title: '长任务',
      startedAt: 1_000,
      watchdogMs: 45 * 60_000,
    })
    expect(start.title).toBe('Watchdog · 开始')
    expect(start.subtitle).toBe('长任务')
    expect(start.body).toBe('08:00 → 08:45 · 45m')
    expect(start.group).toBe('Chat/conversation-a')
    expect(start.url).toContain('/c/conversation-a')

    const longTitle = '这是一个特别特别特别特别特别长的Watchdog聊天标题'
    const longStart = buildWatchdogStartNotificationPayload({
      conversationId: 'conversation-long',
      title: longTitle,
      startedAt: 1_000,
    })
    expect(longStart.title).toBe('Watchdog · 开始')
    expect(longStart.subtitle).toBe(longTitle)
    expect(longStart.body).toBe('08:00 → 08:45 · 45m')

    expect(watchdogStartNotificationKey('conversation-a', 1_000))
      .toBe('watchdog-start:conversation-a:1000')
    expect(watchdogStartNotificationKey('conversation-a', 2_000))
      .toBe('watchdog-start:conversation-a:2000')
    expect(watchdogStartNotificationKey('', 1_000)).toBeNull()

    const unbound = buildWatchdogStartNotificationPayload({
      metadataId: 'v1/abcdefgh12345678',
      title: '排查 Watchdog',
      startedAt: 1_000,
    })
    expect(unbound.title).toBe('Watchdog · 开始')
    expect(unbound.subtitle).toBe('排查 Watchdog · 未绑定')
    expect(unbound.body).toBe('08:00 → 08:45 · 45m')
    expect(unbound.body).not.toContain('meta/abcdefgh')
    expect(unbound).not.toHaveProperty('url')

    const unboundLongTitle = '这是一个特别特别特别特别特别长的未绑定聊天标题'
    const unboundLong = buildWatchdogStartNotificationPayload({
      metadataId: 'v1/abcdefgh12345678',
      title: unboundLongTitle,
      startedAt: 1_000,
    })
    expect(unboundLong.title).toBe('Watchdog · 开始')
    expect(unboundLong.subtitle).toBe(`${unboundLongTitle} · 未绑定`)

    const titleMissing = buildWatchdogStartNotificationPayload({
      metadataId: 'v1/abcdefgh12345678',
      startedAt: 1_000,
    })
    expect(titleMissing.title).toBe('Watchdog · 开始')
    expect(titleMissing.subtitle).toBe('meta/abcdefgh · 未绑定')
    expect(titleMissing.body).not.toContain('v1/abcdefgh12345678')

    expect(unboundWatchdogStartNotificationKey('v1/abcdefgh12345678', 1_000))
      .toBe('watchdog-start-unbound:v1/abcdefgh12345678:1000')
    expect(unboundWatchdogStartNotificationKey('', 1_000)).toBeNull()
  })

  test('Watchdog 起点标题只在 canonical 仍是占位符时使用 DevSpace displayTitle', () => {
    expect(preferredWatchdogStartTitle({
      conversationId: 'conversation-a',
      canonicalTitle: 'New chat',
      devSpaceTitles: ['排查 Watchdog 漏通知并新增开始通知'],
    })).toBe('排查 Watchdog 漏通知并新增开始通知')

    expect(preferredWatchdogStartTitle({
      conversationId: 'conversation-a',
      canonicalTitle: '新聊天',
      devSpaceTitles: ['本轮工作主题'],
    })).toBe('本轮工作主题')

    expect(preferredWatchdogStartTitle({
      conversationId: 'conversation-a',
      canonicalTitle: '正式聊天标题',
      devSpaceTitles: ['内部工作主题'],
    })).toBe('正式聊天标题')

    expect(preferredWatchdogStartTitle({
      conversationId: 'conversation-a',
      canonicalTitle: 'conversation-a',
      devSpaceTitles: [null, ' ', '可读主题'],
    })).toBe('可读主题')

    expect(preferredWatchdogStartTitle({
      conversationId: 'conversation-a',
      canonicalTitle: 'New chat',
      devSpaceTitles: [],
    })).toBe('New chat')
  })

  test('未绑定 watchdog 不把 metadata ID 塞进标题', () => {
    const payload = buildUnboundWatchdogNotificationPayload({
      metadataId: 'v1/abcdefghijklmnopqrstuvwxyz0123456789',
      startedAt: 1_000,
      now: 50 * 60_000 + 1_000,
    })
    expect(payload.title).toBe('Watchdog · 超时未绑定')
    expect(payload.subtitle).toBe('meta/abcdefgh · 未绑定')
    expect(payload.body).toContain('50m')
    expect(payload.body).not.toContain('v1/abcdefghijklmnopqrstuvwxyz0123456789')
    expect(payload.group).toBe('Chat/meta/abcdefgh')
    expect(payload).not.toHaveProperty('url')
  })

  test('未绑定 watchdog 的最终诊断明确暴露 canonical Body 缺失并跨重启稳定去重', () => {
    const metadataId = 'v1/abcdefghijklmnopqrstuvwxyz0123456789'
    const payload = buildUnboundWatchdogDiagnosisNotificationPayload({
      metadataId,
      title: 'Case 4 PBL 第一幕作业与PPT资料整合',
      recoveryAuditCount: 29,
    })
    expect(payload.title).toBe('Watchdog · 诊断')
    expect(payload.subtitle).toBe('Case 4 PBL 第一幕作业与PPT资料整合 · 未绑定')
    expect(payload.body).toBe('未绑定 · canonical Body 未取得 · recovery 29')
    expect(payload.group).toBe('Chat/meta/abcdefgh')
    expect(unboundWatchdogDiagnosisNotificationKey(metadataId, 1_234)).toBe(
      'watchdog-diagnosis-unbound:v1/abcdefghijklmnopqrstuvwxyz0123456789:1234',
    )
  })

  test('正常 final 只在在线终态/Watchdog 路径通知，历史 startup/periodic 不补轰炸', () => {
    const diagnostic = { terminalEvidence: 'final', hasImageGenerationFinal: false, imageGenerationCount: 0 }
    expect(shouldNotifyTurnFinal('wss:conversation-turn-complete', diagnostic)).toBe(true)
    expect(shouldNotifyTurnFinal('wss:conversation-turn-complete:settle', diagnostic)).toBe(true)
    expect(shouldNotifyTurnFinal('watchdog:active-timeout', diagnostic)).toBe(true)
    expect(shouldNotifyTurnFinal('checkpoint:body-terminal', diagnostic)).toBe(true)
    expect(shouldNotifyTurnFinal('reconcile:gap-repair', diagnostic)).toBe(true)
    expect(shouldNotifyTurnFinal('reconcile:wss-reconnect', diagnostic)).toBe(true)
    expect(shouldNotifyTurnFinal('reconcile:guardian-recover', diagnostic)).toBe(true)
    expect(shouldNotifyTurnFinal('reconcile:cooldown-recover', diagnostic)).toBe(true)
    expect(shouldNotifyTurnFinal('reconcile:startup', diagnostic)).toBe(false)
    expect(shouldNotifyTurnFinal('reconcile:periodic', diagnostic)).toBe(false)
    expect(shouldNotifyTurnFinal('wss:conversation-turn-complete', { terminalEvidence: 'none' })).toBe(false)

    const payload = buildTurnFinalNotificationPayload({
      conversationId: 'conversation-a',
      title: '正常长任务',
      diagnostic,
    })
    expect(payload.title).toBe('Turn · 完成')
    expect(payload.subtitle).toBe('正常长任务')
    expect(payload.body).toBe('Final 已确认')
    expect(payload.group).toBe('Chat/conversation-a')

    const longTitle = '这是一个非常非常非常非常非常长的正常完成聊天标题'
    const long = buildTurnFinalNotificationPayload({
      conversationId: 'conversation-long',
      title: longTitle,
      diagnostic: { hasImageGenerationFinal: true, imageGenerationCount: 3 },
    })
    expect(long.title).toBe('Turn · 完成')
    expect(long.subtitle).toBe(longTitle)
    expect(long.body).toBe('Final 已确认 · 3 张图片')
  })

  test('短 WSS/gap repair 只需一整页稳定 overlap，startup/periodic 继续深扫描', () => {
    expect(catalogStableOverlapTarget('wss-reconnect', { pageSize: 28, deepThreshold: 56 })).toBe(28)
    expect(catalogStableOverlapTarget('gap-repair', { pageSize: 28, deepThreshold: 56 })).toBe(28)
    expect(catalogStableOverlapTarget('startup', { pageSize: 28, deepThreshold: 56 })).toBe(28)
    expect(catalogStableOverlapTarget('periodic', { pageSize: 28, deepThreshold: 84 })).toBe(84)
    expect(catalogStableOverlapTarget('guardian-recover', { pageSize: 28, deepThreshold: 56 })).toBe(28)
    // deepThreshold 即使被错误配置得比一页还小，也不能让深同步比短 gap 更激进。
    expect(catalogStableOverlapTarget('startup', { pageSize: 28, deepThreshold: 1 })).toBe(28)
  })

  test('conversation backend URL 分类能区分全量 list、TPP list、正文和 cursor', () => {
   expect(classifyConversationBackendUrl('/backend-api/conversations?offset=0&limit=28&order=updated&is_archived=false&is_starred=false')).toEqual({
      kind: 'catalog', offset: 0, limit: 28, globalCatalog: true, conversationOrigin: null, excludeConversationOrigin: null, hideSnorlax: null,
   })
    expect(classifyConversationBackendUrl('/backend-api/conversations?offset=0&limit=28&order=updated')).toMatchObject({
      kind: 'catalog', globalCatalog: true,
    })
   expect(classifyConversationBackendUrl('/backend-api/conversations?conversation_origin=tpp&expand=false&hide_snorlax=false&limit=20&order=updated&offset=0')).toMatchObject({
     kind: 'catalog', offset: 0, limit: 20, globalCatalog: false, conversationOrigin: 'tpp',
   })
    expect(classifyConversationBackendUrl('/backend-api/conversations?exclude_conversation_origin=tpp&expand=false&hide_snorlax=false&is_archived=false&is_starred=false&limit=20&order=updated&offset=0')).toMatchObject({
      kind: 'catalog', offset: 0, limit: 20, globalCatalog: false, conversationOrigin: null, excludeConversationOrigin: 'tpp',
    })
    expect(classifyConversationBackendUrl('/backend-api/gizmos/snorlax/sidebar?conversations_per_gizmo=5&limit=20&owned_only=false')).toEqual({
      kind: 'project-sidebar',
      limit: 20,
      conversationsPerGizmo: 5,
      ownedOnly: 'false',
      cursor: null,
    })
    expect(classifyConversationBackendUrl('/backend-api/gizmos/g-p-test/conversations?cursor=abc&limit=5&owned_only=false')).toEqual({
      kind: 'project-catalog',
      gizmoId: 'g-p-test',
      limit: 5,
      ownedOnly: 'false',
      cursor: 'abc',
    })
    expect(classifyConversationBackendUrl('/backend-api/conversations/c1?include_has_versions=true&num_turns=10')).toEqual({
      kind: 'body-latest', conversationId: 'c1',
    })
    expect(classifyConversationBackendUrl('/backend-api/conversations/c1/messages?before=abc&include_has_versions=true&num_turns=10')).toEqual({
      kind: 'body-cursor', conversationId: 'c1', before: 'abc',
    })
    expect(classifyConversationBackendUrl('/backend-api/conversation/c1')).toEqual({ kind: 'mapping', conversationId: 'c1' })
    expect(classifyConversationBackendUrl('https://example.com/backend-api/conversations?offset=0')).toBeNull()
  })

  test('Project sidebar parser flattens nested recent conversations without treating them as Body', () => {
    const parsed = extractProjectCatalogPayload({ kind: 'project-sidebar' }, {
      cursor: null,
      items: [
        {
          gizmo: {
            gizmo: {
              id: 'g-p-one',
              display: { name: 'Project One' },
            },
          },
          conversations: {
            cursor: 'next-conversations',
            items: [
              { id: 'cid-1', title: 'One', update_time: '2026-10-18T00:00:00Z', mapping: null },
              { id: 'cid-2', title: 'Two', update_time: '2026-10-17T00:00:00Z', mapping: null },
            ],
          },
        },
      ],
    })
    expect(parsed).toMatchObject({
      cursor: null,
      projects: [{
        projectId: 'g-p-one',
        projectName: 'Project One',
        cursor: 'next-conversations',
        conversationCount: 2,
      }],
    })
    expect(parsed.conversations.map(item => item.id)).toEqual(['cid-1', 'cid-2'])
  })

  test('Guardian cooldown block 只匹配 conversation REST；passive body 必须足够新才可替代 replay', () => {
    expect(shouldBlockGuardianConversationRest('https://chatgpt.com/backend-api/conversations?offset=0&limit=28&order=updated&is_archived=false&is_starred=false')).toBe(true)
    expect(shouldBlockGuardianConversationRest('https://chatgpt.com/backend-api/conversations/c1?num_turns=10')).toBe(true)
    expect(shouldBlockGuardianConversationRest('https://chatgpt.com/backend-api/gizmos/snorlax/sidebar?conversations_per_gizmo=5&limit=20&owned_only=false')).toBe(true)
    expect(shouldBlockGuardianConversationRest('wss://chatgpt.com/ws')).toBe(false)
    expect(passiveObservationMatchesReady(10_000, 9_000)).toBe(true)
    expect(passiveObservationMatchesReady(8_000, 10_000, 1_500)).toBe(false)
    expect(passiveObservationMatchesReady(8_600, 10_000, 1_500)).toBe(true)
  })

  test('Guardian REST unblock 永远真实下发，未知状态不能信任 cached false', () => {
    expect(shouldApplyGuardianConversationRestBlockCommand(false, false, false)).toBe(true)
    expect(shouldApplyGuardianConversationRestBlockCommand(false, true, false)).toBe(true)
    expect(shouldApplyGuardianConversationRestBlockCommand(true, false, false)).toBe(true)
    expect(shouldApplyGuardianConversationRestBlockCommand(true, true, false)).toBe(false)
    expect(shouldApplyGuardianConversationRestBlockCommand(true, false, true)).toBe(true)
    expect(shouldApplyGuardianConversationRestBlockCommand(true, true, true)).toBe(true)
  })

  test('conversation page fetch 只对 Runtime.evaluate timeout 重试', () => {
    expect(shouldRetryConversationPageFetch(new Error('CDP Runtime.evaluate timed out after 10000ms'))).toBe(true)
    expect(shouldRetryConversationPageFetch(new Error('CDP Network.enable timed out after 10000ms'))).toBe(false)
    expect(shouldRetryConversationPageFetch(new Error('HTTP 429'))).toBe(false)
  })

  test('cooldown 恢复期先 slow-start，成功探针清零后恢复正常间隔', () => {
    expect(effectiveActiveRequestGap(6000, 3, 30_000)).toBe(30_000)
    expect(effectiveActiveRequestGap(5000, 1, 30_000)).toBe(30_000)
    expect(effectiveActiveRequestGap(6000, 0, 30_000)).toBe(6000)
    expect(effectiveActiveRequestGap(60_000, 2, 30_000)).toBe(60_000)
  })

  test('Guardian 单次/偶发 CDP 探活失败不会立刻拆页，连续达到阈值才重建', () => {
    expect(shouldRebuildGuardianAfterHealthFailures(1, 3)).toBe(false)
    expect(shouldRebuildGuardianAfterHealthFailures(2, 3)).toBe(false)
    expect(shouldRebuildGuardianAfterHealthFailures(3, 3)).toBe(true)
    expect(shouldRebuildGuardianAfterHealthFailures(4, 3)).toBe(true)
    expect(shouldRebuildGuardianAfterHealthFailures(1, 1)).toBe(true)
  })

  test('Guardian 账户加载错误页属于 UI 自愈，不应当作 DOM baseline 漂移', () => {
    expect(guardianUiFailureKind({
      ready: 'complete',
      composerPresent: false,
      accountLoadFailure: true,
    })).toBe('account-load-failure')
    expect(guardianUiFailureKind({
      ready: 'loading',
      composerPresent: false,
      accountLoadFailure: true,
    })).toBeNull()
    expect(guardianUiFailureKind({
      ready: 'complete',
      composerPresent: true,
      accountLoadFailure: true,
    })).toBeNull()
    expect(guardianUiFailureKind({
      ready: 'complete',
      composerPresent: false,
      accountLoadFailure: false,
    })).toBeNull()
    expect(guardianUiFailureKind({
      href: 'chrome-error://chromewebdata/',
      ready: 'complete',
      composerPresent: false,
      accountLoadFailure: false,
    })).toBe('wrong-document')
    expect(guardianUiFailureKind({
      href: 'about:blank',
      ready: 'complete',
      composerPresent: false,
      accountLoadFailure: false,
    })).toBe('wrong-document')
    expect(guardianUiFailureKind({
      href: 'https://chatgpt.com/',
      ready: 'complete',
      composerPresent: true,
      accountLoadFailure: false,
    })).toBeNull()
  })

  test('daemon singleton lease rejects a second process-level owner', async () => {
    const first = await acquireArchiveDaemonSingleton({ port: 0 })
    try {
      const address = first.address()
      expect(address && typeof address === 'object').toBe(true)
      const port = address && typeof address === 'object' ? address.port : 0
      await expect(acquireArchiveDaemonSingleton({ port })).rejects.toMatchObject({ code: 'EADDRINUSE' })
    }
    finally {
      await new Promise<void>(resolve => first.close(() => resolve()))
    }
  })

  test('deferred gap repair 必须等待 WSS/debounce；cooldown 时仅允许已有 passive catalog 的纯被动 repair', () => {
    const base = {
      pendingLastAt: 100_000,
      lastAttemptAt: 0,
      delayMs: 30_000,
      minIntervalMs: 600_000,
      activeSockets: 1,
      authAvailable: true,
      cooldownUntil: 0,
      reconcileInFlight: false,
    }
    expect(shouldRunDeferredGapRepair({ ...base, now: 129_999 })).toBe(false)
    expect(shouldRunDeferredGapRepair({ ...base, now: 130_000 })).toBe(true)
    expect(shouldRunDeferredGapRepair({ ...base, now: 999_999, activeSockets: 0 })).toBe(false)
    expect(shouldRunDeferredGapRepair({ ...base, now: 999_999, authAvailable: false })).toBe(false)
    expect(shouldRunDeferredGapRepair({ ...base, now: 999_999, cooldownUntil: 1_000_000 })).toBe(false)
    expect(shouldRunDeferredGapRepair({
      ...base,
      now: 999_999,
      authAvailable: false,
      cooldownUntil: 1_000_000,
      passiveCatalogAvailable: true,
    })).toBe(true)
    expect(shouldRunDeferredGapRepair({
      ...base,
      now: 700_000,
      pendingLastAt: 650_000,
      lastAttemptAt: 200_000,
    })).toBe(false)
    expect(shouldRunDeferredGapRepair({
      ...base,
      now: 800_000,
      pendingLastAt: 650_000,
      lastAttemptAt: 200_000,
    })).toBe(true)
  })

  test('WSS 恢复 grace 从本次 socket gap 起算，而不是 Guardian 启动时间', () => {
    const gapStartedAt = 100_000
    expect(shouldRebuildGuardianForMissingWss({
      now: 119_999,
      activeSockets: 0,
      gapStartedAt,
      reconnectGraceMs: 20_000,
    })).toBe(false)
    expect(shouldRebuildGuardianForMissingWss({
      now: 120_000,
      activeSockets: 0,
      gapStartedAt,
      reconnectGraceMs: 20_000,
    })).toBe(true)
    expect(shouldRebuildGuardianForMissingWss({
      now: 999_999,
      activeSockets: 1,
      gapStartedAt,
      reconnectGraceMs: 20_000,
    })).toBe(false)
    expect(shouldRebuildGuardianForMissingWss({
      now: 999_999,
      activeSockets: 0,
      gapStartedAt: null,
      reconnectGraceMs: 20_000,
    })).toBe(false)
  })

  test('请求上下文白名单大小写无关，且不会复制 cookie / user-agent 等浏览器应自行生成的头', () => {
    expect(sanitizeCapturedHeaders({
      Authorization: 'Bearer fresh-token',
      'ChatGPT-Account-ID': 'acct-1',
      'OAI-DID': 'device-1',
      'OAI-Session-ID': 'fresh-session',
      Originator: 'web',
      'X-OAI-IS-Client-Observation': '1',
      'X-OAI-MCP-Form-Version': '2',
      'X-OpenAI-Codex-Window-Type': 'main',
      'X-OpenAI-Web-Frontend': '1',
      'X-OAI-Turn-Trace-ID': 'must-not-copy-globally',
      Cookie: 'must-not-copy',
      'User-Agent': 'must-not-copy',
      Referer: 'must-not-copy',
    })).toEqual({
      authorization: 'Bearer fresh-token',
      'chatgpt-account-id': 'acct-1',
      'oai-did': 'device-1',
      'oai-session-id': 'fresh-session',
      originator: 'web',
      'x-oai-is-client-observation': '1',
      'x-oai-mcp-form-version': '2',
      'x-openai-codex-window-type': 'main',
      'x-openai-web-frontend': '1',
    })
  })

  test('手机通知只跟随新 incident 或 material lifecycle 升级，不跟随 tail 文案抖动', () => {
    const watchdog = {
      id: 'incident-1', incidentKind: 'watchdog-timeout', lifecycleClass: 'watchdog-timeout', terminalEvidence: 'none',
    }
    const sameWatchdog = { ...watchdog, tailShape: 'tool-result-returned', reason: 'body refreshed' }
    const confirmed = {
      ...watchdog, incidentKind: 'abnormal-terminal', lifecycleClass: 'complete-no-final', terminalEvidence: 'none',
    }
    const interrupted = {
      ...confirmed, lifecycleClass: 'explicit-interrupted', terminalEvidence: 'client-stopped',
    }

    expect(shouldNotifyIncidentTransition(null, watchdog)).toBe(true)
    expect(shouldNotifyIncidentTransition(watchdog, sameWatchdog)).toBe(false)
    expect(shouldNotifyIncidentTransition(watchdog, confirmed)).toBe(true)
    expect(shouldNotifyIncidentTransition(confirmed, interrupted)).toBe(true)
    expect(shouldNotifyIncidentTransition(interrupted, null)).toBe(false)
    expect(shouldNotifyIncidentTransition(interrupted, { ...interrupted, id: 'incident-2' })).toBe(true)
  })
})
