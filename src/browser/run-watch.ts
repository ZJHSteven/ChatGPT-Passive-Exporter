import { diagnoseLatestRun, type RunDiagnostic } from '../core/run-diagnostics'
import { analyzeWidgetPressure, type WidgetPressureReport } from '../core/widget-pressure'
import { assessConversationPayload, mergePluralConversationPages } from '../core/conversation-snapshot'
import type { MessagesConversationPayload, RawConversationPayload } from '../core/types'

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

export interface RecentConversationSummary {
  id: string
  title: string
  updateTime?: string | number
  createTime?: string | number
  /**
   * ChatGPT 会话列表里的原始 async_status。当前实测运行中的 thinking/agent 轮次常为 3，
   * 已完成会话常为 null；其它数值保留原样，不擅自解释枚举语义。
   */
  asyncStatus?: number | string | null
}

export interface ConversationTailResult {
  ok: boolean
  httpStatus?: number
  reason?: string
  payload?: RawConversationPayload
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
  /** 当前页面 conversation 的便捷检查。 */
  checkServerStatus: () => Promise<ServerStatusResult>
  /** Fleet Watch 使用：无需打开目标 conversation 页面。 */
  checkConversationServerStatus: (conversationId: string) => Promise<ServerStatusResult>
  /** 用户显式历史审计使用；实时 Fleet 仍只读 offset=0 的最近页。 */
  listConversationPage: (offset: number, limit?: number) => Promise<RecentConversationSummary[]>
  listRecentConversations: (limit?: number) => Promise<RecentConversationSummary[]>
  fetchConversationTail: (conversationId: string, numTurns?: number) => Promise<ConversationTailResult>
  /** 用户明确触发批量导出时使用；与 Fleet 的低频尾部检查分离。 */
  fetchConversation: (conversationId: string, numTurns?: number) => Promise<ConversationTailResult>
  /**
   * 用户明确要求“完整导出/完整读取”时使用。
   * 只有能证明 payload 已覆盖到最早历史时才返回 ok=true；否则 fallback singular mapping，
   * 仍无法证明完整就明确失败，绝不静默返回最近几轮。
   */
  fetchCompleteConversation: (conversationId: string) => Promise<ConversationTailResult>
  /**
   * Companion 自己的主动 backend-api 请求如果曾收到 429，会进入跨标签共享退避。
   * Fleet/历史审计在退避期间必须完全停止主动请求，而不是等下一次捕获到 auth 后继续撞限流。
   */
  activeRequestBackoffUntil: () => number | undefined
  hasEphemeralAuth: () => boolean
  snapshot: () => RunWatchSnapshot
  summaryText: () => string
  dispose: () => void
}

export interface RunWatchOptions {
  sampleIntervalMs?: number
  persistIntervalMs?: number
  maxEvents?: number
  /** 429 后的跨标签主动 API 冷却时长；读取 Companion 当前设置。 */
  getRateLimitBackoffMs?: () => number
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
const ACTIVE_API_BACKOFF_KEY = 'chatgpt-passive-exporter/active-api-backoff/v1'
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

  const hasEphemeralAuth = () => ephemeralHeaders.has('authorization')

  /**
   * 只约束 Companion 自己主动补发的私有 API 请求，不干预 ChatGPT 网页原生网络流量。
   * localStorage 是同 origin / 同 profile 跨 tab 共享的，因此任意一张 Companion 页撞到 429 后，
   * 其它首页/会话页也会一起停手，避免多 tab 轮番重试。
   */
  const activeRequestBackoffUntil = (): number | undefined => {
    try {
      const raw = localStorage.getItem(ACTIVE_API_BACKOFF_KEY)
      if (!raw) return undefined
      const parsed = JSON.parse(raw) as { until?: number }
      if (typeof parsed.until !== 'number') return undefined
      if (parsed.until <= now()) {
        localStorage.removeItem(ACTIVE_API_BACKOFF_KEY)
        return undefined
      }
      return parsed.until
    }
    catch {
      return undefined
    }
  }

