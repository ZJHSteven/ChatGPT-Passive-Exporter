import { diagnoseLatestRun, type RunDiagnostic } from '../core/run-diagnostics'
import { analyzeWidgetPressure, type WidgetPressureReport } from '../core/widget-pressure'
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

export interface GenerationUiStats {
  active: boolean
  activeSince?: number
  lastProgressAt: number
  stalledForMs: number
  assistantTextLength?: number
  assistantChildCount?: number
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
  generation: GenerationUiStats
  widgetPressure?: WidgetPressureReport
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

function progressNetworkPath(input: string): boolean {
  try {
    const url = new URL(input, location.href)
    if (url.origin !== location.origin) return false
    return /^\/backend-api\/(?:f\/conversation|aip\/|ecosystem\/|connectors?\/|mcp\/)/u.test(url.pathname)
  }
  catch {
    return false
  }
}

function isVisible(element: Element): boolean {
  if (!(element instanceof HTMLElement)) return false
  if (element.hidden) return false
  const style = getComputedStyle(element)
  return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0
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

function severityFor(
  iframe: IframeStats,
  perf: PerformanceStats,
  generation: GenerationUiStats,
  diagnostic?: RunDiagnostic,
  serverStatus?: ServerStatusResult,
): WatchSeverity {
  if (diagnostic?.terminalEvidence === 'client-stopped' || diagnostic?.terminalEvidence === 'interrupted') return 'critical'
  if (serverStatus?.status === 'COMPLETE' && generation.active) return 'critical'
  if (iframe.total >= 200 || iframe.oaiSandbox >= 200) return 'critical'
  if (iframe.total >= 100 || iframe.oaiSandbox >= 100 || (perf.usedJsHeapMb ?? 0) >= 3000) return 'danger'
  if (iframe.total >= 50 || iframe.oaiSandbox >= 50 || (perf.usedJsHeapMb ?? 0) >= 1500) return 'warning'

  // “静默多久”不参与故障 severity。reasoning/tool 本来就可能长时间没有可见变化；
  // stalledForMs 只作为取证信息展示，绝不能单独触发“疑似死亡”。
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
  let widgetPressure: WidgetPressureReport | undefined
  let lastServerStatus: ServerStatusResult | undefined
  let lastHref = location.href
  let lastPersistAt = 0
  let disposed = false
  let lastProgressAt = now()
  let generationActiveSince: number | undefined
  let lastAssistantSignature = ''

  // 只驻留内存的临时认证上下文。绝不进入 event / snapshot / localStorage。
  const ephemeralHeaders = new Map<string, string>()

  const pushEvent = (type: string, data?: Record<string, unknown>) => {
    events.push({ at: now(), type, conversationId: currentConversationId(), data })
    if (events.length > maxEvents) events.splice(0, events.length - maxEvents)
  }

  const markProgress = () => {
    lastProgressAt = now()
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
    const countsAsProgress = progressNetworkPath(url)
    const started = performance.now()
    if (shouldLog) {
      if (countsAsProgress) markProgress()
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
        response => {
          if (countsAsProgress) markProgress()
          pushEvent('fetch-response', {
            url: sanitizeUrl(url),
            status: response.status,
            elapsedMs: Math.round(performance.now() - started),
          })
        },
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
        markProgress()
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
        markProgress()
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
  let currentGenerationStats: GenerationUiStats = {
    active: false,
    lastProgressAt,
    stalledForMs: 0,
  }

  const readGenerationUi = (): GenerationUiStats => {
    const stopButtons = [...document.querySelectorAll('button[data-testid="stop-button"]')]
    const active = stopButtons.some(isVisible)

    const assistantTurns = [
      ...document.querySelectorAll<HTMLElement>(
        '[data-testid^="conversation-turn-"][data-turn="assistant"], '
        + '[data-testid^="conversation-turn-"][data-message-author-role="assistant"]',
      ),
    ]
    const lastAssistant = assistantTurns.at(-1)
    const assistantTextLength = lastAssistant?.innerText?.length ?? lastAssistant?.textContent?.length
    const assistantChildCount = lastAssistant?.childElementCount
    const assistantIframeCount = lastAssistant?.querySelectorAll('iframe').length ?? 0
    const signature = lastAssistant
      ? `${assistantTextLength ?? 0}:${assistantChildCount ?? 0}:${assistantIframeCount}`
      : ''

    if (signature && signature !== lastAssistantSignature) {
      if (lastAssistantSignature) markProgress()
      lastAssistantSignature = signature
    }

    if (active && !generationActiveSince) {
      generationActiveSince = now()
      markProgress()
      pushEvent('generation-ui-start')
    }
    else if (!active && generationActiveSince) {
      pushEvent('generation-ui-stop', { durationMs: now() - generationActiveSince })
      generationActiveSince = undefined
      markProgress()
    }

    return {
      active,
      activeSince: generationActiveSince,
      lastProgressAt,
      stalledForMs: active ? Math.max(0, now() - lastProgressAt) : 0,
      assistantTextLength,
      assistantChildCount,
    }
  }

  currentGenerationStats = readGenerationUi()

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
      generation: currentGenerationStats,
      widgetPressure,
      latestDiagnostic,
      lastServerStatus,
      severity: severityFor(currentIframeStats, perf, currentGenerationStats, latestDiagnostic, lastServerStatus),
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
      latestDiagnostic = undefined
      widgetPressure = undefined
      lastServerStatus = undefined
      generationActiveSince = undefined
      lastAssistantSignature = ''
      markProgress()
    }

    currentIframeStats = scanIframes()
    currentGenerationStats = readGenerationUi()
    const perf = performanceStats()
    pushEvent('sample', {
      iframeTotal: currentIframeStats.total,
      iframeSandboxed: currentIframeStats.sandboxed,
      iframeOaiSandbox: currentIframeStats.oaiSandbox,
      usedJsHeapMb: perf.usedJsHeapMb,
      longTaskCount: perf.longTaskCount,
      longTaskDurationMs: perf.longTaskDurationMs,
      generationActive: currentGenerationStats.active,
      stalledForMs: currentGenerationStats.stalledForMs,
      assistantTextLength: currentGenerationStats.assistantTextLength,
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
    markProgress()
    latestDiagnostic = diagnoseLatestRun(payload)
    widgetPressure = analyzeWidgetPressure(payload)
    pushEvent('conversation-diagnostic', {
      terminalEvidence: latestDiagnostic.terminalEvidence,
      tailShape: latestDiagnostic.tailShape,
      summary: latestDiagnostic.summary,
      turnExchangeId: latestDiagnostic.turnExchangeId,
      requestId: latestDiagnostic.requestId,
      interruptedReason: latestDiagnostic.interruptedReason,
      assistantToolCalls: latestDiagnostic.assistantToolCalls,
      toolResults: latestDiagnostic.toolResults,
      sdkNodeCount: widgetPressure.sdkNodeCount,
      devspaceSdkNodeCount: widgetPressure.devspaceSdkNodeCount,
      maxSdkNodesInOneTurn: widgetPressure.maxSdkNodesInOneTurn,
      widgetPressure: widgetPressure.interpretation,
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
      `Generation UI: ${snap.generation.active ? 'ACTIVE' : 'idle'} / stalled ${Math.round(snap.generation.stalledForMs / 1000)} s / last progress ${new Date(snap.generation.lastProgressAt).toLocaleTimeString()}`,
    ]
    if (snap.latestDiagnostic) {
      lines.push(`Payload terminal evidence: ${snap.latestDiagnostic.terminalEvidence}`)
      lines.push(`Payload tail: ${snap.latestDiagnostic.tailShape}`)
      lines.push(`Payload note: ${snap.latestDiagnostic.summary}`)
    }
    if (snap.widgetPressure) {
      lines.push(
        `Raw widget pressure: ${snap.widgetPressure.sdkNodeCount} SDK nodes / ${snap.widgetPressure.devspaceSdkNodeCount} DevSpace / max ${snap.widgetPressure.maxSdkNodesInOneTurn} in one turn / ${snap.widgetPressure.interpretation.toUpperCase()}`,
      )
      const live = snap.iframe.oaiSandbox || snap.iframe.sandboxed || snap.iframe.total
      if (snap.widgetPressure.interpretation === 'extreme' && live >= 50) {
        lines.push('Widget diagnosis: 原始聊天本身已有极高 SDK Widget 密度，当前大量 iframe 更像“历史工具卡设计性累积”；仍需用 iframe lifecycle 排除额外 remount 泄漏。')
      }
      else if (snap.widgetPressure.sdkNodeCount < 20 && live >= 50) {
        lines.push('Widget diagnosis: 原始 SDK Widget 很少但实时 iframe 很多，remount/重复 iframe 泄漏嫌疑较高。')
      }
    }
    if (snap.lastServerStatus) lines.push(`Server: ${snap.lastServerStatus.status ?? snap.lastServerStatus.reason ?? 'unknown'}`)
    if (snap.generation.active && snap.generation.stalledForMs >= 5 * 60_000) {
      lines.push('Suspected stall: Stop button仍可见，但页面/工具侧连续数分钟没有观察到进展；建议点“检查服务器运行状态”。')
    }
    if (snap.lastServerStatus?.status === 'COMPLETE' && snap.generation.active) {
      lines.push('Confirmed stale UI: 服务器已 COMPLETE，但页面仍显示生成中。')
    }
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
