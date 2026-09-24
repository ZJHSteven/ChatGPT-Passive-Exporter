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
  return reason === 'wss-reconnect' ? safePageSize : safeDeepThreshold
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
    if (!url.pathname.includes('/backend-api/estuary/content')) return null
    const id = url.searchParams.get('id')
    return id && /^file_[A-Za-z0-9_-]+$/u.test(id) ? id : null
  }
  catch {
    return null
  }
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
      if ((topic === 'conversations' || inheritedTopic === 'conversations') && isConversationEvent) {
        const conversationId = findStringField(candidate, ['conversation_id', 'conversationId'])
        const updateType = findStringField(candidate, ['update_type', 'updateType'])
        if (!conversationId) continue
        const key = `${conversationId}:${type}:${updateType || ''}`
        if (!seen.has(key)) {
          seen.add(key)
          events.push({ conversationId, type, updateType })
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

  // Auto Tab Discard 等扩展可能留下“URL 仍像 Guardian、renderer 已经不响应”的半死 target。
  // 先做一次极短的 Runtime 探活；失败就从 browser-level 关闭 target，再创建全新 Guardian。
  if (target) {
    let probe = null
    try {
      probe = new CdpClient(target.webSocketDebuggerUrl)
      await probe.connect()
      await probe.send('Runtime.enable', {}, 3000)
      await probe.send('Runtime.evaluate', {
        expression: 'document.readyState',
        returnByValue: true,
      }, 3000)
    }
    catch {
      await browser.send('Target.closeTarget', { targetId: target.id }).catch(() => {})
      target = null
    }
    finally {
      probe?.close()
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

  const page = new CdpClient(target.webSocketDebuggerUrl)
  await page.connect()
  await page.send('Network.enable')
  await page.send('Page.enable')
  await page.send('Runtime.enable')
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
  const watchdogMinutes = Number(flags.get('watchdog-minutes') ?? 35)
  if (!Number.isFinite(watchdogMinutes) || watchdogMinutes <= 0) throw new Error('--watchdog-minutes must be > 0')
  const watchdogMs = watchdogMinutes * 60_000

  await fs.mkdir(path.dirname(statePath), { recursive: true })
  const archive = new ChatArchiveDb(dbPath)
  let guardian = null
  // `guardian === null` 同时出现在“进程第一次启动”和“运行中自愈 catch 已清空旧 Guardian”两种
  // 场景；不能再仅凭 null 决定 reason。否则运行中 WSS/renderer 故障会被误标成 startup，
  // 从而跳过 guardian-recover reconciliation，留下一个真正的事件盲区。
  let guardianEstablishedOnce = false
  let authHeaders = null
  let lastAuthAt = null
  let cooldownUntil = 0
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
  let activeSocketIds = new Set()
  let stopping = false
  // dirty = “本地可能落后”；ready = “现在允许主动抓 body”。二者必须分开。
  const dirty = new Map()
  const ready = new Map()
  // catalogActive 只表示“低频 conversation list 曾看见 async_status=3/5”。
  // 它不是可靠 turn start，因此绝不能进入 watchdog 的 activeTurns.startedAt。
  // 这个集合只用于 catalog 自己识别 active→complete 的 gap repair。
  const catalogActive = new Map()
  const activeTurns = new Map()
  const turnRecorder = new ActiveTurnRecorder(turnTracePath)
  const eventCounts = new Map()
  let syncInFlight = false
  let reconcileInFlight = false
  let syncedConversations = 0
  let syncErrors = 0
  let lastError = null
  let lastActiveRequestAt = 0
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
      oldestActiveMs: activeTurns.size > 0
        ? Math.max(...[...activeTurns.values()].map(item => Date.now() - item.startedAt))
        : 0,
      syncInFlight,
      reconcileInFlight,
    },
    sync: { syncedConversations, syncErrors, lastReconcileAt },
    limits: {
      maxSyncConversations,
      bodyRequestGapMs: syncDelayMs,
      catalogRequestGapMs: reconcileDelayMs,
      requestJitterMs,
    },
    cooldownUntil: cooldownUntil || null,
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

  const tripCooldown = async (reason) => {
    cooldownUntil = Date.now() + cooldownMinutes * 60_000
    await log('active API cooldown armed', { reason, cooldownUntil })
  }

  const requireRequestWindow = () => {
    if (Date.now() < cooldownUntil) throw new Error(`active API cooldown until ${new Date(cooldownUntil).toISOString()}`)
    if (!authHeaders) throw new Error('no captured first-party auth context yet')
    if (!guardian?.page || guardian.page.closed) throw new Error('guardian page unavailable')
  }

  const waitForRequestSlot = async (kind) => {
    const baseGap = kind === 'catalog' ? reconcileDelayMs : syncDelayMs
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
    return response.body
  }

  const syncConversation = async (conversationId, trigger) => {
    requireRequestWindow()
    const classifyTerminal = shouldClassifyTerminalForTrigger(trigger)
    const confirmedTerminal = isConfirmedTerminalTrigger(trigger)
    const incidentBefore = classifyTerminal ? latestOpenIncident(conversationId) : null
    let newIncident = null
    const basePath = `/backend-api/conversations/${encodeURIComponent(conversationId)}`
    const first = await fetchChecked({
      url: `${basePath}?include_has_versions=true&num_turns=10`,
      targetPath: basePath,
      targetRoute: '/backend-api/conversations/{conversation_id}',
      kind: 'body',
    })
    if (!Array.isArray(first.messages)) throw new Error(`conversation ${conversationId} latest body has no messages[]`)

    const baseMeta = {
      title: first.title,
      conversation_id: first.conversation_id || conversationId,
      current_node: first.current_node,
      create_time: first.create_time,
      update_time: first.update_time,
    }
    let pagePayload = first
    let cursor = null
    let pages = 0
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
      const knownBefore = archive.knownMessageIds(conversationId, ids)
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
        incidentKind: trigger.startsWith('watchdog:') ? 'watchdog-timeout' : 'abnormal-terminal',
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
        }
      }
      const nextCursor = pageInfo.start_cursor
      if (typeof nextCursor !== 'string' || !nextCursor) {
        throw new Error(`conversation ${conversationId} has_previous_page=true but no start_cursor`)
      }
      cursor = nextCursor
      const messagePath = `${basePath}/messages`
      pagePayload = await fetchChecked({
        url: `${messagePath}?before=${encodeURIComponent(cursor)}&include_has_versions=true&num_turns=10`,
        targetPath: messagePath,
        targetRoute: '/backend-api/conversations/{conversation_id}/messages',
        kind: 'body',
      })
      if (!Array.isArray(pagePayload.messages)) throw new Error(`conversation ${conversationId} cursor page has no messages[]`)
    }
  }

  const drainDirty = async () => {
    if (syncInFlight || reconcileInFlight || stopping || Date.now() < cooldownUntil || !authHeaders || !guardian?.page || guardian.page.closed) return
    if (maxSyncConversations > 0 && syncedConversations >= maxSyncConversations) return
    if (ready.size === 0) return
    syncInFlight = true
    try {
      // 每次调度最多只处理一个 conversation。
      //
      // 旧实现会 `while (ready.size > 0)` 一直跑完整个 backlog。只要 backlog 有几十上百条，
      // daemon 主循环就会被饿死数十分钟甚至数小时：Guardian Runtime 探活、WSS 缺失检测、
      // watchdog、state.json 刷新都不能按 5 秒节奏执行。主动 API 的节流已经由全局 request gate
      // 负责，因此这里应该采用 cooperative scheduling：处理一条就立刻把控制权还给主循环。
      const [conversationId, trigger] = ready.entries().next().value
      ready.delete(conversationId)
      try {
        const result = await syncConversation(conversationId, trigger)
        syncedConversations += 1
        // 一次 overlap 同步成功以后，本地副本已经追到本次 observation，因此才清 dirty。
        dirty.delete(conversationId)
        if (result.diagnostic.terminalEvidence !== 'none') activeTurns.delete(conversationId)
        await log('conversation synced', {
          conversationId,
          trigger,
          pages: result.pages,
          newMessages: result.newMessages,
          exactMapping: result.exactMapping,
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
    dirty.set(conversationId, trigger)
    ready.set(conversationId, trigger)
    setTimeout(() => { void drainDirty() }, delayMs)
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
      markSyncReady(event.conversationId, `wss:${event.type}`, 500)
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
      markSyncReady(conversationId, 'watchdog:active-timeout', 0)
      void log('active turn exceeded watchdog; queued diagnostic body sync', {
        conversationId,
        activeForMs: now - active.startedAt,
        lastEventAgoMs: now - active.lastEventAt,
      })
    }
  }

  const reconcileCatalog = async (reason) => {
    if (reconcileInFlight) return
    requireRequestWindow()
    reconcileInFlight = true
    let offset = 0
    const limit = 28
    let stableOverlap = 0
    let pages = 0
    let dirtyCount = 0
    const requiredStableOverlap = catalogStableOverlapTarget(reason, {
      pageSize: limit,
      deepThreshold: overlapThreshold,
    })
    try {
      while (stableOverlap < requiredStableOverlap) {
        const route = '/backend-api/conversations'
        const body = await fetchChecked({
          url: listPath(offset, limit),
          targetPath: route,
          targetRoute: route,
          kind: 'catalog',
        })
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
            })
            // running 说明该 conversation 当前仍可能继续变化：只标 stale，不抓半成品 body，
            // 更不能用“第一次扫到 running”的时间启动 watchdog。
            markDirty(id, `catalog:async-active:${reason}`)
            await turnRecorder.append(buildCatalogObservationTrace({
              at: now,
              conversationId: id,
              asyncStatus: item.async_status ?? null,
              classifiedState: 'active',
              reason,
              wasCatalogActive,
              reliableActiveAfterIds: activeTurns.keys(),
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
            await turnRecorder.append(buildCatalogObservationTrace({
              at: now,
              conversationId: id,
              asyncStatus: item.async_status ?? null,
              classifiedState: 'complete',
              reason,
              wasCatalogActive: true,
              reliableActiveAfterIds: activeTurns.keys(),
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
    })
    await writeState()
    void drainDirty()
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

        // 当前 conversations subscribe 经常返回 recovered=false，因此不能假设 gap 内事件会自动回放。
        // 等新连接完成 connect/subscribe 后做一次 overlap reconciliation，仍然不是高频 list 心跳。
        setTimeout(() => {
          if (!stopping && activeSocketIds.has(requestId) && authHeaders) {
            void reconcileCatalog('wss-reconnect').catch(error => log('reconcile after native WSS reconnect failed', { error: String(error) }))
          }
        }, 5000)
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
        observeConversationEvent(event)
      }
      void summaryPromise.then(async (summary) => {
        const controls = Array.isArray(summary.controls) ? summary.controls : []
        const isConversationMessage = controls.some(control => {
          const topic = control.topic_id ?? control.topic
          return control.type === 'message' && topic === 'conversations'
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
    guardianReadyAt = Date.now()
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
    // “daemon 已经 ready”和“首次补洞完成”是两个不同状态。先写 ready state，
    // 避免 CLI 因一次 5 页 startup reconcile 超过启动等待时间而误报 started:false。
    await writeState()
    if (authHeaders && reconcileOnStart && lastReconcileAt === 0) {
      await reconcileCatalog('startup')
    }
    else if (authHeaders && reason !== 'startup') {
      // Guardian 自愈意味着中间存在 WSS 盲区；只在恢复后做一次 overlap reconciliation。
      await reconcileCatalog('guardian-recover')
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

      // 只做健康观测，不主动激活窗口。最小化窗口应长期保持 hidden 而非 discarded。
      const runtime = await guardian.page.send('Runtime.evaluate', {
        expression: `({ visibility: document.visibilityState, discarded: document.wasDiscarded === true, ready: document.readyState })`,
        returnByValue: true,
      }, 3000)
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

      if (reconcileHours > 0 && authHeaders && Date.now() - lastReconcileAt >= reconcileHours * 3600_000) {
        await reconcileCatalog('periodic')
      }
      queueWatchdogDiagnostics()
      await drainDirty()
      // 运行态错误已经写入日志；完整健康迭代成功后清掉 state 里的 transient lastError，
      // 避免 CLI 永远显示一个几小时前已经自动恢复的问题。
      lastError = null
      await writeState()
    }
    catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      await log('daemon loop error', { error: lastError })
      guardian?.page?.close()
      guardian?.browser?.close()
      guardian = null
      await writeState()
      await new Promise(resolve => setTimeout(resolve, 3000))
    }
    await new Promise(resolve => setTimeout(resolve, 5000))
  }

  await log('daemon stopping')
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