  const enterRateLimitBackoff = () => {
    const configured = options.getRateLimitBackoffMs?.()
    const backoffMs = typeof configured === 'number' && Number.isFinite(configured)
      ? Math.max(60_000, configured)
      : 60 * 60_000
    const until = now() + backoffMs
    try {
      localStorage.setItem(ACTIVE_API_BACKOFF_KEY, JSON.stringify({
        until,
        reason: 'HTTP 429',
        createdAt: now(),
      }))
    }
    catch {
      // localStorage 不可用时至少清空本 tab 的 auth，阻止当前实例立即重试。
    }
    ephemeralHeaders.clear()
    pushEvent('active-api-backoff', { until, reason: 'HTTP 429' })
  }

  const authenticatedJson = async (
    path: string,
    targetRoute: string,
  ): Promise<{ ok: boolean, httpStatus?: number, body?: unknown, reason?: string }> => {
    const backoffUntil = activeRequestBackoffUntil()
    if (backoffUntil) {
      return {
        ok: false,
        httpStatus: 429,
        reason: `Companion 主动 API 已因限流暂停到 ${new Date(backoffUntil).toLocaleTimeString()}。`,
      }
    }

    if (!hasEphemeralAuth()) {
      return { ok: false, reason: '尚未从 ChatGPT 页面正常请求中捕获到临时认证上下文。' }
    }

    const headers = new Headers()
    for (const [name, value] of ephemeralHeaders) headers.set(name, value)
    headers.set('x-openai-target-path', path)
    headers.set('x-openai-target-route', targetRoute)

    try {
      const response = await originalFetch.call(window, path, {
        method: 'GET',
        headers,
        credentials: 'include',
      })
      const body = await response.clone().json().catch(() => null)

      // 429 不能只“清 auth”然后等网页下一条正常请求把 auth 补回来继续撞墙。
      // 一旦收到限流，整个 ChatGPT origin 下的 Companion 主动请求统一停 1 小时。
      if (response.status === 429) enterRateLimitBackoff()
      else if (response.status === 401 || response.status === 403) {
        ephemeralHeaders.clear()
      }

      return {
        ok: response.ok,
        httpStatus: response.status,
        body,
        reason: response.ok ? undefined : `HTTP ${response.status}`,
      }
    }
    catch (error) {
      return { ok: false, reason: String(error).slice(0, 220) }
    }
  }

  const checkConversationServerStatus = async (conversationId: string): Promise<ServerStatusResult> => {
    const path = `/backend-api/conversation/${encodeURIComponent(conversationId)}/stream_status`
    const result = await authenticatedJson(path, '/backend-api/conversation/{conversation_id}/stream_status')
    const record = result.body && typeof result.body === 'object' ? result.body as Record<string, unknown> : null
    const status = typeof record?.status === 'string' ? record.status : undefined
    const serverResult: ServerStatusResult = {
      ok: result.ok,
      status,
      httpStatus: result.httpStatus,
      reason: result.ok ? undefined : result.reason,
      checkedAt: now(),
    }
    pushEvent('server-status', {
      conversationId,
      ok: serverResult.ok,
      status: serverResult.status,
      httpStatus: serverResult.httpStatus,
    })
    return serverResult
  }

  /** 当前页面 conversation 的便捷检查。 */
  const checkServerStatus = async (): Promise<ServerStatusResult> => {
    const conversationId = currentConversationId()
    if (!conversationId) {
      return { ok: false, reason: '当前页面不是 /c/<conversation-id>。', checkedAt: now() }
    }
    lastServerStatus = await checkConversationServerStatus(conversationId)
    persist()
    notifyUpdate()
    return lastServerStatus
  }

