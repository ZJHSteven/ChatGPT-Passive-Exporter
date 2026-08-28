import { diagnoseLatestRun, type RunDiagnostic } from '../core/run-diagnostics'
import type { RawConversationPayload } from '../core/types'

/**
 * ChatGPT 长 Agent turn 的轻量运行监控器。
 *
 * 目标不是“接管 ChatGPT”，而是给我们留下足够的事后证据：
 * - 当前 conversation / route；
 * - 页面是否切前后台、离线、pagehide；
 * - conversation 相关 fetch 是否 resolve/reject；
 * - Apps SDK / sandbox iframe 是否持续累积；
 * - Chrome JS heap 和 Long Task 是否明显恶化；
 * - 再次拿到 conversation payload 后，最后一轮是正常 final、client_stopped，
 *   还是停在 tool call 没有 tool result。
 *
 * 安全边界：
 * - 永远不记录请求正文、tool payload、Authorization/cookie 的值；
 * - 为了可选的 stream_status 单次检查，Authorization 只允许存在闭包内存中；
 * - snapshot / localStorage / window 调试接口里绝不暴露认证头。
 */

export type WatchSeverity = 'ok' | 'warning' | 'danger' | 'critical'

export interface RunWatchEvent {
  at: number
  type: string
  conversationId?: string
  data?: Record<string, unknown>
}

export interface IframeStats {
  total: number
  sandboxed: number
  oaiSandbox: number
  connectedTracked: number
  addedTotal: number
  removedTotal: number
  topFingerprints: Array<{ fingerprint: string, count: number }>
}

export interface PerformanceStats {
  usedJsHeapMb?: number
  totalJsHeapMb?: number
  jsHeapLimitMb?: number
  longTaskCount: number
  longTaskDurationMs: number
}

export interface ServerStatusResult {
  ok: boolean
  status?: string
  httpStatus?: number
  reason?: string
  checkedAt: number
}

export interface RunWatchSnapshot {
  protocol: 'chatgpt-passive-exporter/run-watch/v1'
  sessionId: string
  startedAt: number
  href: string
  conversationId?: string
  visibility: DocumentVisibilityState
  iframe: IframeStats
  performance: PerformanceStats
  latestDiagnostic?: RunDiagnostic
  lastServerStatus?: ServerStatusResult
  severity: WatchSeverity
  events: RunWatchEvent[]
}

export interface RunWatchController {
  noteConversationPayload: (payload: RawConversationPayload) => void
  checkServerStatus: () => Promise<ServerStatusResult>
  snapshot: () => RunWatchSnapshot
  summaryText: () => string
  dispose: () => void
}

export interface RunWatchOptions {
  sampleIntervalMs?: number
  persistIntervalMs?: number
  maxEvents?: number
  onUpdate?: (snapshot: RunWatchSnapshot) => void
}

interface ChromePerformanceMemory {
  usedJSHeapSize?: number
  totalJSHeapSize?: number
  jsHeapSizeLimit?: number
}

interface PerformanceWithMemory extends Performance {
  memory?: ChromePerformanceMemory
}

const STORAGE_KEY = 'chatgpt-passive-exporter/run-watch/latest/v1'
const AUTH_HEADER_ALLOWLIST = [
  'authorization',
  'oai-session-id',
  'oai-device-id',
  'oai-client-version',
  'oai-client-build-number',
  'oai-language',
  'x-oai-is-client-observation',
] as const

function now(): number {
  return Date.now()
}

