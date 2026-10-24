#!/usr/bin/env node

/**
 * ChatGPT Archive Phase 2 daemon（Node 原型/当前实现）。
 *
 * 它刻意不依赖 OpenCLI，也不在用户日常 ChatGPT tab 中跑 Fleet：
 * - 复用现有 CDP Chrome 的同一 browser process + 同一 profile；
 * - 自己创建/认领一个独立、最小化的 ChatGPT 首页窗口；
 * - 只在这一页监听官方 WSS，并捕获页面自然请求里的认证上下文；
 * - WSS 把 conversation 标 dirty，daemon 再按 modern cursor 分页增量同步 SQLite；
 * - 冷启动/WSS gap/低频兜底才扫描 conversation list；
 * - 所有请求串行、带间隔；429 会触发全局 cooldown。
 *
 * 这不是“爬虫”：正常稳态的 discovery 来自官方 WSS；REST 只同步已经发生变化的对象。
 */

import fs from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { createServer as createNetServer } from 'node:net'
import process from 'node:process'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  ChatArchiveDb,
  devSpaceVirtualConversationId,
} from '../src/local/archive-db.ts'
import { ArchiveMergeWorker } from '../src/local/archive-merge-worker-client.ts'
import {
  ArchiveEvidenceStore,
  prepareArchiveEvidence,
} from '../src/local/archive-evidence-store.ts'
import {
  ActiveTurnRecorder,
  buildBodySnapshotTrace,
  buildCatalogObservationTrace,
  buildWssLifecycleTrace,
} from '../src/local/active-turn-recorder.ts'
import {
  BARK_NOTIFICATION_GROUPS,
  loadIncidentNotificationConfig,
  sendIncidentNotification,
} from '../src/local/incident-notifier.ts'
import { summarizeFrame as summarizeWssFrame } from './wss-stability-probe.mjs'
import {
  ProtocolDriftLedger,
  dedupeProtocolAssessments,
  formatProtocolDriftAssessment,
} from '../src/local/protocol-drift.ts'
import { diagnoseLatestRun } from '../src/core/run-diagnostics.ts'
import { LiveTurnTransportTracker } from '../src/local/live-turn-transport.ts'
import { LiveSseJournalStream } from '../src/local/live-sse-journal.ts'
import { LiveSseCanonicalAccumulator } from '../src/local/live-sse-canonical.ts'
import {
  checkpointProbeDelayMs,
  createCheckpointWatch,
  normalizeCheckpointStreamStatus,
  recordCheckpointBody,
  recordCheckpointError,
  recordCheckpointStatus,
} from '../src/local/checkpoint-refresh.ts'
import {
  DevSpaceAuditBridge,
  defaultDevSpaceDbPath,
  devSpaceToolArgsFingerprint,
  devSpaceTraceIdFromRequestMetaJson,
  matchDevSpaceCandidateForTurn,
  matchingDevSpaceTraceIdsForTurn,
  parseDevSpaceBodyToolCall,
} from '../src/local/devspace-audit-bridge.ts'
import { DevSpaceAuditWakeListener } from '../src/local/devspace-audit-signal.ts'
import {
  ArchiveBridgeServer,
  buildArchiveBridgeWorksite,
  ensureArchiveBridgeAuthToken,
} from '../src/local/archive-bridge.ts'
import { LifeOpsSyncClient, loadLifeOpsSyncConfig } from '../src/local/lifeops-sync.ts'
import { sendActorPrompt } from '../src/local/chatgpt-actor.ts'
import {
  familyBackoffUntil,
  familyProbationRemaining,
  familyRateLimitAllowed,
  guardianBlockedUrlPatterns,
  recordFamily429,
  recordFamilySuccess,
  restoreFamilyRateLimitSnapshot,
} from '../src/local/rate-limit-state.ts'
import { adaptConversation } from '../src/core/adapter.ts'
import { RequestEventLedger } from '../src/local/request-event-ledger.ts'
import {
  extractProjectCatalogPayload,
  PROJECT_SIDEBAR_PATH,
  PROJECT_SIDEBAR_ROUTE,
} from '../src/local/project-catalog.ts'
import {
  buildGlobalCatalogPath,
  captureGlobalCatalogQueryTemplate,
  FIRST_PARTY_REPLAY_HEADER_ALLOWLIST,
  sanitizeFirstPartyReplayHeaders,
} from '../src/core/first-party-request-context.ts'

const execFileAsync = promisify(execFile)

const DEFAULT_CDP = 'http://127.0.0.1:9222'
const GUARDIAN_MARKER = 'chatgpt-archive-guardian'
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_DB = path.join(PROJECT_ROOT, 'data', 'chatgpt-archive.sqlite')
const DEFAULT_STATE = path.join(PROJECT_ROOT, 'data', 'archive-daemon-state.json')
const DEFAULT_LOG = path.join(PROJECT_ROOT, 'data', 'archive-daemon.log')
const DEFAULT_TURN_TRACE = path.join(PROJECT_ROOT, 'data', 'active-turn-trace.jsonl')
const DEFAULT_LIVE_SSE_DIR = path.join(PROJECT_ROOT, 'data', 'live-sse')
const DEFAULT_NOTIFICATION_CONFIG = path.join(PROJECT_ROOT, 'data', 'archive-notification.local.json')
const DEFAULT_PROTOCOL_LEDGER = path.join(PROJECT_ROOT, 'data', 'protocol-fingerprints.json')
const DEFAULT_REQUEST_EVENT_LEDGER = path.join(PROJECT_ROOT, 'data', 'archive-request-events.jsonl')
const DEFAULT_ARCHIVE_EVIDENCE_DIR = path.join(PROJECT_ROOT, 'data', 'evidence', 'archive')
const DEFAULT_ACTOR_STATE = path.join(PROJECT_ROOT, 'data', 'archive-actor-state.json')
const DEFAULT_ACTOR_SUBMISSION_QUEUE = path.join(PROJECT_ROOT, 'data', 'archive-actor-submissions.json')
const DEFAULT_DOM_LEDGER = path.join(PROJECT_ROOT, 'data', 'dom-fingerprints.json')
const DEFAULT_BRIDGE_AUTH = path.join(PROJECT_ROOT, 'data', 'archive-bridge-auth.local.json')
const DEFAULT_LIFEOPS_SYNC_CONFIG = path.join(PROJECT_ROOT, 'data', 'lifeops-sync.local.json')
const DEFAULT_LIFEOPS_SYNC_PENDING = path.join(PROJECT_ROOT, 'data', 'lifeops-sync-pending.json')
const DEFAULT_BRIDGE_HOST = '127.0.0.1'
const DEFAULT_BRIDGE_PORT = 47_832
const DEFAULT_SINGLETON_HOST = '127.0.0.1'
const DEFAULT_SINGLETON_PORT = 47_830
const DEFAULT_IMAGE_ASSET_DIR = path.join(PROJECT_ROOT, 'data', 'assets', 'chatgpt')
const DEVSPACE_POLL_OVERLAP_MS = 10_000
const DEVSPACE_AUDIT_CONSUMER_KEY = 'archive-daemon'
// DevSpace audit 的消费必须主动给 Node event loop 让路。
//
// 这里故意把单批压得很小：每条 audit 后面还可能触发 recovery mirror、Binding Queue
// exact-match 与同步 SQLite 查询。即使单条通常很快，几十/几百条连续执行也会让同进程的
// Archive Bridge HTTP 完全拿不到调度，LifeOps 就会看到 5s search / 12s conversation timeout。
// 一批 4 条的目标不是提高吞吐，而是把“最大连续占用主线程”的上界压低；剩余 backlog 用
// setImmediate 续跑，让 HTTP/WSS/timer/CDP 回调在批次之间获得机会。
// DevSpace audit 是控制面入口，单条内部仍包含若干同步 SQLite 操作。
// 在这些写路径完全迁出主线程前，不再把多条 audit 串成一个不可抢占批次；
// backlog 通过 setImmediate continuation 逐条追平。
const DEVSPACE_AUDIT_BATCH_SIZE = 1
const DEVSPACE_FALLBACK_POLL_MS = 60_000
const DEVSPACE_IDLE_ALERT_THRESHOLDS_MS = [60_000, 180_000, 300_000]
const DEVSPACE_IDLE_STARTUP_LOOKBACK_MS = 6 * 60_000
// 新 completion 后首次 DevSpace activity 只允许一次主动 Body 身份确认。给页面自然 Body 一个很短的
// 抢先窗口；若 passive Body 先到，ready queue 会直接复用它，从而省掉主动 GET。这里不是 idle probe。
const POST_COMPLETION_TURN_CHECK_DELAY_MS = 1_500
const IMAGE_ASSET_HYDRATE_INTERVAL_MS = 30_000
const SLEEPING_TARGET_RETRY_MS = 5 * 60_000
const PASSIVE_OBSERVER_HEALTH_INTERVAL_MS = 30_000
const PASSIVE_OBSERVER_HEALTH_TIMEOUT_MS = 5_000
const PASSIVE_OBSERVER_HEALTH_FAILURE_THRESHOLD = 2
const PASSIVE_OBSERVER_ZOMBIE_RETRY_MS = 1_000
const WINDOWS_HIDE_HELPER = path.join(PROJECT_ROOT, 'scripts', 'windows-hide-window.ps1')
const DEFAULT_CDP_TIMEOUT_MS = 10_000
const DEFAULT_CHROME_SHORTCUT = process.platform === 'win32' && process.env.USERPROFILE
  ? path.join(process.env.USERPROFILE, 'Desktop', 'Chrome CDP 日常版.lnk')
  : null

/**
 * 把任何顶层 fatal 原因规范化成可落盘文本。
 *
 * 这里不能假设 rejection 一定是 Error：第三方回调、事件监听器或裸 Promise
 * 都可能 reject 任意对象。JSON.stringify 失败时再退回 String，保证“记录 fatal”
 * 本身永远不会因为异常值而再次抛错。
 */
export async function acquireArchiveDaemonSingleton({
  host = DEFAULT_SINGLETON_HOST,
  port = DEFAULT_SINGLETON_PORT,
} = {}) {
  const server = createNetServer()
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.removeListener('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen({ host, port, exclusive: true })
  })
  return server
}

export function formatDaemonFatalError(error) {
  if (error instanceof Error) return error.stack || error.message
  if (typeof error === 'string') return error
  try {
    const serialized = JSON.stringify(error)
    if (serialized) return serialized
  }
  catch {
    // 循环引用等不可 JSON 化对象继续走 String fallback。
  }
  return String(error)
}

/**
 * 追加一条不会污染正常结构化日志格式的 fatal 记录。
 *
 * 正常 loop error 已由 main 内部 catch 自愈并写 archive-daemon.log；这里只覆盖
 * main() reject / uncaughtException / unhandledRejection 这种“进程将退出”的边界。
 */
export async function appendDaemonFatalLog(logPath, source, error, now = Date.now()) {
  const resolvedLogPath = path.resolve(String(logPath || DEFAULT_LOG))
  const payload = {
    source: String(source || 'unknown'),
    error: formatDaemonFatalError(error),
  }
  const line = '[' + new Date(Number(now) || Date.now()).toISOString() + '] daemon fatal ' + JSON.stringify(payload) + '\n'
  await fs.mkdir(path.dirname(resolvedLogPath), { recursive: true }).catch(() => {})
  await fs.appendFile(resolvedLogPath, line).catch(() => {})
  return line
}

/** 从 CLI 参数解析 fatal 日志位置；与 main() 的 --log 语义保持一致。 */
export function daemonFatalLogPath(argv = process.argv.slice(2)) {
  const flags = parseArgs(argv)
  return flags.has('log') ? path.resolve(String(flags.get('log'))) : DEFAULT_LOG
}

class CdpClient {
  constructor(url) {
    this.url = url
    this.ws = null
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Map()
    this.closed = false
  }

  async connect() {
    this.ws = new WebSocket(this.url)
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data))
      if (typeof message.id === 'number') {
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        clearTimeout(pending.timer)
        if (message.error) pending.reject(new Error(message.error.message || 'CDP error'))
        else pending.resolve(message.result || {})
        return
      }
      if (typeof message.method === 'string') {
        for (const handler of this.listeners.get(message.method) || []) {
          try { handler(message.params || {}) }
          catch (error) { console.error('[archive-daemon] CDP event error', error) }
        }
      }
    })
    this.ws.addEventListener('close', () => {
      this.closed = true
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer)
        pending.reject(new Error(`CDP connection closed while waiting for request ${id}`))
      }
      this.pending.clear()
    })
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP connect timed out: ${this.url}`)), DEFAULT_CDP_TIMEOUT_MS)
      this.ws.addEventListener('open', () => {
        clearTimeout(timer)
        resolve()
      }, { once: true })
      this.ws.addEventListener('error', () => {
        clearTimeout(timer)
        reject(new Error(`CDP connect failed: ${this.url}`))
      }, { once: true })
    })
  }

  send(method, params = {}, timeoutMs = DEFAULT_CDP_TIMEOUT_MS) {
    if (!this.ws || this.closed) return Promise.reject(new Error('CDP client is closed'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      // 被 Auto Tab Discard 真正 discard 的 renderer 可能保留 CDP target/socket，却永远不再
      // 回答 Runtime/Page 命令。没有硬超时的话 daemon 会永久挂在一次健康检查上。
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  on(method, handler) {
    const set = this.listeners.get(method) || new Set()
    set.add(handler)
    this.listeners.set(method, set)
    return () => {
      set.delete(handler)
      if (set.size === 0) this.listeners.delete(method)
    }
  }

  close() {
    this.closed = true
    this.ws?.close()
  }
}

function parseArgs(argv) {
  const flags = new Map()
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i]
    if (!value.startsWith('--')) continue
    const name = value.slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      flags.set(name, next)
      i += 1
    }
    else flags.set(name, true)
  }
  return flags
}

function intFlag(flags, name, fallback, min = 0) {
  const value = Number(flags.get(name) ?? fallback)
  if (!Number.isFinite(value) || value < min) throw new Error(`--${name} must be >= ${min}`)
  return Math.round(value)
}

/**
 * Chrome 根进程级恢复。
 *
 * Guardian 不需要自己的浏览器/profile；它应始终复用用户已经登录的 CDP Chrome。
 * 如果 9222 整体不可达，daemon 才用同一 executable + user-data-dir + profile 拉起 Chrome。
 * Chrome 已经运行时该函数只是廉价探活，不会启动第二个 browser process。
 */
async function ensureCdpBrowser(flags, cdpHttp) {
  try {
    const response = await fetch(`${cdpHttp}/json/version`, { signal: AbortSignal.timeout(3000) })
    if (response.ok) return { launched: false, version: await response.json() }
  }
  catch {
    // 进入启动恢复分支。
  }

  if (flags.has('no-auto-launch-chrome')) {
    throw new Error(`CDP browser unavailable at ${cdpHttp} and auto launch is disabled`)
  }
  if (process.platform !== 'win32') {
    throw new Error(`CDP browser unavailable at ${cdpHttp}; automatic Chrome launch is currently Windows-only`)
  }

  // Chrome 启动参数只维护在用户日常使用的快捷方式里。这样将来修改代理、LNA、
  // remote-debugging 或其它实验参数时，Archive daemon 不需要复制/同步第二份配置。
  const shortcut = path.resolve(String(flags.get('chrome-shortcut') || DEFAULT_CHROME_SHORTCUT || ''))
  try {
    await fs.access(shortcut)
  }
  catch {
    throw new Error(`CDP browser unavailable and Chrome shortcut does not exist: ${shortcut}`)
  }

  // Windows Shell 才知道如何正确展开 .lnk。start 的第一个空字符串是窗口标题占位，
  // 不能省略，否则带空格的快捷方式路径会被 cmd 误当成 title。
  const child = spawn('cmd.exe', ['/d', '/s', '/c', 'start', '', shortcut], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()

  const deadline = Date.now() + intFlag(flags, 'chrome-start-timeout-ms', 30_000, 1000)
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${cdpHttp}/json/version`, { signal: AbortSignal.timeout(2000) })
      if (response.ok) return { launched: true, version: await response.json(), launcherPid: child.pid, shortcut }
    }
    catch (error) {
      lastError = error
    }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error(`Chrome shortcut did not restore CDP ${cdpHttp}: ${lastError instanceof Error ? lastError.message : 'timeout'}`)
}

/**
 * 将 WSS event 只解释成“状态提示”，不要把它和“立即发 body 请求”绑死。
 *
 * - 所有 conversations topic event 都意味着本地副本可能 stale，因此一律 dirty；
 * - complete 是正常的 sync-ready 信号；
 * - 真实抓包已经确认 `conversation-update + async-task-update-message` 会在其它 conversation
 *   仍在异步运行时持续出现，因此它才是当前最可靠的“正在活跃/仍有进展”实时信号；
 * - `conversation-turn-start` 目前尚未在真实样本里观察到，只保留兼容能力，不能再把设计
 *   建立在“服务器一定会发 start”这个未经证实的假设上；
 * - conversation-created 说明对象刚出现，但它可能在 turn-complete 之后才到（真实实验就抓到过），
 *   因而只标 dirty，不单独把它当作“现在一定有一个 running turn”。
 */
export function classifyConversationEvent(type, updateType = null) {
  const normalized = String(type || '').toLowerCase()
  const normalizedUpdateType = String(updateType || '').toLowerCase()
  const complete = normalized.includes('complete')
  const explicitTurnStart = normalized.includes('turn') && /(start|begin|created)/u.test(normalized)
  const asyncProgress = normalized === 'conversation-update'
    && normalizedUpdateType === 'async-task-update-message'
  return {
    dirty: true,
    syncReady: complete,
    startsTurn: explicitTurnStart || asyncProgress,
    completesTurn: complete,
    asyncProgress,
    explicitTurnStart,
  }
}

/**
 * 决定一次 body merge 是否有资格把“异常尾部”升级成 incident。
 *
 * 为什么不能所有同步都 classify：
 * - startup / periodic reconciliation 可能一次补几十上百条历史 backlog；
 * - 其中旧的 client_stopped / 半截 tool tail 适合归档取证，但不应在今天重新制造大量“实时事故”。
 *
 * 为什么 watchdog 必须 classify：
 * - watchdog 本来就是“我们认为这一轮可能异常长/漏 complete”才主动做的诊断抓取；
 * - 如果抓到明确 abnormal terminal，却因为 trigger 不含 complete 而不建 incident，就失去 watchdog 的意义。
 */
export function shouldClassifyCompletionForTrigger(trigger) {
  const normalized = String(trigger || '').trim().toLowerCase()
  if (normalized.startsWith('watchdog:')) return true
  if (normalized.startsWith('devspace-idle:bound-probe')) return true
  if (normalized.startsWith('wss:') && normalized.includes('complete')) return true
  // startup 是“把停机期间甚至更久以前的历史补回来”，不能因为今天重启就把旧异常重新报警。
  // periodic / WSS reconnect / Guardian recover 则是在线系统的 gap repair：它们发现的较新变化
  // 本来就应该由 realtime 链处理，只是 WSS 中间漏了，所以允许做终态 incident 分类。
  return normalized.startsWith('reconcile:periodic')
    || normalized.startsWith('reconcile:wss-reconnect')
    || normalized.startsWith('reconcile:guardian-recover')
    || normalized.startsWith('reconcile:gap-repair')
    || normalized.startsWith('reconcile:cooldown-recover')
}

/**
 * 某个 trigger 是否已经提供“这一轮服务端确定结束”的外部证据。
 *
 * 这和 shouldClassifyCompletionForTrigger 不同：watchdog / gap repair 可以读取 body 并识别
 * `client_stopped` 这类显式终止，但如果没有 complete 证据，单凭 reasoning/tool 尾巴仍不能
 * 推断“已经死了”。只有 WSS complete 或 catalog 明确 active→async_status=4 才允许把
 * `bodyCompletionEvidence=none + 非 final tail` 提升成异常 incident。
 */
export function isConfirmedCompletionTrigger(trigger) {
  const normalized = String(trigger || '').trim().toLowerCase().replace(/:settle$/u, '')
  if (normalized.startsWith('wss:') && normalized.includes('complete')) return true
  return normalized.startsWith('reconcile:') && normalized.endsWith(':async-complete')
}

/**
 * complete 是强 lifecycle 证据，但 conversation body 的持久化可能比 WSS complete 慢一拍。
 *
 * 第一次 complete 同步若仍只看到 bodyCompletionEvidence=none，不应立即把 reasoning/tool/in_progress
 * 快照推成 complete-no-final 手机告警。先保存事实并进入一次有界 settle；`:settle` 二次复核后
 * 仍无终态，才允许正式立案。显式 final / interrupted 不需要等待。
 */
export function shouldDeferConfirmedCompletionIncident(trigger, diagnostic) {
  const normalized = String(trigger || '').trim().toLowerCase()
  if (normalized.endsWith(':settle')) return false
  return isConfirmedCompletionTrigger(normalized) && diagnostic?.bodyCompletionEvidence === 'none'
}

/**
 * 把 conversation list 的 async_status 压成 daemon 只关心的三态。
 *
 * 真实历史交叉验证过：3/5 对应进行态，4 对应完成态。这里仍然刻意保守：
 * - 3 / 5：可以建立 active/watchdog，但不能单凭它宣布“模型一定还在计算”；
 * - 4：只表示服务端认为异步工作已结束，最终正常/异常仍要看 conversation body；
 * - null/其它：unknown，不猜。
 */
export function classifyCatalogAsyncStatus(value) {
  const normalized = typeof value === 'string' && /^\d+$/u.test(value.trim())
    ? Number(value.trim())
    : value
  if (normalized === 3 || normalized === 5) return 'active'
  if (normalized === 4) return 'complete'
  return 'unknown'
}

/**
 * catalog 只能告诉我们“扫描这一刻它仍被服务端标成 active”，不能还原真实 POST 时刻。
 * 但这个观察时刻可以作为一个保守的 late-start 下界：真实 turn 一定不晚于它开始。
 *
 * 为避免把已经正常 final、只是 catalog 的 async_status 暂时滞留为 3 的旧 turn 反复拉进
 * watchdog，这里会比较 catalog.update_time 与 Archive 已落盘的 Body completion snapshot。
 */
export function shouldStartCatalogWatchdog({
  alreadyActive = false,
  catalogObservationCompleted = false,
  catalogUpdateTime = null,
  archivedUpdateTime = null,
  archivedBodyCompletionState = null,
} = {}) {
  if (alreadyActive || catalogObservationCompleted) return false
  const completion = String(archivedBodyCompletionState ?? '').trim().toLowerCase()
  const hasCompletion = completion && completion !== 'none' && completion !== 'unknown'
  const parseTime = (value) => {
    if (value === null || value === undefined || value === '') return null
    const numeric = Number(value)
    return Number.isFinite(numeric) ? numeric : null
  }
  const catalogTime = parseTime(catalogUpdateTime)
  const archivedTime = parseTime(archivedUpdateTime)
  if (hasCompletion && catalogTime !== null && archivedTime !== null && catalogTime <= archivedTime) return false
  return true
}

/** 同一 catalog observation 被多次看见时保留最早 late-start 下界与最新证据时间。 */
export function mergeDeferredCatalogWatchdogCandidate(existing, input = {}) {
  const startedAt = Number(input.startedAt)
  const lastEventAt = Number(input.lastEventAt ?? input.startedAt)
  if (!Number.isFinite(startedAt) || startedAt <= 0) return existing ?? null
  if (!Number.isFinite(lastEventAt) || lastEventAt <= 0) return existing ?? null
  return {
    conversationId: input.conversationId ?? existing?.conversationId ?? null,
    startedAt: existing ? Math.min(Number(existing.startedAt), startedAt) : startedAt,
    lastEventAt: existing ? Math.max(Number(existing.lastEventAt), lastEventAt) : lastEventAt,
    startType: input.startType ?? existing?.startType ?? 'catalog:async-active:deferred',
    title: input.title ?? existing?.title ?? null,
    updateTime: input.updateTime ?? existing?.updateTime ?? null,
    bodyTurnExchangeId: existing?.bodyTurnExchangeId ?? null,
    bodyCompletionEvidence: existing?.bodyCompletionEvidence ?? null,
    bodyObservedAt: existing?.bodyObservedAt ?? null,
  }
}

/**
 * catalog update_time 前进代表服务端确实出现了新进展。
 *
 * catalog progress 只能推进 lastEventAt 作为证据，绝不能修改 generation.startedAt。
 * Watchdog 的 45m 是硬边界，不因 catalog update_time 前进而续命。已经 timeout 的 generation
 * 已经离开 activeTurns；后续新的 catalog observation 若 update_time 真正变化，会通过独立
 * watermark 判据自然建立新的弱 generation。
 */
export function recordCatalogWatchdogProgress(active, now = Date.now()) {
  if (!active || typeof active !== 'object') return active
  if (!/^(?:catalog|project-catalog):/u.test(String(active.startType || ''))) return active
  const at = Number(now)
  if (!Number.isFinite(at) || at <= 0) return active
  return {
    ...active,
    lastEventAt: at,
  }
}

/** catalog update_time 变化会开启新的弱 observation generation；未变化才沿用原 firstSeenAt。 */
export function catalogObservationStartedAt(current, nextUpdateTime, now = Date.now()) {
  const observedAt = Number(now)
  const currentFirstSeenAt = Number(current?.firstSeenAt)
  const progressed = Boolean(
    current
    && nextUpdateTime !== null
    && nextUpdateTime !== undefined
    && String(nextUpdateTime) !== String(current.updateTime ?? ''),
  )
  if (progressed) return Number.isFinite(observedAt) ? observedAt : Date.now()
  return Number.isFinite(currentFirstSeenAt) && currentFirstSeenAt > 0
    ? currentFirstSeenAt
    : (Number.isFinite(observedAt) ? observedAt : Date.now())
}

/**
 * DevSpace audit polling 会故意回看一个短 overlap，避免 cursor 边界丢事件。
 * 因此 seen-id 只能在对应事件已经落到“下一次查询下界”之外后删除；按 wall-clock 年龄
 * 清理会让长时间没有新 audit 时的最后一条记录永远留在 overlap 中，并在 seen-id 过期后
 * 被每轮重新当成新 first-tool 处理。
 */
export function shouldRetainSeenDevSpaceAudit(eventAt, pollSinceAt, overlapMs = 10_000) {
  const event = Number(eventAt)
  const cursor = Number(pollSinceAt)
  const overlap = Math.max(0, Number(overlapMs) || 0)
  if (!Number.isFinite(event) || !Number.isFinite(cursor)) return false
  const replayFloor = Math.max(0, cursor - overlap)
  return event >= replayFloor
}

/**
 * 判断一个 CDP target 是否应该挂“普通页面被动 observer”。
 *
 * 早期实现为了避免 Guardian 与普通页职责混在一起，显式排除了 guardian targetId。
 * 但 Phase 4 已真机证明 Guardian 可以直接承担 Actor；此时它自己发出的 `/f/conversation`
 * SSE 正是 Phase 3 最完整的 LiveTurn 数据源。如果仍排除 Guardian，物理合并虽然省了一个 tab，
 * 却会把最有价值的原始 SSE 丢掉。
 *
 * 一个 page target 可以同时被多个 CDP session 观察：Guardian 主 session 继续负责 WSS、健康检查、
 * cooldown `Network.setBlockedURLs` 等控制面；被动 observer session 只 `Network.enable` 并读取页面已经
 * 自然产生的 response/stream，不创建请求、不改路由。因此这里不再按 Guardian 身份排除。
 */
export function shouldRunHistoricalDevSpaceBackfill(hadExistingBindings, createdCount) {
  return !hadExistingBindings && Number(createdCount) > 0
}

export function shouldAttachPassivePageObserver(target) {
  const title = String(target?.title || '').trim()
  return Boolean(
    target?.type === 'page'
    && typeof target?.webSocketDebuggerUrl === 'string'
    && target.webSocketDebuggerUrl
    && String(target?.url || '').startsWith('https://chatgpt.com/')
    // 当前 Chrome/本机休眠页会以“💤 ChatGPT”暴露 target，但 renderer CDP session 完全不响应：
    // Runtime.evaluate / Page.getFrameTree / Network.enable 均会超时。休眠期间页面本来也不会产生
    // Network 事件，因此 attach 没有任何观测收益，只会每次白等 timeout。醒来后 title 恢复，
    // 下一轮 target refresh 会自然重新进入 eligible 集合。
    && !title.startsWith('💤')
  )
}

/**
 * 普通 ChatGPT target 的 observer attach 失败使用固定低频重试。
 * 这类失败经常只是 Chrome 正常冻结/休眠；不能按 Guardian 故障处理，也不能指数退避，
 * 否则 target 醒来后可能要很久才重新被 observer 接管。failureCount 只用于遥测，不改变间隔。
 */
export function passiveObserverRetryDelayMs(
  _failureCount,
  baseMs = SLEEPING_TARGET_RETRY_MS,
  _maxMs = 60 * 60_000,
) {
  const base = Math.max(1000, Number(baseMs) || SLEEPING_TARGET_RETRY_MS)
  return base
}

/**
 * 长期 passive observer 可能出现“target 和 WebSocket 都还在，但这个 CDP session 已经不再
 * 收到 renderer Network 事件”的 zombie。只有在没有正在收流的 LiveTurn 时才允许做本地
 * liveness probe，避免为了健康检查打断一条仍在生成的 SSE。
 */
export function shouldProbePassivePageObserver(input, intervalMs = PASSIVE_OBSERVER_HEALTH_INTERVAL_MS) {
  if (!input || input.clientClosed === true || input.hasActiveTransport === true) return false
  const now = Number(input.now)
  const lastHealthAt = Number(input.lastHealthAt || 0)
  const interval = Math.max(1000, Number(intervalMs) || PASSIVE_OBSERVER_HEALTH_INTERVAL_MS)
  if (!Number.isFinite(now) || now <= 0) return false
  return lastHealthAt <= 0 || now - lastHealthAt >= interval
}

/** Guardian target 命令超时后，用浏览器级 CDP ping 区分故障层级。 */
export function guardianCdpFailureScope(browserLevelHealthy) {
  return browserLevelHealthy ? 'target' : 'browser'
}

/** 协议指纹 body 读取只是诊断用途，超过并发上限时应让位给业务同步和 health probe。 */
export function shouldReadGuardianProtocolBody(inFlight, maxConcurrent = 2) {
  const active = Math.max(0, Number(inFlight) || 0)
  const limit = Math.max(1, Number(maxConcurrent) || 2)
  return active < limit
}

/** catalog late-start 超时与可靠 start 超时必须保留不同 lifecycle 语义。 */
export function watchdogTriggerForStartType(startType) {
  return String(startType || '').startsWith('catalog:')
    ? 'watchdog:catalog-active-timeout'
    : 'watchdog:active-timeout'
}

/**
 * DevSpace first-tool 开始的是“一个新的、尚未知道 turn_exchange_id 的 turn”。
 * binding.lastTurnExchangeId 属于上一轮已确认 turn，绝不能拿来初始化本轮诊断身份。
 */
export function devSpaceFirstToolWatchdogState(auditAt) {
  const startedAt = Number(auditAt)
  return {
    startedAt,
    lastEventAt: startedAt,
    lastWatchdogAt: null,
    watchdogPendingAt: null,
    startType: 'devspace:first-tool',
    lastDiagnosticTurnKey: null,
  }
}

/**
 * 上一 generation 已经有 canonical verified trace 时，新 trace 可以低延迟证明“这不是上一轮
 * 的残余工具”。它只负责跳过 post-completion Body 身份确认，不会结束仍在 active 的 generation。
 * 任一侧 trace conflict / 未验证都退回原有 Body 确认路径。
 */
export function shouldStartPostCompletionDevSpaceTurnFromTrace({
  traceId = null,
  previousTraceId = null,
  previousTraceStatus = null,
  currentTraceStatus = null,
} = {}) {
  const current = typeof traceId === 'string' ? traceId.trim().toLowerCase() : ''
  const previous = typeof previousTraceId === 'string' ? previousTraceId.trim().toLowerCase() : ''
  if (!current || !previous || current === previous) return false
  if (previousTraceStatus !== 'verified') return false
  return currentTraceStatus === 'provisional' || currentTraceStatus === 'verified'
}

export function planDevSpaceBindingProbes({
  generation = '',
  previousGeneration = '',
  probedConversationIds = [],
  candidateConversationIds = [],
} = {}) {
  const changed = String(generation) !== String(previousGeneration)
  const seen = new Set(changed ? [] : probedConversationIds)
  const targets = []
  for (const conversationId of candidateConversationIds) {
    const id = String(conversationId || '')
    if (!id || seen.has(id)) continue
    seen.add(id)
    targets.push(id)
  }
  return {
    generation: String(generation),
    probedConversationIds: [...seen],
    targets,
  }
}

/**
 * 当前 turn 的 canonical exact match 可以纠正历史 backfill；反过来不允许。
 *
 * `body:exact-tool-args-backfill` 来自一次性历史扫描，曾因缺少 per-call 时间局部性把
 * 33rz... 错绑到另一个 conversation。在线 canonical body 的 exact match 更贴近当前事实，
 * 因此允许它覆盖这种历史 binding；两个在线 exact 互相冲突时仍 fail-closed。
 */
export function shouldSupersedeDevSpaceBinding(existing, candidate) {
  if (!existing?.conversationId || !candidate?.conversationId) return false
  if (existing.conversationId === candidate.conversationId) return false
  return existing.evidence === 'body:exact-tool-args-backfill'
    && candidate.evidence === 'body:exact-tool-args'
}

/**
 * watchdog 只负责“超时后调查一次”，不能退化成固定周期 body 轮询器。
 *
 * 第一次超过阈值时允许调查；调查完成以后，如果再也没有新的运行进展，就保持沉默。
 * 只有 later WSS/catalog 证据把 lastEventAt 推进到上一次 watchdog 之后，才重新武装，
 * 并且要从最后一次进展再等满一个完整 watchdog 窗口才能第二次调查。
 */
export function shouldQueueWatchdogDiagnostic(active, now = Date.now(), watchdogMs = 45 * 60_000) {
  const startedAt = Number(active?.startedAt)
  const lastWatchdogAt = active?.lastWatchdogAt === null || active?.lastWatchdogAt === undefined
    ? null
    : Number(active.lastWatchdogAt)
  const current = Number(now)
  const threshold = Math.max(0, Number(watchdogMs) || 0)
  if (!Number.isFinite(startedAt) || !Number.isFinite(current)) return false
  if (current - startedAt < threshold) return false
  // 每个 logical turn 的 Watchdog 只允许跨过一次 45min 边界。
  // 一旦 lastWatchdogAt 已存在，这一代就已经进入 timed-out / awaiting-diagnosis；
  // 同 turn 后续任何 tool/WSS/catalog progress 只能补证据，不能重新武装第二个 Watchdog。
  return lastWatchdogAt === null || !Number.isFinite(lastWatchdogAt)
}

export function persistedWatchdogCompletionAt(lastWatchdogAt) {
  if (lastWatchdogAt === null || lastWatchdogAt === undefined || lastWatchdogAt === '') return null
  const value = Number(lastWatchdogAt)
  return Number.isFinite(value) ? value : null
}

export function isSqliteBusyError(error) {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return /(?:SQLITE_BUSY|database (?:table )?is locked)/iu.test(message)
}

export async function retryTransientSqliteBusy(work, options = {}) {
  const attempts = Math.max(1, Math.trunc(Number(options.attempts ?? 3)))
  const delayMs = Math.max(0, Math.trunc(Number(options.delayMs ?? 100)))
  let attempt = 0
  while (attempt < attempts) {
    attempt += 1
    try {
      return await work(attempt)
    }
    catch (error) {
      if (!isSqliteBusyError(error) || attempt >= attempts) throw error
      if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs * attempt))
    }
  }
  throw new Error('SQLite busy retry exhausted')
}

/**
 * 从一次 body 诊断里提取稳定的 turn 身份。
 *
 * turn_exchange_id 最强；旧/异常 payload 缺它时再依次退化到 request/user/last message。
 * 这个 key 只用于 watchdog 防止“同一 conversation 的旧计时跨到新 turn”，不写回 canonical 数据。
 */
export function watchdogDiagnosticTurnKey(diagnostic) {
  for (const value of [
    diagnostic?.turnExchangeId,
    diagnostic?.requestId,
    diagnostic?.userMessageId,
    diagnostic?.lastMessageId,
  ]) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

/**
 * 从 canonical body 里恢复当前 logical turn 的真实 user 起点。
 *
 * Watchdog 的 late-start 兜底以前在“诊断时才发现已经换 turn”时，会直接拿“发现时刻”重新
 * 计 45 分钟。对于已经运行了一小时以上的新 turn，这会再平白延迟一个完整 watchdog 窗口。
 * body 既然已经给出了本轮 user message / turn_exchange_id / request_id，就优先使用 user
 * message 的 create_time；拿不到时返回 null，调用方再退回“首次确认看到新 turn”的时刻。
 */
export function watchdogTurnStartedAtFromPayload(payload, diagnostic) {
  const messages = Array.isArray(payload?.messages) ? payload.messages : []
  if (messages.length === 0) return null
  const userMessageId = typeof diagnostic?.userMessageId === 'string' ? diagnostic.userMessageId : null
  const turnExchangeId = typeof diagnostic?.turnExchangeId === 'string' ? diagnostic.turnExchangeId : null
  const requestId = typeof diagnostic?.requestId === 'string' ? diagnostic.requestId : null

  const isUser = message => String(message?.author?.role ?? message?.role ?? '').toLowerCase() === 'user'
  const messageTurn = message => {
    const direct = typeof message?.turn_exchange_id === 'string' ? message.turn_exchange_id : null
    const metadata = message?.metadata && typeof message.metadata === 'object' ? message.metadata : null
    return direct ?? (typeof metadata?.turn_exchange_id === 'string' ? metadata.turn_exchange_id : null)
  }
  const messageRequest = message => {
    const direct = typeof message?.request_id === 'string' ? message.request_id : null
    const metadata = message?.metadata && typeof message.metadata === 'object' ? message.metadata : null
    return direct ?? (typeof metadata?.request_id === 'string' ? metadata.request_id : null)
  }
  const candidates = messages.filter((message) => {
    if (!isUser(message)) return false
    if (userMessageId && message?.id === userMessageId) return true
    if (turnExchangeId && messageTurn(message) === turnExchangeId) return true
    if (requestId && messageRequest(message) === requestId) return true
    return false
  })
  const times = candidates
    .map(message => Number(message?.create_time))
    .filter(value => Number.isFinite(value) && value > 0)
    .map(value => value * 1000)
  return times.length > 0 ? Math.min(...times) : null
}

/**
 * catalog late-start 只能先知道 conversation active，不知道具体 turn。
 * 如果一次 watchdog 已经诊断过 turn A，而后续 body 明确变成 turn B，A 的 startedAt 绝不能
 * 继续给 B 计时。此时把“第一次确认看到 B”的时刻作为新的保守 late-start 下界，并要求 B
 * 自己重新等满一个 watchdog 窗口。
 *
 * 返回 changed=true 时，调用方仍可记录 body 中显式 interrupted/client_stopped；只是不得仅凭
 * open reasoning/tool tail 建 active-zombie/watchdog-timeout。
 */
export function reconcileWatchdogDiagnosticTurn(active, diagnostic, now = Date.now(), observedTurnStartedAt = null) {
  if (!active || typeof active !== 'object') return { changed: false, turnKey: null, nextActive: active }
  const turnKey = watchdogDiagnosticTurnKey(diagnostic)
  if (!turnKey) return { changed: false, turnKey: null, nextActive: active }
  const previous = typeof active.lastDiagnosticTurnKey === 'string' && active.lastDiagnosticTurnKey
    ? active.lastDiagnosticTurnKey
    : null
  const observedStart = Number(observedTurnStartedAt)
  const activeStartedAt = Number(active.startedAt)
  // first-tool generation 在第一次诊断前通常没有 turn key。正常同一 turn 中，user create_time
  // 必然早于（或等于）第一个 DevSpace tool audit；若 Body 当前 user turn 反而严格晚于
  // generation.startedAt，就足以证明 daemon 离线/Body 缺口期间已经跨过了至少一个 turn。
  // 不能因为 previous=null 就把旧 generation 的 45m 计时硬套到这个更新 turn。
  const observedStartProvesNewerTurn = !previous
    && Number.isFinite(observedStart)
    && observedStart > 0
    && Number.isFinite(activeStartedAt)
    && observedStart > activeStartedAt
  if ((previous && previous !== turnKey) || observedStartProvesNewerTurn) {
    const current = Number(now)
    const resetStartedAt = Number.isFinite(observedStart) && observedStart > 0 && observedStart <= current
      ? observedStart
      : current
    const previousLastEventAt = Number(active.lastEventAt)
    const resetLastEventAt = Number.isFinite(previousLastEventAt)
      && previousLastEventAt >= resetStartedAt
      && previousLastEventAt <= current
      ? previousLastEventAt
      : resetStartedAt
    return {
      changed: true,
      turnKey,
      turnStartedAt: resetStartedAt,
      turnStartSource: resetStartedAt === observedStart ? 'body-user-create-time' : 'diagnostic-observed-at',
      nextActive: {
        ...active,
        startedAt: resetStartedAt,
        lastEventAt: resetLastEventAt,
        lastWatchdogAt: null,
        watchdogPendingAt: null,
        lastDiagnosticTurnKey: turnKey,
      },
    }
  }
  return {
    changed: false,
    turnKey,
    turnStartedAt: Number(active.startedAt),
    turnStartSource: null,
    nextActive: { ...active, lastDiagnosticTurnKey: turnKey },
  }
}

/**
 * 一次 watchdog 诊断成功后，这个 generation 是否应该退出 activeTurns。
 *
 * reliable generation 仍以“一次硬超时诊断”为终点；catalog late-start 则必须留下已诊断
 * tombstone，否则 unchanged async-active 会在下一次 gap-repair 从旧 firstSeenAt 原地复活：
 * - reliable：诊断的就是当前 generation，完成后关闭；
 * - catalog：body 无 terminal 时保留 lastWatchdogAt，等待真正 progress/complete；
 * - 诊断时才发现已经换到新 turn，且新 turn 尚未到 45min：保留新 generation；
 * - 新 turn 自己其实也早已超过 45min：本次诊断直接覆盖它，完成后也关闭。
 */
export function shouldCloseWatchdogGenerationAfterSync(trigger, result) {
  return String(trigger || '').startsWith('watchdog:')
}

/**
 * WSS complete / Watchdog timeout 之后的 DevSpace activity 只证明“可能开始了新 turn”。
 * 只有 Body 当前 user turn 的真实 create_time 严格晚于上一 completion，才确认新 generation。
 * 这里只判断证据，不发 Body 请求，也不修改 startedAt。
 */
export function postCompletionBodyConfirmsNewTurn(completedAt, bodyTurnStartedAt) {
  const completed = Number(completedAt)
  const bodyStart = Number(bodyTurnStartedAt)
  return Number.isFinite(completed)
    && completed > 0
    && Number.isFinite(bodyStart)
    && bodyStart > completed
}

/**
 * 判断一份 Body completion evidence 是否有资格影响“当前”generation。
 *
 * - 若双方都有 turn key，必须精确相同；
 * - 否则只要存在上一 completion 边界，就要求 Body user create_time 严格晚于该边界；
 * - 只有首个、尚无任何 completion 边界的 generation 才允许在缺 key 时保守接受。
 *
 * 该判据专门阻止“旧 WSS/Watchdog 触发的延迟 Body final”跨到下一 turn 后误删 candidate/active。
 */
export function bodyCompletionBelongsToCurrentGeneration({
  completedAt = null,
  bodyTurnStartedAt = null,
  activeTurnKey = null,
  bodyTurnKey = null,
} = {}) {
  const activeKey = typeof activeTurnKey === 'string' && activeTurnKey.trim() ? activeTurnKey.trim() : null
  const bodyKey = typeof bodyTurnKey === 'string' && bodyTurnKey.trim() ? bodyTurnKey.trim() : null
  if (activeKey && bodyKey) return activeKey === bodyKey

  const completed = Number(completedAt)
  if (Number.isFinite(completed) && completed > 0) {
    const bodyStart = Number(bodyTurnStartedAt)
    return Number.isFinite(bodyStart) && bodyStart > completed
  }
  return true
}

/**
 * 合并 completion 之后已经 durable 落盘的 DevSpace activity。
 * earliestAuditAt 永远只向前取最早值，latestAuditAt 只向后推进；新的 completion 边界会开启
 * 一份全新的 candidate。这样 late binding 可以安全把 Watchdog startedAt 回填到真实首个工具。
 */
export function mergePostCompletionDevSpaceCandidate(existing, input = {}) {
  const completedAt = Number(input.completedAt)
  const auditAt = Number(input.auditAt)
  const latestAuditAt = Number(input.latestAuditAt ?? input.auditAt)
  if (!Number.isFinite(completedAt) || completedAt <= 0) return existing ?? null
  if (!Number.isFinite(auditAt) || !Number.isFinite(latestAuditAt)) return existing ?? null
  if (auditAt <= completedAt || latestAuditAt <= completedAt) return existing ?? null

  const sameGeneration = existing && Number(existing.completedAt) === completedAt
  return {
    conversationId: input.conversationId ?? existing?.conversationId ?? null,
    metadataId: input.metadataId ?? existing?.metadataId ?? null,
    completedAt,
    earliestAuditAt: sameGeneration
      ? Math.min(Number(existing.earliestAuditAt), auditAt)
      : auditAt,
    latestAuditAt: sameGeneration
      ? Math.max(Number(existing.latestAuditAt), latestAuditAt)
      : latestAuditAt,
    lastCheckedAt: sameGeneration ? existing.lastCheckedAt ?? null : null,
    lastCheckedAuditAt: sameGeneration ? existing.lastCheckedAuditAt ?? null : null,
  }
}

/** exact Body/tool binding 是否已经落在旧 unbound Watchdog 的 45m completion 之后。 */
export function unboundBindingResolvesNewerGeneration(watchdogAt, ...candidateStarts) {
  const completed = Number(watchdogAt)
  if (!Number.isFinite(completed) || completed <= 0) return false
  const newestStart = Math.max(
    0,
    ...candidateStarts.map(value => Number(value)).filter(Number.isFinite),
  )
  return newestStart > completed
}

/**
 * Body ready queue 优先级。Lifecycle / Watchdog 必须先于后台 binding probe，避免低价值
 * probe 的 429/排队把 complete/timeout 的时间快照拖进下一 turn。
 */
export function syncTriggerPriority(trigger) {
  const normalized = String(trigger || '').toLowerCase()
  if (normalized.startsWith('watchdog:')) return 100
  if (normalized.startsWith('wss:') && normalized.includes('complete')) return 95
  if (normalized.includes('async-complete') || normalized.includes('body-terminal')) return 90
  if (normalized === 'devspace:post-completion-turn-check') return 85
  if (normalized.startsWith('checkpoint:') || normalized.startsWith('reconcile:checkpoint:')) return 75
  if (normalized.startsWith('catalog:') || normalized.startsWith('project-catalog:')) return 55
  if (normalized === 'devspace:binding-probe') return 10
  return 50
}

export function preferredSyncTrigger(existingTrigger, nextTrigger) {
  if (!existingTrigger) return nextTrigger
  if (!nextTrigger) return existingTrigger
  return syncTriggerPriority(nextTrigger) > syncTriggerPriority(existingTrigger)
    ? nextTrigger
    : existingTrigger
}

/**
 * 把一次强制诊断映射到持久化 incident kind。
 *
 * Watchdog 的 trigger 只描述“为什么现在来查 body”，不能描述“错误是什么”。
 * Active Zombie 必须来自独立的 catalog active 证据；无论计时器最初由 DevSpace 还是
 * catalog 启动，只要超时诊断这一刻 conversation list 仍明确 active，就走同一分类。
 */
export function incidentKindForTrigger(trigger, { catalogStillActive = false } = {}) {
  const normalized = String(trigger || '').trim().toLowerCase()
  if (normalized.startsWith('watchdog:')) {
    return catalogStillActive ? 'active-zombie' : 'watchdog-timeout'
  }
  return 'abnormal-terminal'
}

export function shouldPromoteWatchdogTimeoutToActiveZombie(active, incident, catalogStillActive = false) {
  if (!catalogStillActive || !active || !incident) return false
  if (!Number(active.lastWatchdogAt || 0)) return false
  if (!active.lastDiagnosticTurnKey || active.lastDiagnosticTurnKey !== incident.turnKey) return false
  if (incident.status !== 'open') return false
  if (incident.lifecycleClass !== 'watchdog-timeout') return false
  return String(incident.bodyCompletionEvidence || 'none') === 'none'
}

/**
 * daemon 重启不能把真实 HTTP 429 circuit breaker 清零，否则“重启服务”会变成绕过限流的手段。
 * 只继承仍位于未来的绝对时间戳；过期、缺失或损坏状态一律视为无 cooldown。
 */
export function restoreCooldownUntil(previousState, now = Date.now()) {
  const value = Number(previousState?.cooldownUntil ?? 0)
  return Number.isFinite(value) && value > now ? value : 0
}

/** cooldown 只禁止主动私有 API；Guardian/CDP/WSS 被动监听必须继续存活。 */
export function activeApiAllowed(cooldownUntil, now = Date.now()) {
  const value = Number(cooldownUntil ?? 0)
  return !Number.isFinite(value) || value <= 0 || now >= value
}
/**
 * 把服务端 Retry-After 转成绝对 cooldown 截止时间。
 *
 * ChatGPT 明确给出 Retry-After 时，以服务端为主要真相源，不再无条件放大成 60 分钟；
 * 同时保留短安全下限与 buffer，避免刚到边界就立刻重新撞限流。只有没有或无法解析
 * Retry-After 时，才回退到保守的本地 cooldown。Retry-After 支持 delta-seconds 和 HTTP-date。
 */
export function cooldownDeadlineFromRetryAfter(
  retryAfter,
  {
    now = Date.now(),
    fallbackMs = 60 * 60_000,
    minimumMs = 30_000,
    safetyMs = 5_000,
  } = {},
) {
  const current = Number(now)
  const fallback = Math.max(1_000, Number(fallbackMs) || 60 * 60_000)
  const minimum = Math.max(1_000, Number(minimumMs) || 30_000)
  const safety = Math.max(0, Number(safetyMs) || 0)
  const raw = String(retryAfter ?? '').trim()
  if (!raw) return current + fallback

  let serverDeadline = null
  if (/^\d+(?:\.\d+)?$/u.test(raw)) {
    const seconds = Number(raw)
    if (Number.isFinite(seconds) && seconds >= 0) {
      serverDeadline = current + Math.ceil(seconds * 1000)
    }
  }
  else {
    const parsed = Date.parse(raw)
    if (Number.isFinite(parsed)) serverDeadline = parsed
  }

  if (!Number.isFinite(serverDeadline)) return current + fallback
  return Math.max(current + minimum, Number(serverDeadline) + safety)
}

/**
 * 被动 CDP observer 也会看见 daemon 自己通过 Guardian page 发出的 active replay。
 * 同一个 429 不能在 observer 与 fetchChecked 两边各 trip 一次；active replay 由
 * fetchChecked 负责熔断，observer 只处理真正来自页面自身的 native 请求。
 */
export function shouldTripObserved429(requestUrl, activeReplayRequestUrl, base = 'https://chatgpt.com') {
  if (!activeReplayRequestUrl) return true
  try {
    const observed = new URL(String(requestUrl || ''), base)
    const active = new URL(String(activeReplayRequestUrl || ''), base)
    return (observed.pathname + observed.search) !== (active.pathname + active.search)
  }
  catch {
    return true
  }
}

/**
 * 人类可见时间统一使用北京时间（Asia/Shanghai, UTC+8）。
 *
 * 数据库和内部状态仍保存 epoch/UTC 绝对时间：这样排序、比较、跨时区计算都不会受
 * 展示时区影响；只有 Bark / CLI 等给人看的字符串在最后一步转换为北京时间。
 */
export function formatBeijingTime(value) {
  const ms = Number(value)
  if (!Number.isFinite(ms) || ms <= 0) return '未知时间'
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms))
  const pick = type => parts.find(part => part.type === type)?.value ?? ''
  return `${pick('year')}-${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')}:${pick('second')} 北京时间`
}

export function formatDurationMs(value) {
  const ms = Math.max(0, Number(value || 0))
  if (!Number.isFinite(ms) || ms <= 0) return '0 秒'
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const parts = []
  if (hours > 0) parts.push(`${hours} 小时`)
  if (minutes > 0) parts.push(`${minutes} 分钟`)
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds} 秒`)
  return parts.join(' ')
}

/**
 * 手机通知中的时刻只显示 HH:mm。
 *
 * 秒级时间仍保存在 SQLite/日志，锁屏没有必要重复展示年月日、秒和“北京时间”后缀。
 * 这里仍固定 Asia/Shanghai，避免运行机器当前时区影响用户看到的时间。
 *
 * @param {unknown} value epoch milliseconds
 */
export function formatBeijingClock(value) {
  const ms = Number(value)
  if (!Number.isFinite(ms) || ms <= 0) return '??:??'
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms))
  const pick = type => parts.find(part => part.type === type)?.value ?? ''
  return `${pick('hour')}:${pick('minute')}`
}

/**
 * 把长诊断/Checkpoint 压成适合锁屏的一行文本。
 *
 * 完整原文从不在这里改写：DevSpace SQLite、Archive ledger、日志仍保留原始内容；
 * 这里只压缩 Bark 的“显示副本”。按 code point 截断可避免把 emoji/代理对从中间切坏。
 */
export function compactNotificationText(value, maxChars = 160) {
  const normalized = String(value || '').replace(/\s+/gu, ' ').trim()
  if (!normalized) return ''
  const chars = Array.from(normalized)
  const limit = Math.max(1, Math.trunc(Number(maxChars) || 1))
  return chars.length <= limit
    ? normalized
    : `${chars.slice(0, Math.max(1, limit - 1)).join('')}…`
}

/**
 * Bark 的 group 在手机上承担“通知线程”而不是业务 taxonomy。
 *
 * 旧版按 Chat-Latency / Chat-Timeout / Chat-Done 全局分组，真实手机会把几十个不同会话
 * 折成一个 13/36 条的大栈。现在 conversation-scoped 通知统一按会话分组；
 * 业务类别仍由 ledger.kind / title 完整保留。未绑定 metadata 使用可口述短别名。
 */
export function conversationNotificationGroup({
  conversationId = null,
  metadataId = null,
} = {}) {
  const cid = String(conversationId || '').trim()
  if (cid) return `Chat/${cid}`
  const metadata = String(metadataId || '').trim()
  if (metadata) return `Chat/${shortDevSpaceMetadataAlias(metadata)}`
  return BARK_NOTIFICATION_GROUPS.incident
}

/**
 * iOS subtitle 专门承载“是哪一个聊天”。
 * title 只保留事件/结论，body 只保留一个补充事实，三层信息各司其职。
 */
function notificationConversationSubtitle({
  title = null,
  conversationId = null,
  metadataId = null,
  unbound = false,
}) {
  const readable = String(title || '').replace(/\s+/gu, ' ').trim()
  const fallback = String(conversationId || '').trim()
    || (metadataId ? shortDevSpaceMetadataAlias(metadataId) : '未命名会话')
  return `${readable || fallback}${unbound ? ' · 未绑定' : ''}`
}

/**
 * Watchdog 起点通知会在 turn 刚建立时立刻发送，此时 ChatGPT 经常还没有完成自动命名，
 * `conversations.title` 仍只是 `New chat` / `新聊天`。DevSpace metadata 反而通常已经知道本轮
 * 工作主题，所以允许它只在 canonical 标题还是占位符时做一次“早期标题兜底”。
 *
 * 一旦 ChatGPT 已经有真实标题，canonical title 永远优先；这样不会让 DevSpace 内部工作名
 * 覆盖用户最终在侧边栏看到的聊天名。
 */
export function preferredWatchdogStartTitle({
  conversationId,
  canonicalTitle,
  devSpaceTitles = [],
}) {
  const cid = String(conversationId || '').trim()
  const normalize = value => String(value || '').replace(/\s+/gu, ' ').trim()
  const isPlaceholder = value => {
    const title = normalize(value)
    if (!title) return true
    if (cid && title === cid) return true
    return /^(?:new chat|new conversation|新聊天|新对话)$/iu.test(title)
  }

  const canonical = normalize(canonicalTitle)
  if (!isPlaceholder(canonical)) return canonical

  for (const value of Array.isArray(devSpaceTitles) ? devSpaceTitles : []) {
    const candidate = normalize(value)
    if (!isPlaceholder(candidate)) return candidate
  }
  return !isPlaceholder(canonical) ? canonical : (cid || null)
}

/** 5 分钟 DevSpace 静默 probe 的最终诊断通知：扫完必须给结果。 */
export function buildDevSpaceIdleDiagnosisNotificationPayload({
  conversationId,
  title,
  diagnostic,
  tailGap,
  canonicalMessageCount = null,
}) {
  const completion = String(diagnostic?.bodyCompletionEvidence || 'none')
  const hasTailGap = Boolean(tailGap?.hasTailGap)
  const recoveryCount = Number(tailGap?.recoveryAuditCount || 0)
  const body = hasTailGap
    ? `Body 落后 ${formatDurationMs(tailGap?.gapMs)} · recovery ${recoveryCount}`
    : completion === 'final'
      ? 'Final 已确认 · 无 Body 缺口'
      : '未确认 Final · 无 Body 缺口'
  return {
    title: hasTailGap
      ? '5m 核验 · Body 缺口'
      : completion === 'final'
        ? '5m 核验 · Final'
        : '5m 核验 · 未结束',
    subtitle: notificationConversationSubtitle({ title, conversationId }),
    body,
    group: conversationNotificationGroup({ conversationId }),
    url: conversationId ? `https://chatgpt.com/c/${encodeURIComponent(conversationId)}` : undefined,
  }
}

export function buildDevSpaceIdleUnboundDiagnosisNotificationPayload({
  metadataId,
  title = null,
  recoveryAuditCount = 0,
  recoveryToolCount = 0,
  checkpointCount = 0,
}) {
  return {
    title: '5m 核验 · 未绑定',
    subtitle: notificationConversationSubtitle({ title, metadataId, unbound: true }),
    body: `catalog repair 后仍未匹配 · recovery ${Number(recoveryAuditCount || 0)}`,
    group: conversationNotificationGroup({ metadataId }),
  }
}

/**
 * 429 cooldown 是 Archive 自己的运行状态通知，不属于 conversation incident taxonomy。
 *
 * 这里只负责生成稳定文案，便于单测；真正发送仍走现有 Bark provider。
 */
export function buildCooldownNotificationPayload({
  reason,
  cooldownUntil,
  route = null,
  retryAfter = null,
}) {
  const lines = [
    `原因：${String(reason || 'HTTP 429')}`,
    route ? `请求：${route}` : null,
    retryAfter ? `Retry-After：${retryAfter}` : null,
    `主动 API 冷却至：${formatBeijingTime(cooldownUntil)}`,
    'WSS/CDP 被动监听继续运行；滑动延长只记日志，不重复通知。',
  ].filter(Boolean)
  return {
    title: 'ChatGPT API 429 冷却',
    body: lines.join('\n'),
    group: BARK_NOTIFICATION_GROUPS.archiveWarning,
  }
}

/** Watchdog 到点但 429 cooldown 暂时阻止 body 诊断时的“先报到点、后报结论”通知。 */
export function buildWatchdogDeferredNotificationPayload({
  conversationId,
  title,
  startedAt,
  now = Date.now(),
  cooldownUntil,
}) {
  const activeForMs = Math.max(0, Number(now) - Number(startedAt || now))
  return {
    title: 'Watchdog · 超时待诊断',
    subtitle: notificationConversationSubtitle({ title, conversationId }),
    body: `${Math.floor(activeForMs / 60_000)}m · 429 冷却至 ${formatBeijingClock(cooldownUntil || now)}`,
    group: conversationNotificationGroup({ conversationId }),
    url: conversationId ? `https://chatgpt.com/c/${encodeURIComponent(conversationId)}` : undefined,
  }
}

/**
 * Watchdog 到点本身就是必须可见的事实，不依赖 body 是否能立即拉取，也不依赖 cooldown。
 * 这是两阶段通知的第一条：先告诉用户“这个 turn 已经跨过 45min 硬边界”。
 */
export function buildWatchdogTimeoutNotificationPayload({
  conversationId,
  title,
  startedAt,
  now = Date.now(),
}) {
  const activeForMs = Math.max(0, Number(now) - Number(startedAt || now))
  return {
    title: 'Watchdog · 超时',
    subtitle: notificationConversationSubtitle({ title, conversationId }),
    body: `${Math.floor(activeForMs / 60_000)}m · 起点 ${formatBeijingClock(startedAt || now)}`,
    group: conversationNotificationGroup({ conversationId }),
    url: conversationId ? `https://chatgpt.com/c/${encodeURIComponent(conversationId)}` : undefined,
  }
}

/**
 * Watchdog generation 真正建立时的“起点收据”。
 *
 * 这条通知不是异常告警，也不表示 turn 已经慢了；它只把 Archive 此后会使用的计时基准
 * 明确告诉用户。这样用户看到手机上的起点后，就能直接推算 45 分钟硬边界，而不必等到
 * `Watchdog 超时` 才反推本轮究竟从什么时候开始。
 *
 * 这里只接受已经知道 canonical Conversation ID 的 generation。DevSpace metadata 尚未绑定 CID
 * 时仍在内部保留 provisional first-tool 时间；完成 exact binding 后再用这个原始时间发开始通知。
 */
export function buildWatchdogStartNotificationPayload({
  conversationId = null,
  metadataId = null,
  title,
  startedAt,
  watchdogMs = 45 * 60_000,
}) {
  const safeStartedAt = Number.isFinite(Number(startedAt)) && Number(startedAt) > 0
    ? Number(startedAt)
    : Date.now()
  const safeWatchdogMs = Number.isFinite(Number(watchdogMs)) && Number(watchdogMs) > 0
    ? Number(watchdogMs)
    : 45 * 60_000
  const watchdogMinutes = Math.round(safeWatchdogMs / 60_000)
  return {
    title: 'Watchdog · 开始',
    subtitle: notificationConversationSubtitle({
      title,
      conversationId,
      metadataId,
      unbound: !conversationId,
    }),
    body: `${formatBeijingClock(safeStartedAt)} → ${formatBeijingClock(safeStartedAt + safeWatchdogMs)} · ${watchdogMinutes}m`,
    group: conversationNotificationGroup({ conversationId, metadataId }),
    ...(conversationId
      ? { url: `https://chatgpt.com/c/${encodeURIComponent(conversationId)}` }
      : {}),
  }
}

/**
 * Watchdog 开始通知的稳定持久去重 key。
 * 同一 conversation 可以连续产生很多 turn，所以必须把 generation 的 startedAt 一并纳入身份。
 */
export function watchdogStartNotificationKey(conversationId, startedAt) {
  const cid = String(conversationId || '').trim()
  const start = Math.max(0, Math.trunc(Number(startedAt) || 0))
  return cid && start > 0 ? `watchdog-start:${cid}:${start}` : null
}

/** metadata 尚未绑定 canonical CID 时的稳定起点收据 key。 */
export function unboundWatchdogStartNotificationKey(metadataId, startedAt) {
  const metadata = String(metadataId || '').trim()
  const start = Math.max(0, Math.trunc(Number(startedAt) || 0))
  return metadata && start > 0 ? `watchdog-start-unbound:${metadata}:${start}` : null
}

/**
 * Watchdog 两阶段通知的第二条：只要 canonical body 成功完成诊断，就必须给用户一个结果。
 * 这里不能依赖“是否新建 incident”，否则已有 incident / 同一 incident 更新会造成静默漏报。
 */
export function buildWatchdogDiagnosisNotificationPayload({ conversationId, title, diagnostic, incident = null }) {
  const completion = String(diagnostic?.bodyCompletionEvidence || 'none')
  const evidenceTypes = Array.isArray(incident?.evidenceTypes)
    ? [...new Set(incident.evidenceTypes.map(value => String(value || '').trim()).filter(Boolean))]
    : []
  const hasCanonicalTailGap = evidenceTypes.includes('canonical-tail-gap')
  return {
    title: hasCanonicalTailGap
      ? 'Watchdog · Body 缺口'
      : completion === 'final'
        ? 'Watchdog · Final 已确认'
        : 'Watchdog · 未确认 Final',
    subtitle: notificationConversationSubtitle({ title, conversationId }),
    body: hasCanonicalTailGap
      ? 'DevSpace 审计晚于 canonical'
      : '未发现 Body 缺口',
    group: conversationNotificationGroup({ conversationId }),
    url: `https://chatgpt.com/c/${encodeURIComponent(conversationId)}`,
  }
}

/** DevSpace metadata 45 分钟后仍无法绑定 CID 时也必须显式告诉用户，禁止静默。 */
/**
 * 给手机通知生成一个可口述、可检索的 metadata 短别名。
 *
 * 完整 metadata ID 很长，展示价值低；但完全隐藏又会让用户无法说“帮我查刚才那条通知”。
 * 因此保留去掉 `v1/` 后的前 8 个字符，例如 `meta/31BvfaYk`。Archive/DevSpace 日志仍保存
 * 完整 ID，收到这个短别名后可以用前缀唯一回查。
 */
export function shortDevSpaceMetadataAlias(metadataId) {
  const normalized = String(metadataId || '').trim().replace(/^v1\//u, '')
  return normalized ? `meta/${normalized.slice(0, 8)}` : 'meta/unknown'
}

export function buildUnboundWatchdogNotificationPayload({ metadataId, title = null, startedAt, now = Date.now() }) {
  const activeForMs = Math.max(0, Number(now) - Number(startedAt || now))
  return {
    title: 'Watchdog · 超时未绑定',
    subtitle: notificationConversationSubtitle({ title, metadataId, unbound: true }),
    body: `${Math.floor(activeForMs / 60_000)}m · 起点 ${formatBeijingClock(startedAt || now)}`,
    group: conversationNotificationGroup({ metadataId }),
  }
}

export function unboundWatchdogDiagnosisNotificationKey(metadataId, startedAt) {
  return `watchdog-diagnosis-unbound:${String(metadataId || 'unknown')}:${Math.max(0, Math.trunc(Number(startedAt || 0)))}`
}

export function buildUnboundWatchdogDiagnosisNotificationPayload({
  metadataId,
  title = null,
  recoveryAuditCount = 0,
}) {
  return {
    title: 'Watchdog · 诊断',
    subtitle: notificationConversationSubtitle({ title, metadataId, unbound: true }),
    body: `未绑定 · canonical Body 未取得 · recovery ${Number(recoveryAuditCount || 0)}`,
    group: conversationNotificationGroup({ metadataId }),
  }
}

export function buildSupersededUnboundWatchdogDiagnosisNotificationPayload({
  conversationId,
  metadataId,
  title = null,
  newGenerationStartedAt,
}) {
  return {
    title: 'Watchdog · 诊断',
    subtitle: notificationConversationSubtitle({ title, conversationId, metadataId }),
    body: `CID 已解析 · 超时后已进入新 turn · 新起点 ${formatBeijingClock(newGenerationStartedAt || Date.now())}`,
    group: conversationNotificationGroup({ conversationId, metadataId }),
    ...(conversationId
      ? { url: `https://chatgpt.com/c/${encodeURIComponent(conversationId)}` }
      : {}),
  }
}

/** 正常 final 也作为 turn 的最终可见结果发送，和异常 incident 对称。 */
export function buildTurnFinalNotificationPayload({ conversationId, title, diagnostic }) {
  const finalLine = diagnostic?.hasImageGenerationFinal
    ? `Final 已确认 · ${Number(diagnostic?.imageGenerationCount || 0)} 张图片`
    : 'Final 已确认'
  return {
    title: 'Turn · 完成',
    subtitle: notificationConversationSubtitle({ title, conversationId }),
    body: finalLine,
    group: conversationNotificationGroup({ conversationId }),
    url: `https://chatgpt.com/c/${encodeURIComponent(conversationId)}`,
  }
}

/**
 * 正常 final 通知只针对在线终态/Watchdog 诊断，不在 startup/periodic 历史补档时轰炸手机。
 * settle trigger 由 isConfirmedCompletionTrigger 自己去掉 `:settle` 后识别。
 */
export function shouldNotifyTurnFinal(trigger, diagnostic) {
  if (diagnostic?.bodyCompletionEvidence !== 'final') return false
  const normalized = String(trigger || '').trim().toLowerCase()
  if (normalized.startsWith('watchdog:')) return true
  if (normalized.startsWith('checkpoint:')) return true
  if (normalized.startsWith('reconcile:gap-repair')) return true
  if (normalized.startsWith('reconcile:wss-reconnect')) return true
  if (normalized.startsWith('reconcile:guardian-recover')) return true
  if (normalized.startsWith('reconcile:cooldown-recover')) return true
  return isConfirmedCompletionTrigger(normalized)
}

/**
 * Guardian 的一次 Runtime 探活超时不等价于 renderer 已经死亡。
 *
 * Chrome 在后台/隐藏窗口、CPU 突发繁忙、多个 CDP client 同时工作时都可能出现短暂抖动。
 * 只有连续失败达到阈值才允许进入“拆页重建”路径；任意一次成功都会由调用方把计数清零。
 */
export function shouldRebuildGuardianAfterHealthFailures(consecutiveFailures, threshold = 3) {
  const failures = Math.max(0, Math.trunc(Number(consecutiveFailures) || 0))
  const safeThreshold = Math.max(1, Math.trunc(Number(threshold) || 1))
  return failures >= safeThreshold
}

export function guardianUiFailureKind(snapshot) {
  if (!snapshot || String(snapshot.ready || '') !== 'complete') return null
  const href = typeof snapshot.href === 'string' ? snapshot.href.trim() : ''
  if (href) {
    try {
      const url = new URL(href)
      if (url.origin !== 'https://chatgpt.com') return 'wrong-document'
    }
    catch {
      return 'wrong-document'
    }
  }
  if (snapshot.composerPresent === true) return null
  if (snapshot.accountLoadFailure === true) return 'account-load-failure'
  return null
}

/**
 * 判断 deferred gap repair 是否已经可以发起一次低频 catalog overlap。
 *
 * 这层门控把“恢复 WSS”和“主动扫 REST”彻底拆开：
 * - 必须已经有 WSS，说明被动监听先恢复成功；
 * - 最近一次 recover/reconnect 后先等待 debounce 窗口；
 * - 与上一次 gap-repair 尝试之间还要满足全局最小间隔；
 * - 429 cooldown、缺认证、已有 reconciliation 时一律不主动请求。
 */
export function shouldRunDeferredGapRepair({
  now,
  pendingLastAt,
  lastAttemptAt = 0,
  delayMs,
  minIntervalMs,
  activeSockets,
  authAvailable,
  cooldownUntil,
  reconcileInFlight,
  passiveCatalogAvailable = false,
}) {
  if (!Number.isFinite(Number(pendingLastAt))) return false
  if (Number(activeSockets) <= 0 || reconcileInFlight) return false
  const activeWindowAvailable = Boolean(authAvailable) && activeApiAllowed(cooldownUntil, now)
  // cooldown/缺 auth 只禁止主动 REST；如果页面已经自然给了本次 gap 之后的 catalog 第 0 页，
  // 仍允许进入一次纯被动 repair。若后续缺页，fetchChecked 会在真正发网前拒绝并保留 pending。
  if (!activeWindowAvailable && !passiveCatalogAvailable) return false
  const priorAttemptAt = Number(lastAttemptAt)
  const intervalDueAt = Number.isFinite(priorAttemptAt) && priorAttemptAt > 0
    ? priorAttemptAt + Math.max(0, Number(minIntervalMs) || 0)
    : 0
  const dueAt = Math.max(
    Number(pendingLastAt) + Math.max(0, Number(delayMs) || 0),
    intervalDueAt,
  )
  return Number(now) >= dueAt
}

/**
 * 为不同 reconciliation 场景选择“已经足够重合”的连续稳定条目数。
 *
 * - 原生 WSS reconnect 的盲区通常只有几秒；此时从最新端向旧端扫描，只要在最后一个差异
 *   之后连续看到**一整页**稳定旧记录，就已经跨过本次 gap 的变化边界。第一页完全稳定时
 *   因此只请求一页；第一页有变化才自然翻第二页。
 * - startup / Guardian 重建的首要目标是尽快找回“最近仍 active / 刚变化”的 conversation。
 *   这类记录天然位于 updated-desc 列表前部；深扫会在每次部署/重启额外制造连续 catalog burst，
 *   2026-10-06 已真实观察到 startup 4 页后紧接 body 命中 429。因此它们也只要求一整页稳定 overlap。
 * - periodic 是唯一保留的深层兜底，用 deepThreshold（默认 56）追更久以前的遗漏。
 *
 * 这里不是“看到一个熟 ID 就停”：一个偶然旧 ID 不足以证明 offset pagination 已重新进入
 * 稳定区域，完整一页才是短 gap 的安全缓冲。
 */
export function catalogStableOverlapTarget(reason, { pageSize = 28, deepThreshold = 56 } = {}) {
  const safePageSize = Math.max(1, Math.trunc(pageSize))
  const safeDeepThreshold = Math.max(safePageSize, Math.trunc(deepThreshold))
  return ['wss-reconnect', 'gap-repair', 'startup', 'guardian-recover'].includes(reason)
    ? safePageSize
    : safeDeepThreshold
}

/**
 * 判断“当前没有 ChatGPT WSS”是否已经持续到需要重建 Guardian。
 *
 * 关键点是 grace 必须从“这一次没有 socket 的 gap”开始算，而不是从 Guardian 启动时开始算。
 * 否则 Guardian 运行 20 秒以后，任何一次正常的 socket close 都会在下一轮主循环被立刻升级成
 * 整页 reload，反而打断 ChatGPT 前端自己的 WebSocket 重连逻辑。
 */
export function shouldRebuildGuardianForMissingWss({
  now,
  activeSockets,
  gapStartedAt,
  reconnectGraceMs,
}) {
  if (Number(activeSockets) > 0) return false
  if (!Number.isFinite(gapStartedAt)) return false
  return Number(now) - Number(gapStartedAt) >= Number(reconnectGraceMs)
}

function chatgptTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const millis = Date.parse(value)
    return Number.isFinite(millis) ? millis / 1000 : null
  }
  return null
}

/**
 * Archive 主动只读 replay 会从第一方页面捕获并复用的账户/客户端上下文 header。
 * 这个集合故意导出：Protocol Drift 运行时会把“第一方稳定出现、但这里尚未覆盖”的新 header
 * 直接判成 production compatibility warning。这样即使新 header 在 24h baseline 建立前就已经存在，
 * 也不会再发生“baseline 认为正常、生产代码其实已经落后”的漏报。
 *
 * turn-scoped `x-oai-turn-trace-id` 不在这里：它必须由每个 turn session 单独管理，绝不能
 * 从 A turn 的 native request 捕获后全局复用到 B conversation。
 */
export const CAPTURED_HEADER_ALLOWLIST = [...FIRST_PARTY_REPLAY_HEADER_ALLOWLIST]

export function sanitizeCapturedHeaders(headers) {
  return sanitizeFirstPartyReplayHeaders(headers)
}

/** 只从真正的 ChatGPT conversation tab URL 提取 conversation id；不会导航页面。 */
export function conversationIdFromTargetUrl(value) {
  try {
    const url = new URL(String(value || ''))
    if (url.hostname !== 'chatgpt.com' && !url.hostname.endsWith('.chatgpt.com')) return null
    const match = url.pathname.match(/^\/c\/([^/?#]+)$/u)
    return match?.[1] || null
  }
  catch {
    return null
  }
}

/**
 * 从页面自然产生的 estuary 内容 URL 中只取稳定 file id。
 * `sig/ts` 等短期签名属于瞬时下载能力，不应该成为长期归档身份。
 */
export function estuaryFileIdFromUrl(value) {
  try {
    const url = new URL(String(value || ''))
    if (url.hostname !== 'chatgpt.com' && !url.hostname.endsWith('.chatgpt.com')) return null
    if (!url.pathname.includes('/backend-api/estuary/content')) return null
    const id = url.searchParams.get('id')
    return id && /^file_[A-Za-z0-9_-]+$/u.test(id) ? id : null
  }
  catch {
    return null
  }
}

/**
 * 校验 `/files/download/{file_id}` resolver 的返回值，并只放行同一 stable file id 的
 * ChatGPT estuary URL。短期 sig/ts 只作为本次下载能力返回给调用者，不做持久化。
 *
 * 当前 Web bundle 的标准逻辑允许 `status` 缺失；若存在则必须为 `success`。
 */
export function resolvedEstuaryUrlForFile(payload, fileId) {
  if (!payload || typeof payload !== 'object') return null
  const status = typeof payload.status === 'string' ? payload.status : null
  if (status !== null && status !== 'success') return null
  if (typeof payload.download_url !== 'string' || !payload.download_url) return null
  if (typeof fileId !== 'string' || !/^file_[A-Za-z0-9_-]+$/u.test(fileId)) return null
  try {
    const url = new URL(payload.download_url, 'https://chatgpt.com')
    if (url.protocol !== 'https:') return null
    if (url.hostname !== 'chatgpt.com' && !url.hostname.endsWith('.chatgpt.com')) return null
    if (estuaryFileIdFromUrl(url.toString()) !== fileId) return null
    return url.toString()
  }
  catch {
    return null
  }
}

/**
 * 把 CDP `Network.getResponseBody` 的返回值还原成原始字节。
 *
 * JSON/body API 通常是 UTF-8 文本；图片等二进制响应则由 CDP 以 base64 返回。
 * 这里单独做一个纯函数，避免各监听器自己猜编码，也便于 fixture 回归。
 */
export function decodeCdpResponseBodyBytes(result) {
  const body = String(result?.body || '')
  return result?.base64Encoded
    ? Buffer.from(body, 'base64')
    : Buffer.from(body, 'utf8')
}

/**
 * 判断同一 conversation 的 incident 是否出现了值得再次提醒手机的“实质生命周期变化”。
 *
 * tailShape / reason 会随着更完整 body 或分类器升级频繁刷新，不应每次都轰炸手机；
 * 真正需要二次提醒的是 watchdog timeout 后又拿到 confirmed complete / explicit interrupted
 * 这类 lifecycle 升级。新 turn 的 incident id 不同，当然也必须通知。
 */
export function shouldNotifyIncidentTransition(before, after) {
  if (!after) return false
  if (!before) return true
  if (before.id !== after.id) return true
  return before.incidentKind !== after.incidentKind
    || before.lifecycleClass !== after.lifecycleClass
    || before.bodyCompletionEvidence !== after.bodyCompletionEvidence
}

/**
 * 计算本次主循环刚跨过了哪些 DevSpace idle 阈值。
 *
 * previousIdleMs 很重要：daemon 重启时会把它初始化为“当前已经 idle 的时长”，
 * 因此不会把 1/3 分钟的历史提醒一起补轰炸；只有进程在线期间真正跨过阈值才提醒。
 */
export function crossedDevSpaceIdleThresholds(previousIdleMs, currentIdleMs) {
  const before = Math.max(0, Number(previousIdleMs || 0))
  const after = Math.max(0, Number(currentIdleMs || 0))
  if (after < before) return []
  return DEVSPACE_IDLE_ALERT_THRESHOLDS_MS.filter(threshold => before < threshold && after >= threshold)
}

/**
 * 只有 5 分钟静默这一档才升级成“主动核验”。
 * 1/3 分钟仍然只是提醒，避免正常长思考或 Final 组织阶段额外制造 ChatGPT 请求。
 */
export function devSpaceIdleRepairMode(thresholdMs, conversationId = null) {
  if (Number(thresholdMs) !== 300_000) return 'none'
  return conversationId ? 'bound-body' : 'unbound-catalog'
}

/** 软 Bug 提醒的文案与正式 incident 明确分离；它不声称 turn 已结束。 */
export function buildDevSpaceIdleNotificationPayload({
  conversationId = null,
  title = null,
  metadataId = null,
  thresholdMs,
}) {
  const minutes = Math.round(Number(thresholdMs) / 60_000)
  const payload = {
    title: `工具静默 · ${minutes}m`,
    subtitle: notificationConversationSubtitle({
      title,
      conversationId,
      metadataId,
      unbound: !conversationId,
    }),
    body: conversationId ? '仍在观察' : '等待绑定 canonical',
    group: conversationNotificationGroup({ conversationId, metadataId }),
  }
  if (conversationId) payload.url = `https://chatgpt.com/c/${conversationId}`
  return payload
}

/**
 * 从 DevSpace tool args 中读取阶段性 conclusion。
 *
 * conclusion 是一个可选参数，因此解析失败、非字符串或全空白都必须视为“没有结论”，
 * 不能影响正常 tool audit / Watchdog 流程。这里把正文上限控制在 1800 字符，避免某个模型
 * 意外塞入超长段落时把 Bark payload 撑得过大；完整原文仍保留在 DevSpace SQLite 的 args_json。
 */
export function extractDevSpaceConclusion(argsJson) {
  try {
    const parsed = JSON.parse(String(argsJson || ''))
    if (!parsed || typeof parsed !== 'object' || typeof parsed.conclusion !== 'string') return null
    const normalized = parsed.conclusion.trim()
    if (!normalized) return null
    return normalized.length > 1800 ? `${normalized.slice(0, 1799)}…` : normalized
  }
  catch {
    return null
  }
}

/**
 * 新版独立 checkpoint 工具的结构化阶段结论。
 *
 * 与 legacy conclusion 不同，checkpoint 自己就是一条独立 audit，因此 summary 必须代表
 * 已形成的阶段事实；next 只允许宏观下一阶段。解析失败永远降级为“没有 checkpoint”，
 * 不能影响普通 DevSpace audit / Watchdog 主链。
 */
export function extractDevSpaceCheckpoint(argsJson) {
  try {
    const parsed = JSON.parse(String(argsJson || ''))
    if (!parsed || typeof parsed !== 'object' || typeof parsed.summary !== 'string') return null
    const summary = parsed.summary.trim()
    if (!summary) return null
    const next = typeof parsed.next === 'string' && parsed.next.trim()
      ? parsed.next.trim()
      : null
    // checkpoint 工具本身已经用 schema 限制 summary<=2000、next<=1000。
    // 这里不再做第二层 1800 字符截断，否则合法 checkpoint 会在进入通知层前永久丢尾巴。
    return { summary, next }
  }
  catch {
    return null
  }
}

/**
 * Conclusion 是工具链中的“阶段性结论”，不是 turn final，也不改变任何 Archive 生命周期。
 * 手机展示优先给可读聊天名；只有 conversation/title 都没有时才给 `meta/XXXXXXXX` 短别名，
 * 完整 metadata ID 始终只留在内部日志与 SQLite。
 */
export function buildDevSpaceConclusionNotificationPayload({
  conversationId = null,
  title = null,
  metadataId = null,
  tool,
  conclusion,
}) {
  const payload = {
    title: 'DevSpace · 结论',
    subtitle: notificationConversationSubtitle({
      title,
      conversationId,
      metadataId,
      unbound: !conversationId,
    }),
    body: [
      compactNotificationText(conclusion, 180),
      `工具：${compactNotificationText(tool || 'unknown', 50)}`,
    ].filter(Boolean).join('\n'),
    group: conversationNotificationGroup({ conversationId, metadataId }),
  }
  if (conversationId) payload.url = `https://chatgpt.com/c/${conversationId}`
  return payload
}

const CHECKPOINT_NOTIFICATION_BODY_MAX_UTF8_BYTES = 3000

/**
 * 把 Checkpoint 正文压到一个保守的 APNs body 字节预算内。
 *
 * APNs 普通通知的完整 payload 上限是 4096 bytes；Bark 还需要 title/subtitle/url/group 等字段，
 * 因此这里给正文留 3000 bytes，并把剩余空间留给传输层元数据。和旧版按“字符数”截断不同：
 * - 常见 checkpoint 只要整体不超过预算，就原样完整显示，展开通知可以看到全文；
 * - 只有真的接近 APNs 上限时才截断；
 * - 按 UTF-8 字节计算，避免中文看似字符不多、实际 payload 已经超限；
 * - summary 与 next 都保留一部分预算，超长时不会出现“前文吃满空间导致下一步完全消失”。
 */
function buildCheckpointNotificationBody(summary, next = null, maxBytes = CHECKPOINT_NOTIFICATION_BODY_MAX_UTF8_BYTES) {
  const clean = value => String(value || '').replace(/\r\n?/gu, '\n').trim()
  const summaryText = clean(summary)
  const nextText = clean(next)
  const separator = nextText ? '\n\n下一步：' : ''
  const full = `${summaryText}${separator}${nextText}`
  const byteLength = value => Buffer.byteLength(value, 'utf8')
  const safeBudget = Math.max(64, Math.trunc(Number(maxBytes) || CHECKPOINT_NOTIFICATION_BODY_MAX_UTF8_BYTES))

  if (byteLength(full) <= safeBudget) return full

  const truncateUtf8 = (value, budget) => {
    const ellipsis = '…'
    const ellipsisBytes = byteLength(ellipsis)
    const safe = Math.max(0, Math.trunc(Number(budget) || 0))
    if (byteLength(value) <= safe) return value
    if (safe < ellipsisBytes) return ''
    const chars = []
    let used = ellipsisBytes
    for (const char of value) {
      const size = byteLength(char)
      if (used + size > safe) break
      chars.push(char)
      used += size
    }
    return `${chars.join('')}${ellipsis}`
  }

  if (!nextText) return truncateUtf8(summaryText, safeBudget)

  const separatorBytes = byteLength(separator)
  const contentBudget = Math.max(0, safeBudget - separatorBytes)
  const summaryBytes = byteLength(summaryText)
  const nextBytes = byteLength(nextText)

  // 默认给 next 约 1/3 的空间，至少 384 bytes；如果任一段本身较短，
  // 立即把它没用完的预算让给另一段，尽可能多保留原文。
  let nextBudget = Math.min(nextBytes, Math.max(384, Math.floor(contentBudget / 3)))
  let summaryBudget = Math.max(0, contentBudget - nextBudget)
  if (summaryBytes < summaryBudget) {
    summaryBudget = summaryBytes
    nextBudget = Math.max(0, contentBudget - summaryBudget)
  }
  else if (nextBytes < nextBudget) {
    nextBudget = nextBytes
    summaryBudget = Math.max(0, contentBudget - nextBudget)
  }

  return `${truncateUtf8(summaryText, summaryBudget)}${separator}${truncateUtf8(nextText, nextBudget)}`
}

export function buildDevSpaceCheckpointNotificationPayload({
  conversationId = null,
  title = null,
  metadataId = null,
  summary,
  next = null,
}) {
  const payload = {
    title: 'DevSpace · Checkpoint',
    subtitle: notificationConversationSubtitle({
      title,
      conversationId,
      metadataId,
      unbound: !conversationId,
    }),
    body: buildCheckpointNotificationBody(summary, next),
    group: conversationNotificationGroup({ conversationId, metadataId }),
  }
  if (conversationId) payload.url = `https://chatgpt.com/c/${conversationId}`
  return payload
}

/**
 * historical-turn 的定义本身就是“后面已经出现了更新的 user turn”。
 * 对当前使用方式，这通常意味着用户已经人工发现上一轮异常并继续了；此时再补发 Bark
 * 会让人误以为“刚发的新一轮又异常”。因此 historical incident 永远只落库/统计，不做
 * 实时手机告警。真正需要 Bark 的是当前尚未被后续 user turn 越过的 incident。
 */
export function shouldNotifyHistoricalIncidentForTrigger(trigger) {
  void trigger
  return false
}

export function extractConversationEvents(payloadData) {
  if (typeof payloadData !== 'string' || payloadData.length > 1_000_000) return []
  let parsed
  try { parsed = JSON.parse(payloadData) }
  catch { return [] }
  const events = []
  const seen = new Set()

  /**
   * ChatGPT 当前 WSS 的 conversations 事件并不保证把“事件类型”和“conversation_id”放在同一层。
   * 2026-09-13 真机抓到的 complete frame 形状是：
   *
   * message(topic=conversations)
   *   └─ payload.type = conversation-turn-complete
   *      └─ payload.payload.conversation_id = ...
   *
   * 因此这里不能再用“同一个 object 同时具有 type + conversation_id”这种过强假设。
   * 对一个已经识别出的 conversation event 根对象，只在它自己的小子树里寻找标识字段；这样既能
   * 兼容现在的双层 payload，也不会把同一 frame 里其它无关对象的 id 错配给事件。
   */
  const findStringField = (value, keys, depth = 0) => {
    if (!value || depth > 5) return null
    if (Array.isArray(value)) {
      for (const child of value) {
        const found = findStringField(child, keys, depth + 1)
        if (found) return found
      }
      return null
    }
    if (typeof value !== 'object') return null
    for (const key of keys) {
      if (typeof value[key] === 'string' && value[key]) return value[key]
    }
    for (const child of Object.values(value)) {
      if (!child || typeof child !== 'object') continue
      const found = findStringField(child, keys, depth + 1)
      if (found) return found
    }
    return null
  }

  const visit = (value, inheritedTopic = null, depth = 0) => {
    if (!value || depth > 7) return
    if (Array.isArray(value)) {
      for (const child of value) visit(child, inheritedTopic, depth + 1)
      return
    }
    if (typeof value !== 'object') return
    const topic = value.topic_id ?? value.topic ?? inheritedTopic
    const payload = value.payload && typeof value.payload === 'object' ? value.payload : null
    const candidates = payload ? [payload, value] : [value]
    for (const candidate of candidates) {
      const type = typeof candidate.type === 'string'
        ? candidate.type
        : typeof candidate.event_type === 'string' ? candidate.event_type : null
      // `message` 是 WSS 总线 envelope，不是 conversation 业务事件本身。
      const isConversationEvent = typeof type === 'string' && type.startsWith('conversation-')
      // 2026-09-25：当前 Guardian 会同时订阅 conversations 与 alder-conversations。
      // 旧 parser 只接受前者，因此后者即使收到 conversation-history-update 也会被业务层静默丢掉。
      // 这里仅扩展“观察面”；history-update 的证据等级不变，真机时序验证前仍不能直接启动 watchdog。
      const effectiveTopic = topic ?? inheritedTopic
      const isConversationTopic = effectiveTopic === 'conversations'
        || effectiveTopic === 'alder-conversations'
      if (isConversationTopic && isConversationEvent) {
        const conversationId = findStringField(candidate, ['conversation_id', 'conversationId'])
        const updateType = findStringField(candidate, ['update_type', 'updateType'])
        if (!conversationId) continue
        const key = `${conversationId}:${type}:${updateType || ''}`
        if (!seen.has(key)) {
          seen.add(key)
          events.push({ conversationId, type, updateType, topic: effectiveTopic })
        }
      }
    }
    for (const child of Object.values(value)) {
      if (child && typeof child === 'object') visit(child, topic ?? inheritedTopic, depth + 1)
    }
  }
  visit(parsed)
  return events
}

/**
 * 只提取 `conversation-turn-*` WSS 的控制面摘要。
 *
 * 这里刻意不返回 `encoded_item` 正文，只保留 topic、offset 是否存在、catchup 数量和内层类型，
 * 方便测试/状态页判断第一方前端是否真的发生 handoff。真正的 encoded SSE 由 daemon 内部另一条
 * 仅内存路径喂给 `LiveTurnTransportTracker`，不会进入日志或 state。
 */
export function summarizeTurnTopicWssFrame(payloadData) {
  if (typeof payloadData !== 'string' || payloadData.length > 5_000_000) return []
  let parsed
  try { parsed = JSON.parse(payloadData) }
  catch { return [] }
  const frames = Array.isArray(parsed) ? parsed : [parsed]
  const rows = []
  const isTurnTopic = topic => typeof topic === 'string' && topic.startsWith('conversation-turn-')

  const summarizeStreamEnvelope = (value, topic, source) => {
    if (!value || typeof value !== 'object') return
    const payload = value.payload && typeof value.payload === 'object' ? value.payload : null
    const inner = payload?.payload && typeof payload.payload === 'object' ? payload.payload : null
    if (payload?.type !== 'conversation-turn-stream' || !inner) return
    rows.push({
      source,
      topic,
      innerType: typeof inner.type === 'string' ? inner.type : null,
      hasEncodedItem: typeof inner.encoded_item === 'string',
      encodedBytes: typeof inner.encoded_item === 'string' ? Buffer.byteLength(inner.encoded_item, 'utf8') : 0,
      offsetPresent: value.offset != null,
      streamItemIdPresent: typeof inner.stream_item_id === 'string',
      parentStreamItemIdPresent: typeof inner.parent_stream_item_id === 'string',
    })
  }

  for (const frame of frames) {
    if (!frame || typeof frame !== 'object') continue
    const command = frame.command && typeof frame.command === 'object' ? frame.command : null
    if (command?.type === 'subscribe' && isTurnTopic(command.topic_id)) {
      rows.push({
        source: 'subscribe',
        topic: command.topic_id,
        offset: command.offset == null ? null : String(command.offset),
      })
    }

    const reply = frame.reply && typeof frame.reply === 'object' ? frame.reply : null
    if (reply?.type === 'subscribe' && isTurnTopic(reply.topic_id)) {
      const catchups = Array.isArray(reply.catchups) ? reply.catchups : []
      rows.push({
        source: 'reply',
        topic: reply.topic_id,
        recovered: typeof reply.recovered === 'boolean' ? reply.recovered : null,
        catchupCount: catchups.length,
        lastOffsetPresent: reply.last_offset != null,
      })
      for (const catchup of catchups) summarizeStreamEnvelope(catchup, reply.topic_id, 'catchup')
    }

    if (frame.type === 'message' && isTurnTopic(frame.topic_id)) {
      summarizeStreamEnvelope(frame, frame.topic_id, 'message')
    }
  }
  return rows
}

/** 仅 daemon 内部使用：从 turn-topic reply/message 中取出 encoded SSE，不写日志。 */
function extractTurnTopicEncodedItems(payloadData) {
  if (typeof payloadData !== 'string' || payloadData.length > 5_000_000) return []
  let parsed
  try { parsed = JSON.parse(payloadData) }
  catch { return [] }
  const frames = Array.isArray(parsed) ? parsed : [parsed]
  const items = []
  const isTurnTopic = topic => typeof topic === 'string' && topic.startsWith('conversation-turn-')

  const consume = (value, inheritedTopic = null, depth = 0) => {
    if (!value || depth > 8) return
    if (Array.isArray(value)) {
      for (const child of value) consume(child, inheritedTopic, depth + 1)
      return
    }
    if (typeof value !== 'object') return
    const topic = isTurnTopic(value.topic_id) ? value.topic_id : inheritedTopic
    if (topic && typeof value.encoded_item === 'string' && value.encoded_item) {
      items.push({ topic, encodedItem: value.encoded_item })
    }
    for (const child of Object.values(value)) {
      if (child && typeof child === 'object') consume(child, topic, depth + 1)
    }
  }
  for (const frame of frames) consume(frame)
  return items
}

async function waitForTarget(cdpHttp, targetId, timeoutMs = 5000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const targets = await fetch(`${cdpHttp}/json/list`).then(response => response.json())
    const target = targets.find(item => item.id === targetId)
    if (target?.webSocketDebuggerUrl) return target
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`Target ${targetId} did not appear`)
}

function isGuardianTarget(target) {
  if (target?.type !== 'page') return false
  try {
    const url = new URL(target.url || '')
    return url.origin === 'https://chatgpt.com' && url.searchParams.get(GUARDIAN_MARKER) === '1'
  }
  catch { return false }
}

async function connectBrowser(cdpHttp) {
  const version = await fetch(`${cdpHttp}/json/version`).then(response => response.json())
  const browser = new CdpClient(version.webSocketDebuggerUrl)
  await browser.connect()
  return { browser, version }
}

async function ensureGuardian(cdpHttp) {
  const targets = await fetch(`${cdpHttp}/json/list`).then(response => response.json())
  let target = targets.find(isGuardianTarget)
  const { browser, version } = await connectBrowser(cdpHttp)
  let created = false
  let page = null
  let runtimeAlreadyEnabled = false

  // Auto Tab Discard 等扩展可能留下“URL 仍像 Guardian、renderer 已经不响应”的半死 target。
  // 先做一次极短的 Runtime 探活；失败就从 browser-level 关闭 target，再创建全新 Guardian。
  // 探活成功后直接复用这一条 CDP session 作为正式 page client，避免马上 detach 后又新建
  // 第二条 session 再做一次 Runtime.enable。故障日志里反复出现的 created=false +
  // Runtime.enable timeout，正符合“旧 target 探活成功、第二次 attach 卡死”的模式。
  if (target) {
    try {
      page = new CdpClient(target.webSocketDebuggerUrl)
      await page.connect()
      await page.send('Runtime.enable', {}, 3000)
      runtimeAlreadyEnabled = true
      await page.send('Runtime.evaluate', {
        expression: 'document.readyState',
        returnByValue: true,
      }, 3000)
    }
    catch {
      page?.close()
      page = null
      runtimeAlreadyEnabled = false
      await browser.send('Target.closeTarget', { targetId: target.id }).catch(() => {})
      target = null
    }
  }

  if (!target) {
    const result = await browser.send('Target.createTarget', {
      url: 'about:blank',
      newWindow: true,
      background: true,
    })
    target = await waitForTarget(cdpHttp, result.targetId)
    created = true
  }

  if (!page) {
    page = new CdpClient(target.webSocketDebuggerUrl)
    await page.connect()
  }
  await page.send('Network.enable')
  await page.send('Page.enable')
  if (!runtimeAlreadyEnabled) await page.send('Runtime.enable')
  await page.send('Performance.enable')
  await page.send('Page.setLifecycleEventsEnabled', { enabled: true })

  const window = await browser.send('Browser.getWindowForTarget', { targetId: target.id })
  let nativeWindow = null
  if (process.platform === 'win32') {
    const titleMarker = `ChatGPT Archive Guardian ${process.pid}-${Date.now()}`
    try {
      // Guardian 是独立窗口里的唯一 tab；临时改 document.title 就能可靠定位对应 HWND，
      // 隐藏后再导航/reload，页面会自行恢复正常标题。
      await page.send('Runtime.evaluate', {
        expression: `document.title=${JSON.stringify(titleMarker)}`,
        returnByValue: true,
      }, 3000)
      const { stdout } = await execFileAsync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-File', WINDOWS_HIDE_HELPER,
        '-TitleMarker', titleMarker,
      ], {
        encoding: 'utf8',
        timeout: 8000,
        windowsHide: true,
      })
      const normalizedStdout = String(stdout || '').trim()
      const [hwnd, visibleBefore, visibleAfter] = normalizedStdout.split(/\t/u)
      nativeWindow = normalizedStdout ? {
        hwnd: hwnd || null,
        visibleBefore: visibleBefore === 'True',
        visibleAfter: visibleAfter === 'True',
      } : {
        hidden: false,
        error: 'Win32 helper returned empty stdout',
      }
    }
    catch (error) {
      nativeWindow = {
        hidden: false,
        error: error instanceof Error ? error.message : String(error),
      }
      // 真隐藏失败时才退回 minimized；不会因此阻断归档功能。
      await browser.send('Browser.setWindowBounds', {
        windowId: window.windowId,
        bounds: { windowState: 'minimized' },
      })
    }
  }
  else {
    await browser.send('Browser.setWindowBounds', {
      windowId: window.windowId,
      bounds: { windowState: 'minimized' },
    })
  }
  return { browser, page, version, targetId: target.id, windowId: window.windowId, created, nativeWindow }
}

async function pageFetchJson(page, { url, targetPath, targetRoute, headers }) {
  const expression = `(${async function fetchJson(url, headers) {
    const response = await fetch(url, {
      credentials: 'include',
      headers,
    })
    const responseHeaders = {}
    for (const name of ['retry-after', 'x-request-id', 'cf-ray']) {
      const value = response.headers.get(name)
      if (value) responseHeaders[name] = value
    }
    return {
      status: response.status,
      text: await response.text(),
      headers: responseHeaders,
    }
  }.toString()})(${JSON.stringify(url)}, ${JSON.stringify(headers)})`
  const evaluate = async () => await page.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }, 20_000)
  let result
  try {
    result = await evaluate()
  }
  catch (error) {
    if (!shouldRetryConversationPageFetch(error)) throw error
    await new Promise(resolve => setTimeout(resolve, 500))
    result = await evaluate()
  }
  const value = result?.result?.value
  if (!value || typeof value.status !== 'number') {
    const exception = result?.exceptionDetails?.exception?.description
      || result?.exceptionDetails?.text
      || null
    throw new Error(exception ? `Page fetch failed for ${url}: ${exception}` : `No fetch result for ${url}`)
  }
  let body = null
  try { body = value.text ? JSON.parse(value.text) : null }
  catch { /* preserve status even when an error body is not JSON */ }
  return {
    status: value.status,
    body,
    text: String(value.text || ''),
    headers: value.headers && typeof value.headers === 'object' ? value.headers : {},
  }
}

/**
 * 在 Guardian 自己的页面上下文里发起 SSE resume，并把 body 持续 drain 掉。
 *
 * 请求仍走真实 ChatGPT 页面网络栈；Archive 只补充当前 turn 已保存的 resume capability。
 * CDP passive observer 会把这条 `/f/conversation/resume` 当普通原生流继续接入 LiveTurn，
 * 因此这里不解析 assistant 正文，也不会产生第二套流状态机。
 */
async function pageResumeConversation(page, { conversationId, offset, token, headers }) {
  const url = '/backend-api/f/conversation/resume'
  const expression = `(${async function resumeConversation(url, headers, conversationId, offset, token) {
    const requestHeaders = {
      ...headers,
      'content-type': 'application/json',
      'x-conduit-token': token,
      'x-openai-web-sse-compression': '1',
    }
    const response = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: requestHeaders,
      body: JSON.stringify({ conversation_id: conversationId, offset }),
    })
    const responseHeaders = {}
    for (const name of ['retry-after', 'x-request-id', 'cf-ray', 'content-type']) {
      const value = response.headers.get(name)
      if (value) responseHeaders[name] = value
    }
    if (response.ok && response.body) {
      const key = conversationId + ':' + String(Date.now())
      const pumps = globalThis.__chatgptArchiveResumePumps ||= new Map()
      const reader = response.body.getReader()
      const pump = (async () => {
        try {
          while (true) {
            const next = await reader.read()
            if (next.done) break
          }
        }
        catch {
          // CDP observer owns lifecycle evidence; page-side drain failure is not authoritative.
        }
        finally {
          pumps.delete(key)
          try { reader.releaseLock() }
          catch { /* ignore */ }
        }
      })()
      pumps.set(key, pump)
    }
    return { status: response.status, headers: responseHeaders }
  }.toString()})(${JSON.stringify(url)}, ${JSON.stringify(headers)}, ${JSON.stringify(conversationId)}, ${JSON.stringify(offset)}, ${JSON.stringify(token)})`
  const result = await page.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  const value = result?.result?.value
  if (!value || typeof value.status !== 'number') throw new Error(`No resume result for ${conversationId}`)
  return {
    status: value.status,
    headers: value.headers && typeof value.headers === 'object' ? value.headers : {},
  }
}

export function resumeRetryDelayMs(attemptNumber) {
  const attempt = Math.max(1, Math.trunc(Number(attemptNumber) || 1))
  const schedule = [2_000, 5_000, 15_000, 30_000, 60_000]
  return schedule[Math.min(schedule.length - 1, attempt - 1)]
}

/**
 * 判断一条本机 SSE 是否已经进入“静默挂死、应该交给 resume”的状态。
 *
 * 不能只看 startedAt：模型首 token 本来就可能等很久。只有已经真正收到过 SSE bytes，
 * 并且当前 turn 已经拿到可持久化的 resume capability，之后连续一段时间连 ping/data 都没有，
 * 才把旧流视为失活。turn-WSS 不走这个判定，它有自己的 socket lifecycle。
 */
export function shouldRetireIdleLiveTransport(
  state,
  {
    now = Date.now(),
    idleMs = 45_000,
    hasResumeCredential = false,
  } = {},
) {
  if (!state || !hasResumeCredential) return false
  if (state.transport !== 'conversation' && state.transport !== 'resume') return false
  if (!String(state.conversationId || '').trim()) return false
  const lastDataAt = Number(state.lastDataAt)
  if (!Number.isFinite(lastDataAt) || lastDataAt <= 0) return false
  return Number(now) - lastDataAt >= Math.max(1_000, Number(idleMs) || 45_000)
}

/**
 * conversation 级 legacy terminal_state 只作为 Body completion state 的持久化列；只有它比
 * 当前 resume token 更新时，才可证明该 token 所属 turn 已经完成。
 * 同一个 CID 可以连续发送多个 turn；上一轮的 final 不能阻止下一轮恢复。
 */
export function bodyCompletionStateSupersedesResumeCredential(row, credentialSeenAt) {
  if (row?.bodyCompletionState !== 'final') return false
  const completionSeenAt = Number(row?.lastSeenAt)
  const tokenSeenAt = Number(credentialSeenAt)
  if (!Number.isFinite(completionSeenAt) || !Number.isFinite(tokenSeenAt)) return false
  return completionSeenAt >= tokenSeenAt
}

export function listPath(offset, limit, template = null) {
  return buildGlobalCatalogPath(offset, limit, template)
}

/**
 * 同一次 conversation sync 的所有主动子请求都继承同一组 session-scoped extraHeaders。
 * checkpoint 场景里 latest body、cursor body 与必要的 exact mapping 属于同一 polling session；
 * x-oai-turn-trace-id 不能只加在其中一部分请求上。
 */
export function syncSubrequestFetchOptions(syncOptions = {}, { skipRequestSlot = false } = {}) {
  const requestOptions = {}
  if (skipRequestSlot) requestOptions.skipRequestSlot = true
  if (syncOptions.extraHeaders && typeof syncOptions.extraHeaders === 'object') {
    requestOptions.extraHeaders = syncOptions.extraHeaders
  }
  return requestOptions
}

/**
 * 把 ChatGPT conversation 私有 REST URL 归一化成少数几类。
 *
 * 这个分类器只看 URL，不读取 cookie/token，也不发请求。后续三条路径共用它：
 * 1) 监听页面自己已经发出的 native response；
 * 2) 判断某个 native list 是否与 daemon 的全量 catalog 语义等价；
 * 3) cooldown 期间只屏蔽 Guardian 的 conversation REST，同时保留 WSS。
 */
export function classifyConversationBackendUrl(input, base = 'https://chatgpt.com') {
  try {
    const url = new URL(String(input || ''), base)
    if (url.origin !== 'https://chatgpt.com') return null

    if (url.pathname === '/backend-api/conversations') {
      const offset = Number(url.searchParams.get('offset') ?? '0')
      const limit = Number(url.searchParams.get('limit') ?? '0')
     const origin = url.searchParams.get('conversation_origin')
      const excludeOrigin = url.searchParams.get('exclude_conversation_origin')
     const hideSnorlax = url.searchParams.get('hide_snorlax')
     const order = url.searchParams.get('order')
     const archived = url.searchParams.get('is_archived')
     const starred = url.searchParams.get('is_starred')
     // global catalog 的语义是“不启用额外过滤”。第一方可以显式传 false，也可以省略 false。
     // 因此这里按语义判断，而不是把某一版 query 的“字段是否存在”写成永久协议。
     const globalCatalog = !origin
        && !excludeOrigin
       && Number.isFinite(offset)
        && Number.isFinite(limit)
        && (order === null || order === 'updated')
        && archived !== 'true'
        && starred !== 'true'
        && hideSnorlax !== 'true'
      return {
        kind: 'catalog',
        offset: Number.isFinite(offset) ? offset : 0,
        limit: Number.isFinite(limit) ? limit : 0,
       globalCatalog,
       conversationOrigin: origin,
        excludeConversationOrigin: excludeOrigin,
       hideSnorlax,
     }
    }

    if (url.pathname === '/backend-api/gizmos/snorlax/sidebar') {
      const limit = Number(url.searchParams.get('limit') ?? '0')
      const conversationsPerGizmo = Number(url.searchParams.get('conversations_per_gizmo') ?? '0')
      return {
        kind: 'project-sidebar',
        limit: Number.isFinite(limit) ? limit : 0,
        conversationsPerGizmo: Number.isFinite(conversationsPerGizmo) ? conversationsPerGizmo : 0,
        ownedOnly: url.searchParams.get('owned_only'),
        cursor: url.searchParams.get('cursor'),
      }
    }

    const projectCatalog = url.pathname.match(/^\/backend-api\/gizmos\/([^/]+)\/conversations\/?$/u)
    if (projectCatalog) {
      const limit = Number(url.searchParams.get('limit') ?? '0')
      return {
        kind: 'project-catalog',
        gizmoId: decodeURIComponent(projectCatalog[1]),
        limit: Number.isFinite(limit) ? limit : 0,
        ownedOnly: url.searchParams.get('owned_only'),
        cursor: url.searchParams.get('cursor'),
      }
    }

    const plural = url.pathname.match(/^\/backend-api\/conversations\/([^/]+?)(\/messages)?\/?$/u)
    if (plural) {
      const conversationId = decodeURIComponent(plural[1])
      if (plural[2]) {
        return {
          kind: 'body-cursor',
          conversationId,
          before: url.searchParams.get('before'),
        }
      }
      return { kind: 'body-latest', conversationId }
    }

    const singular = url.pathname.match(/^\/backend-api\/conversation\/([^/]+)\/?$/u)
    if (singular) {
      return { kind: 'mapping', conversationId: decodeURIComponent(singular[1]) }
    }
    return null
  }
  catch {
    return null
  }
}



/** 只有 conversation REST 会在 Guardian cooldown 中被本地 CDP block；WSS 不匹配这里。 */
export function shouldBlockGuardianConversationRest(input) {
  return classifyConversationBackendUrl(input) !== null
}

/**
 * 判断是否必须把 Guardian conversation REST block 目标状态真实下发给 Chrome。
 *
 * 解除 block 必须始终幂等下发。Network.setBlockedURLs 如果在 CDP 层超时，
 * 浏览器端可能已经执行成功，而 daemon 本地缓存仍停留在 false；如果随后仅凭
 * cached false 跳过 unblock，就会形成 Chrome 实际 blocked / daemon 认为 clear 的分裂。
 */
export function shouldApplyGuardianConversationRestBlockCommand(enabled, cachedBlocked, uncertain = false) {
  if (!enabled) return true
  return Boolean(uncertain) || !Boolean(cachedBlocked)
}

/** conversation body/catalog 都是幂等 GET；仅对 CDP Runtime.evaluate 超时允许一次安全重试。 */
export function shouldRetryConversationPageFetch(error) {
  const message = error instanceof Error ? error.message : String(error || '')
  return /CDP Runtime\.evaluate timed out/iu.test(message)
}

/**
 * passive body 只替代“这一次 ready 之后页面自然产生的响应”。
 * 过旧 observation 仍可作为历史证据落库，但不能拿来证明当前 complete 已追平。
 */
export function passiveObservationMatchesReady(capturedAt, readyAt, toleranceMs = 1500) {
  const captured = Number(capturedAt)
  const ready = Number(readyAt)
  const tolerance = Math.max(0, Number(toleranceMs) || 0)
  return Number.isFinite(captured) && Number.isFinite(ready) && captured + tolerance >= ready
}

/** cooldown 刚解除时先 slow-start；连续成功若干次后才恢复正常请求间隔。 */
export function effectiveActiveRequestGap(baseGapMs, recoveryProbeRemaining, recoveryProbeGapMs) {
  const base = Math.max(0, Number(baseGapMs) || 0)
  const probeGap = Math.max(0, Number(recoveryProbeGapMs) || 0)
  return Number(recoveryProbeRemaining) > 0 ? Math.max(base, probeGap) : base
}

/**
 * 判断某个 WSS topic 是否属于 conversation 生命周期传输面。
 *
 * ChatGPT 当前稳定存在多条物理 WSS：conversation、通知、资源更新彼此独立。
 * gap repair 只应该跟随真正承载 conversation 生命周期的 transport 换代，
 * 不能因为 app_notifications/resource-updates 自己轮换就去扫 conversation catalog。
 */
export function isConversationTransportTopic(topic) {
  return topic === 'conversations' || topic === 'alder-conversations'
}

/**
 * 同一个 Guardian 生命周期内，只要已经见过一条 conversation carrier，
 * 后续换到另一条 requestId 就视为 transport generation 发生变化。
 *
 * 第一次建立 carrier 属于正常启动，不触发 repair；旧 carrier 先关闭再建立新 carrier，
 * 或新旧 carrier overlap 后换代，两种形态都返回 true。
 */
export function shouldRepairConversationTransport(observedCarrierBefore, currentRequestId, nextRequestId) {
  const next = typeof nextRequestId === 'string' ? nextRequestId.trim() : ''
  if (!next) return false
  const current = typeof currentRequestId === 'string' ? currentRequestId.trim() : ''
  return Boolean(observedCarrierBefore) && current !== next
}

/**
 * 只有真正的顶层 ChatGPT document replacement 才需要淘汰旧 WSS telemetry。
 *
 * ChatGPT 正常 sidebar/new-chat 路由走 SPA，不会触发 `Page.frameNavigated`；而 `Page.navigate`、
 * reload、renderer 恢复会创建一个新的顶层 document。旧 document 的 WebSocket JS 对象此时已经
 * 不可能继续属于当前页面，但 Chrome CDP 在 document replacement 场景下并不保证逐条补发
 * `Network.webSocketClosed`。若继续把旧 requestId 留在 activeSocketIds，3 条账户 socket 会在每次
 * full navigation 后累积成 6/9/12，最终让“是否仍有 WSS”这个健康判断失真。
 */
export function shouldRetireWssSocketsForFrameNavigation(frame) {
  if (!frame || typeof frame !== 'object') return false
  if (typeof frame.parentId === 'string' && frame.parentId) return false
  const url = typeof frame.url === 'string' ? frame.url : ''
  return url.startsWith('https://chatgpt.com/')
}

async function main() {
  const flags = parseArgs(process.argv.slice(2))
  const daemonSingleton = await acquireArchiveDaemonSingleton()
  const cdpHttp = String(flags.get('cdp') || DEFAULT_CDP).replace(/\/$/u, '')
  const dbPath = flags.has('db') ? path.resolve(String(flags.get('db'))) : DEFAULT_DB
  const statePath = flags.has('state') ? path.resolve(String(flags.get('state'))) : DEFAULT_STATE
  const logPath = flags.has('log') ? path.resolve(String(flags.get('log'))) : DEFAULT_LOG
  const turnTracePath = flags.has('turn-trace')
    ? path.resolve(String(flags.get('turn-trace')))
    : DEFAULT_TURN_TRACE
  const liveSseDir = flags.has('live-sse-dir')
    ? path.resolve(String(flags.get('live-sse-dir')))
    : DEFAULT_LIVE_SSE_DIR
  const notificationConfigPath = flags.has('notification-config')
    ? path.resolve(String(flags.get('notification-config')))
    : DEFAULT_NOTIFICATION_CONFIG
  const protocolLedgerPath = flags.has('protocol-ledger')
    ? path.resolve(String(flags.get('protocol-ledger')))
    : DEFAULT_PROTOCOL_LEDGER
  const requestEventLedgerPath = flags.has('request-event-ledger')
    ? path.resolve(String(flags.get('request-event-ledger')))
    : DEFAULT_REQUEST_EVENT_LEDGER
  const archiveEvidenceDir = flags.has('evidence-dir')
    ? path.resolve(String(flags.get('evidence-dir')))
    : DEFAULT_ARCHIVE_EVIDENCE_DIR
  // 紧急回滚阀：若外置 CAS 在某台机器/文件系统上出现不可接受的问题，可显式恢复旧 SQLite
  // live_observations BLOB 写入。默认必须走外置 Evidence Store，避免新数据继续把 Hot DB 撑大。
  const externalEvidenceEnabled = !flags.has('legacy-live-observations')
  // Phase 5 Bridge 默认只监听 loopback。即使用户显式传了其它 host，也必须再给
  // `--allow-remote-bridge` 才允许启动，避免一次参数误写把本地 Archive/Actor 控制面暴露出去。
  const bridgeEnabled = !flags.has('no-bridge')
  const bridgeHost = String(flags.get('bridge-host') || DEFAULT_BRIDGE_HOST).trim()
  const bridgePort = intFlag(flags, 'bridge-port', DEFAULT_BRIDGE_PORT, 1)
  const bridgeAuthPath = flags.has('bridge-auth')
    ? path.resolve(String(flags.get('bridge-auth')))
    : DEFAULT_BRIDGE_AUTH
  const lifeOpsSyncConfigPath = flags.has('lifeops-sync-config')
    ? path.resolve(String(flags.get('lifeops-sync-config')))
    : DEFAULT_LIFEOPS_SYNC_CONFIG
  const lifeOpsSyncPendingPath = flags.has('lifeops-sync-pending')
    ? path.resolve(String(flags.get('lifeops-sync-pending')))
    : DEFAULT_LIFEOPS_SYNC_PENDING
  const actorStatePath = flags.has('actor-state')
    ? path.resolve(String(flags.get('actor-state')))
    : DEFAULT_ACTOR_STATE
  const actorSubmissionQueuePath = flags.has('actor-submission-queue')
    ? path.resolve(String(flags.get('actor-submission-queue')))
    : DEFAULT_ACTOR_SUBMISSION_QUEUE
  const domLedgerPath = flags.has('dom-ledger')
    ? path.resolve(String(flags.get('dom-ledger')))
    : DEFAULT_DOM_LEDGER
  const loopbackBridgeHost = bridgeHost === '127.0.0.1' || bridgeHost === '::1' || bridgeHost === 'localhost'
  if (bridgeEnabled && !loopbackBridgeHost && !flags.has('allow-remote-bridge')) {
    throw new Error('Archive Bridge non-loopback bind requires explicit --allow-remote-bridge')
  }
  const devSpaceDbPath = flags.has('devspace-db')
    ? path.resolve(String(flags.get('devspace-db')))
    : defaultDevSpaceDbPath()
  // 这里的 delay 不是“同步完以后随便睡一下”，而是所有主动 backend 请求之间的
  // **全局最小间隔**。Backlog 追平宁可花一两个小时，也不要因为一次启动积压 100+ 条
  // conversation 就短时间连续打几十个请求。
  const syncDelayMs = intFlag(flags, 'sync-delay-ms', 6000, 0)
  const reconcileDelayMs = intFlag(flags, 'reconcile-delay-ms', 5000, 0)
  const requestJitterMs = intFlag(flags, 'request-jitter-ms', 1500, 0)
  const overlapThreshold = intFlag(flags, 'overlap', 56, 1)
  // WSS / Live Turn 才是实时发现主路径；catalog 只承担冷启动、断线恢复和低频最终一致性兜底。
  // 不能因为普通 Web turn 暂时缺少通用 start 事件，就把 conversation list 偷偷升级成小时级
  // “准实时 heartbeat”。默认恢复为 6 小时；跨设备 early signal 继续单独验证
  // conversation-history-update，本机 Web turn 则由 Phase 3 直接观察 /f/conversation SSE。
  const reconcileHours = Number(flags.get('reconcile-hours') ?? 6)
  const reconcileOnStart = !flags.has('no-reconcile-on-start')
  // 私有 `/files/download/{file_id}` resolver 目前仅由当前 Web bundle 反向确认，
  // 尚未完成 Archive 自身的一次 production E2E。默认关闭，必须显式 opt-in。
  const allowActiveImageResolver = flags.has('allow-active-image-resolver')
  const cooldownMinutes = intFlag(flags, 'cooldown-minutes', 60, 1)
  const maxSyncConversations = intFlag(flags, 'max-sync-conversations', 0, 0)
  const wssReconnectGraceMs = intFlag(flags, 'wss-reconnect-grace-ms', 20_000, 1000)
  const guardianHealthFailureThreshold = intFlag(flags, 'guardian-health-failures', 3, 1)
  const gapRepairDelayMs = intFlag(flags, 'gap-repair-delay-ms', 30_000, 1000)
  const gapRepairMinIntervalMs = intFlag(flags, 'gap-repair-min-interval-ms', 10 * 60_000, 10_000)
  const nativeBodyGraceMs = intFlag(flags, 'native-body-grace-ms', 3000, 0)
  const completeSettleMs = intFlag(flags, 'complete-settle-ms', 15_000, 1000)
  const recoveryProbeGapMs = intFlag(flags, 'recovery-probe-gap-ms', 30_000, 1000)
  const recoveryProbeSuccesses = intFlag(flags, 'recovery-probe-successes', 3, 1)
  // 2026-10-06 两个真实 iPhone -> PC late-open 样本都显示：resume 不可用以后，
  // 第一方 Web 大约每 7~10 秒读取一次 stream_status + conversation body。
  // 这里复刻的是这个量级和状态机，不做固定 7 秒机械轮询；随机抖动也能避免形成强周期指纹。
  const checkpointPollMinMs = intFlag(flags, 'checkpoint-poll-min-ms', 7_000, 1000)
  const checkpointPollMaxMs = intFlag(flags, 'checkpoint-poll-max-ms', 10_000, checkpointPollMinMs)
  const checkpointFirstProbeMs = intFlag(flags, 'checkpoint-first-probe-ms', 1_000, 0)
  const checkpointErrorRetryMs = intFlag(flags, 'checkpoint-error-retry-ms', 30_000, 1000)
  const checkpointMaxErrors = intFlag(flags, 'checkpoint-max-errors', 3, 1)
  // 紧急安全默认：2026-10-07 已确认 7~10s stream_status+body 主动轮询会在长 turn / sticky-active
  // 上把账户持续推入 429 cooldown。先默认关闭 Archive 自己的主动 checkpoint polling；
  // WSS/SSE/被动网页请求、gap repair、watchdog 仍照常工作。后续只有在限额模型重新验证后才显式 opt-in。
  const checkpointPollingEnabled = flags.has('enable-checkpoint-polling')
  const watchdogMinutes = Number(flags.get('watchdog-minutes') ?? 45)
  if (!Number.isFinite(watchdogMinutes) || watchdogMinutes <= 0) throw new Error('--watchdog-minutes must be > 0')
  const watchdogMs = watchdogMinutes * 60_000

  await fs.mkdir(path.dirname(statePath), { recursive: true })
  let previousDaemonState = null
  try {
    previousDaemonState = JSON.parse(await fs.readFile(statePath, 'utf8'))
  }
  catch {
    // 首次启动或损坏的旧 state 都不应阻止 daemon 启动。
  }
  const startedAt = Date.now()
  // Archive daemon 同时承载 Bridge HTTP、WSS/SSE、DevSpace UDP、Bark timer 与 CDP health。
  // Node 事件循环是 cooperative scheduling：任一同步 SQLite/JS 段不返回，这些控制面就都无法调度。
  // 用固定 250ms 心跳直接量“实际失去调度多久”，避免以后再把 event-loop starvation 误判成网络慢。
  const CONTROL_PLANE_TICK_MS = 250
  // 延迟必须用 monotonic clock；Date.now() 受 Windows/NTP 墙钟校正影响，不适合做 event-loop drift。
  let controlPlaneExpectedMono = performance.now() + CONTROL_PLANE_TICK_MS
  let controlPlanePreviousCpu = process.cpuUsage()
  let controlPlanePreviousElu = performance.eventLoopUtilization()
  let controlPlaneLagLastMs = 0
  let controlPlaneLagMaxMs = 0
  let controlPlaneLagOver100Ms = 0
  let controlPlaneLagOver1000Ms = 0
  let controlPlaneStage = 'startup'
  const controlPlaneRecentSlowLags = []
  const recordControlPlaneSlowPath = ({ at = Date.now(), lagMs, stage, source, cpuMs = null, elu = null }) => {
    const durationMs = Math.max(0, Number(lagMs) || 0)
    if (durationMs < 100) return
    controlPlaneRecentSlowLags.push({
      at,
      lagMs: Math.round(durationMs * 100) / 100,
      stage,
      source,
      ...(Number.isFinite(Number(cpuMs)) ? { cpuMs: Math.round(Number(cpuMs) * 100) / 100 } : {}),
      ...(Number.isFinite(Number(elu)) ? { elu: Math.round(Number(elu) * 10_000) / 10_000 } : {}),
    })
    if (controlPlaneRecentSlowLags.length > 40) controlPlaneRecentSlowLags.shift()
  }
  const runControlPlaneStage = (stage, fn) => {
    const previous = controlPlaneStage
    const sectionStartedAt = performance.now()
    controlPlaneStage = stage
    try {
      return fn()
    }
    finally {
      recordControlPlaneSlowPath({
        lagMs: performance.now() - sectionStartedAt,
        stage,
        source: 'sync-section',
      })
      controlPlaneStage = previous
    }
  }
  const yieldControlPlane = () => new Promise(resolve => setImmediate(resolve))
  const controlPlaneLagTimer = setInterval(() => {
    const now = Date.now()
    const nowMono = performance.now()
    const lagMs = Math.max(0, nowMono - controlPlaneExpectedMono)
    const cpu = process.cpuUsage(controlPlanePreviousCpu)
    controlPlanePreviousCpu = process.cpuUsage()
    const cpuMs = (Number(cpu.user || 0) + Number(cpu.system || 0)) / 1000
    const eluDelta = performance.eventLoopUtilization(controlPlanePreviousElu)
    controlPlanePreviousElu = performance.eventLoopUtilization()
    controlPlaneLagLastMs = lagMs
    controlPlaneLagMaxMs = Math.max(controlPlaneLagMaxMs, lagMs)
    if (lagMs >= 100) controlPlaneLagOver100Ms += 1
    if (lagMs >= 1000) controlPlaneLagOver1000Ms += 1
    recordControlPlaneSlowPath({
      at: now,
      lagMs,
      stage: controlPlaneStage,
      source: 'timer-drift',
      cpuMs,
      elu: eluDelta.utilization,
    })
    controlPlaneExpectedMono = nowMono + CONTROL_PLANE_TICK_MS
  }, CONTROL_PLANE_TICK_MS)
  controlPlaneLagTimer.unref?.()
  // 进程一拿到 statePath 就先覆盖“旧 daemon 的 PID 身份”，不要等到历史 seed、
  // DevSpace catch-up、Bridge/WSS 等较重初始化完成以后才第一次写 state。
  //
  // 这份 bootstrap state 有两个目的：
  // 1. daemon status 在启动窗口里看到的是“新进程正在初始化”，而不是已经死亡的旧 PID；
  // 2. daemon resume 若健康探针失败，可以准确终止本次刚启动的新 PID，真正 fail-closed。
  //
  // 这里只写最小、明确为 initializing 的结构；完整状态会在后续正常 writeState() 覆盖。
  await fs.writeFile(statePath, JSON.stringify({
    pid: process.pid,
    startedAt,
    updatedAt: startedAt,
    startupPhase: 'initializing',
    database: dbPath,
    turnTrace: turnTracePath,
    cdp: cdpHttp,
    bridge: {
      enabled: bridgeEnabled,
      listening: false,
      host: bridgeHost,
      port: bridgePort,
      clients: 0,
      startedAt: null,
      authPath: bridgeAuthPath,
      lastError: null,
    },
    guardian: null,
    wss: {
      activeSockets: 0,
      gapStartedAt: null,
    },
    devspace: {
      dbPath: devSpaceDbPath,
      wake: {
        listening: false,
        received: 0,
        invalid: 0,
        handlerErrors: 0,
        lastError: null,
      },
    },
    lastError: null,
  }, null, 2)).catch(() => {})
  const archive = new ChatArchiveDb(dbPath)
  const archiveMergeWorker = new ArchiveMergeWorker(dbPath)
  const evidenceStore = new ArchiveEvidenceStore(archiveEvidenceDir)
  const requestEventLedger = new RequestEventLedger(requestEventLedgerPath)
  const devSpaceAuditBridge = new DevSpaceAuditBridge(devSpaceDbPath)
  const devSpaceAuditWakeListener = new DevSpaceAuditWakeListener()
  /** Bridge 失败不能拖死 Archive 核心；状态会明确暴露 lastError，后续可单独修复/重启。 */
  let archiveBridge = null
  let archiveBridgeStartedAt = null
  let archiveBridgeLastError = null
  let guardian = null
  // `guardian === null` 同时出现在“进程第一次启动”和“运行中自愈 catch 已清空旧 Guardian”两种
  // 场景；不能再仅凭 null 决定 reason。否则运行中 WSS/renderer 故障会被误标成 startup，
  // 从而跳过 guardian-recover reconciliation，留下一个真正的事件盲区。
  let guardianEstablishedOnce = false
  let authHeaders = null
  let lastAuthAt = null
  // 只从第一方自然产生的 global conversation list 学 query 模板；主动 replay 自己不会反哺模板。
  // 这样若上游新增稳定 query，可以自动继承，同时不会把 TPP/hide_snorlax=true 等过滤混入全量 catalog。
  let globalCatalogQueryTemplate = null
  const rateLimits = restoreFamilyRateLimitSnapshot(previousDaemonState)
  // cooldownUntil 仅保留为旧版 state 的一次性全局迁移闸门。
  // 新发生的 429 全部写入 rateLimits.families，不再回写这个全局值。
  let cooldownUntil = Number(rateLimits.legacyGlobalUntil || 0)
  let cooldownRecoveryPending = cooldownUntil > Date.now()
  let lastReconcileAt = 0
  let lastWssEventAt = null
  let lastWssCreatedAt = null
  let lastWssClosedAt = null
  let lastWssFrameAt = null
  let lastWssControlAt = null
  // “现在没有任何 ChatGPT WSS”从什么时候开始。首次加载从 Guardian ready 起算；
  // 运行期则只在最后一条受监控 socket 真正收到 CDP close 时重新起算。
  let wssGapStartedAt = null
  let lastWssReconnectDelayMs = null
  let wssSentFrames = 0
  let wssReceivedFrames = 0
  let wssParsedEventFrames = 0
  let wssUnparsedConversationFrames = 0
  let wssGeneration = 0
  // conversation transport 与物理 WSS 总数分开追踪。一个 Guardian 内第一次看到 carrier
  // 只是初始化；之后 requestId 改变才代表真正的 transport generation 换代。
  let conversationTransportRequestId = null
  let lastConversationTransportRequestId = null
  let conversationTransportGeneration = 0
  let conversationTransportObservedInGuardian = false
  let lastConversationTransportChangedAt = null
  let lastConversationTransportClosedAt = null
  let subscribedTopics = new Set()
  let observedMessageTopics = new Set()
  let observedConversationEventTypes = new Set()
  let conversationSubscriptionRecovered = null
  let lastSafeWssControls = []
  let guardianReadyAt = 0
  let guardianHealthFailures = 0
  let guardianLastCdpFailureScope = null
  let guardianLastBrowserPingMs = null
  let guardianRebuilds = 0
  let guardianUiReloadAttemptedAt = null
  let guardianUiFailure = null
  let activeSocketIds = new Set()
  // 逐 socket 的控制面遥测只保存在内存/state/log 中，用来回答“到底是哪一条 WSS 在轮换”。
  // 这里故意不保存完整 URL/query、正文、cookie、token 或认证头；requestId 只是本次 CDP
  // 会话里的短生命周期标识，topic/recovered 则是判断 conversations transport 是否换代的关键证据。
  let wssSocketTelemetry = new Map()
  let recentWssSocketLifecycles = []
  let stopping = false
  let pendingGapRepair = null
  let lastGapRepairAttemptAt = 0
  // 只记录 gap-repair 当前被哪一道门卡住；用于解释“为什么没有 fallback”，不参与决策。
  let lastGapRepairGate = null
  let lastGapRepairGateSignature = null
  // dirty = “本地可能落后”；ready = “现在允许主动抓 body”。二者必须分开。
  const dirty = new Map()
  const ready = new Map()
  // readySince 用于判断 passive response 是否属于“这一次 complete 之后”的新证据；
  // readyNotBefore 则真正实现 native grace。旧代码只 setTimeout(drainDirty)，但 ready 已经进 Map，
  // 主循环仍可能在 timeout 前抢跑，因此 delay 实际并不是硬门槛。
  const readySince = new Map()
  const readyNotBefore = new Map()
  // 页面 native body/list 的短期缓存。body 记录必须保留“写入 SQLite 前已知 message”快照，
  // 否则 passive merge 后再做 overlap，会被自己刚写进去的数据误判成“整页早已存在”。
  const passiveBodyPages = new Map()
  const passiveCatalogPages = new Map()
  let passiveProjectSidebar = null
 const passivePageObservers = new Map()
  // activeLiveTransports 仍只暴露轻量生命体征；完整 SSE 正文另存到本地 live-sse journal，
  // 不混进 state/log，避免普通诊断命令意外打印整段聊天正文。
  const activeLiveTransports = new Map()
  let liveSseJournalStarted = 0
  let liveSseJournalFinalized = 0
  let liveSseJournalBytes = 0
  let liveSseJournalErrors = 0
  let liveSseCanonicalPromoted = 0
  let liveSseCanonicalFallbacks = 0
  let liveSsePartialEvidenceMerged = 0
  let liveSsePartialMessagesMerged = 0
  let liveSseBodyRefreshesSkipped = 0
  // 完整 SSE promotion 后给同一 CID 一个很短的“本 turn 已满足”窗口。新 turn 的明确 start
  // 会立即删除它；TTL 只是防止极端缺失 lifecycle 时旧标记永久影响后续同步。
  const liveSseCanonicalSatisfied = new Map()
  const liveSseSatisfiedTtlMs = 5 * 60_000
  // Remote/跨设备 turn 没有本机原始 SSE 时，使用第一方 Web 已验证的
  // `stream_status + canonical body` checkpoint fallback。它只在明确 active CID 上建立，
  // 并和 LiveTurn transport 分开：一旦本机已经有真正 live transport，就暂停主动 checkpoint。
  const checkpointWatches = new Map()
  // 第一方 late-open 的 x-oai-turn-trace-id 已真机确认是每个 polling session 独立生成的 UUID。
  // raw trace 只驻留内存，不写 state/log；同一 Guardian 可以同时承载多个 CID 的独立 polling session。
  const checkpointTurnContexts = new Map()
  const resumeRetryTimers = new Map()
  const resumeMaxAttempts = 5
  const liveTransportIdleResumeMs = 45_000
  const resumeStartupLookbackMs = 24 * 60 * 60_000
  let resumeStartupRecoveryDone = false
  let checkpointInFlight = false
  let checkpointProbes = 0
  let checkpointBodyRefreshes = 0
  let checkpointErrors = 0
  let checkpointCompleted = 0
  const passiveObserverRetryAfter = new Map()
  const passiveObserverFailureCounts = new Map()
  const imageHydrationTargetRetryAfter = new Map()
  // body observation 可能恰好发生在一小时 cooldown 开始后。若缓存只有 10 分钟，
  // cooldown 结束时会忘掉已经免费拿到的 latest page，又重复请求一次。因此缓存寿命至少覆盖
  // 一个完整 cooldown 再加 10 分钟缓冲；catalog 是否可用于“当前 repair”另有 capturedAt 门槛。
  const passiveCacheMaxAgeMs = Math.max(10 * 60_000, (cooldownMinutes + 10) * 60_000)
  const passiveCatalogFreshnessMs = intFlag(flags, 'passive-catalog-freshness-ms', 60_000, 1000)
  let passiveBodyResponses = 0
  let passiveCatalogResponses = 0
  let passiveProjectCatalogResponses = 0
  let projectCatalogRepairs = 0
  let projectCatalogRepairDiscoveries = 0
  let passiveImageResponses = 0
  let passiveImageHydrations = 0
  let passiveImageCaptureErrors = 0
  let passive429Responses = 0
  let passiveBodyPagesReused = 0
  let passiveCatalogPagesReused = 0
  let guardianProtocolBodyReadsInFlight = 0
  let guardianProtocolBodyReadsSkipped = 0
  let requestEventLedgerErrors = 0
  let guardianConversationRestBlockedPatterns = []
  let guardianConversationRestBlockUncertain = true
  // catalogActive 只表示“低频 conversation list 曾看见 async_status=3/5”。它不是可靠
  // turn start；若没有更强证据，activeTurns 可以用“首次观察时刻”作为保守 late-start 下界，
  // 但必须以 catalog:* 标记。一次 timeout 后的 anti-resurrection 由独立 catalog watermark
  // 负责，不能再把 conversation 留在 activeTurns 里充当墓碑。
  // 这个集合另外用于识别 active→complete 与 update_time progress。
  const catalogActive = new Map()
  const activeTurns = new Map()
  const pendingWatchdogDiagnoses = new Map()
  const postCompletionDevSpaceCandidates = new Map()
  const deferredCatalogWatchdogCandidates = new Map()
  const recentConversationComplete = new Map()
  const persistActiveTurn = (conversationId, active) => {
    archive.upsertActiveWatchdog({
      conversationId,
      startedAt: Number(active.startedAt || 0),
      lastEventAt: Number(active.lastEventAt || active.startedAt || 0),
      lastWatchdogAt: active.lastWatchdogAt === null || active.lastWatchdogAt === undefined
        ? null
        : Number(active.lastWatchdogAt),
      watchdogPendingAt: active.watchdogPendingAt === null || active.watchdogPendingAt === undefined
        ? null
        : Number(active.watchdogPendingAt),
      startType: String(active.startType || 'unknown'),
      lastDiagnosticTurnKey: active.lastDiagnosticTurnKey ?? null,
    })
  }
  const clearActiveTurn = (conversationId) => {
    const current = activeTurns.get(conversationId)
    activeTurns.delete(conversationId)
    if (current) archive.deleteActiveWatchdogIfStartedAt(conversationId, current.startedAt)
  }

  const queueDeferredCatalogWatchdogCandidate = ({
    conversationId,
    startedAt,
    lastEventAt,
    startType,
    title = null,
    updateTime = null,
  }) => {
    if (!conversationId) return null
    const existing = deferredCatalogWatchdogCandidates.get(conversationId)
    const candidate = mergeDeferredCatalogWatchdogCandidate(existing, {
      conversationId,
      startedAt,
      lastEventAt,
      startType,
      title,
      updateTime,
    })
    if (!candidate) return null
    deferredCatalogWatchdogCandidates.set(conversationId, candidate)
    if (!existing) {
      void log('catalog watchdog start deferred until canonical Body arrives', {
        conversationId,
        startedAt: candidate.startedAt,
        startType: candidate.startType,
        titlePresent: Boolean(String(candidate.title || '').trim()),
      })
    }
    return candidate
  }

  const dropDeferredCatalogWatchdogCandidate = (conversationId, reason) => {
    const candidate = deferredCatalogWatchdogCandidates.get(conversationId)
    if (!candidate) return false
    deferredCatalogWatchdogCandidates.delete(conversationId)
    void log('deferred catalog watchdog candidate dropped', {
      conversationId,
      reason,
      startedAt: candidate.startedAt,
      bodyTurnExchangeId: candidate.bodyTurnExchangeId ?? null,
    })
    return true
  }

  const startDeferredCatalogWatchdogCandidate = (conversationId, reason) => {
    const candidate = deferredCatalogWatchdogCandidates.get(conversationId)
    if (!candidate) return false
    if (activeTurns.has(conversationId)) {
      dropDeferredCatalogWatchdogCandidate(conversationId, 'active-generation-already-exists')
      return false
    }
    if (!catalogActive.has(conversationId)) {
      dropDeferredCatalogWatchdogCandidate(conversationId, 'catalog-no-longer-active')
      return false
    }
    if (String(candidate.bodyCompletionEvidence || 'none') !== 'none') {
      dropDeferredCatalogWatchdogCandidate(conversationId, 'canonical-body-already-complete')
      return false
    }
    if (archive.hasCatalogWatchdogCompleted(conversationId, candidate.updateTime ?? null)) {
      dropDeferredCatalogWatchdogCandidate(conversationId, 'catalog-observation-already-completed')
      return false
    }

    const nextActive = {
      startedAt: Number(candidate.startedAt),
      lastEventAt: Number(candidate.lastEventAt || candidate.startedAt),
      lastWatchdogAt: null,
      watchdogPendingAt: null,
      startType: String(candidate.startType || 'catalog:async-active:deferred'),
      lastDiagnosticTurnKey: candidate.bodyTurnExchangeId ?? null,
    }
    activeTurns.set(conversationId, nextActive)
    persistActiveTurn(conversationId, nextActive)
    dispatchWatchdogStartNotification(conversationId, nextActive, candidate.title ?? null)
    armCheckpointWatch(conversationId, `${nextActive.startType}:confirmed`, nextActive.startedAt)
    deferredCatalogWatchdogCandidates.delete(conversationId)
    void log('deferred catalog watchdog candidate confirmed by canonical Body', {
      conversationId,
      reason,
      startedAt: nextActive.startedAt,
      bodyTurnExchangeId: nextActive.lastDiagnosticTurnKey,
      startType: nextActive.startType,
    })
    return true
  }

  const recordDeferredCatalogBodyObservation = (conversationId, diagnostic, observedAt = Date.now()) => {
    const candidate = deferredCatalogWatchdogCandidates.get(conversationId)
    if (!candidate) return false
    candidate.bodyTurnExchangeId = diagnostic?.turnExchangeId ?? candidate.bodyTurnExchangeId ?? null
    candidate.bodyCompletionEvidence = diagnostic?.bodyCompletionEvidence ?? 'none'
    candidate.bodyObservedAt = Number(observedAt) || Date.now()
    deferredCatalogWatchdogCandidates.set(conversationId, candidate)

    if (String(candidate.bodyCompletionEvidence || 'none') !== 'none') {
      dropDeferredCatalogWatchdogCandidate(conversationId, 'canonical-body-complete')
      return false
    }
    if (hasPendingDevSpaceBindingWork()) {
      void log('deferred catalog watchdog candidate awaiting canonical matching queue', {
        conversationId,
        bodyTurnExchangeId: candidate.bodyTurnExchangeId,
        pendingEvidence: devSpaceBindingEvidenceWork.size,
        pendingAuditEvents: devSpaceBindingAuditWork.size,
      })
      return false
    }
    return startDeferredCatalogWatchdogCandidate(conversationId, 'canonical-body-active-matching-settled')
  }

  const flushDeferredCatalogWatchdogCandidates = (reason) => {
    if (hasPendingDevSpaceBindingWork()) return 0
    let started = 0
    for (const [conversationId, candidate] of [...deferredCatalogWatchdogCandidates.entries()]) {
      if (!candidate.bodyObservedAt) continue
      if (String(candidate.bodyCompletionEvidence || 'none') !== 'none') {
        dropDeferredCatalogWatchdogCandidate(conversationId, 'canonical-body-complete')
        continue
      }
      if (startDeferredCatalogWatchdogCandidate(conversationId, reason)) started += 1
    }
    return started
  }
  // daemon 重启必须恢复“原计时器”，而不是由最近一次 DevSpace audit 重新开表。
  // active_watchdogs 是 conversation 级状态，因此不受同一 CID 多 metadata 的影响。
  //
  // 旧实现会在每次启动时，对每个已有 lastDiagnosticTurnKey 的 watchdog 再扫一次
  // messages，尝试从 turn_exchange_id/request_id/message_id 反查 user create_time。
  // 这条兼容性重验在当前 11.56GiB 生产库上 11 条合计约 1.8s，而且本轮核验
  // 没有一条实际改变 startedAt。当前 runtime 在 canonical Body attach/move turn 时已经
  // 把 canonical startedAt 持久化进 active_watchdogs；稳态重启应直接相信 durable state。
  // 历史异常行若需要修复，必须走显式/bounded repair，而不是永久塞进 startup 热路径。
  for (const persisted of archive.listActiveWatchdogs()) {
    const restored = {
      startedAt: Number(persisted.startedAt),
      lastEventAt: persisted.lastEventAt,
      lastWatchdogAt: persisted.lastWatchdogAt,
      watchdogPendingAt: persisted.watchdogPendingAt,
      startType: persisted.startType,
      lastDiagnosticTurnKey: persisted.lastDiagnosticTurnKey,
    }
    const persistedCompletionAt = persistedWatchdogCompletionAt(persisted.lastWatchdogAt)
    if (persistedCompletionAt !== null) {
      const completedAt = persistedCompletionAt
      recentConversationComplete.set(persisted.conversationId, completedAt)
      if (Number(persisted.watchdogPendingAt || 0) > 0) {
        pendingWatchdogDiagnoses.set(persisted.conversationId, {
          ...restored,
          completedAt,
        })
      }
      else {
        if (/^(?:catalog|project-catalog):/u.test(String(persisted.startType || ''))) {
          const archived = archive.db.prepare(
            'SELECT update_time AS updateTime FROM conversations WHERE id = ?',
          ).get(persisted.conversationId)
          archive.markCatalogWatchdogCompleted(
            persisted.conversationId,
            archived?.updateTime ?? null,
            completedAt,
          )
        }
        archive.deleteActiveWatchdogIfStartedAt(persisted.conversationId, persisted.startedAt)
      }
      continue
    }
    activeTurns.set(persisted.conversationId, restored)
  }
  // metadata 尚未解出 canonical conversation 时，也先保存 first-tool 的真实时间。
  // binding 晚到以后仍以这个时间作为 watchdog.startedAt，不让发现延迟污染超时起点。
  const unboundDevSpaceTurns = new Map()
  let devSpaceBindingProbeGeneration = ''
  let devSpaceBindingProbedConversationIds = []
  // DevSpace audit 从 durable (started_at, audit_id) 高水位续读。首次升级时会在 daemon
  // startup 明确 bootstrap 到当时头部；之后无论离线多久都从持久游标继续，不再靠 2 分钟回看。
  let devSpaceAuditCursor = archive.getDevSpaceAuditCursor(DEVSPACE_AUDIT_CONSUMER_KEY)
  let devSpaceAuditCursorBootstrapped = Boolean(devSpaceAuditCursor)
  let devSpaceLastPollAt = null
  let devSpaceLastFallbackPollAt = 0
  let devSpaceLastAuditAt = null
  let devSpaceLastError = null
  let devSpaceAuditsObserved = 0
  let devSpaceAuditPollInFlight = false
  let devSpaceAuditPollScheduled = false
  let devSpaceAuditPollBatches = 0
  let devSpaceAuditPollYields = 0
  let devSpaceAuditLastBatchCount = 0
  let devSpaceAuditLastBatchMs = 0
  let devSpaceAuditMaxBatchMs = 0
  let devSpaceBindingsCreated = 0
  let devSpaceBindingMirrors = 0
  let devSpaceBindingQueueEnqueued = 0
  let devSpaceBindingQueueAttempts = 0
  let devSpaceBindingQueueMatches = 0
  let devSpaceBindingProbeMergesSkipped = 0
  // audit 热路径只负责发现“可能需要 binding match”的事实；真正的 exact-match/rebind
  // 放到 cooperative worker，每个 event-loop tick 最多做一条 evidence，避免一个本地
  // tool audit 把 Bark/CDP/WSS/timer 一起饿死几十秒甚至几分钟。
  const devSpaceBindingAuditWork = new Map()
  const devSpaceBindingEvidenceWork = new Map()
  let devSpaceBindingWorkerScheduled = false
  let devSpaceBindingWorkerInFlight = false
  const hasPendingDevSpaceBindingWork = () => (
    devSpaceBindingWorkerScheduled
    || devSpaceBindingWorkerInFlight
    || devSpaceBindingEvidenceWork.size > 0
    || devSpaceBindingAuditWork.size > 0
  )
  let devSpaceBindingWorkerRuns = 0
  let devSpaceBindingWorkerLastItemMs = 0
  let devSpaceBindingWorkerMaxItemMs = 0
  // 这里只追踪“最近有 DevSpace 活动、并且当前没有 running tool”的 metadata。
  // 每项保留上一轮观察到的 idle 时长，用于精确识别 1/3/5 分钟阈值穿越。
  const devSpaceIdleCandidates = new Map()
  let devSpaceIdleNotificationsQueued = 0
  // 5 分钟 probe 的“扫完必须给结果”状态。key=metadataId；绑定前后都沿用同一个 generation。
  // 只有 body sync 成功或 unbound gap-repair 明确结束后才消费，避免发“已扫描”但其实没拿到结果。
  const pendingDevSpaceIdleDiagnoses = new Map()
  let devSpaceIdleDiagnosisNotificationsQueued = 0
  // 45 分钟 unbound Watchdog 只有在“解析出 CID 并完成 Body 诊断”或
  // “catalog repair 后仍无 CID，明确记录 canonical Body 未取得”后才算闭环。
  const pendingUnboundWatchdogDiagnoses = new Map()
  let unboundWatchdogDiagnosisNotificationsQueued = 0
  // daemon 重启不能把一个已经计时几十分钟的 provisional watchdog 重新从 0 开始。
  // 从 Archive 自己的持久 binding 表恢复近期未绑定 metadata；firstSeenAt 仍是原始首个工具时间。
  for (const binding of archive.listDevSpaceMetadataBindings({
    onlyUnbound: true,
    sinceAt: Date.now() - Math.max(watchdogMs * 2, 2 * 60_000),
    limit: 1000,
  })) {
    const startedAt = Number(binding.firstSeenAt || binding.lastSeenAt || Date.now())
    const timedOutAt = Number(binding.unboundWatchdogAt || 0)
    // unbound_watchdog_at 存在时，旧 provisional generation 已经在 45m 硬边界结束；
    // 重启后只能恢复 pending diagnosis，不能把它重新塞回 active provisional 集合。
    if (timedOutAt <= 0) {
      unboundDevSpaceTurns.set(binding.metadataId, {
        startedAt,
        lastEventAt: binding.lastSeenAt,
        lastAuditId: binding.lastAuditId,
        repairQueuedAt: null,
      })
    }
    const diagnosisKey = unboundWatchdogDiagnosisNotificationKey(binding.metadataId, startedAt)
    if (timedOutAt > 0 && !archive.hasTurnNotification(diagnosisKey)) {
      pendingUnboundWatchdogDiagnoses.set(binding.metadataId, {
        metadataId: binding.metadataId,
        startedAt,
        watchdogAt: timedOutAt,
        title: binding.displayTitle ?? null,
        catalogRepairCompletedAt: null,
      })
    }
  }
  // 已经跨过 45m 硬边界的 unresolved diagnosis 不能受“近期活动窗口”限制。
  // 这里只扫很小的 binding 表，不碰 messages 大表；因此可安全跨重启恢复历史未闭环项。
  for (const binding of archive.listDevSpaceMetadataBindings({ onlyUnbound: true, limit: 1000 })) {
    const timedOutAt = Number(binding.unboundWatchdogAt || 0)
    if (timedOutAt <= 0) continue
    const startedAt = Number(binding.firstSeenAt || binding.lastSeenAt || timedOutAt)
    const diagnosisKey = unboundWatchdogDiagnosisNotificationKey(binding.metadataId, startedAt)
    if (archive.hasTurnNotification(diagnosisKey)) continue
    if (!pendingUnboundWatchdogDiagnoses.has(binding.metadataId)) {
      pendingUnboundWatchdogDiagnoses.set(binding.metadataId, {
        metadataId: binding.metadataId,
        startedAt,
        watchdogAt: timedOutAt,
        title: binding.displayTitle ?? null,
        catalogRepairCompletedAt: null,
      })
    }
  }
  // activeTurns 只承载“当前 generation 仍在运行”的计时器。已经跨过 45m 的 generation
  // 不再留在这里；pending diagnosis 与 catalog anti-resurrection 都有独立状态。
  const isCatalogLateActive = (active) => /^(?:catalog|project-catalog):/u.test(String(active?.startType || ''))
  const reliableActiveIds = () => [...activeTurns.entries()]
    .filter(([, active]) => !isCatalogLateActive(active))
    .map(([conversationId]) => conversationId)
  const catalogLateActiveIds = () => [...activeTurns.entries()]
    .filter(([, active]) => isCatalogLateActive(active))
    .map(([conversationId]) => conversationId)
  const timedOutWatchdogIds = () => [...pendingWatchdogDiagnoses.keys()]
  const pendingWatchdogDiagnosisIds = () => [...pendingWatchdogDiagnoses.keys()]
  const turnRecorder = new ActiveTurnRecorder(turnTracePath)
  const eventCounts = new Map()
  // eventCounts 继续按 type 聚合，保持现有状态输出兼容；另加 topic 维度用于 Phase 3 取证。
  const eventTopicCounts = new Map()
  let syncInFlight = false
  let reconcileInFlight = false
  let syncedConversations = 0
  let syncErrors = 0
  let lastError = null
  let lastActiveRequestAt = 0
  let recoveryProbeRemaining = 0
  let notificationConfig = null
  let lifeOpsSync = null
  let lifeOpsSyncLastError = null
  // metadata-only watchdog 先进入 LifeOps Inbox 后，后续一旦绑定出 canonical conversation/turn，
  // 需要让第一次 body sync 继续使用同一 sourceEventId，才能把 provisional 事件原地补齐。
  // 这只是短生命周期桥接；即使 daemon 恰好重启，LifeOps 端还有 conversation+turn 二次归并兜底。
  const lifeOpsEventOverrideByConversation = new Map()
  const lifeOpsWatchdogQueued = new Set()
  let protocolLedger = null
  let protocolFlushTimer = null
  let activeReplayRequestUrl = null
  let notificationLastAttemptAt = null
  let notificationLastSuccessAt = null
  let notificationLastError = null
  let lastImageHydrationAt = 0
  let imageHydrationSuccesses = 0
  let imageHydrationErrors = 0
  let activeImageResolverAttempts = 0
  let activeImageResolverSuccesses = 0
  let activeImageResolverErrors = 0
  let lastActiveImageResolverAt = 0
  // 5 秒 Critical tick 与后台 Maintenance lane 必须是两个故障域。
  //
  // Critical lane 只负责 Guardian/CDP/WSS/限流与状态心跳；Maintenance lane 才负责
  // observer attach、reconcile、dirty/checkpoint drain、gap repair、image hydration 等允许耗时的任务。
  // 这组 telemetry 用于证明“后台任务慢”不会再伪装成“整个 daemon 主循环失联”。
  let maintenanceLaneInFlight = false
  let maintenanceLaneScheduled = false
  let maintenanceLaneRuns = 0
  let maintenanceLaneLastMs = 0
  let maintenanceLaneMaxMs = 0
  let maintenanceLaneLastError = null
  let maintenanceLaneLastStep = null
  let latestCdpTargets = []
  let evidenceLegacyFallbacks = 0

  const log = async (message, extra = null) => {
    const line = `[${new Date().toISOString()}] ${message}${extra ? ` ${JSON.stringify(extra)}` : ''}\n`
    await fs.appendFile(logPath, line).catch(() => {})
    console.error(line.trim())
  }

  /**
   * 为一次 raw Body/Mapping observation 准备并持久化冷证据。
   *
   * 正常路径：
   *   async JSON gzip -> CAS blob（相同 SHA 复用）-> observation event JSONL -> Hot SQLite 只 merge canonical。
   *
   * 降级路径：
   *   外置 store 任一步失败时，仍把“已经准备好的 gzip”交给 legacy live_observations 写入。
   *   因此瘦身只影响存储布局，不改变“原始证据至少有一份 durable copy”的安全边界。
   */
  const prepareObservationEvidence = async ({
    payload,
    conversationId,
    observationKind,
    endpoint = null,
    pageCursor = null,
    observedAt = Date.now(),
  }) => {
    let preparedObservation = null
    try {
      preparedObservation = await prepareArchiveEvidence(payload)
    }
    catch (error) {
      evidenceLegacyFallbacks += 1
      await log('cold evidence preparation failed; falling back to legacy SQLite observation', {
        conversationId,
        observationKind,
        error: error instanceof Error ? error.message : String(error),
      }).catch(() => {})
      return { preparedObservation: null, skipLegacyObservation: false, storedEvidence: null }
    }

    if (!externalEvidenceEnabled) {
      return { preparedObservation, skipLegacyObservation: false, storedEvidence: null }
    }

    try {
      const storedEvidence = await evidenceStore.recordObservation({
        conversationId,
        observationKind,
        endpoint,
        pageCursor,
        observedAt,
        prepared: preparedObservation,
      })
      return { preparedObservation, skipLegacyObservation: true, storedEvidence }
    }
    catch (error) {
      evidenceLegacyFallbacks += 1
      await log('cold evidence store failed; falling back to legacy SQLite observation', {
        conversationId,
        observationKind,
        sha256: preparedObservation.sha256,
        error: error instanceof Error ? error.message : String(error),
      }).catch(() => {})
      return { preparedObservation, skipLegacyObservation: false, storedEvidence: null }
    }
  }

  /**
   * Bridge 是旁路产品接口，不允许任何客户端/SSE 写失败反向破坏 Archive 主链。
   * 这里只接受已经脱敏、体积很小的 lifecycle 元数据；原始 SSE chunk、resume credential、
   * ChatGPT Authorization/Cookie 永远不会经过这个函数。
   */
  const publishBridgeEvent = (event) => {
    if (!archiveBridge) return
    try {
      archiveBridge.publish({
        version: 1,
        at: Number(event?.at) || Date.now(),
        ...event,
      })
    }
    catch (error) {
      void log('Archive Bridge event publish failed', {
        kind: event?.kind ?? null,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  try {
    protocolLedger = await ProtocolDriftLedger.open(protocolLedgerPath)
  }
  catch (error) {
    await log('protocol drift ledger unavailable; monitoring disabled', {
      filePath: protocolLedgerPath,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  // 运行期重复事件可能在 Bark 请求尚未返回时再次到达；SQLite ledger 只能去重“已经成功”的
  // 通知，因此再用一个极小的 in-flight Set 挡住同进程并发重复。失败后 finally 删除，允许重试。
  const notificationInFlight = new Set()
  const protocolDriftPending = new Map()
  let protocolDriftNotifyTimer = null

  const canonicalConversationTitle = (conversationId) => {
    const row = archive.db.prepare('SELECT title FROM conversations WHERE id=?').get(conversationId)
    return row?.title || conversationId
  }

  // 所有用户可见通知都采用同一标题策略：canonical 真实标题优先；若仍是
  // New chat/新聊天/CID 占位符，则用最近的 DevSpace metadata title 补位。
  // 这不修改 ChatGPT 服务端标题，只避免本地通知在自动命名尚未完成时退化。
  const conversationTitle = (conversationId) => {
    const devSpaceTitles = archive.getDevSpaceMetadataBindingsForConversation(conversationId)
      .slice()
      .sort((a, b) => Number(b.lastSeenAt || 0) - Number(a.lastSeenAt || 0))
      .map(binding => binding.displayTitle)
    return preferredWatchdogStartTitle({
      conversationId,
      canonicalTitle: canonicalConversationTitle(conversationId),
      devSpaceTitles,
    }) || conversationId
  }

  /**
   * 新聊天刚起步时优先用 canonical 标题；若它仍是 `New chat/新聊天` 占位符，则从同 CID 的
   * DevSpace binding 中挑最近一次非空 displayTitle。这个查询只发生在“新 generation 建立”
   * 的低频路径，不进入主循环热路径。
   */
  const watchdogStartTitleForConversation = (conversationId, candidateTitle = null) => {
    const devSpaceTitles = archive.getDevSpaceMetadataBindingsForConversation(conversationId)
      .slice()
      .sort((a, b) => Number(b.lastSeenAt || 0) - Number(a.lastSeenAt || 0))
      .map(binding => binding.displayTitle)
    return preferredWatchdogStartTitle({
      conversationId,
      canonicalTitle: canonicalConversationTitle(conversationId),
      devSpaceTitles: [candidateTitle, ...devSpaceTitles],
    })
  }

  /**
   * 所有 turn/incident 级 Bark 都从这里出站：
   * 1. 成功发送后才写持久 ledger；
   * 2. 发送失败不占坑，未来重复事实可以再次尝试；
   * 3. 通知永远 detached，不阻塞 Archive 主归档路径。
   */
  const dispatchPersistentNotification = ({
    notificationKey,
    kind,
    conversationId = null,
    turnKey = null,
    payload,
    successLog,
    failureLog,
    logFields = {},
  }) => {
    if (!notificationConfig || !notificationKey || !payload) return false
    if (archive.hasTurnNotification(notificationKey) || notificationInFlight.has(notificationKey)) return false
    notificationInFlight.add(notificationKey)
    void (async () => {
      notificationLastAttemptAt = Date.now()
      const result = await sendIncidentNotification(notificationConfig, payload)
      if (result.ok) {
        archive.markTurnNotificationSent({
          notificationKey,
          kind,
          conversationId,
          turnKey,
          sentAt: Date.now(),
          providerStatus: result.status,
          payload,
        })
        notificationLastSuccessAt = Date.now()
        notificationLastError = null
        await log(successLog, {
          conversationId,
          provider: notificationConfig.provider,
          status: result.status,
          notificationKey,
          kind,
          ...logFields,
        })
      }
      else if (result.attempted) {
        notificationLastError = result.error || 'notification failed'
        await log(failureLog, {
          conversationId,
          provider: notificationConfig.provider,
          status: result.status,
          error: notificationLastError,
          notificationKey,
          kind,
          ...logFields,
        })
      }
    })().catch(async (error) => {
      notificationLastError = error instanceof Error ? error.message : String(error)
      await log(failureLog, {
        conversationId,
        provider: notificationConfig?.provider ?? null,
        error: notificationLastError,
        notificationKey,
        kind,
        ...logFields,
      }).catch(() => {})
    }).finally(() => {
      notificationInFlight.delete(notificationKey)
    })
    return true
  }

  /**
   * 给一个刚刚建立的 canonical Watchdog generation 发送一次“起点收据”。
   *
   * 调用方必须只在 runtime 新建/切换 generation 时调用；daemon startup 恢复 active_watchdogs
   * 的路径故意不调用这里，因此升级或重启不会把旧 generation 全部补发到手机。
   */
  const dispatchWatchdogStartNotification = (conversationId, active, title = null, metadataId = null) => {
    if (!notificationConfig || !conversationId || !active) return false
    const startedAt = Number(active.startedAt || 0)
    // DevSpace generation 在未绑定阶段已经可能发过起点收据。绑定后继续使用同一个
    // metadata+startedAt key，成功过就去重；若未绑定通知此前发送失败，则这里会自然重试。
    const notificationKey = metadataId
      ? unboundWatchdogStartNotificationKey(metadataId, startedAt)
      : watchdogStartNotificationKey(conversationId, startedAt)
    if (!notificationKey) return false
    return dispatchPersistentNotification({
      notificationKey,
      kind: 'watchdog-start',
      conversationId,
      turnKey: `generation:${startedAt}`,
      payload: buildWatchdogStartNotificationPayload({
        conversationId,
        title: watchdogStartTitleForConversation(conversationId, title),
        startedAt,
        watchdogMs,
      }),
      successLog: 'watchdog start notification sent',
      failureLog: 'watchdog start notification failed',
      logFields: {
        startedAt,
        watchdogAt: startedAt + watchdogMs,
        startType: active.startType ?? null,
        metadataId,
      },
    })
  }

  /**
   * metadata 尚未解析出 canonical CID 时也立即发 Watchdog 起点收据。
   * Title 来自 DevSpace init 注册；Title 缺失不是正常分支，payload 会显式标为异常并只在
   * 这种情况下展示短 metadata alias，便于排障。
   */
  const dispatchUnboundWatchdogStartNotification = (metadataId, candidate, title = null) => {
    if (!notificationConfig || !metadataId || !candidate) return false
    const startedAt = Number(candidate.startedAt || 0)
    const notificationKey = unboundWatchdogStartNotificationKey(metadataId, startedAt)
    if (!notificationKey) return false
    return dispatchPersistentNotification({
      notificationKey,
      kind: 'watchdog-start',
      conversationId: null,
      turnKey: `generation:${startedAt}`,
      payload: buildWatchdogStartNotificationPayload({
        metadataId,
        title,
        startedAt,
        watchdogMs,
      }),
      successLog: 'unbound watchdog start notification sent',
      failureLog: 'unbound watchdog start notification failed',
      logFields: {
        metadataId,
        startedAt,
        watchdogAt: startedAt + watchdogMs,
        startType: 'devspace:first-tool-unbound',
        titlePresent: Boolean(String(title || '').trim()),
      },
    })
  }

  const refreshDevSpaceIdleCandidate = (metadataId, now = Date.now(), knownState = null) => {
    const state = knownState ?? devSpaceAuditBridge.metadataToolState(metadataId)
    if (!state || state.runningTools > 0 || !state.latestFinishedAt || !state.lastFinishedAuditId) {
      devSpaceIdleCandidates.delete(metadataId)
      return null
    }
    const binding = archive.getDevSpaceMetadataBinding(metadataId)
    if (binding?.lifecycleState === 'closed') {
      devSpaceIdleCandidates.delete(metadataId)
      return null
    }
    const generationKey = `${state.lastFinishedAuditId}:${state.latestFinishedAt}`
    const previous = devSpaceIdleCandidates.get(metadataId)
    const currentIdleMs = Math.max(0, now - state.latestFinishedAt)
    devSpaceIdleCandidates.set(metadataId, {
      state,
      generationKey,
      // 同 generation 继续累计；新 generation（包括 daemon 启动恢复）从“当前年龄”
      // 开始观察，避免补发早已错过的历史 1/3 分钟通知。
      lastCheckedIdleMs: previous?.generationKey === generationKey
        ? Math.min(previous.lastCheckedIdleMs, currentIdleMs)
        : currentIdleMs,
    })
    return state
  }

  const refreshTrackedDevSpaceIdleCandidates = () => {
    for (const metadataId of [...devSpaceIdleCandidates.keys()]) {
      refreshDevSpaceIdleCandidate(metadataId)
    }
  }

  const checkDevSpaceIdleNotifications = (now = Date.now()) => {
    for (const [metadataId, candidate] of [...devSpaceIdleCandidates.entries()]) {
      const binding = archive.getDevSpaceMetadataBinding(metadataId)
      if (binding?.lifecycleState === 'closed') {
        devSpaceIdleCandidates.delete(metadataId)
        continue
      }
      const currentIdleMs = Math.max(0, now - Number(candidate.state.latestFinishedAt || now))
      const crossed = crossedDevSpaceIdleThresholds(candidate.lastCheckedIdleMs, currentIdleMs)
      candidate.lastCheckedIdleMs = currentIdleMs
      if (crossed.length === 0) continue

      const conversationId = binding?.conversationId || null
      const title = conversationId
        ? conversationTitle(conversationId)
        : candidate.state.title
      for (const thresholdMs of crossed) {
        const notificationKey = [
          'devspace-idle',
          metadataId,
          candidate.state.lastFinishedAuditId,
          thresholdMs,
        ].join(':')
        const queued = dispatchPersistentNotification({
          notificationKey,
          kind: 'devspace-idle',
          conversationId,
          turnKey: binding?.lastTurnExchangeId ?? null,
          payload: buildDevSpaceIdleNotificationPayload({
            conversationId,
            title,
            metadataId,
            thresholdMs,
          }),
          successLog: 'DevSpace idle bug notification sent',
          failureLog: 'DevSpace idle bug notification failed',
          logFields: {
            metadataId,
            thresholdMs,
            idleMs: currentIdleMs,
            bound: Boolean(conversationId),
          },
        })
        if (queued) devSpaceIdleNotificationsQueued += 1

        // 5 分钟软提醒同时触发一次“提前核验”，但它本身仍不是 turn complete 证据。
        // 已绑定 metadata 只读对应 conversation 的 latest body；未绑定 metadata 则复用现有
        // deferred catalog gap-repair，让 list 找近期新增/变化 conversation，再交给 exact
        // tool+args matching 建立 binding。两条路径都继续服从 cooldown / request gate。
        const repairMode = devSpaceIdleRepairMode(thresholdMs, conversationId)
        if (repairMode !== 'none') {
          pendingDevSpaceIdleDiagnoses.set(metadataId, {
            metadataId,
            conversationId,
            title,
            generationKey: candidate.generationKey,
            lastFinishedAuditId: candidate.state.lastFinishedAuditId,
            requestedAt: now,
            repairMode,
          })
        }
        if (repairMode === 'bound-body') {
          // 如果 WSS complete / Watchdog 等更强 trigger 已经排队，不能让这个弱 probe 覆盖它。
          if (!ready.has(conversationId)) {
            markSyncReady(conversationId, 'devspace-idle:bound-probe', 0)
            void log('DevSpace 5m idle queued bound body probe', {
              metadataId,
              conversationId,
              idleMs: currentIdleMs,
            })
          }
          else {
            void log('DevSpace 5m idle bound probe skipped because sync is already queued', {
              metadataId,
              conversationId,
              existingTrigger: ready.get(conversationId),
            })
          }
        }
        else if (repairMode === 'unbound-catalog') {
          void scheduleGapRepair('devspace-idle-unbound-5m')
          void log('DevSpace 5m idle queued unbound catalog gap repair', {
            metadataId,
            idleMs: currentIdleMs,
          })
        }
      }
    }
  }

  const devSpaceRecoveryCountsForMetadata = (metadataId) => {
    const row = archive.db.prepare(`
      SELECT COUNT(*) AS n,
             SUM(CASE WHEN tool='checkpoint' THEN 1 ELSE 0 END) AS checkpoints
      FROM devspace_recovery_audits
      WHERE metadata_id=? AND superseded_at IS NULL
    `).get(metadataId)
    const recoveryAuditCount = Math.max(0, Number(row?.n || 0))
    const checkpointCount = Math.max(0, Number(row?.checkpoints || 0))
    return {
      recoveryAuditCount,
      checkpointCount,
      recoveryToolCount: Math.max(0, recoveryAuditCount - checkpointCount),
    }
  }

  /**
   * 一个 canonical body sync 成功后，消费所有已经绑定到该 conversation 的 5 分钟诊断。
   * 这里故意不要求 trigger 必须是 devspace-idle：如果 WSS complete / Watchdog 已经排了更强 sync，
   * 直接复用那次 body 结果即可，既保证“扫完必报”，也避免重复请求。
   */
  const completePendingDevSpaceIdleDiagnoses = (conversationId, result, now = Date.now()) => {
    const matches = []
    for (const [metadataId, pending] of pendingDevSpaceIdleDiagnoses) {
      const binding = archive.getDevSpaceMetadataBinding(metadataId)
      const boundConversationId = binding?.conversationId || pending.conversationId || null
      if (boundConversationId !== conversationId) continue
      matches.push([metadataId, pending])
    }
    if (matches.length === 0) return []

    const completed = []
    for (const [metadataId, pending] of matches) {
      const diagnostic = result.diagnostic
      const tailGap = archive.describeDevSpaceTailGap({
        conversationId,
        turnExchangeId: diagnostic.turnExchangeId ?? null,
        lastMessageId: diagnostic.lastMessageId ?? null,
        metadataId,
        bodyCompletionEvidence: diagnostic.bodyCompletionEvidence ?? null,
        minGapMs: 5_000,
      })

      let evidenceIncident = null
      if (tailGap.hasTailGap) {
        const reason = [
          `canonical Body 尾部落后于 DevSpace 执行事实 ${formatDurationMs(tailGap.gapMs)}`,
          `Body tail=${diagnostic.tailShape || 'unknown'} / completion=${diagnostic.bodyCompletionEvidence || 'none'}`,
          `尾部之后仍有 ${tailGap.recoveryAuditCount} 条 recovery audit（tool ${tailGap.recoveryToolCount} / checkpoint ${tailGap.checkpointCount}）`,
        ].join('；')
        evidenceIncident = archive.ensureIncidentForEvidence({
          conversationId,
          diagnostic,
          observedAt: now,
          source: 'devspace-idle:canonical-tail-gap',
          reason,
        })
        if (evidenceIncident) {
          archive.attachCanonicalTailGapEvidence({
            conversationId,
            turnExchangeId: diagnostic.turnExchangeId ?? null,
            turnKey: evidenceIncident.turnKey,
            lastMessageId: diagnostic.lastMessageId ?? null,
            metadataId,
            bodyCompletionEvidence: diagnostic.bodyCompletionEvidence ?? null,
            observedAt: now,
          })
        }
      }

      const conversation = archive.db.prepare(
        'SELECT title, message_count AS messageCount FROM conversations WHERE id=?',
      ).get(conversationId)
      const queued = dispatchPersistentNotification({
        notificationKey: `devspace-idle-diagnosis:${metadataId}:${pending.lastFinishedAuditId}`,
        kind: tailGap.hasTailGap ? 'devspace-idle-diagnosis:canonical-tail-gap' : 'devspace-idle-diagnosis',
        conversationId,
        turnKey: diagnostic.turnExchangeId ?? diagnostic.userMessageId ?? diagnostic.lastMessageId ?? null,
        payload: buildDevSpaceIdleDiagnosisNotificationPayload({
          conversationId,
          title: conversation?.title || pending.title || conversationId,
          diagnostic,
          tailGap,
          canonicalMessageCount: conversation?.messageCount ?? null,
        }),
        successLog: 'DevSpace 5m idle diagnosis notification sent',
        failureLog: 'DevSpace 5m idle diagnosis notification failed',
        logFields: {
          metadataId,
          canonicalTailGap: tailGap.hasTailGap,
          gapMs: tailGap.gapMs,
          recoveryAuditCount: tailGap.recoveryAuditCount,
          incidentId: evidenceIncident?.id ?? null,
        },
      })
      if (queued) devSpaceIdleDiagnosisNotificationsQueued += 1
      pendingDevSpaceIdleDiagnoses.delete(metadataId)
      completed.push({ metadataId, tailGap, incident: evidenceIncident })
      void log('DevSpace 5m idle diagnosis completed', {
        metadataId,
        conversationId,
        bodyCompletion: diagnostic.bodyCompletionEvidence,
        tail: diagnostic.tailShape,
        canonicalTailGap: tailGap.hasTailGap,
        gapMs: tailGap.gapMs,
        recoveryAuditCount: tailGap.recoveryAuditCount,
        notificationQueued: queued,
      })
    }
    return completed
  }

  /** gap-repair 结束后仍未绑定时也必须给一条“扫描完成但无法对账”的结果。 */
  const completeUnboundDevSpaceIdleDiagnoses = () => {
    if (syncInFlight || reconcileInFlight || ready.size > 0 || hasPendingDevSpaceBindingWork()) return
    for (const [metadataId, pending] of [...pendingDevSpaceIdleDiagnoses.entries()]) {
      if (pending.repairMode !== 'unbound-catalog') continue
      if (!pending.catalogRepairCompletedAt) continue
      const binding = archive.getDevSpaceMetadataBinding(metadataId)
      if (binding?.conversationId) {
        pending.conversationId = binding.conversationId
        pending.repairMode = 'bound-body'
        // catalog repair 可能已经为同一 conversation 排了更强 sync；有就复用，没有才补 body probe。
        if (!ready.has(binding.conversationId)) {
          markSyncReady(binding.conversationId, 'devspace-idle:bound-probe', 0)
        }
        continue
      }
      const counts = devSpaceRecoveryCountsForMetadata(metadataId)
      const queued = dispatchPersistentNotification({
        notificationKey: `devspace-idle-diagnosis:${metadataId}:${pending.lastFinishedAuditId}`,
        kind: 'devspace-idle-diagnosis:unbound',
        conversationId: null,
        turnKey: null,
        payload: buildDevSpaceIdleUnboundDiagnosisNotificationPayload({
          metadataId,
          title: pending.title,
          ...counts,
        }),
        successLog: 'DevSpace 5m unbound diagnosis notification sent',
        failureLog: 'DevSpace 5m unbound diagnosis notification failed',
        logFields: { metadataId, ...counts },
      })
      if (queued) devSpaceIdleDiagnosisNotificationsQueued += 1
      pendingDevSpaceIdleDiagnoses.delete(metadataId)
      void log('DevSpace 5m idle diagnosis completed without canonical binding', {
        metadataId,
        notificationQueued: queued,
        ...counts,
      })
    }
  }

  const completeUnboundWatchdogDiagnoses = () => {
    if (syncInFlight || reconcileInFlight || ready.size > 0 || hasPendingDevSpaceBindingWork()) return
    for (const [metadataId, pending] of [...pendingUnboundWatchdogDiagnoses.entries()]) {
      if (!pending.catalogRepairCompletedAt) continue

      const binding = archive.getDevSpaceMetadataBinding(metadataId)
      if (binding?.conversationId) {
        pendingUnboundWatchdogDiagnoses.delete(metadataId)
        flushDeferredCatalogWatchdogCandidates('unbound-watchdog-binding-resolved')
        if (!ready.has(binding.conversationId)) {
          markSyncReady(binding.conversationId, 'watchdog:devspace-timeout', 0)
        }
        void log('unbound watchdog catalog repair resolved canonical binding; queued body diagnosis', {
          metadataId,
          conversationId: binding.conversationId,
        })
        continue
      }

      const counts = devSpaceRecoveryCountsForMetadata(metadataId)
      const title = pending.title
        ?? devSpaceAuditBridge.metadataToolState(metadataId)?.title
        ?? binding?.displayTitle
        ?? null
      const notificationKey = unboundWatchdogDiagnosisNotificationKey(metadataId, pending.startedAt)
      const alreadySent = archive.hasTurnNotification(notificationKey)
      const queued = alreadySent ? false : dispatchPersistentNotification({
        notificationKey,
        kind: 'watchdog-diagnosis:unbound',
        conversationId: null,
        turnKey: metadataId,
        payload: buildUnboundWatchdogDiagnosisNotificationPayload({
          metadataId,
          title,
          ...counts,
        }),
        successLog: 'unbound watchdog diagnosis notification sent',
        failureLog: 'unbound watchdog diagnosis notification failed',
        logFields: { metadataId, ...counts },
      })
      if (queued) unboundWatchdogDiagnosisNotificationsQueued += 1

      enqueueLifeOpsEvent({
        sourceEventId: unboundWatchdogLifeOpsEventId(metadataId, pending.startedAt),
        metadataId,
        conversationId: null,
        turnExchangeId: null,
        title,
        runState: 'aborted',
        reviewState: 'unread',
        updatedAt: new Date(pending.catalogRepairCompletedAt || Date.now()).toISOString(),
        inboxKind: 'incident',
        inboxHealth: 'incident',
        incidentType: 'active-zombie-unbound',
        incidentState: 'unbound-unresolved-no-canonical-body',
        metadata: {
          provisionalStartedAt: pending.startedAt,
          watchdogAt: pending.watchdogAt,
          catalogRepairCompletedAt: pending.catalogRepairCompletedAt,
          canonicalBodyAvailable: false,
          ...counts,
        },
      })

      // 成功发送后的 notification ledger 是跨重启 completion marker。
      // 失败时不清 pending，下一轮可以继续重试；LifeOps 则已经有明确终态分类。
      if (alreadySent) {
        pendingUnboundWatchdogDiagnoses.delete(metadataId)
        flushDeferredCatalogWatchdogCandidates('unbound-watchdog-diagnosis-resolved')
        void log('unbound watchdog diagnosis completed without canonical binding', {
          metadataId,
          notificationQueued: false,
          notificationAlreadySent: true,
          ...counts,
        })
      }
      else if (queued) {
        void log('unbound watchdog terminal diagnosis queued without canonical binding', {
          metadataId,
          notificationQueued: true,
          ...counts,
        })
      }
    }
  }

  /**
   * 阶段 checkpoint / legacy conclusion 都立即旁路 Bark，但二者语义分开：
   * - checkpoint：新版独立工具，应该代表真正阶段进展；
   * - conclusion：旧 schema 兼容，仅为历史/缓存会话继续可见，不再鼓励新模型使用。
   */
  const dispatchDevSpaceProgressNotification = (event) => {
    if (!notificationConfig || !event?.id || !event?.metadataId) return false
    const checkpoint = event.tool === 'checkpoint' ? extractDevSpaceCheckpoint(event.argsJson) : null
    const legacyConclusion = checkpoint ? null : extractDevSpaceConclusion(event.argsJson)
    if (!checkpoint && !legacyConclusion) return false

    const binding = archive.getDevSpaceMetadataBinding(event.metadataId)
    const conversationId = binding?.conversationId || null
    const metadataState = conversationId ? null : devSpaceAuditBridge.metadataToolState(event.metadataId)
    const title = conversationId
      ? conversationTitle(conversationId)
      : binding?.displayTitle ?? metadataState?.title ?? null
    const isCheckpoint = Boolean(checkpoint)

    return dispatchPersistentNotification({
      notificationKey: `${isCheckpoint ? 'devspace-checkpoint' : 'devspace-conclusion'}:${event.id}`,
      kind: isCheckpoint ? 'devspace-checkpoint' : 'devspace-conclusion',
      conversationId,
      turnKey: binding?.lastTurnExchangeId ?? null,
      payload: isCheckpoint
        ? buildDevSpaceCheckpointNotificationPayload({
            conversationId,
            title,
            metadataId: event.metadataId,
            summary: checkpoint.summary,
            next: checkpoint.next,
          })
        : buildDevSpaceConclusionNotificationPayload({
            conversationId,
            title,
            metadataId: event.metadataId,
            tool: event.tool,
            conclusion: legacyConclusion,
          }),
      successLog: isCheckpoint
        ? 'DevSpace checkpoint notification sent'
        : 'DevSpace conclusion notification sent',
      failureLog: isCheckpoint
        ? 'DevSpace checkpoint notification failed'
        : 'DevSpace conclusion notification failed',
      logFields: {
        metadataId: event.metadataId,
        auditId: event.id,
        tool: event.tool,
        bound: Boolean(conversationId),
        checkpoint: isCheckpoint,
      },
    })
  }

  /**
   * 把 DevSpace audit 镜像为 provisional recovery 事实。
   *
   * 已绑定 metadata 直接写 canonical CID；未绑定 metadata 立即写稳定 synthetic conversation，
   * 这样 DevSpace 的先发事实不需要等 Body/WSS/Watchdog。后续可靠 binding 到达时会原位迁移。
   */
  const persistDevSpaceRecoveryAudit = async (event, bindingOverride = null) => {
    if (!event?.id || !event?.metadataId || !event?.tool) return false
    const profileStartedAt = performance.now()
    let phaseStartedAt = profileStartedAt
    const binding = bindingOverride ?? archive.getDevSpaceMetadataBinding(event.metadataId)
    const bindingReadMs = performance.now() - phaseStartedAt
    phaseStartedAt = performance.now()
    const toolFingerprint = devSpaceToolArgsFingerprint(event.tool, event.argsJson)
    if (!toolFingerprint) return false
    const fingerprintMs = performance.now() - phaseStartedAt
    const finishedAt = event.finishedAt ? Date.parse(event.finishedAt) : null
    const conversationId = binding?.conversationId
      || devSpaceVirtualConversationId(event.metadataId)
    const mainThreadPrepareMs = performance.now() - profileStartedAt
    phaseStartedAt = performance.now()
    const recoveryAuditInput = {
      auditId: event.id,
      conversationId,
      metadataId: event.metadataId,
      tool: event.tool,
      toolFingerprint,
      argsJson: event.argsJson,
      resultJson: event.resultJson ?? null,
      error: event.error ?? null,
      conclusion: extractDevSpaceConclusion(event.argsJson),
      startedAt: event.startedAtMs,
      finishedAt: Number.isFinite(finishedAt) ? finishedAt : null,
      observedAt: Date.now(),
    }
    await retryTransientSqliteBusy(
      () => archiveMergeWorker.upsertRecoveryAudit(recoveryAuditInput),
      { attempts: 3, delayMs: 100 },
    )
    const workerRoundTripMs = performance.now() - phaseStartedAt
    const totalMs = performance.now() - profileStartedAt
    if (mainThreadPrepareMs >= 50) {
      void log('slow Archive control-plane DB profile', {
        operation: 'devspace-recovery-upsert-prepare',
        totalMs: mainThreadPrepareMs,
        bindingReadMs,
        fingerprintMs,
        metadataId: event.metadataId,
        auditId: event.id,
        bound: Boolean(binding?.conversationId),
      })
    }
    if (workerRoundTripMs >= 50) {
      void log('slow Archive writer worker job', {
        operation: 'devspace-recovery-upsert',
        totalMs,
        mainThreadPrepareMs,
        workerRoundTripMs,
        bindingReadMs,
        fingerprintMs,
        metadataId: event.metadataId,
        auditId: event.id,
        bound: Boolean(binding?.conversationId),
      })
    }
    return true
  }

  /** finish 门铃到达时按 audit id 重读最终行，覆盖 start 阶段只有 args/started_at 的 provisional。 */
  const refreshDevSpaceRecoveryAudit = async (auditId) => {
    const event = devSpaceAuditBridge.auditById(auditId)
    return event ? await persistDevSpaceRecoveryAudit(event) : false
  }

  /** binding 晚到时只补 exact-match 附近的局部 audit 窗口，避免历史全库重扫。 */
  const backfillDevSpaceRecoveryForBinding = async (binding, startAt, observedAt) => {
    if (!binding?.conversationId || !binding?.metadataId) return 0
    const windowStart = Math.max(0, Number(startAt || observedAt || Date.now()) - 2 * 60_000)
    const windowEnd = Math.max(windowStart, Number(observedAt || Date.now()) + 2 * 60_000)
    const audits = devSpaceAuditBridge.auditsForMetadata(
      binding.metadataId,
      windowStart,
      windowEnd,
      1000,
    )
    let mirrored = 0
    for (const event of audits) {
      if (await persistDevSpaceRecoveryAudit(event, binding)) mirrored += 1
    }
    return mirrored
  }

  /**
   * first-party body 到达后，用本次内存里的 canonical messages 淘汰 provisional。
   *
   * 旧实现先把 Body merge 进 SQLite，再根据该 conversation 所有未 supersede recovery 的全历史
   * min/max 去回扫 messages。生产里 recovery backlog 可跨数天，导致一次 latest Body 实际扫描
   * 上千 tool/assistant rows；还会为了只算 min/max 把 result_json/args_json 全读进 Node。
   *
   * 这里直接复用同一份 first-party payload：匹配规则仍由现有 supersede* 方法负责，只改变 canonical
   * 证据来源。先用 payload 的时间范围确认附近确有 active recovery；没有就 O(1) 退出。
   */
  const reconcileDevSpaceRecoveryWithCanonical = (conversationId, payload) => runControlPlaneStage(
    'devspace-recovery-reconcile',
    () => {
    const canonical = adaptConversation(payload)
    const timestamped = canonical.messages.filter(message => Number.isFinite(message.createTime))
    if (timestamped.length === 0) return 0
    const messageTimes = timestamped.map(message => Number(message.createTime) * 1000)
    const minAt = Math.max(0, Math.min(...messageTimes) - 120_000)
    const maxAt = Math.max(...messageTimes) + 120_000
    const activeNearby = archive.db.prepare(`
      SELECT 1 AS ok
      FROM devspace_recovery_audits
      WHERE conversation_id = ?
        AND superseded_at IS NULL
        AND started_at BETWEEN ? AND ?
      LIMIT 1
    `).get(conversationId, minAt, maxAt)
    if (!activeNearby) return 0

    let superseded = 0
    for (const message of canonical.messages) {
      if (message.recipient !== 'api_tool.call_tool') continue
      if (!Number.isFinite(message.createTime) || !message.text) continue
      const startedAt = Number(message.createTime) * 1000
      const call = parseDevSpaceBodyToolCall(message.text, startedAt)
      if (!call) continue
      // checkpoint 的 provisional assistant 语义不能仅因为 canonical tool-call 到达就消失；
      // 它要等真正 assistant commentary 明确复述 summary 才覆盖。
      if (call.tool === 'checkpoint') continue
      const toolFingerprint = devSpaceToolArgsFingerprint(call.tool, call.argsJson)
      if (!toolFingerprint) continue
      const matchedAuditId = archive.supersedeDevSpaceRecoveryAudit({
        conversationId,
        toolFingerprint,
        canonicalStartedAt: call.startedAtMs,
        canonicalMessageId: message.id,
        observedAt: Date.now(),
      })
      if (matchedAuditId) superseded += 1
    }

    const hasCheckpointNearby = archive.db.prepare(`
      SELECT 1 AS ok
      FROM devspace_recovery_audits
      WHERE conversation_id = ?
        AND tool = 'checkpoint'
        AND superseded_at IS NULL
        AND started_at BETWEEN ? AND ?
      LIMIT 1
    `).get(conversationId, minAt, maxAt)
    if (!hasCheckpointNearby) return superseded

    for (const message of canonical.messages) {
      if (message.role !== 'assistant' || message.hidden || !message.text || message.channel === 'analysis') continue
      if (!Number.isFinite(message.createTime)) continue
      const assistantStartedAt = Number(message.createTime) * 1000
      const matchedCheckpointId = archive.supersedeDevSpaceCheckpointFromAssistant({
        conversationId,
        assistantText: message.text,
        assistantStartedAt,
        canonicalMessageId: message.id,
        observedAt: Date.now(),
      })
      if (matchedCheckpointId) superseded += 1
    }
      return superseded
    },
  )

  const notifyActorDomDrift = ({ phase, result, details }) => {
    if (!result?.signature || !result?.shape) return false
    const body = [
      `页面：${result.shape.routeKind}`,
      `阶段：${phase}`,
      ...(details || []).map(detail => `• ${detail}`),
      '影响：Actor 已 fail-closed，本次不会继续导航/输入/发送；需要确认新版 DOM 后再 approve。',
    ].join('\n')
    return dispatchPersistentNotification({
      notificationKey: `dom-drift:${result.signature}`,
      kind: 'dom-drift',
      payload: {
        title: 'ChatGPT DOM 漂移：Actor 已安全阻断',
        body,
        group: BARK_NOTIFICATION_GROUPS.archiveWarning,
      },
      successLog: 'DOM drift notification sent',
      failureLog: 'DOM drift notification failed',
      logFields: {
        phase,
        routeKind: result.shape.routeKind,
        signature: result.signature,
      },
    })
  }

  /**
   * Actor submission queue 的失败尝试属于“发起新 turn 之前/期间”的基础设施事件，
   * 它不一定拥有 conversationId，因此不能硬塞进 conversation incident taxonomy。
   *
   * 这里采用两级策略：
   * 1. 真正 terminal failed：立即提醒；
   * 2. 已确认是 Project/sidebar 瞬态不可见：第一次进入 retry_waiting 就提醒一次，
   *    因为它会直接延迟 ClassFlow Notes，且历史上已实际造成静默漏发。
   *
   * 其他普通网络瞬态重试不在第一次就 Bark，避免短抖动制造噪声；DOM drift 仍由上面的
   * 专用通知负责，防止同一个漂移事件重复提醒。
   */
  const notifyActorSubmissionAttemptError = (record) => {
    const status = String(record?.status || '')
    const error = String(record?.lastError || '').trim()
    const idempotencyKey = String(record?.idempotencyKey || '').trim()
    const submissionId = String(record?.id || '').trim()
    const attemptCount = Number(record?.attemptCount || 0)
    const projectVisibilityRetry = status === 'retry_waiting'
      && attemptCount === 1
      && /project not found or not visible in sidebar/iu.test(error)
    const terminalFailure = status === 'failed'
    if (!submissionId || !error || (!terminalFailure && !projectVisibilityRetry)) return false

    const source = idempotencyKey.startsWith('classflow:')
      ? 'ClassFlow Notes'
      : (idempotencyKey || '未命名 submission')
    const title = terminalFailure
      ? 'Archive Actor 提交失败'
      : 'Archive Actor：Project 暂未就绪，已自动重试'
    const body = [
      `来源：${source}`,
      `尝试次数：${attemptCount}`,
      `状态：${status}`,
      `原因：${error}`,
      projectVisibilityRetry
        ? '本次失败发生在正式提交前；队列已保留任务并按退避策略自动重试。'
        : '任务已停止自动提交，需要检查持久化 submission 记录后决定恢复方式。',
    ].join('\n')

    return dispatchPersistentNotification({
      notificationKey: `actor-submission:${terminalFailure ? 'failed' : 'project-retry'}:${submissionId}`,
      kind: terminalFailure ? 'actor-submission-failed' : 'actor-submission-project-retry',
      conversationId: record?.input?.conversationId ?? null,
      turnKey: submissionId,
      payload: {
        title,
        body,
        group: BARK_NOTIFICATION_GROUPS.archiveWarning,
      },
      successLog: 'actor submission error notification sent',
      failureLog: 'actor submission error notification failed',
      logFields: {
        submissionId,
        idempotencyKey,
        status,
        attemptCount,
      },
    })
  }

  /**
   * HTTP protocol drift 不再等每天 12:00 批处理。真正 actionable 的语义 drift 在第二次稳定出现
   * （或第一次就已经是 critical）时进入这个 10 秒聚合窗口，然后立即 Bark。
   *
   * 10 秒只用于把同一轮页面自然产生的 catalog/body/mapping 连续变化合成一条可读通知，
   * 不是“定时日报”；没有新 drift 就完全没有任务/请求。
   */
  const flushProtocolDriftNotifications = async () => {
    protocolDriftNotifyTimer = null
    if (!notificationConfig || protocolDriftPending.size === 0) return

    const queued = dedupeProtocolAssessments([...protocolDriftPending.values()]
      .map(assessment => ({ assessment })))
      .map(item => item.assessment)
      .filter(assessment => !archive.hasTurnNotification(`protocol-drift:${assessment.dedupeKey}`))
    protocolDriftPending.clear()
    if (queued.length === 0) return

    const keys = queued.map(assessment => `protocol-drift:${assessment.dedupeKey}`)
    if (keys.some(key => notificationInFlight.has(key))) return
    for (const key of keys) notificationInFlight.add(key)

    const critical = queued.filter(item => item.severity === 'critical').length
    const warning = queued.filter(item => item.severity === 'warning').length
    const shown = queued.slice(0, 4)
    const body = shown.map(formatProtocolDriftAssessment).join('\n\n')
      + (queued.length > shown.length ? `\n\n另有 ${queued.length - shown.length} 项语义漂移已合并。` : '')
    const title = critical > 0
      ? `ChatGPT 协议严重漂移 ${critical} 项${warning > 0 ? ` / 警告 ${warning} 项` : ''}`
      : `ChatGPT 协议漂移警告 ${warning} 项`

    notificationLastAttemptAt = Date.now()
    const payload = {
      title,
      body,
      group: BARK_NOTIFICATION_GROUPS.archiveWarning,
    }
    try {
      const result = await sendIncidentNotification(notificationConfig, payload)
      if (result.ok) {
        const sentAt = Date.now()
        for (const assessment of queued) {
          archive.markTurnNotificationSent({
            notificationKey: `protocol-drift:${assessment.dedupeKey}`,
            kind: 'protocol-drift',
            sentAt,
            providerStatus: result.status,
            payload: { ...payload, assessment },
          })
        }
        notificationLastSuccessAt = sentAt
        notificationLastError = null
        await log('protocol drift notification sent', {
          provider: notificationConfig.provider,
          status: result.status,
          critical,
          warning,
          semanticKeys: queued.map(item => item.dedupeKey),
        })
      }
      else if (result.attempted) {
        notificationLastError = result.error || 'protocol drift notification failed'
        await log('protocol drift notification failed', {
          provider: notificationConfig.provider,
          status: result.status,
          error: notificationLastError,
          semanticKeys: queued.map(item => item.dedupeKey),
        })
      }
    }
    catch (error) {
      notificationLastError = error instanceof Error ? error.message : String(error)
      await log('protocol drift notification branch failed', {
        error: notificationLastError,
        semanticKeys: queued.map(item => item.dedupeKey),
      }).catch(() => {})
    }
    finally {
      for (const key of keys) notificationInFlight.delete(key)
    }
  }

  const queueProtocolDriftNotification = (assessment) => {
    if (!assessment?.notify || !notificationConfig) return false
    const notificationKey = `protocol-drift:${assessment.dedupeKey}`
    if (archive.hasTurnNotification(notificationKey) || notificationInFlight.has(notificationKey)) return false
    const existing = protocolDriftPending.get(assessment.dedupeKey)
    if (!existing || assessment.count >= existing.count) protocolDriftPending.set(assessment.dedupeKey, assessment)
    if (!protocolDriftNotifyTimer) {
      protocolDriftNotifyTimer = setTimeout(() => {
        void flushProtocolDriftNotifications()
      }, 10_000)
    }
    return true
  }

  const scheduleProtocolLedgerFlush = () => {
    if (!protocolLedger || protocolFlushTimer) return
    protocolFlushTimer = setTimeout(() => {
      protocolFlushTimer = null
      void protocolLedger.flush().catch(async (error) => {
        await log('protocol drift ledger flush failed', {
          error: error instanceof Error ? error.message : String(error),
        }).catch(() => {})
      })
    }, 2000)
  }

  const relativeBackendUrl = (input) => {
    try {
      const url = new URL(String(input || ''), 'https://chatgpt.com')
      return url.pathname + url.search
    }
    catch { return String(input || '') }
  }

  const observeProtocolRequest = (request, sourceKind, targetId, observedAt = Date.now()) => {
    if (!protocolLedger || !String(request?.url || '').includes('/backend-api/')) return null
    const result = protocolLedger.observeRequest({
      url: request.url,
      method: request.method,
      headers: request.headers,
      postData: request.postData,
      sourceKind,
      targetId,
      observedAt,
    })
    if (!result) return null
    if (result.isNew) {
      void log(result.pending ? 'protocol request drift observed' : 'protocol request baseline learned', {
        signature: result.signature,
        sourceKind,
        candidateFamily: result.candidate.family,
        candidateEligible: result.candidate.eligible,
      })
    }
    // 新语义 drift 第一次通常只是 info；第二次稳定复现时 count===2 才升级 warning。
    // 已存在的历史 variant 在 daemon 重启后不会被重新通知，避免部署新分类器后把旧账一次轰出来。
    // 与 baseline 正交地检查“当前第一方 header 是否已超出生产 replay 捕获白名单”。
    // 这专门补 2026-10-07 暴露出的 bootstrap 漏洞：上游变化可能早于 monitor 安装。
    const productionCoverage = protocolLedger.assessProductionHeaderCoverage(
      result.signature,
      CAPTURED_HEADER_ALLOWLIST,
    )
    if (result.assessment?.notify && (result.isNew || result.assessment.count === 2)) {
      // 正常 post-baseline 漂移优先使用更完整的 baseline diff；不要再为同一个新增 header
      // 额外发一条“生产 allowlist 未覆盖”的重复通知。
      queueProtocolDriftNotification(result.assessment)
    }
    else if (productionCoverage?.notify && productionCoverage.count === 2) {
      queueProtocolDriftNotification(productionCoverage)
    }
    scheduleProtocolLedgerFlush()
    return result.signature
  }

  const observeProtocolResponse = (requestSignature, response, observedAt = Date.now()) => {
    if (!protocolLedger || !requestSignature) return
    const result = protocolLedger.observeResponse(requestSignature, {
      status: response?.status,
      contentType: response?.contentType ?? response?.mimeType ?? null,
      body: response?.body,
      observedAt,
    })
    if (result?.isNew) {
      void log(result.pending ? 'protocol response drift observed' : 'protocol response baseline learned', {
        requestSignature,
        responseSignature: result.signature,
      })
    }
    if (result?.assessment?.notify && (result.isNew || result.assessment.count === 2)) {
      queueProtocolDriftNotification(result.assessment)
    }
    scheduleProtocolLedgerFlush()
  }

  if (cooldownUntil > Date.now()) {
    await log('active API cooldown restored from previous daemon state', { cooldownUntil })
  }

  const state = () => ({
    pid: process.pid,
    startedAt: startedAt,
    updatedAt: Date.now(),
    startupPhase: guardian ? 'running' : 'initializing',
    database: dbPath,
    evidence: {
      enabled: externalEvidenceEnabled,
      legacyFallbacks: evidenceLegacyFallbacks,
      ...evidenceStore.stats(),
    },
    turnTrace: turnTracePath,
    cdp: cdpHttp,
    controlPlane: {
      tickMs: CONTROL_PLANE_TICK_MS,
      eventLoopLagLastMs: controlPlaneLagLastMs,
      eventLoopLagMaxMs: controlPlaneLagMaxMs,
      eventLoopLagOver100Ms: controlPlaneLagOver100Ms,
      eventLoopLagOver1000Ms: controlPlaneLagOver1000Ms,
      stage: controlPlaneStage,
      recentSlowLags: controlPlaneRecentSlowLags.slice(-40),
      maintenanceLane: {
        inFlight: maintenanceLaneInFlight,
        scheduled: maintenanceLaneScheduled,
        runs: maintenanceLaneRuns,
        lastMs: Math.round(maintenanceLaneLastMs * 100) / 100,
        maxMs: Math.round(maintenanceLaneMaxMs * 100) / 100,
        lastStep: maintenanceLaneLastStep,
        lastError: maintenanceLaneLastError,
      },
      mergeWorker: archiveMergeWorker.stats(),
    },
    bridge: {
      enabled: bridgeEnabled,
      listening: archiveBridge?.listening ?? false,
      host: bridgeHost,
      port: archiveBridge?.port ?? bridgePort,
      clients: archiveBridge?.clientCount ?? 0,
      startedAt: archiveBridgeStartedAt,
      authPath: bridgeAuthPath,
      lastError: archiveBridgeLastError,
    },
    lifeOpsSync: {
      enabled: Boolean(lifeOpsSync),
      configPath: lifeOpsSyncConfigPath,
      pendingPath: lifeOpsSyncPendingPath,
      pendingCount: lifeOpsSync?.pendingCount ?? 0,
      lastError: lifeOpsSyncLastError,
    },
    guardian: guardian ? {
      targetId: guardian.targetId,
      windowId: guardian.windowId,
      browser: guardian.version?.Browser ?? null,
      pageClosed: guardian.page?.closed ?? true,
      nativeWindow: guardian.nativeWindow ?? null,
      healthFailures: guardianHealthFailures,
      lastCdpFailureScope: guardianLastCdpFailureScope,
      lastBrowserPingMs: guardianLastBrowserPingMs,
      rebuilds: guardianRebuilds,
      uiFailure: guardianUiFailure,
      uiReloadAttemptedAt: guardianUiReloadAttemptedAt,
    } : null,
    wss: {
      activeSockets: activeSocketIds.size,
      lastCreatedAt: lastWssCreatedAt,
      lastClosedAt: lastWssClosedAt,
      lastFrameAt: lastWssFrameAt,
      lastControlAt: lastWssControlAt,
      lastEventAt: lastWssEventAt,
      gapStartedAt: wssGapStartedAt,
      lastReconnectDelayMs: lastWssReconnectDelayMs,
      reconnectGraceMs: wssReconnectGraceMs,
      eventCounts: Object.fromEntries(eventCounts),
      eventTopicCounts: Object.fromEntries(eventTopicCounts),
      generation: wssGeneration,
      conversationTransport: {
        requestId: conversationTransportRequestId,
        lastRequestId: lastConversationTransportRequestId,
        generation: conversationTransportGeneration,
        observedInGuardian: conversationTransportObservedInGuardian,
        lastChangedAt: lastConversationTransportChangedAt,
        lastClosedAt: lastConversationTransportClosedAt,
      },
      sentFrames: wssSentFrames,
      receivedFrames: wssReceivedFrames,
      parsedEventFrames: wssParsedEventFrames,
      unparsedConversationFrames: wssUnparsedConversationFrames,
      subscribedTopics: [...subscribedTopics].sort(),
      explicitSubscribedTopics: [...subscribedTopics].sort(),
      observedMessageTopics: [...observedMessageTopics].sort(),
      observedConversationEventTypes: [...observedConversationEventTypes].sort(),
      conversationSubscriptionRecovered,
      lastControls: lastSafeWssControls,
      sockets: [...wssSocketTelemetry.values()]
        .map(socket => ({
          requestId: socket.requestId,
          generation: socket.generation,
          createdAt: socket.createdAt,
          ageMs: Math.max(0, Date.now() - Number(socket.createdAt || Date.now())),
          sentSubscribedTopics: [...socket.sentSubscribedTopics].sort(),
          acknowledgedTopics: [...socket.acknowledgedTopics].sort(),
          recoveredByTopic: Object.fromEntries([...socket.recoveredByTopic.entries()].sort(([a], [b]) => a.localeCompare(b))),
          observedMessageTopics: [...socket.observedMessageTopics].sort(),
          controlFrames: socket.controlFrames,
        }))
        .sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0)),
      recentSocketLifecycles: recentWssSocketLifecycles,
    },
    liveTransport: {
      active: activeLiveTransports.size,
      journal: {
        rootDir: liveSseDir,
        started: liveSseJournalStarted,
        finalized: liveSseJournalFinalized,
        bytes: liveSseJournalBytes,
        errors: liveSseJournalErrors,
      },
      canonical: {
        promoted: liveSseCanonicalPromoted,
        fallbacks: liveSseCanonicalFallbacks,
        partialEvidenceMerged: liveSsePartialEvidenceMerged,
        partialMessagesMerged: liveSsePartialMessagesMerged,
        bodyRefreshesSkipped: liveSseBodyRefreshesSkipped,
        satisfiedConversations: liveSseCanonicalSatisfied.size,
      },
      streams: [...activeLiveTransports.values()]
        .sort((a, b) => Number(a.startedAt || 0) - Number(b.startedAt || 0))
        .slice(-32),
    },
    checkpointRefresh: {
      enabled: checkpointPollingEnabled,
      active: checkpointWatches.size,
      inFlight: checkpointInFlight,
      probes: checkpointProbes,
      bodyRefreshes: checkpointBodyRefreshes,
      errors: checkpointErrors,
      completed: checkpointCompleted,
      watches: [...checkpointWatches.values()]
        .sort((a, b) => Number(a.startedAt || 0) - Number(b.startedAt || 0))
        .map(watch => ({
          ...watch,
          turnTraceBound: checkpointTurnContexts.has(watch.conversationId),
        }))
        .slice(-32),
    },
    devspace: {
      dbPath: devSpaceDbPath,
      wake: devSpaceAuditWakeListener.stats(),
      fallbackPollMs: DEVSPACE_FALLBACK_POLL_MS,
      auditCursor: devSpaceAuditCursor,
      auditCursorBootstrapped: devSpaceAuditCursorBootstrapped,
      lastPollAt: devSpaceLastPollAt,
      lastAuditAt: devSpaceLastAuditAt,
      lastError: devSpaceLastError,
      auditsObserved: devSpaceAuditsObserved,
      auditConsumer: {
        batchSize: DEVSPACE_AUDIT_BATCH_SIZE,
        inFlight: devSpaceAuditPollInFlight,
        continuationScheduled: devSpaceAuditPollScheduled,
        batches: devSpaceAuditPollBatches,
        yields: devSpaceAuditPollYields,
        lastBatchCount: devSpaceAuditLastBatchCount,
        lastBatchMs: Math.round(devSpaceAuditLastBatchMs * 100) / 100,
        maxBatchMs: Math.round(devSpaceAuditMaxBatchMs * 100) / 100,
      },
      bindingsCreated: devSpaceBindingsCreated,
      bindingMirrors: devSpaceBindingMirrors,
      bindingQueuePending: archive.listPendingDevSpaceBindingTurnEvidence({ limit: 10_000 }).length,
      bindingQueueEnqueued: devSpaceBindingQueueEnqueued,
      bindingQueueAttempts: devSpaceBindingQueueAttempts,
      bindingQueueMatches: devSpaceBindingQueueMatches,
      bindingProbeMergesSkipped: devSpaceBindingProbeMergesSkipped,
      bindingWorker: {
        scheduled: devSpaceBindingWorkerScheduled,
        inFlight: devSpaceBindingWorkerInFlight,
        pendingAuditEvents: devSpaceBindingAuditWork.size,
        pendingEvidence: devSpaceBindingEvidenceWork.size,
        runs: devSpaceBindingWorkerRuns,
        lastItemMs: Math.round(devSpaceBindingWorkerLastItemMs * 100) / 100,
        maxItemMs: Math.round(devSpaceBindingWorkerMaxItemMs * 100) / 100,
      },
      unboundActive: unboundDevSpaceTurns.size,
      idleCandidates: devSpaceIdleCandidates.size,
      idleNotificationsQueued: devSpaceIdleNotificationsQueued,
      idleDiagnosesPending: pendingDevSpaceIdleDiagnoses.size,
      idleDiagnosisNotificationsQueued: devSpaceIdleDiagnosisNotificationsQueued,
      unboundWatchdogDiagnosesPending: pendingUnboundWatchdogDiagnoses.size,
      unboundWatchdogDiagnosisNotificationsQueued,
      bindings: archive.listDevSpaceMetadataBindings({ limit: 100 }).map(binding => ({
        metadataId: binding.metadataId,
        conversationId: binding.conversationId,
        firstSeenAt: binding.firstSeenAt,
        lastSeenAt: binding.lastSeenAt,
        boundAt: binding.boundAt,
        evidence: binding.evidence,
        confidence: binding.confidence,
        lastTurnExchangeId: binding.lastTurnExchangeId,
        unboundWatchdogAt: binding.unboundWatchdogAt,
        lifecycleState: binding.lifecycleState,
      })),
    },
   authContext: { available: Boolean(authHeaders), capturedAt: lastAuthAt },
    protocol: protocolLedger ? protocolLedger.summary() : { enabled: false, filePath: protocolLedgerPath },
   queue: {
      dirty: dirty.size,
      ready: ready.size,
      catalogActive: catalogActive.size,
      active: reliableActiveIds().length + catalogLateActiveIds().length,
      reliableActive: reliableActiveIds().length,
      catalogLateActive: catalogLateActiveIds().length,
      timedOut: timedOutWatchdogIds().length,
      timedOutAwaitingDiagnosis: pendingWatchdogDiagnosisIds().length,
      oldestActiveMs: (reliableActiveIds().length + catalogLateActiveIds().length) > 0
        ? Math.max(...[...activeTurns.values()].map(item => Date.now() - item.startedAt))
        : 0,
      activeTurns: [...activeTurns.entries()].map(([conversationId, active]) => ({
        conversationId,
        startedAt: active.startedAt,
        lastEventAt: active.lastEventAt,
        lastWatchdogAt: active.lastWatchdogAt ?? null,
        watchdogPendingAt: active.watchdogPendingAt ?? null,
        startType: active.startType,
        lastDiagnosticTurnKey: active.lastDiagnosticTurnKey ?? null,
      })).sort((a, b) => Number(a.startedAt || 0) - Number(b.startedAt || 0)),
      syncInFlight,
      reconcileInFlight,
    },
    sync: {
      syncedConversations,
      syncErrors,
      lastReconcileAt,
      lastGapRepairAttemptAt: lastGapRepairAttemptAt || null,
      pendingGapRepair: pendingGapRepair ? {
        firstAt: pendingGapRepair.firstAt,
        lastAt: pendingGapRepair.lastAt,
        reasons: [...pendingGapRepair.reasons].sort(),
      } : null,
      gapRepairGate: lastGapRepairGate,
      passive: {
        observedPages: passivePageObservers.size,
        bodyResponses: passiveBodyResponses,
        catalogResponses: passiveCatalogResponses,
        projectCatalogResponses: passiveProjectCatalogResponses,
        projectSidebarCached: Boolean(passiveProjectSidebar),
        projectCatalogRepairs,
        projectCatalogRepairDiscoveries,
        imageResponses: passiveImageResponses,
        imageHydrations: passiveImageHydrations,
        imageCaptureErrors: passiveImageCaptureErrors,
        http429Responses: passive429Responses,
        bodyPagesReused: passiveBodyPagesReused,
        catalogPagesReused: passiveCatalogPagesReused,
        bodyCacheEntries: passiveBodyPages.size,
        catalogCacheEntries: passiveCatalogPages.size,
        guardianProtocolBodyReadsInFlight,
        guardianProtocolBodyReadsSkipped,
        guardianConversationRestBlocked: guardianConversationRestBlockedPatterns.length > 0,
        guardianConversationRestBlockedPatterns,
        guardianConversationRestBlockUncertain,
        requestEventLedgerPath,
        requestEventLedgerErrors,
      },
    },
    limits: {
      maxSyncConversations,
      bodyRequestGapMs: syncDelayMs,
      catalogRequestGapMs: reconcileDelayMs,
      requestJitterMs,
      guardianHealthFailureThreshold,
      gapRepairDelayMs,
      gapRepairMinIntervalMs,
      nativeBodyGraceMs,
      completeSettleMs,
      passiveCatalogFreshnessMs,
      recoveryProbeGapMs,
      recoveryProbeSuccesses,
      checkpointPollMinMs,
      checkpointPollMaxMs,
      checkpointFirstProbeMs,
      checkpointErrorRetryMs,
      checkpointMaxErrors,
      checkpointPollingEnabled,
    },
    // legacy 顶层字段只为旧消费者/旧 state 迁移保留；新版 429 状态见 rateLimits。
    cooldownUntil: cooldownUntil || null,
    cooldownRecoveryPending,
    recoveryProbeRemaining,
    rateLimits,
    notification: {
      enabled: Boolean(notificationConfig),
      provider: notificationConfig?.provider ?? null,
      lastAttemptAt: notificationLastAttemptAt,
      lastSuccessAt: notificationLastSuccessAt,
      lastError: notificationLastError,
    },
    imageAssets: {
      activeResolverEnabled: allowActiveImageResolver,
      lastHydrationAt: lastImageHydrationAt || null,
      hydrateSuccesses: imageHydrationSuccesses,
      hydrateErrors: imageHydrationErrors,
      activeResolverAttempts: activeImageResolverAttempts,
      activeResolverSuccesses: activeImageResolverSuccesses,
      activeResolverErrors: activeImageResolverErrors,
      lastActiveResolverAt: lastActiveImageResolverAt || null,
      pendingGenerated: archive.listPendingGeneratedImageAssets(500, Date.now()).length,
    },
    rssBytes: process.memoryUsage().rss,
    heapUsedBytes: process.memoryUsage().heapUsed,
    lastError,
  })

  const writeState = async () => fs.writeFile(statePath, JSON.stringify(state(), null, 2)).catch(() => {})
  // `--no-reconcile-on-start` 的含义必须是“启动后先纯监听”。旧实现保留
  // lastReconcileAt=0，导致第一轮主循环把 periodic 当成“已经超过 6 小时”而立刻扫 list。
  if (!reconcileOnStart) lastReconcileAt = startedAt
  // 继承真实 429 cooldown 时也从本次启动重新计算 periodic。
  // 否则 cooldown 一结束，lastReconcileAt=0 会把低频兜底误判成“早已逾期”，立即深扫 catalog。
  if (cooldownUntil > startedAt) lastReconcileAt = startedAt

  try {
    notificationConfig = await loadIncidentNotificationConfig(notificationConfigPath)
    if (notificationConfig) {
      await log('incident notification enabled', {
        provider: notificationConfig.provider,
        configPath: notificationConfigPath,
      })
      // 启动时额外做一次“第一方现状 vs 当前生产 allowlist”检查。这不是重放历史 drift：
      // 只有当前代码确实仍漏掉第一方已稳定使用的账户级 header 才会通知。
      // 因此即使那个 header 早于 protocol baseline（2026-10-07 的真实漏报场景），也能被发现。
      if (protocolLedger) {
        for (const signature of Object.keys(protocolLedger.state.variants)) {
          const coverage = protocolLedger.assessProductionHeaderCoverage(
            signature,
            CAPTURED_HEADER_ALLOWLIST,
          )
          if (coverage?.notify) queueProtocolDriftNotification(coverage)
        }
      }
    }
  }
  catch (error) {
    notificationLastError = error instanceof Error ? error.message : String(error)
    await log('incident notification config invalid; notifications disabled', {
      configPath: notificationConfigPath,
      error: notificationLastError,
    })
  }

  // LifeOps 同步完全是旁路 outbox：配置缺失时静默禁用；配置错误/网络错误只记日志，
  // 绝不能让 Archive/WSS/SQLite 主链无法启动。真正的发送与持久重试由 LifeOpsSyncClient 自己完成。
  try {
    const lifeOpsSyncConfig = await loadLifeOpsSyncConfig(lifeOpsSyncConfigPath)
    if (lifeOpsSyncConfig) {
      lifeOpsSync = new LifeOpsSyncClient(lifeOpsSyncConfig, {
        pendingPath: lifeOpsSyncPendingPath,
        log: async (message, extra) => await log(message, extra),
      })
      await lifeOpsSync.start()
      lifeOpsSyncLastError = null
      await log('LifeOps sync enabled', {
        baseUrl: lifeOpsSyncConfig.baseUrl,
        configPath: lifeOpsSyncConfigPath,
        pendingPath: lifeOpsSyncPendingPath,
        pendingCount: lifeOpsSync.pendingCount,
      })
    }
  }
  catch (error) {
    lifeOpsSyncLastError = error instanceof Error ? error.message : String(error)
    lifeOpsSync = null
    await log('LifeOps sync config invalid; sync disabled', {
      configPath: lifeOpsSyncConfigPath,
      error: lifeOpsSyncLastError,
    })
  }

  const latestOpenIncident = (conversationId) => {
    const incident = archive.db.prepare(`
      SELECT i.id, i.turn_exchange_id AS turnExchangeId, i.turn_key AS turnKey,
             i.incident_kind AS incidentKind, i.lifecycle_class AS lifecycleClass,
             i.detected_at AS detectedAt, i.last_observed_at AS lastObservedAt, i.status,
             i.reason, i.terminal_evidence AS bodyCompletionEvidence, i.tail_shape AS tailShape,
             i.head_state AS headState, i.source, i.diagnostic_json AS diagnosticJson,
             c.title
      FROM incidents i
      JOIN conversations c ON c.id = i.conversation_id
      WHERE i.conversation_id = ? AND i.status = 'open'
      ORDER BY i.detected_at DESC
      LIMIT 1
    `).get(conversationId) || null
    if (!incident) return null
    return {
      ...incident,
      evidenceTypes: archive.listIncidentEvidence(incident.id).map(evidence => evidence.evidenceType),
    }
  }

  const incidentSnapshots = (conversationId) => archive.db.prepare(`
    SELECT i.id, i.turn_exchange_id AS turnExchangeId, i.turn_key AS turnKey,
           i.incident_kind AS incidentKind, i.lifecycle_class AS lifecycleClass,
           i.reason, i.terminal_evidence AS bodyCompletionEvidence, i.tail_shape AS tailShape,
           i.detected_at AS detectedAt, i.last_observed_at AS lastObservedAt, i.status,
           c.title
    FROM incidents i
    JOIN conversations c ON c.id = i.conversation_id
    WHERE i.conversation_id = ?
    ORDER BY i.detected_at ASC, i.id ASC
  `).all(conversationId)

  const attachWatchdogDevSpaceTailGapEvidence = (conversationId, diagnostic, observedAt = Date.now()) => {
    const turnExchangeId = diagnostic?.turnExchangeId ?? null
    if (!turnExchangeId) return []
    const incident = latestOpenIncident(conversationId)
    if (!incident || incident.turnKey !== turnExchangeId) return []
    const bindings = archive.db.prepare(`
      SELECT metadata_id AS metadataId
      FROM devspace_metadata_bindings
      WHERE conversation_id=? AND last_turn_exchange_id=?
      ORDER BY last_verified_at DESC, last_seen_at DESC
    `).all(conversationId, turnExchangeId)
    const attached = []
    for (const binding of bindings) {
      if (!binding?.metadataId) continue
      const result = archive.attachCanonicalTailGapEvidence({
        conversationId,
        turnExchangeId,
        turnKey: incident.turnKey,
        lastMessageId: diagnostic?.lastMessageId ?? null,
        metadataId: binding.metadataId,
        bodyCompletionEvidence: diagnostic?.bodyCompletionEvidence ?? null,
        observedAt,
        beforeAt: observedAt,
      })
      if (result.summary.hasTailGap) attached.push(result.summary)
    }
    return attached
  }

  const promoteWatchdogTimeoutFromCatalog = (conversationId, observedAt = Date.now()) => {
    const active = activeTurns.get(conversationId)
    const incident = latestOpenIncident(conversationId)
    if (!shouldPromoteWatchdogTimeoutToActiveZombie(active, incident, catalogActive.has(conversationId))) return null
    let diagnostic = null
    try {
      diagnostic = JSON.parse(String(incident.diagnosticJson || 'null'))
    }
    catch {
      return null
    }
    if (!diagnostic || typeof diagnostic !== 'object') return null
    archive.updateIncidentFromDiagnostic(
      conversationId,
      diagnostic,
      observedAt,
      true,
      true,
      'active-zombie',
      incident.source || 'catalog:post-watchdog-active',
      true,
    )
    return latestOpenIncident(conversationId)
  }

  /**
   * LifeOps 是 Archive 的旁路消费者；任何 enqueue 失败都只记在 outbox，不得影响归档主链。
   * 这里的 payload 只包含事件身份、Conversation 引用和生命周期元数据，不读取/上传聊天正文。
   */
  const enqueueLifeOpsEvent = (payload) => {
    if (!lifeOpsSync || !payload) return false
    lifeOpsSync.enqueue(payload)
    return true
  }

  const watchdogLifeOpsEventId = (conversationId, startedAt) =>
    `incident:watchdog:${conversationId}:${Number(startedAt || 0)}`

  const unboundWatchdogLifeOpsEventId = (metadataId, startedAt) =>
    `incident:devspace-unbound:${metadataId}:${Number(startedAt || 0)}`

  /**
   * Watchdog 一到阈值就先向 Inbox 留下一条 Incident，即使 cooldown 导致 body 暂时拉不到。
   * 等 body/turn id 后来可用时，用同 sourceEventId 再次 enqueue 原地补齐。
   */
  const enqueueLifeOpsWatchdogTimeout = (conversationId, active, now = Date.now()) => {
    if (!lifeOpsSync || !conversationId || !active) return false
    const startedAt = Number(active.startedAt || now)
    const sourceEventId = watchdogLifeOpsEventId(conversationId, startedAt)
    if (lifeOpsWatchdogQueued.has(sourceEventId)) return false
    lifeOpsWatchdogQueued.add(sourceEventId)
    return enqueueLifeOpsEvent({
      sourceEventId,
      conversationId,
      turnExchangeId: null,
      title: conversationTitle(conversationId),
      runState: 'aborted',
      reviewState: 'unread',
      url: `https://chatgpt.com/c/${encodeURIComponent(conversationId)}`,
      updatedAt: new Date(now).toISOString(),
      inboxKind: 'incident',
      inboxHealth: 'incident',
      incidentType: 'watchdog-timeout-pending-diagnosis',
      incidentState: 'watchdog-fired',
      metadata: {
        startedAt,
        lastEventAt: active.lastEventAt ?? null,
        startType: active.startType ?? null,
        lastDiagnosticTurnKey: active.lastDiagnosticTurnKey ?? null,
        cooldownUntil: familyBackoffUntil(rateLimits, 'body', now) || null,
      },
    })
  }

  /**
   * DevSpace 已经证明“某个 metadata 对应的工作持续超过 watchdog”，但还没有 canonical CID 时，
   * 也先创建一条 metadata-only Incident。后续 bindDevSpaceMetadataToConversation 会用同一个 key
   * 补齐 conversation/turn/title/url，而不是创建第二张卡。
   */
  const enqueueLifeOpsUnboundWatchdog = (metadataId, candidate, now = Date.now()) => {
    if (!lifeOpsSync || !metadataId || !candidate) return false
    const startedAt = Number(candidate.startedAt || now)
    const sourceEventId = unboundWatchdogLifeOpsEventId(metadataId, startedAt)
    if (lifeOpsWatchdogQueued.has(sourceEventId)) return false
    lifeOpsWatchdogQueued.add(sourceEventId)
    return enqueueLifeOpsEvent({
      sourceEventId,
      metadataId,
      inboxKind: 'incident',
      inboxHealth: 'incident',
      incidentType: 'active-zombie-unbound',
      incidentState: 'metadata-only',
      updatedAt: new Date(now).toISOString(),
      metadata: {
        startedAt,
        lastEventAt: candidate.lastEventAt ?? null,
        lastAuditId: candidate.lastAuditId ?? null,
        reason: 'DevSpace watchdog reached threshold before metadata could be bound to a canonical conversation',
      },
    })
  }

  /**
   * 手机通知是 Archive 的旁路副作用，绝不能成为 conversation/body/SQLite 同步的关键路径。
   *
   * 调用方只负责把已经落库的 incident 交给通知分支；Bark 自己的超时、重试、日志失败
   * 都在这个 detached promise 内消化。这样即使 Bark 卡满整个请求窗口，`syncInFlight`
   * 也可以立刻释放，下一条 conversation 继续正常归档。
   *
   * 注意：这里目前仍是内存级 fire-and-forget；daemon 若在发送完成前被强杀，通知本身
   * 可能丢失，但 SQLite 中的 incident 事实不会丢。跨进程可靠重试属于后续 outbox 工作。
   */
  const dispatchIncidentNotification = (conversationId, incident) => {
    if (!notificationConfig || !incident) return
    const body = compactNotificationText(
      incident.reason || `${incident.bodyCompletionEvidence || 'abnormal'} / ${incident.tailShape || 'unknown tail'}`,
      180,
    )
    const payload = {
      title: incident.lifecycleClass === 'watchdog-timeout'
        ? 'Incident · Watchdog 超时'
        : incident.lifecycleClass === 'active-zombie'
          ? 'Incident · Active Zombie'
        : incident.lifecycleClass === 'complete-no-final'
          ? 'Incident · 无 Final'
        : incident.lifecycleClass === 'explicit-interrupted'
          ? 'Incident · 运行中断'
          : 'Incident · 异常结束',
      subtitle: notificationConversationSubtitle({
        title: incident.title || conversationTitle(conversationId),
        conversationId,
      }),
      body,
      group: conversationNotificationGroup({ conversationId }),
      url: `https://chatgpt.com/c/${encodeURIComponent(conversationId)}`,
    }
    dispatchPersistentNotification({
      notificationKey: `incident:${incident.id}`,
      kind: `incident:${incident.lifecycleClass || incident.incidentKind || 'abnormal-terminal'}`,
      conversationId,
      turnKey: incident.turnKey || incident.turnExchangeId || incident.id,
      payload,
      successLog: 'incident notification sent',
      failureLog: 'incident notification failed',
      logFields: { incidentId: incident.id },
    })
  }

  const dispatchTurnFinalNotification = (conversationId, diagnostic) => {
    if (!notificationConfig || !conversationId || !diagnostic) return false
    const turnKey = watchdogDiagnosticTurnKey(diagnostic)
      || diagnostic.currentNode
      || diagnostic.lastMessageId
      || 'unknown-turn'
    const payload = buildTurnFinalNotificationPayload({
      conversationId,
      title: conversationTitle(conversationId),
      diagnostic,
    })
    return dispatchPersistentNotification({
      notificationKey: `turn-final:${conversationId}:${turnKey}`,
      kind: 'turn-final',
      conversationId,
      turnKey,
      payload,
      successLog: 'turn final notification sent',
      failureLog: 'turn final notification failed',
    })
  }

  const dispatchWatchdogDeferredNotification = (conversationId, active, now = Date.now()) => {
    if (!notificationConfig || !conversationId || !active) return false
    if (familyRateLimitAllowed(rateLimits, 'body', now)) return false
    const startedAt = Number(active.startedAt || now)
    const turnKey = typeof active.lastDiagnosticTurnKey === 'string' && active.lastDiagnosticTurnKey
      ? active.lastDiagnosticTurnKey
      : `generation:${startedAt}`
    const payload = buildWatchdogDeferredNotificationPayload({
      conversationId,
      title: conversationTitle(conversationId),
      startedAt,
      now,
      cooldownUntil: familyBackoffUntil(rateLimits, 'body', now),
    })
    return dispatchPersistentNotification({
      notificationKey: `watchdog-deferred-cooldown:${conversationId}:${startedAt}`,
      kind: 'watchdog-deferred-cooldown',
      conversationId,
      turnKey,
      payload,
      successLog: 'watchdog cooldown-deferred notification sent',
      failureLog: 'watchdog cooldown-deferred notification failed',
      logFields: { startedAt, cooldownUntil: familyBackoffUntil(rateLimits, 'body', now) },
    })
  }

  const dispatchWatchdogTimeoutNotification = (conversationId, active, now = Date.now()) => {
    if (!notificationConfig || !conversationId || !active) return false
    const startedAt = Number(active.startedAt || now)
    // 兼容 2026-10-07~10-08 已经发出的旧 provisional 通知：它虽然标题叫
    // `watchdog-deferred-cooldown`，语义上已经完成“第一阶段：Watchdog 到点”的告知。
    // 升级两阶段通知后若直接换成新 key，会在 daemon 重启时把同一 generation 再提醒一次。
    // 因此旧 ledger 已成功落盘时视为第一阶段已经送达；只对未来新 generation 使用新 key。
    const legacyKey = `watchdog-deferred-cooldown:${conversationId}:${startedAt}`
    if (archive.hasTurnNotification(legacyKey)) return false
    const turnKey = typeof active.lastDiagnosticTurnKey === 'string' && active.lastDiagnosticTurnKey
      ? active.lastDiagnosticTurnKey
      : `generation:${startedAt}`
    const payload = buildWatchdogTimeoutNotificationPayload({
      conversationId,
      title: conversationTitle(conversationId),
      startedAt,
      now,
    })
    return dispatchPersistentNotification({
      notificationKey: `watchdog-timeout:${conversationId}:${startedAt}`,
      kind: 'watchdog-timeout',
      conversationId,
      turnKey,
      payload,
      successLog: 'watchdog timeout notification sent',
      failureLog: 'watchdog timeout notification failed',
      logFields: { startedAt },
    })
  }

  const dispatchWatchdogDiagnosisNotification = (conversationId, generationStartedAt, diagnostic, incident = null) => {
    if (!notificationConfig || !conversationId || !diagnostic) return false
    const startedAt = Number(generationStartedAt || 0)
    const turnKey = watchdogDiagnosticTurnKey(diagnostic)
      || (startedAt > 0 ? `generation:${startedAt}` : 'unknown-turn')
    const payload = buildWatchdogDiagnosisNotificationPayload({
      conversationId,
      title: conversationTitle(conversationId),
      diagnostic,
      incident,
    })
    return dispatchPersistentNotification({
      notificationKey: `watchdog-diagnosis:${conversationId}:${startedAt || turnKey}`,
      kind: 'watchdog-diagnosis',
      conversationId,
      turnKey,
      payload,
      successLog: 'watchdog diagnosis notification sent',
      failureLog: 'watchdog diagnosis notification failed',
      logFields: { startedAt: startedAt || null },
    })
  }

  const dispatchUnboundWatchdogNotification = (metadataId, candidate, now = Date.now()) => {
    if (!notificationConfig || !metadataId || !candidate) return false
    const startedAt = Number(candidate.startedAt || now)
    // 45min 到点属于极低频路径，此时再按 metadata 单次读取 title 即可；不为普通 tool hot path
    // 额外增加 SQLite 查询。若 legacy metadata 没有 title，payload 会退回可口述的 meta/XXXXXXXX。
    const metadataTitle = devSpaceAuditBridge.metadataToolState(metadataId)?.title ?? null
    const payload = buildUnboundWatchdogNotificationPayload({
      metadataId,
      title: metadataTitle,
      startedAt,
      now,
    })
    return dispatchPersistentNotification({
      notificationKey: `watchdog-unbound:${metadataId}:${startedAt}`,
      kind: 'watchdog-unbound',
      conversationId: null,
      turnKey: metadataId,
      payload,
      successLog: 'unbound watchdog notification sent',
      failureLog: 'unbound watchdog notification failed',
      logFields: { metadataId, startedAt },
    })
  }

  /**
   * 429 cooldown 是独立运行状态提醒，不写 incidents 表，也不改变 Watchdog taxonomy。
   *
   * 只在“未冷却 -> 进入冷却”的边沿调用；同一 cooldown 内后续 429 只延长窗口并写日志，
   * 避免手机被重复轰炸。发送仍然 detached，Bark 自己不能阻塞 cooldown 状态切换。
   */
  const dispatchCooldownNotification = ({
    reason,
    cooldownUntil: notifiedCooldownUntil,
    route = null,
    retryAfter = null,
  }) => {
    if (!notificationConfig) return
    const payload = buildCooldownNotificationPayload({
      reason,
      cooldownUntil: notifiedCooldownUntil,
      route,
      retryAfter,
    })
    void (async () => {
      notificationLastAttemptAt = Date.now()
      const result = await sendIncidentNotification(notificationConfig, payload)
      if (result.ok) {
        notificationLastSuccessAt = Date.now()
        notificationLastError = null
        await log('active API cooldown notification sent', {
          provider: notificationConfig.provider,
          status: result.status,
          reason,
          route,
          cooldownUntil: notifiedCooldownUntil,
        })
      }
      else if (result.attempted) {
        notificationLastError = result.error || 'cooldown notification failed'
        await log('active API cooldown notification failed', {
          provider: notificationConfig.provider,
          status: result.status,
          error: notificationLastError,
          reason,
          route,
          cooldownUntil: notifiedCooldownUntil,
        })
      }
    })().catch(async (error) => {
      notificationLastError = error instanceof Error ? error.message : String(error)
      await log('active API cooldown notification branch failed', {
        provider: notificationConfig.provider,
        error: notificationLastError,
        reason,
        route,
        cooldownUntil: notifiedCooldownUntil,
      }).catch(() => {})
    })
  }

  /** ImageGen 是值得提醒的业务事件，但不是异常 incident。 */
  const notifyImageGeneration = async (conversationId, event) => {
    if (!notificationConfig || !event || event.notificationSentAt) return
    notificationLastAttemptAt = Date.now()
    const conversation = archive.db.prepare('SELECT title FROM conversations WHERE id=?').get(conversationId)
    const conversationTitle = conversation?.title || conversationId
    const result = await sendIncidentNotification(notificationConfig, {
      title: 'ImageGen · 完成',
      subtitle: conversationTitle,
      body: `${event.imageCount} 张图片`,
      group: conversationNotificationGroup({ conversationId }),
      url: `https://chatgpt.com/c/${encodeURIComponent(conversationId)}`,
    })
    if (result.ok) {
      archive.markImageGenerationNotificationSent(conversationId, event.messageId)
      notificationLastSuccessAt = Date.now()
      notificationLastError = null
      await log('image generation notification sent', {
        conversationId,
        messageId: event.messageId,
        imageCount: event.imageCount,
      })
    }
    else if (result.attempted) {
      notificationLastError = result.error || 'image generation notification failed'
      await log('image generation notification failed', {
        conversationId,
        messageId: event.messageId,
        error: notificationLastError,
      })
    }
  }

  const dispatchImageGenerationNotification = (conversationId, event) => {
    if (!notificationConfig || !event || event.notificationSentAt) return
    void notifyImageGeneration(conversationId, event).catch(async (error) => {
      notificationLastError = error instanceof Error ? error.message : String(error)
      await log('image generation notification branch failed', {
        conversationId,
        error: notificationLastError,
      }).catch(() => {})
    })
  }

  /**
   * 把已经拿到的 ImageGen 原始字节写到 SQLite 外部资产目录，并回写校验信息。
   *
   * 注意这里的身份来自 conversation body 中的 stable asset pointer/file id；调用方传入的
   * signed URL（如果存在）只用于当前一次浏览器请求，绝不进入日志、文件名或数据库。
   */
  const persistGeneratedImageAssetBytes = async (asset, bytes, observedContentType = '') => {
    if (!asset?.fileId) throw new Error('generated image asset has no stable file id')
    if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes)
    if (asset.expectedSizeBytes !== null && bytes.length !== Number(asset.expectedSizeBytes)) {
      throw new Error(`size mismatch expected=${asset.expectedSizeBytes} actual=${bytes.length}`)
    }

    const contentType = String(asset.mimeType || observedContentType || 'image/png')
      .split(';')[0]
      .trim()
      .toLowerCase()
    if (contentType && !contentType.startsWith('image/')) {
      throw new Error(`unexpected content-type ${contentType}`)
    }
    const extension = contentType === 'image/jpeg' ? 'jpg'
      : contentType === 'image/webp' ? 'webp'
        : contentType === 'image/gif' ? 'gif' : 'png'
    const safeFileId = String(asset.fileId).replace(/[^A-Za-z0-9_-]/gu, '_')
    const outputPath = path.join(DEFAULT_IMAGE_ASSET_DIR, `${safeFileId}.${extension}`)
    const temporaryPath = `${outputPath}.tmp-${process.pid}-${Date.now()}`
    await fs.mkdir(DEFAULT_IMAGE_ASSET_DIR, { recursive: true })
    await fs.writeFile(temporaryPath, bytes)
    await fs.rename(temporaryPath, outputPath)
    const digest = createHash('sha256').update(bytes).digest('hex')
    archive.markImageAssetDownloaded(asset.assetPointer, {
      localPath: path.relative(PROJECT_ROOT, outputPath).split(path.sep).join('/'),
      sha256: digest,
      actualSizeBytes: bytes.length,
    })
    return { outputPath, digest, bytes: bytes.length, contentType }
  }

  /** 在已登录 ChatGPT renderer 中下载一个已经解析好的 signed estuary URL。 */
  const fetchImageBytesInPage = async (page, signedUrl) => {
    const fetchExpression = `(${async function downloadInPage(url) {
      const response = await fetch(url, { credentials: 'include' })
      const blob = await response.blob()
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result || ''))
        reader.onerror = () => reject(reader.error || new Error('FileReader failed'))
        reader.readAsDataURL(blob)
      })
      return {
        ok: response.ok,
        status: response.status,
        contentType: blob.type || response.headers.get('content-type') || '',
        size: blob.size,
        dataUrl,
      }
    }})(${JSON.stringify(signedUrl)})`
    const fetched = await page.send('Runtime.evaluate', {
      expression: fetchExpression,
      awaitPromise: true,
      returnByValue: true,
    }, 30_000)
    const result = fetched.result?.value || {}
    if (!result.ok) throw new Error(`HTTP ${result.status ?? 'unknown'}`)
    const dataUrl = String(result.dataUrl || '')
    const comma = dataUrl.indexOf(',')
    if (comma < 0 || !dataUrl.slice(0, comma).includes(';base64')) {
      throw new Error('page fetch returned no base64 image data')
    }
    const bytes = Buffer.from(dataUrl.slice(comma + 1), 'base64')
    if (Number(result.size) !== bytes.length) {
      throw new Error(`renderer size mismatch blob=${result.size} decoded=${bytes.length}`)
    }
    return { bytes, contentType: String(result.contentType || '') }
  }

  /**
   * 补全 ImageGen 图片本体：被动优先，严格受控主动 resolver 兜底。
   *
   * 被动主路径：
   * 1. 不创建、不导航、不激活任何 conversation tab；
   * 2. 只连接用户本来已经打开的 ChatGPT conversation target；
   * 3. 只读取 DOM 中已经自然解析出的 estuary URL；
   * 4. 真正取图由**该页面自己的 fetch** 完成，浏览器自行附带登录态，daemon 不读取 Cookie；
   * 5. per-tab Network observer 还会直接截获页面自己已经收到的 estuary 响应。
   *
   * 主动兜底仅用于长期 pending/off-head 图片：每个 hydration 周期最多 1 张；使用当前 Web
   * bundle 已确认的 `/files/download/{file_id}` resolver，并复用 Guardian 已捕获的 first-party
   * authHeaders。resolver 与图片下载都不保存 signed URL/token/cookie，并继续服从统一节流/429 cooldown。
   *
   * 2026-09-24 的真实漫画会话已经验证：页面上下文 fetch 能得到与 conversation body
   * `size_bytes` 完全一致的 Blob。之前失败的是浏览器下载管理器落盘链，而不是 fetch 本身；
   * 因此这里把 Blob 以 data URL 通过本地 CDP 带回，再由 daemon 原子写盘。
   */
  const hydratePendingGeneratedImageAssets = async () => {
    const now = Date.now()
    if (now - lastImageHydrationAt < IMAGE_ASSET_HYDRATE_INTERVAL_MS) return
    lastImageHydrationAt = now

    const pending = archive.listPendingGeneratedImageAssets(100)
    if (pending.length === 0) return

    const targets = await fetch(`${cdpHttp}/json/list`).then(response => response.json())
    const byConversation = new Map()
    for (const target of targets) {
      const conversationId = conversationIdFromTargetUrl(target?.url)
      if (!conversationId || !target?.webSocketDebuggerUrl) continue
      if (!byConversation.has(conversationId)) byConversation.set(conversationId, target)
    }

    const pendingByConversation = new Map()
    for (const asset of pending) {
      if (!asset.fileId || !byConversation.has(asset.conversationId)) continue
      const rows = pendingByConversation.get(asset.conversationId) || []
      rows.push(asset)
      pendingByConversation.set(asset.conversationId, rows)
    }
   for (const [conversationId, assets] of pendingByConversation) {
     const target = byConversation.get(conversationId)
      if (Date.now() < Number(imageHydrationTargetRetryAfter.get(target?.id) || 0)) continue
     const page = new CdpClient(target.webSocketDebuggerUrl)
     try {
        await page.connect()
        await page.send('Runtime.enable')
        const runtime = await page.send('Runtime.evaluate', {
          expression: `Array.from(document.images).map(img => img.currentSrc || img.src || '').filter(src => src.includes('/backend-api/estuary/content'))`,
          returnByValue: true,
        }, 5000)
        const urls = Array.isArray(runtime.result?.value) ? runtime.result.value : []
        const urlByFileId = new Map()
        for (const url of urls) {
          const fileId = estuaryFileIdFromUrl(url)
          if (fileId && !urlByFileId.has(fileId)) urlByFileId.set(fileId, String(url))
        }

       for (const asset of assets) {
          const signedUrl = urlByFileId.get(asset.fileId)
          if (!signedUrl) continue
          try {
            // URL 由当前 DOM 产生并只进入 renderer 表达式；不进入任何日志/SQLite。
            const { bytes, contentType } = await fetchImageBytesInPage(page, signedUrl)
            await persistGeneratedImageAssetBytes(asset, bytes, contentType)
            imageHydrationSuccesses += 1
            await log('image asset hydrated', {
              conversationId,
              fileId: asset.fileId,
              bytes: bytes.length,
            })
          }
          catch (error) {
            imageHydrationErrors += 1
            const message = error instanceof Error ? error.message : String(error)
            archive.markImageAssetDownloadError(asset.assetPointer, message)
            await log('image asset hydration failed', {
              conversationId,
              fileId: asset.fileId,
              error: message,
            })
          }
       }
        imageHydrationTargetRetryAfter.delete(target.id)
     }
     catch (error) {
        imageHydrationTargetRetryAfter.set(target?.id, Date.now() + SLEEPING_TARGET_RETRY_MS)
       imageHydrationErrors += 1
        await log('image hydration page unavailable; skipped', {
          conversationId,
          targetId: target?.id ?? null,
          error: error instanceof Error ? error.message : String(error),
        })
      }
     finally {
       page.close()
     }
    }

    // DOM/被动网络始终优先；到这里再重新查询一次，避免给刚刚已经补全的资产重复 resolver。
    if (!allowActiveImageResolver) return
    const activeCandidate = archive.listPendingGeneratedImageAssets(1)[0]
    if (!activeCandidate?.fileId) return
    if (!authHeaders
      || !guardian?.page
      || guardian.page.closed
      || !familyRateLimitAllowed(rateLimits, 'body')) return

    const resolverPath = `/backend-api/files/download/${encodeURIComponent(activeCandidate.fileId)}`
    activeImageResolverAttempts += 1
    lastActiveImageResolverAt = Date.now()
    let resolverPayload
    try {
      resolverPayload = await fetchChecked({
        url: resolverPath,
        targetPath: resolverPath,
        targetRoute: '/backend-api/files/download/{file_id}',
        kind: 'body',
      })
    }
    catch (error) {
      activeImageResolverErrors += 1
      const message = error instanceof Error ? error.message : String(error)
      // 认证/限流/Guardian 生命周期属于 transport 状态，不污染具体图片的 download_error。
      const transportFailure = /HTTP 429|auth context expired|active API cooldown|no captured first-party auth context|guardian page unavailable/iu.test(message)
      if (!transportFailure) archive.markImageAssetDownloadError(activeCandidate.assetPointer, `resolver: ${message}`)
      await log('image asset resolver failed', {
        conversationId: activeCandidate.conversationId,
        fileId: activeCandidate.fileId,
        error: message,
      })
      return
    }

    const signedUrl = resolvedEstuaryUrlForFile(resolverPayload, activeCandidate.fileId)
    if (!signedUrl) {
      activeImageResolverErrors += 1
      imageHydrationErrors += 1
      const message = 'resolver returned no matching ChatGPT estuary URL'
      archive.markImageAssetDownloadError(activeCandidate.assetPointer, message)
      await log('image asset resolver rejected payload', {
        conversationId: activeCandidate.conversationId,
        fileId: activeCandidate.fileId,
      })
      return
    }

    try {
      const { bytes, contentType } = await fetchImageBytesInPage(guardian.page, signedUrl)
      await persistGeneratedImageAssetBytes(activeCandidate, bytes, contentType)
      activeImageResolverSuccesses += 1
      imageHydrationSuccesses += 1
      await log('image asset hydrated via resolver', {
        conversationId: activeCandidate.conversationId,
        fileId: activeCandidate.fileId,
        bytes: bytes.length,
      })
    }
    catch (error) {
      activeImageResolverErrors += 1
      imageHydrationErrors += 1
      const message = error instanceof Error ? error.message : String(error)
      archive.markImageAssetDownloadError(activeCandidate.assetPointer, `resolver download: ${message}`)
      await log('image asset resolver download failed', {
        conversationId: activeCandidate.conversationId,
        fileId: activeCandidate.fileId,
        error: message,
      })
    }
  }

  const requestFamilyForKind = (kind) => {
    if (kind === 'catalog') return 'catalog'
    if (kind === 'project-sidebar' || kind === 'project-catalog') return 'project-catalog'
    if (kind === 'mapping') return 'mapping'
    return 'body'
  }

  const routeFamily = (route) => {
    if (route?.kind === 'catalog') return 'catalog'
    if (route?.kind === 'project-sidebar' || route?.kind === 'project-catalog') return 'project-catalog'
    if (route?.kind === 'mapping') return 'mapping'
    return 'body'
  }

  const routeClassForObservation = (route) => {
    if (!route) return 'unknown'
    if (route.kind === 'catalog') return route.globalCatalog ? 'catalog-global' : 'catalog-native'
    if (route.kind === 'project-sidebar') return 'project-sidebar'
    if (route.kind === 'project-catalog') return 'project-catalog'
    return String(route.kind || 'unknown')
  }

  const recordRequestEvent = (event) => {
    void requestEventLedger.append(event).catch(async (error) => {
      requestEventLedgerErrors += 1
      if (requestEventLedgerErrors <= 3 || requestEventLedgerErrors % 100 === 0) {
        await log('request event ledger append failed', {
          errors: requestEventLedgerErrors,
          error: error instanceof Error ? error.message : String(error),
        }).catch(() => {})
      }
    })
  }

  const tripCooldown = async (reason, details = {}) => {
    const now = Date.now()
    const family = details.family || 'body'
    const previous = rateLimits.families[family]
    const previousCooldownUntil = Number(previous?.backoffUntil || 0)
    const wasAlreadyCooling = previousCooldownUntil > now
    const retryAfter = String(details.retryAfter ?? '').trim()
    const requestedCooldownUntil = retryAfter
      ? cooldownDeadlineFromRetryAfter(retryAfter, {
          now,
          fallbackMs: cooldownMinutes * 60_000,
        })
      : null

    const next = recordFamily429(rateLimits, family, {
      now,
      retryAfter: retryAfter || null,
      requestedDeadline: requestedCooldownUntil,
      fallbackMs: cooldownMinutes * 60_000,
    })
    const familyCooldownUntil = Number(next.backoffUntil || 0)

    // catalog 429 只推进 catalog periodic 基准；body/mapping/actor 不再把 catalog 深扫时钟一起改写。
    if (family === 'catalog') lastReconcileAt = now
    await log('active API cooldown armed', {
      reason,
      family,
      cooldownUntil: familyCooldownUntil,
      wasAlreadyCooling,
      previousCooldownUntil: previousCooldownUntil > 0 ? previousCooldownUntil : null,
      extensionMs: wasAlreadyCooling ? Math.max(0, familyCooldownUntil - previousCooldownUntil) : null,
      retryAfterDriven: Boolean(retryAfter),
      backoffStage: next.stage,
      probationRemaining: next.probationRemaining,
      ...details,
    })
    if (!wasAlreadyCooling) {
      dispatchCooldownNotification({
        reason,
        cooldownUntil: familyCooldownUntil,
        route: details.route ?? null,
        retryAfter: details.retryAfter ?? null,
      })
    }
    await syncGuardianRateLimitBlocks().catch(async (error) => {
      await log('Guardian REST cooldown block failed', {
        family,
        error: error instanceof Error ? error.message : String(error),
      })
    })
    // Actor/Bridge 会直接读取 daemon state 的 actor family；因此 429 熔断一旦建立，
    // 必须立即落盘，不能等到 5 秒主循环末尾才让其它入口看见。
    await fs.writeFile(statePath, JSON.stringify(state(), null, 2)).catch(() => {})
    return familyCooldownUntil
  }

  const requireRequestWindow = (family) => {
    const now = Date.now()
    // legacy 全局 cooldown 到期前仍保持旧版 fail-closed；之后所有新限流都走 family state。
    if (cooldownRecoveryPending && now < cooldownUntil) {
      throw new Error(`legacy active API cooldown until ${new Date(cooldownUntil).toISOString()}`)
    }
    if (!familyRateLimitAllowed(rateLimits, family, now)) {
      const until = familyBackoffUntil(rateLimits, family, now)
      throw new Error(`active ${family} API cooldown until ${new Date(until).toISOString()}`)
    }
    if (cooldownRecoveryPending) throw new Error('active API cooldown recovery pending')
    if (guardianConversationRestBlockUncertain) throw new Error('Guardian conversation REST block state is uncertain')
    if (!authHeaders) throw new Error('no captured first-party auth context yet')
    if (!guardian?.page || guardian.page.closed) throw new Error('guardian page unavailable')
  }

  const waitForRequestSlot = async (kind) => {
    const family = requestFamilyForKind(kind)
    const configuredGap = family === 'catalog' || family === 'project-catalog'
      ? reconcileDelayMs
      : syncDelayMs
    const familyProbeRemaining = familyProbationRemaining(
      rateLimits,
      family,
      Date.now(),
      recoveryProbeSuccesses,
    )
    const baseGap = effectiveActiveRequestGap(
      configuredGap,
      Math.max(recoveryProbeRemaining, familyProbeRemaining),
      recoveryProbeGapMs,
    )
    const jitter = requestJitterMs > 0 ? Math.floor(Math.random() * (requestJitterMs + 1)) : 0
    if (lastActiveRequestAt > 0) {
      const waitMs = lastActiveRequestAt + baseGap + jitter - Date.now()
      if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs))
    }
    lastActiveRequestAt = Date.now()
  }

  /**
   * Resume scheduler 必须和 fetchChecked() 处于同一 daemon 主作用域。
   *
   * 旧实现误把这一整块放在 fetchChecked() 函数体内部：普通 body/catalog fetch 执行时看起来
   * 一切正常，但 passive SSE observer 与 daemon startup recovery 都无法访问
   * scheduleResumeRetry()，真正进入恢复路径时就会 ReferenceError。
   */
  const clearResumeRetry = (conversationId, turnExchangeId = null) => {
    const credential = archive.getLiveResumeCredential(conversationId, turnExchangeId)
    const key = credential?.turnKey ?? turnExchangeId ?? conversationId
    const timer = resumeRetryTimers.get(key)
    if (timer) clearTimeout(timer)
    resumeRetryTimers.delete(key)
  }

  const scheduleResumeRetry = (conversationId, turnExchangeId = null, reason = 'stream-failed') => {
    const credential = archive.getLiveResumeCredential(conversationId, turnExchangeId)
    if (!credential) {
      void log('live turn resume skipped: no persisted resume token', {
        conversationId,
        turnExchangeId,
        reason,
      }).catch(() => {})
      return false
    }
    const key = credential.turnKey
    if (resumeRetryTimers.has(key)) return true
    const nextAttemptNumber = Number(credential.resumeAttemptCount || 0) + 1
    if (nextAttemptNumber > resumeMaxAttempts) {
      void log('live turn resume exhausted; canonical body remains fallback', {
        conversationId,
        turnExchangeId: credential.turnExchangeId,
        attempts: credential.resumeAttemptCount,
        reason,
      }).catch(() => {})
      return false
    }
    const now = Date.now()
    const normalDueAt = now + resumeRetryDelayMs(nextAttemptNumber)
    const bodyBackoffUntil = familyBackoffUntil(rateLimits, 'body', now)
    const dueAt = Math.max(normalDueAt, bodyBackoffUntil > now ? bodyBackoffUntil + 1000 : 0)
    const timer = setTimeout(() => {
      resumeRetryTimers.delete(key)
      void (async () => {
        const current = archive.getLiveResumeCredential(conversationId, credential.turnExchangeId)
        if (!current) return
        const row = archive.db.prepare(`
          SELECT terminal_state AS bodyCompletionState, last_seen_at AS lastSeenAt
          FROM conversations
          WHERE id = ?
          LIMIT 1
        `).get(conversationId)
        // 同一个 conversation 可以继续发送下一轮。只有比当前 resume token 更新的 canonical
        // final 才证明“这一轮已经结束”；上一轮遗留的 final 不能把新 turn 的 resume 短路。
        if (bodyCompletionStateSupersedesResumeCredential(row, current.lastSeenAt)) return

        if (!guardian?.page || guardian.page.closed || !authHeaders) {
          // 本机 Chrome/Guardian 临时离线不消耗 resume 尝试额度；等待 daemon 自愈后再试。
          const retryTimer = setTimeout(() => {
            resumeRetryTimers.delete(key)
            scheduleResumeRetry(conversationId, current.turnExchangeId, 'guardian-or-auth-unavailable')
          }, 10_000)
          resumeRetryTimers.set(key, retryTimer)
          return
        }
        if (!familyRateLimitAllowed(rateLimits, 'body')) {
          scheduleResumeRetry(conversationId, current.turnExchangeId, 'cooldown-active')
          return
        }

        const rawOffset = current.resumeOffset ?? '0'
        const numericOffset = Number(rawOffset)
        const offset = Number.isFinite(numericOffset) && String(numericOffset) === String(rawOffset).trim()
          ? numericOffset
          : rawOffset
        let status = null
        let errorMessage = null
        try {
          const response = await pageResumeConversation(guardian.page, {
            conversationId,
            offset,
            token: current.token,
            headers: authHeaders,
          })
          status = Number(response.status || 0) || null
          if (status === 429) {
            await tripCooldown('live turn resume HTTP 429', {
              family: 'body',
              route: '/backend-api/f/conversation/resume',
              retryAfter: response.headers?.['retry-after'] ?? null,
              requestId: response.headers?.['x-request-id'] ?? null,
              cfRay: response.headers?.['cf-ray'] ?? null,
            })
          }
          else if (status >= 200 && status < 300) {
            recordFamilySuccess(rateLimits, 'body', Date.now())
          }
          if (status === 401 || status === 403) authHeaders = null
          if (status === null || status < 200 || status >= 300) {
            errorMessage = `resume HTTP ${status ?? 'unknown'}`
          }
        }
        catch (error) {
          errorMessage = error instanceof Error ? error.message : String(error)
        }

        const attemptNumber = Number(current.resumeAttemptCount || 0) + 1
        const succeeded = status !== null && status >= 200 && status < 300
        const nextResumeAt = succeeded || attemptNumber >= resumeMaxAttempts
          ? null
          : Math.max(
              Date.now() + resumeRetryDelayMs(attemptNumber + 1),
              familyBackoffUntil(rateLimits, 'body', Date.now()) > Date.now()
                ? familyBackoffUntil(rateLimits, 'body', Date.now()) + 1000
                : 0,
            )
        archive.markLiveResumeAttempt({
          conversationId,
          turnExchangeId: current.turnExchangeId,
          attemptedAt: Date.now(),
          nextResumeAt,
          status,
          error: errorMessage,
        })
        await log(succeeded ? 'live turn resume accepted' : 'live turn resume attempt failed', {
          conversationId,
          turnExchangeId: current.turnExchangeId,
          attempt: attemptNumber,
          status,
          nextResumeAt,
          error: errorMessage,
        })
        if (!succeeded && attemptNumber < resumeMaxAttempts) {
          scheduleResumeRetry(conversationId, current.turnExchangeId, errorMessage || 'resume-failed')
        }
      })().catch(async (error) => {
        await log('live turn resume scheduler failed', {
          conversationId,
          turnExchangeId,
          error: error instanceof Error ? error.message : String(error),
        }).catch(() => {})
      })
    }, Math.max(0, dueAt - now))
    resumeRetryTimers.set(key, timer)
    return true
  }

 const fetchChecked = async (request, options = {}) => {
   const family = requestFamilyForKind(request.kind)
   // backoff 到期后先把 Guardian 对应 URL pattern 解封，再真正发 probation probe。
   // sync 后再次检查 gate，避免 CDP block 状态不确定时继续向外请求。
   requireRequestWindow(family)
   await syncGuardianRateLimitBlocks()
   requireRequestWindow(family)
   // checkpoint fallback 的第一方行为是“先 stream_status，再几乎立即拉 latest body”。
   // 为了复刻这个**配对请求**而不是把两次请求都强行隔开 6 秒，调用方可以在已经
   // 占用过一次全局 request slot 后，仅对紧接着的 latest body 跳过第二次 wait。
   // 其它分页/cursor/mapping 仍会重新经过全局 gate，因此不会把这个选项变成绕过节流的后门。
   if (options.skipRequestSlot !== true) {
     await waitForRequestSlot(request.kind)
 }

    activeReplayRequestUrl = relativeBackendUrl(request.url)
    let response
    const requestStartedAt = Date.now()
    try {
      const headers = options.extraHeaders
        ? { ...authHeaders, ...options.extraHeaders }
        : authHeaders
      response = await pageFetchJson(guardian.page, { ...request, headers })
    }
    finally {
      activeReplayRequestUrl = null
    }
    recordRequestEvent({
      timestamp: Date.now(),
      source: 'archive-active',
      targetId: guardian?.targetId ?? null,
      family,
      routeClass: String(request.targetRoute || request.kind || 'unknown'),
      status: Number(response?.status || 0) || null,
      retryAfter: response?.headers?.['retry-after'] ?? null,
      latencyMs: Date.now() - requestStartedAt,
      backoffStage: rateLimits.families[family]?.stage ?? -1,
    })
   if (response.status === 429) {
      await tripCooldown(`active ${request.kind || 'body'} HTTP 429`, {
        family,
        route: relativeBackendUrl(request.url),
        retryAfter: response.headers?.['retry-after'] ?? null,
        requestId: response.headers?.['x-request-id'] ?? null,
        cfRay: response.headers?.['cf-ray'] ?? null,
      })
      throw new Error('ChatGPT backend returned HTTP 429')
    }
    if (response.status === 401 || response.status === 403) {
      authHeaders = null
      throw new Error(`ChatGPT auth context expired: HTTP ${response.status}`)
    }
    if (response.status < 200 || response.status >= 300 || !response.body) {
      throw new Error(`ChatGPT backend HTTP ${response.status}: ${response.text.slice(0, 240)}`)
    }
    recordFamilySuccess(rateLimits, family, Date.now())
    if (recoveryProbeRemaining > 0) {
      recoveryProbeRemaining -= 1
      if (recoveryProbeRemaining === 0) {
        await log('active API recovery probation completed; normal request gap restored')
      }
    }
    return response.body
  }

  /** 当前 conversation 是否已经被本机真正的 SSE / turn-WSS 覆盖。 */
  const hasLiveTransportForConversation = (conversationId) => [...activeLiveTransports.values()]
    .some(stream => String(stream?.conversationId || '') === String(conversationId || ''))

  /**
   * daemon 重启会丢失内存 tracker，但 resume capability 已经持久化在 SQLite。
   * 这里只恢复近期、尝试次数未耗尽、且当前没有本机 live transport 的 credential；
   * 真正发请求前统一 scheduler 仍会再次检查 auth/cooldown/当前 turn 是否已有新鲜 final。
   */
  const recoverRecentOrphanedResumeCredentials = () => {
    const cutoff = Date.now() - resumeStartupLookbackMs
    const rows = archive.db.prepare(`
      SELECT conversation_id AS conversationId, turn_exchange_id AS turnExchangeId,
             last_seen_at AS lastSeenAt, resume_attempt_count AS resumeAttemptCount
      FROM live_resume_credentials
      WHERE last_seen_at >= ? AND resume_attempt_count < ?
      ORDER BY last_seen_at DESC
      LIMIT 32
    `).all(cutoff, resumeMaxAttempts)
    let scheduled = 0
    for (const row of rows) {
      if (!row?.conversationId || hasLiveTransportForConversation(row.conversationId)) continue
      if (scheduleResumeRetry(row.conversationId, row.turnExchangeId ?? null, 'daemon-startup-orphan')) {
        scheduled += 1
      }
    }
    return scheduled
  }

  /**
   * 把“HTTP 连接仍存在，但已经长期没有任何 SSE bytes”的半死流转换成标准 stream-failed。
   * `retireIdle()` 由对应 passive observer 注入；它内部仍调用原 LiveTurn tracker.fail()，
   * 所以后续自动进入既有 resume backoff，不会产生第三套状态机。
   */
  const retireIdleLiveTransports = () => {
    const now = Date.now()
    for (const state of [...activeLiveTransports.values()]) {
      if (typeof state?.retireIdle !== 'function') continue
      const conversationId = String(state?.conversationId || '').trim()
      if (!conversationId) continue
      const credential = archive.getLiveResumeCredential(conversationId, state.turnExchangeId ?? null)
      if (!shouldRetireIdleLiveTransport(state, {
        now,
        idleMs: liveTransportIdleResumeMs,
        hasResumeCredential: Boolean(credential),
      })) continue
      const idleForMs = now - Number(state.lastDataAt || now)
      if (state.retireIdle('idle-timeout', now)) {
        void log('live turn SSE idle timeout; resume scheduled', {
          conversationId,
          turnExchangeId: state.turnExchangeId ?? null,
          transport: state.transport,
          idleForMs,
          requestId: state.cdpRequestId,
        }).catch(() => {})
      }
    }
  }

  /**
   * 给一个明确 active 的 conversation 建 checkpoint fallback。
   *
   * 这里的 startedAt 只是“Archive 开始追踪”的时间；绝不能冒充真实 turn start。
   * 同一个 CID 重复被 catalog/native list 看见时只刷新 observation，不重置计时和 identity。
   */
  const armCheckpointWatch = (conversationId, source, now = Date.now()) => {
    if (!conversationId) return null
    if (!checkpointPollingEnabled) return null
    const existing = checkpointWatches.get(conversationId)
    if (existing) {
      existing.lastObservedAt = Math.max(Number(existing.lastObservedAt || 0), now)
      return existing
    }
    const watch = createCheckpointWatch({
      conversationId,
      source: String(source || 'unknown'),
      now,
      firstProbeDelayMs: checkpointFirstProbeMs,
    })
    checkpointWatches.set(conversationId, watch)
    checkpointTurnContexts.set(conversationId, {
      turnTraceId: randomUUID(),
      createdAt: now,
    })
    void log('checkpoint refresh armed', {
      conversationId,
      source: watch.source,
      firstProbeAt: watch.nextProbeAt,
      turnTrace: 'session-scoped',
    }).catch(() => {})
    return watch
  }

  /** 停止 watcher 只删除 polling 状态，不修改 canonical conversation/incident。 */
  const stopCheckpointWatch = (conversationId, reason, now = Date.now()) => {
    const watch = checkpointWatches.get(conversationId)
    if (!watch) return null
    checkpointWatches.delete(conversationId)
    checkpointTurnContexts.delete(conversationId)
    void log('checkpoint refresh stopped', {
      conversationId,
      reason,
      ageMs: Math.max(0, now - Number(watch.startedAt || now)),
      probes: watch.probes,
      bodyRefreshes: watch.bodyRefreshes,
      lastStatus: watch.lastStatus,
      turnExchangeId: watch.turnExchangeId,
    }).catch(() => {})
    return watch
  }

  const passiveBodyKey = (conversationId, cursor = null) => `${conversationId}|${cursor ? `cursor:${cursor}` : 'latest'}`

  const prunePassiveCaches = (now = Date.now()) => {
    for (const [key, entry] of passiveBodyPages) {
      if (now - Number(entry.capturedAt || 0) > passiveCacheMaxAgeMs) passiveBodyPages.delete(key)
    }
    for (const [key, entry] of passiveCatalogPages) {
      if (now - Number(entry.capturedAt || 0) > passiveCacheMaxAgeMs) passiveCatalogPages.delete(key)
    }
    if (passiveProjectSidebar
      && now - Number(passiveProjectSidebar.capturedAt || 0) > passiveCacheMaxAgeMs) {
      passiveProjectSidebar = null
    }
  }

  /**
   * latest body 必须属于本次 ready/complete 附近，才可以证明“这次变化已经看过”。
   * cursor page 由 before cursor 精确定位；只要缓存仍新鲜即可复用，因为它代表同一历史分页边界。
   */
  const reusablePassiveBodyPage = (conversationId, cursor, readyAt) => {
    prunePassiveCaches()
    const entry = passiveBodyPages.get(passiveBodyKey(conversationId, cursor))
    if (!entry) return null
    if (cursor) return entry
    return passiveObservationMatchesReady(entry.capturedAt, readyAt) ? entry : null
  }

  /**
   * catalog passive page 只有在“同 offset + 同 limit”且仍位于短期缓存窗口内时才能复用。
   *
   * 注意：这里不要求它必须发生在 gap-repair 之后，因为 conversation list 的 offset page 本身
   * 就是一个只读 server snapshot。真正的正确性边界仍由 reconcileCatalog 的连续 stableOverlap
   * 决定；如果 passive 第 0 页里有变化，扫描会自然继续请求/复用第 1、2…页直到 overlap。
   */
  const reusablePassiveCatalogPage = (offset, limit, minCapturedAt = 0) => {
    prunePassiveCaches()
    const entry = passiveCatalogPages.get(`${offset}:${limit}`)
    if (!entry) return null
    return Number(entry.capturedAt || 0) >= Number(minCapturedAt || 0) ? entry : null
  }

  const reusablePassiveProjectSidebar = (minCapturedAt = 0) => {
    prunePassiveCaches()
    if (!passiveProjectSidebar) return null
    return Number(passiveProjectSidebar.capturedAt || 0) >= Number(minCapturedAt || 0)
      ? passiveProjectSidebar
      : null
  }

  const syncConversation = async (conversationId, trigger, options = {}) => {
    const syncReadyAt = Number(readySince.get(conversationId) || Date.now())
    const classifyCompletion = shouldClassifyCompletionForTrigger(trigger)
    const confirmedCompletion = isConfirmedCompletionTrigger(trigger)
    const requestedIncidentKind = incidentKindForTrigger(trigger, {
      catalogStillActive: catalogActive.has(conversationId),
    })
    let newIncident = null
    const incidentIdsBefore = new Set(incidentSnapshots(conversationId).map(incident => incident.id))
    const basePath = `/backend-api/conversations/${encodeURIComponent(conversationId)}`
    const passiveFirst = reusablePassiveBodyPage(conversationId, null, syncReadyAt)
    const first = passiveFirst?.payload ?? await fetchChecked({
      url: `${basePath}?include_has_versions=true&num_turns=10`,
      targetPath: basePath,
      targetRoute: '/backend-api/conversations/{conversation_id}',
      kind: 'body',
    }, syncSubrequestFetchOptions(options, {
      skipRequestSlot: options.skipFirstRequestSlot === true,
    }))
    if (passiveFirst) passiveBodyPagesReused += 1
    if (!Array.isArray(first.messages)) throw new Error(`conversation ${conversationId} latest body has no messages[]`)

    // 先在内存中预诊断最新页，再决定本次 observation 有没有资格创建 incident。
    // 这样 complete 已经到达、但 body 仍落后一拍时，仍然可以正常落 messages/raw observation，
    // 同时把“异常立案”推迟到唯一一次 settle 复核，避免把正常持久化延迟发成 Bark 红牌。
    const preliminaryDiagnostic = diagnoseLatestRun({
      ...first,
      conversation_id: first.conversation_id || conversationId,
    })
    const bodyTurnStartedAt = watchdogTurnStartedAtFromPayload(first, preliminaryDiagnostic)
    let watchdogTurnChanged = false
    let watchdogTurnStartedAt = null
    let watchdogTurnAlreadyTimedOut = false
    if (String(trigger || '').startsWith('watchdog:')) {
      const timedOutGeneration = pendingWatchdogDiagnoses.get(conversationId)
        ?? activeTurns.get(conversationId)
      if (timedOutGeneration) {
        const diagnosedAt = Date.now()
        const reconciled = reconcileWatchdogDiagnosticTurn(
          timedOutGeneration,
          preliminaryDiagnostic,
          diagnosedAt,
          bodyTurnStartedAt,
        )
        watchdogTurnChanged = reconciled.changed
        watchdogTurnStartedAt = Number.isFinite(Number(reconciled.turnStartedAt))
          ? Number(reconciled.turnStartedAt)
          : null
        watchdogTurnAlreadyTimedOut = Boolean(
          watchdogTurnChanged
          && watchdogTurnStartedAt !== null
          && diagnosedAt - watchdogTurnStartedAt >= watchdogMs,
        )
        if (watchdogTurnChanged) {
          // timeout 本身已经结束旧 generation。Body 若已经看到更新 turn，只记录“旧诊断窗口已被
          // 新 turn 覆盖”；新 generation 必须由 post-completion DevSpace candidate + Body 确认路径
          // 建立，并回填最早 DevSpace audit，不能在这里拿 Body 发现时刻凭空重开 Watchdog。
          void log('watchdog body belongs to a newer turn; reconciled turn start', {
            conversationId,
            trigger,
            previousTurnKey: timedOutGeneration.lastDiagnosticTurnKey ?? null,
            turnKey: reconciled.turnKey,
            turnStartedAt: watchdogTurnStartedAt,
            turnStartSource: reconciled.turnStartSource,
            alreadyTimedOut: watchdogTurnAlreadyTimedOut,
          })
        }
      }
    }
    const completionSettleNeeded = classifyCompletion
      && shouldDeferConfirmedCompletionIncident(trigger, preliminaryDiagnostic)
    const classifyCompletionNow = classifyCompletion && !completionSettleNeeded
    const incidentBefore = classifyCompletionNow ? latestOpenIncident(conversationId) : null

    const baseMeta = {
      title: first.title,
      conversation_id: first.conversation_id || conversationId,
      current_node: first.current_node,
      create_time: first.create_time,
      update_time: first.update_time,
    }
    let pagePayload = first
    let passivePageEntry = passiveFirst
    let cursor = null
    let pages = 0
    let passivePagesUsed = passiveFirst ? 1 : 0
    let newMessages = 0
    let recoverySuperseded = 0
    let databaseMergeMs = 0
    let latestDiagnostic = null
    let imageGenerationEvent = null
    const versionMarkerIds = new Set()
    while (true) {
      const normalized = { ...baseMeta, ...pagePayload, conversation_id: conversationId }
      for (const message of normalized.messages || []) {
        if (message?.metadata?.has_versions === true && typeof message.id === 'string') {
          versionMarkerIds.add(message.id)
        }
      }
      const ids = (normalized.messages || []).map(message => message?.id).filter(id => typeof id === 'string')
      const knownBefore = passivePageEntry?.knownBeforeIds
        ? new Set(passivePageEntry.knownBeforeIds)
        : archive.knownMessageIds(conversationId, ids)
      const allKnownBefore = ids.length > 0 && ids.every(id => knownBefore.has(id))

      // devspace:binding-probe 只用于在候选 Conversation 里寻找已经落库的 canonical
      // DevSpace tool evidence，从而把 unresolved metadata 绑定到 CID/turn。若当前 body 这一页
      // 的全部 message ID 都已经存在，再跑 mergeLiveMessagesPage() 不会增加 canonical 信息，
      // 却会重复触发 messages/FTS/resources/raw observation 写放大。生产曾实测出现
      // newMessages=0 但 dbMergeMs=10~18 秒，期间同进程 Archive Bridge 完全无法响应。
      //
      // 这个快路严格只用于 binding-probe；WSS/Watchdog/catalog 等正式同步即便 ID 全已知，
      // 仍继续 merge，以便捕获同 ID 上的状态、终止字段或内容变化。
      if (trigger === 'devspace:binding-probe' && allKnownBefore) {
        devSpaceBindingProbeMergesSkipped += 1
        const skippedPages = pages + 1
        void log('DevSpace binding probe reused stored canonical page; merge skipped', {
          conversationId,
          page: skippedPages,
          messages: ids.length,
          cursor,
        }).catch(() => {})
        return {
          conversationId,
          pages: skippedPages,
          newMessages,
          currentNode: first.current_node ?? null,
          updateTime: first.update_time ?? null,
          diagnostic: latestDiagnostic ?? preliminaryDiagnostic,
          newIncident,
          newHistoricalIncidents: [],
          imageGenerationEvent,
          exactMapping: false,
          passivePagesUsed,
          databaseMergeMs,
          completionSettleNeeded,
          watchdogTurnChanged,
          watchdogTurnStartedAt,
          watchdogTurnAlreadyTimedOut,
          bodyTurnStartedAt,
          recoverySuperseded: 0,
        }
      }

      const observationKind = `body-page:${trigger}`
      const observationEndpoint = pages === 0 ? basePath : `${basePath}/messages`
      const observationAt = Date.now()
      const observationPrepareStartedAt = performance.now()
      const evidence = await prepareObservationEvidence({
        payload: normalized,
        conversationId,
        observationKind,
        endpoint: observationEndpoint,
        pageCursor: cursor,
        observedAt: observationAt,
      })
      const asyncObservationPrepareMs = performance.now() - observationPrepareStartedAt
      const mergeStartedAt = performance.now()
      const merged = await archiveMergeWorker.mergeMessages(normalized, {
        observedAt: observationAt,
        endpoint: observationEndpoint,
        pageCursor: cursor,
        observationKind,
        preserveObservedTextPrefix: true,
        updateCurrentState: pages === 0,
        classifyCompletionIncident: pages === 0 && classifyCompletionNow,
        // watchdog 的语义是“已经超时，所以这个 turn 本身就是需要调查的 incident”。
        // COMPLETE 只决定它是不是 confirmed terminal；不能拿“尚未 COMPLETE”把 watchdog 变成空操作。
        allowIncompleteTailIncident: pages === 0
          && !completionSettleNeeded
          && !watchdogTurnChanged
          && (confirmedCompletion || trigger.startsWith('watchdog:')),
        incidentKind: requestedIncidentKind,
        preparedObservation: evidence.preparedObservation,
        skipLegacyObservation: evidence.skipLegacyObservation,
      })
      if (Number(merged.timings?.totalMs || 0) >= 100) {
        await log('slow canonical merge profile', {
          conversationId,
          trigger,
          page: pages,
          pageMessages: merged.pageMessageCount,
          newMessages: merged.newMessageCount,
          asyncObservationPrepareMs,
          ...merged.timings,
        })
      }
      databaseMergeMs += performance.now() - mergeStartedAt
      if (pages === 0) latestDiagnostic = merged.diagnostic
      if (pages === 0 && merged.diagnostic.hasImageGenerationFinal) {
        imageGenerationEvent = archive.getImageGenerationEvent(conversationId, merged.diagnostic.turnExchangeId)
      }
      if (pages === 0 && classifyCompletionNow) {
        const incidentAfter = latestOpenIncident(conversationId)
        if (shouldNotifyIncidentTransition(incidentBefore, incidentAfter)) newIncident = incidentAfter
      }
      newMessages += merged.newMessageCount
      recoverySuperseded += reconcileDevSpaceRecoveryWithCanonical(conversationId, normalized)
      pages += 1

      const pageInfo = pagePayload.page_info || {}
      if (pageInfo.has_previous_page === false || allKnownBefore || (options.latestOnly === true && pages === 1)) {
        let exactMapping = false
        if (options.latestOnly !== true && versionMarkerIds.size > 0) {
          const exactSource = archive.db.prepare(`
            SELECT parent_source AS parentSource
            FROM mapping_nodes
            WHERE conversation_id = ? AND node_id = ?
          `)
          const needsExactMapping = [...versionMarkerIds].some((messageId) => {
            const row = exactSource.get(conversationId, messageId)
            return !row || !['official-mapping', 'live-singular-mapping'].includes(row.parentSource)
          })

          if (needsExactMapping) {
            const singularPath = `/backend-api/conversation/${encodeURIComponent(conversationId)}`
            try {
              const mappingPayload = await fetchChecked({
                url: singularPath,
                targetPath: singularPath,
                targetRoute: '/backend-api/conversation/{conversation_id}',
                kind: 'mapping',
              }, syncSubrequestFetchOptions(options))
              if (!mappingPayload?.mapping || typeof mappingPayload.mapping !== 'object') {
                throw new Error(`conversation ${conversationId} singular response has no mapping`)
              }
              const mappingObservedAt = Date.now()
              const mappingObservationKind = `mapping-snapshot:${trigger}`
              const mappingEvidence = await prepareObservationEvidence({
                payload: mappingPayload,
                conversationId,
                observationKind: mappingObservationKind,
                endpoint: singularPath,
                observedAt: mappingObservedAt,
              })
              const mappingMergeStartedAt = performance.now()
              const mappingResult = await archiveMergeWorker.mergeMapping(mappingPayload, {
                observedAt: mappingObservedAt,
                endpoint: singularPath,
                observationKind: mappingObservationKind,
                preparedObservation: mappingEvidence.preparedObservation,
                skipLegacyObservation: mappingEvidence.skipLegacyObservation,
              })
              databaseMergeMs += performance.now() - mappingMergeStartedAt
              newMessages += mappingResult.newMessageCount
              exactMapping = true
              await log('versioned conversation exact mapping merged', {
                conversationId,
                trigger,
                versionMarkers: versionMarkerIds.size,
                nodes: mappingResult.nodeCount,
                newMessages: mappingResult.newMessageCount,
              })
            }
            catch (error) {
              // 分支树增强失败不能把已成功的正文增量同步也判失败。保留 transport-only 标记，
              // 后续版本事件可再次尝试 exact mapping；同时 raw plural observation 已经在库里。
              await log('versioned conversation exact mapping unavailable', {
                conversationId,
                trigger,
                error: error instanceof Error ? error.message : String(error),
              })
            }
          }
        }

        if (recoverySuperseded > 0) {
          await log('canonical body superseded DevSpace recovery overlay', {
            conversationId,
            trigger,
            recoverySuperseded,
          })
        }

        return {
          conversationId,
          pages,
          newMessages,
          currentNode: first.current_node ?? null,
          updateTime: first.update_time ?? null,
          diagnostic: latestDiagnostic ?? merged.diagnostic,
          newIncident,
          newHistoricalIncidents: shouldNotifyHistoricalIncidentForTrigger(trigger)
            ? incidentSnapshots(conversationId)
                .filter(incident => !incidentIdsBefore.has(incident.id) && incident.id !== newIncident?.id)
            : [],
          imageGenerationEvent,
          exactMapping,
          passivePagesUsed,
          databaseMergeMs,
          completionSettleNeeded,
          watchdogTurnChanged,
          watchdogTurnStartedAt,
          watchdogTurnAlreadyTimedOut,
          bodyTurnStartedAt,
          recoverySuperseded,
        }
      }
      const nextCursor = pageInfo.start_cursor
      if (typeof nextCursor !== 'string' || !nextCursor) {
        throw new Error(`conversation ${conversationId} has_previous_page=true but no start_cursor`)
      }
      cursor = nextCursor
      const messagePath = `${basePath}/messages`
      passivePageEntry = reusablePassiveBodyPage(conversationId, cursor, syncReadyAt)
      pagePayload = passivePageEntry?.payload ?? await fetchChecked({
        url: `${messagePath}?before=${encodeURIComponent(cursor)}&include_has_versions=true&num_turns=10`,
        targetPath: messagePath,
        targetRoute: '/backend-api/conversations/{conversation_id}/messages',
        kind: 'body',
      }, syncSubrequestFetchOptions(options))
      if (passivePageEntry) {
        passiveBodyPagesReused += 1
        passivePagesUsed += 1
      }
      if (!Array.isArray(pagePayload.messages)) throw new Error(`conversation ${conversationId} cursor page has no messages[]`)
    }
  }

  /**
   * Phase 3 checkpoint fallback：只处理一条 due conversation，然后立刻把控制权还给主循环。
   *
   * 真机已验证的第一方顺序是：
   *   stream_status -> (仍 streaming) canonical body -> 7~10 秒后再来一轮
   *   stream_status -> COMPLETE -> final body
   *
   * 本实现额外做两层节省：若已有真实 live transport，则完全不 poll；若页面自己已经拿到了
   * fresh native body，则直接消费 passive cache，不重复打 backend。
   */
  const drainCheckpointWatches = async () => {
    if (!checkpointPollingEnabled) return
    if (checkpointInFlight || syncInFlight || reconcileInFlight || stopping) return
    if (maxSyncConversations > 0 && syncedConversations >= maxSyncConversations) return

    const now = Date.now()
    const due = [...checkpointWatches.entries()]
      .find(([, watch]) => Number(watch.nextProbeAt || 0) <= now)
    if (!due) return

    const [conversationId, current] = due
    let turnContext = checkpointTurnContexts.get(conversationId)
    if (!turnContext) {
      turnContext = { turnTraceId: randomUUID(), createdAt: now }
      checkpointTurnContexts.set(conversationId, turnContext)
    }
    const turnHeaders = { 'x-oai-turn-trace-id': turnContext.turnTraceId }

    // 本机原始 SSE / resume SSE / turn-WSS 比 checkpoint 更完整；有 live transport 时不制造重复请求。
    if (hasLiveTransportForConversation(conversationId)) {
      current.nextProbeAt = now + checkpointProbeDelayMs(checkpointPollMinMs, checkpointPollMaxMs)
      current.lastError = null
      checkpointWatches.set(conversationId, current)
      return
    }

    // cooldown/auth/Guardian 不可用不是协议错误，只延期；不要把正常熔断累加成“3 次失败后停监控”。
    if (!authHeaders
      || !guardian?.page
      || guardian.page.closed
      || !familyRateLimitAllowed(rateLimits, 'body', now)) {
      const bodyBackoffUntil = familyBackoffUntil(rateLimits, 'body', now)
      const retryAt = Math.max(
        now + checkpointErrorRetryMs,
        bodyBackoffUntil > now ? bodyBackoffUntil + 1000 : 0,
      )
      current.nextProbeAt = retryAt
      checkpointWatches.set(conversationId, current)
      return
    }

    checkpointInFlight = true
    try {
      const statusPath = `/backend-api/conversation/${encodeURIComponent(conversationId)}/stream_status`
      const statusPayload = await fetchChecked({
        url: statusPath,
        targetPath: statusPath,
        targetRoute: '/backend-api/conversation/{conversation_id}/stream_status',
        kind: 'body',
      }, {
        extraHeaders: turnHeaders,
      })
      checkpointProbes += 1

      const rawStatus = statusPayload?.status ?? statusPayload?.stream_status ?? null
      const nextDelayMs = checkpointProbeDelayMs(checkpointPollMinMs, checkpointPollMaxMs)
      let next = recordCheckpointStatus({
        state: current,
        rawStatus,
        now: Date.now(),
        nextDelayMs,
      })
      checkpointWatches.set(conversationId, next)

      if (next.lastStatus === 'unknown') {
        checkpointErrors += 1
        next = recordCheckpointError({
          state: next,
          now: Date.now(),
          error: `unexpected stream_status=${JSON.stringify(rawStatus)}`,
          retryDelayMs: checkpointErrorRetryMs,
        })
        checkpointWatches.set(conversationId, next)
        await log('checkpoint stream_status shape drift', {
          conversationId,
          rawStatus: rawStatus == null ? null : String(rawStatus),
          consecutiveErrors: next.consecutiveErrors,
        })
        if (next.consecutiveErrors >= checkpointMaxErrors) {
          stopCheckpointWatch(conversationId, 'stream-status-shape-drift')
        }
        return
      }

      if (next.lastStatus === 'complete') {
        checkpointCompleted += 1
        stopCheckpointWatch(conversationId, 'stream-status-complete')
        // COMPLETE 是 lifecycle 证据，但 final body 仍可能落后一拍；统一交给现有 complete settle 逻辑。
        markSyncReady(conversationId, 'reconcile:checkpoint:async-complete', 0)
        return
      }

      // 页面本身若正在做第一方 polling，优先消费刚刚自然拿到的 latest body；不重复 GET。
      prunePassiveCaches()
      const passive = passiveBodyPages.get(passiveBodyKey(conversationId, null))
      const passiveFresh = passive
        && Date.now() - Number(passive.capturedAt || 0) <= checkpointPollMaxMs
      if (passiveFresh) {
        const payload = passive.payload
        const diagnostic = diagnoseLatestRun({
          ...payload,
          conversation_id: payload?.conversation_id || conversationId,
        })
        next = recordCheckpointBody({
          state: next,
          now: Date.now(),
          currentNode: payload?.current_node,
          updateTime: payload?.update_time,
          turnExchangeId: diagnostic.turnExchangeId,
          requestId: diagnostic.requestId,
        })
        checkpointWatches.set(conversationId, next)
        checkpointBodyRefreshes += 1
        if (diagnostic.bodyCompletionEvidence !== 'none') {
          stopCheckpointWatch(conversationId, 'passive-body-terminal')
          markSyncReady(conversationId, 'checkpoint:passive-body-terminal', 0)
        }
        return
      }

      // status 已占用本轮全局 request slot；latest body 紧接着复用该 slot，模拟第一方配对请求。
      syncInFlight = true
      let result
      try {
        result = await syncConversation(conversationId, 'checkpoint:streaming', {
          skipFirstRequestSlot: true,
          extraHeaders: turnHeaders,
          latestOnly: true,
        })
        syncedConversations += 1
      }
      finally {
        syncInFlight = false
      }

      await publishDevSpaceBindingEvidenceFromBody(conversationId, result.diagnostic)
      recordDeferredCatalogBodyObservation(conversationId, result.diagnostic, Date.now())
      checkpointBodyRefreshes += 1
      next = recordCheckpointBody({
        state: next,
        now: Date.now(),
        currentNode: result.currentNode,
        updateTime: result.updateTime,
        turnExchangeId: result.diagnostic.turnExchangeId,
        requestId: result.diagnostic.requestId,
      })
      checkpointWatches.set(conversationId, next)

      await log('checkpoint body refreshed', {
        conversationId,
        newMessages: result.newMessages,
        currentNode: result.currentNode,
        updateTime: result.updateTime,
        turnExchangeId: result.diagnostic.turnExchangeId ?? null,
        requestId: result.diagnostic.requestId ?? null,
        tail: result.diagnostic.tailShape,
      })

      // status 仍 streaming 但 canonical body 已出现明确终态时，优先相信更具体的 body 证据。
      if (result.diagnostic.bodyCompletionEvidence !== 'none') {
        stopCheckpointWatch(conversationId, 'body-terminal-while-status-streaming')
        markSyncReady(conversationId, 'checkpoint:body-terminal', 0)
      }
    }
    catch (error) {
      checkpointErrors += 1
      const message = error instanceof Error ? error.message : String(error)
      const latest = checkpointWatches.get(conversationId)
      if (latest) {
        const cooldownError = message.includes('HTTP 429')
          || message.startsWith('active body API cooldown until ')
          || message.startsWith('legacy active API cooldown until ')
        const authError = message.includes('auth context expired') || message.includes('no captured first-party auth context')
        const bodyBackoffUntil = familyBackoffUntil(rateLimits, 'body', Date.now())
        const retryDelayMs = cooldownError && bodyBackoffUntil > Date.now()
          ? Math.max(checkpointErrorRetryMs, bodyBackoffUntil - Date.now() + 1000)
          : checkpointErrorRetryMs
        const next = recordCheckpointError({
          state: latest,
          now: Date.now(),
          error: message,
          retryDelayMs,
        })
        checkpointWatches.set(conversationId, next)
        // 429/cooldown/auth 恢复属于环境状态，不因为累计次数丢掉 watcher；其它连续错误才有限止损。
        if (!cooldownError && !authError && next.consecutiveErrors >= checkpointMaxErrors) {
          stopCheckpointWatch(conversationId, 'checkpoint-error-limit')
        }
      }
      await log('checkpoint refresh failed', {
        conversationId,
        error: message,
        cooldownUntil: familyBackoffUntil(rateLimits, 'body', Date.now()) || null,
      })
    }
    finally {
      checkpointInFlight = false
    }
  }

  const drainDirty = async () => {
    if (syncInFlight || reconcileInFlight || stopping) return
    if (maxSyncConversations > 0 && syncedConversations >= maxSyncConversations) return
    if (ready.size === 0) return
    const now = Date.now()
    const activeWindowAvailable = familyRateLimitAllowed(rateLimits, 'body', now)
      && Boolean(authHeaders)
      && Boolean(guardian?.page)
      && !guardian?.page?.closed
    const nextReady = [...ready.entries()]
      .filter(([conversationId]) => {
        if (now < Number(readyNotBefore.get(conversationId) || 0)) return false
        if (activeWindowAvailable) return true
        const readyAt = Number(readySince.get(conversationId) || now)
        return Boolean(reusablePassiveBodyPage(conversationId, null, readyAt))
      })
      .sort(([, triggerA], [, triggerB]) => syncTriggerPriority(triggerB) - syncTriggerPriority(triggerA))[0]
    if (!nextReady) return
    syncInFlight = true
    try {
      // 每次调度最多只处理一个 conversation。
      //
      // 旧实现会 `while (ready.size > 0)` 一直跑完整个 backlog。只要 backlog 有几十上百条，
      // daemon 主循环就会被饿死数十分钟甚至数小时：Guardian Runtime 探活、WSS 缺失检测、
      // watchdog、state.json 刷新都不能按 5 秒节奏执行。主动 API 的节流已经由全局 request gate
      // 负责，因此这里应该采用 cooperative scheduling：处理一条就立刻把控制权还给主循环。
      const [conversationId, trigger] = nextReady
      ready.delete(conversationId)
      try {
        const watchdogPending = String(trigger || '').startsWith('watchdog:')
          ? pendingWatchdogDiagnoses.get(conversationId) ?? null
          : null
        const watchdogGenerationStartedAt = Number(watchdogPending?.startedAt || 0)
        const result = await syncConversation(conversationId, trigger)
        syncedConversations += 1
        // body 一旦给出 turn_exchange_id，就可以把 earlier provisional metadata 做后验校验；
        // 该步骤只读局部时间窗，不扫描整库。
        await publishDevSpaceBindingEvidenceFromBody(conversationId, result.diagnostic)
        recordDeferredCatalogBodyObservation(conversationId, result.diagnostic, Date.now())
        const postCompletionCandidateBeforeBody = postCompletionDevSpaceCandidates.get(conversationId) ?? null
        // late binding 可能正是在上面的 canonical evidence publish 中才找到 metadata；因此
        // post-completion candidate 必须在 publish 之后消费，才能复用这一次 Body 直接确认新 turn。
        completePostCompletionDevSpaceCandidate(conversationId, result)
        if (String(trigger || '').startsWith('watchdog:')) {
          const tailGaps = attachWatchdogDevSpaceTailGapEvidence(conversationId, result.diagnostic)
          if (tailGaps.length > 0) {
            await log('watchdog diagnosis attached DevSpace canonical tail gap evidence', {
              conversationId,
              trigger,
              evidenceCount: tailGaps.length,
              maxGapMs: Math.max(...tailGaps.map(gap => Number(gap.gapMs || 0))),
            })
          }
        }
        // 5 分钟静默 probe 的结果必须在这次成功 body sync 后显式收口。即使真正拉 body 的
        // trigger 是 WSS complete / Watchdog，也复用同一个结果，不再额外请求。
        const idleDiagnoses = completePendingDevSpaceIdleDiagnoses(conversationId, result)
        let watchdogReanchoredTurnStartedAt = null
        if (String(trigger || '').startsWith('watchdog:') && watchdogPending) {
          pendingWatchdogDiagnoses.delete(conversationId)
          if (
            result.watchdogTurnChanged
            && Number.isFinite(Number(result.watchdogTurnStartedAt))
            && Number(result.watchdogTurnStartedAt) > 0
          ) {
            // 典型恢复场景：daemon 离线跨过多个 ChatGPT turn，durable active_watchdogs 仍保存
            // 更早一轮 first-tool generation。恢复后它会先因旧 startedAt 触发 timeout；Body 诊断
            // 若已明确当前 user turn 的 create_time 晚于旧 generation 起点，就不能把“timeout
            // 处理时刻”当成 completion boundary 把当前仍在运行的 turn 永久挡在外面。
            //
            // 在成功 canonical sync 之后，把当前 turn 重新锚定为一个独立 generation。起点使用
            // Body user create_time（不是恢复时刻），lastEventAt 继承已经 catch-up 的 DevSpace
            // 活动；旧 row 用 startedAt 条件删除，因此不会误删这条新 generation。
            watchdogReanchoredTurnStartedAt = Number(result.watchdogTurnStartedAt)
            const nextActive = {
              ...watchdogPending,
              startedAt: watchdogReanchoredTurnStartedAt,
              lastEventAt: Math.max(
                watchdogReanchoredTurnStartedAt,
                Number(watchdogPending.lastEventAt || watchdogReanchoredTurnStartedAt),
              ),
              lastWatchdogAt: null,
              watchdogPendingAt: null,
              lastDiagnosticTurnKey: watchdogDiagnosticTurnKey(result.diagnostic),
            }
            activeTurns.set(conversationId, nextActive)
            persistActiveTurn(conversationId, nextActive)
            postCompletionDevSpaceCandidates.delete(conversationId)
            recentConversationComplete.set(
              conversationId,
              Math.max(1, watchdogReanchoredTurnStartedAt - 1),
            )
            dispatchWatchdogStartNotification(
              conversationId,
              nextActive,
              conversationTitle(conversationId),
            )
            armCheckpointWatch(conversationId, 'watchdog:newer-body-turn', watchdogReanchoredTurnStartedAt)
            archive.updateDevSpaceBindingTurn({
              conversationId,
              turnExchangeId: result.diagnostic.turnExchangeId ?? null,
              requestId: result.diagnostic.requestId ?? null,
              observedAt: Date.now(),
              lifecycleState: 'active',
            })
            await log('watchdog timeout diagnosis re-anchored newer active turn', {
              conversationId,
              oldGenerationStartedAt: watchdogPending.startedAt,
              oldGenerationCompletedAt: watchdogPending.completedAt ?? watchdogPending.lastWatchdogAt ?? null,
              turnKey: nextActive.lastDiagnosticTurnKey,
              startedAt: nextActive.startedAt,
              lastEventAt: nextActive.lastEventAt,
            })
          }
          archive.deleteActiveWatchdogIfStartedAt(conversationId, watchdogPending.startedAt)
          if (!activeTurns.has(conversationId)) {
            archive.updateDevSpaceBindingTurn({
              conversationId,
              turnExchangeId: result.diagnostic.turnExchangeId ?? null,
              requestId: result.diagnostic.requestId ?? null,
              observedAt: Date.now(),
              lifecycleState: 'closed',
            })
          }
          await log('watchdog diagnosis completed for already-ended generation', {
            conversationId,
            trigger,
            generationStartedAt: watchdogPending.startedAt,
            generationCompletedAt: watchdogPending.completedAt ?? watchdogPending.lastWatchdogAt ?? null,
            turnKey: watchdogDiagnosticTurnKey(result.diagnostic),
            watchdogTurnChanged: result.watchdogTurnChanged,
          })
        }
        // 一次 overlap 同步成功以后，本地副本已经追到本次 observation，因此才清 dirty。
        dirty.delete(conversationId)
        readySince.delete(conversationId)
        readyNotBefore.delete(conversationId)
        const activeAfterBody = activeTurns.get(conversationId) ?? null
        const completionBoundary = watchdogReanchoredTurnStartedAt !== null
          ? Math.max(1, watchdogReanchoredTurnStartedAt - 1)
          : Number(
              postCompletionCandidateBeforeBody?.completedAt
              ?? recentConversationComplete.get(conversationId)
              ?? 0,
            )
        const bodyCompletionOwnsCurrentGeneration = bodyCompletionBelongsToCurrentGeneration({
          completedAt: completionBoundary,
          bodyTurnStartedAt: result.bodyTurnStartedAt,
          activeTurnKey: activeAfterBody?.lastDiagnosticTurnKey ?? null,
          bodyTurnKey: watchdogDiagnosticTurnKey(result.diagnostic),
        })
        if (result.diagnostic.bodyCompletionEvidence !== 'none' && bodyCompletionOwnsCurrentGeneration) {
          recentConversationComplete.set(conversationId, Date.now())
          postCompletionDevSpaceCandidates.delete(conversationId)
          clearActiveTurn(conversationId)
          catalogActive.delete(conversationId)
          stopCheckpointWatch(conversationId, 'body-terminal', Date.now())
          archive.updateDevSpaceBindingTurn({
            conversationId,
            turnExchangeId: result.diagnostic.turnExchangeId ?? null,
            requestId: result.diagnostic.requestId ?? null,
            observedAt: Date.now(),
            lifecycleState: 'closed',
          })
        }
        else if (result.diagnostic.bodyCompletionEvidence !== 'none') {
          await log('stale Body completion ignored for current generation lifecycle', {
            conversationId,
            trigger,
            bodyCompletion: result.diagnostic.bodyCompletionEvidence,
            bodyTurnStartedAt: result.bodyTurnStartedAt,
            bodyTurnKey: watchdogDiagnosticTurnKey(result.diagnostic),
            completionBoundary: completionBoundary || null,
            activeTurnKey: activeAfterBody?.lastDiagnosticTurnKey ?? null,
            candidatePreserved: postCompletionDevSpaceCandidates.has(conversationId),
          })
        }
        if (result.completionSettleNeeded) {
          // 给第一方页面一个短窗口自然拉取/持久化最终 body。markSyncReady 现在就登记
          // readySince、但通过 notBefore 延迟执行，因此窗口内页面自然产生的 body response
          // 可以被 passive cache 复用；只有窗口结束仍没有足够新的 passive body 时，才会
          // 发生最多一次主动 GET。`:settle` 触发器本身不会再次进入 settle，避免循环。
          markSyncReady(conversationId, `${trigger}:settle`, completeSettleMs)
          await log('confirmed terminal body still unsettled; scheduled one bounded settle recheck', {
            conversationId,
            trigger,
            settleMs: completeSettleMs,
            tail: result.diagnostic.tailShape,
            currentNodeStatus: result.diagnostic.currentNodeStatus ?? null,
          })
        }
        await log('conversation synced', {
          conversationId,
          trigger,
          pages: result.pages,
          newMessages: result.newMessages,
          dbMergeMs: Math.round(result.databaseMergeMs * 100) / 100,
          exactMapping: result.exactMapping,
          passivePagesUsed: result.passivePagesUsed,
          bodyCompletion: result.diagnostic.bodyCompletionEvidence,
          tail: result.diagnostic.tailShape,
        })
        // Body sync 是我们第一次能够稳定拿到 request_id / turn_exchange_id / tool activity 的位置。
        // 它和 WSS lifecycle 分开记录：WSS 负责“何时 complete / 当时观测到多少并发”，body
        // 负责“complete 的到底是哪一个 turn，以及它最终停在什么尾型”。
        await turnRecorder.append(buildBodySnapshotTrace({
          at: Date.now(),
          conversationId,
          trigger,
          diagnostic: result.diagnostic,
          activeConversationIds: activeTurns.keys(),
        })).catch(async (error) => {
          await log('active turn trace write failed', {
            kind: 'body-snapshot',
            conversationId,
            error: error instanceof Error ? error.message : String(error),
          })
        })
        // canonical-update 只在 SQLite merge 成功以后广播；客户端收到它即可按 conversationId
        // 重新 GET canonical messages。这样 Bridge 不需要复制原始 ChatGPT token stream，也不会
        // 把 resume credential 等内部能力泄漏到 Family-AI。
        publishBridgeEvent({
          kind: 'canonical-update',
          conversationId,
          turnExchangeId: result.diagnostic.turnExchangeId ?? null,
          requestId: result.diagnostic.requestId ?? null,
          bodyCompletionEvidence: result.diagnostic.bodyCompletionEvidence ?? null,
          tailShape: result.diagnostic.tailShape ?? null,
        })
        // Inbox 只接收“已经有明确意义”的 Turn：
        // - 正常路径必须已经观察到 final；
        // - Incident / Watchdog 可以在没有 final 时进入；
        // - complete 但 body 仍落后一拍（completionSettleNeeded）先等 bounded settle，不误报成健康事件。
        // Worksite 本身只同步 metadata/link，不读取正文；同 Conversation 后续 Turn 更新同一引用。
        if (lifeOpsSync) {
          const currentIncident = result.newIncident || latestOpenIncident(conversationId)
          const watchdogTrigger = String(trigger || '').startsWith('watchdog:')
          const shouldEnqueueInboxTurn = !result.completionSettleNeeded && (
            result.diagnostic.bodyCompletionEvidence === 'final'
            || Boolean(currentIncident)
            || watchdogTrigger
          )
          if (shouldEnqueueInboxTurn) {
            const worksite = buildArchiveBridgeWorksite(
              archive,
              conversationId,
              result.diagnostic.turnExchangeId ?? null,
            )
            if (worksite) {
              const override = lifeOpsEventOverrideByConversation.get(conversationId)
              const watchdogSourceEventId = watchdogTrigger && watchdogGenerationStartedAt > 0
                ? watchdogLifeOpsEventId(conversationId, watchdogGenerationStartedAt)
                : null
              const incidentType = currentIncident?.lifecycleClass
                || currentIncident?.incidentKind
                || (watchdogTrigger ? 'watchdog-timeout' : null)
              lifeOpsSync.enqueue({
                ...worksite,
                sourceEventId: override?.sourceEventId
                  || watchdogSourceEventId
                  || worksite.sourceEventId,
                metadataId: override?.metadataId ?? null,
                inboxKind: currentIncident || watchdogTrigger ? 'incident' : 'turn',
                inboxHealth: currentIncident || watchdogTrigger ? 'incident' : 'healthy',
                finalState: result.diagnostic.bodyCompletionEvidence ?? null,
                incidentType,
                incidentState: currentIncident?.status
                  || (watchdogTrigger ? 'diagnosed' : null),
                metadata: {
                  ...(worksite.metadata || {}),
                  trigger,
                  requestId: result.diagnostic.requestId ?? null,
                  tailShape: result.diagnostic.tailShape ?? null,
                  incidentId: currentIncident?.id ?? null,
                  incidentReason: currentIncident?.reason ?? null,
                },
              })
              if (override) lifeOpsEventOverrideByConversation.delete(conversationId)
            }
          }
        }
        // SQLite/trace 到这里已经完成；通知只从已落库事实分叉出去，不参与 syncInFlight。
        // Watchdog 固定是“两阶段”：到点时已经发第一条；body 一旦诊断成功，这里无条件发第二条，
        // 不再额外叠加 turn-final / incident Bark，确保同一 Watchdog turn 最多恰好两条。
        if (String(trigger || '').startsWith('watchdog:')) {
          dispatchWatchdogDiagnosisNotification(
            conversationId,
            watchdogGenerationStartedAt,
            result.diagnostic,
            // Watchdog 诊断通知必须从“已落库后的最终 incident 视图”读取 evidence。
            // result.newIncident 是 merge 返回的瞬时对象，可能早于 canonical-tail-gap 附着，
            // 若优先使用它，手机通知会漏掉用户最关心的 Body 尾部缺失结论。
            latestOpenIncident(conversationId) || result.newIncident,
          )
        }
        else {
          // 非 Watchdog 路径仍保持“一 turn 一个终态通知”：final 与异常 incident 互斥。
          if (shouldNotifyTurnFinal(trigger, result.diagnostic)) {
            dispatchTurnFinalNotification(conversationId, result.diagnostic)
          }
          const incidentsToNotify = [
            result.newIncident,
            ...(result.newHistoricalIncidents || []),
          ].filter(Boolean)
          const notifiedIncidentIds = new Set()
          for (const incident of incidentsToNotify) {
            if (notifiedIncidentIds.has(incident.id)) continue
            notifiedIncidentIds.add(incident.id)
            dispatchIncidentNotification(conversationId, incident)
          }
        }
        if (result.imageGenerationEvent && !result.imageGenerationEvent.notificationSentAt) {
          // startup 只是认识已有历史，不能在重启后把旧图片节点重新推到手机。
          if (trigger === 'reconcile:startup') {
            archive.markImageGenerationNotificationSent(conversationId, result.imageGenerationEvent.messageId)
          }
          else dispatchImageGenerationNotification(conversationId, result.imageGenerationEvent)
        }
      }
      catch (error) {
        syncErrors += 1
        lastError = error instanceof Error ? error.message : String(error)
        await log('conversation sync failed', { conversationId, trigger, error: lastError })
        // 失败不能把 dirty 事实抹掉；同时保留 ready，等 auth/cooldown/页面恢复后再试。
        const existingTrigger = ready.get(conversationId)
        ready.set(conversationId, preferredSyncTrigger(existingTrigger, trigger))
        if (lastError.startsWith('active body API cooldown until ')
          || lastError.startsWith('legacy active API cooldown until ')) {
          const retryAt = Math.max(Date.now() + 5000, familyBackoffUntil(rateLimits, 'body', Date.now()))
          readyNotBefore.set(conversationId, Math.max(Number(readyNotBefore.get(conversationId) || 0), retryAt))
        }
        else readyNotBefore.set(
          conversationId,
          Math.max(Number(readyNotBefore.get(conversationId) || 0), Date.now() + 5000),
        )
      }
    }
    finally {
      syncInFlight = false
      await writeState()
    }
  }

  const markDirty = (conversationId, trigger) => {
    if (!conversationId) return
    dirty.set(conversationId, trigger)
  }

  const markSyncReady = (conversationId, trigger, delayMs = 500) => {
    if (!conversationId) return
    const now = Date.now()
    const existingTrigger = ready.get(conversationId)
    const selectedTrigger = preferredSyncTrigger(existingTrigger, trigger)
    dirty.set(conversationId, selectedTrigger)
    ready.set(conversationId, selectedTrigger)
    if (!readySince.has(conversationId)) readySince.set(conversationId, now)
    const requestedNotBefore = now + Math.max(0, Number(delayMs) || 0)
    const existingNotBefore = Number(readyNotBefore.get(conversationId) || 0)
    // 低优先级后来者不能把高优先级 lifecycle 请求推迟；同优先级重复排队也取更早截止。
    readyNotBefore.set(
      conversationId,
      existingNotBefore > 0 ? Math.min(existingNotBefore, requestedNotBefore) : requestedNotBefore,
    )
    setTimeout(() => { void drainDirty() }, delayMs)
  }

  const clearSyncDemand = (conversationId) => {
    dirty.delete(conversationId)
    ready.delete(conversationId)
    readySince.delete(conversationId)
    readyNotBefore.delete(conversationId)
  }

  const recentLiveSseCanonicalSatisfied = (conversationId, now = Date.now()) => {
    const state = liveSseCanonicalSatisfied.get(conversationId)
    if (!state) return null
    if (now - Number(state.at || 0) <= liveSseSatisfiedTtlMs) return state
    liveSseCanonicalSatisfied.delete(conversationId)
    return null
  }

  /**
   * 尝试把一条已经完整结束的 v1 SSE 晋升为 Archive canonical messages。
   *
   * 这里是严格 fail-closed：accumulator 必须同时证明 v1、message_stream_complete、[DONE]、
   * delta 全部可解码，并找到 finished_successfully + end_turn=true 的最终 assistant。
   * 任何条件不满足都只记录 fallback，现有 body sync 路径完全不变。
   */
  const promoteCompleteLiveSse = async (accumulator, source = {}) => {
    accumulator.finish()
    const snapshot = accumulator.snapshot()
    if (!snapshot.complete || !snapshot.conversationId) {
      liveSseCanonicalFallbacks += 1
      void log('live SSE canonical promotion skipped', {
        targetId: source.targetId ?? null,
        requestId: source.requestId ?? null,
        transport: source.transport ?? null,
        conversationId: snapshot.conversationId,
        protocolVersion: snapshot.protocolVersion,
        messageStreamComplete: snapshot.messageStreamComplete,
        doneSeen: snapshot.doneSeen,
        decodeErrors: snapshot.decodeErrors.slice(0, 4),
        messages: snapshot.messages.length,
      }).catch(() => {})
      return null
    }

    try {
      const existing = archive.getConversationSummary(snapshot.conversationId)
      const fallbackTitle = snapshot.title || existing?.title || 'ChatGPT Conversation'
      const payload = accumulator.canonicalPayload(fallbackTitle)
      if (!payload) throw new Error('complete SSE did not produce canonical payload')
      const observedAt = Date.now()
      const merged = await archiveMergeWorker.mergeMessages(payload, {
        observedAt,
        endpoint: source.endpoint ?? null,
        observationKind: 'live-sse-complete',
        preserveObservedTextPrefix: true,
        classifyCompletionIncident: false,
        updateCurrentState: true,
        updateIncidents: false,
        allowIncompleteTailIncident: false,
      })
      if (Number(merged.timings?.totalMs || 0) >= 100) {
        void log('slow canonical merge profile', {
          conversationId: snapshot.conversationId,
          trigger: 'live-sse-complete',
          pageMessages: merged.pageMessageCount,
          newMessages: merged.newMessageCount,
          ...merged.timings,
        }).catch(() => {})
      }
      // 完整 SSE 已经被提升为 canonical messages 后，它在 binding 语义上就等价于一次
      // canonical Body 落库。不能因为随后 WSS complete 会跳过主动 Body refresh，就让
      // DevSpace metadata 永远失去 exact tool+args reconcile 的机会。
      await publishDevSpaceBindingEvidenceFromBody(snapshot.conversationId, {
        turnExchangeId: snapshot.turnExchangeId,
        requestId: snapshot.requestId,
      })

      liveSseCanonicalPromoted += 1
      liveSseCanonicalSatisfied.set(snapshot.conversationId, {
        at: observedAt,
        turnExchangeId: snapshot.turnExchangeId,
        requestId: snapshot.requestId,
        sourceRequestId: source.requestId ?? null,
        transport: source.transport ?? null,
      })
      clearSyncDemand(snapshot.conversationId)
      clearActiveTurn(snapshot.conversationId)
      catalogActive.delete(snapshot.conversationId)
      stopCheckpointWatch(snapshot.conversationId, 'live-sse-complete', observedAt)
      archive.updateDevSpaceBindingTurn({
        conversationId: snapshot.conversationId,
        turnExchangeId: snapshot.turnExchangeId,
        requestId: snapshot.requestId,
        observedAt,
        lifecycleState: 'closed',
      })
      void log('live SSE promoted to canonical messages', {
        conversationId: snapshot.conversationId,
        turnExchangeId: snapshot.turnExchangeId,
        requestId: source.requestId ?? null,
        transport: source.transport ?? null,
        messages: snapshot.messages.length,
        newMessages: merged.newMessageCount,
        currentNode: snapshot.currentNode,
      }).catch(() => {})
      return { snapshot, merged }
    }
    catch (error) {
      liveSseCanonicalFallbacks += 1
      void log('live SSE canonical promotion failed; body fallback retained', {
        targetId: source.targetId ?? null,
        requestId: source.requestId ?? null,
        transport: source.transport ?? null,
        conversationId: snapshot.conversationId,
        error: error instanceof Error ? error.message : String(error),
      }).catch(() => {})
      return null
    }
  }

  /**
   * 把截断/中断 SSE 中“已经可靠解码出来”的 message 作为 provisional evidence 合并。
   *
   * 与 complete promotion 的边界必须严格分开：
   * - 不更新 current_node / terminal / incident；
   * - 不设置 liveSseCanonicalSatisfied；
   * - 不 clear dirty/ready，不取消 Body fallback；
   * - 只做 message-id union + 严格 prefix 单调正文保护。
   *
   * 因此它能保存“比当前 Body checkpoint 更往前”的 SSE 证据，但不能单独宣告 turn 完成。
   */
  const mergePartialLiveSseEvidence = async (accumulator, source = {}, reason = 'incomplete-stream') => {
    try {
      accumulator.finish()
      const snapshot = accumulator.snapshot()
      const existing = snapshot.conversationId
        ? archive.getConversationSummary(snapshot.conversationId)
        : null
      const payload = accumulator.evidencePayload(
        snapshot.title || existing?.title || 'ChatGPT Conversation',
      )
      if (!payload || !snapshot.conversationId) return null

      const observedAt = Date.now()
      const merged = await archiveMergeWorker.mergeMessages(payload, {
        observedAt,
        endpoint: source.endpoint ?? null,
        observationKind: 'live-sse-partial',
        preserveObservedTextPrefix: true,
        classifyCompletionIncident: false,
        updateCurrentState: false,
        updateIncidents: false,
        allowIncompleteTailIncident: false,
      })
      if (Number(merged.timings?.totalMs || 0) >= 100) {
        void log('slow canonical merge profile', {
          conversationId: snapshot.conversationId,
          trigger: 'live-sse-partial',
          pageMessages: merged.pageMessageCount,
          newMessages: merged.newMessageCount,
          ...merged.timings,
        }).catch(() => {})
      }
      liveSsePartialEvidenceMerged += 1
      liveSsePartialMessagesMerged += Number(snapshot.messages.length || 0)
      void log('partial live SSE evidence merged', {
        conversationId: snapshot.conversationId,
        turnExchangeId: snapshot.turnExchangeId,
        requestId: source.requestId ?? null,
        transport: source.transport ?? null,
        reason,
        messages: snapshot.messages.length,
        newMessages: merged.newMessageCount,
        decodeErrors: snapshot.decodeErrors.slice(0, 4),
        messageStreamComplete: snapshot.messageStreamComplete,
        doneSeen: snapshot.doneSeen,
      }).catch(() => {})
      return { snapshot, merged }
    }
    catch (error) {
      void log('partial live SSE evidence merge failed; body fallback retained', {
        targetId: source.targetId ?? null,
        requestId: source.requestId ?? null,
        transport: source.transport ?? null,
        reason,
        error: error instanceof Error ? error.message : String(error),
      }).catch(() => {})
      return null
    }
  }

  const mirrorDevSpaceBinding = (binding) => {
    if (!binding?.conversationId) return false
    try {
      const mirrored = devSpaceAuditBridge.mirrorBinding({
        metadataId: binding.metadataId,
        conversationId: binding.conversationId,
        turnExchangeId: binding.lastTurnExchangeId,
        evidence: binding.evidence || 'archive:binding',
        confidence: binding.confidence || 'unknown',
        observedAt: Number(binding.lastVerifiedAt || binding.boundAt || Date.now()),
      })
      if (mirrored) devSpaceBindingMirrors += 1
      return mirrored
    }
    catch (error) {
      devSpaceLastError = error instanceof Error ? error.message : String(error)
      return false
    }
  }

  const queuePostCompletionDevSpaceCandidate = (
    binding,
    auditAt,
    completedAt,
    latestAuditAt = auditAt,
  ) => {
    if (!binding?.conversationId) return false
    const conversationId = binding.conversationId
    const first = Number(auditAt)
    const last = Number(latestAuditAt)
    const completed = Number(completedAt)
    if (!Number.isFinite(first) || !Number.isFinite(last) || !Number.isFinite(completed)) return false
    if (first <= completed || last <= completed) return false

    const existing = postCompletionDevSpaceCandidates.get(conversationId)
    const candidate = mergePostCompletionDevSpaceCandidate(existing, {
      conversationId,
      metadataId: binding.metadataId,
      completedAt: completed,
      auditAt: first,
      latestAuditAt: last,
    })
    if (!candidate) return false
    postCompletionDevSpaceCandidates.set(conversationId, candidate)
    archive.updateDevSpaceBindingTurn({
      conversationId,
      observedAt: candidate.latestAuditAt,
      lifecycleState: 'closed',
    })

    // 一个 completion generation 只主动排一次 turn-check。若 Body 当时仍落后，candidate 保留；
    // 后续任何自然 Body（尤其现有 5m idle diagnosis）都可再次完成确认，不按 tool 频率主动拉取。
    if (!existing) {
      markSyncReady(
        conversationId,
        'devspace:post-completion-turn-check',
        POST_COMPLETION_TURN_CHECK_DELAY_MS,
      )
      void log('DevSpace activity after completed generation queued one Body turn check', {
        conversationId,
        metadataId: binding.metadataId,
        completedAt: completed,
        earliestAuditAt: candidate.earliestAuditAt,
        latestAuditAt: candidate.latestAuditAt,
      })
    }
    return true
  }

  const completePostCompletionDevSpaceCandidate = (conversationId, result, now = Date.now()) => {
    const candidate = postCompletionDevSpaceCandidates.get(conversationId)
    if (!candidate) return false
    candidate.lastCheckedAt = now
    candidate.lastCheckedAuditAt = candidate.latestAuditAt
    postCompletionDevSpaceCandidates.set(conversationId, candidate)
    if (!postCompletionBodyConfirmsNewTurn(candidate.completedAt, result?.bodyTurnStartedAt)) return false

    const nextActive = devSpaceFirstToolWatchdogState(candidate.earliestAuditAt)
    nextActive.lastEventAt = Math.max(candidate.earliestAuditAt, candidate.latestAuditAt)
    nextActive.lastDiagnosticTurnKey = watchdogDiagnosticTurnKey(result?.diagnostic)
    activeTurns.set(conversationId, nextActive)
    persistActiveTurn(conversationId, nextActive)
    dispatchWatchdogStartNotification(
      conversationId,
      nextActive,
      conversationTitle(conversationId),
      candidate.metadataId,
    )
    armCheckpointWatch(conversationId, 'devspace:first-tool', candidate.earliestAuditAt)
    archive.updateDevSpaceBindingTurn({
      conversationId,
      turnExchangeId: result?.diagnostic?.turnExchangeId ?? null,
      requestId: result?.diagnostic?.requestId ?? null,
      observedAt: now,
      lifecycleState: 'active',
    })
    postCompletionDevSpaceCandidates.delete(conversationId)
    void log('Body confirmed post-completion DevSpace activity as new turn; watchdog start backfilled', {
      conversationId,
      metadataId: candidate.metadataId,
      completedAt: candidate.completedAt,
      bodyTurnStartedAt: result.bodyTurnStartedAt,
      startedAt: nextActive.startedAt,
      lastEventAt: nextActive.lastEventAt,
      turnKey: nextActive.lastDiagnosticTurnKey,
    })
    return true
  }

  /**
   * metadata 已经绑定时，每个新 DevSpace tool call 都是“该 conversation 有真实工具活动”的强证据。
   * 正在运行的 generation 只推进 lastEventAt；已完成 generation 之后的 activity 则先进入
   * post-completion candidate，等待异步 Body 确认新 turn，不能仅凭时间间隔直接起表。
   */
  const activateBoundDevSpaceTurn = (binding, auditAt, traceId = null) => {
    if (!binding?.conversationId) return
    const conversationId = binding.conversationId
    const completedAt = Number(recentConversationComplete.get(conversationId) || 0)
    if (completedAt >= auditAt) {
      archive.updateDevSpaceBindingTurn({
        conversationId,
        observedAt: completedAt,
        lifecycleState: 'closed',
      })
      return
    }
    const current = activeTurns.get(conversationId)
    if (current) {
      current.lastEventAt = Math.max(Number(current.lastEventAt || 0), auditAt)
      persistActiveTurn(conversationId, current)
    }
    else if (completedAt > 0) {
      const previousTrace = binding.lastTurnExchangeId
        ? archive.getDevSpaceTraceTurnByTurn(conversationId, binding.lastTurnExchangeId)
        : null
      const currentTrace = traceId ? archive.getDevSpaceTraceTurnByTrace(traceId) : null
      if (shouldStartPostCompletionDevSpaceTurnFromTrace({
        traceId,
        previousTraceId: previousTrace?.traceId ?? null,
        previousTraceStatus: previousTrace?.status ?? null,
        currentTraceStatus: currentTrace?.status ?? null,
      })) {
        const nextActive = devSpaceFirstToolWatchdogState(auditAt)
        nextActive.startType = 'devspace:first-tool-trace'
        activeTurns.set(conversationId, nextActive)
        persistActiveTurn(conversationId, nextActive)
        dispatchWatchdogStartNotification(conversationId, nextActive, null, binding.metadataId)
        postCompletionDevSpaceCandidates.delete(conversationId)
        void log('verified previous trace separated post-completion DevSpace activity as new provisional turn', {
          conversationId,
          metadataId: binding.metadataId,
          previousTurnExchangeId: binding.lastTurnExchangeId,
          previousTraceId: previousTrace?.traceId ?? null,
          traceId,
          startedAt: auditAt,
        })
      }
      else {
        queuePostCompletionDevSpaceCandidate(binding, auditAt, completedAt)
        return
      }
    }
    else {
      const nextActive = devSpaceFirstToolWatchdogState(auditAt)
      activeTurns.set(conversationId, nextActive)
      persistActiveTurn(conversationId, nextActive)
      dispatchWatchdogStartNotification(conversationId, nextActive, null, binding.metadataId)
      void log('DevSpace first tool started watchdog', {
        conversationId,
        startedAt: auditAt,
        metadataId: binding.metadataId,
      })
    }
    armCheckpointWatch(conversationId, 'devspace:first-tool', auditAt)
    archive.updateDevSpaceBindingTurn({
      conversationId,
      observedAt: auditAt,
      lifecycleState: 'active',
    })
  }

  const bindDevSpaceMetadataToConversation = async (input) => {
    const existing = archive.getDevSpaceMetadataBinding(input.metadataId)
    const provisional = unboundDevSpaceTurns.get(input.metadataId)
    const pendingUnboundTimeout = pendingUnboundWatchdogDiagnoses.get(input.metadataId) ?? null
    const timedOutBeforeBinding = Boolean(
      pendingUnboundTimeout
      || existing?.unboundWatchdogAt
      || provisional?.repairQueuedAt,
    )
    const pendingUnboundWatchdogAt = Number(
      pendingUnboundTimeout?.watchdogAt
      ?? existing?.unboundWatchdogAt
      ?? provisional?.repairQueuedAt
      ?? 0,
    )
    const bindingGenerationStartedAt = Math.max(
      Number(input.startAt || 0),
      Number(provisional?.startedAt || 0),
    )
    const bindingResolvedNewerGeneration = timedOutBeforeBinding
      && unboundBindingResolvesNewerGeneration(
        pendingUnboundWatchdogAt,
        input.startAt,
        provisional?.startedAt,
      )
    if (existing?.conversationId && existing.conversationId !== input.conversationId) {
      if (!shouldSupersedeDevSpaceBinding(existing, input)) {
        void log('DevSpace metadata binding conflict left unchanged', {
          metadataId: input.metadataId,
          existingConversationId: existing.conversationId,
          candidateConversationId: input.conversationId,
          existingEvidence: existing.evidence,
          candidateEvidence: input.evidence,
        })
        return existing
      }
      void log('DevSpace metadata backfill binding superseded by current exact body match', {
        metadataId: input.metadataId,
        existingConversationId: existing.conversationId,
        candidateConversationId: input.conversationId,
        existingEvidence: existing.evidence,
        candidateEvidence: input.evidence,
      })
    }
    const completedAt = Number(recentConversationComplete.get(input.conversationId) || 0)
    const lifecycleState = input.lifecycleState
      ?? (completedAt >= input.startAt ? 'closed' : 'active')
    const binding = archive.bindDevSpaceMetadata({
      metadataId: input.metadataId,
      conversationId: input.conversationId,
      displayTitle: existing?.displayTitle ?? null,
      evidence: input.evidence,
      confidence: input.confidence,
      observedAt: input.observedAt,
      turnExchangeId: input.turnExchangeId ?? null,
      requestId: input.requestId ?? null,
      lifecycleState,
    })
    unboundDevSpaceTurns.delete(input.metadataId)
    dropDeferredCatalogWatchdogCandidate(input.conversationId, 'exact-devspace-binding')
    if (!existing?.conversationId) devSpaceBindingsCreated += 1
    mirrorDevSpaceBinding(binding)
    const recoveryRebound = archive.rebindDevSpaceRecoveryAudits(
      input.metadataId,
      input.conversationId,
    )
    const recoveryMirrored = await backfillDevSpaceRecoveryForBinding(
      binding,
      input.startAt,
      input.observedAt,
    )
    if (existing?.conversationId && existing.conversationId !== input.conversationId) {
      const staleConversationId = existing.conversationId
      const staleWatchdog = activeTurns.get(staleConversationId)
      if (staleWatchdog?.startType === 'devspace:first-tool') {
        const otherBindings = archive.getDevSpaceMetadataBindingsForConversation(staleConversationId)
          .filter(row => row.metadataId !== input.metadataId)
        const hasIndependentAuditAtOrAfterStart = otherBindings.some(row =>
          Number(row.lastAuditAt || 0) >= Number(staleWatchdog.startedAt || 0))
        if (!hasIndependentAuditAtOrAfterStart) {
          clearActiveTurn(staleConversationId)
          void log('cleared stale DevSpace watchdog after binding correction', {
            metadataId: input.metadataId,
            staleConversationId,
            correctedConversationId: input.conversationId,
            staleStartedAt: staleWatchdog.startedAt,
          })
        }
      }
    }
    void log('DevSpace metadata bound to conversation', {
      metadataId: input.metadataId,
      conversationId: input.conversationId,
      evidence: input.evidence,
      confidence: input.confidence,
      lifecycleState,
      startAt: input.startAt,
      recoveryRebound,
      recoveryMirrored,
    })
    if (lifecycleState === 'active' && (!timedOutBeforeBinding || bindingResolvedNewerGeneration)) {
      activateBoundDevSpaceTurn(binding, input.startAt)
    }
    else if (completedAt > 0) {
      // late binding 时 provisional firstSeenAt 可能仍落在上一轮 completion 之前，而同 metadata
      // 已经在 completion 之后产生了 durable tool audit。把这些已有事实补回 candidate，不能再等
      // 下一条工具调用才发现新 generation，否则 startedAt 会被人为推迟数分钟。
      const postCompleteAudits = devSpaceAuditBridge.auditsForMetadata(
        input.metadataId,
        completedAt + 1,
        Math.max(Number(input.observedAt || 0), Date.now()) + 1,
        5000,
      ).filter(event => Number(event.startedAtMs) > completedAt)
      if (postCompleteAudits.length > 0) {
        const earliestAuditAt = Math.min(...postCompleteAudits.map(event => Number(event.startedAtMs)))
        const latestAuditAt = Math.max(...postCompleteAudits.map(event => Number(event.startedAtMs)))
        queuePostCompletionDevSpaceCandidate(
          binding,
          earliestAuditAt,
          completedAt,
          latestAuditAt,
        )
      }
    }
    if (timedOutBeforeBinding) {
      const provisionalStartedAt = Number(
        pendingUnboundTimeout?.startedAt
        ?? provisional?.startedAt
        ?? existing?.firstSeenAt
        ?? input.startAt
        ?? input.observedAt,
      )
      const watchdogAt = pendingUnboundWatchdogAt
      const newGenerationStartedAt = bindingGenerationStartedAt
      const sourceEventId = unboundWatchdogLifeOpsEventId(input.metadataId, provisionalStartedAt)
      enqueueLifeOpsEvent({
        sourceEventId,
        metadataId: input.metadataId,
        conversationId: input.conversationId,
        turnExchangeId: input.turnExchangeId ?? null,
        title: conversationTitle(input.conversationId),
        runState: 'aborted',
        reviewState: 'unread',
        url: `https://chatgpt.com/c/${encodeURIComponent(input.conversationId)}`,
        updatedAt: new Date(input.observedAt ?? Date.now()).toISOString(),
        inboxKind: 'incident',
        inboxHealth: 'incident',
        incidentType: 'active-zombie-unbound',
        incidentState: bindingResolvedNewerGeneration
          ? 'bound-superseded-by-new-turn'
          : 'bound-awaiting-diagnosis',
        metadata: {
          bindingEvidence: input.evidence ?? null,
          bindingConfidence: input.confidence ?? null,
          provisionalStartedAt,
          watchdogAt: watchdogAt || null,
          newGenerationStartedAt: bindingResolvedNewerGeneration ? newGenerationStartedAt : null,
        },
      })
      lifeOpsEventOverrideByConversation.set(input.conversationId, {
        sourceEventId,
        metadataId: input.metadataId,
        startedAt: provisionalStartedAt,
      })
      if (bindingResolvedNewerGeneration) {
        pendingUnboundWatchdogDiagnoses.delete(input.metadataId)
        dispatchPersistentNotification({
          notificationKey: unboundWatchdogDiagnosisNotificationKey(input.metadataId, provisionalStartedAt),
          kind: 'watchdog-diagnosis:bound-superseded',
          conversationId: input.conversationId,
          turnKey: input.turnExchangeId ?? input.metadataId,
          payload: buildSupersededUnboundWatchdogDiagnosisNotificationPayload({
            conversationId: input.conversationId,
            metadataId: input.metadataId,
            title: conversationTitle(input.conversationId),
            newGenerationStartedAt,
          }),
          successLog: 'superseded unbound watchdog diagnosis notification sent',
          failureLog: 'superseded unbound watchdog diagnosis notification failed',
          logFields: {
            metadataId: input.metadataId,
            oldStartedAt: provisionalStartedAt,
            watchdogAt,
            newGenerationStartedAt,
          },
        })
        void log('timed-out unbound generation bound after newer generation start; skipped stale latest-Body diagnosis', {
          metadataId: input.metadataId,
          conversationId: input.conversationId,
          oldStartedAt: provisionalStartedAt,
          watchdogAt,
          newGenerationStartedAt,
          turnExchangeId: input.turnExchangeId ?? null,
        })
      }
      else {
        const completedAtForGeneration = watchdogAt || Number(input.observedAt || Date.now())
        const boundPending = {
          startedAt: provisionalStartedAt,
          lastEventAt: completedAtForGeneration,
          lastWatchdogAt: completedAtForGeneration,
          watchdogPendingAt: completedAtForGeneration,
          startType: 'devspace:unbound-first-tool',
          lastDiagnosticTurnKey: input.turnExchangeId ?? null,
          completedAt: completedAtForGeneration,
        }
        pendingUnboundWatchdogDiagnoses.delete(input.metadataId)
        pendingWatchdogDiagnoses.set(input.conversationId, boundPending)
        persistActiveTurn(input.conversationId, boundPending)
        recentConversationComplete.set(input.conversationId, boundPending.completedAt)
        archive.updateDevSpaceBindingTurn({
          conversationId: input.conversationId,
          observedAt: boundPending.completedAt,
          lifecycleState: 'closed',
        })
        markSyncReady(input.conversationId, 'watchdog:devspace-timeout', 0)
        void log('timed-out DevSpace metadata bound; promoted old generation to pending conversation diagnosis', {
          metadataId: input.metadataId,
          conversationId: input.conversationId,
          generationStartedAt: boundPending.startedAt,
          generationCompletedAt: boundPending.completedAt,
          turnExchangeId: input.turnExchangeId ?? null,
        })
      }
    }
    flushDeferredCatalogWatchdogCandidates('unbound-devspace-ownership-resolved')
    return binding
  }

  const handleDevSpaceAuditEvent = async (event) => {
    devSpaceAuditsObserved += 1
    devSpaceLastAuditAt = Math.max(Number(devSpaceLastAuditAt || 0), event.startedAtMs)
    const traceId = devSpaceTraceIdFromRequestMetaJson(event.requestMetaJson)
    if (traceId) {
      const traceObserveStartedAt = performance.now()
      const traceRow = runControlPlaneStage('devspace-audit:observe-trace', () => archive.observeDevSpaceTraceTurn({
        traceId,
        metadataId: event.metadataId,
        auditId: event.id,
        observedAt: event.startedAtMs,
      }))
      const traceObserveMs = performance.now() - traceObserveStartedAt
      if (traceObserveMs >= 50) {
        void log('slow Archive control-plane DB profile', {
          operation: 'devspace-trace-observe',
          totalMs: traceObserveMs,
          traceId,
          metadataId: event.metadataId,
          auditId: event.id,
          status: traceRow?.status ?? null,
        })
      }
    }
    const metadataState = runControlPlaneStage('devspace-audit:metadata-state', () =>
      devSpaceAuditBridge.metadataToolState(event.metadataId))
    await yieldControlPlane()
    const binding = runControlPlaneStage('devspace-audit:observe-metadata', () => archive.observeDevSpaceMetadata({
      metadataId: event.metadataId,
      auditId: event.id,
      auditAt: event.startedAtMs,
      displayTitle: metadataState?.title ?? null,
    }))
    await yieldControlPlane()
    // begin 事件会看到 runningTools>0 并立即取消旧 idle generation。
    // finish 事件即使 auditId 已经见过，也会由 wake callback 额外按 metadata 重读。
    runControlPlaneStage('devspace-audit:idle-refresh', () =>
      refreshDevSpaceIdleCandidate(event.metadataId, Date.now(), metadataState))
    await yieldControlPlane()
    runControlPlaneStage('devspace-audit:progress-notification', () =>
      dispatchDevSpaceProgressNotification(event))
    await yieldControlPlane()
    // binding 尚未建立时也立即写 synthetic provisional conversation；一旦绑定再原位迁移。
    await runControlPlaneStage('devspace-audit:recovery-upsert', () =>
      persistDevSpaceRecoveryAudit(event, binding))
    await yieldControlPlane()
    if (binding.conversationId) {
      runControlPlaneStage('devspace-audit:activate-bound-turn', () =>
        activateBoundDevSpaceTurn(binding, event.startedAtMs, traceId))
      await yieldControlPlane()
      return
    }

    // binding exact-match/rebind 不能留在 audit 热路径同步执行；它可能触发较大的 SQLite
    // 扫描/镜像。先登记工作，让 first-tool Watchdog 与 durable cursor 立即继续推进。
    queueDevSpaceBindingWorkForAudit(event)
    await yieldControlPlane()

    const current = unboundDevSpaceTurns.get(event.metadataId)
    const persistedStartAt = Number(binding.firstSeenAt || event.startedAtMs)
    const generationRestarted = Boolean(current && persistedStartAt > Number(current.startedAt || 0))
    const nextCandidate = {
      startedAt: generationRestarted ? persistedStartAt : (current?.startedAt ?? persistedStartAt),
      lastEventAt: Math.max(Number(current?.lastEventAt || 0), event.startedAtMs),
      lastAuditId: event.id,
      repairQueuedAt: generationRestarted ? null : (current?.repairQueuedAt ?? null),
    }
    unboundDevSpaceTurns.set(event.metadataId, nextCandidate)
    if (!current || generationRestarted) {
      const title = binding.displayTitle ?? metadataState?.title ?? null
      dispatchUnboundWatchdogStartNotification(event.metadataId, nextCandidate, title)
      void log('DevSpace first tool started unbound watchdog', {
        metadataId: event.metadataId,
        startedAt: nextCandidate.startedAt,
        titlePresent: Boolean(String(title || '').trim()),
      })
    }
  }

  /**
   * durable audit backlog 的 cooperative continuation。
   *
   * 不能在当前调用栈里递归继续消费，否则虽然“拆成批次”，本质仍然不给 HTTP/WSS/timer
   * 调度机会。setImmediate 会把续批放到下一轮 event loop；scheduled 标记同时避免 UDP wake、
   * 60s fallback 和前一批 continuation 重复堆出多个 drain。
   */
  const scheduleDevSpaceAuditPoll = () => {
    if (devSpaceAuditPollScheduled || stopping) return
    devSpaceAuditPollScheduled = true
    setImmediate(() => {
      devSpaceAuditPollScheduled = false
      void pollDevSpaceAudits().catch(error => {
        void log('scheduled DevSpace audit poll failed', {
          error: error instanceof Error ? error.message : String(error),
        }).catch(() => {})
      })
    })
  }

  /**
   * 每次只消费一个很小的 durable audit 批次。
   *
   * durable cursor 仍然保持原语义：一条 event 必须完整 handle 成功后才推进。若某条处理中
   * 抛错，本批立即停止，下一次 wake/fallback 从上一条已成功 cursor 继续，不会为了“让路”
   * 牺牲 exactly-once-like 的本地恢复边界。
   */
  const pollDevSpaceAudits = async () => {
    if (stopping) return 0
    // UDP start/finish、fallback 与 cooperative continuation 可能同时要求 poll。
    // 旧同步实现可以简单 return 0；异步分段后调用方需要能够真正等到前一轮完成，
    // 否则 finish recovery refresh 会在 start audit 尚未持久化时抢跑。
    while (devSpaceAuditPollInFlight && !stopping) await yieldControlPlane()
    if (stopping) return 0
    devSpaceAuditPollInFlight = true
    const batchStartedAt = performance.now()
    let observed = 0
    try {
      const events = runControlPlaneStage('devspace-audit:poll', () => (
        devSpaceAuditCursor
          ? devSpaceAuditBridge.pollAfter({
              startedAt: devSpaceAuditCursor.startedAt,
              auditId: devSpaceAuditCursor.auditId,
            }, DEVSPACE_AUDIT_BATCH_SIZE)
          : devSpaceAuditBridge.pollSince(0, DEVSPACE_AUDIT_BATCH_SIZE)
      ))

      for (const event of events) {
        // 必须先完整处理，再推进 durable cursor。若中途抛错，下次从上一条高水位安全重放。
        await handleDevSpaceAuditEvent(event)
        await yieldControlPlane()
        devSpaceAuditCursor = runControlPlaneStage('devspace-audit:advance-cursor', () => archive.advanceDevSpaceAuditCursor({
          consumerKey: DEVSPACE_AUDIT_CONSUMER_KEY,
          startedAt: event.startedAt,
          auditId: event.id,
        }))
        observed += 1
        await yieldControlPlane()
      }

      devSpaceLastPollAt = Date.now()
      devSpaceLastError = null
      devSpaceAuditPollBatches += 1
      devSpaceAuditLastBatchCount = observed

      // 满批说明“很可能还有 backlog”。这里只登记一个下一轮 continuation，绝不当前栈继续扫。
      if (events.length === DEVSPACE_AUDIT_BATCH_SIZE) {
        devSpaceAuditPollYields += 1
        scheduleDevSpaceAuditPoll()
      }
      return observed
    }
    catch (error) {
      devSpaceLastError = error instanceof Error ? error.message : String(error)
      return 0
    }
    finally {
      const elapsedMs = performance.now() - batchStartedAt
      devSpaceAuditLastBatchMs = elapsedMs
      devSpaceAuditMaxBatchMs = Math.max(devSpaceAuditMaxBatchMs, elapsedMs)
      devSpaceAuditPollInFlight = false
    }
  }

  const bootstrapDevSpaceAuditCursor = () => {
    if (devSpaceAuditCursorBootstrapped) return devSpaceAuditCursor
    const latest = devSpaceAuditBridge.latestAuditCursor()
    if (latest) {
      devSpaceAuditCursor = archive.advanceDevSpaceAuditCursor({
        consumerKey: DEVSPACE_AUDIT_CONSUMER_KEY,
        startedAt: latest.startedAt,
        auditId: latest.auditId,
      })
    }
    // DevSpace DB 为空也只 bootstrap 一次。之后第一条 audit 会由 pollSince(0) 消费并建立游标。
    devSpaceAuditCursorBootstrapped = true
    return devSpaceAuditCursor
  }

  /**
   * cursor 只追踪 INSERT 时的 started_at；同一 audit 的 finish 是 UPDATE，不会再次越过 cursor。
   * 因此 daemon 重启/低频兜底要按 recovery 中尚未 finished 的 audit id 重读最终行。
   */
  const refreshPendingDevSpaceRecoveryAudits = async ({ collectMetadataIds = false } = {}) => {
    let refreshed = 0
    const metadataIds = new Set()
    for (const auditId of archive.listPendingDevSpaceRecoveryAuditIds(1000)) {
      // startup 需要知道“哪些 metadata 可能在 daemon 离线期间 finish 了”。
      // 既然这里本来就要按 pending audit-id 精确重读最终行，就顺手复用这份 event；
      // 不要再额外全表扫描 DevSpace tool_audit 去猜最近 finished_at。
      const event = devSpaceAuditBridge.auditById(auditId)
      if (!event) continue
      if (event.metadataId) metadataIds.add(event.metadataId)
      if (await persistDevSpaceRecoveryAudit(event)) refreshed += 1
    }
    return collectMetadataIds
      ? { refreshed, metadataIds: [...metadataIds] }
      : refreshed
  }

  /**
   * 对一个已经落盘的 ChatGPT turn 做 DevSpace binding。
   *
   * 关键点：不再用“时间窗里只有一个 metadata”判断身份。body 里的 api_tool.call_tool
   * 本来就保存了 DevSpace tool 名和完整 args；tool_audit 也保存同一份 args，因此用
   * canonical exact-match + 同 fingerprint 的局部时间一致性判断身份。
   */
  const readDevSpaceTurnEvidenceFromStoredTurn = async (conversationId, turnExchangeId) => {
    const workerStartedAt = performance.now()
    const rows = await archiveMergeWorker.readTurnToolCalls(conversationId, turnExchangeId)
    const workerMs = performance.now() - workerStartedAt
    const buildStartedAt = performance.now()
    const bodyCalls = rows
      .map(row => parseDevSpaceBodyToolCall(String(row.text || ''), Number(row.createTime) * 1000))
      .filter(Boolean)
    if (bodyCalls.length === 0) return null

    const startAt = Math.min(...bodyCalls.map(call => call.startedAtMs))
    const endAt = Math.max(...bodyCalls.map(call => call.startedAtMs))
    const requestId = rows.find(row => typeof row.requestId === 'string' && row.requestId)?.requestId ?? null
    const revision = createHash('sha256')
      .update(bodyCalls.map(call =>
        String(call.startedAtMs) + '\\n'
        + String(devSpaceToolArgsFingerprint(call.tool, call.argsJson) ?? ''),
      ).join('\\n--\\n'))
      .digest('hex')
    return {
      bodyCalls,
      startAt,
      endAt,
      requestId,
      revision,
      workerMs,
      buildMs: performance.now() - buildStartedAt,
    }
  }

  const matchDevSpaceBindingFromStoredTurn = (conversationId, turnExchangeId, storedEvidence) => {
    const evidence = storedEvidence
    if (!evidence) return null
    const { bodyCalls, startAt, endAt } = evidence
    const activities = devSpaceAuditBridge.activityBetween(startAt - 120_000, endAt + 120_000, 5000)
    const match = matchDevSpaceCandidateForTurn({
      activities,
      bodyCalls,
      alreadyBoundMetadataIds: [],
    })
    if (!match) return null
    const traceIds = matchingDevSpaceTraceIdsForTurn({
      activity: match.activity,
      bodyCalls,
    })

    const provisional = unboundDevSpaceTurns.get(match.activity.metadataId)
    return {
      metadataId: match.activity.metadataId,
      startAt: provisional?.startedAt ?? match.activity.firstAt,
      exactMatches: match.exactMatches,
      uniqueMatches: match.uniqueMatches,
      traceIds,
    }
  }

  const verifyMatchedDevSpaceTraceTurn = ({
    candidate,
    storedEvidence,
    conversationId,
    turnExchangeId,
    observedAt = Date.now(),
  }) => {
    const traceIds = Array.isArray(candidate?.traceIds) ? candidate.traceIds : []
    if (traceIds.length !== 1) {
      if (traceIds.length > 1) {
        void log('DevSpace canonical turn matched multiple trace ids; trace identity left provisional', {
          metadataId: candidate?.metadataId ?? null,
          conversationId,
          turnExchangeId,
          traceIds,
        })
      }
      return null
    }
    const row = archive.verifyDevSpaceTraceTurn({
      traceId: traceIds[0],
      metadataId: candidate.metadataId,
      conversationId,
      turnExchangeId,
      requestId: storedEvidence?.requestId ?? null,
      verifiedAt: observedAt,
    })
    if (row?.status === 'conflict') {
      void log('DevSpace trace/turn identity conflict detected', {
        traceId: row.traceId,
        metadataId: row.metadataId,
        conversationId,
        turnExchangeId,
        conflictReason: row.conflictReason,
      })
    }
    return row
  }

  /**
   * 旧版本因为“并发时必须只有一个 metadata”过于保守，留下了一批本可确定的 unbound。
   * 启动时做一次批量本地回填：
   * - DevSpace SQLite 只读一次时间段；
   * - Archive messages 只读一次时间段；
   * - 之后全部在内存里按 turn 做 exact tool+args matching。
   *
   * 这样复杂度来自“本次少量 tool call 的纯内存比较”，不会再出现逐 turn 重复查两个 SQLite
   * 导致启动 CPU 飙高的问题。只有同一 metadata 的所有可信命中都落在同一个 conversation，
   * 才持久化 binding。
   */
  const bindDevSpaceCandidateFromStoredTurn = async ({
    conversationId,
    turnExchangeId,
    requestId = null,
    candidate,
    evidence,
    observedAt = Date.now(),
  }) => {
    await bindDevSpaceMetadataToConversation({
      metadataId: candidate.metadataId,
      conversationId,
      startAt: candidate.startAt,
      observedAt,
      turnExchangeId,
      requestId,
      evidence,
      confidence: 'high',
      lifecycleState: activeTurns.has(conversationId) || unboundDevSpaceTurns.has(candidate.metadataId)
        ? 'active'
        : 'closed',
    })
    void log('DevSpace metadata exact-match binding confirmed', {
      metadataId: candidate.metadataId,
      conversationId,
      turnExchangeId,
      exactMatches: candidate.exactMatches,
      uniqueMatches: candidate.uniqueMatches,
      evidence,
    })
  }

  const metadataRevisionForEvidence = evidence => {
    const rows = archive.db.prepare(
      'SELECT metadata_id AS metadataId, last_audit_id AS lastAuditId, last_seen_at AS lastSeenAt '
      + 'FROM devspace_metadata_bindings '
      + 'WHERE conversation_id IS NULL AND first_seen_at <= ? AND last_seen_at >= ? '
      + 'ORDER BY metadata_id ASC',
    ).all(
      Number(evidence.lastToolAt) + 120_000,
      Math.max(0, Number(evidence.firstToolAt) - 120_000),
    )
    if (rows.length === 0) return 'none'
    return createHash('sha256')
      .update(rows.map(row =>
        String(row.metadataId || '') + '\n'
        + String(row.lastAuditId || '') + '\n'
        + String(row.lastSeenAt || 0),
      ).join('\n--\n'))
      .digest('hex')
  }

  const attemptDevSpaceBindingQueueEvidence = async (queueRow, { source = 'queue' } = {}) => {
    if (!queueRow || queueRow.status !== 'pending') return false
    const profileStartedAt = performance.now()
    const profile = {
      evidenceWorkerMs: 0,
      evidenceBuildMs: 0,
      metadataRevisionMs: 0,
      matchMs: 0,
      bindingReadMs: 0,
      durableMarkMs: 0,
      traceVerifyMs: 0,
      bindMs: 0,
    }
    const logProfile = (outcome) => {
      const totalMs = performance.now() - profileStartedAt
      if (totalMs < 50) return
      const syncProfileMs = profile.evidenceBuildMs
        + profile.metadataRevisionMs
        + profile.matchMs
        + profile.bindingReadMs
        + profile.durableMarkMs
        + profile.traceVerifyMs
      void log(
        syncProfileMs >= 50
          ? 'slow Archive control-plane DB profile'
          : 'slow Archive binding worker item',
        {
        operation: 'devspace-binding-item',
        outcome,
        totalMs,
        syncProfileMs,
        ...profile,
        source,
        conversationId: queueRow.conversationId,
        turnExchangeId: queueRow.turnExchangeId,
        },
      )
    }

    let phaseStartedAt = performance.now()
    const storedEvidence = await readDevSpaceTurnEvidenceFromStoredTurn(
      queueRow.conversationId,
      queueRow.turnExchangeId,
    )
    profile.evidenceWorkerMs = Number(storedEvidence?.workerMs || 0)
    profile.evidenceBuildMs = Number(storedEvidence?.buildMs || 0)
    if (!storedEvidence) {
      logProfile('no-stored-evidence')
      return false
    }

    phaseStartedAt = performance.now()
    const metadataRevision = metadataRevisionForEvidence({
      firstToolAt: storedEvidence.startAt,
      lastToolAt: storedEvidence.endAt,
    })
    profile.metadataRevisionMs = performance.now() - phaseStartedAt
    if (queueRow.lastAttemptEvidenceRevision === storedEvidence.revision
      && queueRow.lastAttemptMetadataRevision === metadataRevision) {
      logProfile('unchanged-revision')
      return false
    }

    devSpaceBindingQueueAttempts += 1
    phaseStartedAt = performance.now()
    const candidate = matchDevSpaceBindingFromStoredTurn(
      queueRow.conversationId,
      queueRow.turnExchangeId,
      storedEvidence,
    )
    profile.matchMs = performance.now() - phaseStartedAt
    if (!candidate) {
      phaseStartedAt = performance.now()
      archive.markDevSpaceBindingTurnEvidenceAttempt(
        queueRow.conversationId,
        queueRow.turnExchangeId,
        Date.now(),
        storedEvidence.revision,
        metadataRevision,
      )
      profile.durableMarkMs = performance.now() - phaseStartedAt
      logProfile('no-candidate')
      return false
    }

    phaseStartedAt = performance.now()
    const existingBinding = archive.getDevSpaceMetadataBinding(candidate.metadataId)
    profile.bindingReadMs = performance.now() - phaseStartedAt
    const observedAt = Date.now()
    if (existingBinding?.conversationId) {
      if (existingBinding.conversationId !== queueRow.conversationId) {
        phaseStartedAt = performance.now()
        archive.markDevSpaceBindingTurnEvidenceAttempt(
          queueRow.conversationId,
          queueRow.turnExchangeId,
          observedAt,
          storedEvidence.revision,
          metadataRevision,
        )
        profile.durableMarkMs = performance.now() - phaseStartedAt
        void log('DevSpace matching queue rejected cross-conversation bound candidate', {
          source,
          metadataId: candidate.metadataId,
          boundConversationId: existingBinding.conversationId,
          evidenceConversationId: queueRow.conversationId,
          turnExchangeId: queueRow.turnExchangeId,
        })
        logProfile('cross-conversation-bound-candidate')
        return false
      }

      phaseStartedAt = performance.now()
      archive.markDevSpaceBindingTurnEvidenceMatched({
        conversationId: queueRow.conversationId,
        turnExchangeId: queueRow.turnExchangeId,
        metadataId: candidate.metadataId,
        matchedAt: observedAt,
        evidenceRevision: storedEvidence.revision,
        metadataRevision,
      })
      profile.durableMarkMs = performance.now() - phaseStartedAt
      phaseStartedAt = performance.now()
      verifyMatchedDevSpaceTraceTurn({
        candidate,
        storedEvidence,
        conversationId: queueRow.conversationId,
        turnExchangeId: queueRow.turnExchangeId,
        observedAt,
      })
      profile.traceVerifyMs = performance.now() - phaseStartedAt
      devSpaceBindingQueueMatches += 1
      logProfile('matched-existing-binding')
      return true
    }

    phaseStartedAt = performance.now()
    await bindDevSpaceCandidateFromStoredTurn({
      conversationId: queueRow.conversationId,
      turnExchangeId: queueRow.turnExchangeId,
      candidate,
      evidence: 'body:exact-tool-args-matching-queue',
      observedAt,
    })
    profile.bindMs = performance.now() - phaseStartedAt
    phaseStartedAt = performance.now()
    archive.markDevSpaceBindingTurnEvidenceMatched({
      conversationId: queueRow.conversationId,
      turnExchangeId: queueRow.turnExchangeId,
      metadataId: candidate.metadataId,
      matchedAt: observedAt,
      evidenceRevision: storedEvidence.revision,
      metadataRevision,
    })
    profile.durableMarkMs = performance.now() - phaseStartedAt
    phaseStartedAt = performance.now()
    verifyMatchedDevSpaceTraceTurn({
      candidate,
      storedEvidence,
      conversationId: queueRow.conversationId,
      turnExchangeId: queueRow.turnExchangeId,
      observedAt,
    })
    profile.traceVerifyMs = performance.now() - phaseStartedAt
    devSpaceBindingQueueMatches += 1
    void log('DevSpace matching queue consumed canonical turn evidence', {
      source,
      metadataId: candidate.metadataId,
      conversationId: queueRow.conversationId,
      turnExchangeId: queueRow.turnExchangeId,
      exactMatches: candidate.exactMatches,
      uniqueMatches: candidate.uniqueMatches,
    })
    logProfile('matched-new-binding')
    return true
  }

  const enqueueStoredDevSpaceTurnEvidence = async (
    conversationId,
    turnExchangeId,
    {
      observedAt = Date.now(),
      force = false,
      source = 'canonical-ingress',
    } = {},
  ) => {
    const storedEvidence = await readDevSpaceTurnEvidenceFromStoredTurn(conversationId, turnExchangeId)
    if (!storedEvidence) return { queued: false, matched: false }

    const metadataRevision = metadataRevisionForEvidence({
      firstToolAt: storedEvidence.startAt,
      lastToolAt: storedEvidence.endAt,
    })
    const recentEvidence = Math.abs(Number(observedAt) - Number(storedEvidence.endAt)) <= 10 * 60_000
    if (!force && !recentEvidence && metadataRevision === 'none') {
      return { queued: false, matched: false }
    }

    const queued = archive.upsertDevSpaceBindingTurnEvidence({
      conversationId,
      turnExchangeId,
      firstToolAt: storedEvidence.startAt,
      lastToolAt: storedEvidence.endAt,
      toolCallCount: storedEvidence.bodyCalls.length,
      evidenceRevision: storedEvidence.revision,
      observedAt,
    })
    if (queued.created) devSpaceBindingQueueEnqueued += 1
    if (queued.row.status !== 'pending') return { queued: true, matched: true }

    // Canonical ingress 只负责发布 durable evidence；绝不能在 Body/SSE/passive callback 里
    // 现场跑 exact matcher。旧实现虽然已有 Matching Queue 表，却在 enqueue 后立刻同步
    // attempt，一次 Body 最多枚举 64 个 turn，仍会把主事件循环堵到秒级。
    // 真正匹配统一交给 cooperative binding worker，每 tick 最多处理一条。
    const key = `${queued.row.conversationId}:${queued.row.turnExchangeId}`
    devSpaceBindingEvidenceWork.set(key, queued.row)
    scheduleDevSpaceBindingWorker()
    return { queued: true, matched: false }
  }

  const publishCanonicalDevSpaceBindingEvidence = async (
    conversationId,
    {
      turnExchangeId = null,
      excludeTurnExchangeId = null,
      observedAt = Date.now(),
      maxTurns = 64,
      source = 'canonical-ingress',
    } = {},
  ) => {
    let queued = 0
    let matched = 0
    const handled = new Set()

    const publishTurn = async (candidateTurnExchangeId, force = false) => {
      const id = String(candidateTurnExchangeId || '')
      if (!id || handled.has(id) || id === excludeTurnExchangeId) return
      handled.add(id)
      const result = await enqueueStoredDevSpaceTurnEvidence(conversationId, id, {
        observedAt,
        force,
        source,
      })
      if (result.queued) queued += 1
      if (result.matched) matched += 1
    }

    if (turnExchangeId) await publishTurn(turnExchangeId, true)

    const turns = archive.db.prepare(
      "SELECT turn_exchange_id AS turnExchangeId, MAX(ordinal) AS lastOrdinal "
      + "FROM messages INDEXED BY messages_conversation_ordinal "
      + "WHERE conversation_id=? AND turn_exchange_id IS NOT NULL "
      + "AND recipient='api_tool.call_tool' AND text<>'' "
      + "GROUP BY turn_exchange_id ORDER BY lastOrdinal DESC LIMIT ?",
    ).all(conversationId, Math.max(1, Math.min(256, Number(maxTurns) || 64)))
    for (const row of turns) await publishTurn(row.turnExchangeId, false)

    return { queued, matched }
  }

  const scheduleDevSpaceBindingWorker = () => {
    if (devSpaceBindingWorkerScheduled || devSpaceBindingWorkerInFlight || stopping) return
    devSpaceBindingWorkerScheduled = true
    setImmediate(() => {
      devSpaceBindingWorkerScheduled = false
      void runDevSpaceBindingWorker().catch(error => {
        void log('DevSpace binding worker failed', {
          error: error instanceof Error ? error.message : String(error),
        })
      })
    })
  }

  const queueDevSpaceBindingWorkForAudit = event => {
    if (!event?.id) return false
    devSpaceBindingAuditWork.set(event.id, {
      id: event.id,
      startedAtMs: Number(event.startedAtMs),
    })
    scheduleDevSpaceBindingWorker()
    return true
  }

  const runDevSpaceBindingWorker = async () => {
    if (stopping || devSpaceBindingWorkerInFlight) return
    devSpaceBindingWorkerInFlight = true
    const itemStartedAt = performance.now()
    try {
      // Exact matching still handles at most one item per cooperative run. If a new binding needs
      // recovery backfill, that work awaits the shared Archive writer worker instead of blocking
      // the daemon event loop.
      const evidenceEntry = devSpaceBindingEvidenceWork.entries().next()
      if (!evidenceEntry.done) {
        const [key, row] = evidenceEntry.value
        devSpaceBindingEvidenceWork.delete(key)
        await runControlPlaneStage('devspace-binding-item', () =>
          attemptDevSpaceBindingQueueEvidence(row, { source: 'devspace-audit-worker' }))
      }
      else {
        const auditEntry = devSpaceBindingAuditWork.entries().next()
        if (!auditEntry.done) {
          const [auditId, event] = auditEntry.value
          devSpaceBindingAuditWork.delete(auditId)
          const rows = runControlPlaneStage('devspace-binding-audit-scan', () => archive.listPendingDevSpaceBindingTurnEvidence({
            overlapStartAt: Math.max(0, Number(event.startedAtMs) - 120_000),
            overlapEndAt: Number(event.startedAtMs) + 120_000,
            limit: 256,
          }))
          for (const row of rows) {
            const key = `${row.conversationId}:${row.turnExchangeId}`
            devSpaceBindingEvidenceWork.set(key, row)
          }
        }
      }
    }
    finally {
      devSpaceBindingWorkerInFlight = false
      devSpaceBindingWorkerRuns += 1
      devSpaceBindingWorkerLastItemMs = performance.now() - itemStartedAt
      devSpaceBindingWorkerMaxItemMs = Math.max(
        devSpaceBindingWorkerMaxItemMs,
        devSpaceBindingWorkerLastItemMs,
      )
      if (devSpaceBindingEvidenceWork.size > 0 || devSpaceBindingAuditWork.size > 0) {
        scheduleDevSpaceBindingWorker()
      }
      else {
        flushDeferredCatalogWatchdogCandidates('canonical-matching-queue-drained')
      }
    }
  }

  const queuePendingDevSpaceBindingQueue = ({ limit = 1000 } = {}) => {
    const rows = archive.listPendingDevSpaceBindingTurnEvidence({ limit })
    for (const row of rows) {
      const key = `${row.conversationId}:${row.turnExchangeId}`
      devSpaceBindingEvidenceWork.set(key, row)
    }
    if (rows.length > 0) scheduleDevSpaceBindingWorker()
    return rows.length
  }


  const publishHistoricalDevSpaceBindingEvidenceFromConversation = async (
    conversationId,
    { excludeTurnExchangeId = null, maxTurns = 64 } = {},
  ) => {
    return (await publishCanonicalDevSpaceBindingEvidence(conversationId, {
      excludeTurnExchangeId,
      observedAt: Date.now(),
      maxTurns,
      source: 'conversation-history',
    })).queued
  }

  const publishDevSpaceBindingEvidenceFromBody = async (conversationId, diagnostic) => runControlPlaneStage(
    'devspace-binding-publish-body',
    async () => {
    const now = Date.now()
    const turnExchangeId = typeof diagnostic?.turnExchangeId === 'string' ? diagnostic.turnExchangeId : null
    const requestId = typeof diagnostic?.requestId === 'string' ? diagnostic.requestId : null
    const existing = archive.getDevSpaceMetadataBindingsForConversation(conversationId)
    if (existing.length > 0) {
      archive.updateDevSpaceBindingTurn({
        conversationId,
        turnExchangeId,
        requestId,
        observedAt: now,
        lifecycleState: activeTurns.has(conversationId) ? 'active' : 'closed',
      })
      for (const row of archive.getDevSpaceMetadataBindingsForConversation(conversationId)) mirrorDevSpaceBinding(row)
    }

    const result = await publishCanonicalDevSpaceBindingEvidence(conversationId, {
      turnExchangeId,
      observedAt: now,
      maxTurns: 64,
      source: 'canonical-body',
    })
    if (result.queued > 0) {
      void log('DevSpace matching queue scheduled canonical body evidence', {
        conversationId,
        turnExchangeId,
        queued: result.queued,
        alreadyMatched: result.matched,
      })
    }
    },
  )

  const queueTimedOutDevSpaceBindingProbes = () => {
    const timedOutEntries = [...pendingUnboundWatchdogDiagnoses.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
    if (timedOutEntries.length === 0) return 0

    const generation = timedOutEntries
      .map(([metadataId, pending]) => `${metadataId}:${Number(pending.watchdogAt)}`)
      .join('|')
    const candidateConversationIds = new Set([
      ...activeTurns.keys(),
      ...catalogActive.keys(),
    ])
    const plan = planDevSpaceBindingProbes({
      generation,
      previousGeneration: devSpaceBindingProbeGeneration,
      probedConversationIds: devSpaceBindingProbedConversationIds,
      candidateConversationIds,
    })
    devSpaceBindingProbeGeneration = plan.generation
    devSpaceBindingProbedConversationIds = plan.probedConversationIds
    for (const conversationId of plan.targets) {
      markSyncReady(conversationId, 'devspace:binding-probe', 0)
    }
    if (plan.targets.length > 0) {
      void log('queued bounded DevSpace binding body probes after catalog repair', {
        generationCount: timedOutEntries.length,
        targetCount: plan.targets.length,
        conversationIds: plan.targets,
      })
    }
    return plan.targets.length
  }

  const checkUnboundDevSpaceTimeouts = () => {
    const now = Date.now()
    for (const [metadataId, candidate] of [...unboundDevSpaceTurns.entries()]) {
      const currentBinding = archive.getDevSpaceMetadataBinding(metadataId)
      if (currentBinding?.conversationId) {
        unboundDevSpaceTurns.delete(metadataId)
        pendingUnboundWatchdogDiagnoses.delete(metadataId)
        flushDeferredCatalogWatchdogCandidates('durable-binding-cleared-unbound-candidate')
        void log('stale unbound watchdog candidate cleared after durable binding', {
          metadataId,
          conversationId: currentBinding.conversationId,
        })
        continue
      }
      if (now - Number(candidate.startedAt) < watchdogMs) continue

      const startedAt = Number(candidate.startedAt || currentBinding?.firstSeenAt || now)
      archive.markDevSpaceUnboundWatchdog(metadataId, now)
      const diagnosisKey = unboundWatchdogDiagnosisNotificationKey(metadataId, startedAt)
      if (!archive.hasTurnNotification(diagnosisKey) && !pendingUnboundWatchdogDiagnoses.has(metadataId)) {
        pendingUnboundWatchdogDiagnoses.set(metadataId, {
          metadataId,
          startedAt,
          watchdogAt: now,
          title: currentBinding?.displayTitle ?? devSpaceAuditBridge.metadataToolState(metadataId)?.title ?? null,
          catalogRepairCompletedAt: null,
        })
      }
      // CID 还没解出来也不能静默：先告诉用户“Watchdog 已到点但当前无法安全定位聊天”。
      // 持久 notification key 保证这个 provisional 事件跨循环/重启只成功发送一次。
      enqueueLifeOpsUnboundWatchdog(metadataId, candidate, now)
      dispatchUnboundWatchdogNotification(metadataId, candidate, now)
      void log('unbound DevSpace watchdog exceeded threshold; generation completed and queued catalog repair', {
        metadataId,
        activeForMs: now - startedAt,
      })
      // 45m 到点后这代 provisional generation 立即结束。CID 解析/Body 诊断由上面的
      // pendingUnboundWatchdogDiagnoses 独立持有；后续真实 audit 会从新的 first_seen_at 起表。
      unboundDevSpaceTurns.delete(metadataId)
      void scheduleGapRepair('devspace-unbound-timeout')
    }
  }

  const decodeCdpJsonResponseBody = async (client, requestId) => {
    const result = await client.send('Network.getResponseBody', { requestId }, 5000)
    const text = result.base64Encoded
      ? Buffer.from(String(result.body || ''), 'base64').toString('utf8')
      : String(result.body || '')
    return text ? JSON.parse(text) : null
  }

  const rememberPassiveBodyResponse = async ({ route, payload, capturedAt, requestUrl, targetId }) => {
    const conversationId = route.conversationId
    if (!conversationId) return

    if (route.kind === 'mapping') {
      if (!payload?.mapping || typeof payload.mapping !== 'object') return
      const observationKind = 'mapping-snapshot:passive-native'
      const endpoint = `/backend-api/conversation/${conversationId}`
      const evidence = await prepareObservationEvidence({
        payload,
        conversationId,
        observationKind,
        endpoint,
        observedAt: capturedAt,
      })
      await archiveMergeWorker.mergeMapping(payload, {
        observedAt: capturedAt,
        endpoint,
        observationKind,
        preparedObservation: evidence.preparedObservation,
        skipLegacyObservation: evidence.skipLegacyObservation,
      })
      // mapping snapshot 同样是 canonical conversation ingress。它可能是页面恢复时唯一自然
      // 发出的 conversation 请求；如果这里只 merge 不 reconcile，已经落库的 tool calls 仍会
      // 永久保持 unbound。mapping 没有稳定的 latest-turn diagnostic，因此对该 CID 做 bounded
      // historical exact retry。
      await publishHistoricalDevSpaceBindingEvidenceFromConversation(conversationId, { maxTurns: 64 })
      passiveBodyResponses += 1
      return
    }

    if (!Array.isArray(payload?.messages)) return
    const normalized = { ...payload, conversation_id: payload.conversation_id || conversationId }
    const ids = normalized.messages.map(message => message?.id).filter(id => typeof id === 'string')
    const knownBefore = archive.knownMessageIds(conversationId, ids)
    const cursor = route.kind === 'body-cursor' ? route.before : null
    passiveBodyPages.set(passiveBodyKey(conversationId, cursor), {
      payload: normalized,
      capturedAt,
      knownBeforeIds: [...knownBefore],
      sourceTargetId: targetId,
      requestUrl,
    })
    passiveBodyResponses += 1

    if (route.kind === 'body-latest') {
      const observationKind = 'body-page:passive-native'
      const endpoint = `/backend-api/conversations/${conversationId}`
      const observationPrepareStartedAt = performance.now()
      const evidence = await prepareObservationEvidence({
        payload: normalized,
        conversationId,
        observationKind,
        endpoint,
        observedAt: capturedAt,
      })
      const asyncObservationPrepareMs = performance.now() - observationPrepareStartedAt
      const passiveMerged = await archiveMergeWorker.mergeMessages(normalized, {
        observedAt: capturedAt,
        endpoint,
        pageCursor: null,
        observationKind,
        preserveObservedTextPrefix: true,
        updateCurrentState: true,
        classifyCompletionIncident: false,
        allowIncompleteTailIncident: false,
        incidentKind: 'abnormal-terminal',
        preparedObservation: evidence.preparedObservation,
        skipLegacyObservation: evidence.skipLegacyObservation,
      })
      if (Number(passiveMerged.timings?.totalMs || 0) >= 100) {
        await log('slow canonical merge profile', {
          conversationId,
          trigger: 'passive-native',
          pageMessages: passiveMerged.pageMessageCount,
          newMessages: passiveMerged.newMessageCount,
          asyncObservationPrepareMs,
          ...passiveMerged.timings,
        })
      }
      // 第一方页面自然拿到的 latest Body 也是 canonical ingress。过去这里只 merge SQLite，
      // 没有触发 binding reconcile，导致“Body 已在库里但 metadata 仍 unbound”。
      const passiveDiagnostic = diagnoseLatestRun(normalized)
      await publishDevSpaceBindingEvidenceFromBody(conversationId, passiveDiagnostic)
      // post-completion candidate 若正等 Body 身份确认，优先复用页面自然产生的 Body，零额外请求。
      // publish 可能刚在这一份 Body 上完成 late binding 并补出 candidate，因此必须排在 publish 后。
      completePostCompletionDevSpaceCandidate(conversationId, {
        diagnostic: passiveDiagnostic,
        bodyTurnStartedAt: watchdogTurnStartedAtFromPayload(normalized, passiveDiagnostic),
      }, capturedAt)
      const recoverySuperseded = reconcileDevSpaceRecoveryWithCanonical(conversationId, normalized)
      if (recoverySuperseded > 0) {
        void log('passive canonical body superseded DevSpace recovery overlay', {
          conversationId,
          recoverySuperseded,
        })
      }

      const readyAt = readySince.get(conversationId)
      if (readyAt && passiveObservationMatchesReady(capturedAt, readyAt)) {
        // 页面自己已经把本次 ready 之后的 body 拿回来了；cooldown 只禁止主动 HTTP，
        // 不禁止使用已经到手的 passive 数据继续 overlap/terminal merge。
        readyNotBefore.set(conversationId, Date.now())
        void drainDirty()
      }
    }
    else {
      const readyAt = readySince.get(conversationId)
      if (readyAt && passiveObservationMatchesReady(capturedAt, readyAt)) {
        // cursor 页也可能正好补上上一次 passive latest 所缺的历史页；立即唤醒本地状态机。
        readyNotBefore.set(conversationId, Date.now())
        void drainDirty()
      }
    }
  }

  const observeProjectCatalogConversations = async ({
    conversations,
    reason,
    observedAt = Date.now(),
    minConversationUpdateAtMs = null,
  }) => {
    let dirtyCount = 0
    let activeCount = 0
    let completeCount = 0

    for (const item of conversations || []) {
      const id = typeof item?.id === 'string'
        ? item.id
        : typeof item?.conversation_id === 'string' ? item.conversation_id : null
      if (!id) continue

      const asyncState = classifyCatalogAsyncStatus(item.async_status)
      const serverUpdate = chatgptTime(item.update_time)
      const serverUpdateMs = serverUpdate === null ? null : serverUpdate * 1000
      if (asyncState !== 'active'
        && Number.isFinite(Number(minConversationUpdateAtMs))
        && serverUpdateMs !== null
        && serverUpdateMs < Number(minConversationUpdateAtMs)) {
        continue
      }
      const now = Math.max(Number(observedAt) || Date.now(), Date.now())
      const wasCatalogActive = catalogActive.has(id)
      if (asyncState === 'active') {
        activeCount += 1
        const current = catalogActive.get(id)
        const nextUpdateTime = item.update_time ?? null
        const catalogProgressed = Boolean(
          current
          && nextUpdateTime !== null
          && String(nextUpdateTime) !== String(current.updateTime ?? ''),
        )
        const observationStartedAt = catalogObservationStartedAt(current, nextUpdateTime, now)
        catalogActive.set(id, {
          firstSeenAt: observationStartedAt,
          lastSeenAt: now,
          asyncStatus: item.async_status,
          updateTime: nextUpdateTime,
        })
        const archived = archive.db.prepare(
          'SELECT update_time AS updateTime, terminal_state AS bodyCompletionState FROM conversations WHERE id = ?',
        ).get(id)
        const catalogObservationCompleted = archive.hasCatalogWatchdogCompleted(id, item.update_time ?? null)
        const shouldStartCatalogGeneration = shouldStartCatalogWatchdog({
          alreadyActive: activeTurns.has(id),
          catalogObservationCompleted,
          catalogUpdateTime: item.update_time ?? null,
          archivedUpdateTime: archived?.updateTime ?? null,
          archivedBodyCompletionState: archived?.bodyCompletionState ?? null,
        })
        if (shouldStartCatalogGeneration) {
          // Catalog 只负责发现“这个 CID 有新的 active observation”。先走正常 Body sync；
          // Body 到达后再决定是合并到已有 metadata generation、启动独立 catalog Watchdog，
          // 还是只做 complete 收尾。这里不提前发 New Chat。
          queueDeferredCatalogWatchdogCandidate({
            conversationId: id,
            startedAt: observationStartedAt,
            lastEventAt: now,
            startType: 'project-catalog:async-active:' + reason,
            title: item.title ?? null,
            updateTime: item.update_time ?? null,
          })
        }
        else if (catalogProgressed) {
          const active = activeTurns.get(id)
          if (active && /^(?:catalog|project-catalog):/u.test(String(active.startType || ''))) {
            const progressed = recordCatalogWatchdogProgress(active, now)
            activeTurns.set(id, progressed)
            persistActiveTurn(id, progressed)
          }
        }
        markDirty(id, 'project-catalog:async-active:' + reason)
      }
      else if (asyncState === 'complete' && (wasCatalogActive || isCatalogLateActive(activeTurns.get(id)))) {
        completeCount += 1
        catalogActive.delete(id)
        dropDeferredCatalogWatchdogCandidate(id, 'project-catalog-complete')
        clearActiveTurn(id)
        stopCheckpointWatch(id, 'project-catalog:' + reason + ':async-complete', now)
        markSyncReady(id, 'project-catalog:' + reason + ':async-complete', 0)
      }

      const local = archive.db.prepare(
        'SELECT title, update_time AS updateTime FROM conversations WHERE id=?',
      ).get(id)
      const localUpdate = local?.updateTime ?? null
      const changed = !local
        || (serverUpdate !== null && (localUpdate === null || serverUpdate > Number(localUpdate) + 0.000001))
        || String(item.title || '') !== String(local?.title || '')
      if (changed) {
        dirtyCount += 1
        markSyncReady(id, 'project-catalog:' + reason, 0)
      }
    }

    return { dirtyCount, activeCount, completeCount }
  }

  const rememberPassiveProjectCatalogResponse = ({ route, payload, capturedAt, requestUrl, targetId }) => {
    passiveProjectCatalogResponses += 1
    const extracted = extractProjectCatalogPayload(route, payload)
    if (route.kind === 'project-sidebar') {
      passiveProjectSidebar = {
        payload,
        capturedAt,
        sourceTargetId: targetId,
        requestUrl,
      }
    }
    void observeProjectCatalogConversations({
      conversations: extracted.conversations,
      reason: 'passive:' + route.kind,
      observedAt: capturedAt,
      minConversationUpdateAtMs: Number(capturedAt || Date.now()) - 2 * 60 * 60_000,
    }).then((summary) => {
      if (summary.dirtyCount > 0) {
        void log('passive Project catalog discovered conversation changes', {
          kind: route.kind,
          targetId,
          projects: extracted.projects.length,
          conversations: extracted.conversations.length,
          ...summary,
        })
        void drainDirty()
      }
    }).catch(async (error) => {
      await log('passive Project catalog processing failed', {
        kind: route.kind,
        targetId,
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }

  const rememberPassiveCatalogResponse = ({ route, payload, capturedAt, requestUrl, targetId }) => {
    passiveCatalogResponses += 1
    if (!route.globalCatalog || route.limit !== 28 || !Array.isArray(payload?.items)) return
    passiveCatalogPages.set(`${route.offset}:${route.limit}`, {
      items: payload.items,
      capturedAt,
      sourceTargetId: targetId,
      requestUrl,
    })

    // native conversation list 是跨设备 active CID 的第一方 discovery 入口之一。
    // 只在明确 async active 时建立 watcher；complete 则立即撤销，避免后台继续无意义 polling。
    for (const item of payload.items) {
      const id = typeof item?.id === 'string'
        ? item.id
        : typeof item?.conversation_id === 'string' ? item.conversation_id : null
      if (!id) continue
      const asyncState = classifyCatalogAsyncStatus(item.async_status)
      if (asyncState === 'active') {
        const archived = archive.db.prepare(`
          SELECT update_time AS updateTime, terminal_state AS bodyCompletionState
          FROM conversations WHERE id = ?
        `).get(id)
        const catalogObservationCompleted = archive.hasCatalogWatchdogCompleted(id, item.update_time ?? null)
        if (shouldStartCatalogWatchdog({
          alreadyActive: checkpointWatches.has(id),
          catalogObservationCompleted,
          catalogUpdateTime: item.update_time ?? null,
          archivedUpdateTime: archived?.updateTime ?? null,
          archivedBodyCompletionState: archived?.bodyCompletionState ?? null,
        })) {
          armCheckpointWatch(id, `passive-catalog:${targetId || 'unknown'}`, capturedAt)
        }
      }
      else if (asyncState === 'complete') stopCheckpointWatch(id, 'passive-catalog-complete', capturedAt)
    }
  }

  const attachPassivePageObserver = async (target) => {
    const client = new CdpClient(target.webSocketDebuggerUrl)
   await client.connect()
   await client.send('Network.enable')
   const pendingBodies = new Map()
   const pendingImages = new Map()
    const liveTransports = new Map()
    const turnWssTrackers = new Map()
    const liveCanonicalDecoders = new Map()
    const protocolRequestSignatures = new Map()
   const pendingProtocolResponses = new Map()
    // 完整 SSE 正文与轻量 ActiveTurn trace 分离。这里按 cdpRequestId 保存当前 observer 自己的
    // append-only journal；HTTP SSE 和 turn-WSS synthetic request id 共用一套接口。
    const liveSseJournals = new Map()

    const openLiveSseJournal = (cdpRequestId, transport, startedAt = Date.now()) => {
      const key = String(cdpRequestId)
      const existing = liveSseJournals.get(key)
      if (existing) return existing
      const journal = new LiveSseJournalStream(liveSseDir, {
        targetId: String(target.id),
        cdpRequestId: key,
        transport,
        startedAt,
      })
      liveSseJournals.set(key, journal)
      liveSseJournalStarted += 1
      return journal
    }

    const appendJournalBase64 = (cdpRequestId, data) => {
      const journal = liveSseJournals.get(String(cdpRequestId))
      if (!journal || typeof data !== 'string' || !data) return
      void journal.appendBase64(data).catch(async (error) => {
        liveSseJournalErrors += 1
        await log('live SSE journal append failed', {
          targetId: target.id,
          requestId: String(cdpRequestId),
          error: error instanceof Error ? error.message : String(error),
        }).catch(() => {})
      })
    }

    const appendJournalText = (cdpRequestId, text) => {
      const journal = liveSseJournals.get(String(cdpRequestId))
      if (!journal || typeof text !== 'string' || !text) return
      void journal.appendText(text).catch(async (error) => {
        liveSseJournalErrors += 1
        await log('live SSE journal append failed', {
          targetId: target.id,
          requestId: String(cdpRequestId),
          error: error instanceof Error ? error.message : String(error),
        }).catch(() => {})
      })
    }

    const finalizeLiveSseJournal = async (cdpRequestId, mark) => {
      const key = String(cdpRequestId)
      const journal = liveSseJournals.get(key)
      if (!journal) return null
      liveSseJournals.delete(key)
      try {
        const snapshot = await journal.finalize(mark)
        liveSseJournalFinalized += 1
        liveSseJournalBytes += Number(snapshot.bytesWritten || 0)
        return snapshot
      }
      catch (error) {
        liveSseJournalErrors += 1
        await log('live SSE journal finalize failed', {
          targetId: target.id,
          requestId: key,
          error: error instanceof Error ? error.message : String(error),
        }).catch(() => {})
        return null
      }
    }

    const cleanupLiveSseJournals = async (reason = 'observer-detached') => {
      for (const requestId of [...liveCanonicalDecoders.keys()]) {
        await settleLiveCanonicalDecoder(requestId, reason)
      }
      const entries = [...liveSseJournals.entries()]
      await Promise.all(entries.map(([requestId]) => finalizeLiveSseJournal(requestId, {
        event: 'stream-observer-detached',
        detail: { reason },
      })))
      liveCanonicalDecoders.clear()
    }

    const registerLiveCanonicalDecoder = (requestId, canonical, source) => {
      const state = { canonical, source, promoted: false, partialMerged: false, mergePromise: null }
      liveCanonicalDecoders.set(String(requestId), state)
      return state
    }

    const tryPromoteLiveCanonicalDecoder = async (requestId) => {
      const key = String(requestId)
      const state = liveCanonicalDecoders.get(key)
      if (!state || state.promoted) return false
      // 先只读 snapshot 判断是否已经具备完整 SSE 自证；不完整时绝不调用 promotion helper，
      // 避免正常流中每个中间 chunk 都累计一条 fallback 遥测。
      if (!state.canonical.snapshot().complete) return false
      if (state.mergePromise) return await state.mergePromise
      const promise = (async () => {
        const promoted = await promoteCompleteLiveSse(state.canonical, state.source)
        if (!promoted) return false
        state.promoted = true
        return true
      })()
      state.mergePromise = promise
      try {
        return await promise
      }
      finally {
        if (state.mergePromise === promise) state.mergePromise = null
      }
    }

    const mergePartialLiveCanonicalDecoder = async (requestId, reason = 'incomplete-stream') => {
      const key = String(requestId)
      const state = liveCanonicalDecoders.get(key)
      if (!state || state.promoted || state.partialMerged) return false
      if (state.mergePromise) {
        const completed = await state.mergePromise
        if (completed || state.promoted || state.partialMerged) return false
      }
      const promise = (async () => {
        const merged = await mergePartialLiveSseEvidence(state.canonical, state.source, reason)
        if (!merged) return false
        state.partialMerged = true
        return true
      })()
      state.mergePromise = promise
      try {
        return await promise
      }
      finally {
        if (state.mergePromise === promise) state.mergePromise = null
      }
    }

    const settleLiveCanonicalDecoder = async (requestId, reason = 'stream-ended') => {
      if (await tryPromoteLiveCanonicalDecoder(requestId)) return 'complete'
      if (await mergePartialLiveCanonicalDecoder(requestId, reason)) return 'partial'
      return 'none'
    }

    const appendLiveTransport = (event) => {
      const key = `${target.id}:${event?.cdpRequestId ?? ''}`
      const state = activeLiveTransports.get(key)
      if (state) {
        state.conversationId = event?.conversationId ?? state.conversationId ?? null
        state.turnExchangeId = event?.turnExchangeId ?? state.turnExchangeId ?? null
        state.lastControlAt = event?.at ?? Date.now()
        state.lastControlEvent = event?.event ?? null
        state.bytesObserved = event?.bytesObserved ?? state.bytesObserved ?? 0
        state.pingCount = event?.pingCount ?? state.pingCount ?? 0
      }
      const journal = liveSseJournals.get(String(event?.cdpRequestId ?? ''))
      if (journal && event?.event) {
        // meta 只保存控制面；resume token/正文仍只存在专门的本地 SSE 文件或 SQLite credential。
        void journal.mark({
          event: String(event.event),
          at: Number(event?.at || Date.now()),
          conversationId: typeof event?.conversationId === 'string' ? event.conversationId : null,
          turnExchangeId: typeof event?.turnExchangeId === 'string' ? event.turnExchangeId : null,
          bytesObserved: Number(event?.bytesObserved || 0),
          ...(event?.loadingFailedReason ? { detail: { reason: String(event.loadingFailedReason).slice(0, 240) } } : {}),
        }).catch(async (error) => {
          liveSseJournalErrors += 1
          await log('live SSE journal mark failed', {
            targetId: target.id,
            requestId: event?.cdpRequestId ?? null,
            event: event?.event ?? null,
            error: error instanceof Error ? error.message : String(error),
          }).catch(() => {})
        })
      }
      if (
        event?.event === 'resume-token'
        && typeof event?.conversationId === 'string'
        && event.conversationId
        && typeof event?.resumeToken === 'string'
        && event.resumeToken
      ) {
        archive.upsertLiveResumeCredential({
          conversationId: event.conversationId,
          turnExchangeId: typeof event?.turnExchangeId === 'string' ? event.turnExchangeId : null,
          token: event.resumeToken,
          resumeOffset: event.resumeOffset ?? null,
          tokenSha256: String(event.resumeTokenSha256 || ''),
          tokenLength: Number(event.resumeTokenLength || event.resumeToken.length),
          sourceTransport: String(event.transport || 'conversation'),
          seenAt: Number(event.at || Date.now()),
        })
        clearResumeRetry(event.conversationId, event.turnExchangeId ?? null)
      }
      if (
        (event?.event === 'done' || event?.event === 'message-stream-complete')
        && typeof event?.conversationId === 'string'
        && event.conversationId
      ) {
        clearResumeRetry(event.conversationId, event.turnExchangeId ?? null)
      }
      if (event?.event === 'done' && event?.cdpRequestId) {
        // tracker.emit() 发生在 tracker.ingest*() 的同步调用栈中，而 canonical accumulator
        // 对同一 chunk 的 ingest 紧随其后。排一个 microtask，确保 `[DONE]` 已经先进入 accumulator，
        // 然后立刻 promotion；不再依赖 Chrome 最后到底发 loadingFinished 还是 ERR_ABORTED。
        const requestId = String(event.cdpRequestId)
        queueMicrotask(() => { void tryPromoteLiveCanonicalDecoder(requestId) })
      }
      if (
        event?.event === 'stream-failed'
        && typeof event?.conversationId === 'string'
        && event.conversationId
      ) {
        scheduleResumeRetry(
          event.conversationId,
          event.turnExchangeId ?? null,
          event.loadingFailedReason ?? 'stream-failed',
        )
      }
      void turnRecorder.append(event).catch(async (error) => {
        await log('live turn transport trace write failed', {
          targetId: target.id,
          requestId: event?.cdpRequestId ?? null,
          event: event?.event ?? null,
          error: error instanceof Error ? error.message : String(error),
        }).catch(() => {})
      })
      publishBridgeEvent({
        at: event?.at,
        kind: 'live-transport',
        conversationId: event?.conversationId ?? null,
        turnExchangeId: event?.turnExchangeId ?? null,
        requestId: event?.cdpRequestId ?? null,
        event: event?.event ?? null,
        transport: event?.transport ?? null,
      })
    }

    const appendTurnWssControl = (event) => {
      void turnRecorder.append({
        version: 1,
        at: Date.now(),
        kind: 'turn-wss-control',
        targetId: target.id,
        ...event,
      }).catch(async (error) => {
        await log('turn WSS control trace write failed', {
          targetId: target.id,
          event: event?.event ?? null,
          error: error instanceof Error ? error.message : String(error),
        }).catch(() => {})
      })
    }

    const ensureTurnWssTracker = (requestId, topic) => {
      const trackerKey = `${requestId}:${topic}`
      const existing = turnWssTrackers.get(trackerKey)
      if (existing) return existing
      const cdpRequestId = `wss:${requestId}:${topic}`
      const startedAt = Date.now()
      openLiveSseJournal(cdpRequestId, 'turn-wss', startedAt)
      const tracker = new LiveTurnTransportTracker({
        cdpRequestId,
        transport: 'turn-wss',
        requestStartedAt: startedAt,
        emit: appendLiveTransport,
      })
      const canonical = new LiveSseCanonicalAccumulator()
      registerLiveCanonicalDecoder(cdpRequestId, canonical, {
        targetId: target.id,
        requestId: cdpRequestId,
        transport: 'turn-wss',
        endpoint: 'turn-wss',
      })
      const liveKey = `${target.id}:${cdpRequestId}`
      activeLiveTransports.set(liveKey, {
        targetId: target.id,
        cdpRequestId,
        transport: 'turn-wss',
        startedAt,
        lastDataAt: null,
        dataEvents: 0,
        dataBytes: 0,
        conversationId: null,
        turnExchangeId: topic.slice('conversation-turn-'.length) || null,
        lastControlAt: Date.now(),
        lastControlEvent: 'subscribe',
        bytesObserved: 0,
        pingCount: 0,
      })
      const entry = { tracker, canonical, liveKey, requestId, topic, cdpRequestId, finished: false }
      turnWssTrackers.set(trackerKey, entry)
      return entry
    }

    const finishTurnWssTracker = (entry, failedReason = null) => {
      if (!entry || entry.finished) return
      entry.finished = true
      if (failedReason) entry.tracker.fail(failedReason, Date.now())
      else entry.tracker.finish(Date.now())
      void settleLiveCanonicalDecoder(
        entry.cdpRequestId,
        failedReason ? `turn-wss:${failedReason}` : 'turn-wss-finished-incomplete',
      ).catch(async (error) => {
        await log('turn WSS canonical settlement failed', {
          requestId: entry.cdpRequestId,
          error: error instanceof Error ? error.message : String(error),
        }).catch(() => {})
      }).finally(() => {
        void finalizeLiveSseJournal(entry.cdpRequestId, {
          event: failedReason ? 'stream-failed' : 'stream-finished',
          ...(failedReason ? { detail: { reason: String(failedReason).slice(0, 240) } } : {}),
        })
        liveCanonicalDecoders.delete(entry.cdpRequestId)
        activeLiveTransports.delete(entry.liveKey)
        turnWssTrackers.delete(`${entry.requestId}:${entry.topic}`)
      })
    }

    const observeTurnWssFrame = (requestId, direction, payloadData) => {
      const rows = summarizeTurnTopicWssFrame(payloadData)
      for (const row of rows) {
        const topic = row?.topic
        if (typeof topic !== 'string' || !topic.startsWith('conversation-turn-')) continue
        const entry = ensureTurnWssTracker(String(requestId), topic)
        appendTurnWssControl({
          event: row.source,
          cdpRequestId: String(requestId),
          topic,
          direction,
          offset: row.offset ?? null,
          recovered: row.recovered ?? null,
          catchupCount: row.catchupCount ?? null,
          lastOffsetPresent: row.lastOffsetPresent ?? null,
          innerType: row.innerType ?? null,
          hasEncodedItem: row.hasEncodedItem ?? null,
          encodedBytes: row.encodedBytes ?? null,
        })
        if (row.innerType === 'done') finishTurnWssTracker(entry)
      }
      if (direction !== 'received') return
      for (const item of extractTurnTopicEncodedItems(payloadData)) {
        const entry = ensureTurnWssTracker(String(requestId), item.topic)
        const receivedAt = Date.now()
        appendJournalText(entry.cdpRequestId, item.encodedItem)
        entry.tracker.ingestText(item.encodedItem, receivedAt)
        entry.canonical.ingestText(item.encodedItem)
        const state = activeLiveTransports.get(entry.liveKey)
        if (state) {
          state.lastDataAt = receivedAt
          state.dataEvents = Number(state.dataEvents || 0) + 1
          state.dataBytes = Number(state.dataBytes || 0) + Buffer.byteLength(item.encodedItem, 'utf8')
        }
        if (/data:\s*\[DONE\]/u.test(item.encodedItem)) finishTurnWssTracker(entry)
      }
    }

    const startLiveTransport = (requestId, request) => {
      const url = String(request?.url || '')
      if (request?.method !== 'POST') return
      const transport = url.endsWith('/backend-api/f/conversation')
        ? 'conversation'
        : url.endsWith('/backend-api/f/conversation/resume') ? 'resume' : null
      if (!transport) return
      const startedAt = Date.now()
      openLiveSseJournal(String(requestId), transport, startedAt)
      const tracker = new LiveTurnTransportTracker({
        cdpRequestId: String(requestId),
        transport,
        requestStartedAt: startedAt,
        emit: appendLiveTransport,
      })
      const canonical = new LiveSseCanonicalAccumulator()
      registerLiveCanonicalDecoder(String(requestId), canonical, {
        targetId: target.id,
        requestId: String(requestId),
        transport,
        endpoint: transport === 'resume'
          ? '/backend-api/f/conversation/resume'
          : '/backend-api/f/conversation',
      })
      const liveKey = `${target.id}:${requestId}`
      const liveState = {
        targetId: target.id,
        cdpRequestId: String(requestId),
        transport,
        startedAt,
        lastDataAt: null,
        dataEvents: 0,
        dataBytes: 0,
        conversationId: null,
        turnExchangeId: null,
        lastControlAt: null,
        lastControlEvent: null,
        bytesObserved: 0,
        pingCount: 0,
      }
      const live = {
        tracker,
        canonical,
        liveKey,
        ready: false,
        pending: [],
        enablePromise: null,
        settling: false,
      }
      // 这个函数只存在于 daemon 内存；JSON.stringify 会自然忽略函数属性，因此不会污染 state。
      // idle scanner 通过它把旧 SSE 送回 tracker.fail()，从而复用标准 stream-failed -> resume 链。
      liveState.retireIdle = (reason, at = Date.now()) => {
        if (!liveTransports.has(requestId) || live.settling) return false
        live.settling = true
        // Stop future transport events immediately, but keep the decoder until async Worker
        // settlement finishes so an incomplete stream can still persist partial evidence.
        liveTransports.delete(requestId)
        activeLiveTransports.delete(liveKey)
        tracker.fail(reason, at)
        void settleLiveCanonicalDecoder(String(requestId), `idle-retire:${reason}`).catch(async (error) => {
          await log('idle-retire canonical settlement failed', {
            requestId: String(requestId),
            error: error instanceof Error ? error.message : String(error),
          }).catch(() => {})
        }).finally(() => {
          void finalizeLiveSseJournal(String(requestId), {
            event: 'stream-failed',
            at,
            detail: { reason: String(reason).slice(0, 240) },
          })
          liveCanonicalDecoders.delete(String(requestId))
        })
        return true
      }
      activeLiveTransports.set(liveKey, liveState)
      liveTransports.set(requestId, live)
    }

    client.on('Network.requestWillBeSent', ({ requestId, request }) => {
      startLiveTransport(requestId, request)
      if (!String(request?.url || '').includes('/backend-api/')) return
      const catalogTemplate = captureGlobalCatalogQueryTemplate(String(request?.url || ''))
      if (catalogTemplate) globalCatalogQueryTemplate = catalogTemplate
      const signature = observeProtocolRequest(request, 'user-page', target.id)
      if (signature) protocolRequestSignatures.set(requestId, signature)
    })

    // Phase 3 turn-WSS 只做被动观察：不创建 socket、不发 subscribe。只要第一方页面自然 handoff，
    // CDP 就会看到 subscribe / ACK / catchups / live message，并把 encoded SSE 合流进现有 tracker。
    client.on('Network.webSocketFrameSent', ({ requestId, response }) => {
      observeTurnWssFrame(requestId, 'sent', response?.payloadData)
    })
    client.on('Network.webSocketFrameReceived', ({ requestId, response }) => {
      observeTurnWssFrame(requestId, 'received', response?.payloadData)
    })
    client.on('Network.webSocketClosed', ({ requestId }) => {
      for (const entry of [...turnWssTrackers.values()]) {
        if (String(entry.requestId) !== String(requestId)) continue
        finishTurnWssTracker(entry, 'websocket-closed-before-turn-done')
      }
    })

   client.on('Network.responseReceived', ({ requestId, response }) => {
     const requestUrl = String(response?.url || '')
     const fileId = estuaryFileIdFromUrl(requestUrl)
     const status = Number(response?.status || 0)
      const live = liveTransports.get(requestId)
      if (live) {
        const liveMimeType = String(response?.mimeType || '')
        if (status >= 200 && status < 300 && liveMimeType.includes('text/event-stream')) {
          live.enablePromise = client.send('Network.streamResourceContent', { requestId }, 10_000)
            .then((result) => {
              const bufferedAt = Date.now()
              appendJournalBase64(String(requestId), result?.bufferedData)
              live.tracker.ingestBase64(result?.bufferedData, bufferedAt)
              live.canonical.ingestBase64(result?.bufferedData)
              live.ready = true
              for (const chunk of live.pending) {
                appendJournalBase64(String(requestId), chunk.data)
                live.tracker.ingestBase64(chunk.data, chunk.at)
                live.canonical.ingestBase64(chunk.data)
              }
              live.pending = []
            })
            .catch(async (error) => {
              liveTransports.delete(requestId)
              activeLiveTransports.delete(live.liveKey)
              liveCanonicalDecoders.delete(String(requestId))
              await finalizeLiveSseJournal(String(requestId), {
                event: 'stream-capture-failed',
                detail: { reason: error instanceof Error ? error.message : String(error) },
              })
              await log('live turn streamResourceContent unavailable', {
                targetId: target.id,
                requestId,
                transport: live.tracker.transport,
                error: error instanceof Error ? error.message : String(error),
              })
            })
        }
        else {
          liveTransports.delete(requestId)
          activeLiveTransports.delete(live.liveKey)
          liveCanonicalDecoders.delete(String(requestId))
          void finalizeLiveSseJournal(String(requestId), {
            event: 'stream-rejected',
            detail: { status, mimeType: liveMimeType || null },
          })
        }
      }
      const protocolSignature = protocolRequestSignatures.get(requestId) || null
      const mimeType = String(response?.mimeType || '')
      if (protocolSignature
        && status >= 200 && status < 300
        && /json/u.test(mimeType)
        && !requestUrl.includes('/backend-api/f/conversation')) {
        pendingProtocolResponses.set(requestId, {
          requestSignature: protocolSignature,
          status,
          contentType: mimeType,
        })
      }
     if (fileId && status >= 200 && status < 300) {
        // 这里只记 requestId + stable file id + MIME；短期 signed URL 不进状态/日志。
        pendingImages.set(requestId, {
          fileId,
          contentType: String(response?.mimeType || ''),
          capturedAt: Date.now(),
        })
      }

      const route = classifyConversationBackendUrl(requestUrl)
      if (!route) return
      const family = routeFamily(route)
      const relativeUrl = relativeBackendUrl(requestUrl)
      const isArchiveReplay = Boolean(activeReplayRequestUrl && relativeUrl === activeReplayRequestUrl)
      if (!isArchiveReplay) {
        recordRequestEvent({
          timestamp: Date.now(),
          source: 'native-page',
          targetId: target.id,
          family,
          routeClass: routeClassForObservation(route),
          status: status || null,
          retryAfter: response?.headers?.['retry-after'] ?? response?.headers?.['Retry-After'] ?? null,
          latencyMs: null,
          backoffStage: rateLimits.families[family]?.stage ?? -1,
        })
      }
      if (status === 429) {
        passive429Responses += 1
        if (!shouldTripObserved429(requestUrl, activeReplayRequestUrl)) {
          // 这是 fetchChecked 自己发出的 active replay；同一响应稍后会由 fetchChecked
          // 同步 tripCooldown。这里只保留观测计数，不重复修改 cooldown 或发送 Bark。
          return
        }
        void tripCooldown(`observed native ${route.kind} HTTP 429`, {
          family,
          route: relativeBackendUrl(requestUrl),
          retryAfter: response?.headers?.['retry-after'] ?? response?.headers?.['Retry-After'] ?? null,
          requestId: response?.headers?.['x-request-id'] ?? response?.headers?.['X-Request-Id'] ?? null,
        }).catch(() => {})
        return
      }
      if (status < 200 || status >= 300) return
      pendingBodies.set(requestId, { route, requestUrl, capturedAt: Date.now() })
    })

    client.on('Network.dataReceived', ({ requestId, data, dataLength }) => {
      const live = liveTransports.get(requestId)
      if (!live || typeof data !== 'string' || !data) return
      const chunk = { data, at: Date.now() }
      const state = activeLiveTransports.get(live.liveKey)
      if (state) {
        state.lastDataAt = chunk.at
        state.dataEvents += 1
        state.dataBytes += Number.isFinite(Number(dataLength)) ? Number(dataLength) : Buffer.from(data, 'base64').byteLength
      }
      if (!live.ready) {
        // streamResourceContent() 返回前，dataReceived 已经是真实到达本机的字节。最终 `.sse` 仍要
        // 等 bufferedData 后按正确顺序拼接，所以这里不能直接写主文件；但必须立即进 pre-ready
        // WAL，避免这几秒内 daemon/Chrome 异常退出时连已经看到的残片都丢掉。
        const journal = liveSseJournals.get(String(requestId))
        if (journal) {
          const sequence = live.pending.length
          void journal.appendPreReadyBase64(data, { at: chunk.at, sequence }).catch(async (error) => {
            liveSseJournalErrors += 1
            await log('live SSE pre-ready WAL append failed', {
              targetId: target.id,
              requestId: String(requestId),
              sequence,
              error: error instanceof Error ? error.message : String(error),
            }).catch(() => {})
          })
        }
        live.pending.push(chunk)
      }
      else {
        appendJournalBase64(String(requestId), data)
        live.tracker.ingestBase64(data, chunk.at)
        live.canonical.ingestBase64(data)
      }
    })

    client.on('Network.loadingFinished', ({ requestId }) => {
      const live = liveTransports.get(requestId)
      if (live) {
        const finish = async () => {
          if (!liveTransports.has(requestId) || live.settling) return
          live.settling = true
          live.tracker.finish(Date.now())
          try {
            await settleLiveCanonicalDecoder(String(requestId), 'network-loading-finished-incomplete')
          }
          finally {
            void finalizeLiveSseJournal(String(requestId), { event: 'stream-finished' })
            liveCanonicalDecoders.delete(String(requestId))
            liveTransports.delete(requestId)
            activeLiveTransports.delete(live.liveKey)
          }
        }
        if (live.enablePromise) void live.enablePromise.then(() => void finish(), () => {})
        else void finish()
      }
      const imageMeta = pendingImages.get(requestId)
      if (imageMeta) {
        pendingImages.delete(requestId)
        void (async () => {
          // conversation body 通常先于图片请求完成，但 React 可在很短时间内立即发起图片加载。
          // 给 passive body merge 一个极短竞态窗口；始终只在 SQLite 已确认这是 generated-image
          // 后才读取二进制响应体，避免顺手收进普通用户附件。
          let asset = archive.findPendingGeneratedImageAssetByFileId(imageMeta.fileId)
          for (const delayMs of [100, 300, 700]) {
            if (asset) break
            await new Promise(resolve => setTimeout(resolve, delayMs))
            asset = archive.findPendingGeneratedImageAssetByFileId(imageMeta.fileId)
          }
          if (!asset) return

          passiveImageResponses += 1
          try {
            const body = await client.send('Network.getResponseBody', { requestId }, 10_000)
            const bytes = decodeCdpResponseBodyBytes(body)
            const stored = await persistGeneratedImageAssetBytes(asset, bytes, imageMeta.contentType)
            passiveImageHydrations += 1
            await log('passive image asset captured', {
              conversationId: asset.conversationId,
              fileId: asset.fileId,
              bytes: stored.bytes,
            })
          }
          catch (error) {
            passiveImageCaptureErrors += 1
            const message = error instanceof Error ? error.message : String(error)
            archive.markImageAssetDownloadError(asset.assetPointer, `passive capture: ${message}`)
            await log('passive image asset capture failed', {
              conversationId: asset.conversationId,
              fileId: asset.fileId,
              error: message,
            })
          }
        })().catch(async (error) => {
          passiveImageCaptureErrors += 1
          await log('passive image response handler failed', {
            fileId: imageMeta.fileId,
            error: error instanceof Error ? error.message : String(error),
          })
        })
      }

     const meta = pendingBodies.get(requestId)
      const protocolMeta = pendingProtocolResponses.get(requestId)
      if (!meta && !protocolMeta) {
        protocolRequestSignatures.delete(requestId)
        return
      }
      pendingBodies.delete(requestId)
      pendingProtocolResponses.delete(requestId)
      protocolRequestSignatures.delete(requestId)
     void decodeCdpJsonResponseBody(client, requestId).then(async (payload) => {
        if (protocolMeta) {
          observeProtocolResponse(protocolMeta.requestSignature, {
            status: protocolMeta.status,
            contentType: protocolMeta.contentType,
            body: payload,
          })
        }
        if (!meta) return
       if (meta.route.kind === 'catalog') {
          rememberPassiveCatalogResponse({
            ...meta, payload, targetId: target.id,
          })
          return
        }
        if (meta.route.kind === 'project-sidebar' || meta.route.kind === 'project-catalog') {
          rememberPassiveProjectCatalogResponse({
            ...meta, payload, targetId: target.id,
          })
          return
        }
        await rememberPassiveBodyResponse({
          ...meta, payload, targetId: target.id,
        })
      }).catch(async (error) => {
       await log('passive native response capture failed', {
         targetId: target.id,
          kind: meta?.route?.kind ?? 'protocol',
         error: error instanceof Error ? error.message : String(error),
       })
      })
    })

   client.on('Network.loadingFailed', ({ requestId, errorText, canceled, blockedReason }) => {
     const live = liveTransports.get(requestId)
     if (live) {
       const fail = async () => {
         if (!liveTransports.has(requestId) || live.settling) return
         live.settling = true
         const reason = [errorText, blockedReason, canceled === true ? 'canceled' : null].filter(Boolean).join('; ')
           || 'Network.loadingFailed'
         let settlement = 'none'
         try {
           settlement = await settleLiveCanonicalDecoder(String(requestId), `network-loading-failed:${reason}`)
         }
         finally {
           live.tracker.fail(reason, Date.now())
           void finalizeLiveSseJournal(String(requestId), {
             event: settlement === 'complete' ? 'stream-finished-after-network-abort' : 'stream-failed',
             detail: { reason: String(reason).slice(0, 240) },
           })
           liveCanonicalDecoders.delete(String(requestId))
           liveTransports.delete(requestId)
           activeLiveTransports.delete(live.liveKey)
         }
       }
       if (live.enablePromise) void live.enablePromise.then(() => void fail(), () => void fail())
       else void fail()
     }
     pendingBodies.delete(requestId)
     pendingImages.delete(requestId)
      pendingProtocolResponses.delete(requestId)
      protocolRequestSignatures.delete(requestId)
   })

    passivePageObservers.set(target.id, {
      client,
      url: target.url,
      cleanupLiveSseJournals,
      lastHealthAt: Date.now(),
      lastHealthSuccessAt: Date.now(),
      healthFailures: 0,
      lastHealthError: null,
    })
    await log('passive ChatGPT page observer attached', { targetId: target.id, url: target.url })
  }

  const refreshPassivePageObservers = async (targets) => {
    // Guardian 现在也是 Phase 4 默认 Actor，因此必须和普通 ChatGPT page 一样挂被动 observer。
    // 这里的 observer 只读 Network，不会替代/重置 Guardian 自己的控制 session；
    // cooldown 的 blocked URLs 仍由 Guardian 主 session 维护。
    const eligible = targets.filter(shouldAttachPassivePageObserver)
    const liveIds = new Set(eligible.map(target => target.id))
    const now = Date.now()

    for (const [targetId, observer] of passivePageObservers) {
      let detachReason = null
      let healthError = null

      if (!liveIds.has(targetId)) detachReason = 'target-missing'
      else if (observer.client.closed) detachReason = 'client-closed'
      else {
        const hasActiveTransport = [...activeLiveTransports.values()]
          .some(stream => String(stream?.targetId || '') === String(targetId))
        if (shouldProbePassivePageObserver({
          now,
          lastHealthAt: observer.lastHealthAt,
          hasActiveTransport,
          clientClosed: observer.client.closed,
        })) {
          observer.lastHealthAt = now
          try {
            // Network.enable 是幂等、本地 CDP 控制命令，不产生任何 ChatGPT HTTP 请求。
            // 它既能证明这个 observer session 还会回答命令，也顺手重新声明 Network 观察能力。
            await observer.client.send('Network.enable', {}, PASSIVE_OBSERVER_HEALTH_TIMEOUT_MS)
            observer.healthFailures = 0
            observer.lastHealthSuccessAt = Date.now()
            observer.lastHealthError = null
          }
          catch (error) {
            healthError = error instanceof Error ? error.message : String(error)
            observer.healthFailures = Number(observer.healthFailures || 0) + 1
            observer.lastHealthError = healthError
            await log('passive ChatGPT page observer health failed', {
              targetId,
              failureCount: observer.healthFailures,
              threshold: PASSIVE_OBSERVER_HEALTH_FAILURE_THRESHOLD,
              error: healthError,
            })
            if (observer.healthFailures >= PASSIVE_OBSERVER_HEALTH_FAILURE_THRESHOLD) {
              detachReason = 'health-probe-failed'
            }
          }
        }
      }

      if (detachReason) {
        await observer.cleanupLiveSseJournals?.('target-detached').catch(async (error) => {
          liveSseJournalErrors += 1
          await log('live SSE journal observer cleanup failed', {
            targetId,
            error: error instanceof Error ? error.message : String(error),
          }).catch(() => {})
        })
        observer.client.close()
        passivePageObservers.delete(targetId)
        if (!liveIds.has(targetId)) {
          passiveObserverRetryAfter.delete(targetId)
          passiveObserverFailureCounts.delete(targetId)
        }
        else if (detachReason === 'health-probe-failed') {
          // target 仍然存在，只是旧 observer session 已失明。下一轮主循环即可重挂；
          // 不复用“睡眠 target 初次 attach 失败”的 5 分钟慢重试。
          passiveObserverRetryAfter.set(targetId, Date.now() + PASSIVE_OBSERVER_ZOMBIE_RETRY_MS)
          await log('passive ChatGPT page observer zombie detached', {
            targetId,
            retryAfterMs: PASSIVE_OBSERVER_ZOMBIE_RETRY_MS,
            error: healthError ?? observer.lastHealthError ?? null,
          })
        }
      }
    }

   for (const target of eligible) {
     if (passivePageObservers.has(target.id)) continue
      if (Date.now() < Number(passiveObserverRetryAfter.get(target.id) || 0)) continue
     try {
       await attachPassivePageObserver(target)
        passiveObserverRetryAfter.delete(target.id)
        passiveObserverFailureCounts.delete(target.id)
     }
     catch (error) {
        const failureCount = Number(passiveObserverFailureCounts.get(target.id) || 0) + 1
        passiveObserverFailureCounts.set(target.id, failureCount)
        const retryDelayMs = passiveObserverRetryDelayMs(failureCount)
        passiveObserverRetryAfter.set(target.id, Date.now() + retryDelayMs)
       await log('passive ChatGPT page observer attach failed', {
          targetId: target.id,
          failureCount,
          retryDelayMs,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    prunePassiveCaches()
  }

  const syncGuardianRateLimitBlocks = async () => {
    if (!guardian?.page || guardian.page.closed) return
    const desiredPatterns = guardianBlockedUrlPatterns(rateLimits, Date.now())
    const samePatterns = desiredPatterns.length === guardianConversationRestBlockedPatterns.length
      && desiredPatterns.every((pattern, index) => pattern === guardianConversationRestBlockedPatterns[index])
    if (samePatterns && !guardianConversationRestBlockUncertain) return
    try {
      await guardian.page.send('Network.setBlockedURLs', {
        urls: desiredPatterns,
      }, 3000)
      guardianConversationRestBlockedPatterns = desiredPatterns
      guardianConversationRestBlockUncertain = false
      await log(
        desiredPatterns.length > 0
          ? 'Guardian conversation REST family blocks synchronized'
          : 'Guardian conversation REST block released',
        { patterns: desiredPatterns },
      )
    }
    catch (error) {
      guardianConversationRestBlockUncertain = true
      throw error
    }
  }

  const observeConversationEvent = (event) => {
    const behavior = classifyConversationEvent(event.type, event.updateType)
    const now = Date.now()
    const activeBeforeIds = [...activeTurns.keys()]
    // 明确的新 turn 必须立即废掉上一轮的 SSE satisfied 标记；同一 CID 可以在几秒内连续提问，
    // 不能因为旧 turn 刚刚完整 promotion 就把新 turn 的 lifecycle 误认为“无需同步”。
    if (behavior.startsTurn && behavior.explicitTurnStart) liveSseCanonicalSatisfied.delete(event.conversationId)
    const sseSatisfied = recentLiveSseCanonicalSatisfied(event.conversationId, now)
    // 只记录生命周期元数据，不记录消息正文。并发实验需要精确知道每个
    // conversation 的 created/complete 时刻，否则 eventCounts 只能给总数，
    // 无法判断究竟是哪一条在高并发下被挤掉或漏掉。
    void log('wss conversation event', {
      conversationId: event.conversationId,
      type: event.type,
      updateType: event.updateType || null,
      topic: event.topic || null,
    })
    if (!sseSatisfied) markDirty(event.conversationId, `wss:${event.type}`)
    if (behavior.startsTurn) {
      const current = activeTurns.get(event.conversationId)
      const explicitNewTurn = Boolean(behavior.explicitTurnStart)
      const createdGeneration = !current || explicitNewTurn
      const nextActive = explicitNewTurn
        ? {
            startedAt: now,
            lastEventAt: now,
            lastWatchdogAt: null,
            watchdogPendingAt: null,
            startType: event.updateType ? `${event.type}:${event.updateType}` : event.type,
            lastDiagnosticTurnKey: null,
          }
        : {
            startedAt: current?.startedAt ?? now,
            lastEventAt: now,
            lastWatchdogAt: current?.lastWatchdogAt ?? null,
            watchdogPendingAt: current?.watchdogPendingAt ?? null,
            startType: current?.startType ?? (event.updateType ? `${event.type}:${event.updateType}` : event.type),
            lastDiagnosticTurnKey: current?.lastDiagnosticTurnKey ?? null,
          }
      activeTurns.set(event.conversationId, nextActive)
      persistActiveTurn(event.conversationId, nextActive)
      if (createdGeneration) dispatchWatchdogStartNotification(event.conversationId, nextActive)
    }
    else if (activeTurns.has(event.conversationId)) {
      const current = activeTurns.get(event.conversationId)
      current.lastEventAt = now
      persistActiveTurn(event.conversationId, current)
    }
    if (behavior.completesTurn) {
      recentConversationComplete.set(event.conversationId, now)
      postCompletionDevSpaceCandidates.delete(event.conversationId)
      dropDeferredCatalogWatchdogCandidate(event.conversationId, `wss:${event.type}`)
      clearActiveTurn(event.conversationId)
      catalogActive.delete(event.conversationId)
      stopCheckpointWatch(event.conversationId, `wss:${event.type}`, now)
      archive.updateDevSpaceBindingTurn({
        conversationId: event.conversationId,
        observedAt: now,
        lifecycleState: 'closed',
      })
      if (sseSatisfied) {
        clearSyncDemand(event.conversationId)
        liveSseBodyRefreshesSkipped += 1
        void log('WSS complete satisfied by canonical SSE; body refresh skipped', {
          conversationId: event.conversationId,
          event: event.type,
          turnExchangeId: sseSatisfied.turnExchangeId ?? null,
          sourceRequestId: sseSatisfied.sourceRequestId ?? null,
          transport: sseSatisfied.transport ?? null,
        }).catch(() => {})
      }
      else markSyncReady(event.conversationId, `wss:${event.type}`, nativeBodyGraceMs)
    }
    const activeAfterIds = [...activeTurns.keys()]
    publishBridgeEvent({
      at: now,
      kind: 'wss-lifecycle',
      conversationId: event.conversationId,
      event: event.type,
    })
    void turnRecorder.append(buildWssLifecycleTrace({
      at: now,
      event: {
        conversationId: event.conversationId,
        type: event.type,
        updateType: event.updateType || null,
        startsTurn: behavior.startsTurn,
        completesTurn: behavior.completesTurn,
        asyncProgress: behavior.asyncProgress,
      },
      activeBeforeIds,
      activeAfterIds,
    })).catch((error) => {
      void log('active turn trace write failed', {
        kind: 'wss-lifecycle',
        conversationId: event.conversationId,
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }

  const queueWatchdogDiagnostics = () => {
    const now = Date.now()
    for (const [conversationId, pending] of pendingWatchdogDiagnoses) {
      stopCheckpointWatch(conversationId, 'watchdog-pending', now)
      // daemon 重启后恢复 pending diagnosis 时仍补发一次“到点”事实；持久 ledger 会去重。
      enqueueLifeOpsWatchdogTimeout(conversationId, pending, now)
      dispatchWatchdogTimeoutNotification(conversationId, pending, now)
      if (!ready.has(conversationId)) {
        const watchdogTrigger = watchdogTriggerForStartType(pending.startType)
        markSyncReady(conversationId, watchdogTrigger, 0)
        void log('restored pending watchdog diagnosis; re-queued body sync', {
          conversationId,
          pendingAt: pending.watchdogPendingAt,
          startType: pending.startType,
          trigger: watchdogTrigger,
        })
      }
    }
    for (const [conversationId, active] of activeTurns) {
      if (!shouldQueueWatchdogDiagnostic(active, now, watchdogMs)) continue
      // 45m 硬边界本身就是当前 generation 的 completion。先停止 checkpoint、持久化独立
      // pending diagnosis，再从 activeTurns 摘除；Body 只负责随后异常分类，不再决定是否结束。
      stopCheckpointWatch(conversationId, 'watchdog-timeout', now)
      active.lastWatchdogAt = now
      active.watchdogPendingAt = now
      persistActiveTurn(conversationId, active)
      pendingWatchdogDiagnoses.set(conversationId, {
        ...active,
        completedAt: now,
      })
      recentConversationComplete.set(conversationId, now)
      postCompletionDevSpaceCandidates.delete(conversationId)
      if (isCatalogLateActive(active)) {
        archive.markCatalogWatchdogCompleted(
          conversationId,
          catalogActive.get(conversationId)?.updateTime ?? null,
          now,
        )
      }
      activeTurns.delete(conversationId)
      archive.updateDevSpaceBindingTurn({
        conversationId,
        observedAt: now,
        lifecycleState: 'closed',
      })
      // Watchdog 到点事实与 body 是否可立即拉取无关：第一条通知现在始终立即发送。
      enqueueLifeOpsWatchdogTimeout(conversationId, active, now)
      dispatchWatchdogTimeoutNotification(conversationId, active, now)
      const watchdogTrigger = watchdogTriggerForStartType(active.startType)
      markSyncReady(conversationId, watchdogTrigger, 0)
      void log('active turn exceeded watchdog; queued diagnostic body sync', {
        conversationId,
        activeForMs: now - active.startedAt,
        lastEventAgoMs: now - active.lastEventAt,
        startType: active.startType,
        trigger: watchdogTrigger,
        generationCompletedAt: now,
      })
    }
  }

  const reconcileCatalog = async (reason) => {
    if (reconcileInFlight) return
    reconcileInFlight = true
    const reconcileStartedAt = Date.now()
    const passiveMinCapturedAt = reason === 'gap-repair' && pendingGapRepair
      ? Number(pendingGapRepair.lastAt || reconcileStartedAt)
      : reconcileStartedAt - passiveCatalogFreshnessMs
    let offset = 0
    const limit = 28
    let stableOverlap = 0
    let pages = 0
    let passivePagesUsed = 0
    let dirtyCount = 0
    const requiredStableOverlap = catalogStableOverlapTarget(reason, {
      pageSize: limit,
      deepThreshold: overlapThreshold,
    })
    try {
      while (stableOverlap < requiredStableOverlap) {
        const route = '/backend-api/conversations'
        const passiveCatalog = reusablePassiveCatalogPage(offset, limit, passiveMinCapturedAt)
        const body = passiveCatalog
          ? { items: passiveCatalog.items }
          : await fetchChecked({
              url: listPath(offset, limit, globalCatalogQueryTemplate),
              targetPath: route,
              targetRoute: route,
              kind: 'catalog',
            })
        if (passiveCatalog) {
          passiveCatalogPagesReused += 1
          passivePagesUsed += 1
        }
        const items = Array.isArray(body.items) ? body.items : []
        if (items.length === 0) break
        for (const item of items) {
          const id = typeof item.id === 'string' ? item.id : typeof item.conversation_id === 'string' ? item.conversation_id : null
          if (!id) continue
          const asyncState = classifyCatalogAsyncStatus(item.async_status)
          const now = Date.now()
          const wasCatalogActive = catalogActive.has(id)
          if (asyncState === 'active') {
            const current = catalogActive.get(id)
            const nextUpdateTime = item.update_time ?? null
            const catalogProgressed = Boolean(
              current
              && nextUpdateTime !== null
              && String(nextUpdateTime) !== String(current.updateTime ?? ''),
            )
            const observationStartedAt = catalogObservationStartedAt(current, nextUpdateTime, now)
            catalogActive.set(id, {
              firstSeenAt: observationStartedAt,
              lastSeenAt: now,
              asyncStatus: item.async_status,
              updateTime: nextUpdateTime,
            })
            const promotedIncident = promoteWatchdogTimeoutFromCatalog(id, now)
            if (promotedIncident) {
              await log('watchdog-timeout promoted to active-zombie from persistent catalog active evidence', {
                conversationId: id,
                turnKey: promotedIncident.turnKey,
                incidentId: promotedIncident.id,
                lifecycleClass: promotedIncident.lifecycleClass,
                evidenceTypes: promotedIncident.evidenceTypes,
              })
            }
            // 没有可靠 turn-start 时，把“第一次看到 active”作为保守 late-start 下界。
            // 真实 POST 一定发生得更早，所以 watchdog 只会更晚报警，不会提前误报。
            const archived = archive.db.prepare(`
              SELECT update_time AS updateTime, terminal_state AS bodyCompletionState
              FROM conversations WHERE id = ?
            `).get(id)
            const catalogObservationCompleted = archive.hasCatalogWatchdogCompleted(id, item.update_time ?? null)
            const shouldStartCatalogGeneration = shouldStartCatalogWatchdog({
              alreadyActive: activeTurns.has(id),
              catalogObservationCompleted,
              catalogUpdateTime: item.update_time ?? null,
              archivedUpdateTime: archived?.updateTime ?? null,
              archivedBodyCompletionState: archived?.bodyCompletionState ?? null,
            })
            if (shouldStartCatalogGeneration) {
              // Gap Repair 是 Catalog → Body → canonical match/diagnosis。Catalog 只创建
              // 待 Body 确认的 candidate；Body 之前绝不独立发 New Chat Watchdog。
              queueDeferredCatalogWatchdogCandidate({
                conversationId: id,
                startedAt: observationStartedAt,
                lastEventAt: now,
                startType: `catalog:async-active:${reason}`,
                title: item.title ?? null,
                updateTime: item.update_time ?? null,
              })
            }
            else if (catalogProgressed) {
              const active = activeTurns.get(id)
              // reconciliation 再次看见同一个 async_status=3 不是“新进展”。只有服务端
              // update_time 真正变化才重新武装下一次 watchdog，并从 progress 时刻重新计时；
              // 不能继续沿用上一 generation 的陈旧 firstSeenAt。
              if (active && String(active.startType || '').startsWith('catalog:')) {
                const progressed = recordCatalogWatchdogProgress(active, now)
                activeTurns.set(id, progressed)
                persistActiveTurn(id, progressed)
              }
            }
            // running 先标 stale；真正 body 诊断仍等 complete 或 watchdog 超时，避免正常长任务
            // 在每次 catalog reconciliation 时都主动抓半成品。
            markDirty(id, `catalog:async-active:${reason}`)
            await turnRecorder.append(buildCatalogObservationTrace({
              at: now,
              conversationId: id,
              asyncStatus: item.async_status ?? null,
              classifiedState: 'active',
              reason,
              wasCatalogActive,
              reliableActiveAfterIds: reliableActiveIds(),
              catalogActiveAfterIds: catalogActive.keys(),
            })).catch(async (error) => {
              await log('active turn trace write failed', {
                kind: 'catalog-observation',
                conversationId: id,
                error: error instanceof Error ? error.message : String(error),
              })
            })
          }
          else if (asyncState === 'complete' && (wasCatalogActive || isCatalogLateActive(activeTurns.get(id)))) {
            // 低频 list 看到了 active→complete，而 WSS complete 没到：这是典型 gap repair。
            // persisted catalog tombstone 可能跨 daemon 重启存在，此时内存 catalogActive 尚为空，
            // 也必须按 complete 清掉，不能永久污染 queue.active/oldestActiveMs。
            const hadCatalogGeneration = wasCatalogActive || isCatalogLateActive(activeTurns.get(id))
            catalogActive.delete(id)
            dropDeferredCatalogWatchdogCandidate(id, 'catalog-complete')
            clearActiveTurn(id)
            stopCheckpointWatch(id, `reconcile:${reason}:async-complete`, now)
            await turnRecorder.append(buildCatalogObservationTrace({
              at: now,
              conversationId: id,
              asyncStatus: item.async_status ?? null,
              classifiedState: 'complete',
              reason,
              wasCatalogActive: hadCatalogGeneration,
              reliableActiveAfterIds: reliableActiveIds(),
              catalogActiveAfterIds: catalogActive.keys(),
            })).catch(async (error) => {
              await log('active turn trace write failed', {
                kind: 'catalog-observation',
                conversationId: id,
                error: error instanceof Error ? error.message : String(error),
              })
            })
            markSyncReady(id, `reconcile:${reason}:async-complete`, 0)
          }

          const local = archive.db.prepare('SELECT title, update_time AS updateTime FROM conversations WHERE id=?').get(id)
          const serverUpdate = chatgptTime(item.update_time)
          const localUpdate = local?.updateTime ?? null
          const changed = !local
            || (serverUpdate !== null && (localUpdate === null || serverUpdate > Number(localUpdate) + 0.000001))
            || String(item.title || '') !== String(local?.title || '')
          if (changed) {
            stableOverlap = 0
            dirtyCount += 1
            // Gap Repair 的 changed observation 一律进入正常 Body sync；active/complete 只影响
            // lifecycle 解释，不再决定是否允许读取 Body。update_time/watermark 负责抑制重复抓取。
            markSyncReady(id, `reconcile:${reason}`, 0)
          }
          else stableOverlap += 1
        }
        pages += 1
        offset += items.length
        if (items.length < limit) break
      }
    }
    finally {
      reconcileInFlight = false
    }
    lastReconcileAt = Date.now()
    await log('catalog reconciliation complete', {
      reason,
      pages,
      dirtyCount,
      stableOverlap,
      requiredStableOverlap,
      passivePagesUsed,
    })
    await writeState()
    void drainDirty()
  }

  /**
   * 把 Guardian/WSS gap 统一压成一个 pending repair。
   *
   * 多次 recover/reconnect 只更新 lastAt 和原因集合，不会各自发起一轮 REST 扫描。
   */
  const reconcileProjectSidebar = async (
    reason,
    { minCapturedAt = 0, minConversationUpdateAtMs = null } = {},
  ) => {
    const passive = reusablePassiveProjectSidebar(minCapturedAt)
    const route = PROJECT_SIDEBAR_ROUTE
    const payload = passive?.payload ?? await fetchChecked({
      url: PROJECT_SIDEBAR_PATH,
      targetPath: route,
      targetRoute: route,
      kind: 'project-sidebar',
    })
    const extracted = extractProjectCatalogPayload({ kind: 'project-sidebar' }, payload)
    const summary = await observeProjectCatalogConversations({
      conversations: extracted.conversations,
      reason: reason,
      observedAt: passive?.capturedAt ?? Date.now(),
      minConversationUpdateAtMs,
    })
    projectCatalogRepairs += 1
    projectCatalogRepairDiscoveries += summary.dirtyCount
    await log('Project sidebar reconciliation complete', {
      reason,
      source: passive ? 'passive' : 'active',
      projects: extracted.projects.length,
      conversations: extracted.conversations.length,
      topCursorPresent: Boolean(extracted.cursor),
      ...summary,
    })
    if (extracted.cursor) {
      await log('Project sidebar reconciliation stopped at first project page', {
        reason,
        topCursorPresent: true,
        note: 'top-level Project cursor pagination is not replayed until first-party semantics are observed',
      })
    }
    void drainDirty()
    return {
      source: passive ? 'passive' : 'active',
      projects: extracted.projects.length,
      conversations: extracted.conversations.length,
      cursor: extracted.cursor,
      ...summary,
    }
  }


  const scheduleGapRepair = async (reason) => {
    const now = Date.now()
    if (!pendingGapRepair) {
      pendingGapRepair = {
        firstAt: now,
        lastAt: now,
        reasons: new Set([String(reason || 'unknown')]),
      }
    }
    else {
      pendingGapRepair.lastAt = now
      pendingGapRepair.reasons.add(String(reason || 'unknown'))
    }
    await log('deferred gap repair scheduled', {
      reason,
      firstAt: pendingGapRepair.firstAt,
      lastAt: pendingGapRepair.lastAt,
      reasons: [...pendingGapRepair.reasons].sort(),
    })
  }

  /**
   * 真正发起 gap repair 前必须先满足：
   * 1) WSS 已经恢复；
   * 2) 最近一次 gap 后已稳定一段时间；
   * 3) 与上次 repair 尝试有足够间隔；
   * 4) 不在 429 cooldown。
   *
   * 失败只保留 pending 并重新 debounce，绝不能让异常冒泡到 Guardian rebuild。
   */
  const maybeRunGapRepair = async () => {
    if (!pendingGapRepair) {
      lastGapRepairGate = null
      lastGapRepairGateSignature = null
      return
    }
    const now = Date.now()
    const passiveSeed = reusablePassiveCatalogPage(0, 28, Number(pendingGapRepair.lastAt || now))
    const projectRepairRequired = pendingGapRepair.reasons.has('devspace-idle-unbound-5m')
      || pendingGapRepair.reasons.has('devspace-unbound-timeout')
    const projectRepairCandidateStarts = projectRepairRequired
      ? [
          ...[...pendingDevSpaceIdleDiagnoses.values()]
            .filter(pending => pending.repairMode === 'unbound-catalog')
            .map(pending => archive.getDevSpaceMetadataBinding(pending.metadataId)?.firstSeenAt ?? pending.requestedAt),
          ...[...pendingUnboundWatchdogDiagnoses.values()]
            .map(pending => pending.startedAt),
        ].map(Number).filter(Number.isFinite)
      : []
    const projectRepairMinConversationUpdateAtMs = projectRepairCandidateStarts.length > 0
      ? Math.max(0, Math.min(...projectRepairCandidateStarts) - 10 * 60_000)
      : Math.max(0, Number(pendingGapRepair.firstAt || now) - Math.max(watchdogMs, 10 * 60_000))
    const passiveProjectSeed = projectRepairRequired
      ? reusablePassiveProjectSidebar(Number(pendingGapRepair.lastAt || now))
      : null
    const catalogBackoffUntil = familyBackoffUntil(rateLimits, 'catalog', now)
    const projectCatalogBackoffUntil = familyBackoffUntil(rateLimits, 'project-catalog', now)
    const activeWindowAvailable = Boolean(authHeaders) && familyRateLimitAllowed(rateLimits, 'catalog', now)
    const projectCatalogWindowAvailable = !projectRepairRequired
      || (Boolean(authHeaders) && familyRateLimitAllowed(rateLimits, 'project-catalog', now))
    let eligible = shouldRunDeferredGapRepair({
      now,
      pendingLastAt: pendingGapRepair.lastAt,
      lastAttemptAt: lastGapRepairAttemptAt,
      delayMs: gapRepairDelayMs,
      minIntervalMs: gapRepairMinIntervalMs,
      activeSockets: activeSocketIds.size,
      authAvailable: Boolean(authHeaders),
      cooldownUntil: catalogBackoffUntil,
      reconcileInFlight,
      passiveCatalogAvailable: Boolean(passiveSeed),
    })
    if (eligible
      && projectRepairRequired
      && !projectCatalogWindowAvailable
      && !passiveProjectSeed) {
      eligible = false
    }

    const debounceDueAt = Number(pendingGapRepair.lastAt) + gapRepairDelayMs
    const intervalDueAt = lastGapRepairAttemptAt > 0
      ? lastGapRepairAttemptAt + gapRepairMinIntervalMs
      : 0
    const blockers = []
    if (activeSocketIds.size <= 0) blockers.push('no-active-wss')
    if (reconcileInFlight) blockers.push('reconcile-in-flight')
    if (!activeWindowAvailable && !passiveSeed) {
      if (!authHeaders) blockers.push('no-auth')
      if (!familyRateLimitAllowed(rateLimits, 'catalog', now)) blockers.push('catalog-api-cooldown')
      blockers.push('no-passive-catalog-after-gap')
    }
    if (projectRepairRequired && !projectCatalogWindowAvailable && !passiveProjectSeed) {
      if (!authHeaders) blockers.push('project-catalog-no-auth')
      if (!familyRateLimitAllowed(rateLimits, 'project-catalog', now)) blockers.push('project-catalog-api-cooldown')
      blockers.push('no-passive-project-sidebar-after-gap')
    }
    if (now < debounceDueAt) blockers.push('debounce')
    if (intervalDueAt > 0 && now < intervalDueAt) blockers.push('active-repair-min-interval')
    const gate = {
      at: now,
      eligible,
      blockers,
      activeSockets: activeSocketIds.size,
      authAvailable: Boolean(authHeaders),
      activeWindowAvailable,
      passiveCatalogAvailable: Boolean(passiveSeed),
      projectRepairRequired,
      passiveProjectSidebarAvailable: Boolean(passiveProjectSeed),
      projectCatalogWindowAvailable,
      reconcileInFlight,
      cooldownUntil: catalogBackoffUntil || null,
      projectCatalogCooldownUntil: projectCatalogBackoffUntil || null,
      debounceDueAt,
      intervalDueAt: intervalDueAt || null,
      pendingFirstAt: pendingGapRepair.firstAt,
      pendingLastAt: pendingGapRepair.lastAt,
      reasons: [...pendingGapRepair.reasons].sort(),
    }
    lastGapRepairGate = gate
    const gateSignature = JSON.stringify({
      eligible: gate.eligible,
      blockers: gate.blockers,
      activeSockets: gate.activeSockets,
      authAvailable: gate.authAvailable,
      activeWindowAvailable: gate.activeWindowAvailable,
      passiveCatalogAvailable: gate.passiveCatalogAvailable,
      projectRepairRequired: gate.projectRepairRequired,
      passiveProjectSidebarAvailable: gate.passiveProjectSidebarAvailable,
      projectCatalogWindowAvailable: gate.projectCatalogWindowAvailable,
      reconcileInFlight: gate.reconcileInFlight,
      cooldownUntil: gate.cooldownUntil,
      projectCatalogCooldownUntil: gate.projectCatalogCooldownUntil,
      debounceDueAt: gate.debounceDueAt,
      intervalDueAt: gate.intervalDueAt,
      reasons: gate.reasons,
    })
    if (gateSignature !== lastGapRepairGateSignature) {
      lastGapRepairGateSignature = gateSignature
      await log('deferred gap repair gate changed', gate)
    }
    if (!eligible) return

    const repair = pendingGapRepair
    // 10 分钟 minInterval 保护的是主动 REST 频率；纯 passive repair 不消耗服务端配额。
    if (activeWindowAvailable) lastGapRepairAttemptAt = now
    try {
      await reconcileCatalog('gap-repair')
      if (projectRepairRequired) {
        await reconcileProjectSidebar('devspace-unbound-repair', {
          minCapturedAt: Number(repair.lastAt || 0),
          minConversationUpdateAtMs: projectRepairMinConversationUpdateAtMs,
        })
      }
      if (repair.reasons.has('devspace-unbound-timeout')) {
        queueTimedOutDevSpaceBindingProbes()
      }
      if (repair.reasons.has('devspace-idle-unbound-5m')) {
        const completedAt = Date.now()
        for (const pending of pendingDevSpaceIdleDiagnoses.values()) {
          if (pending.repairMode === 'unbound-catalog') pending.catalogRepairCompletedAt = completedAt
        }
      }
      if (repair.reasons.has('devspace-unbound-timeout')) {
        const completedAt = Date.now()
        for (const pending of pendingUnboundWatchdogDiagnoses.values()) {
          if (!pending.catalogRepairCompletedAt) pending.catalogRepairCompletedAt = completedAt
        }
      }
      pendingGapRepair = null
      lastGapRepairGate = null
      lastGapRepairGateSignature = null
      await log('deferred gap repair complete', {
        reasons: [...repair.reasons].sort(),
      })
    }
    catch (error) {
      if (projectRepairRequired) {
        // Global catalog may already have succeeded before Project repair failed/429'd.
        // Do not let the global 10m minimum interval delay an independent Project bucket retry.
        lastGapRepairAttemptAt = 0
      }
      repair.lastAt = Date.now()
      pendingGapRepair = repair
      await log('deferred gap repair failed', {
        reasons: [...repair.reasons].sort(),
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

 const attachGuardianEvents = async () => {
   const page = guardian.page
    const guardianProtocolRequestSignatures = new Map()
    const guardianProtocolResponses = new Map()

    page.on('Page.frameNavigated', ({ frame }) => {
      if (!shouldRetireWssSocketsForFrameNavigation(frame)) return
      const retiredIds = [...activeSocketIds]
      if (retiredIds.length === 0) return

      const now = Date.now()
      for (const requestId of retiredIds) {
        const socket = wssSocketTelemetry.get(requestId) || null
        wssSocketTelemetry.delete(requestId)
        recentWssSocketLifecycles.push({
          requestId,
          generation: socket?.generation ?? wssGeneration,
          createdAt: socket?.createdAt ?? null,
          closedAt: now,
          lifetimeMs: socket?.createdAt ? Math.max(0, now - Number(socket.createdAt)) : null,
          sentSubscribedTopics: socket ? [...socket.sentSubscribedTopics].sort() : [],
          acknowledgedTopics: socket ? [...socket.acknowledgedTopics].sort() : [],
          recoveredByTopic: socket ? Object.fromEntries([...socket.recoveredByTopic.entries()].sort(([a], [b]) => a.localeCompare(b))) : {},
          observedMessageTopics: socket ? [...socket.observedMessageTopics].sort() : [],
          controlFrames: socket?.controlFrames ?? 0,
          activeSocketsAfter: 0,
          enteredGlobalGap: true,
          retiredBy: 'top-level-document-navigation',
        })
      }
      if (recentWssSocketLifecycles.length > 32) recentWssSocketLifecycles = recentWssSocketLifecycles.slice(-32)
      activeSocketIds = new Set()

      if (conversationTransportRequestId) {
        lastConversationTransportRequestId = conversationTransportRequestId
        conversationTransportRequestId = null
        lastConversationTransportClosedAt = now
      }
      lastWssClosedAt = now
      wssGapStartedAt = now
      subscribedTopics = new Set()
      observedMessageTopics = new Set()
      observedConversationEventTypes = new Set()
      conversationSubscriptionRecovered = null

      void log('ChatGPT WSS sockets retired for top-level document navigation', {
        url: typeof frame?.url === 'string' ? frame.url : null,
        retiredSockets: retiredIds.length,
        requestIds: retiredIds.slice(0, 16),
        conversationCarrier: lastConversationTransportRequestId,
      })
    })

    /**
     * 只记录 WSS 的协议控制面，不记录业务正文。
     *
     * `summarizeWssFrame()` 已经做白名单化：它最多留下 type/topic/recovered/status 等
     * 控制字段和帧字节数，conversation_id、消息正文、认证参数都不会进入 state/log。
     * 这层遥测专门用于区分：
     * 1) socket 根本没有订阅 conversations；
     * 2) conversations 已订阅，但没有业务 frame；
     * 3) 收到了 conversations message frame，但我们的 event parser 没跟上 schema。
     */
    const observeWssControlFrame = async (requestId, direction, payloadData) => {
      const summary = summarizeWssFrame(payloadData)
      const now = Date.now()
      lastWssFrameAt = now
      if (direction === 'sent') wssSentFrames += 1
      else wssReceivedFrames += 1

      const controls = Array.isArray(summary.controls) ? summary.controls : []
      if (controls.length === 0) return summary

      lastWssControlAt = now
      const socket = wssSocketTelemetry.get(requestId) || null
      const newlyObservedMessageTopics = []
      for (const control of controls) {
        const topic = typeof control.topic_id === 'string'
          ? control.topic_id
          : typeof control.topic === 'string' ? control.topic : null
        if (control.type === 'subscribe' && topic) {
          if (direction === 'sent') subscribedTopics.add(topic)
          if (direction === 'sent' && socket) socket.sentSubscribedTopics.add(topic)
          if (direction === 'sent' && socket && isConversationTransportTopic(topic)) {
            const shouldRepair = shouldRepairConversationTransport(
              conversationTransportObservedInGuardian,
              conversationTransportRequestId,
              requestId,
            )
            if (conversationTransportRequestId !== requestId) {
              const previousRequestId = conversationTransportRequestId ?? lastConversationTransportRequestId
              lastConversationTransportRequestId = conversationTransportRequestId ?? lastConversationTransportRequestId
              conversationTransportRequestId = requestId
              conversationTransportGeneration += 1
              conversationTransportObservedInGuardian = true
              lastConversationTransportChangedAt = now
              await log('ChatGPT conversation transport generation changed', {
                previousRequestId,
                requestId,
                generation: conversationTransportGeneration,
                topic,
                shouldRepair,
                activeSockets: activeSocketIds.size,
              })
              if (shouldRepair) {
                // 这里只登记 repair；30 秒 debounce、10 分钟 active repair 最小间隔、
                // 429 cooldown 和 passive catalog 复用仍全部走统一 gap-repair 门控。
                void scheduleGapRepair('conversation-transport-rotation')
              }
            }
          }
          if (direction === 'received' && socket) {
            socket.acknowledgedTopics.add(topic)
            if (typeof control.recovered === 'boolean') socket.recoveredByTopic.set(topic, control.recovered)
          }
          if (direction === 'received' && topic === 'conversations' && typeof control.recovered === 'boolean') {
            conversationSubscriptionRecovered = control.recovered
          }
        }
        if (direction === 'received' && control.type === 'message' && topic) {
          observedMessageTopics.add(topic)
          if (socket && !socket.observedMessageTopics.has(topic)) newlyObservedMessageTopics.push(topic)
          if (socket) socket.observedMessageTopics.add(topic)
        }
        if (
          direction === 'received'
          && typeof control.type === 'string'
          && control.type.startsWith('conversation-')
          && control.type !== 'message'
        ) {
          observedConversationEventTypes.add(control.type)
        }
      }
      if (socket) socket.controlFrames += 1

      const safeEntry = {
        at: now,
        requestId,
        direction,
        bytes: summary.bytes,
        controls: controls.slice(0, 16),
      }
      lastSafeWssControls.push(safeEntry)
      if (lastSafeWssControls.length > 12) lastSafeWssControls = lastSafeWssControls.slice(-12)

      // subscribe/connect 控制帧数量很低，直接带 requestId 落日志，后续才能还原 topic 属于哪条 socket。
      // 普通 message 不逐帧刷日志，只在某条 socket 第一次看到一个 message topic 时记一次。
      if (controls.some(control => control.type === 'subscribe' || control.type === 'connect')) {
        await log('ChatGPT WSS socket control observed', {
          requestId,
          direction,
          activeSockets: activeSocketIds.size,
          controls: controls.slice(0, 16),
        })
      }
      if (newlyObservedMessageTopics.length > 0) {
        await log('ChatGPT WSS socket observed first message topic', {
          requestId,
          topics: [...new Set(newlyObservedMessageTopics)].sort(),
          activeSockets: activeSocketIds.size,
        })
      }
      return summary
    }

    page.on('Network.requestWillBeSent', ({ requestId, request }) => {
     if (!String(request?.url || '').includes('/backend-api/')) return
     const headers = sanitizeCapturedHeaders(request.headers)
     if (typeof headers.authorization === 'string' && headers.authorization.length > 20) {
       authHeaders = authHeaders?.authorization === headers.authorization
         ? { ...authHeaders, ...headers }
         : headers
       lastAuthAt = Date.now()
     }
      const relativeUrl = relativeBackendUrl(request.url)
      const isArchiveReplay = Boolean(activeReplayRequestUrl && relativeUrl === activeReplayRequestUrl)
      if (!isArchiveReplay) {
        const catalogTemplate = captureGlobalCatalogQueryTemplate(String(request?.url || ''))
        if (catalogTemplate) globalCatalogQueryTemplate = catalogTemplate
        const signature = observeProtocolRequest(request, 'guardian-native', guardian.targetId)
        if (signature) guardianProtocolRequestSignatures.set(requestId, signature)
      }
   })
    page.on('Network.responseReceived', ({ requestId, response }) => {
     const route = classifyConversationBackendUrl(response?.url)
      const protocolSignature = guardianProtocolRequestSignatures.get(requestId) || null
      const status = Number(response?.status || 0)
      const mimeType = String(response?.mimeType || '')
      if (protocolSignature
        && status >= 200 && status < 300
        && /json/u.test(mimeType)
        && !String(response?.url || '').includes('/backend-api/f/conversation')) {
        guardianProtocolResponses.set(requestId, {
          requestSignature: protocolSignature,
          status,
          contentType: mimeType,
        })
      }
     // Guardian 自己的 TPP/sidebar list 不属于 daemon replay；它若 429，必须让 daemon 也退避。
     // active replay 的 global list/body 429 已由 fetchChecked 处理，避免在这里重复续杯 cooldown。
      if (route?.kind === 'catalog'
        && !route.globalCatalog
        && status === 429
        && !passivePageObservers.has(guardian.targetId)) {
       passive429Responses += 1
       void tripCooldown('Guardian native catalog HTTP 429', {
         family: 'catalog',
         route: relativeBackendUrl(response?.url),
         retryAfter: response?.headers?.['retry-after'] ?? response?.headers?.['Retry-After'] ?? null,
         requestId: response?.headers?.['x-request-id'] ?? response?.headers?.['X-Request-Id'] ?? null,
       }).catch(() => {})
     }
   })
    page.on('Network.loadingFinished', ({ requestId }) => {
      const meta = guardianProtocolResponses.get(requestId)
      guardianProtocolRequestSignatures.delete(requestId)
      if (!meta) return
      guardianProtocolResponses.delete(requestId)
      if (!shouldReadGuardianProtocolBody(guardianProtocolBodyReadsInFlight)) {
        guardianProtocolBodyReadsSkipped += 1
        if (guardianProtocolBodyReadsSkipped <= 3 || guardianProtocolBodyReadsSkipped % 25 === 0) {
          void log('guardian protocol response fingerprint skipped for CDP backpressure', {
            inFlight: guardianProtocolBodyReadsInFlight,
            skipped: guardianProtocolBodyReadsSkipped,
          }).catch(() => {})
        }
        return
      }
      guardianProtocolBodyReadsInFlight += 1
      void decodeCdpJsonResponseBody(page, requestId).then((payload) => {
        observeProtocolResponse(meta.requestSignature, {
          status: meta.status,
          contentType: meta.contentType,
          body: payload,
        })
      }).catch(async (error) => {
        await log('guardian protocol response fingerprint failed', {
          error: error instanceof Error ? error.message : String(error),
        }).catch(() => {})
      }).finally(() => {
        guardianProtocolBodyReadsInFlight = Math.max(0, guardianProtocolBodyReadsInFlight - 1)
      })
    })
    page.on('Network.loadingFailed', ({ requestId }) => {
      guardianProtocolRequestSignatures.delete(requestId)
      guardianProtocolResponses.delete(requestId)
    })
    page.on('Network.webSocketCreated', ({ requestId, url }) => {
      if (!String(url || '').startsWith('wss://') || !String(url || '').includes('chatgpt.com')) return
      const now = Date.now()
      const activeSocketsBefore = activeSocketIds.size
      const gapStartedAt = wssGapStartedAt
      const isNativeReconnect = Number.isFinite(gapStartedAt)
        && Number.isFinite(lastWssClosedAt)
        && Number(lastWssClosedAt) >= guardianReadyAt
      activeSocketIds.add(requestId)
      wssSocketTelemetry.set(requestId, {
        requestId,
        generation: wssGeneration,
        createdAt: now,
        sentSubscribedTopics: new Set(),
        acknowledgedTopics: new Set(),
        recoveredByTopic: new Map(),
        observedMessageTopics: new Set(),
        controlFrames: 0,
      })
      lastWssCreatedAt = now
      wssGapStartedAt = null

      void log('ChatGPT WSS socket created', {
        requestId,
        generation: wssGeneration,
        activeSocketsBefore,
        activeSocketsAfter: activeSocketIds.size,
        globalGapStartedAt: Number.isFinite(gapStartedAt) ? gapStartedAt : null,
        classifiedNativeReconnect: isNativeReconnect,
      })

      if (isNativeReconnect) {
        lastWssReconnectDelayMs = now - Number(gapStartedAt)
        // 新连接必须重新完成 subscribe；清掉上一条 socket 的 ACK，避免状态页显示陈旧恢复状态。
        subscribedTopics = new Set()
        observedMessageTopics = new Set()
        observedConversationEventTypes = new Set()
        conversationSubscriptionRecovered = null
        void log('ChatGPT WSS reconnected natively', {
          delayMs: lastWssReconnectDelayMs,
          closedAt: lastWssClosedAt,
          createdAt: now,
        })

        // global-zero 现在只保留为遥测。真正的 conversation fallback 由
        // conversations/alder-conversations carrier generation 换代触发；这样通知/资源 socket
        // 独立轮换不会误扫 catalog，3→4→3 的 overlap handover 也不会漏 repair。
      }
    })
    page.on('Network.webSocketClosed', ({ requestId }) => {
      if (!activeSocketIds.delete(requestId)) return
      const now = Date.now()
      const socket = wssSocketTelemetry.get(requestId) || null
      wssSocketTelemetry.delete(requestId)
      lastWssClosedAt = now
      if (conversationTransportRequestId === requestId) {
        lastConversationTransportRequestId = requestId
        conversationTransportRequestId = null
        lastConversationTransportClosedAt = now
        void log('ChatGPT conversation transport carrier closed', {
          requestId,
          generation: conversationTransportGeneration,
          activeSocketsAfter: activeSocketIds.size,
        })
      }
      // 只有最后一条 WSS 都关闭时才进入 gap；若旧连接关闭时新连接已并存，监听面并未中断。
      if (activeSocketIds.size === 0) wssGapStartedAt = now

      const lifecycle = {
        requestId,
        generation: socket?.generation ?? wssGeneration,
        createdAt: socket?.createdAt ?? null,
        closedAt: now,
        lifetimeMs: socket?.createdAt ? Math.max(0, now - Number(socket.createdAt)) : null,
        sentSubscribedTopics: socket ? [...socket.sentSubscribedTopics].sort() : [],
        acknowledgedTopics: socket ? [...socket.acknowledgedTopics].sort() : [],
        recoveredByTopic: socket ? Object.fromEntries([...socket.recoveredByTopic.entries()].sort(([a], [b]) => a.localeCompare(b))) : {},
        observedMessageTopics: socket ? [...socket.observedMessageTopics].sort() : [],
        controlFrames: socket?.controlFrames ?? 0,
        activeSocketsAfter: activeSocketIds.size,
        enteredGlobalGap: activeSocketIds.size === 0,
      }
      recentWssSocketLifecycles.push(lifecycle)
      if (recentWssSocketLifecycles.length > 32) recentWssSocketLifecycles = recentWssSocketLifecycles.slice(-32)
      void log('ChatGPT WSS socket closed', lifecycle)
    })
    page.on('Network.webSocketFrameSent', ({ requestId, response }) => {
      if (!activeSocketIds.has(requestId)) return
      void observeWssControlFrame(requestId, 'sent', response?.payloadData)
    })
    page.on('Network.webSocketFrameReceived', ({ requestId, response }) => {
      if (!activeSocketIds.has(requestId)) return
      const payloadData = response?.payloadData
      const summaryPromise = observeWssControlFrame(requestId, 'received', payloadData)
      const events = extractConversationEvents(payloadData)
      if (events.length > 0) wssParsedEventFrames += 1
      for (const event of events) {
        lastWssEventAt = Date.now()
        eventCounts.set(event.type, (eventCounts.get(event.type) || 0) + 1)
        const topicCountKey = `${event.topic || 'unknown'}:${event.type}`
        eventTopicCounts.set(topicCountKey, (eventTopicCounts.get(topicCountKey) || 0) + 1)
        observeConversationEvent(event)
      }
      void summaryPromise.then(async (summary) => {
        const controls = Array.isArray(summary.controls) ? summary.controls : []
        const isConversationMessage = controls.some(control => {
          const topic = control.topic_id ?? control.topic
          return control.type === 'message'
            && (topic === 'conversations' || topic === 'alder-conversations')
        })
        if (isConversationMessage && events.length === 0) {
          wssUnparsedConversationFrames += 1
          await log('WSS conversations frame was not parsed into an event', {
            bytes: summary.bytes,
            controls,
          })
        }
      })
    })
  }

  const establishGuardian = async (reason) => {
    const browserAvailability = await ensureCdpBrowser(flags, cdpHttp)
    if (browserAvailability.launched) {
      await log('Chrome CDP browser relaunched', {
        reason,
        browser: browserAvailability.version?.Browser ?? null,
        launcherPid: browserAvailability.launcherPid ?? null,
        shortcut: browserAvailability.shortcut ?? null,
      })
    }
    const previousWindowId = guardian?.windowId ?? null
    const previousBrowser = guardian?.browser ?? null

    // 如果第三方 discard 扩展把原 Guardian tab 替换成自己的“睡眠占位页”，target id/URL
    // 会变，但顶层 Chrome window id 仍是原来的。先清理这个已知 Guardian 窗口里的残留 target，
    // 防止每次自愈都在任务栏留下一个新的“已休眠窗口”。普通用户窗口绝不会匹配该 windowId。
    if (previousBrowser && previousWindowId !== null) {
      try {
        const { targetInfos = [] } = await previousBrowser.send('Target.getTargets')
        for (const info of targetInfos) {
          if (info.type !== 'page') continue
          try {
            const located = await previousBrowser.send('Browser.getWindowForTarget', { targetId: info.targetId }, 2500)
            if (located.windowId === previousWindowId) {
              await previousBrowser.send('Target.closeTarget', { targetId: info.targetId }, 2500).catch(() => {})
            }
          }
          catch {
            // 某个 target 正在消失不影响其它窗口清理。
          }
        }
      }
      catch {
        // browser-level CDP 自己也断开时，后面的 ensureGuardian 会重新连接。
      }
    }
    guardian?.page?.close()
    guardian?.browser?.close()
    guardian = await ensureGuardian(cdpHttp)
    guardianConversationRestBlockedPatterns = []
    guardianConversationRestBlockUncertain = true
    guardianReadyAt = Date.now()
    guardianHealthFailures = 0
    guardianUiReloadAttemptedAt = null
    guardianUiFailure = null
    if (reason !== 'startup') guardianRebuilds += 1
    wssGeneration += 1
    activeSocketIds = new Set()
    wssSocketTelemetry = new Map()
    conversationTransportRequestId = null
    lastConversationTransportRequestId = null
    conversationTransportObservedInGuardian = false
    lastConversationTransportChangedAt = null
    lastConversationTransportClosedAt = null
    // 新 Guardian 尚未建立第一条 WSS，首次 readiness 也统一使用同一个 gap 时钟。
    wssGapStartedAt = guardianReadyAt
    subscribedTopics = new Set()
    observedMessageTopics = new Set()
    observedConversationEventTypes = new Set()
    conversationSubscriptionRecovered = null
    lastSafeWssControls = []
    authHeaders = null
    await attachGuardianEvents()
    // 如果进程启动时继承了真实 429 cooldown，先在 reload/navigation 之前就挡住
    // Guardian 自己的 conversation REST。WSS 使用 wss://，不会命中这个 HTTPS block。
    const desiredPatterns = guardianBlockedUrlPatterns(rateLimits, Date.now())
    await syncGuardianRateLimitBlocks().catch(async (error) => {
      await log('Guardian REST block state sync failed after attach', {
        desiredPatterns,
        error: error instanceof Error ? error.message : String(error),
      })
    })
    await log('guardian ready', {
      reason,
      targetId: guardian.targetId,
      windowId: guardian.windowId,
      created: guardian.created,
      nativeHidden: guardian.nativeWindow?.visibleAfter === false,
    })
    guardianEstablishedOnce = true
    // listener 必须先于导航/reload 安装，才能捕获第一条真实 backend header 与 WSS 创建。
    //
    // 这里刻意只“发起”导航，不再 await CDP command ACK。生产现场已经出现过：页面/网络实际上
    // 开始启动了，但 Page.navigate 的 command reply 因 renderer/CDP 抖动迟迟不回来；旧代码因此
    // 一直卡在第一次 writeState() 之前，最终被 `daemon resume` 的 90 秒 supervisor fail-closed。
    //
    // Guardian readiness 的真正证据是下面的 auth/header、后续 Runtime health 与 WSS，而不是
    // Page.navigate/Page.reload 这条命令本身的 ACK。CdpClient 自己仍有 10 秒 hard timeout；
    // reject 只写日志，不能再把整个 daemon startup 当成失败。这样没有降低健康门槛，只移除了
    // 一个与健康无关、且会放大 renderer 瞬态抖动的同步门闩。
    if (guardian.created) {
      void guardian.page.send('Page.navigate', { url: `https://chatgpt.com/?${GUARDIAN_MARKER}=1` })
        .catch(async (error) => {
          await log('Guardian startup navigation command did not acknowledge; readiness observation continues', {
            reason,
            command: 'Page.navigate',
            error: error instanceof Error ? error.message : String(error),
          }).catch(() => {})
        })
    }
    else {
      // 如果复用了旧 guardian，它不会因为 attach 自动产生网络请求；轻量 reload 一次只发生在
      // daemon 自己的专用页，用于重新挂全 WSS 生命周期并获得页面真实 request context。
      void guardian.page.send('Page.reload', { ignoreCache: false })
        .catch(async (error) => {
          await log('Guardian startup reload command did not acknowledge; readiness observation continues', {
            reason,
            command: 'Page.reload',
            error: error instanceof Error ? error.message : String(error),
          }).catch(() => {})
        })
    }

    const waitStarted = Date.now()
    while (!authHeaders && Date.now() - waitStarted < 20_000 && !guardian.page.closed) {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    await syncGuardianRateLimitBlocks().catch(() => {})
    // “daemon 已经 ready”和“首次补洞完成”是两个不同状态。先写 ready state，
    // 避免 CLI 因一次 5 页 startup reconcile 超过启动等待时间而误报 started:false。
    await writeState()
    if (authHeaders
      && familyRateLimitAllowed(rateLimits, 'catalog')
      && !cooldownRecoveryPending
      && reconcileOnStart
      && lastReconcileAt === 0) {
      // 冷启动补账属于主动 REST，与 Guardian 自身存活解耦。
      await reconcileCatalog('startup').catch(async (error) => {
        await log('startup reconciliation failed; passive Guardian remains online', {
          error: error instanceof Error ? error.message : String(error),
        })
      })
    }
    else if (reason !== 'startup') {
      // Guardian 自愈只负责先恢复被动 WSS；REST gap repair 统一进入低频去抖队列。
      await scheduleGapRepair('guardian-recover')
    }
  }

  // Phase 5 Bridge 与 Archive daemon 同生命周期，但失败时不能拖死归档/WSS 主链。
  // 默认只监听 loopback；token 只从独立 *.local.json 读取到内存，不写 state/log。
  if (bridgeEnabled) {
    try {
      const bridgeAuthToken = await ensureArchiveBridgeAuthToken(bridgeAuthPath)
      archiveBridge = new ArchiveBridgeServer({
        archive,
        authToken: bridgeAuthToken,
        host: bridgeHost,
        port: bridgePort,
        submissionQueuePath: actorSubmissionQueuePath,
        submissionQueueLog: log,
        onSubmissionAttemptError: notifyActorSubmissionAttemptError,
        submitTurn: async (input) => await sendActorPrompt({
          cdpHttp,
          statePath: actorStatePath,
          daemonStatePath: statePath,
          domLedgerPath,
          tracePath: turnTracePath,
          prompt: input.text,
          conversationId: input.conversationId,
          projectName: input.projectName,
          mode: input.mode,
          targetMode: input.targetMode,
          onDomDrift: notifyActorDomDrift,
          onRateLimit: async details => {
            recordRequestEvent({
              timestamp: Date.now(),
              source: 'actor',
              targetId: guardian?.targetId ?? null,
              family: 'actor',
              routeClass: details.mode === 'steer' ? 'actor-steer' : 'actor-conversation',
              status: details.status,
              retryAfter: details.retryAfter,
              latencyMs: null,
              backoffStage: rateLimits.families.actor.stage,
            })
            return await tripCooldown('actor turn submit HTTP 429', {
              family: 'actor',
              route: details.requestUrl,
              requestId: details.requestId,
              retryAfter: details.retryAfter,
            })
          },
        }),
      })
      await archiveBridge.start()
      archiveBridgeStartedAt = Date.now()
      archiveBridgeLastError = null
      await log('Archive Bridge ready', {
        host: bridgeHost,
        port: archiveBridge.port,
        authPath: bridgeAuthPath,
      })
    }
    catch (error) {
      archiveBridgeLastError = error instanceof Error ? error.message : String(error)
      await archiveBridge?.stop().catch(() => {})
      archiveBridge = null
      await log('Archive Bridge failed to start; archive core remains available', {
        host: bridgeHost,
        port: bridgePort,
        error: archiveBridgeLastError,
      })
    }
  }

  process.on('SIGINT', () => { stopping = true })
  process.on('SIGTERM', () => { stopping = true })

  // 先把 DevSpace SQLite 里所有历史 metadata 的首末时间 seed 进 Archive。
  // 这只是补齐“曾经存在过”的事实，不把历史行放进 unboundDevSpaceTurns，
  // 所以不会把几周前的聊天误当成当前 active watchdog。
  const hadExistingDevSpaceMetadataBindings = archive.listDevSpaceMetadataBindings({ limit: 1 }).length > 0
  let devSpaceHistoricalSeeded = 0
  // 全历史 GROUP BY + 逐条 Archive upsert 只属于第一次迁移。稳态重启若 binding 表已经存在，
  // durable audit cursor 会把 daemon 离线期间的新 metadata 逐条补进来；没必要每次启动都重新
  // GROUP BY 整个 DevSpace tool_audit 历史，再重复写几百条完全相同的 binding 行。
  const devSpaceMetadataHistory = hadExistingDevSpaceMetadataBindings
    ? []
    : devSpaceAuditBridge.metadataSummaries(10_000)
  for (const summary of devSpaceMetadataHistory) {
    const seeded = archive.seedDevSpaceMetadataHistory({
      metadataId: summary.metadataId,
      firstSeenAt: summary.firstAt,
      lastSeenAt: summary.lastAt,
    })
    if (seeded.created) devSpaceHistoricalSeeded += 1
  }
  if (devSpaceMetadataHistory.length > 0) {
    await log('DevSpace historical metadata seed complete', {
      discovered: devSpaceMetadataHistory.length,
      created: devSpaceHistoricalSeeded,
    })
  }

  // 再修复旧版留下的“明明能 exact-match 但因为并发而 unbound”的历史行；
  // 随后做一次 durable catch-up。这样当前新 audit 一进来时即可直接命中已知 CID。
  // 历史全量 backfill 是迁移任务，不是 daemon 每次重启都要做的稳态工作。
  // 首次把旧 DevSpace metadata seed 进 Archive 时跑一遍即可；之后 live body sync 自己会
  // 对当前 turn 做 exact-match。否则少量永久无法匹配的旧 metadata 会让每次启动都重扫
  // 2 万+ audit / 数百 turn，甚至把 Watchdog 主循环堵住一分多钟。
  // Never run the global historical exact-match scan on the daemon startup hot path.
  // New metadata can legitimately be seeded on any restart, so devSpaceHistoricalSeeded > 0
  // is not a migration-only signal. Historical binding repair is conversation-scoped and
  // event-driven after canonical Body sync instead.
  const devSpaceBackfilledBindings = 0

  // parser / binding 策略升级后，旧 metadata 可能“以前匹配不了、现在能匹配”。
  // 每次启动只对近期 unbound 做一个窄窗口重验，避免为了几个活跃候选重扫数周历史。
  // Recurring recent-unbound backfill is intentionally excluded from the startup hot path.
  // Its current create_time range scan can exceed the 90s resume health gate on the large archive.
  // Historical repair must be explicit/bounded and must not delay Guardian/WSS readiness.

  const cursorBeforeBootstrap = devSpaceAuditCursor
  bootstrapDevSpaceAuditCursor()
  if (!cursorBeforeBootstrap && devSpaceAuditCursor) {
    await log('DevSpace durable audit cursor bootstrapped at current head', {
      consumerKey: DEVSPACE_AUDIT_CONSUMER_KEY,
      startedAt: devSpaceAuditCursor.startedAt,
      auditId: devSpaceAuditCursor.auditId,
    })
  }
  let pendingRecoveryAtStartup = { refreshed: 0, metadataIds: [] }
  try {
    pendingRecoveryAtStartup = await refreshPendingDevSpaceRecoveryAudits({ collectMetadataIds: true })
    if (pendingRecoveryAtStartup.refreshed > 0) {
      await log('pending DevSpace recovery audits refreshed after startup', {
        refreshed: pendingRecoveryAtStartup.refreshed,
      })
    }
  }
  catch (error) {
    await log('startup pending DevSpace recovery refresh failed; deferred to fallback', {
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => {})
  }
  try {
    await pollDevSpaceAudits()
  }
  catch (error) {
    await log('startup DevSpace audit poll failed; deferred to fallback', {
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => {})
  }
  const bindingQueueQueuedAtStartup = queuePendingDevSpaceBindingQueue({
    limit: 1000,
  })
  if (bindingQueueQueuedAtStartup > 0) {
    await log('DevSpace matching queue recovery scheduled after startup', {
      queued: bindingQueueQueuedAtStartup,
    })
  }
  if (pendingUnboundWatchdogDiagnoses.size > 0) {
    // 旧 unbound generation 已经结束，重启只恢复 diagnosis/repair work；不能恢复 active candidate。
    // gap repair 本身会在 maintenance lane 等待 WSS/auth/cooldown 条件成熟，不阻塞 startup hot path。
    void scheduleGapRepair('devspace-unbound-timeout')
    await log('pending unbound watchdog diagnoses scheduled catalog repair after startup', {
      pending: pendingUnboundWatchdogDiagnoses.size,
    })
  }
  // 启动恢复不再扫描 DevSpace 全局“最近 started OR finished”。真实 800MiB tool_audit 上，
  // 旧 OR+GROUP BY+ORDER BY 即使最终只返回 1 个 metadata，冷缓存也实测 3.8s，热缓存仍
  // 约 0.55s。这里从 Archive 已持久化事实反推候选：
  // 1) daemon 离线期间可能 finish 的 pending recovery audit（上面已按 audit-id 精确重读）；
  // 2) 近期 durable replay / live audit 已推进 last_seen_at 的 metadata binding。
  // 然后逐 metadata_id 走 DevSpace (metadata_id,started_at) 索引精确读取当前状态。
  const startupMetadataIds = new Set(pendingRecoveryAtStartup.metadataIds)
  for (const binding of archive.listDevSpaceMetadataBindings({
    sinceAt: Date.now() - DEVSPACE_IDLE_STARTUP_LOOKBACK_MS,
    limit: 200,
  })) {
    startupMetadataIds.add(binding.metadataId)
  }
  for (const metadataId of startupMetadataIds) {
    const state = runControlPlaneStage('devspace-startup:metadata-state', () =>
      devSpaceAuditBridge.metadataToolState(metadataId))
    if (state) refreshDevSpaceIdleCandidate(state.metadataId, Date.now(), state)
  }
  devSpaceLastFallbackPollAt = Date.now()
  const devSpaceWakeListening = await devSpaceAuditWakeListener.start(async (signal) => {
    // poll 现在会在同一 audit 内部 cooperative yield；finish 门铃的最终状态重读显式串到
    // 本次 poll 之后，保持旧版“先消费 start/cursor，再覆盖 finish result”的顺序。
    try {
      await pollDevSpaceAudits()
    }
    catch (error) {
      await log('DevSpace audit wake poll failed', {
        auditId: signal.auditId,
        metadataId: signal.metadataId,
        error: error instanceof Error ? error.message : String(error),
      }).catch(() => {})
    }
    finally {
      // finish 与 start 使用同一 auditId；finish 是原行 UPDATE，不会越过 started_at cursor，
      // 因此仍按 signal.metadataId / auditId 重读最终状态。
      refreshDevSpaceIdleCandidate(signal.metadataId)
      // recovery overlay 同样按 auditId 补最终 result/error/finished_at。
      try {
        await refreshDevSpaceRecoveryAudit(signal.auditId)
      }
      catch (error) {
        await log('DevSpace recovery finish refresh failed', {
          auditId: signal.auditId,
          metadataId: signal.metadataId,
          error: error instanceof Error ? error.message : String(error),
        }).catch(() => {})
      }
    }
  })
  await log('DevSpace audit wake listener ready', {
    listening: devSpaceWakeListening,
    ...devSpaceAuditWakeListener.stats(),
    fallbackPollMs: DEVSPACE_FALLBACK_POLL_MS,
  })

  /**
   * Maintenance lane 的单个步骤隔离器。
   *
   * 旧主循环把所有后台工作都包在 Guardian 的总 try/catch 里：任何 reconcile / hydrate /
   * dirty-drain 抛错，最后都会关闭 Guardian page，导致一个普通后台故障被升级成浏览器核心重建。
   * 这里把错误局限在当前 maintenance step：记日志、记 telemetry，然后继续下一个后台步骤。
   */
  const runMaintenanceStep = async (step, work) => {
    maintenanceLaneLastStep = step
    try {
      await work()
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      maintenanceLaneLastError = `${step}: ${message}`
      await log('daemon maintenance step failed', {
        step,
        error: message,
      }).catch(() => {})
    }
    // 即使一个 step 很快，也主动把控制权交回 event loop；后续 writer/repair 再变重时，
    // 不允许整条 maintenance lane 重新退化成一个长同步调用栈。
    await yieldControlPlane()
  }

  /**
   * 允许耗时、允许失败、但不允许杀 Guardian 的后台 lane。
   *
   * 每次最多同时运行一个实例。Critical 5s tick 只负责调用 scheduleMaintenanceLane()，
   * 不 await 本函数，因此 CDP/Guardian/WSS 健康检查不会再等待 catalog/reconcile/image 等慢任务。
   */
  const runMaintenanceLane = async () => {
    if (maintenanceLaneInFlight || stopping) return
    maintenanceLaneInFlight = true
    maintenanceLaneRuns += 1
    maintenanceLaneLastError = null
    const started = performance.now()
    try {
      await runMaintenanceStep('resume-recovery', async () => {
        if (resumeStartupRecoveryDone || !authHeaders) return
        const scheduled = recoverRecentOrphanedResumeCredentials()
        resumeStartupRecoveryDone = true
        if (scheduled > 0) {
          await log('recent orphaned live turn resumes scheduled after daemon startup', { scheduled })
        }
      })

      await runMaintenanceStep('devspace-fallback', async () => {
        if (Date.now() - devSpaceLastFallbackPollAt < DEVSPACE_FALLBACK_POLL_MS) return
        await pollDevSpaceAudits()
        await refreshPendingDevSpaceRecoveryAudits()
        // finish 门铃丢失时，低频按当前已追踪 metadata 重读 idle 状态。
        refreshTrackedDevSpaceIdleCandidates()
        devSpaceLastFallbackPollAt = Date.now()
      })

      await runMaintenanceStep('devspace-thresholds', () => {
        runControlPlaneStage('maintenance:devspace-thresholds', () => {
          checkDevSpaceIdleNotifications()
          checkUnboundDevSpaceTimeouts()
        })
      })

      await runMaintenanceStep('watchdog-diagnostics', () => {
        runControlPlaneStage('maintenance:watchdog-diagnostics', () => queueWatchdogDiagnostics())
      })

      // canonical/diagnostic 工作优先于 observer/image 等外围维护；这样一旦有 ready backlog，
      // 当前 maintenance turn 会先推进一个最重要的同步单元，再做其它低优先级任务。
      await runMaintenanceStep('dirty-drain', async () => await drainDirty())
      await runMaintenanceStep('checkpoint-drain', async () => await drainCheckpointWatches())
      await runMaintenanceStep('gap-repair', async () => await maybeRunGapRepair())
      await runMaintenanceStep('unbound-diagnosis', () => {
        runControlPlaneStage('maintenance:unbound-diagnosis', () => {
          completeUnboundDevSpaceIdleDiagnoses()
          completeUnboundWatchdogDiagnoses()
        })
      })

      await runMaintenanceStep('passive-observers', async () => {
        await refreshPassivePageObservers(latestCdpTargets)
      })

      await runMaintenanceStep('image-hydration', async () => {
        await hydratePendingGeneratedImageAssets()
      })

      await runMaintenanceStep('periodic-reconcile', async () => {
        if (!(reconcileHours > 0
          && authHeaders
          && familyRateLimitAllowed(rateLimits, 'catalog')
          && !cooldownRecoveryPending
          && !guardianConversationRestBlockUncertain
          && Date.now() - lastReconcileAt >= reconcileHours * 3600_000)) return
        await reconcileCatalog('periodic').catch(async (error) => {
          await log('periodic reconciliation failed; passive Guardian remains online', {
            error: error instanceof Error ? error.message : String(error),
          })
        })
      })

      await runMaintenanceStep('protocol-maintenance', () => {
        if (protocolLedger?.refreshBaselineLock()) scheduleProtocolLedgerFlush()
      })
    }
    finally {
      maintenanceLaneLastMs = performance.now() - started
      maintenanceLaneMaxMs = Math.max(maintenanceLaneMaxMs, maintenanceLaneLastMs)
      maintenanceLaneLastStep = null
      maintenanceLaneInFlight = false
    }
  }

  const scheduleMaintenanceLane = () => {
    if (maintenanceLaneScheduled || maintenanceLaneInFlight || stopping) return false
    maintenanceLaneScheduled = true
    setImmediate(() => {
      maintenanceLaneScheduled = false
      void runMaintenanceLane().catch(async (error) => {
        // runMaintenanceLane 理论上只会在 finally 外的极端错误到这里；仍然只记录，绝不关闭 Guardian。
        const message = error instanceof Error ? error.message : String(error)
        maintenanceLaneLastError = `lane: ${message}`
        await log('daemon maintenance lane failed', { error: message }).catch(() => {})
      })
    })
    return true
  }

  controlPlaneStage = 'idle'
  await log('daemon starting', { pid: process.pid, dbPath, cdpHttp })
  while (!stopping) {
    try {
      if (!guardian || guardian.page.closed) {
        await establishGuardian(guardianEstablishedOnce ? 'recover-page' : 'startup')
      }

      const targets = await fetch(`${cdpHttp}/json/list`).then(response => response.json())
      if (!targets.some(target => target.id === guardian.targetId)) {
        guardian.page.closed = true
        continue
      }
      // Critical lane 只保存当前 target snapshot；observer attach 等允许耗时的 CDP 工作交给
      // Maintenance lane，避免某个 10s Network.enable timeout 把 Guardian health tick 一起拖住。
      latestCdpTargets = Array.isArray(targets) ? targets : []
      // family backoff 到期后及时解除 Guardian 对应 URL pattern。
      // 这一步不发 ChatGPT 请求；只是让页面/下一次 probation probe 不会被过期的本地 CDP block 卡住。
      await syncGuardianRateLimitBlocks()
      retireIdleLiveTransports()

      // 只做健康观测，不主动激活窗口。短暂的 renderer/CDP 抖动先累计失败次数；
      // 不再“一次 3 秒 timeout 就拆 Guardian”。成功一次立即清零。
      let runtime = null
      try {
        runtime = await guardian.page.send('Runtime.evaluate', {
          expression: `(() => {
            const bodyText = String(document.body?.innerText || '')
            const composerPresent = Boolean(
              document.querySelector('form[data-chatgpt-composer] #prompt-textarea')
              || document.querySelector('form[data-chatgpt-composer] [contenteditable="true"][role="textbox"]')
              || document.querySelector('form[data-chatgpt-composer] textarea')
            )
            const lower = bodyText.toLowerCase()
            return {
              href: String(location.href || ''),
              visibility: document.visibilityState,
              discarded: document.wasDiscarded === true,
              ready: document.readyState,
              composerPresent,
              accountLoadFailure:
                bodyText.includes('无法加载你的账户')
                || lower.includes('unable to load your account'),
            }
          })()`,
          returnByValue: true,
        }, 3000)
        guardianHealthFailures = 0
        guardianLastCdpFailureScope = null
      }
      catch (error) {
        let browserLevelHealthy = false
        const browserPingStartedAt = Date.now()
        try {
          await guardian.browser.send('Browser.getVersion', {}, 1500)
          browserLevelHealthy = true
        }
        catch {
          browserLevelHealthy = false
        }
        guardianLastBrowserPingMs = Date.now() - browserPingStartedAt
        guardianLastCdpFailureScope = guardianCdpFailureScope(browserLevelHealthy)
        guardianHealthFailures += 1
        await log('guardian health probe failed', {
          consecutiveFailures: guardianHealthFailures,
          threshold: guardianHealthFailureThreshold,
          cdpFailureScope: guardianLastCdpFailureScope,
          browserPingMs: guardianLastBrowserPingMs,
          error: error instanceof Error ? error.message : String(error),
        })
        if (!shouldRebuildGuardianAfterHealthFailures(guardianHealthFailures, guardianHealthFailureThreshold)) {
          await writeState()
          await new Promise(resolve => setTimeout(resolve, 5000))
          continue
        }
        throw new Error(`guardian health probe failed ${guardianHealthFailures} consecutive times`)
      }
      if (runtime.result?.value?.discarded === true) {
        throw new Error('guardian renderer reports document.wasDiscarded=true')
      }

      const uiSnapshot = runtime.result?.value || null
      const uiFailure = guardianUiFailureKind(uiSnapshot)
      if (uiFailure) {
        guardianUiFailure = uiFailure
        const now = Date.now()
        if (guardianUiReloadAttemptedAt === null) {
          guardianUiReloadAttemptedAt = now
          const recoveryCommand = uiFailure === 'wrong-document' ? 'Page.navigate' : 'Page.reload'
          await log('guardian UI unhealthy; recovery requested', {
            failure: uiFailure,
            href: uiSnapshot?.href ?? null,
            ready: uiSnapshot?.ready ?? null,
            composerPresent: Boolean(uiSnapshot?.composerPresent),
            recoveryCommand,
          })
          if (recoveryCommand === 'Page.navigate') {
            await guardian.page.send('Page.navigate', {
              url: 'https://chatgpt.com/?' + GUARDIAN_MARKER + '=1',
            })
          }
          else {
            await guardian.page.send('Page.reload', { ignoreCache: false })
          }
          await writeState()
          await new Promise(resolve => setTimeout(resolve, 3000))
          continue
        }
        if (now - guardianUiReloadAttemptedAt >= 10_000) {
          throw new Error(`guardian UI failure persisted after soft reload: ${uiFailure}`)
        }
        await writeState()
        await new Promise(resolve => setTimeout(resolve, 2000))
        continue
      }
      if (uiSnapshot?.ready === 'complete') {
        guardianUiFailure = null
        guardianUiReloadAttemptedAt = null
      }

      // 首次加载时 gap 从 Guardian ready 起算；运行中 close 则从本次 CDP close 起算。
      // 必须先给第一方页面自己的 reconnect 机制完整 grace，超过 grace 仍无 socket 才重建页面。
      if (authHeaders && shouldRebuildGuardianForMissingWss({
        now: Date.now(),
        activeSockets: activeSocketIds.size,
        gapStartedAt: wssGapStartedAt,
        reconnectGraceMs: wssReconnectGraceMs,
      })) {
        throw new Error('guardian has no active ChatGPT WSS after readiness grace period')
      }

      // cooldown 到期只解除“主动 API 禁止”，不再拿完整 catalog 扫描当探针。
      // 先保持 WSS 在线；已知 ready conversation 由 drainDirty 逐条补 body。
      if (cooldownRecoveryPending && activeApiAllowed(cooldownUntil)) {
        try {
          rateLimits.legacyGlobalUntil = 0
          await syncGuardianRateLimitBlocks()
        }
        catch (error) {
          await log('Guardian REST block release failed after cooldown; recovery remains pending', {
            error: error instanceof Error ? error.message : String(error),
          })
          await writeState()
          await new Promise(resolve => setTimeout(resolve, 1000))
          continue
        }
        cooldownRecoveryPending = false
        cooldownUntil = 0
        recoveryProbeRemaining = recoveryProbeSuccesses
        lastReconcileAt = Date.now()
        if (pendingGapRepair) pendingGapRepair.lastAt = Date.now()
        await log('active API cooldown expired; passive-first recovery resumed', {
          recoveryProbeRemaining,
          recoveryProbeGapMs,
        })
      }
      // 后台归档/修复/图片/observer 工作只“调度”不等待；即使 Maintenance lane 仍在处理上一轮，
      // Critical lane 也会继续每 5 秒做 Guardian/CDP/WSS 健康检查。
      scheduleMaintenanceLane()
     // 运行态错误已经写入日志；完整健康迭代成功后清掉 state 里的 transient lastError，
      // 避免 CLI 永远显示一个几小时前已经自动恢复的问题。
      lastError = null
      await writeState()
    }
    catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      await log('daemon loop error', { error: lastError })
      // 保留 guardian/window 元数据，让下一轮 establishGuardian 能利用 previousWindowId
      // 清掉旧窗口里的半死 target。旧实现这里 guardian=null，会丢失这个唯一可靠的定位信息。
      guardian?.page?.close()
      await writeState()
      await new Promise(resolve => setTimeout(resolve, 3000))
    }
    await new Promise(resolve => setTimeout(resolve, 5000))
  }

 await log('daemon stopping')
  if (protocolDriftNotifyTimer) {
    clearTimeout(protocolDriftNotifyTimer)
    protocolDriftNotifyTimer = null
  }
  if (protocolFlushTimer) {
    clearTimeout(protocolFlushTimer)
    protocolFlushTimer = null
  }
  if (protocolLedger) {
    await protocolLedger.flush().catch(async (error) => {
      await log('protocol drift ledger final flush failed', {
        error: error instanceof Error ? error.message : String(error),
      }).catch(() => {})
    })
  }
  for (const [targetId, observer] of passivePageObservers) {
    await observer.cleanupLiveSseJournals?.('daemon-shutdown').catch(async (error) => {
      liveSseJournalErrors += 1
      await log('live SSE journal shutdown cleanup failed', {
        targetId,
        error: error instanceof Error ? error.message : String(error),
      }).catch(() => {})
    })
    observer.client.close()
  }
  passivePageObservers.clear()
  if (archiveBridge) {
    await archiveBridge.stop().catch(async (error) => {
      await log('Archive Bridge stop failed', {
        error: error instanceof Error ? error.message : String(error),
      }).catch(() => {})
    })
    archiveBridge = null
  }
  if (lifeOpsSync) {
    await lifeOpsSync.stop().catch(async (error) => {
      await log('LifeOps sync stop failed', {
        error: error instanceof Error ? error.message : String(error),
      }).catch(() => {})
    })
    lifeOpsSync = null
  }
  await requestEventLedger.close()
  guardian?.page?.close()
  guardian?.browser?.close()
  await writeState()
  devSpaceAuditWakeListener.close()
  devSpaceAuditBridge.close()
  await archiveMergeWorker.close().catch(async (error) => {
    await log('Archive merge worker stop failed', {
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => {})
  })
  await new Promise((resolve) => {
    if (!daemonSingleton.listening) return resolve()
    daemonSingleton.close(() => resolve())
  })
  archive.close()
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const fatalLogPath = daemonFatalLogPath()
  let fatalExitStarted = false

  /**
   * 顶层 fatal 必须“先落盘，再退出”。
   *
   * 安装 uncaughtException handler 后 Node 不会再自动退出，所以这里显式 process.exit(1)；
   * 不能在未知状态下继续跑 daemon。fatalExitStarted 同时避免 main reject 与进程事件
   * 竞争时重复写同一个异常。
   */
  const exitOnFatal = (source, error) => {
    if (fatalExitStarted) return
    fatalExitStarted = true
    const rendered = formatDaemonFatalError(error)
    void appendDaemonFatalLog(fatalLogPath, source, error)
      .finally(() => {
        console.error(rendered)
        process.exit(1)
      })
  }

  process.once('uncaughtException', error => exitOnFatal('uncaughtException', error))
  process.once('unhandledRejection', reason => exitOnFatal('unhandledRejection', reason))
  main().catch(error => exitOnFatal('main', error))
}


