#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { ChatArchiveDb } from '../src/local/archive-db.ts'
import { importOfficialExportZips } from '../src/local/official-export.ts'
import { clusterCompletionBursts, readTurnTraceTail } from '../src/local/turn-trace-reader.ts'
import { actorStatus, inspectActorPage, resetActor, sendActorPrompt } from '../src/local/chatgpt-actor.ts'
import { ActorDomDriftLedger } from '../src/local/dom-drift.ts'
import {
  ProtocolDriftLedger,
  dedupeProtocolAssessments,
  formatProtocolDriftAssessment,
} from '../src/local/protocol-drift.ts'
import { loadIncidentNotificationConfig, sendIncidentNotification } from '../src/local/incident-notifier.ts'
import {
  archiveDaemonSupervisorReady,
  clearArchiveDaemonStartOnce,
  enterArchiveDaemonMaintenance,
  grantArchiveDaemonStartOnce,
  leaveArchiveDaemonMaintenance,
  readArchiveDaemonMaintenance,
} from '../src/local/archive-daemon-supervision.ts'

/**
 * 全局 `chatgpt-archive` 通过 npm link/全局 shim 可以从任意工作目录启动。
 * 因此默认数据库、daemon 脚本和运行状态绝不能再用 `process.cwd()` 推导；
 * 否则 AI 在另一个项目目录调用 CLI 时会悄悄创建一份新的空 `data/chatgpt-archive.sqlite`。
 *
 * `import.meta.url` 始终指向真正的脚本文件，所以以 scripts/ 的父目录作为项目根最稳定。
 */
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_DB_PATH = path.join(PROJECT_ROOT, 'data', 'chatgpt-archive.sqlite')
const DEFAULT_DAEMON_STATE_PATH = path.join(PROJECT_ROOT, 'data', 'archive-daemon-state.json')
const DEFAULT_DAEMON_LOG_PATH = path.join(PROJECT_ROOT, 'data', 'archive-daemon.log')
const DEFAULT_DAEMON_MAINTENANCE_PATH = path.join(PROJECT_ROOT, 'data', 'archive-daemon-maintenance.json')
const DEFAULT_DAEMON_START_ONCE_PATH = path.join(PROJECT_ROOT, 'data', 'archive-daemon-start-once.flag')
const DEFAULT_TURN_TRACE_PATH = path.join(PROJECT_ROOT, 'data', 'active-turn-trace.jsonl')
const DEFAULT_ACTOR_STATE_PATH = path.join(PROJECT_ROOT, 'data', 'archive-actor-state.json')
const DEFAULT_PROTOCOL_LEDGER_PATH = path.join(PROJECT_ROOT, 'data', 'protocol-fingerprints.json')
const DEFAULT_DOM_LEDGER_PATH = path.join(PROJECT_ROOT, 'data', 'dom-fingerprints.json')
const DEFAULT_BRIDGE_AUTH_PATH = path.join(PROJECT_ROOT, 'data', 'archive-bridge-auth.local.json')
const DEFAULT_NOTIFICATION_CONFIG_PATH = path.join(PROJECT_ROOT, 'data', 'archive-notification.local.json')
const DEFAULT_PROTOCOL_REPORT_STATE_PATH = path.join(PROJECT_ROOT, 'data', 'protocol-report-state.json')
const DEFAULT_PROTOCOL_APPROVALS_PATH = path.join(PROJECT_ROOT, 'data', 'protocol-template-approvals.json')
const WINDOWS_STARTUP_HELPER = path.join(PROJECT_ROOT, 'scripts', 'windows-archive-startup.ps1')
const WINDOWS_STARTUP_LAUNCHER = path.join(PROJECT_ROOT, 'scripts', 'windows-archive-daemon-launcher.vbs')
const WINDOWS_STARTUP_TASK = 'ChatGPT Archive Daemon'
const WINDOWS_PROTOCOL_TASK_HELPER = path.join(PROJECT_ROOT, 'scripts', 'windows-protocol-drift-task.ps1')
const WINDOWS_PROTOCOL_TASK = 'ChatGPT Archive Protocol Drift'

function usage() {
  console.log(`ChatGPT Archive CLI

Usage:
  chatgpt-archive import <json-file...> [--db <path>]
  chatgpt-archive recover <recovery-json-file...> [--db <path>]
  chatgpt-archive import-official <chatgpt-export.zip...> [--db <path>]
  chatgpt-archive list [--limit N] [--db <path>]
  chatgpt-archive search <fts-query> [--limit N] [--sort relevance|recent|frequency] [--snippets-per-conversation N] [--db <path>]
  chatgpt-archive search-messages <fts-query> [--limit N] [--db <path>]
  chatgpt-archive show <conversation-id> [--format md|json|resources] [--db <path>]
  chatgpt-archive stats [--db <path>]
  chatgpt-archive sources [--db <path>]
  chatgpt-archive schema [--source ID] [--db <path>]
  chatgpt-archive reindex [--all|--search-only|--bigram-only] [--db <path>]
  chatgpt-archive incidents [--status open|resolved] [--limit N] [--db <path>]
  chatgpt-archive turn-trace [--limit N] [--trace <path>] [--cluster-ms N]
  chatgpt-archive actor send --prompt-file <path> [--mode auto|new|continue|steer] [--project <name>] [--wait-final] [--final-timeout-ms N] [--target guardian|dedicated] [--conversation <UUID>] [--cdp URL] [--trace <path>] [--state <path>] [--dom-ledger <path>]
  chatgpt-archive job submit --prompt-file <path> --key <idempotency-key> [--mode new|continue|steer] [--conversation <UUID>] [--project <name>]
  chatgpt-archive job status --key <idempotency-key>
  chatgpt-archive job result --key <idempotency-key>
  chatgpt-archive job wait --key <idempotency-key> [--timeout-ms 1800000]
  chatgpt-archive actor batch --jobs-file <json> [--target guardian|dedicated] [--min-gap-ms N] [--cdp URL] [--trace <path>] [--state <path>] [--dom-ledger <path>]
  chatgpt-archive actor inspect [--target guardian|dedicated] [--cdp URL] [--state <path>]
  chatgpt-archive actor status [--cdp URL] [--state <path>]
 chatgpt-archive actor reset [--cdp URL] [--state <path>]
  chatgpt-archive protocol status [--ledger <path>] [--dom-ledger <path>]
  chatgpt-archive protocol report [--notify] [--ledger <path>] [--dom-ledger <path>]
  chatgpt-archive protocol approve <request-signature> [--ledger <path>]
  chatgpt-archive protocol approve-dom <dom-signature> [--dom-ledger <path>]
  chatgpt-archive protocol lock-dom [--dom-ledger <path>]
  chatgpt-archive protocol install-daily [--time HH:mm]
  chatgpt-archive protocol daily-status
  chatgpt-archive protocol uninstall-daily
  chatgpt-archive daemon start [--cdp URL] [--reconcile-hours N] [--db <path>] [--devspace-db <path>] [--allow-active-image-resolver] [--bridge-host HOST] [--bridge-port PORT] [--bridge-auth <path>] [--no-bridge] [--allow-remote-bridge]
  chatgpt-archive daemon status [--state <path>]
  chatgpt-archive daemon stop [--state <path>]
  chatgpt-archive daemon resume [--state <path>]
  chatgpt-archive daemon install-startup
  chatgpt-archive daemon startup-status
  chatgpt-archive daemon uninstall-startup

Default DB: <ChatGPT Archive project>/data/chatgpt-archive.sqlite

Development fallback:
  node scripts/chatgpt-archive.mjs <command> ...
  npm run chatgpt-archive -- <command> ...

Import accepts either:
- one conversation object (messages[] or legacy mapping)
- an array of conversation objects, e.g. a ChatGPT official conversations.json-style dump

Recovery accepts only payloads explicitly marked:
- recovery.kind = "browser-memory-recovery"
- messages[] are union/upserted non-destructively
- canonical current_node and incident state are never changed by recovery evidence
`)
}