function currentConversationId(): string | undefined {
  return location.pathname.match(/^\/c\/([^/?#]+)/u)?.[1]
}

function sanitizeUrl(input: string): string {
  try {
    const url = new URL(input, location.href)
    return `${url.origin}${url.pathname}`
  }
  catch {
    return input.slice(0, 200)
  }
}

function interestingNetworkPath(input: string): boolean {
  try {
    const url = new URL(input, location.href)
    if (url.origin !== location.origin) return false
    return /^\/backend-api\/(?:f\/conversation|conversations?(?:\/|$)|aip\/|ecosystem\/|connectors?\/|mcp\/)/u.test(url.pathname)
  }
  catch {
    return false
  }
}

function headersFromRequest(input: RequestInfo | URL, init?: RequestInit): Headers {
  try {
    if (init?.headers) return new Headers(init.headers)
    if (input instanceof Request) return new Headers(input.headers)
  }
  catch {
    // 某些宿主自定义 Request/Headers 代理可能抛错；监控器必须静默降级。
  }
  return new Headers()
}

function iframeFingerprint(frame: HTMLIFrameElement): string {
  let src = frame.getAttribute('src') ?? ''
  try {
    if (src) {
      const url = new URL(src, location.href)
      src = `${url.origin}${url.pathname}`
    }
  }
  catch {
    src = src.slice(0, 180)
  }

  const sandbox = frame.getAttribute('sandbox') ?? ''
  const title = (frame.getAttribute('title') ?? '').slice(0, 80)
  return `${src || '<no-src>'}|sandbox=${sandbox}|title=${title}`
}

function looksLikeOaiSandbox(frame: HTMLIFrameElement): boolean {
  const src = frame.getAttribute('src') ?? ''
  return /(?:^|\.)oaiusercontent\.com(?:\/|$)/iu.test(src)
    || /\/backend-api\/sentinel\/frame\.html/iu.test(src)
    || /web-sandbox/iu.test(src)
}

function mb(bytes: number | undefined): number | undefined {
  return typeof bytes === 'number' && Number.isFinite(bytes)
    ? Math.round(bytes / 1024 / 1024 * 10) / 10
    : undefined
}

function severityFor(iframe: IframeStats, perf: PerformanceStats, diagnostic?: RunDiagnostic): WatchSeverity {
  if (diagnostic?.outcome === 'client-stopped' || diagnostic?.outcome === 'interrupted') return 'critical'
  if (diagnostic?.outcome === 'tool-result-missing') return 'danger'
  if (iframe.total >= 200 || iframe.oaiSandbox >= 200) return 'critical'
  if (iframe.total >= 100 || iframe.oaiSandbox >= 100 || (perf.usedJsHeapMb ?? 0) >= 3000) return 'danger'
  if (iframe.total >= 50 || iframe.oaiSandbox >= 50 || (perf.usedJsHeapMb ?? 0) >= 1500) return 'warning'
  return 'ok'
}

/**
 * 安装 Run Watch。
 *
 * 实现上刻意避免 MutationObserver(subtree=true) 监视整棵超大聊天 DOM，因为那会在本来就
 * 卡顿的长聊天里制造额外负担。iframe 只每 10 秒左右做一次 O(number of iframes) 扫描；
 * 对 200~500 个 iframe 仍然远轻于遍历几十万 DOM node。
 */
export function installRunWatch(options: RunWatchOptions = {}): RunWatchController {
  const sampleIntervalMs = Math.max(5_000, options.sampleIntervalMs ?? 10_000)
  const persistIntervalMs = Math.max(10_000, options.persistIntervalMs ?? 20_000)
  const maxEvents = Math.max(100, options.maxEvents ?? 600)
  const sessionId = crypto.randomUUID?.() ?? `${now()}-${Math.random().toString(16).slice(2)}`
  const startedAt = now()
  const events: RunWatchEvent[] = []
  const iframeIds = new WeakMap<HTMLIFrameElement, number>()
  let nextIframeId = 1
  let previousIframeIds = new Set<number>()
  let addedTotal = 0
  let removedTotal = 0
  let longTaskCount = 0
  let longTaskDurationMs = 0
  let latestDiagnostic: RunDiagnostic | undefined
  let lastServerStatus: ServerStatusResult | undefined
  let lastHref = location.href
  let lastPersistAt = 0
  let disposed = false

  // 只驻留内存的临时认证上下文。绝不进入 event / snapshot / localStorage。
  const ephemeralHeaders = new Map<string, string>()

  const pushEvent = (type: string, data?: Record<string, unknown>) => {
    events.push({ at: now(), type, conversationId: currentConversationId(), data })
    if (events.length > maxEvents) events.splice(0, events.length - maxEvents)
  }

  const originalFetch = window.fetch
  window.fetch = function runWatchFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = input instanceof Request ? input.url : String(input)
    const requestHeaders = headersFromRequest(input, init)

    // 只从 ChatGPT 自己已经准备发出的请求里读取少量认证字段，并且只保存在闭包内存。
    // snapshot()/console/localStorage 永远无法访问这些值。
    if (interestingNetworkPath(url)) {
      for (const name of AUTH_HEADER_ALLOWLIST) {
        const value = requestHeaders.get(name)
        if (value) ephemeralHeaders.set(name, value)
      }
    }

    const shouldLog = interestingNetworkPath(url)
    const started = performance.now()
    if (shouldLog) {
      pushEvent('fetch-start', {
        method: init?.method ?? (input instanceof Request ? input.method : 'GET'),
        url: sanitizeUrl(url),
      })
    }

    let promise: Promise<Response>
    try {
      promise = originalFetch.call(this, input, init)
    }
    catch (error) {
      if (shouldLog) pushEvent('fetch-throw', { url: sanitizeUrl(url), error: String(error).slice(0, 200) })
      throw error
    }

    if (shouldLog) {
      void promise.then(
        response => pushEvent('fetch-response', {
          url: sanitizeUrl(url),
          status: response.status,
          elapsedMs: Math.round(performance.now() - started),
        }),
        error => pushEvent('fetch-reject', {
          url: sanitizeUrl(url),
          elapsedMs: Math.round(performance.now() - started),
          name: error instanceof DOMException ? error.name : undefined,
          error: String(error).slice(0, 200),
        }),
      )
    }

    return promise
  }

  const scanIframes = (): IframeStats => {
    const frames = [...document.querySelectorAll<HTMLIFrameElement>('iframe')]
    const currentIds = new Set<number>()
    const counts = new Map<string, number>()
    let sandboxed = 0
    let oaiSandbox = 0

    for (const frame of frames) {
      let id = iframeIds.get(frame)
      if (!id) {
        id = nextIframeId++
        iframeIds.set(frame, id)
        addedTotal += 1
        pushEvent('iframe-added', {
          iframeId: id,
          fingerprint: iframeFingerprint(frame),
          oaiSandbox: looksLikeOaiSandbox(frame),
        })
      }
      currentIds.add(id)

      if (frame.hasAttribute('sandbox')) sandboxed += 1
      if (looksLikeOaiSandbox(frame)) oaiSandbox += 1
      const fingerprint = iframeFingerprint(frame)
      counts.set(fingerprint, (counts.get(fingerprint) ?? 0) + 1)
    }

    for (const oldId of previousIframeIds) {
      if (!currentIds.has(oldId)) {
        removedTotal += 1
        pushEvent('iframe-removed', { iframeId: oldId })
      }
    }
    previousIframeIds = currentIds

    const topFingerprints = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([fingerprint, count]) => ({ fingerprint, count }))

    return {
      total: frames.length,
      sandboxed,
      oaiSandbox,
      connectedTracked: currentIds.size,
      addedTotal,
      removedTotal,
      topFingerprints,
    }
  }

  let currentIframeStats = scanIframes()

  const performanceStats = (): PerformanceStats => {
    const memory = (performance as PerformanceWithMemory).memory
    return {
      usedJsHeapMb: mb(memory?.usedJSHeapSize),
      totalJsHeapMb: mb(memory?.totalJSHeapSize),
      jsHeapLimitMb: mb(memory?.jsHeapSizeLimit),
      longTaskCount,
      longTaskDurationMs: Math.round(longTaskDurationMs),
    }
  }

  const buildSnapshot = (): RunWatchSnapshot => {
    const perf = performanceStats()
    return {
      protocol: 'chatgpt-passive-exporter/run-watch/v1',
      sessionId,
      startedAt,
      href: location.href,
      conversationId: currentConversationId(),
      visibility: document.visibilityState,
      iframe: currentIframeStats,
      performance: perf,
      latestDiagnostic,
      lastServerStatus,
      severity: severityFor(currentIframeStats, perf, latestDiagnostic),
      events: [...events],
    }
  }

  const persist = () => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(buildSnapshot()))
      lastPersistAt = now()
    }
    catch {
      // localStorage 可能被浏览器策略/容量限制；监控继续留在内存即可。
    }
  }

  const notifyUpdate = () => {
    options.onUpdate?.(buildSnapshot())
  }

  const sample = () => {
    if (disposed) return

    if (location.href !== lastHref) {
      pushEvent('route-change', { from: sanitizeUrl(lastHref), to: sanitizeUrl(location.href) })
      lastHref = location.href
    }

    currentIframeStats = scanIframes()
    const perf = performanceStats()
    pushEvent('sample', {
      iframeTotal: currentIframeStats.total,
      iframeSandboxed: currentIframeStats.sandboxed,
      iframeOaiSandbox: currentIframeStats.oaiSandbox,
      usedJsHeapMb: perf.usedJsHeapMb,
      longTaskCount: perf.longTaskCount,
      longTaskDurationMs: perf.longTaskDurationMs,
      visibility: document.visibilityState,
    })

    if (now() - lastPersistAt >= persistIntervalMs) persist()
    notifyUpdate()
  }

  const onVisibility = () => pushEvent('visibilitychange', { state: document.visibilityState })
  const onPageHide = (event: PageTransitionEvent) => {
    pushEvent('pagehide', { persisted: event.persisted })
    persist()
  }
  const onPageShow = (event: PageTransitionEvent) => pushEvent('pageshow', { persisted: event.persisted })
  const onOnline = () => pushEvent('online')
  const onOffline = () => pushEvent('offline')
  const onWindowError = (event: ErrorEvent) => pushEvent('window-error', {
    message: event.message.slice(0, 300),
    filename: sanitizeUrl(event.filename ?? ''),
  })
  const onUnhandledRejection = (event: PromiseRejectionEvent) => pushEvent('unhandled-rejection', {
    reason: String(event.reason).slice(0, 300),
  })

  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('pagehide', onPageHide)
  window.addEventListener('pageshow', onPageShow)
  window.addEventListener('online', onOnline)
  window.addEventListener('offline', onOffline)
  window.addEventListener('error', onWindowError)
  window.addEventListener('unhandledrejection', onUnhandledRejection)

  let longTaskObserver: PerformanceObserver | undefined
  try {
    longTaskObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTaskCount += 1
        longTaskDurationMs += entry.duration
      }
    })
    longTaskObserver.observe({ type: 'longtask', buffered: true })
  }
  catch {
    // Firefox/部分浏览器没有 Long Tasks API；其它指标仍然工作。
  }

  pushEvent('watch-start', { href: sanitizeUrl(location.href) })
  const timer = window.setInterval(sample, sampleIntervalMs)
  sample()

  const noteConversationPayload = (payload: RawConversationPayload) => {
    latestDiagnostic = diagnoseLatestRun(payload)
    pushEvent('conversation-diagnostic', {
      outcome: latestDiagnostic.outcome,
      summary: latestDiagnostic.summary,
      turnExchangeId: latestDiagnostic.turnExchangeId,
      requestId: latestDiagnostic.requestId,
      interruptedReason: latestDiagnostic.interruptedReason,
      assistantToolCalls: latestDiagnostic.assistantToolCalls,
      toolResults: latestDiagnostic.toolResults,
    })
    persist()
    notifyUpdate()
  }

  /**
   * 只在用户主动点“检查运行状态”时调用一次。
   * endpoint 本身很轻量；若认证头尚未从页面正常请求中捕获，则直接返回 unknown，
   * 不尝试登录、不读取 cookie，也不循环重试。
   */
  const checkServerStatus = async (): Promise<ServerStatusResult> => {
    const conversationId = currentConversationId()
    const authorization = ephemeralHeaders.get('authorization')
    if (!conversationId) {
      return { ok: false, reason: '当前页面不是 /c/<conversation-id>。', checkedAt: now() }
    }
    if (!authorization) {
      return { ok: false, reason: '尚未从页面正常请求中捕获到临时认证上下文；刷新/重新进入聊天后再试。', checkedAt: now() }
    }

    const path = `/backend-api/conversation/${encodeURIComponent(conversationId)}/stream_status`
    const headers = new Headers()
    for (const [name, value] of ephemeralHeaders) headers.set(name, value)
    headers.set('x-openai-target-path', path)
    headers.set('x-openai-target-route', '/backend-api/conversation/{conversation_id}/stream_status')

    try {
      const response = await originalFetch.call(window, path, {
        method: 'GET',
        headers,
        credentials: 'include',
      })
      const body = await response.clone().json().catch(() => null) as { status?: unknown } | null
      const status = typeof body?.status === 'string' ? body.status : undefined
      lastServerStatus = {
        ok: response.ok,
        status,
        httpStatus: response.status,
        reason: response.ok ? undefined : `stream_status HTTP ${response.status}`,
        checkedAt: now(),
      }

      // 认证过期/限流时不保留旧 auth，防止用户连续点击造成请求风暴。
      if (response.status === 401 || response.status === 403 || response.status === 429) {
        ephemeralHeaders.clear()
      }
      pushEvent('server-status', {
        ok: lastServerStatus.ok,
        status: lastServerStatus.status,
        httpStatus: lastServerStatus.httpStatus,
      })
      persist()
      notifyUpdate()
      return lastServerStatus
    }
    catch (error) {
      lastServerStatus = {
        ok: false,
        reason: `stream_status 请求失败：${String(error).slice(0, 180)}`,
        checkedAt: now(),
      }
      pushEvent('server-status-error', { reason: lastServerStatus.reason })
      return lastServerStatus
    }
  }

  const summaryText = (): string => {
    const snap = buildSnapshot()
    const lines = [
      `Run Watch: ${snap.severity.toUpperCase()}`,
      `Conversation: ${snap.conversationId ?? 'unknown'}`,
      `Visibility: ${snap.visibility}`,
      `iframe: ${snap.iframe.total} total / ${snap.iframe.sandboxed} sandboxed / ${snap.iframe.oaiSandbox} OAI sandbox`,
      `iframe lifecycle: +${snap.iframe.addedTotal} / -${snap.iframe.removedTotal}`,
      `JS heap: ${snap.performance.usedJsHeapMb ?? '?'} MB used / ${snap.performance.totalJsHeapMb ?? '?'} MB total`,
      `Long tasks: ${snap.performance.longTaskCount}, ${snap.performance.longTaskDurationMs} ms`,
    ]
    if (snap.latestDiagnostic) lines.push(`Last run: ${snap.latestDiagnostic.outcome} — ${snap.latestDiagnostic.summary}`)
    if (snap.lastServerStatus) lines.push(`Server: ${snap.lastServerStatus.status ?? snap.lastServerStatus.reason ?? 'unknown'}`)
    if (snap.iframe.topFingerprints[0]) {
      lines.push('Top iframe fingerprints:')
      for (const item of snap.iframe.topFingerprints.slice(0, 5)) {
        lines.push(`  ${item.count} × ${item.fingerprint}`)
      }
    }
    return lines.join('\n')
  }

  return {
    noteConversationPayload,
    checkServerStatus,
    snapshot: buildSnapshot,
    summaryText,
    dispose: () => {
      disposed = true
      window.clearInterval(timer)
      longTaskObserver?.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('pageshow', onPageShow)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
      window.removeEventListener('error', onWindowError)
      window.removeEventListener('unhandledrejection', onUnhandledRejection)
      window.fetch = originalFetch
      persist()
    },
  }
}
