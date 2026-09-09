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
import path from 'node:path'
import process from 'node:process'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ChatArchiveDb } from '../src/local/archive-db.ts'

const DEFAULT_CDP = 'http://127.0.0.1:9222'
const GUARDIAN_MARKER = 'chatgpt-archive-guardian'
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_DB = path.join(PROJECT_ROOT, 'data', 'chatgpt-archive.sqlite')
const DEFAULT_STATE = path.join(PROJECT_ROOT, 'data', 'archive-daemon-state.json')
const DEFAULT_LOG = path.join(PROJECT_ROOT, 'data', 'archive-daemon.log')
const WINDOWS_HIDE_HELPER = path.join(PROJECT_ROOT, 'scripts', 'windows-hide-window.ps1')
const DEFAULT_CDP_TIMEOUT_MS = 10_000

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

function chatgptTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const millis = Date.parse(value)
    return Number.isFinite(millis) ? millis / 1000 : null
  }
  return null
}

function sanitizeCapturedHeaders(headers) {
  const allowed = new Set([
    'authorization',
    'oai-client-build-number',
    'oai-client-version',
    'oai-device-id',
    'oai-language',
    'oai-session-id',
    'X-OAI-IS-Client-Observation',
  ])
  return Object.fromEntries(Object.entries(headers || {}).filter(([key]) => allowed.has(key)))
}