  const listConversationPage = async (offset: number, limit = 28): Promise<RecentConversationSummary[]> => {
    // 当前 ChatGPT Web sidebar 实测使用 limit=28 + is_archived/is_starred 过滤。
    // 历史审计沿用同一形状，只改变 offset；这样不会为了后台工具制造新的 query 结构。
    const safeOffset = Math.max(0, Math.trunc(offset))
    const safeLimit = Math.max(1, Math.min(28, Math.trunc(limit)))
    const path = `/backend-api/conversations?offset=${safeOffset}&limit=28&order=updated&is_archived=false&is_starred=false`
    const result = await authenticatedJson(path, '/backend-api/conversations')
    if (!result.ok) return []

    const record = result.body && typeof result.body === 'object' ? result.body as Record<string, unknown> : null
    const items = Array.isArray(record?.items) ? record.items : []
    const summaries: RecentConversationSummary[] = []

    for (const item of items) {
      if (!item || typeof item !== 'object') continue
      const row = item as Record<string, unknown>
      const id = typeof row.id === 'string'
        ? row.id
        : typeof row.conversation_id === 'string'
          ? row.conversation_id
          : undefined
      if (!id) continue
      summaries.push({
        id,
        title: typeof row.title === 'string' && row.title ? row.title : id,
        updateTime: typeof row.update_time === 'string' || typeof row.update_time === 'number' ? row.update_time : undefined,
        createTime: typeof row.create_time === 'string' || typeof row.create_time === 'number' ? row.create_time : undefined,
        asyncStatus: typeof row.async_status === 'string' || typeof row.async_status === 'number' || row.async_status === null
          ? row.async_status
          : undefined,
      })
    }
    return summaries.slice(0, safeLimit)
  }

  const listRecentConversations = async (limit = 20): Promise<RecentConversationSummary[]> => {
    return listConversationPage(0, limit)
  }

  /**
   * 仅在某条 conversation 已经结束、需要做后验归因时读取最后少量 turns。
   * 默认 2 turns，避免像 50MB 巨型聊天那样每次全量拉取。
   */
  const fetchConversationByTurns = async (conversationId: string, numTurns: number): Promise<ConversationTailResult> => {
    const path = `/backend-api/conversations/${encodeURIComponent(conversationId)}?include_has_versions=true&num_turns=${numTurns}`
    const result = await authenticatedJson(path, '/backend-api/conversations/{conversation_id}')
    const payload = result.ok && result.body && typeof result.body === 'object'
      ? result.body as RawConversationPayload
      : undefined
    return {
      ok: result.ok,
      httpStatus: result.httpStatus,
      reason: result.reason,
      payload,
      checkedAt: now(),
    }
  }

  const fetchConversationTail = async (conversationId: string, numTurns = 2): Promise<ConversationTailResult> => {
    return fetchConversationByTurns(conversationId, Math.max(1, Math.min(5, Math.trunc(numTurns))))
  }

  /**
   * 批量导出属于用户明确触发的主动操作，因此允许读取更完整的 conversation。
   * 这里仍保留 100 turns 上限，避免无界请求；当前实测超长聊天在 num_turns=100 时可返回完整分页。
   */
  const fetchConversation = async (conversationId: string, numTurns = 100): Promise<ConversationTailResult> => {
    return fetchConversationByTurns(conversationId, Math.max(1, Math.min(1000, Math.trunc(numTurns))))
  }

