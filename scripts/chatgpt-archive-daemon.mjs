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
import { createHash } from 'node:crypto'
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

const DEFAULT_CDP = 'http://127.0.0.1:9222'
const GUARDIAN_MARKER = 'chatgpt-archive-guardian'
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_DB = path.join(PROJECT_ROOT, 'data', 'chatgpt-archive.sqlite')
const DEFAULT_STATE = path.join(PROJECT_ROOT, 'data', 'archive-daemon-state.json')
const DEFAULT_LOG = path.join(PROJECT_ROOT, 'data', 'archive-daemon.log')
const DEFAULT_TURN_TRACE = path.join(PROJECT_ROOT, 'data', 'active-turn-trace.jsonl')
const DEFAULT_NOTIFICATION_CONFIG = path.join(PROJECT_ROOT, 'data', 'archive-notification.local.json')
const DEFAULT_IMAGE_ASSET_DIR = path.join(PROJECT_ROOT, 'data', 'assets', 'chatgpt')
const IMAGE_ASSET_HYDRATE_INTERVAL_MS = 30_000
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
  const normalized = String(trigger || '').trim().toLowerCase()
  if (normalized.startsWith('wss:') && normalized.includes('complete')) return true
  return normalized.startsWith('reconcile:') && normalized.endsWith(':async-complete')
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