export function extractConversationEvents(payloadData) {
  if (typeof payloadData !== 'string' || payloadData.length > 1_000_000) return []
  let parsed
  try { parsed = JSON.parse(payloadData) }
  catch { return [] }
  const events = []
  const seen = new Set()
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
      const conversationId = typeof candidate.conversation_id === 'string'
        ? candidate.conversation_id
        : typeof candidate.conversationId === 'string' ? candidate.conversationId : null
      const type = typeof candidate.type === 'string'
        ? candidate.type
        : typeof candidate.event_type === 'string' ? candidate.event_type : null
      if ((topic === 'conversations' || inheritedTopic === 'conversations') && conversationId && type) {
        const key = `${conversationId}:${type}`
        if (!seen.has(key)) {
          seen.add(key)
          events.push({ conversationId, type })
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
  const syncDelayMs = intFlag(flags, 'sync-delay-ms', 1500, 0)
  const reconcileDelayMs = intFlag(flags, 'reconcile-delay-ms', 900, 0)
  const overlapThreshold = intFlag(flags, 'overlap', 56, 1)
  const reconcileHours = Number(flags.get('reconcile-hours') ?? 6)
  const reconcileOnStart = !flags.has('no-reconcile-on-start')
  const cooldownMinutes = intFlag(flags, 'cooldown-minutes', 60, 1)
  const maxSyncConversations = intFlag(flags, 'max-sync-conversations', 0, 0)

  await fs.mkdir(path.dirname(statePath), { recursive: true })
  const archive = new ChatArchiveDb(dbPath)
  let guardian = null
  let authHeaders = null
  let lastAuthAt = null
  let cooldownUntil = 0
  let lastReconcileAt = 0
  let lastWssEventAt = null
  let lastWssCreatedAt = null
  let lastWssClosedAt = null
  let guardianReadyAt = 0
  let activeSocketIds = new Set()
  let stopping = false
  const dirty = new Map()
  const eventCounts = new Map()
  let syncInFlight = false
  let reconcileInFlight = false
  let syncedConversations = 0
  let syncErrors = 0
  let lastError = null

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
      lastEventAt: lastWssEventAt,
      eventCounts: Object.fromEntries(eventCounts),
    },
    authContext: { available: Boolean(authHeaders), capturedAt: lastAuthAt },
    queue: { dirty: dirty.size, syncInFlight, reconcileInFlight },
    sync: { syncedConversations, syncErrors, lastReconcileAt },
    limits: { maxSyncConversations },
    cooldownUntil: cooldownUntil || null,
    rssBytes: process.memoryUsage().rss,
    heapUsedBytes: process.memoryUsage().heapUsed,
    lastError,
  })

  const writeState = async () => fs.writeFile(statePath, JSON.stringify(state(), null, 2)).catch(() => {})
  const startedAt = Date.now()
  // `--no-reconcile-on-start` 的含义必须是“启动后先纯监听”。旧实现保留
  // lastReconcileAt=0，导致第一轮主循环把 periodic 当成“已经超过 6 小时”而立刻扫 list。
  if (!reconcileOnStart) lastReconcileAt = startedAt

  const tripCooldown = async (reason) => {
    cooldownUntil = Date.now() + cooldownMinutes * 60_000
    await log('active API cooldown armed', { reason, cooldownUntil })
  }

  const requireRequestWindow = () => {
    if (Date.now() < cooldownUntil) throw new Error(`active API cooldown until ${new Date(cooldownUntil).toISOString()}`)
    if (!authHeaders) throw new Error('no captured first-party auth context yet')
    if (!guardian?.page || guardian.page.closed) throw new Error('guardian page unavailable')
  }

  const fetchChecked = async (request) => {
    requireRequestWindow()
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
    const basePath = `/backend-api/conversations/${encodeURIComponent(conversationId)}`
    const first = await fetchChecked({
      url: `${basePath}?include_has_versions=true&num_turns=10`,
      targetPath: basePath,
      targetRoute: '/backend-api/conversations/{conversation_id}',
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
    while (true) {
      const normalized = { ...baseMeta, ...pagePayload, conversation_id: conversationId }
      const ids = (normalized.messages || []).map(message => message?.id).filter(id => typeof id === 'string')
      const knownBefore = archive.knownMessageIds(conversationId, ids)
      const allKnownBefore = ids.length > 0 && ids.every(id => knownBefore.has(id))
      const merged = archive.mergeLiveMessagesPage(normalized, {
        observedAt: Date.now(),
        endpoint: pages === 0 ? basePath : `${basePath}/messages`,
        pageCursor: cursor,
        observationKind: `body-page:${trigger}`,
        classifyTerminal: pages === 0 && /complete/iu.test(trigger),
      })
      newMessages += merged.newMessageCount
      pages += 1

      const pageInfo = pagePayload.page_info || {}
      if (pageInfo.has_previous_page === false || allKnownBefore) {
        return { conversationId, pages, newMessages, diagnostic: merged.diagnostic }
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
      })
      if (!Array.isArray(pagePayload.messages)) throw new Error(`conversation ${conversationId} cursor page has no messages[]`)
      if (syncDelayMs > 0) await new Promise(resolve => setTimeout(resolve, syncDelayMs))
    }
  }

  const drainDirty = async () => {
    if (syncInFlight || reconcileInFlight || stopping || Date.now() < cooldownUntil || !authHeaders || !guardian?.page || guardian.page.closed) return
    if (maxSyncConversations > 0 && syncedConversations >= maxSyncConversations) return
    syncInFlight = true
    try {
      while (dirty.size > 0 && !stopping && Date.now() >= cooldownUntil && authHeaders) {
        if (maxSyncConversations > 0 && syncedConversations >= maxSyncConversations) break
        const [conversationId, trigger] = dirty.entries().next().value
        dirty.delete(conversationId)
        try {
          const result = await syncConversation(conversationId, trigger)
          syncedConversations += 1
          await log('conversation synced', {
            conversationId,
            trigger,
            pages: result.pages,
            newMessages: result.newMessages,
            terminal: result.diagnostic.terminalEvidence,
            tail: result.diagnostic.tailShape,
          })
        }
        catch (error) {
          syncErrors += 1
          lastError = error instanceof Error ? error.message : String(error)
          await log('conversation sync failed', { conversationId, trigger, error: lastError })
          if (!authHeaders || Date.now() < cooldownUntil) break
        }
        if (syncDelayMs > 0) await new Promise(resolve => setTimeout(resolve, syncDelayMs))
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
    setTimeout(() => { void drainDirty() }, /complete/iu.test(trigger) ? 500 : 2500)
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
    try {
      while (stableOverlap < overlapThreshold) {
        const route = '/backend-api/conversations'
        const body = await fetchChecked({ url: listPath(offset, limit), targetPath: route, targetRoute: route })
        const items = Array.isArray(body.items) ? body.items : []
        if (items.length === 0) break
        for (const item of items) {
          const id = typeof item.id === 'string' ? item.id : typeof item.conversation_id === 'string' ? item.conversation_id : null
          if (!id) continue
          const local = archive.db.prepare('SELECT title, update_time AS updateTime FROM conversations WHERE id=?').get(id)
          const serverUpdate = chatgptTime(item.update_time)
          const localUpdate = local?.updateTime ?? null
          const changed = !local
            || (serverUpdate !== null && (localUpdate === null || serverUpdate > Number(localUpdate) + 0.000001))
            || String(item.title || '') !== String(local?.title || '')
          if (changed) {
            stableOverlap = 0
            dirtyCount += 1
            markDirty(id, `reconcile:${reason}`)
          }
          else stableOverlap += 1
        }
        pages += 1
        offset += items.length
        if (items.length < limit) break
        if (reconcileDelayMs > 0) await new Promise(resolve => setTimeout(resolve, reconcileDelayMs))
      }
    }
    finally {
      reconcileInFlight = false
    }
    lastReconcileAt = Date.now()
    await log('catalog reconciliation complete', { reason, pages, dirtyCount, stableOverlap })
    await writeState()
    void drainDirty()
  }

  const attachGuardianEvents = async () => {
    const page = guardian.page
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
      activeSocketIds.add(requestId)
      lastWssCreatedAt = Date.now()
    })
    page.on('Network.webSocketClosed', ({ requestId }) => {
      if (!activeSocketIds.delete(requestId)) return
      lastWssClosedAt = Date.now()
      // fresh reconnect 不保证 gap replay；等新 socket/auth 恢复后做一次 reconciliation。
      setTimeout(() => {
        if (!stopping && activeSocketIds.size > 0 && authHeaders) void reconcileCatalog('wss-reconnect').catch(error => log('reconcile after WSS close failed', { error: String(error) }))
      }, 5000)
    })
    page.on('Network.webSocketFrameReceived', ({ requestId, response }) => {
      if (!activeSocketIds.has(requestId)) return
      const events = extractConversationEvents(response?.payloadData)
      for (const event of events) {
        lastWssEventAt = Date.now()
        eventCounts.set(event.type, (eventCounts.get(event.type) || 0) + 1)
        markDirty(event.conversationId, `wss:${event.type}`)
      }
    })
  }

  const establishGuardian = async (reason) => {
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
    activeSocketIds = new Set()
    authHeaders = null
    await attachGuardianEvents()
    await log('guardian ready', {
      reason,
      targetId: guardian.targetId,
      windowId: guardian.windowId,
      created: guardian.created,
      nativeHidden: guardian.nativeWindow?.visibleAfter === false,
    })
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
      if (!guardian || guardian.page.closed) await establishGuardian(guardian ? 'recover-page' : 'startup')

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

      // 正常 ChatGPT 首页加载后会维持一个 conversations WSS。若页面已经 ready/auth 可用、
      // 但 20 秒后仍没有 socket，视作监听面失效并重建 Guardian，而不是无期限静默。
      if (authHeaders && Date.now() - guardianReadyAt > 20_000 && activeSocketIds.size === 0) {
        throw new Error('guardian has no active ChatGPT WSS after readiness grace period')
      }

      if (reconcileHours > 0 && authHeaders && Date.now() - lastReconcileAt >= reconcileHours * 3600_000) {
        await reconcileCatalog('periodic')
      }
      await drainDirty()
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