  /**
   * 完整 conversation 读取。
   *
   * 为什么不能简单 `num_turns=1000`：当前第一方 ChatGPT Web 明确使用 10-turn cursor 分页，
   * 大窗口属于我们自己发明的请求形状，也仍可能只得到 tail。这里改成完全跟随网页协议：
   * 最新 10 turns → page_info.start_cursor → /messages?before=<cursor> → 一直翻到
   * has_previous_page=false。每页串行、留少量间隔，不制造并发尖峰；modern 路径无法证明完整
   * 时才退回 legacy singular mapping。两条路径都失败则宁可报错，也绝不静默导出残缺历史。
   */
  const fetchCompleteConversation = async (conversationId: string): Promise<ConversationTailResult> => {
    const plural = await fetchConversationByTurns(conversationId, 10)
    let pluralReason = plural.reason ?? `plural HTTP ${plural.httpStatus ?? '?'}`

    if (plural.ok && plural.payload && Array.isArray((plural.payload as MessagesConversationPayload).messages)) {
      const latestPage = plural.payload as MessagesConversationPayload
      const pages: MessagesConversationPayload[] = [latestPage]
      const firstAssessment = assessConversationPayload(latestPage)
      if (firstAssessment.completeness === 'complete') return plural

      let currentPage = latestPage
      const seenCursors = new Set<string>()
      for (let pageIndex = 1; pageIndex < 2000; pageIndex += 1) {
        const pageInfo = currentPage.page_info
        if (pageInfo?.has_previous_page === false) {
          return { ...plural, payload: mergePluralConversationPages(pages) }
        }

        const cursor = typeof pageInfo?.start_cursor === 'string' ? pageInfo.start_cursor : ''
        if (!cursor) {
          pluralReason = `modern cursor 第 ${pageIndex} 页仍有 previous page，但缺少 start_cursor`
          break
        }
        if (seenCursors.has(cursor)) {
          pluralReason = `modern cursor 出现重复 start_cursor：${cursor}`
          break
        }
        seenCursors.add(cursor)

        // 完整导出是用户显式动作，可以主动补页；仍串行并留间隔，避免制造瞬时请求尖峰。
        await new Promise(resolve => window.setTimeout(resolve, 350))
        const path = `/backend-api/conversations/${encodeURIComponent(conversationId)}/messages?before=${encodeURIComponent(cursor)}&include_has_versions=true&num_turns=10`
        const older = await authenticatedJson(path, '/backend-api/conversations/{conversation_id}/messages')
        if (!older.ok || !older.body || typeof older.body !== 'object') {
          pluralReason = `modern cursor 第 ${pageIndex + 1} 页失败：${older.reason ?? `HTTP ${older.httpStatus ?? '?'}`}`
          break
        }
        const olderPage = older.body as MessagesConversationPayload
        if (!Array.isArray(olderPage.messages)) {
          pluralReason = `modern cursor 第 ${pageIndex + 1} 页没有 messages[]`
          break
        }
        pages.push(olderPage)
        currentPage = olderPage

        if (olderPage.page_info?.has_previous_page === false) {
          return {
            ok: true,
            httpStatus: older.httpStatus,
            payload: mergePluralConversationPages(pages),
            checkedAt: now(),
          }
        }
      }
    }

    const singularPath = `/backend-api/conversation/${encodeURIComponent(conversationId)}`
    const singular = await authenticatedJson(singularPath, '/backend-api/conversation/{conversation_id}')
    const payload = singular.ok && singular.body && typeof singular.body === 'object'
      ? singular.body as RawConversationPayload
      : undefined

    if (payload) {
      const assessment = assessConversationPayload(payload)
      if (assessment.completeness === 'complete') {
        return {
          ok: true,
          httpStatus: singular.httpStatus,
          payload,
          checkedAt: now(),
        }
      }
    }

    if (plural.ok && plural.payload && pluralReason.startsWith('plural HTTP')) {
      pluralReason = assessConversationPayload(plural.payload).reason
    }
    const singularReason = singular.ok && payload
      ? assessConversationPayload(payload).reason
      : singular.reason ?? `singular HTTP ${singular.httpStatus ?? '?'}`

    return {
      ok: false,
      httpStatus: singular.httpStatus ?? plural.httpStatus,
      reason: `无法证明 conversation 已完整读取。plural: ${pluralReason}; singular: ${singularReason}`,
      checkedAt: now(),
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
      lines.push('Quiet-period note: 页面 UI 仍显示生成中，且本 tab 一段时间没有观察到可见进展；这不是死亡证据，只用于取证。')
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
    checkConversationServerStatus,
    listConversationPage,
    listRecentConversations,
    fetchConversationTail,
    fetchConversation,
    fetchCompleteConversation,
    activeRequestBackoffUntil,
    hasEphemeralAuth,
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