function parseArgs(argv) {
  const positionals = []
  const flags = new Map()
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i]
    if (value.startsWith('--')) {
      const name = value.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) {
        flags.set(name, next)
        i += 1
      }
      else {
        flags.set(name, true)
      }
    }
    else positionals.push(value)
  }
  return { positionals, flags }
}

function dbPath(flags) {
  const explicit = flags.get('db') ?? process.env.CHATGPT_ARCHIVE_DB
  return explicit === undefined ? DEFAULT_DB_PATH : path.resolve(String(explicit))
}

/**
 * 异步任务的 CLI 是正式公共接口：所有命令只访问 RQCI Bridge 的 Job API，
 * 不访问 ChatGPT、不扫描 Archive messages；Bridge 在生产者侧维护最终结果。
 * 长任务调用方使用 submit -> status/result，也可按需使用阻塞的 CLI wait。
 */
async function archiveJobRequest(flags, method, query = '', body) {
  const bridgeUrl = String(flags.get('bridge-url') || 'http://127.0.0.1:47832').replace(/\/$/u, '')
  const authPath = path.resolve(String(flags.get('bridge-auth') || DEFAULT_BRIDGE_AUTH_PATH))
  const auth = JSON.parse(await fs.readFile(authPath, 'utf8'))
  if (typeof auth.token !== 'string' || !auth.token) throw new Error('Archive Bridge auth token not configured')
  const response = await fetch(`${bridgeUrl}/v1/jobs${query}`, {
    method,
    headers: {
      authorization: `Bearer ${auth.token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20_000),
  })
  const payload = await response.json()
  if (!response.ok) throw new Error(`RQCI Job API HTTP ${response.status}: ${payload.error || 'unknown'}`)
  if (!payload.job) throw new Error('RQCI Job API omitted job')
  return payload.job
}

async function runJobCommand(action, flags) {
  const key = String(flags.get('key') || '').trim()
  if (!key) throw new Error('job command requires --key <idempotency-key>')
  if (action === 'submit') {
    const file = flags.get('prompt-file')
    if (typeof file !== 'string' || !file) throw new Error('job submit requires --prompt-file <path>')
    const mode = String(flags.get('mode') || 'new')
    if (!['new', 'continue', 'steer'].includes(mode)) throw new Error('--mode must be new|continue|steer')
    const conversationId = typeof flags.get('conversation') === 'string' ? String(flags.get('conversation')) : null
    if (mode !== 'new' && !conversationId) throw new Error('continue/steer requires --conversation')
    const job = await archiveJobRequest(flags, 'POST', '', {
      idempotencyKey: key,
      text: await fs.readFile(path.resolve(file), 'utf8'),
      mode,
      conversationId,
      projectName: typeof flags.get('project') === 'string' ? String(flags.get('project')) : null,
    })
    console.log(JSON.stringify(job, null, 2))
    return
  }
  if (!['status', 'result', 'wait'].includes(action)) throw new Error('job action must be submit|status|result|wait')
  const readJob = () => archiveJobRequest(flags, 'GET', `?key=${encodeURIComponent(key)}`)
  if (action === 'status') {
    console.log(JSON.stringify(await readJob(), null, 2))
    return
  }
  const timeoutMs = Number(flags.get('timeout-ms') || 30 * 60_000)
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) throw new Error('--timeout-ms must be >= 1000')
  const deadline = Date.now() + (action === 'wait' ? timeoutMs : 0)
  while (true) {
    const job = await readJob()
    if (job.status === 'completed') {
      console.log(JSON.stringify(job.result, null, 2))
      return
    }
    if (job.status === 'failed') {
      // 把 ChatGPT SSE 的具体错误码直接作为 CLI 错误反馈给 ClassFlow 等调用端。
      // 只展示公共 Job API 字段，调用端不必解析内部日志或原始 SSE。
      const details = [job.errorCode, job.errorReason].filter(Boolean).join('/')
      throw new Error(`RQCI job failed${details ? ` [${details}]` : ''}: ${job.error || key}`)
    }
    if (action !== 'wait') throw new Error(`RQCI job not complete: ${job.status}`)
    if (Date.now() >= deadline) throw new Error(`RQCI job wait timed out: ${key}`)
    await new Promise(resolve => setTimeout(resolve, 1500))
  }
}

/** 计算安装审批需要绑定的本地 payload SHA256，避免审批后文件被悄悄替换。 */
async function sha256File(filePath) {
  return createHash('sha256').update(await fs.readFile(filePath)).digest('hex')
}

/**
 * 从 Archive 已经归一化的消息里寻找“本次 Actor 提交之后”的 assistant final。
 *
 * 这里不能简单取 conversation 最后一条 assistant：同一个 CID 可能已经有很多历史 turn。
 * `submittedAt` 来自 Actor 观察到正式 `/f/conversation` POST 的 requestWillBeSent 时刻，
 * 因而是本机最可靠的新 turn 下界；给 5 秒容差只为覆盖服务端 create_time 与本机时钟差。
 */
export function latestAssistantFinal(messages, submittedAtMs) {
  const floorSeconds = Math.max(0, Number(submittedAtMs || 0) / 1000 - 5)
  const candidates = messages.filter((row) => {
    if (String(row?.role || '').toLowerCase() !== 'assistant') return false
    if (Number(row?.hidden || 0) !== 0) return false
    if (!String(row?.text || '').trim()) return false
    const created = Number(row?.createTime || 0)
    if (Number.isFinite(created) && created > 0 && created < floorSeconds) return false
    const channel = String(row?.channel || '').toLowerCase()
    // final 通道不是完成事件。必须观察到模型最终成功结束的规范化记录。
    const ended = row?.endTurn === true || row?.endTurn === 1
    const finished = row?.status === 'finished_successfully'
    const finishType = row?.finishType
    return channel === 'final' && ended && finished && (!finishType || finishType === 'stop')
  })
  return candidates.length > 0 ? candidates[candidates.length - 1] : null
}

/**
 * 等待 daemon 把 Actor 新 turn 的 canonical final 写入**本地 SQLite**。
 *
 * 这段等待不会调用 ChatGPT REST/list/body，也不会创建额外 WSS；真正的在线数据流仍是：
 * 页面原始 SSE -> Phase 3 LiveTurn -> conversations WSS complete -> daemon body sync。
 * CLI 这里只是把异步 daemon 的最终结果变成一个方便 ClassFlow 调用的阻塞接口。
 */
export async function waitForCanonicalActorFinal({ databasePath, conversationId, submittedAt, timeoutMs }) {
  const archive = new ChatArchiveDb(databasePath)
  try {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const summary = archive.getConversationSummary(conversationId)
      if (
        summary?.bodyCompletionState === 'final'
        && Number(summary.capturedAt || 0) >= Number(submittedAt || 0)
      ) {
        const finalMessage = latestAssistantFinal(archive.getMessages(conversationId), submittedAt)
        if (finalMessage) {
          return {
            conversationId,
            title: summary.title,
            capturedAt: summary.capturedAt,
            messageId: finalMessage.messageId ?? null,
            modelSlug: finalMessage.resolvedModelSlug ?? finalMessage.modelSlug ?? null,
            text: String(finalMessage.text || ''),
          }
        }
      }
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    throw new Error(`actor final wait timed out after ${timeoutMs}ms for conversation ${conversationId}`)
  }
  finally {
    archive.close()
  }
}

function daemonStatePath(flags) {
  const explicit = flags.get('state')
  return explicit === undefined ? DEFAULT_DAEMON_STATE_PATH : path.resolve(String(explicit))
}

async function readJsonOr(filePath, fallback) {
  try { return JSON.parse(await fs.readFile(filePath, 'utf8')) }
  catch (error) {
    if (error?.code === 'ENOENT') return fallback
    throw error
  }
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const temporary = filePath + '.tmp-' + process.pid
  await fs.writeFile(temporary, JSON.stringify(value, null, 2))
  await fs.rename(temporary, filePath)
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  }
  catch {
    return false
  }
}

async function readDaemonState(flags) {
  const statePath = daemonStatePath(flags)
  try {
    const state = JSON.parse(await fs.readFile(statePath, 'utf8'))
    return { statePath, state, alive: isPidAlive(Number(state?.pid)) }
  }
  catch {
    return { statePath, state: null, alive: false }
  }
}

/**
 * 停止当前 daemon 进程，但不改变 maintenance 状态。
 *
 * stop 会先进入 maintenance；resume 也会保持 maintenance，直到新版本通过健康门槛。
 * 把真正的 PID 终止逻辑集中在这里，可以避免两个流程出现不同的 SIGTERM/SIGKILL 语义。
 */
async function stopDaemonProcess(flags) {
  const current = await readDaemonState(flags)
  const pid = Number(current.state?.pid)
  if (!current.alive || !Number.isInteger(pid)) {
    return { stopped: false, reason: 'daemon not running', ...current }
  }
  process.kill(pid, 'SIGTERM')
  const started = Date.now()
  while (isPidAlive(pid) && Date.now() - started < 5000) {
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  if (isPidAlive(pid)) {
    process.kill(pid, 'SIGKILL')
    // Windows TerminateProcess 通常很快，但不能在发出 SIGKILL 的同一个 tick
    // 就把“信号已发送”误当成“进程已经消失”。给内核一个很短的确认窗口。
    const forcedAt = Date.now()
    while (isPidAlive(pid) && Date.now() - forcedAt < 2000) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
  return { stopped: !isPidAlive(pid), pid, statePath: current.statePath }
}

/** 请求现有 Windows 计划任务立即运行一次；只触发同名任务，不修改任务定义。 */
async function runArchiveScheduledTask() {
  const child = spawn('schtasks.exe', ['/Run', '/TN', WINDOWS_STARTUP_TASK], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const exitCode = await new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', resolve)
  })
  if (exitCode !== 0) {
    throw new Error('Failed to run scheduled Archive daemon: ' + (stderr.trim() || stdout.trim() || 'exit ' + exitCode))
  }
}

async function daemonCommand(positionals, flags) {
  const action = positionals[0]
  if (!action) throw new Error('daemon requires start|status|stop|resume|install-startup|startup-status|uninstall-startup')

  if (['install-startup', 'startup-status', 'uninstall-startup'].includes(action)) {
    if (process.platform !== 'win32') throw new Error(`${action} is currently Windows-only`)
    const helperAction = action === 'install-startup'
      ? 'Install'
      : action === 'uninstall-startup' ? 'Uninstall' : 'Status'
    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-File', WINDOWS_STARTUP_HELPER,
      '-Action', helperAction,
      '-TaskName', WINDOWS_STARTUP_TASK,
    ]
    if (helperAction === 'Install') {
      const daemonScript = path.join(PROJECT_ROOT, 'scripts', 'chatgpt-archive-daemon.mjs')
      const daemonSha256 = await sha256File(daemonScript)
      const launcherSha256 = await sha256File(WINDOWS_STARTUP_LAUNCHER)
      args.push(
        '-NodeExe', process.execPath,
        '-DaemonScript', daemonScript,
        '-LauncherScript', WINDOWS_STARTUP_LAUNCHER,
        '-ProjectRoot', PROJECT_ROOT,
        '-DbPath', dbPath(flags),
        '-MaintenanceFlag', DEFAULT_DAEMON_MAINTENANCE_PATH,
        '-StartOnceFlag', DEFAULT_DAEMON_START_ONCE_PATH,
        '-ExpectedDaemonSha256', daemonSha256,
        '-ExpectedLauncherSha256', launcherSha256,
      )
    }
    // Windows PowerShell 5.1 会按系统代码页误读无 BOM 的 UTF-8 中文脚本；本机已有
    // PowerShell 7，统一用 pwsh 解析 startup helper，避免同一脚本在 PS7 正常、PS5.1 语法损坏。
    const child = spawn('pwsh.exe', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    const exitCode = await new Promise((resolve, reject) => {
      child.on('error', reject)
      child.on('close', resolve)
    })
    if (exitCode !== 0) throw new Error(`Windows startup task failed (${exitCode}): ${stderr.trim() || stdout.trim()}`)
    console.log(stdout.trim() || JSON.stringify({ action, ok: true }))
    return
  }

  if (action === 'status') {
    const current = await readDaemonState(flags)
    const maintenance = await readArchiveDaemonMaintenance(DEFAULT_DAEMON_MAINTENANCE_PATH)
    console.log(JSON.stringify({ ...current, maintenance }, null, 2))
    return
  }

  if (action === 'stop') {
    const maintenance = await enterArchiveDaemonMaintenance(DEFAULT_DAEMON_MAINTENANCE_PATH, 'manual-stop')
    await clearArchiveDaemonStartOnce(DEFAULT_DAEMON_START_ONCE_PATH)
    const result = await stopDaemonProcess(flags)
    console.log(JSON.stringify({ ...result, maintenance }, null, 2))
    return
  }

  if (action === 'resume') {
    if (process.platform !== 'win32') throw new Error('daemon resume is currently Windows-only')

    const previous = await readDaemonState(flags)
    const previousPid = previous.alive ? Number(previous.state?.pid) : null
    await enterArchiveDaemonMaintenance(DEFAULT_DAEMON_MAINTENANCE_PATH, 'resume-probe')
    await clearArchiveDaemonStartOnce(DEFAULT_DAEMON_START_ONCE_PATH)
    await stopDaemonProcess(flags)
    await grantArchiveDaemonStartOnce(DEFAULT_DAEMON_START_ONCE_PATH)

    try {
      const probeStartedAt = Date.now()
      let demandStartAttempts = 0
      let nextDemandStartAt = 0
      let sawNewProbeIdentity = false
      let stableSamples = 0
      let observed = null
      // 生产上近期 DevSpace binding backfill 已实测可能占用约 50 秒；45 秒会把
      // “其实仍在正常初始化、稍后即可 healthy”的新实例误判失败并主动杀掉。
      // 这里把人工 resume 的 fail-closed 观察窗放宽到 90 秒。它只影响部署/人工恢复
      // 时最长等待多久，不改变 Task Scheduler 自身每 1 分钟的监督周期。
      while (Date.now() - probeStartedAt < 90_000) {
        // Windows 在 Node 子进程退出后，还需要几十毫秒让父级 wscript / Task Scheduler
        // 实例从 Running 真正退场。此窗口里立刻 /Run 会被 IgnoreNew 正确忽略。
        //
        // 不用固定 sleep 猜时序：只要 one-shot permit 还未被新实例消费、且尚未看到
        // 本轮新 PID，就短暂重发 demand start。旧实例退场后的第一个有效 /Run 会启动
        // launcher 并消费 permit；一旦新 PID bootstrap state 出现，就立即停止重发。
        if (
          !sawNewProbeIdentity
          && Date.now() - probeStartedAt < 10_000
          && Date.now() >= nextDemandStartAt
        ) {
          demandStartAttempts += 1
          await runArchiveScheduledTask()
          nextDemandStartAt = Date.now() + 750
        }

        await new Promise(resolve => setTimeout(resolve, 250))
        observed = await readDaemonState(flags)
        const observedPid = Number(observed.state?.pid)
        const observedStartedAt = Number(observed.state?.startedAt)
        const isNewProbeIdentity = (
          observed.alive
          && Number.isInteger(observedPid)
          && observedPid !== previousPid
          && Number.isFinite(observedStartedAt)
          && observedStartedAt >= probeStartedAt - 5000
        )
        if (isNewProbeIdentity) sawNewProbeIdentity = true
        if (isNewProbeIdentity && archiveDaemonSupervisorReady(observed)) {
          stableSamples += 1
          if (stableSamples >= 4) {
            await leaveArchiveDaemonMaintenance(DEFAULT_DAEMON_MAINTENANCE_PATH)
            await clearArchiveDaemonStartOnce(DEFAULT_DAEMON_START_ONCE_PATH)
            console.log(JSON.stringify({
              resumed: true,
              supervised: true,
              stableSamples,
              demandStartAttempts,
              ...observed,
              maintenance: await readArchiveDaemonMaintenance(DEFAULT_DAEMON_MAINTENANCE_PATH),
            }, null, 2))
            return
          }
        }
        else {
          stableSamples = 0
        }
      }

      await clearArchiveDaemonStartOnce(DEFAULT_DAEMON_START_ONCE_PATH)
      await enterArchiveDaemonMaintenance(DEFAULT_DAEMON_MAINTENANCE_PATH, 'resume-health-check-failed')
      const stopResult = await stopDaemonProcess(flags)
      if (!stopResult.stopped && stopResult.reason !== 'daemon not running') {
        throw new Error('Scheduled Archive daemon failed health check and could not be stopped; maintenance remains active')
      }
      throw new Error('Scheduled Archive daemon did not become healthy within 90 seconds; maintenance remains active')
    }
    catch (error) {
      await clearArchiveDaemonStartOnce(DEFAULT_DAEMON_START_ONCE_PATH).catch(() => {})
      await enterArchiveDaemonMaintenance(DEFAULT_DAEMON_MAINTENANCE_PATH, 'resume-failed').catch(() => {})
      throw error
    }
  }

  if (action === 'start') {
    const current = await readDaemonState(flags)
    if (current.alive) {
      console.log(JSON.stringify({ started: false, reason: 'already running', ...current }, null, 2))
      return
    }

    await enterArchiveDaemonMaintenance(DEFAULT_DAEMON_MAINTENANCE_PATH, 'direct-start')
    await clearArchiveDaemonStartOnce(DEFAULT_DAEMON_START_ONCE_PATH)

    const daemonScript = path.join(PROJECT_ROOT, 'scripts', 'chatgpt-archive-daemon.mjs')
    const statePath = daemonStatePath(flags)
    const logPath = flags.has('log')
      ? path.resolve(String(flags.get('log')))
      : DEFAULT_DAEMON_LOG_PATH
    const childArgs = [daemonScript, '--state', statePath, '--log', logPath, '--db', dbPath(flags)]
    const passFlags = [
      'cdp',
      'sync-delay-ms',
      'reconcile-delay-ms',
      'request-jitter-ms',
      'overlap',
      'reconcile-hours',
      'cooldown-minutes',
      'max-sync-conversations',
      'guardian-health-failures',
      'gap-repair-delay-ms',
      'gap-repair-min-interval-ms',
      'native-body-grace-ms',
      'passive-catalog-freshness-ms',
      'recovery-probe-gap-ms',
      'recovery-probe-successes',
      'watchdog-minutes',
      'devspace-db',
      'chrome-shortcut',
      'chrome-start-timeout-ms',
     'notification-config',
      'protocol-ledger',
     'turn-trace',
      'bridge-host',
      'bridge-port',
      'bridge-auth',
      'lifeops-sync-config',
      'lifeops-sync-pending',
      'actor-state',
      'dom-ledger',
    ]
    for (const name of passFlags) {
      if (flags.has(name)) childArgs.push(`--${name}`, String(flags.get(name)))
    }
    if (flags.has('no-reconcile-on-start')) childArgs.push('--no-reconcile-on-start')
    if (flags.has('no-auto-launch-chrome')) childArgs.push('--no-auto-launch-chrome')
    if (flags.has('allow-active-image-resolver')) childArgs.push('--allow-active-image-resolver')
    if (flags.has('no-bridge')) childArgs.push('--no-bridge')
    if (flags.has('allow-remote-bridge')) childArgs.push('--allow-remote-bridge')

    const child = spawn(process.execPath, childArgs, {
      detached: true,
      windowsHide: true,
      // daemon 自己负责写结构化日志；这里若再把 stderr/stdout 重定向到同一文件，
      // 每条 log() 会被“fs.appendFile + console.error”写两遍。
      stdio: 'ignore',
      cwd: PROJECT_ROOT,
    })
    child.unref()

    const started = Date.now()
    let observed = null
    while (Date.now() - started < 15_000) {
      await new Promise(resolve => setTimeout(resolve, 100))
      observed = await readDaemonState(flags)
      if (observed.alive && observed.state?.guardian) break
    }
    console.log(JSON.stringify({ started: Boolean(observed?.alive), pid: child.pid, ...(observed || {}) }, null, 2))
    return
  }

  throw new Error(`Unknown daemon action: ${action}`)
}

async function protocolCommand(positionals, flags) {
  const action = positionals[0]
  if (!action) throw new Error('protocol requires status|report|approve|install-daily|daily-status|uninstall-daily')

  if (['install-daily', 'daily-status', 'uninstall-daily'].includes(action)) {
    if (process.platform !== 'win32') throw new Error(action + ' is currently Windows-only')
    const helperAction = action === 'install-daily'
      ? 'Install'
      : action === 'uninstall-daily' ? 'Uninstall' : 'Status'
    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', WINDOWS_PROTOCOL_TASK_HELPER,
      '-Action', helperAction,
      '-TaskName', WINDOWS_PROTOCOL_TASK,
    ]
    if (helperAction === 'Install') {
      const dailyAt = String(flags.get('time') || '12:00')
      if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(dailyAt)) throw new Error('--time must be HH:mm')
      args.push(
        '-NodeExe', process.execPath,
        '-CliScript', fileURLToPath(import.meta.url),
        '-LauncherScript', WINDOWS_STARTUP_LAUNCHER,
        '-ProjectRoot', PROJECT_ROOT,
        '-DailyAt', dailyAt,
      )
    }
    const child = spawn('pwsh.exe', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    const exitCode = await new Promise((resolve, reject) => {
      child.on('error', reject)
      child.on('close', resolve)
    })
    if (exitCode !== 0) throw new Error('Protocol drift scheduled task failed (' + exitCode + '): ' + (stderr.trim() || stdout.trim()))
    console.log(stdout.trim() || JSON.stringify({ action, ok: true }))
    return
  }

  const ledgerPath = flags.has('ledger')
    ? path.resolve(String(flags.get('ledger')))
    : DEFAULT_PROTOCOL_LEDGER_PATH
  const ledger = await ProtocolDriftLedger.open(ledgerPath)
  const domLedgerPath = flags.has('dom-ledger')
    ? path.resolve(String(flags.get('dom-ledger')))
    : DEFAULT_DOM_LEDGER_PATH
  const domLedger = await ActorDomDriftLedger.open(domLedgerPath)
  const reportStatePath = flags.has('report-state')
    ? path.resolve(String(flags.get('report-state')))
    : DEFAULT_PROTOCOL_REPORT_STATE_PATH
  const approvalsPath = flags.has('approvals')
    ? path.resolve(String(flags.get('approvals')))
    : DEFAULT_PROTOCOL_APPROVALS_PATH

  if (action === 'status') {
    const reportState = await readJsonOr(reportStatePath, { version: 1, notified: {} })
    const approvals = await readJsonOr(approvalsPath, { version: 1, approvals: {} })
    console.log(JSON.stringify({
      summary: ledger.summary(),
      pending: ledger.pendingChanges({ unreportedOnly: false }),
      actionable: dedupeProtocolAssessments(ledger.assessedPendingChanges({
        unreportedOnly: false,
        notifyOnly: true,
      })).map(item => item.assessment),
      dom: {
        summary: domLedger.summary(),
        pending: domLedger.pendingChanges({ unreportedOnly: false }),
      },
      reportStatePath,
      notifiedCount: Object.keys(reportState.notified || {}).length,
      approvalsPath,
      approvals: approvals.approvals || {},
    }, null, 2))
    return
  }

  if (action === 'approve-dom') {
    const signature = positionals[1]
    if (!signature) throw new Error('protocol approve-dom requires a DOM signature')
    if (!domLedger.approve(signature)) throw new Error('DOM signature is missing: ' + signature)
    await domLedger.flush()
    console.log(JSON.stringify({ domLedgerPath, signature, approved: true }, null, 2))
    return
  }

  if (action === 'lock-dom') {
    domLedger.lockBaseline()
    await domLedger.flush()
    console.log(JSON.stringify({ domLedgerPath, locked: true, summary: domLedger.summary() }, null, 2))
    return
  }

  if (action === 'approve') {
    const signature = positionals[1]
    if (!signature) throw new Error('protocol approve requires a request signature')
    const variant = ledger.state.variants[signature]
    if (!variant?.candidate?.eligible) {
      throw new Error('request signature is missing or not replay-eligible: ' + signature)
    }
    const approvals = await readJsonOr(approvalsPath, { version: 1, approvals: {} })
    approvals.version = 1
    approvals.approvals = approvals.approvals || {}
    approvals.approvals[signature] = {
      approvedAt: Date.now(),
      family: variant.candidate.family,
      route: variant.shape.route,
      method: variant.shape.method,
      query: variant.shape.query,
    }
    await writeJsonAtomic(approvalsPath, approvals)
    console.log(JSON.stringify({ ledgerPath, approvalsPath, signature, approved: true }, null, 2))
    return
  }

  if (action === 'report') {
    const summary = ledger.summary()
    const actionable = dedupeProtocolAssessments(ledger.assessedPendingChanges({
      unreportedOnly: false,
      notifyOnly: true,
    }))
    const domSummary = domLedger.summary()
    const allDomPending = domLedger.pendingChanges({ unreportedOnly: false })
    const reportState = await readJsonOr(reportStatePath, { version: 1, notified: {} })
    reportState.version = 1
    reportState.notified = reportState.notified || {}
    const semanticChangeKey = item => 'protocol-semantic:' + item.assessment.dedupeKey
    const domChangeKey = change => 'dom:' + change.signature
    const pending = actionable.filter(item => !reportState.notified[semanticChangeKey(item)])
    const domPending = allDomPending.filter(change => !reportState.notified[domChangeKey(change)])
    const pendingTotal = pending.length + domPending.length
    let notification = null
    if (flags.has('notify') && pendingTotal > 0) {
      const notificationPath = flags.has('notification-config')
        ? path.resolve(String(flags.get('notification-config')))
        : DEFAULT_NOTIFICATION_CONFIG_PATH
      const config = await loadIncidentNotificationConfig(notificationPath)
      const protocolLines = pending.map(item => formatProtocolDriftAssessment(item.assessment))
      const domLines = domPending.map(change => (
        '[DOM] route=' + change.routeKind + ' signature=' + change.signature
      ))
      const allLines = [...protocolLines, ...domLines]
      const lines = allLines.slice(0, 8)
      if (allLines.length > lines.length) lines.push('…另有 ' + (allLines.length - lines.length) + ' 项')
      const result = await sendIncidentNotification(config, {
        title: 'ChatGPT 协议/DOM 漂移 ' + pendingTotal + ' 项',
        body: lines.join('\n'),
      })
      notification = result
      if (result.ok) {
        const now = Date.now()
        for (const item of pending) reportState.notified[semanticChangeKey(item)] = now
        for (const change of domPending) reportState.notified[domChangeKey(change)] = now
        await writeJsonAtomic(reportStatePath, reportState)
      }
    }
    console.log(JSON.stringify({
      summary,
      pending: pending.map(item => ({ change: item.change, assessment: item.assessment })),
      dom: {
        summary: domSummary,
        pending: domPending,
      },
      notification,
      reportStatePath,
    }, null, 2))
    return
  }

  throw new Error('Unknown protocol action: ' + action)
}

function limit(flags, fallback) {
  const parsed = Number(flags.get('limit') || fallback)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error('--limit must be a positive integer')
  return parsed
}

async function importFile(db, filePath) {
  const absolute = path.resolve(filePath)
  const stat = await fs.stat(absolute)
  if (!stat.isFile()) throw new Error(`Not a file: ${absolute}`)
  const parsed = JSON.parse(await fs.readFile(absolute, 'utf8'))
  const payloads = Array.isArray(parsed) ? parsed : [parsed]
  const results = []
  for (const payload of payloads) {
    try {
      results.push({ file: absolute, ...db.importRaw(payload, stat.mtimeMs || Date.now()) })
    }
    catch (error) {
      results.push({ file: absolute, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return results
}

/**
 * Non-destructive offline recovery for evidence that survived in browser memory
 * while the canonical conversation body stopped persisting.
 *
 * Unlike importRaw(), this path must never replace an existing conversation.
 * It reuses the live union merge and stores the full recovery bundle in
 * live_observations for later forensic reinterpretation.
 */
async function recoverFile(db, filePath) {
  const absolute = path.resolve(filePath)
  const stat = await fs.stat(absolute)
  if (!stat.isFile()) throw new Error('Not a file: ' + absolute)
  const parsed = JSON.parse(await fs.readFile(absolute, 'utf8'))
  const payloads = Array.isArray(parsed) ? parsed : [parsed]
  const results = []

  for (const payload of payloads) {
    try {
      const recovery = payload && typeof payload === 'object' ? payload.recovery : null
      if (!recovery || recovery.kind !== 'browser-memory-recovery') {
        throw new Error('recovery payload must set recovery.kind="browser-memory-recovery"')
      }
      if (!Array.isArray(payload.messages)) {
        throw new Error('recovery payload requires messages[]')
      }

      const canonicalMessages = payload.messages.filter((message) => {
        if (!message || typeof message !== 'object') return false
        const role = message.author && typeof message.author === 'object'
          ? message.author.role
          : null
        if (role === 'user') return true
        if (role !== 'assistant') return false

        // ChatGPT 的“消息发送超时 / 已达到长度上限”等错误卡片同样会带 data-message-id，
        // 但真实样本证明这些 ID 可以完全不存在于 server body。DOM message-id 本身因此不够。
        // 当前只允许带真实模型标识的 assistant DOM 节点进入 canonical union；其余 UI-only
        // 节点仍完整保存在 recovery.uiMessages/raw observation 中，供 forensic 对账。
        const metadata = message.metadata && typeof message.metadata === 'object'
          ? message.metadata
          : {}
        const modelSlug = metadata.recovery_model_slug
        const content = message.content && typeof message.content === 'object'
          ? message.content
          : {}
        const text = Array.isArray(content.parts) ? content.parts.filter(part => typeof part === 'string').join('\n') : ''
        if (typeof modelSlug !== 'string' || modelSlug.trim().length === 0) return false
        if (/消息发送超时|已达到此对话的长度上限|达到此对话的长度上限/u.test(text)) return false
        return true
      })

      const mergePayload = { ...payload, messages: canonicalMessages }
      const capturedAt = Number(recovery.capturedAt)
      const observedAt = Number.isFinite(capturedAt) && capturedAt > 0
        ? capturedAt
        : (stat.mtimeMs || Date.now())

      results.push({
        file: absolute,
        ...db.mergeLiveMessagesPage(mergePayload, {
          observedAt,
          endpoint: 'offline://browser-memory-recovery',
          observationKind: 'browser-memory-recovery',
          updateCurrentState: false,
          classifyCompletionIncident: false,
          allowIncompleteTailIncident: false,
          updateIncidents: false,
          insertUnknownOnly: true,
        }),
        uiMessageCount: payload.messages.length,
        canonicalCandidateCount: canonicalMessages.length,
      })
    }
    catch (error) {
      results.push({
        file: absolute,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return results
}

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  if (!command || command === '-h' || command === '--help' || command === 'help') {
    usage()
    return
  }

  const { positionals, flags } = parseArgs(rest)

  if (command === 'daemon') {
    await daemonCommand(positionals, flags)
    return
  }

  if (command === 'job') {
    await runJobCommand(positionals[0], flags)
    return
  }

  if (command === 'turn-trace') {
    const tracePath = flags.has('trace')
      ? path.resolve(String(flags.get('trace')))
      : DEFAULT_TURN_TRACE_PATH
    const clusterMs = Number(flags.get('cluster-ms') ?? 30_000)
    if (!Number.isFinite(clusterMs) || clusterMs < 0) throw new Error('--cluster-ms must be >= 0')
    let records = []
    try {
      records = await readTurnTraceTail(tracePath)
    }
    catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    const recent = records.slice(-limit(flags, 100))
    console.log(JSON.stringify({
      tracePath,
      recordCountInTail: records.length,
      records: recent,
      completionBursts: clusterCompletionBursts(records, clusterMs),
    }, null, 2))
    return
  }

  if (command === 'actor') {
    const action = positionals[0]
    const cdpHttp = String(flags.get('cdp') || 'http://127.0.0.1:9222').replace(/\/$/u, '')
    const actorStatePath = flags.has('state')
      ? path.resolve(String(flags.get('state')))
      : DEFAULT_ACTOR_STATE_PATH
    if (action === 'status') {
      console.log(JSON.stringify(await actorStatus(cdpHttp, actorStatePath, DEFAULT_DAEMON_STATE_PATH), null, 2))
      return
    }
    if (action === 'inspect') {
      const actorTarget = String(flags.get('target') ?? 'guardian')
      if (!['guardian', 'dedicated'].includes(actorTarget)) {
        throw new Error('--target must be one of guardian|dedicated')
      }
      const timeoutMs = Number(flags.get('timeout-ms') ?? 20_000)
      if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) throw new Error('--timeout-ms must be >= 1000')
      console.log(JSON.stringify(await inspectActorPage({
        cdpHttp,
        statePath: actorStatePath,
        daemonStatePath: DEFAULT_DAEMON_STATE_PATH,
        targetMode: actorTarget,
        timeoutMs,
      }), null, 2))
      return
    }
    if (action === 'reset') {
      console.log(JSON.stringify(await resetActor(cdpHttp, actorStatePath), null, 2))
      return
    }
    if (action === 'send') {
      const promptFile = flags.get('prompt-file')
      if (typeof promptFile !== 'string' || !promptFile) throw new Error('actor send requires --prompt-file <path>')
      const prompt = await fs.readFile(path.resolve(promptFile), 'utf8')
      const actorMode = String(flags.get('mode') ?? 'auto')
      if (!['auto', 'new', 'continue', 'steer'].includes(actorMode)) {
        throw new Error('--mode must be one of auto|new|continue|steer')
      }
      const actorTarget = String(flags.get('target') ?? 'guardian')
      if (!['guardian', 'dedicated'].includes(actorTarget)) {
        throw new Error('--target must be one of guardian|dedicated')
      }
      const tracePath = flags.has('trace')
        ? path.resolve(String(flags.get('trace')))
        : DEFAULT_TURN_TRACE_PATH
      const domLedgerPath = flags.has('dom-ledger')
        ? path.resolve(String(flags.get('dom-ledger')))
        : DEFAULT_DOM_LEDGER_PATH
      const timeoutMs = Number(flags.get('timeout-ms') ?? 20_000)
      if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) throw new Error('--timeout-ms must be >= 1000')
      const projectName = typeof flags.get('project') === 'string' ? String(flags.get('project')).trim() : null
      const sendResult = await sendActorPrompt({
        cdpHttp,
        statePath: actorStatePath,
        daemonStatePath: DEFAULT_DAEMON_STATE_PATH,
        domLedgerPath,
        tracePath,
        prompt,
        conversationId: typeof flags.get('conversation') === 'string' ? String(flags.get('conversation')) : null,
        projectName,
        mode: actorMode,
        targetMode: actorTarget,
        timeoutMs,
      })
      if (!flags.has('wait-final')) {
        console.log(JSON.stringify(sendResult, null, 2))
        return
      }
      const finalTimeoutMs = Number(flags.get('final-timeout-ms') ?? 30 * 60_000)
      if (!Number.isFinite(finalTimeoutMs) || finalTimeoutMs < 1000) {
        throw new Error('--final-timeout-ms must be >= 1000')
      }
      const final = await waitForCanonicalActorFinal({
        databasePath: dbPath(flags),
        conversationId: String(sendResult.conversationId),
        submittedAt: Number(sendResult.submittedAt || Date.now()),
        timeoutMs: finalTimeoutMs,
      })
      console.log(JSON.stringify({ ...sendResult, final }, null, 2))
      return
    }
    if (action === 'batch') {
      const jobsFile = flags.get('jobs-file')
      if (typeof jobsFile !== 'string' || !jobsFile) throw new Error('actor batch requires --jobs-file <json>')
      const actorTarget = String(flags.get('target') ?? 'guardian')
      if (!['guardian', 'dedicated'].includes(actorTarget)) {
        throw new Error('--target must be one of guardian|dedicated')
      }
      const minGapMs = Number(flags.get('min-gap-ms') ?? 5_000)
      if (!Number.isFinite(minGapMs) || minGapMs < 0 || minGapMs > 10 * 60_000) {
        throw new Error('--min-gap-ms must be between 0 and 600000')
      }
      const timeoutMs = Number(flags.get('timeout-ms') ?? 20_000)
      if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) throw new Error('--timeout-ms must be >= 1000')
      const tracePath = flags.has('trace')
        ? path.resolve(String(flags.get('trace')))
        : DEFAULT_TURN_TRACE_PATH
      const domLedgerPath = flags.has('dom-ledger')
        ? path.resolve(String(flags.get('dom-ledger')))
        : DEFAULT_DOM_LEDGER_PATH
      const parsed = JSON.parse(await fs.readFile(path.resolve(jobsFile), 'utf8'))
      if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('actor batch jobs file must be a non-empty JSON array')
      if (parsed.length > 100) throw new Error('actor batch jobs file exceeds the 100-job safety limit')

      const results = []
      let previousFinishedAt = 0
      for (let index = 0; index < parsed.length; index += 1) {
        const raw = parsed[index]
        if (!raw || typeof raw !== 'object') throw new Error(`actor batch job ${index} must be an object`)
        const mode = String(raw.mode ?? 'auto')
        if (!['auto', 'new', 'continue', 'steer'].includes(mode)) {
          throw new Error(`actor batch job ${index} has invalid mode=${mode}`)
        }
        const conversationId = typeof raw.conversation === 'string' && raw.conversation.trim()
          ? raw.conversation.trim()
          : typeof raw.conversationId === 'string' && raw.conversationId.trim()
            ? raw.conversationId.trim()
            : null
        const projectName = typeof raw.project === 'string' && raw.project.trim()
          ? raw.project.trim()
          : null
        const promptFile = typeof raw.promptFile === 'string' && raw.promptFile.trim()
          ? path.resolve(path.dirname(path.resolve(jobsFile)), raw.promptFile.trim())
          : null
        const prompt = typeof raw.prompt === 'string'
          ? raw.prompt
          : promptFile ? await fs.readFile(promptFile, 'utf8') : ''
        if (!prompt.trim()) throw new Error(`actor batch job ${index} has no prompt or promptFile content`)

        // 这是稳定性限速，不是固定开环调度：真正进入下一条之前，上一条必须已经通过
        // sendActorPrompt 的 route/context/network 2xx 闭环。minGap 只提供额外请求预算保护。
        const earliestAt = previousFinishedAt + minGapMs
        const delayMs = Math.max(0, earliestAt - Date.now())
        if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs))

        const startedAt = Date.now()
        const result = await sendActorPrompt({
          cdpHttp,
          statePath: actorStatePath,
          daemonStatePath: DEFAULT_DAEMON_STATE_PATH,
          domLedgerPath,
          tracePath,
          prompt,
          conversationId,
          projectName,
          mode,
          targetMode: actorTarget,
          timeoutMs,
        })
        previousFinishedAt = Date.now()
        results.push({
          index,
          startedAt,
          finishedAt: previousFinishedAt,
          mode,
          conversationId,
          projectName,
          result,
        })
      }
      console.log(JSON.stringify({
        completed: results.length,
        minGapMs,
        target: actorTarget,
        results,
      }, null, 2))
      return
    }
    throw new Error('actor requires send|batch|inspect|status|reset')
  }

  if (command === 'protocol') {
    await protocolCommand(positionals, flags)
    return
  }

  const archive = new ChatArchiveDb(dbPath(flags))
  try {
    if (command === 'import') {
      if (positionals.length === 0) throw new Error('import requires at least one JSON file')
      const results = []
      for (const file of positionals) results.push(...await importFile(archive, file))
      console.log(JSON.stringify({ database: archive.filePath, imported: results }, null, 2))
      return
    }

    if (command === 'recover') {
      if (positionals.length === 0) throw new Error('recover requires at least one recovery JSON file')
      const results = []
      for (const file of positionals) results.push(...await recoverFile(archive, file))
      console.log(JSON.stringify({ database: archive.filePath, recovered: results }, null, 2))
      return
    }

    if (command === 'import-official') {
      if (positionals.length === 0) throw new Error('import-official requires at least one ChatGPT export ZIP')
      const results = await importOfficialExportZips(archive, positionals)
      console.log(JSON.stringify({ database: archive.filePath, sources: results, stats: archive.stats() }, null, 2))
      return
    }

    if (command === 'list') {
      console.log(JSON.stringify(archive.list(limit(flags, 50)), null, 2))
      return
    }

    if (command === 'search') {
      if (positionals.length === 0) throw new Error('search requires an FTS query')
      const query = positionals.join(' ')
      const sortFlag = String(flags.get('sort') || 'relevance')
      if (!['relevance', 'recent', 'frequency'].includes(sortFlag)) {
        throw new Error(`Unknown --sort ${sortFlag}; use relevance|recent|frequency`)
      }
      const snippetsFlag = Number(flags.get('snippets-per-conversation') || 3)
      const snippetsPerConversation = Number.isFinite(snippetsFlag) ? Math.max(1, Math.min(10, Math.trunc(snippetsFlag))) : 3
      console.log(JSON.stringify(archive.searchConversations(query, {
        limit: limit(flags, 20),
        sort: sortFlag,
        snippetsPerConversation,
      }), null, 2))
      return
    }

    if (command === 'search-messages') {
      if (positionals.length === 0) throw new Error('search-messages requires an FTS query')
      const query = positionals.join(' ')
      console.log(JSON.stringify(archive.searchMessages(query, limit(flags, 20)), null, 2))
      return
    }

    if (command === 'show') {
      const id = positionals[0]
      if (!id) throw new Error('show requires a conversation ID')
      const format = String(flags.get('format') || 'md')
      if (format === 'md') {
        const markdown = archive.getMarkdown(id)
        if (markdown === null) throw new Error(`Conversation not found: ${id}`)
        process.stdout.write(markdown)
        return
      }
      if (format === 'json') {
        console.log(JSON.stringify(archive.getMessages(id), null, 2))
        return
      }
      if (format === 'resources') {
        console.log(JSON.stringify(archive.getResources(id), null, 2))
        return
      }
      throw new Error(`Unknown --format ${format}; use md|json|resources`)
    }

    if (command === 'stats') {
      console.log(JSON.stringify(archive.stats(), null, 2))
      return
    }

    if (command === 'sources') {
      console.log(JSON.stringify(archive.listSources(), null, 2))
      return
    }

    if (command === 'schema') {
      const sourceFlag = flags.get('source')
      const sourceId = sourceFlag === undefined ? undefined : Number(sourceFlag)
      if (sourceId !== undefined && (!Number.isInteger(sourceId) || sourceId <= 0)) throw new Error('--source must be a positive integer')
      console.log(JSON.stringify(archive.schemaFields(sourceId), null, 2))
      return
    }

    if (command === 'reindex') {
      if (flags.has('search-only')) {
        archive.rebuildSearchIndexes({ includeAuditText: flags.has('all') })
        console.log(JSON.stringify({
          database: archive.filePath,
          searchOnly: true,
          includeAuditText: flags.has('all'),
          stats: archive.stats(),
        }, null, 2))
        return
      }
      if (flags.has('bigram-only')) {
        const rebuiltBigramMessages = archive.rebuildBigramSearchIndex()
        console.log(JSON.stringify({
          database: archive.filePath,
          bigramOnly: true,
          rebuiltBigramMessages,
        }, null, 2))
        return
      }
      const resourceCount = archive.rebuildDerivedResources()
      archive.rebuildSearchIndexes({ includeAuditText: flags.has('all') })
      console.log(JSON.stringify({
        database: archive.filePath,
        includeAuditText: flags.has('all'),
        rebuiltResources: resourceCount,
        stats: archive.stats(),
      }, null, 2))
      return
    }

    if (command === 'incidents') {
      const statusFlag = flags.get('status')
      const status = statusFlag === undefined ? undefined : String(statusFlag)
      if (status !== undefined && status !== 'open' && status !== 'resolved') {
        throw new Error('--status must be open|resolved')
      }
      console.log(JSON.stringify(archive.listIncidents({
        status,
        limit: limit(flags, 100),
      }), null, 2))
      return
    }

    throw new Error(`Unknown command: ${command}`)
  }
  finally {
    archive.close()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