/** catalog late-start 超时与可靠 start 超时必须保留不同 lifecycle 语义。 */
export function watchdogTriggerForStartType(startType) {
  return String(startType || '').startsWith('catalog:')
    ? 'watchdog:catalog-active-timeout'
    : 'watchdog:active-timeout'
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
}) {
  if (!Number.isFinite(Number(pendingLastAt))) return false
  if (Number(activeSockets) <= 0 || !authAvailable || reconcileInFlight) return false
  if (!activeApiAllowed(cooldownUntil, now)) return false
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
 * - startup / periodic / Guardian 重建可能跨越更久，继续沿用 deepThreshold（默认 56）。
 *
 * 这里不是“看到一个熟 ID 就停”：一个偶然旧 ID 不足以证明 offset pagination 已重新进入
 * 稳定区域，完整一页才是短 gap 的安全缓冲。
 */
export function catalogStableOverlapTarget(reason, { pageSize = 28, deepThreshold = 56 } = {}) {
  const safePageSize = Math.max(1, Math.trunc(pageSize))
  const safeDeepThreshold = Math.max(safePageSize, Math.trunc(deepThreshold))
  return reason === 'wss-reconnect' || reason === 'gap-repair' ? safePageSize : safeDeepThreshold
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

export function sanitizeCapturedHeaders(headers) {
  const allowed = new Set([
    'authorization',
    'oai-client-build-number',
    'oai-client-version',
    'oai-device-id',
    'oai-language',
    'oai-session-id',
    'x-oai-is-client-observation',
  ])
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
  const expression = `(${async function fetchJson(url, targetPath, targetRoute, headers) {
    const response = await fetch(url, {
      credentials: 'include',
      headers: {
        ...headers,
        'X-OpenAI-Target-Path': targetPath,
        'X-OpenAI-Target-Route': targetRoute,
      },
    })
    return { status: response.status, text: await response.text() }
  }.toString()})(${JSON.stringify(url)}, ${JSON.stringify(targetPath)}, ${JSON.stringify(targetRoute)}, ${JSON.stringify(headers)})`
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
  return { status: value.status, body, text: String(value.text || '') }
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
      const hideSnorlax = url.searchParams.get('hide_snorlax')
      const globalCatalog = !origin
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
  const cooldownMinutes = intFlag(flags, 'cooldown-minutes', 60, 1)
  const maxSyncConversations = intFlag(flags, 'max-sync-conversations', 0, 0)
  const wssReconnectGraceMs = intFlag(flags, 'wss-reconnect-grace-ms', 20_000, 1000)
  const guardianHealthFailureThreshold = intFlag(flags, 'guardian-health-failures', 3, 1)
  const gapRepairDelayMs = intFlag(flags, 'gap-repair-delay-ms', 30_000, 1000)
  const gapRepairMinIntervalMs = intFlag(flags, 'gap-repair-min-interval-ms', 10 * 60_000, 10_000)
  const nativeBodyGraceMs = intFlag(flags, 'native-body-grace-ms', 3000, 0)
  const recoveryProbeGapMs = intFlag(flags, 'recovery-probe-gap-ms', 30_000, 1000)
  const recoveryProbeSuccesses = intFlag(flags, 'recovery-probe-successes', 3, 1)
  const watchdogMinutes = Number(flags.get('watchdog-minutes') ?? 30)
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
  let subscribedTopics = new Set()
  let conversationSubscriptionRecovered = null
  let lastSafeWssControls = []
  let guardianReadyAt = 0
  let guardianHealthFailures = 0
  let guardianRebuilds = 0
  let activeSocketIds = new Set()
  let stopping = false
  let pendingGapRepair = null
  let lastGapRepairAttemptAt = 0
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
  // catalogActive 只表示“低频 conversation list 曾看见 async_status=3/5”。
  // 它不是可靠 turn start，因此绝不能进入 watchdog 的 activeTurns.startedAt。
  // 这个集合只用于 catalog 自己识别 active→complete 的 gap repair。
  const catalogActive = new Map()
  const activeTurns = new Map()
  // activeTurns 现在承载“所有已纳入 watchdog 的 active”：既可能来自可靠 WSS/actor start，
  // 也可能来自 catalog 首次观察到 active 的保守 late-start。两者不能在取证输出里混称 reliable。
  const isCatalogLateActive = (active) => String(active?.startType || '').startsWith('catalog:')
  const reliableActiveIds = () => [...activeTurns.entries()]
    .filter(([, active]) => !isCatalogLateActive(active))
    .map(([conversationId]) => conversationId)
  const catalogLateActiveIds = () => [...activeTurns.entries()]
    .filter(([, active]) => isCatalogLateActive(active))
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
  let notificationLastAttemptAt = null
  let notificationLastSuccessAt = null
  let notificationLastError = null
  let lastImageHydrationAt = 0
  let imageHydrationSuccesses = 0
  let imageHydrationErrors = 0

  const log = async (message, extra = null) => {
    const line = `[${new Date().toISOString()}] ${message}${extra ? ` ${JSON.stringify(extra)}` : ''}\n`
    await fs.appendFile(logPath, line).catch(() => {})
    console.error(line.trim())
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
      sentFrames: wssSentFrames,
      receivedFrames: wssReceivedFrames,
      parsedEventFrames: wssParsedEventFrames,
      unparsedConversationFrames: wssUnparsedConversationFrames,
      subscribedTopics: [...subscribedTopics].sort(),
      conversationSubscriptionRecovered,
      lastControls: lastSafeWssControls,
    },
    authContext: { available: Boolean(authHeaders), capturedAt: lastAuthAt },
    queue: {
      dirty: dirty.size,
      ready: ready.size,
      catalogActive: catalogActive.size,
      active: activeTurns.size,
      reliableActive: reliableActiveIds().length,
      catalogLateActive: catalogLateActiveIds().length,
      oldestActiveMs: activeTurns.size > 0
        ? Math.max(...[...activeTurns.values()].map(item => Date.now() - item.startedAt))
        : 0,
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
      passiveCatalogFreshnessMs,
      recoveryProbeGapMs,
      recoveryProbeSuccesses,
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
      lastHydrationAt: lastImageHydrationAt || null,
      hydrateSuccesses: imageHydrationSuccesses,
      hydrateErrors: imageHydrationErrors,
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
    }
  }
  catch (error) {
    notificationLastError = error instanceof Error ? error.message : String(error)
    await log('incident notification config invalid; notifications disabled', {
      configPath: notificationConfigPath,
      error: notificationLastError,
    })
  }

  const latestOpenIncident = (conversationId) => archive.db.prepare(`
    SELECT i.id, i.incident_kind AS incidentKind, i.lifecycle_class AS lifecycleClass,
           i.reason, i.terminal_evidence AS terminalEvidence, i.tail_shape AS tailShape,
           c.title
    FROM incidents i
    JOIN conversations c ON c.id = i.conversation_id
    WHERE i.conversation_id = ? AND i.status = 'open'
    ORDER BY i.detected_at DESC
    LIMIT 1
  `).get(conversationId) || null

  const notifyIncident = async (conversationId, incident) => {
    if (!notificationConfig || !incident) return
    notificationLastAttemptAt = Date.now()
    const body = [
      incident.title || conversationId,
      incident.reason || `${incident.terminalEvidence || 'abnormal'} / ${incident.tailShape || 'unknown tail'}`,
    ].filter(Boolean).join('\n')
    const result = await sendIncidentNotification(notificationConfig, {
      title: incident.lifecycleClass === 'watchdog-timeout'
        ? 'ChatGPT 运行超时'
        : incident.lifecycleClass === 'active-zombie'
          ? 'ChatGPT 活跃僵尸异常'
        : incident.lifecycleClass === 'explicit-interrupted'
          ? 'ChatGPT 运行中断'
          : 'ChatGPT 异常结束',
      body,
      url: `https://chatgpt.com/c/${encodeURIComponent(conversationId)}`,
    })
    if (result.ok) {
      notificationLastSuccessAt = Date.now()
      notificationLastError = null
      await log('incident notification sent', {
        conversationId,
        provider: notificationConfig.provider,
        status: result.status,
      })
    }
    else if (result.attempted) {
      notificationLastError = result.error || 'notification failed'
      await log('incident notification failed', {
        conversationId,
        provider: notificationConfig.provider,
        status: result.status,
        error: notificationLastError,
      })
    }
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
    void notifyIncident(conversationId, incident).catch(async (error) => {
      notificationLastError = error instanceof Error ? error.message : String(error)
      await log('incident notification branch failed', {
        conversationId,
        provider: notificationConfig.provider,
        error: notificationLastError,
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

  /**
   * 机会式补全 ImageGen 图片本体。
   *
   * 被动边界：
   * 1. 不创建、不导航、不激活任何 conversation tab；
   * 2. 只连接用户本来已经打开的 ChatGPT conversation target；
   * 3. 只读取 DOM 中已经自然解析出的 estuary URL；
   * 4. 真正取图由**该页面自己的 fetch** 完成，浏览器自行附带登录态，daemon 不读取 Cookie；
   * 5. 找不到已解析 URL 就保持 pending，未来页面自然出现时再补。
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
    if (pendingByConversation.size === 0) return

    await fs.mkdir(DEFAULT_IMAGE_ASSET_DIR, { recursive: true })
    for (const [conversationId, assets] of pendingByConversation) {
      const target = byConversation.get(conversationId)
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
            if (comma < 0 || !dataUrl.slice(0, comma).includes(';base64')) throw new Error('page fetch returned no base64 image data')
            const bytes = Buffer.from(dataUrl.slice(comma + 1), 'base64')
            if (Number(result.size) !== bytes.length) {
              throw new Error(`renderer size mismatch blob=${result.size} decoded=${bytes.length}`)
            }
            await persistGeneratedImageAssetBytes(asset, bytes, result.contentType)
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
      }
      finally {
        page.close()
      }
    }
  }

  const tripCooldown = async (reason) => {
    const now = Date.now()
    cooldownUntil = now + cooldownMinutes * 60_000
    cooldownRecoveryPending = true
    recoveryProbeRemaining = 0
    // 429 本身就是“现在不适合做主动扫描”的强证据。把 periodic 基准推进到本次 429，
    // 防止 daemon 已运行很久时在 cooldown 一结束就因为旧 lastReconcileAt 立即深扫 catalog。
    lastReconcileAt = now
    await log('active API cooldown armed', { reason, cooldownUntil })
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

  const fetchChecked = async (request) => {
    requireRequestWindow()
    await waitForRequestSlot(request.kind === 'catalog' ? 'catalog' : 'body')
    const response = await pageFetchJson(guardian.page, { ...request, headers: authHeaders })
    if (response.status === 429) {
      await tripCooldown('HTTP 429')
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

  const syncConversation = async (conversationId, trigger) => {
    const syncReadyAt = Number(readySince.get(conversationId) || Date.now())
    const classifyTerminal = shouldClassifyTerminalForTrigger(trigger)
    const confirmedTerminal = isConfirmedTerminalTrigger(trigger)
    const incidentBefore = classifyTerminal ? latestOpenIncident(conversationId) : null
    const requestedIncidentKind = incidentKindForTrigger(trigger)
    let newIncident = null
    const basePath = `/backend-api/conversations/${encodeURIComponent(conversationId)}`
    const passiveFirst = reusablePassiveBodyPage(conversationId, null, syncReadyAt)
    const first = passiveFirst?.payload ?? await fetchChecked({
      url: `${basePath}?include_has_versions=true&num_turns=10`,
      targetPath: basePath,
      targetRoute: '/backend-api/conversations/{conversation_id}',
      kind: 'body',
    })
    if (passiveFirst) passiveBodyPagesReused += 1
    if (!Array.isArray(first.messages)) throw new Error(`conversation ${conversationId} latest body has no messages[]`)

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
        classifyTerminal: pages === 0 && classifyTerminal,
        // watchdog 的语义是“已经超时，所以这个 turn 本身就是需要调查的 incident”。
        // COMPLETE 只决定它是不是 confirmed terminal；不能拿“尚未 COMPLETE”把 watchdog 变成空操作。
        allowIncompleteTailIncident: pages === 0 && (confirmedTerminal || trigger.startsWith('watchdog:')),
        incidentKind: requestedIncidentKind,
      })
      if (pages === 0) latestDiagnostic = merged.diagnostic
      if (pages === 0 && merged.diagnostic.hasImageGenerationFinal) {
        imageGenerationEvent = archive.getImageGenerationEvent(conversationId, merged.diagnostic.turnExchangeId)
      }
      if (pages === 0 && classifyTerminal) {
        const incidentAfter = latestOpenIncident(conversationId)
        if (shouldNotifyIncidentTransition(incidentBefore, incidentAfter)) newIncident = incidentAfter
      }
      newMessages += merged.newMessageCount
      pages += 1

      const pageInfo = pagePayload.page_info || {}
      if (pageInfo.has_previous_page === false || allKnownBefore) {
        let exactMapping = false
        if (versionMarkerIds.size > 0) {
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
          diagnostic: latestDiagnostic ?? merged.diagnostic,
          newIncident,
          imageGenerationEvent,
          exactMapping,
          passivePagesUsed,
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
      })
      if (passivePageEntry) {
        passiveBodyPagesReused += 1
        passivePagesUsed += 1
      }
      if (!Array.isArray(pagePayload.messages)) throw new Error(`conversation ${conversationId} cursor page has no messages[]`)
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
        const result = await syncConversation(conversationId, trigger)
        syncedConversations += 1
        // 一次 overlap 同步成功以后，本地副本已经追到本次 observation，因此才清 dirty。
        dirty.delete(conversationId)
        readySince.delete(conversationId)
        readyNotBefore.delete(conversationId)
        if (result.diagnostic.terminalEvidence !== 'none') {
          activeTurns.delete(conversationId)
          catalogActive.delete(conversationId)
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
        // SQLite/trace 到这里已经完成；通知只从已落库事实分叉出去，不参与 syncInFlight。
        if (result.newIncident) dispatchIncidentNotification(conversationId, result.newIncident)
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
  }

  const attachPassivePageObserver = async (target) => {
    const client = new CdpClient(target.webSocketDebuggerUrl)
    await client.connect()
    await client.send('Network.enable')
    const pendingBodies = new Map()
    const pendingImages = new Map()

    client.on('Network.responseReceived', ({ requestId, response }) => {
      const requestUrl = String(response?.url || '')
      const fileId = estuaryFileIdFromUrl(requestUrl)
      const status = Number(response?.status || 0)
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
        void tripCooldown(`observed native ${route.kind} HTTP 429`).catch(() => {})
        return
      }
      if (status < 200 || status >= 300) return
      pendingBodies.set(requestId, { route, requestUrl, capturedAt: Date.now() })
    })

    client.on('Network.loadingFinished', ({ requestId }) => {
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
      if (!meta) return
      pendingBodies.delete(requestId)
      void decodeCdpJsonResponseBody(client, requestId).then(async (payload) => {
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
          kind: meta.route.kind,
          error: error instanceof Error ? error.message : String(error),
        })
      })
    })

    client.on('Network.loadingFailed', ({ requestId }) => {
      pendingBodies.delete(requestId)
      pendingImages.delete(requestId)
    })

    passivePageObservers.set(target.id, { client, url: target.url })
    await log('passive ChatGPT page observer attached', { targetId: target.id, url: target.url })
  }

  const refreshPassivePageObservers = async (targets) => {
    const eligible = targets.filter(target => target?.type === 'page'
      && target.id !== guardian?.targetId
      && typeof target.webSocketDebuggerUrl === 'string'
      && String(target.url || '').startsWith('https://chatgpt.com/'))
    const liveIds = new Set(eligible.map(target => target.id))

    for (const [targetId, observer] of passivePageObservers) {
      if (!liveIds.has(targetId) || observer.client.closed) {
        observer.client.close()
        passivePageObservers.delete(targetId)
      }
    }

    for (const target of eligible) {
      if (passivePageObservers.has(target.id)) continue
      try {
        await attachPassivePageObserver(target)
      }
      catch (error) {
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
        '*://chatgpt.com/backend-api/conversations*',
        '*://chatgpt.com/backend-api/conversation/*',
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
      activeTurns.set(event.conversationId, {
        startedAt: current?.startedAt ?? now,
        lastEventAt: now,
        lastWatchdogAt: current?.lastWatchdogAt ?? null,
        startType: current?.startType ?? (event.updateType ? `${event.type}:${event.updateType}` : event.type),
      })
    }
    else if (activeTurns.has(event.conversationId)) {
      activeTurns.get(event.conversationId).lastEventAt = now
    }
    if (behavior.completesTurn) {
      activeTurns.delete(event.conversationId)
      catalogActive.delete(event.conversationId)
      markSyncReady(event.conversationId, `wss:${event.type}`, nativeBodyGraceMs)
    }
    const activeAfterIds = [...activeTurns.keys()]
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
      if (now - active.startedAt < watchdogMs) continue
      // 同一个仍活跃 turn 至多每个 watchdog 窗口做一次诊断抓取；没有 complete 时不轮询。
      if (active.lastWatchdogAt && now - active.lastWatchdogAt < watchdogMs) continue
      active.lastWatchdogAt = now
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
            catalogActive.set(id, {
              firstSeenAt: current?.firstSeenAt ?? now,
              lastSeenAt: now,
              asyncStatus: item.async_status,
              updateTime: item.update_time ?? null,
            })
            // 没有可靠 turn-start 时，把“第一次看到 active”作为保守 late-start 下界。
            // 真实 POST 一定发生得更早，所以 watchdog 只会更晚报警，不会提前误报。
            const archived = archive.db.prepare(`
              SELECT update_time AS updateTime, terminal_state AS terminalState
              FROM conversations WHERE id = ?
            `).get(id)
            if (shouldStartCatalogWatchdog({
              alreadyActive: activeTurns.has(id),
              catalogUpdateTime: item.update_time ?? null,
              archivedUpdateTime: archived?.updateTime ?? null,
              archivedTerminalState: archived?.terminalState ?? null,
            })) {
              activeTurns.set(id, {
                startedAt: current?.firstSeenAt ?? now,
                lastEventAt: now,
                lastWatchdogAt: null,
                startType: `catalog:async-active:${reason}`,
              })
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
          else if (asyncState === 'complete' && wasCatalogActive) {
            // 低频 list 看到了 active→complete，而 WSS complete 没到：这是典型 gap repair。
            catalogActive.delete(id)
            activeTurns.delete(id)
            await turnRecorder.append(buildCatalogObservationTrace({
              at: now,
              conversationId: id,
              asyncStatus: item.async_status ?? null,
              classifiedState: 'complete',
              reason,
              wasCatalogActive: true,
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
    if (!pendingGapRepair) return
    const now = Date.now()
    if (!shouldRunDeferredGapRepair({
      now,
      pendingLastAt: pendingGapRepair.lastAt,
      lastAttemptAt: lastGapRepairAttemptAt,
      delayMs: gapRepairDelayMs,
      minIntervalMs: gapRepairMinIntervalMs,
      activeSockets: activeSocketIds.size,
      authAvailable: Boolean(authHeaders),
      cooldownUntil,
      reconcileInFlight,
    })) return

    const repair = pendingGapRepair
    lastGapRepairAttemptAt = now
    try {
      await reconcileCatalog('gap-repair')
      pendingGapRepair = null
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
    const observeWssControlFrame = async (direction, payloadData) => {
      const summary = summarizeWssFrame(payloadData)
      const now = Date.now()
      lastWssFrameAt = now
      if (direction === 'sent') wssSentFrames += 1
      else wssReceivedFrames += 1

      const controls = Array.isArray(summary.controls) ? summary.controls : []
      if (controls.length === 0) return summary

      lastWssControlAt = now
      for (const control of controls) {
        const topic = typeof control.topic_id === 'string'
          ? control.topic_id
          : typeof control.topic === 'string' ? control.topic : null
        if (control.type === 'subscribe' && topic) {
          if (direction === 'sent') subscribedTopics.add(topic)
          if (direction === 'received' && topic === 'conversations' && typeof control.recovered === 'boolean') {
            conversationSubscriptionRecovered = control.recovered
          }
        }
      }

      const safeEntry = {
        at: now,
        direction,
        bytes: summary.bytes,
        controls: controls.slice(0, 16),
      }
      lastSafeWssControls.push(safeEntry)
      if (lastSafeWssControls.length > 12) lastSafeWssControls = lastSafeWssControls.slice(-12)
      return summary
    }

    page.on('Network.requestWillBeSent', ({ request }) => {
      if (!String(request?.url || '').includes('/backend-api/')) return
      const headers = sanitizeCapturedHeaders(request.headers)
      if (typeof headers.authorization === 'string' && headers.authorization.length > 20) {
        authHeaders = headers
        lastAuthAt = Date.now()
      }
    })
    page.on('Network.responseReceived', ({ response }) => {
      const route = classifyConversationBackendUrl(response?.url)
      // Guardian 自己的 TPP/sidebar list 不属于 daemon replay；它若 429，必须让 daemon 也退避。
      // active replay 的 global list/body 429 已由 fetchChecked 处理，避免在这里重复续杯 cooldown。
      if (route?.kind === 'catalog' && !route.globalCatalog && Number(response?.status) === 429) {
        passive429Responses += 1
        void tripCooldown('Guardian native catalog HTTP 429').catch(() => {})
      }
    })
    page.on('Network.webSocketCreated', ({ requestId, url }) => {
      if (!String(url || '').startsWith('wss://') || !String(url || '').includes('chatgpt.com')) return
      const now = Date.now()
      const gapStartedAt = wssGapStartedAt
      const isNativeReconnect = Number.isFinite(gapStartedAt)
        && Number.isFinite(lastWssClosedAt)
        && Number(lastWssClosedAt) >= guardianReadyAt
      activeSocketIds.add(requestId)
      lastWssCreatedAt = now
      wssGapStartedAt = null

      if (isNativeReconnect) {
        lastWssReconnectDelayMs = now - Number(gapStartedAt)
        // 新连接必须重新完成 subscribe；清掉上一条 socket 的 ACK，避免状态页显示陈旧恢复状态。
        subscribedTopics = new Set()
        conversationSubscriptionRecovered = null
        void log('ChatGPT WSS reconnected natively', {
          delayMs: lastWssReconnectDelayMs,
          closedAt: lastWssClosedAt,
          createdAt: now,
        })

        // 当前 conversations subscribe 经常返回 recovered=false，因此仍需要 overlap repair；
        // 这里只登记 pending，真正 REST 请求由统一的 deferred gap-repair 门控决定。
        void scheduleGapRepair('wss-reconnect')
      }
    })
    page.on('Network.webSocketClosed', ({ requestId }) => {
      if (!activeSocketIds.delete(requestId)) return
      const now = Date.now()
      lastWssClosedAt = now
      // 只有最后一条 WSS 都关闭时才进入 gap；若旧连接关闭时新连接已并存，监听面并未中断。
      if (activeSocketIds.size === 0) wssGapStartedAt = now
    })
    page.on('Network.webSocketFrameSent', ({ requestId, response }) => {
      if (!activeSocketIds.has(requestId)) return
      void observeWssControlFrame('sent', response?.payloadData)
    })
    page.on('Network.webSocketFrameReceived', ({ requestId, response }) => {
      if (!activeSocketIds.has(requestId)) return
      const payloadData = response?.payloadData
      const summaryPromise = observeWssControlFrame('received', payloadData)
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
    // 新 Guardian 尚未建立第一条 WSS，首次 readiness 也统一使用同一个 gap 时钟。
    wssGapStartedAt = guardianReadyAt
    subscribedTopics = new Set()
    conversationSubscriptionRecovered = null
    lastSafeWssControls = []
    authHeaders = null
    await attachGuardianEvents()
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
    if (Date.now() < cooldownUntil && activeSocketIds.size > 0) {
      await setGuardianConversationRestBlocked(true).catch(() => {})
    }
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

  process.on('SIGINT', () => { stopping = true })
  process.on('SIGTERM', () => { stopping = true })

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
      if (cooldownRecoveryPending && authHeaders && activeApiAllowed(cooldownUntil)) {
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
      await maybeRunGapRepair()
      await hydratePendingGeneratedImageAssets()
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
  for (const observer of passivePageObservers.values()) observer.client.close()
  passivePageObservers.clear()
  guardian?.page?.close()
  guardian?.browser?.close()
  archive.close()
  await writeState()
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exitCode = 1
  })
}

