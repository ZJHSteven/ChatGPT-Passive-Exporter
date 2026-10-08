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
import process from 'node:process'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ChatArchiveDb } from '../src/local/archive-db.ts'
import {
  ActiveTurnRecorder,
  buildBodySnapshotTrace,
  buildCatalogObservationTrace,
  buildWssLifecycleTrace,
} from '../src/local/active-turn-recorder.ts'
import {
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
  matchDevSpaceCandidateForTurn,
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

const DEFAULT_CDP = 'http://127.0.0.1:9222'
const GUARDIAN_MARKER = 'chatgpt-archive-guardian'
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_DB = path.join(PROJECT_ROOT, 'data', 'chatgpt-archive.sqlite')
const DEFAULT_STATE = path.join(PROJECT_ROOT, 'data', 'archive-daemon-state.json')
const DEFAULT_LOG = path.join(PROJECT_ROOT, 'data', 'archive-daemon.log')
const DEFAULT_TURN_TRACE = path.join(PROJECT_ROOT, 'data', 'active-turn-trace.jsonl')
const DEFAULT_NOTIFICATION_CONFIG = path.join(PROJECT_ROOT, 'data', 'archive-notification.local.json')
const DEFAULT_PROTOCOL_LEDGER = path.join(PROJECT_ROOT, 'data', 'protocol-fingerprints.json')
const DEFAULT_ACTOR_STATE = path.join(PROJECT_ROOT, 'data', 'archive-actor-state.json')
const DEFAULT_DOM_LEDGER = path.join(PROJECT_ROOT, 'data', 'dom-fingerprints.json')
const DEFAULT_BRIDGE_AUTH = path.join(PROJECT_ROOT, 'data', 'archive-bridge-auth.local.json')
const DEFAULT_LIFEOPS_SYNC_CONFIG = path.join(PROJECT_ROOT, 'data', 'lifeops-sync.local.json')
const DEFAULT_LIFEOPS_SYNC_PENDING = path.join(PROJECT_ROOT, 'data', 'lifeops-sync-pending.json')
const DEFAULT_BRIDGE_HOST = '127.0.0.1'
const DEFAULT_BRIDGE_PORT = 47_832
const DEFAULT_IMAGE_ASSET_DIR = path.join(PROJECT_ROOT, 'data', 'assets', 'chatgpt')
const DEVSPACE_POLL_OVERLAP_MS = 10_000
const DEVSPACE_INITIAL_LOOKBACK_MS = 2 * 60_000
const DEVSPACE_FALLBACK_POLL_MS = 60_000
const DEVSPACE_IDLE_ALERT_THRESHOLDS_MS = [60_000, 180_000, 300_000]
const DEVSPACE_IDLE_STARTUP_LOOKBACK_MS = 6 * 60_000
const IMAGE_ASSET_HYDRATE_INTERVAL_MS = 30_000
const SLEEPING_TARGET_RETRY_MS = 5 * 60_000
const WINDOWS_HIDE_HELPER = path.join(PROJECT_ROOT, 'scripts', 'windows-hide-window.ps1')
const DEFAULT_CDP_TIMEOUT_MS = 10_000
const DEFAULT_CHROME_SHORTCUT = process.platform === 'win32' && process.env.USERPROFILE
  ? path.join(process.env.USERPROFILE, 'Desktop', 'Chrome CDP 日常版.lnk')
  : null

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
export function shouldClassifyTerminalForTrigger(trigger) {
  const normalized = String(trigger || '').trim().toLowerCase()
  if (normalized.startsWith('watchdog:')) return true
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
 * 这和 shouldClassifyTerminalForTrigger 不同：watchdog / gap repair 可以读取 body 并识别
 * `client_stopped` 这类显式终止，但如果没有 complete 证据，单凭 reasoning/tool 尾巴仍不能
 * 推断“已经死了”。只有 WSS complete 或 catalog 明确 active→async_status=4 才允许把
 * `terminalEvidence=none + 非 final tail` 提升成异常 incident。
 */
export function isConfirmedTerminalTrigger(trigger) {
  const normalized = String(trigger || '').trim().toLowerCase().replace(/:settle$/u, '')
  if (normalized.startsWith('wss:') && normalized.includes('complete')) return true
  return normalized.startsWith('reconcile:') && normalized.endsWith(':async-complete')
}

/**
 * complete 是强 lifecycle 证据，但 conversation body 的持久化可能比 WSS complete 慢一拍。
 *
 * 第一次 complete 同步若仍只看到 terminalEvidence=none，不应立即把 reasoning/tool/in_progress
 * 快照推成 complete-no-final 手机告警。先保存事实并进入一次有界 settle；`:settle` 二次复核后
 * 仍无终态，才允许正式立案。显式 final / interrupted 不需要等待。
 */
export function shouldDeferConfirmedTerminalIncident(trigger, diagnostic) {
  const normalized = String(trigger || '').trim().toLowerCase()
  if (normalized.endsWith(':settle')) return false
  return isConfirmedTerminalTrigger(normalized) && diagnostic?.terminalEvidence === 'none'
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
 * watchdog，这里会比较 catalog.update_time 与 Archive 已落盘的 terminal snapshot。
 */
export function shouldStartCatalogWatchdog({
  alreadyActive = false,
  catalogUpdateTime = null,
  archivedUpdateTime = null,
  archivedTerminalState = null,
} = {}) {
  if (alreadyActive) return false
  const terminal = String(archivedTerminalState ?? '').trim().toLowerCase()
  const hasTerminal = terminal && terminal !== 'none' && terminal !== 'unknown'
  const parseTime = (value) => {
    if (value === null || value === undefined || value === '') return null
    const numeric = Number(value)
    return Number.isFinite(numeric) ? numeric : null
  }
  const catalogTime = parseTime(catalogUpdateTime)
  const archivedTime = parseTime(archivedUpdateTime)
  if (hasTerminal && catalogTime !== null && archivedTime !== null && catalogTime <= archivedTime) return false
  return true
}

/**
 * catalog update_time 前进代表服务端确实出现了新进展。
 *
 * 对已经超时诊断过的 catalog generation，不能继续沿用最早 firstSeenAt；否则下一次
 * 诊断文案会显示数百分钟的陈旧 age，而且首次 watchdog 甚至可能在刚发生进展后立刻触发。
 * 每次真实 progress 都从该观察时刻重新武装一个完整 watchdog 窗口，同时保留上次 body
 * 的 turn key，便于下次诊断识别“同 turn 恢复后又卡住”还是已经换到新 turn。
 */
export function recordCatalogWatchdogProgress(active, now = Date.now()) {
  if (!active || typeof active !== 'object') return active
  if (!String(active.startType || '').startsWith('catalog:')) return active
  const at = Number(now)
  if (!Number.isFinite(at) || at <= 0) return active
  return {
    ...active,
    lastEventAt: at,
  }
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
export function shouldAttachPassivePageObserver(target) {
  return Boolean(
    target?.type === 'page'
    && typeof target?.webSocketDebuggerUrl === 'string'
    && target.webSocketDebuggerUrl
    && String(target?.url || '').startsWith('https://chatgpt.com/')
  )
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
  if (previous && previous !== turnKey) {
    const observedStart = Number(observedTurnStartedAt)
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
  if (!String(trigger || '').startsWith('watchdog:')) return false
  // body 诊断完成后仍保留这一代 tombstone。只有明确 terminal 或明确发现新的 turn identity
  // 才由其它路径清除/替换；这样旧 first-tool、catalog update_time、async progress 都没有
  // “clear 后重新创建同一代”的机会。
  return false
}

/** 把 daemon trigger 映射到持久化 incident kind。 */
export function incidentKindForTrigger(trigger) {
  const normalized = String(trigger || '').trim().toLowerCase()
  if (normalized.startsWith('watchdog:catalog-active-timeout')) return 'active-zombie'
  if (normalized.startsWith('watchdog:')) return 'watchdog-timeout'
  return 'abnormal-terminal'
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
    title: 'ChatGPT Watchdog 已超时 · 等待诊断',
    body: [
      title || conversationId,
      `Watchdog 已运行 ${Math.floor(activeForMs / 60_000)} 分钟，达到超时阈值。`,
      '当前主动 body 请求处于 HTTP 429 cooldown，且尚无本次超时后的被动 body 可用于错误归因。',
      `本轮起点：${formatBeijingTime(startedAt || now)}`,
      `冷却至：${formatBeijingTime(cooldownUntil || now)}`,
      '冷却解除后会继续诊断；若随后确认异常，再发送最终诊断通知。',
    ].join('\n'),
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
    title: 'ChatGPT Watchdog 已超时',
    body: [
      title || conversationId,
      `Watchdog 已运行 ${Math.floor(activeForMs / 60_000)} 分钟，达到超时阈值。`,
      `本轮起点：${formatBeijingTime(startedAt || now)}`,
      '本 turn 已锁定为 timed-out；后续同 turn 的工具、WSS 或 catalog 进展不会重新启动 Watchdog。',
      'Archive 会继续等待/拉取 canonical body，诊断完成后再发送第二条结果通知。',
    ].join('\n'),
    url: conversationId ? `https://chatgpt.com/c/${encodeURIComponent(conversationId)}` : undefined,
  }
}

/**
 * Watchdog 两阶段通知的第二条：只要 canonical body 成功完成诊断，就必须给用户一个结果。
 * 这里不能依赖“是否新建 incident”，否则已有 incident / 同一 incident 更新会造成静默漏报。
 */
export function buildWatchdogDiagnosisNotificationPayload({ conversationId, title, diagnostic, incident = null }) {
  const terminal = String(diagnostic?.terminalEvidence || 'none')
  const tail = String(diagnostic?.tailShape || 'unknown')
  const reason = incident?.reason || (
    terminal === 'final'
      ? 'canonical body 已确认 final。'
      : `canonical body 已完成诊断：terminal=${terminal}，tail=${tail}。`
  )
  return {
    title: terminal === 'final'
      ? 'ChatGPT Watchdog 诊断完成 · 已有 Final'
      : 'ChatGPT Watchdog 诊断完成',
    body: [
      title || conversationId,
      reason,
      `terminal：${terminal}`,
      `tail：${tail}`,
    ].join('\n'),
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
  const subject = typeof title === 'string' && title.trim()
    ? `聊天：以“${title.trim()}”为主题（尚未绑定 Conversation）`
    : `聊天：未命名（${shortDevSpaceMetadataAlias(metadataId)}，尚未绑定 Conversation）`
  return {
    title: 'ChatGPT Watchdog 已超时 · 会话未绑定',
    body: [
      subject,
      `Watchdog 已运行 ${Math.floor(activeForMs / 60_000)} 分钟。`,
      '当前还没有足够证据把该 metadata 安全绑定到 canonical ChatGPT conversation，因此不能猜聊天名或 CID。',
      'Archive 已启动 catalog/body 修复；绑定成功后继续正常诊断。',
    ].join('\n'),
  }
}

/** 正常 final 也作为 turn 的最终可见结果发送，和异常 incident 对称。 */
export function buildTurnFinalNotificationPayload({ conversationId, title, diagnostic }) {
  const imageSuffix = diagnostic?.hasImageGenerationFinal
    ? `；包含 ${Number(diagnostic?.imageGenerationCount || 0)} 张生成图片`
    : ''
  return {
    title: 'ChatGPT Turn 正常完成',
    body: `${title || conversationId}\n服务端完成信号与 canonical body 已确认 final${imageSuffix}。`,
    url: `https://chatgpt.com/c/${encodeURIComponent(conversationId)}`,
  }
}

/**
 * 正常 final 通知只针对在线终态/Watchdog 诊断，不在 startup/periodic 历史补档时轰炸手机。
 * settle trigger 由 isConfirmedTerminalTrigger 自己去掉 `:settle` 后识别。
 */
export function shouldNotifyTurnFinal(trigger, diagnostic) {
  if (diagnostic?.terminalEvidence !== 'final') return false
  const normalized = String(trigger || '').trim().toLowerCase()
  if (normalized.startsWith('watchdog:')) return true
  if (normalized.startsWith('checkpoint:')) return true
  if (normalized.startsWith('reconcile:gap-repair')) return true
  if (normalized.startsWith('reconcile:wss-reconnect')) return true
  if (normalized.startsWith('reconcile:guardian-recover')) return true
  if (normalized.startsWith('reconcile:cooldown-recover')) return true
  return isConfirmedTerminalTrigger(normalized)
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
export const CAPTURED_HEADER_ALLOWLIST = [
    'authorization',
    'chatgpt-account-id',
    'oai-did',
    'oai-client-build-number',
    'oai-client-version',
    'oai-device-id',
    'oai-language',
    'oai-session-id',
    'originator',
    'x-oai-is-client-observation',
    'x-oai-mcp-form-version',
    'x-openai-codex-window-type',
    'x-openai-web-frontend',
  ]

export function sanitizeCapturedHeaders(headers) {
  const allowed = new Set(CAPTURED_HEADER_ALLOWLIST)
  const sanitized = {}
  for (const [key, value] of Object.entries(headers || {})) {
    const normalized = String(key).toLowerCase()
    if (allowed.has(normalized)) sanitized[normalized] = value
  }
  return sanitized
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
    || before.terminalEvidence !== after.terminalEvidence
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

/** 软 Bug 提醒的文案与正式 incident 明确分离；它不声称 turn 已结束。 */
export function buildDevSpaceIdleNotificationPayload({
  conversationId = null,
  title = null,
  metadataId = null,
  thresholdMs,
}) {
  const minutes = Math.round(Number(thresholdMs) / 60_000)
  const subject = title
    ? conversationId
      ? `聊天：${title}`
      : `聊天：以“${title}”为主题（尚未绑定 Conversation）`
    : `聊天：未命名（${shortDevSpaceMetadataAlias(metadataId)}，尚未绑定 Conversation）`
  const payload = {
    title: `DevSpace Bug · 工具静默 ${minutes} 分钟`,
    body: [
      subject,
      `DevSpace 已连续约 ${minutes} 分钟没有新的工具调用，且当前没有正在运行的 DevSpace 工具。`,
      '可能是本轮已经停止，也可能正在准备 Final、纯模型思考，或正在使用 DevSpace 之外的工具。',
      '这是软提醒，不代表 turn 已结束；Archive 的正式 Watchdog / incident 判定不受影响。',
    ].join('\n'),
    group: 'DevSpace Bug',
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
  const subject = title
    ? conversationId
      ? `聊天：${title}`
      : `聊天：以“${title}”为主题（尚未绑定 Conversation）`
    : `聊天：未命名（${shortDevSpaceMetadataAlias(metadataId)}，尚未绑定 Conversation）`
  const payload = {
    title: 'DevSpace Conclusion · 阶段性结论',
    body: [
      subject,
      `工具：${String(tool || 'unknown')}`,
      String(conclusion || '').trim(),
    ].filter(Boolean).join('\n'),
    group: 'DevSpace Conclusion',
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
      const stdout = execFileSync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-File', WINDOWS_HIDE_HELPER,
        '-TitleMarker', titleMarker,
      ], {
        encoding: 'utf8',
        timeout: 8000,
        windowsHide: true,
      }).trim()
      const [hwnd, visibleBefore, visibleAfter] = stdout.split(/\t/u)
      nativeWindow = stdout ? {
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
  const result = await page.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  const value = result?.result?.value
  if (!value || typeof value.status !== 'number') throw new Error(`No fetch result for ${url}`)
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

function listPath(offset, limit) {
  return `/backend-api/conversations?offset=${offset}&limit=${limit}&order=updated&is_archived=false&is_starred=false`
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
     const globalCatalog = !origin
        && !excludeOrigin
       && Number.isFinite(offset)
        && Number.isFinite(limit)
        && url.searchParams.get('order') === 'updated'
        && url.searchParams.get('is_archived') === 'false'
        && url.searchParams.get('is_starred') === 'false'
        && (hideSnorlax === null || hideSnorlax === 'false')
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
  const cdpHttp = String(flags.get('cdp') || DEFAULT_CDP).replace(/\/$/u, '')
  const dbPath = flags.has('db') ? path.resolve(String(flags.get('db'))) : DEFAULT_DB
  const statePath = flags.has('state') ? path.resolve(String(flags.get('state'))) : DEFAULT_STATE
  const logPath = flags.has('log') ? path.resolve(String(flags.get('log'))) : DEFAULT_LOG
  const turnTracePath = flags.has('turn-trace')
    ? path.resolve(String(flags.get('turn-trace')))
    : DEFAULT_TURN_TRACE
  const notificationConfigPath = flags.has('notification-config')
    ? path.resolve(String(flags.get('notification-config')))
    : DEFAULT_NOTIFICATION_CONFIG
  const protocolLedgerPath = flags.has('protocol-ledger')
    ? path.resolve(String(flags.get('protocol-ledger')))
    : DEFAULT_PROTOCOL_LEDGER
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
  const archive = new ChatArchiveDb(dbPath)
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
  let cooldownUntil = restoreCooldownUntil(previousDaemonState)
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
  let guardianRebuilds = 0
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
 const passivePageObservers = new Map()
  // Phase 3 只在内存/state 暴露当前 in-flight transport 的生命体征；不保存正文或 token。
  const activeLiveTransports = new Map()
  // Remote/跨设备 turn 没有本机原始 SSE 时，使用第一方 Web 已验证的
  // `stream_status + canonical body` checkpoint fallback。它只在明确 active CID 上建立，
  // 并和 LiveTurn transport 分开：一旦本机已经有真正 live transport，就暂停主动 checkpoint。
  const checkpointWatches = new Map()
  // 第一方 late-open 的 x-oai-turn-trace-id 已真机确认是每个 polling session 独立生成的 UUID。
  // raw trace 只驻留内存，不写 state/log；同一 Guardian 可以同时承载多个 CID 的独立 polling session。
  const checkpointTurnContexts = new Map()
  let checkpointInFlight = false
  let checkpointProbes = 0
  let checkpointBodyRefreshes = 0
  let checkpointErrors = 0
  let checkpointCompleted = 0
  const passiveObserverRetryAfter = new Map()
  const imageHydrationTargetRetryAfter = new Map()
  // body observation 可能恰好发生在一小时 cooldown 开始后。若缓存只有 10 分钟，
  // cooldown 结束时会忘掉已经免费拿到的 latest page，又重复请求一次。因此缓存寿命至少覆盖
  // 一个完整 cooldown 再加 10 分钟缓冲；catalog 是否可用于“当前 repair”另有 capturedAt 门槛。
  const passiveCacheMaxAgeMs = Math.max(10 * 60_000, (cooldownMinutes + 10) * 60_000)
  const passiveCatalogFreshnessMs = intFlag(flags, 'passive-catalog-freshness-ms', 60_000, 1000)
  let passiveBodyResponses = 0
  let passiveCatalogResponses = 0
  let passiveImageResponses = 0
  let passiveImageHydrations = 0
  let passiveImageCaptureErrors = 0
  let passive429Responses = 0
  let passiveBodyPagesReused = 0
  let passiveCatalogPagesReused = 0
  let guardianConversationRestBlocked = false
  // catalogActive 只表示“低频 conversation list 曾看见 async_status=3/5”。它不是可靠
  // turn start；若没有更强证据，activeTurns 可以用“首次观察时刻”作为保守 late-start 下界，
  // 但必须以 catalog:* 标记，并在一次诊断后保留 tombstone，不能把它伪装成 reliable start。
  // 这个集合另外用于识别 active→complete 与 update_time progress。
  const catalogActive = new Map()
  const activeTurns = new Map()
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
    activeTurns.delete(conversationId)
    archive.deleteActiveWatchdog(conversationId)
  }
  // daemon 重启必须恢复“原计时器”，而不是由最近一次 DevSpace audit 重新开表。
  // active_watchdogs 是 conversation 级状态，因此不受同一 CID 多 metadata 的影响。
  for (const persisted of archive.listActiveWatchdogs()) {
    let restoredStartedAt = Number(persisted.startedAt)
    const diagnosticKey = typeof persisted.lastDiagnosticTurnKey === 'string' && persisted.lastDiagnosticTurnKey
      ? persisted.lastDiagnosticTurnKey
      : null
    if (diagnosticKey) {
      const row = archive.db.prepare(`
        SELECT MIN(create_time) AS createTime
        FROM messages
        WHERE conversation_id = ?
          AND role = 'user'
          AND create_time IS NOT NULL
          AND (turn_exchange_id = ? OR request_id = ? OR message_id = ?)
      `).get(persisted.conversationId, diagnosticKey, diagnosticKey, diagnosticKey)
      const canonicalStartedAt = Number(row?.createTime) * 1000
      if (Number.isFinite(canonicalStartedAt) && canonicalStartedAt > 0 && canonicalStartedAt < restoredStartedAt) {
        restoredStartedAt = canonicalStartedAt
      }
    }
    const restored = {
      startedAt: restoredStartedAt,
      lastEventAt: persisted.lastEventAt,
      lastWatchdogAt: persisted.lastWatchdogAt,
      watchdogPendingAt: persisted.watchdogPendingAt,
      startType: persisted.startType,
      lastDiagnosticTurnKey: persisted.lastDiagnosticTurnKey,
    }
    activeTurns.set(persisted.conversationId, restored)
    if (restoredStartedAt !== Number(persisted.startedAt)) persistActiveTurn(persisted.conversationId, restored)
  }
  // metadata 尚未解出 canonical conversation 时，也先保存 first-tool 的真实时间。
  // binding 晚到以后仍以这个时间作为 watchdog.startedAt，不让发现延迟污染超时起点。
  const unboundDevSpaceTurns = new Map()
  const recentConversationComplete = new Map()
  const seenDevSpaceAuditIds = new Map()
  let devSpacePollSinceAt = Date.now() - DEVSPACE_INITIAL_LOOKBACK_MS
  let devSpaceLastPollAt = null
  let devSpaceLastFallbackPollAt = 0
  let devSpaceLastAuditAt = null
  let devSpaceLastError = null
  let devSpaceAuditsObserved = 0
  let devSpaceBindingsCreated = 0
  let devSpaceBindingMirrors = 0
  // 这里只追踪“最近有 DevSpace 活动、并且当前没有 running tool”的 metadata。
  // 每项保留上一轮观察到的 idle 时长，用于精确识别 1/3/5 分钟阈值穿越。
  const devSpaceIdleCandidates = new Map()
  let devSpaceIdleNotificationsQueued = 0
  // daemon 重启不能把一个已经计时几十分钟的 provisional watchdog 重新从 0 开始。
  // 从 Archive 自己的持久 binding 表恢复近期未绑定 metadata；firstSeenAt 仍是原始首个工具时间。
  for (const binding of archive.listDevSpaceMetadataBindings({
    onlyUnbound: true,
    sinceAt: Date.now() - Math.max(watchdogMs * 2, 2 * 60_000),
    limit: 1000,
  })) {
    unboundDevSpaceTurns.set(binding.metadataId, {
      startedAt: binding.firstSeenAt,
      lastEventAt: binding.lastSeenAt,
      lastAuditId: binding.lastAuditId,
      repairQueuedAt: null,
    })
  }
  // activeTurns 现在承载“所有已纳入 watchdog 的 active”：既可能来自可靠 WSS/actor start，
  // 也可能来自 catalog 首次观察到 active 的保守 late-start。两者不能在取证输出里混称 reliable。
  const isCatalogLateActive = (active) => String(active?.startType || '').startsWith('catalog:')
  const isWatchdogLatched = (active) => Number.isFinite(Number(active?.lastWatchdogAt))
  const reliableActiveIds = () => [...activeTurns.entries()]
    .filter(([, active]) => !isCatalogLateActive(active) && !isWatchdogLatched(active))
    .map(([conversationId]) => conversationId)
  const catalogLateActiveIds = () => [...activeTurns.entries()]
    .filter(([, active]) => isCatalogLateActive(active) && !isWatchdogLatched(active))
    .map(([conversationId]) => conversationId)
  const timedOutWatchdogIds = () => [...activeTurns.entries()]
    .filter(([, active]) => isWatchdogLatched(active))
    .map(([conversationId]) => conversationId)
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

  const log = async (message, extra = null) => {
    const line = `[${new Date().toISOString()}] ${message}${extra ? ` ${JSON.stringify(extra)}` : ''}\n`
    await fs.appendFile(logPath, line).catch(() => {})
    console.error(line.trim())
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

  const conversationTitle = (conversationId) => {
    const row = archive.db.prepare('SELECT title FROM conversations WHERE id=?').get(conversationId)
    return row?.title || conversationId
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

  const refreshDevSpaceIdleCandidate = (metadataId, now = Date.now()) => {
    const state = devSpaceAuditBridge.metadataToolState(metadataId)
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
      }
    }
  }

  /**
   * DevSpace audit 一旦携带 conclusion 就立即旁路 Bark。
   *
   * 这里故意先解析 conclusion、确认非空后才额外读取 metadata title / binding，避免给绝大多数
   * 普通工具调用增加 SQLite 查询。通知 key 直接使用 append-only audit id，因此 begin/finish UDP、
   * 60 秒 durable catch-up、daemon 重启重放都只能成功发送一次。
   */
  const dispatchDevSpaceConclusionNotification = (event) => {
    if (!notificationConfig || !event?.id || !event?.metadataId) return false
    const conclusion = extractDevSpaceConclusion(event.argsJson)
    if (!conclusion) return false

    const binding = archive.getDevSpaceMetadataBinding(event.metadataId)
    const conversationId = binding?.conversationId || null
    const metadataState = conversationId ? null : devSpaceAuditBridge.metadataToolState(event.metadataId)
    const title = conversationId
      ? conversationTitle(conversationId)
      : metadataState?.title ?? null

    return dispatchPersistentNotification({
      notificationKey: `devspace-conclusion:${event.id}`,
      kind: 'devspace-conclusion',
      conversationId,
      turnKey: binding?.lastTurnExchangeId ?? null,
      payload: buildDevSpaceConclusionNotificationPayload({
        conversationId,
        title,
        metadataId: event.metadataId,
        tool: event.tool,
        conclusion,
      }),
      successLog: 'DevSpace conclusion notification sent',
      failureLog: 'DevSpace conclusion notification failed',
      logFields: {
        metadataId: event.metadataId,
        auditId: event.id,
        tool: event.tool,
        bound: Boolean(conversationId),
      },
    })
  }

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
    try {
      const result = await sendIncidentNotification(notificationConfig, { title, body })
      if (result.ok) {
        const sentAt = Date.now()
        for (const assessment of queued) {
          archive.markTurnNotificationSent({
            notificationKey: `protocol-drift:${assessment.dedupeKey}`,
            kind: 'protocol-drift',
            sentAt,
            providerStatus: result.status,
            payload: { title, body, assessment },
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
    database: dbPath,
    turnTrace: turnTracePath,
    cdp: cdpHttp,
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
      rebuilds: guardianRebuilds,
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
      lastPollAt: devSpaceLastPollAt,
      lastAuditAt: devSpaceLastAuditAt,
      lastError: devSpaceLastError,
      auditsObserved: devSpaceAuditsObserved,
      bindingsCreated: devSpaceBindingsCreated,
      bindingMirrors: devSpaceBindingMirrors,
      unboundActive: unboundDevSpaceTurns.size,
      idleCandidates: devSpaceIdleCandidates.size,
      idleNotificationsQueued: devSpaceIdleNotificationsQueued,
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
      timedOutAwaitingDiagnosis: timedOutWatchdogIds().length,
      oldestActiveMs: (reliableActiveIds().length + catalogLateActiveIds().length) > 0
        ? Math.max(...[...activeTurns.values()]
            .filter(item => !isWatchdogLatched(item))
            .map(item => Date.now() - item.startedAt))
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
        imageResponses: passiveImageResponses,
        imageHydrations: passiveImageHydrations,
        imageCaptureErrors: passiveImageCaptureErrors,
        http429Responses: passive429Responses,
        bodyPagesReused: passiveBodyPagesReused,
        catalogPagesReused: passiveCatalogPagesReused,
        bodyCacheEntries: passiveBodyPages.size,
        catalogCacheEntries: passiveCatalogPages.size,
        guardianConversationRestBlocked,
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
    cooldownUntil: cooldownUntil || null,
    cooldownRecoveryPending,
    recoveryProbeRemaining,
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
  const startedAt = Date.now()
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

  const latestOpenIncident = (conversationId) => archive.db.prepare(`
    SELECT i.id, i.turn_exchange_id AS turnExchangeId, i.turn_key AS turnKey,
           i.incident_kind AS incidentKind, i.lifecycle_class AS lifecycleClass,
           i.detected_at AS detectedAt, i.last_observed_at AS lastObservedAt, i.status,
           i.reason, i.terminal_evidence AS terminalEvidence, i.tail_shape AS tailShape,
           c.title
    FROM incidents i
    JOIN conversations c ON c.id = i.conversation_id
    WHERE i.conversation_id = ? AND i.status = 'open'
    ORDER BY i.detected_at DESC
    LIMIT 1
  `).get(conversationId) || null

  const incidentSnapshots = (conversationId) => archive.db.prepare(`
    SELECT i.id, i.turn_exchange_id AS turnExchangeId, i.turn_key AS turnKey,
           i.incident_kind AS incidentKind, i.lifecycle_class AS lifecycleClass,
           i.reason, i.terminal_evidence AS terminalEvidence, i.tail_shape AS tailShape,
           i.detected_at AS detectedAt, i.last_observed_at AS lastObservedAt, i.status,
           c.title
    FROM incidents i
    JOIN conversations c ON c.id = i.conversation_id
    WHERE i.conversation_id = ?
    ORDER BY i.detected_at ASC, i.id ASC
  `).all(conversationId)

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
        cooldownUntil: Number(cooldownUntil || 0) || null,
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
    const body = [
      incident.title || conversationId,
      incident.reason || `${incident.terminalEvidence || 'abnormal'} / ${incident.tailShape || 'unknown tail'}`,
    ].filter(Boolean).join('\n')
    const payload = {
      title: incident.lifecycleClass === 'watchdog-timeout'
        ? 'ChatGPT Watchdog 超时'
        : incident.lifecycleClass === 'active-zombie'
          ? 'ChatGPT Watchdog 超时 · Active Zombie'
        : incident.lifecycleClass === 'complete-no-final'
          ? 'ChatGPT Complete · 无 Final'
        : incident.lifecycleClass === 'explicit-interrupted'
          ? 'ChatGPT 运行中断'
          : 'ChatGPT 异常结束',
      body,
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
    if (activeApiAllowed(cooldownUntil, now)) return false
    const startedAt = Number(active.startedAt || now)
    const turnKey = typeof active.lastDiagnosticTurnKey === 'string' && active.lastDiagnosticTurnKey
      ? active.lastDiagnosticTurnKey
      : `generation:${startedAt}`
    const payload = buildWatchdogDeferredNotificationPayload({
      conversationId,
      title: conversationTitle(conversationId),
      startedAt,
      now,
      cooldownUntil,
    })
    return dispatchPersistentNotification({
      notificationKey: `watchdog-deferred-cooldown:${conversationId}:${startedAt}`,
      kind: 'watchdog-deferred-cooldown',
      conversationId,
      turnKey,
      payload,
      successLog: 'watchdog cooldown-deferred notification sent',
      failureLog: 'watchdog cooldown-deferred notification failed',
      logFields: { startedAt, cooldownUntil },
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
      title: 'ChatGPT 图片节点',
      body: `${conversationTitle}\n本轮已进入并完成 ImageGen，归档识别到 ${event.imageCount} 张图片。`,
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
    if (!authHeaders || !guardian?.page || guardian.page.closed || !activeApiAllowed(cooldownUntil)) return

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

  const tripCooldown = async (reason, details = {}) => {
    const now = Date.now()
    const previousCooldownUntil = Number(cooldownUntil || 0)
    const wasAlreadyCooling = previousCooldownUntil > now
    cooldownUntil = now + cooldownMinutes * 60_000
    cooldownRecoveryPending = true
    recoveryProbeRemaining = 0
    // 429 本身就是“现在不适合做主动扫描”的强证据。把 periodic 基准推进到本次 429，
    // 防止 daemon 已运行很久时在 cooldown 一结束就因为旧 lastReconcileAt 立即深扫 catalog。
    lastReconcileAt = now
    await log('active API cooldown armed', {
      reason,
      cooldownUntil,
      wasAlreadyCooling,
      previousCooldownUntil: previousCooldownUntil > 0 ? previousCooldownUntil : null,
      extensionMs: wasAlreadyCooling ? Math.max(0, cooldownUntil - previousCooldownUntil) : null,
      ...details,
    })
    if (!wasAlreadyCooling) {
      dispatchCooldownNotification({
        reason,
        cooldownUntil,
        route: details.route ?? null,
        retryAfter: details.retryAfter ?? null,
      })
    }
    await setGuardianConversationRestBlocked(true).catch(async (error) => {
      await log('Guardian REST cooldown block failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }

  const requireRequestWindow = () => {
    if (Date.now() < cooldownUntil) throw new Error(`active API cooldown until ${new Date(cooldownUntil).toISOString()}`)
    if (!authHeaders) throw new Error('no captured first-party auth context yet')
    if (!guardian?.page || guardian.page.closed) throw new Error('guardian page unavailable')
  }

  const waitForRequestSlot = async (kind) => {
    const configuredGap = kind === 'catalog' ? reconcileDelayMs : syncDelayMs
    const baseGap = effectiveActiveRequestGap(configuredGap, recoveryProbeRemaining, recoveryProbeGapMs)
    const jitter = requestJitterMs > 0 ? Math.floor(Math.random() * (requestJitterMs + 1)) : 0
    if (lastActiveRequestAt > 0) {
      const waitMs = lastActiveRequestAt + baseGap + jitter - Date.now()
      if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs))
    }
    lastActiveRequestAt = Date.now()
  }

 const fetchChecked = async (request, options = {}) => {
   requireRequestWindow()
   // checkpoint fallback 的第一方行为是“先 stream_status，再几乎立即拉 latest body”。
   // 为了复刻这个**配对请求**而不是把两次请求都强行隔开 6 秒，调用方可以在已经
   // 占用过一次全局 request slot 后，仅对紧接着的 latest body 跳过第二次 wait。
   // 其它分页/cursor/mapping 仍会重新经过全局 gate，因此不会把这个选项变成绕过节流的后门。
   if (options.skipRequestSlot !== true) {
     await waitForRequestSlot(request.kind === 'catalog' ? 'catalog' : 'body')
   }
    activeReplayRequestUrl = relativeBackendUrl(request.url)
    let response
    try {
      const headers = options.extraHeaders
        ? { ...authHeaders, ...options.extraHeaders }
        : authHeaders
      response = await pageFetchJson(guardian.page, { ...request, headers })
    }
    finally {
      activeReplayRequestUrl = null
    }
   if (response.status === 429) {
      await tripCooldown(`active ${request.kind || 'body'} HTTP 429`, {
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

  const syncConversation = async (conversationId, trigger, options = {}) => {
    const syncReadyAt = Number(readySince.get(conversationId) || Date.now())
    const classifyTerminal = shouldClassifyTerminalForTrigger(trigger)
    const confirmedTerminal = isConfirmedTerminalTrigger(trigger)
    const requestedIncidentKind = incidentKindForTrigger(trigger)
    let newIncident = null
    const incidentIdsBefore = new Set(incidentSnapshots(conversationId).map(incident => incident.id))
    const basePath = `/backend-api/conversations/${encodeURIComponent(conversationId)}`
    const passiveFirst = reusablePassiveBodyPage(conversationId, null, syncReadyAt)
    const first = passiveFirst?.payload ?? await fetchChecked({
      url: `${basePath}?include_has_versions=true&num_turns=10`,
      targetPath: basePath,
      targetRoute: '/backend-api/conversations/{conversation_id}',
      kind: 'body',
    }, {
      skipRequestSlot: options.skipFirstRequestSlot === true,
      extraHeaders: options.extraHeaders,
    })
    if (passiveFirst) passiveBodyPagesReused += 1
    if (!Array.isArray(first.messages)) throw new Error(`conversation ${conversationId} latest body has no messages[]`)

    // 先在内存中预诊断最新页，再决定本次 observation 有没有资格创建 incident。
    // 这样 complete 已经到达、但 body 仍落后一拍时，仍然可以正常落 messages/raw observation，
    // 同时把“异常立案”推迟到唯一一次 settle 复核，避免把正常持久化延迟发成 Bark 红牌。
    const preliminaryDiagnostic = diagnoseLatestRun({
      ...first,
      conversation_id: first.conversation_id || conversationId,
    })
    let watchdogTurnChanged = false
    let watchdogTurnStartedAt = null
    let watchdogTurnAlreadyTimedOut = false
    if (String(trigger || '').startsWith('watchdog:')) {
      const currentActive = activeTurns.get(conversationId)
      if (currentActive) {
        const diagnosedAt = Date.now()
        const observedTurnStartedAt = watchdogTurnStartedAtFromPayload(first, preliminaryDiagnostic)
        const reconciled = reconcileWatchdogDiagnosticTurn(
          currentActive,
          preliminaryDiagnostic,
          diagnosedAt,
          observedTurnStartedAt,
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
        activeTurns.set(conversationId, reconciled.nextActive)
        persistActiveTurn(conversationId, reconciled.nextActive)
        if (watchdogTurnChanged) {
          void log('watchdog body belongs to a newer turn; reconciled turn start', {
            conversationId,
            trigger,
            previousTurnKey: currentActive.lastDiagnosticTurnKey ?? null,
            turnKey: reconciled.turnKey,
            turnStartedAt: watchdogTurnStartedAt,
            turnStartSource: reconciled.turnStartSource,
            alreadyTimedOut: watchdogTurnAlreadyTimedOut,
          })
        }
      }
    }
    const terminalSettleNeeded = classifyTerminal
      && shouldDeferConfirmedTerminalIncident(trigger, preliminaryDiagnostic)
    const classifyTerminalNow = classifyTerminal && !terminalSettleNeeded
    const incidentBefore = classifyTerminalNow ? latestOpenIncident(conversationId) : null

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
      const merged = archive.mergeLiveMessagesPage(normalized, {
        observedAt: Date.now(),
        endpoint: pages === 0 ? basePath : `${basePath}/messages`,
        pageCursor: cursor,
        observationKind: `body-page:${trigger}`,
        updateCurrentState: pages === 0,
        classifyTerminal: pages === 0 && classifyTerminalNow,
        // watchdog 的语义是“已经超时，所以这个 turn 本身就是需要调查的 incident”。
        // COMPLETE 只决定它是不是 confirmed terminal；不能拿“尚未 COMPLETE”把 watchdog 变成空操作。
        allowIncompleteTailIncident: pages === 0
          && !terminalSettleNeeded
          && (!watchdogTurnChanged || watchdogTurnAlreadyTimedOut)
          && (confirmedTerminal || trigger.startsWith('watchdog:')),
        incidentKind: requestedIncidentKind,
      })
      if (pages === 0) latestDiagnostic = merged.diagnostic
      if (pages === 0 && merged.diagnostic.hasImageGenerationFinal) {
        imageGenerationEvent = archive.getImageGenerationEvent(conversationId, merged.diagnostic.turnExchangeId)
      }
      if (pages === 0 && classifyTerminalNow) {
        const incidentAfter = latestOpenIncident(conversationId)
        if (shouldNotifyIncidentTransition(incidentBefore, incidentAfter)) newIncident = incidentAfter
      }
      newMessages += merged.newMessageCount
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
                kind: 'body',
              })
              if (!mappingPayload?.mapping || typeof mappingPayload.mapping !== 'object') {
                throw new Error(`conversation ${conversationId} singular response has no mapping`)
              }
              const mappingResult = archive.mergeLiveMappingSnapshot(mappingPayload, {
                observedAt: Date.now(),
                endpoint: singularPath,
                observationKind: `mapping-snapshot:${trigger}`,
              })
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
          terminalSettleNeeded,
          watchdogTurnChanged,
          watchdogTurnStartedAt,
          watchdogTurnAlreadyTimedOut,
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
      }, {
        extraHeaders: options.extraHeaders,
      })
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
    if (!authHeaders || !guardian?.page || guardian.page.closed || !activeApiAllowed(cooldownUntil, now)) {
      const retryAt = Math.max(
        now + checkpointErrorRetryMs,
        Number(cooldownUntil || 0) > now ? Number(cooldownUntil) + 1000 : 0,
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
        if (diagnostic.terminalEvidence !== 'none') {
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

      reconcileDevSpaceBindingFromBody(conversationId, result.diagnostic)
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
      if (result.diagnostic.terminalEvidence !== 'none') {
        stopCheckpointWatch(conversationId, 'body-terminal-while-status-streaming')
        markSyncReady(conversationId, 'checkpoint:body-terminal', 0)
      }
    }
    catch (error) {
      checkpointErrors += 1
      const message = error instanceof Error ? error.message : String(error)
      const latest = checkpointWatches.get(conversationId)
      if (latest) {
        const cooldownError = message.includes('HTTP 429') || message.startsWith('active API cooldown until ')
        const authError = message.includes('auth context expired') || message.includes('no captured first-party auth context')
        const retryDelayMs = cooldownError && cooldownUntil > Date.now()
          ? Math.max(checkpointErrorRetryMs, cooldownUntil - Date.now() + 1000)
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
        cooldownUntil: cooldownUntil || null,
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
    const activeWindowAvailable = activeApiAllowed(cooldownUntil, now)
      && Boolean(authHeaders)
      && Boolean(guardian?.page)
      && !guardian?.page?.closed
    const nextReady = [...ready.entries()].find(([conversationId]) => {
      if (now < Number(readyNotBefore.get(conversationId) || 0)) return false
      if (activeWindowAvailable) return true
      const readyAt = Number(readySince.get(conversationId) || now)
      return Boolean(reusablePassiveBodyPage(conversationId, null, readyAt))
    })
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
        const watchdogGenerationStartedAt = String(trigger || '').startsWith('watchdog:')
          ? Number(activeTurns.get(conversationId)?.startedAt || 0)
          : 0
        const result = await syncConversation(conversationId, trigger)
        syncedConversations += 1
        if (String(trigger || '').startsWith('watchdog:')) {
          const active = activeTurns.get(conversationId)
          if (active) {
            active.watchdogPendingAt = null
            persistActiveTurn(conversationId, active)
          }
        }
        // body 一旦给出 turn_exchange_id，就可以把 earlier provisional metadata 做后验校验；
        // 该步骤只读局部时间窗，不扫描整库。
        reconcileDevSpaceBindingFromBody(conversationId, result.diagnostic)
        const watchdogGenerationDone = shouldCloseWatchdogGenerationAfterSync(trigger, result)
        if (watchdogGenerationDone && activeTurns.has(conversationId)) {
          clearActiveTurn(conversationId)
          stopCheckpointWatch(conversationId, 'watchdog-diagnostic-complete', Date.now())
          archive.updateDevSpaceBindingTurn({
            conversationId,
            turnExchangeId: result.diagnostic.turnExchangeId ?? null,
            requestId: result.diagnostic.requestId ?? null,
            observedAt: Date.now(),
            lifecycleState: 'closed',
          })
          await log('watchdog diagnostic closed active generation', {
            conversationId,
            trigger,
            turnKey: watchdogDiagnosticTurnKey(result.diagnostic),
            watchdogTurnChanged: result.watchdogTurnChanged,
            watchdogTurnAlreadyTimedOut: result.watchdogTurnAlreadyTimedOut,
          })
        }
        // 一次 overlap 同步成功以后，本地副本已经追到本次 observation，因此才清 dirty。
        dirty.delete(conversationId)
        readySince.delete(conversationId)
        readyNotBefore.delete(conversationId)
        if (result.diagnostic.terminalEvidence !== 'none') {
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
        if (result.terminalSettleNeeded) {
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
          exactMapping: result.exactMapping,
          passivePagesUsed: result.passivePagesUsed,
          terminal: result.diagnostic.terminalEvidence,
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
          terminalEvidence: result.diagnostic.terminalEvidence ?? null,
          tailShape: result.diagnostic.tailShape ?? null,
        })
        // Canonical merge 成功后才推 LifeOps：这样 Inbox 永远来自已经持久化的 Archive 事实，
        // 不会把半截 SSE/WSS chunk 当成工作现场。相同 conversation+turn 的后续 body 会被 outbox 合并。
        if (lifeOpsSync) {
          const worksite = buildArchiveBridgeWorksite(
            archive,
            conversationId,
            result.diagnostic.turnExchangeId ?? null,
          )
          if (worksite) lifeOpsSync.enqueue(worksite)
        }
        // SQLite/trace 到这里已经完成；通知只从已落库事实分叉出去，不参与 syncInFlight。
        // Watchdog 固定是“两阶段”：到点时已经发第一条；body 一旦诊断成功，这里无条件发第二条，
        // 不再额外叠加 turn-final / incident Bark，确保同一 Watchdog turn 最多恰好两条。
        if (String(trigger || '').startsWith('watchdog:')) {
          dispatchWatchdogDiagnosisNotification(
            conversationId,
            watchdogGenerationStartedAt,
            result.diagnostic,
            result.newIncident || latestOpenIncident(conversationId),
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
        ready.set(conversationId, trigger)
        if (lastError.startsWith('active API cooldown until ')) {
          readyNotBefore.set(conversationId, Math.max(Date.now() + 5000, cooldownUntil))
        }
        else readyNotBefore.set(conversationId, Date.now() + 5000)
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
    dirty.set(conversationId, trigger)
    ready.set(conversationId, trigger)
    if (!readySince.has(conversationId)) readySince.set(conversationId, now)
    readyNotBefore.set(conversationId, now + Math.max(0, Number(delayMs) || 0))
    setTimeout(() => { void drainDirty() }, delayMs)
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

  /**
   * metadata 已经绑定时，每个新 DevSpace tool call 都是“该 conversation 当前有 active turn”
   * 的强证据。startedAt 只在 activeTurns 原本不存在时写一次；同一轮后续调用仅推进
   * lastEventAt，因此不会把 45 分钟 watchdog 不断向后重置。
   */
  const activateBoundDevSpaceTurn = (binding, auditAt) => {
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
    const watchdogLatched = isWatchdogLatched(current)
    if (current) {
      current.lastEventAt = Math.max(Number(current.lastEventAt || 0), auditAt)
      persistActiveTurn(conversationId, current)
    }
    else {
      const nextActive = devSpaceFirstToolWatchdogState(auditAt)
      activeTurns.set(conversationId, nextActive)
      persistActiveTurn(conversationId, nextActive)
      void log('DevSpace first tool started watchdog', {
        conversationId,
        startedAt: auditAt,
        metadataId: binding.metadataId,
      })
    }
    // Watchdog 一旦到点，这一代进入 timed-out tombstone。后续同 turn 的 DevSpace tool 只说明
    // “它可能还在继续跑”，不能据此把同一代重新当 running，更不能重新开启 checkpoint/body polling。
    if (!watchdogLatched) armCheckpointWatch(conversationId, 'devspace:first-tool', auditAt)
    archive.updateDevSpaceBindingTurn({
      conversationId,
      observedAt: auditAt,
      lifecycleState: watchdogLatched ? 'timed_out' : 'active',
    })
  }

  const bindDevSpaceMetadataToConversation = (input) => {
    const existing = archive.getDevSpaceMetadataBinding(input.metadataId)
    const provisional = unboundDevSpaceTurns.get(input.metadataId)
    const timedOutBeforeBinding = Boolean(existing?.unboundWatchdogAt || provisional?.repairQueuedAt)
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
      evidence: input.evidence,
      confidence: input.confidence,
      observedAt: input.observedAt,
      turnExchangeId: input.turnExchangeId ?? null,
      requestId: input.requestId ?? null,
      lifecycleState,
    })
    unboundDevSpaceTurns.delete(input.metadataId)
    if (!existing?.conversationId) devSpaceBindingsCreated += 1
    mirrorDevSpaceBinding(binding)
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
    })
    if (lifecycleState === 'active') activateBoundDevSpaceTurn(binding, input.startAt)
    if (timedOutBeforeBinding) {
      // timeout 只是“强制诊断”的触发器。现在 CID 已经通过 exact body match 解出，
      // 才把真正 conversation 交给现有 watchdog 诊断/incident/Bark 流程。
      markSyncReady(input.conversationId, 'watchdog:devspace-timeout', 0)
      void log('timed-out DevSpace metadata bound; queued conversation watchdog diagnostic', {
        metadataId: input.metadataId,
        conversationId: input.conversationId,
      })
    }
    return binding
  }

  const handleDevSpaceAuditEvent = (event) => {
    if (seenDevSpaceAuditIds.has(event.id)) return
    seenDevSpaceAuditIds.set(event.id, event.startedAtMs)
    devSpaceAuditsObserved += 1
    devSpaceLastAuditAt = Math.max(Number(devSpaceLastAuditAt || 0), event.startedAtMs)
    const binding = archive.observeDevSpaceMetadata({
      metadataId: event.metadataId,
      auditId: event.id,
      auditAt: event.startedAtMs,
    })
    // begin 事件会看到 runningTools>0 并立即取消旧 idle generation。
    // finish 事件即使 auditId 已经见过，也会由 wake callback 额外按 metadata 重读。
    refreshDevSpaceIdleCandidate(event.metadataId)
    dispatchDevSpaceConclusionNotification(event)
    if (binding.conversationId) {
      activateBoundDevSpaceTurn(binding, event.startedAtMs)
      return
    }
    const current = unboundDevSpaceTurns.get(event.metadataId)
    const persistedStartAt = Number(binding.firstSeenAt || event.startedAtMs)
    const generationRestarted = Boolean(current && persistedStartAt > Number(current.startedAt || 0))
    unboundDevSpaceTurns.set(event.metadataId, {
      startedAt: generationRestarted ? persistedStartAt : (current?.startedAt ?? persistedStartAt),
      lastEventAt: Math.max(Number(current?.lastEventAt || 0), event.startedAtMs),
      lastAuditId: event.id,
      repairQueuedAt: generationRestarted ? null : (current?.repairQueuedAt ?? null),
    })
  }

  const pollDevSpaceAudits = () => {
    try {
      const events = devSpaceAuditBridge.pollSince(Math.max(0, devSpacePollSinceAt - DEVSPACE_POLL_OVERLAP_MS))
      for (const event of events) handleDevSpaceAuditEvent(event)
      if (events.length > 0) {
        devSpacePollSinceAt = Math.max(devSpacePollSinceAt, ...events.map(event => event.startedAtMs + 1))
      }
      devSpaceLastPollAt = Date.now()
      devSpaceLastError = null
      for (const [auditId, at] of seenDevSpaceAuditIds) {
        if (!shouldRetainSeenDevSpaceAudit(at, devSpacePollSinceAt, DEVSPACE_POLL_OVERLAP_MS)) {
          seenDevSpaceAuditIds.delete(auditId)
        }
      }
    }
    catch (error) {
      devSpaceLastError = error instanceof Error ? error.message : String(error)
    }
  }

  /**
   * 对一个已经落盘的 ChatGPT turn 做 DevSpace binding。
   *
   * 关键点：不再用“时间窗里只有一个 metadata”判断身份。body 里的 api_tool.call_tool
   * 本来就保存了 DevSpace tool 名和完整 args；tool_audit 也保存同一份 args，因此用
   * canonical exact-match + 同 fingerprint 的局部时间一致性判断身份。
   */
  const matchDevSpaceBindingFromStoredTurn = (conversationId, turnExchangeId) => {
    const rows = archive.db.prepare(
      "SELECT create_time AS createTime, text FROM messages WHERE conversation_id=? AND turn_exchange_id=? AND recipient='api_tool.call_tool' AND create_time IS NOT NULL AND text<>'' ORDER BY create_time ASC",
    ).all(conversationId, turnExchangeId)
    const bodyCalls = rows
      .map(row => parseDevSpaceBodyToolCall(String(row.text || ''), Number(row.createTime) * 1000))
      .filter(Boolean)
    if (bodyCalls.length === 0) return null

    const startAt = Math.min(...bodyCalls.map(call => call.startedAtMs))
    const endAt = Math.max(...bodyCalls.map(call => call.startedAtMs))
    // 两分钟 slack 只为覆盖 Host/SQLite 时间戳落点差异；身份判定本身完全由 tool+args 决定。
    const activities = devSpaceAuditBridge.activityBetween(startAt - 120_000, endAt + 120_000, 5000)
    const boundIds = archive.listDevSpaceMetadataBindings({ limit: 1000 })
      .filter(row => Boolean(row.conversationId))
      .map(row => row.metadataId)
    const match = matchDevSpaceCandidateForTurn({
      activities,
      bodyCalls,
      alreadyBoundMetadataIds: boundIds,
    })
    if (!match) return null

    const provisional = unboundDevSpaceTurns.get(match.activity.metadataId)
    return {
      metadataId: match.activity.metadataId,
      startAt: provisional?.startedAt ?? match.activity.firstAt,
      exactMatches: match.exactMatches,
      uniqueMatches: match.uniqueMatches,
    }
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
  const backfillStoredDevSpaceBindings = ({ sinceAt = null } = {}) => {
    const unbound = archive.listDevSpaceMetadataBindings({
      onlyUnbound: true,
      ...(Number.isFinite(Number(sinceAt)) ? { sinceAt: Number(sinceAt) } : {}),
      limit: 1000,
    })
    if (unbound.length === 0) return 0

    const globalStartAt = Math.max(
      0,
      Math.min(...unbound.map(binding => Math.max(
        Number(binding.firstSeenAt),
        Number.isFinite(Number(sinceAt)) ? Number(sinceAt) : 0,
      ))) - 5 * 60_000,
    )
    const globalEndAt = Math.max(
      ...unbound.map(binding => Number(binding.lastSeenAt)),
    ) + 5 * 60_000
    // 9/14 起真实 tool_audit 已超过两万行；历史 backfill 必须覆盖完整时间段，
    // 不能因为默认 limit 截断后半段而制造“随机只有一部分 metadata 能匹配”的假象。
    const activities = devSpaceAuditBridge.activityBetween(globalStartAt, globalEndAt, 100_000)
    if (activities.length === 0) return 0

    const rows = archive.db.prepare(
      "SELECT conversation_id AS conversationId, turn_exchange_id AS turnExchangeId, create_time AS createTime, text FROM messages WHERE recipient='api_tool.call_tool' AND create_time BETWEEN ? AND ? AND turn_exchange_id IS NOT NULL AND text<>'' ORDER BY create_time ASC",
    ).all(globalStartAt / 1000, globalEndAt / 1000)
    const callsByTurn = new Map()
    for (const row of rows) {
      const call = parseDevSpaceBodyToolCall(String(row.text || ''), Number(row.createTime) * 1000)
      if (!call) continue
      const key = `${row.conversationId}\n${row.turnExchangeId}`
      const existing = callsByTurn.get(key) ?? {
        conversationId: row.conversationId,
        turnExchangeId: row.turnExchangeId,
        calls: [],
        lastAt: 0,
      }
      existing.calls.push(call)
      existing.lastAt = Math.max(existing.lastAt, call.startedAtMs)
      callsByTurn.set(key, existing)
    }

    const boundIds = archive.listDevSpaceMetadataBindings({ limit: 1000 })
      .filter(binding => Boolean(binding.conversationId))
      .map(binding => binding.metadataId)
    const matchesByMetadata = new Map()
    for (const turn of callsByTurn.values()) {
      const match = matchDevSpaceCandidateForTurn({
        activities,
        bodyCalls: turn.calls,
        alreadyBoundMetadataIds: boundIds,
      })
      if (!match) continue
      const matches = matchesByMetadata.get(match.activity.metadataId) ?? []
      matches.push({
        conversationId: turn.conversationId,
        turnExchangeId: turn.turnExchangeId,
        lastAt: turn.lastAt,
        exactMatches: match.exactMatches,
        uniqueMatches: match.uniqueMatches,
      })
      matchesByMetadata.set(match.activity.metadataId, matches)
    }

    let created = 0
    for (const binding of unbound) {
      const matches = matchesByMetadata.get(binding.metadataId) ?? []
      const conversationIds = [...new Set(matches.map(match => match.conversationId))]
      if (conversationIds.length !== 1 || matches.length === 0) continue
      const best = matches.sort((a, b) =>
        b.uniqueMatches - a.uniqueMatches
        || b.exactMatches - a.exactMatches
        || b.lastAt - a.lastAt)[0]
      bindDevSpaceMetadataToConversation({
        metadataId: binding.metadataId,
        conversationId: best.conversationId,
        startAt: binding.firstSeenAt,
        observedAt: Date.now(),
        turnExchangeId: best.turnExchangeId,
        evidence: 'body:exact-tool-args-backfill-v2-time-local',
        confidence: 'high',
        lifecycleState: 'closed',
      })
      created += 1
    }
    return created
  }

  const reconcileDevSpaceBindingFromBody = (conversationId, diagnostic) => {
    const now = Date.now()
    const turnExchangeId = typeof diagnostic?.turnExchangeId === 'string' ? diagnostic.turnExchangeId : null
    const requestId = typeof diagnostic?.requestId === 'string' ? diagnostic.requestId : null
    const existing = archive.getDevSpaceMetadataBindingsForConversation(conversationId)
    if (existing.length > 0) {
      // 一个 canonical conversation 可以先后出现多个 openai/session metadata。
      // 旧 binding 只说明“这些 metadata 仍属于这个 CID”，不能证明当前 turn 没有新 metadata。
      // 因此先更新旧 binding 的最近 turn/request，但绝不能在这里 return；
      // 下面仍要尝试从当前 body exact-match 一个尚未绑定的新 metadata。
      archive.updateDevSpaceBindingTurn({
        conversationId,
        turnExchangeId,
        requestId,
        observedAt: now,
        lifecycleState: activeTurns.has(conversationId) ? 'active' : 'closed',
      })
      for (const row of archive.getDevSpaceMetadataBindingsForConversation(conversationId)) mirrorDevSpaceBinding(row)
    }
    if (!turnExchangeId) return
    const candidate = matchDevSpaceBindingFromStoredTurn(conversationId, turnExchangeId)
    if (!candidate) return
    bindDevSpaceMetadataToConversation({
      metadataId: candidate.metadataId,
      conversationId,
      startAt: candidate.startAt,
      observedAt: now,
      turnExchangeId,
      requestId,
      evidence: 'body:exact-tool-args',
      confidence: 'high',
      lifecycleState: activeTurns.has(conversationId) ? 'active' : 'closed',
    })
    void log('DevSpace metadata exact-match binding confirmed', {
      metadataId: candidate.metadataId,
      conversationId,
      turnExchangeId,
      exactMatches: candidate.exactMatches,
      uniqueMatches: candidate.uniqueMatches,
    })
  }

  const checkUnboundDevSpaceTimeouts = () => {
    const now = Date.now()
    for (const [metadataId, candidate] of unboundDevSpaceTurns) {
      if (now - Number(candidate.startedAt) < watchdogMs) continue
      archive.markDevSpaceUnboundWatchdog(metadataId, now)
      // CID 还没解出来也不能静默：先告诉用户“Watchdog 已到点但当前无法安全定位聊天”。
      // 持久 notification key 保证这个 provisional 事件跨循环/重启只成功发送一次。
      enqueueLifeOpsUnboundWatchdog(metadataId, candidate, now)
      dispatchUnboundWatchdogNotification(metadataId, candidate, now)
      if (!candidate.repairQueuedAt) {
        candidate.repairQueuedAt = now
        void log('unbound DevSpace watchdog exceeded threshold; queued catalog repair', {
          metadataId,
          activeForMs: now - Number(candidate.startedAt),
        })
        void scheduleGapRepair('devspace-unbound-timeout')
      }
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
      archive.mergeLiveMappingSnapshot(payload, {
        observedAt: capturedAt,
        endpoint: `/backend-api/conversation/${conversationId}`,
        observationKind: 'mapping-snapshot:passive-native',
      })
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
      archive.mergeLiveMessagesPage(normalized, {
        observedAt: capturedAt,
        endpoint: `/backend-api/conversations/${conversationId}`,
        pageCursor: null,
        observationKind: 'body-page:passive-native',
        updateCurrentState: true,
        classifyTerminal: false,
        allowIncompleteTailIncident: false,
        incidentKind: 'abnormal-terminal',
      })

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
          SELECT update_time AS updateTime, terminal_state AS terminalState
          FROM conversations WHERE id = ?
        `).get(id)
        if (shouldStartCatalogWatchdog({
          alreadyActive: checkpointWatches.has(id),
          catalogUpdateTime: item.update_time ?? null,
          archivedUpdateTime: archived?.updateTime ?? null,
          archivedTerminalState: archived?.terminalState ?? null,
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
    const protocolRequestSignatures = new Map()
    const pendingProtocolResponses = new Map()

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
      const tracker = new LiveTurnTransportTracker({
        cdpRequestId,
        transport: 'turn-wss',
        requestStartedAt: Date.now(),
        emit: appendLiveTransport,
      })
      const liveKey = `${target.id}:${cdpRequestId}`
      activeLiveTransports.set(liveKey, {
        targetId: target.id,
        cdpRequestId,
        transport: 'turn-wss',
        startedAt: Date.now(),
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
      const entry = { tracker, liveKey, requestId, topic, finished: false }
      turnWssTrackers.set(trackerKey, entry)
      return entry
    }

    const finishTurnWssTracker = (entry, failedReason = null) => {
      if (!entry || entry.finished) return
      entry.finished = true
      if (failedReason) entry.tracker.fail(failedReason, Date.now())
      else entry.tracker.finish(Date.now())
      activeLiveTransports.delete(entry.liveKey)
      turnWssTrackers.delete(`${entry.requestId}:${entry.topic}`)
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
        entry.tracker.ingestText(item.encodedItem, Date.now())
        const state = activeLiveTransports.get(entry.liveKey)
        if (state) {
          state.lastDataAt = Date.now()
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
      const tracker = new LiveTurnTransportTracker({
        cdpRequestId: String(requestId),
        transport,
        requestStartedAt: Date.now(),
        emit: appendLiveTransport,
      })
      const liveKey = `${target.id}:${requestId}`
      activeLiveTransports.set(liveKey, {
        targetId: target.id,
        cdpRequestId: String(requestId),
        transport,
        startedAt: Date.now(),
        lastDataAt: null,
        dataEvents: 0,
        dataBytes: 0,
        conversationId: null,
        turnExchangeId: null,
        lastControlAt: null,
        lastControlEvent: null,
        bytesObserved: 0,
        pingCount: 0,
      })
      liveTransports.set(requestId, {
        tracker,
        liveKey,
        ready: false,
        pending: [],
        enablePromise: null,
      })
    }

    client.on('Network.requestWillBeSent', ({ requestId, request }) => {
      startLiveTransport(requestId, request)
      if (!String(request?.url || '').includes('/backend-api/')) return
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
              live.tracker.ingestBase64(result?.bufferedData, Date.now())
              live.ready = true
              for (const chunk of live.pending) live.tracker.ingestBase64(chunk.data, chunk.at)
              live.pending = []
            })
            .catch(async (error) => {
              liveTransports.delete(requestId)
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
      if (status === 429) {
        passive429Responses += 1
        void tripCooldown(`observed native ${route.kind} HTTP 429`, {
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
      if (!live.ready) live.pending.push(chunk)
      else live.tracker.ingestBase64(data, chunk.at)
    })

    client.on('Network.loadingFinished', ({ requestId }) => {
      const live = liveTransports.get(requestId)
      if (live) {
        const finish = () => {
          if (!liveTransports.has(requestId)) return
          live.tracker.finish(Date.now())
          liveTransports.delete(requestId)
          activeLiveTransports.delete(live.liveKey)
        }
        if (live.enablePromise) void live.enablePromise.then(finish, () => {})
        else finish()
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
       const fail = () => {
         if (!liveTransports.has(requestId)) return
         const reason = [errorText, blockedReason, canceled === true ? 'canceled' : null].filter(Boolean).join('; ')
           || 'Network.loadingFailed'
         live.tracker.fail(reason, Date.now())
         liveTransports.delete(requestId)
         activeLiveTransports.delete(live.liveKey)
       }
       if (live.enablePromise) void live.enablePromise.then(fail, fail)
       else fail()
     }
     pendingBodies.delete(requestId)
     pendingImages.delete(requestId)
      pendingProtocolResponses.delete(requestId)
      protocolRequestSignatures.delete(requestId)
   })

    passivePageObservers.set(target.id, { client, url: target.url })
    await log('passive ChatGPT page observer attached', { targetId: target.id, url: target.url })
  }

  const refreshPassivePageObservers = async (targets) => {
    // Guardian 现在也是 Phase 4 默认 Actor，因此必须和普通 ChatGPT page 一样挂被动 observer。
    // 这里的 observer 只读 Network，不会替代/重置 Guardian 自己的控制 session；
    // cooldown 的 blocked URLs 仍由 Guardian 主 session 维护。
    const eligible = targets.filter(shouldAttachPassivePageObserver)
    const liveIds = new Set(eligible.map(target => target.id))

    for (const [targetId, observer] of passivePageObservers) {
      if (!liveIds.has(targetId) || observer.client.closed) {
        observer.client.close()
        passivePageObservers.delete(targetId)
      }
    }

   for (const target of eligible) {
     if (passivePageObservers.has(target.id)) continue
      if (Date.now() < Number(passiveObserverRetryAfter.get(target.id) || 0)) continue
     try {
       await attachPassivePageObserver(target)
        passiveObserverRetryAfter.delete(target.id)
     }
     catch (error) {
        passiveObserverRetryAfter.set(target.id, Date.now() + SLEEPING_TARGET_RETRY_MS)
       await log('passive ChatGPT page observer attach failed', {
          targetId: target.id,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    prunePassiveCaches()
  }

  const setGuardianConversationRestBlocked = async (enabled) => {
    if (!guardian?.page || guardian.page.closed || guardianConversationRestBlocked === enabled) return
    await guardian.page.send('Network.setBlockedURLs', {
      urls: enabled ? [
        // 明确限定 HTTPS。不要使用 *://，这样即使未来 WSS 恰好复用相似 pathname，
        // wss://chatgpt.com/... 也绝不会被 REST cooldown 规则误伤。
        'https://chatgpt.com/backend-api/conversations*',
        'https://chatgpt.com/backend-api/conversation/*',
      ] : [],
    }, 3000)
    guardianConversationRestBlocked = enabled
    await log(enabled ? 'Guardian conversation REST blocked for cooldown' : 'Guardian conversation REST block released')
  }

  const observeConversationEvent = (event) => {
    const behavior = classifyConversationEvent(event.type, event.updateType)
    const now = Date.now()
    const activeBeforeIds = [...activeTurns.keys()]
    // 只记录生命周期元数据，不记录消息正文。并发实验需要精确知道每个
    // conversation 的 created/complete 时刻，否则 eventCounts 只能给总数，
    // 无法判断究竟是哪一条在高并发下被挤掉或漏掉。
    void log('wss conversation event', {
      conversationId: event.conversationId,
      type: event.type,
      updateType: event.updateType || null,
      topic: event.topic || null,
    })
    markDirty(event.conversationId, `wss:${event.type}`)
    if (behavior.startsTurn) {
      const current = activeTurns.get(event.conversationId)
      const explicitNewTurn = Boolean(behavior.explicitTurnStart)
      const latched = isWatchdogLatched(current)
      const nextActive = latched && explicitNewTurn
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
    }
    else if (activeTurns.has(event.conversationId)) {
      const current = activeTurns.get(event.conversationId)
      current.lastEventAt = now
      persistActiveTurn(event.conversationId, current)
    }
    if (behavior.completesTurn) {
      recentConversationComplete.set(event.conversationId, now)
      clearActiveTurn(event.conversationId)
      catalogActive.delete(event.conversationId)
      stopCheckpointWatch(event.conversationId, `wss:${event.type}`, now)
      archive.updateDevSpaceBindingTurn({
        conversationId: event.conversationId,
        observedAt: now,
        lifecycleState: 'closed',
      })
      markSyncReady(event.conversationId, `wss:${event.type}`, nativeBodyGraceMs)
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
    for (const [conversationId, active] of activeTurns) {
      if (active.watchdogPendingAt) {
        stopCheckpointWatch(conversationId, 'watchdog-pending', now)
        // daemon 重启后恢复 timed-out generation 时仍补发一次“到点”事实；持久 ledger 会去重。
        enqueueLifeOpsWatchdogTimeout(conversationId, active, now)
        dispatchWatchdogTimeoutNotification(conversationId, active, now)
        if (!ready.has(conversationId)) {
          const watchdogTrigger = watchdogTriggerForStartType(active.startType)
          markSyncReady(conversationId, watchdogTrigger, 0)
          void log('restored pending watchdog diagnostic; re-queued body sync', {
            conversationId,
            pendingAt: active.watchdogPendingAt,
            startType: active.startType,
            trigger: watchdogTrigger,
          })
        }
        continue
      }
      if (!shouldQueueWatchdogDiagnostic(active, now, watchdogMs)) continue
      // 同一个仍活跃 turn 至多每个 watchdog 窗口做一次诊断抓取；没有 complete 时不轮询。
      // Watchdog 一旦接管，checkpoint 高频追踪必须立刻终止，不能让同一 zombie 一边被判超时
      // 一边继续 7~10 秒主动 polling。
      stopCheckpointWatch(conversationId, 'watchdog-timeout', now)
      active.lastWatchdogAt = now
      active.watchdogPendingAt = now
      persistActiveTurn(conversationId, active)
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
              url: listPath(offset, limit),
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
            catalogActive.set(id, {
              firstSeenAt: current?.firstSeenAt ?? now,
              lastSeenAt: now,
              asyncStatus: item.async_status,
              updateTime: nextUpdateTime,
            })
            // 没有可靠 turn-start 时，把“第一次看到 active”作为保守 late-start 下界。
            // 真实 POST 一定发生得更早，所以 watchdog 只会更晚报警，不会提前误报。
            const archived = archive.db.prepare(`
              SELECT update_time AS updateTime, terminal_state AS terminalState
              FROM conversations WHERE id = ?
            `).get(id)
            if (shouldStartCatalogWatchdog({
              alreadyActive: checkpointWatches.has(id),
              catalogUpdateTime: item.update_time ?? null,
              archivedUpdateTime: archived?.updateTime ?? null,
              archivedTerminalState: archived?.terminalState ?? null,
            })) {
              armCheckpointWatch(id, `reconcile:${reason}:async-active`, now)
            }
            if (shouldStartCatalogWatchdog({
              alreadyActive: activeTurns.has(id),
              catalogUpdateTime: item.update_time ?? null,
              archivedUpdateTime: archived?.updateTime ?? null,
              archivedTerminalState: archived?.terminalState ?? null,
            })) {
              const nextActive = {
                startedAt: current?.firstSeenAt ?? now,
                lastEventAt: now,
                lastWatchdogAt: null,
                watchdogPendingAt: null,
                startType: `catalog:async-active:${reason}`,
                lastDiagnosticTurnKey: null,
              }
              activeTurns.set(id, nextActive)
              persistActiveTurn(id, nextActive)
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
            // running 时只登记 dirty/active，避免为了监控去抓正在生成的半成品；完成/未知则
            // 按正常 gap reconciliation 直接补 body。若上面刚处理 active→complete，这里重复
            // set 同一个 Map key 也是幂等的。
            if (asyncState !== 'active') markSyncReady(id, `reconcile:${reason}`, 0)
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
    const activeWindowAvailable = Boolean(authHeaders) && activeApiAllowed(cooldownUntil, now)
    const eligible = shouldRunDeferredGapRepair({
      now,
      pendingLastAt: pendingGapRepair.lastAt,
      lastAttemptAt: lastGapRepairAttemptAt,
      delayMs: gapRepairDelayMs,
      minIntervalMs: gapRepairMinIntervalMs,
      activeSockets: activeSocketIds.size,
      authAvailable: Boolean(authHeaders),
      cooldownUntil,
      reconcileInFlight,
      passiveCatalogAvailable: Boolean(passiveSeed),
    })

    const debounceDueAt = Number(pendingGapRepair.lastAt) + gapRepairDelayMs
    const intervalDueAt = lastGapRepairAttemptAt > 0
      ? lastGapRepairAttemptAt + gapRepairMinIntervalMs
      : 0
    const blockers = []
    if (activeSocketIds.size <= 0) blockers.push('no-active-wss')
    if (reconcileInFlight) blockers.push('reconcile-in-flight')
    if (!activeWindowAvailable && !passiveSeed) {
      if (!authHeaders) blockers.push('no-auth')
      if (!activeApiAllowed(cooldownUntil, now)) blockers.push('active-api-cooldown')
      blockers.push('no-passive-catalog-after-gap')
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
      reconcileInFlight,
      cooldownUntil: cooldownUntil || null,
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
      reconcileInFlight: gate.reconcileInFlight,
      cooldownUntil: gate.cooldownUntil,
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
      pendingGapRepair = null
      lastGapRepairGate = null
      lastGapRepairGateSignature = null
      await log('deferred gap repair complete', {
        reasons: [...repair.reasons].sort(),
      })
    }
    catch (error) {
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
      if (route?.kind === 'catalog' && !route.globalCatalog && status === 429) {
       passive429Responses += 1
       void tripCooldown('Guardian native catalog HTTP 429', {
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
    guardianConversationRestBlocked = false
    guardianReadyAt = Date.now()
    guardianHealthFailures = 0
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
    if (Date.now() < cooldownUntil) {
      await setGuardianConversationRestBlocked(true).catch(async (error) => {
        await log('Guardian REST pre-block failed during cooldown startup', {
          error: error instanceof Error ? error.message : String(error),
        })
      })
    }
    await log('guardian ready', {
      reason,
      targetId: guardian.targetId,
      windowId: guardian.windowId,
      created: guardian.created,
      nativeHidden: guardian.nativeWindow?.visibleAfter === false,
    })
    guardianEstablishedOnce = true
    // listener 必须先于导航/reload 安装，才能捕获第一条真实 backend header 与 WSS 创建。
    if (guardian.created) {
      await guardian.page.send('Page.navigate', { url: `https://chatgpt.com/?${GUARDIAN_MARKER}=1` })
    }
    else {
      // 如果复用了旧 guardian，它不会因为 attach 自动产生网络请求；轻量 reload 一次只发生在
      // daemon 自己的专用页，用于重新挂全 WSS 生命周期并获得页面真实 request context。
      await guardian.page.send('Page.reload', { ignoreCache: false })
    }

    const waitStarted = Date.now()
    while (!authHeaders && Date.now() - waitStarted < 20_000 && !guardian.page.closed) {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    if (Date.now() < cooldownUntil) await setGuardianConversationRestBlocked(true).catch(() => {})
    // “daemon 已经 ready”和“首次补洞完成”是两个不同状态。先写 ready state，
    // 避免 CLI 因一次 5 页 startup reconcile 超过启动等待时间而误报 started:false。
    await writeState()
    if (authHeaders && activeApiAllowed(cooldownUntil) && reconcileOnStart && lastReconcileAt === 0) {
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
        submitTurn: async (input) => await sendActorPrompt({
          cdpHttp,
          statePath: actorStatePath,
          daemonStatePath: statePath,
          domLedgerPath,
          tracePath: turnTracePath,
          prompt: input.text,
          conversationId: input.conversationId,
          mode: input.mode,
          targetMode: input.targetMode,
          onDomDrift: notifyActorDomDrift,
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
  let devSpaceHistoricalSeeded = 0
  const devSpaceMetadataHistory = devSpaceAuditBridge.metadataSummaries(10_000)
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
  const devSpaceBackfilledBindings = devSpaceHistoricalSeeded > 0
    ? backfillStoredDevSpaceBindings()
    : 0
  if (devSpaceBackfilledBindings > 0) {
    await log('DevSpace exact-match binding backfill complete', {
      created: devSpaceBackfilledBindings,
    })
  }

  // parser / binding 策略升级后，旧 metadata 可能“以前匹配不了、现在能匹配”。
  // 每次启动只对近期 unbound 做一个窄窗口重验，避免为了几个活跃候选重扫数周历史。
  const recentBackfillSinceAt = Date.now() - Math.max(watchdogMs * 2, 2 * 60 * 60_000)
  const recentDevSpaceBackfilledBindings = backfillStoredDevSpaceBindings({
    sinceAt: recentBackfillSinceAt,
  })
  if (recentDevSpaceBackfilledBindings > 0) {
    await log('DevSpace recent exact-match binding backfill complete', {
      created: recentDevSpaceBackfilledBindings,
      sinceAt: recentBackfillSinceAt,
    })
  }

  // 启动时先做一次 durable catch-up；之后以 DevSpace UDP 门铃为主，
  // 每 60 秒才做一次极低频兜底扫描，防止 daemon 重启窗口/UDP 丢包留下最后一条 audit。
  pollDevSpaceAudits()
  // 重启恢复只看最近 6 分钟本地工具活动；候选的 lastCheckedIdleMs 从当前 idle 年龄
  // 起步，因此不会补发已经错过的历史 1/3 分钟，但仍可继续命中后续 3/5 分钟。
  for (const state of devSpaceAuditBridge.recentMetadataToolStates(
    Date.now() - DEVSPACE_IDLE_STARTUP_LOOKBACK_MS,
  )) {
    refreshDevSpaceIdleCandidate(state.metadataId)
  }
  devSpaceLastFallbackPollAt = Date.now()
  const devSpaceWakeListening = await devSpaceAuditWakeListener.start((signal) => {
    pollDevSpaceAudits()
    // finish 与 start 使用同一 auditId；即使增量 poll 因 seen-id 去重不再进入 handler，
    // 也必须按 signal.metadataId 重读当前 SQLite 状态，才能即时开始 idle 计时。
    refreshDevSpaceIdleCandidate(signal.metadataId)
  })
  await log('DevSpace audit wake listener ready', {
    listening: devSpaceWakeListening,
    ...devSpaceAuditWakeListener.stats(),
    fallbackPollMs: DEVSPACE_FALLBACK_POLL_MS,
  })

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
      await refreshPassivePageObservers(targets)
      // 稳态由 DevSpace 事件立即唤醒；这里只保留一分钟一次的 durable catch-up，
      // 它不是实时发现路径，成本也从“每 5 秒一次”降到“每 60 秒一次”。
      if (Date.now() - devSpaceLastFallbackPollAt >= DEVSPACE_FALLBACK_POLL_MS) {
        pollDevSpaceAudits()
        // 若 finish UDP 丢失，started_at 游标本身不会再次看到旧 audit；这里对极少数
        // 已追踪 metadata 做一次本机状态重读，作为 durable finish catch-up。
        refreshTrackedDevSpaceIdleCandidates()
        devSpaceLastFallbackPollAt = Date.now()
      }
      checkDevSpaceIdleNotifications()
      checkUnboundDevSpaceTimeouts()

      // 只做健康观测，不主动激活窗口。短暂的 renderer/CDP 抖动先累计失败次数；
      // 不再“一次 3 秒 timeout 就拆 Guardian”。成功一次立即清零。
      let runtime = null
      try {
        runtime = await guardian.page.send('Runtime.evaluate', {
          expression: `({ visibility: document.visibilityState, discarded: document.wasDiscarded === true, ready: document.readyState })`,
          returnByValue: true,
        }, 3000)
        guardianHealthFailures = 0
      }
      catch (error) {
        guardianHealthFailures += 1
        await log('guardian health probe failed', {
          consecutiveFailures: guardianHealthFailures,
          threshold: guardianHealthFailureThreshold,
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

      if (reconcileHours > 0
        && authHeaders
        && activeApiAllowed(cooldownUntil)
        && Date.now() - lastReconcileAt >= reconcileHours * 3600_000) {
        await reconcileCatalog('periodic').catch(async (error) => {
          await log('periodic reconciliation failed; passive Guardian remains online', {
            error: error instanceof Error ? error.message : String(error),
          })
        })
      }
      // cooldown 到期只解除“主动 API 禁止”，不再拿完整 catalog 扫描当探针。
      // 先保持 WSS 在线；已知 ready conversation 由 drainDirty 逐条补 body。
      if (cooldownRecoveryPending && activeApiAllowed(cooldownUntil)) {
        cooldownRecoveryPending = false
        cooldownUntil = 0
        await setGuardianConversationRestBlocked(false).catch(() => {})
        recoveryProbeRemaining = recoveryProbeSuccesses
        lastReconcileAt = Date.now()
        if (pendingGapRepair) pendingGapRepair.lastAt = Date.now()
        await log('active API cooldown expired; passive-first recovery resumed', {
          recoveryProbeRemaining,
          recoveryProbeGapMs,
        })
      }
     queueWatchdogDiagnostics()
     await drainDirty()
     await drainCheckpointWatches()
     await maybeRunGapRepair()
     await hydratePendingGeneratedImageAssets()
      if (protocolLedger?.refreshBaselineLock()) scheduleProtocolLedgerFlush()
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
 for (const observer of passivePageObservers.values()) observer.client.close()
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
  guardian?.page?.close()
  guardian?.browser?.close()
  await writeState()
  devSpaceAuditWakeListener.close()
  devSpaceAuditBridge.close()
  archive.close()
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exitCode = 1
  })
}

