/**
 * `chatgpt-archive-daemon.mjs` 保持为可直接由 Node 执行的 ESM daemon。
 * 测试只导入其纯函数 WSS parser，因此用旁路声明维持严格 TypeScript 检查，
 * 不把整份长期进程脚本强行迁成 TS，也不使用 @ts-ignore。
 */
export interface ArchiveWssEvent {
  conversationId: string
  type: string
  updateType: string | null
}

export interface ArchiveWssEventBehavior {
  dirty: true
  syncReady: boolean
  startsTurn: boolean
  completesTurn: boolean
  asyncProgress: boolean
}

/** 从 ChatGPT conversations topic 的 WSS frame 中抽取最小事件身份。 */
export function extractConversationEvents(payloadData: unknown): ArchiveWssEvent[]

/** 将 WSS event 分类为 dirty / active / sync-ready 行为，不触碰网络。 */
export function classifyConversationEvent(type: unknown, updateType?: unknown): ArchiveWssEventBehavior

/** 判断某种同步 trigger 是否允许把异常尾部升级成 realtime incident。 */
export function shouldClassifyTerminalForTrigger(trigger: unknown): boolean

/** 判断 trigger 是否已提供 WSS/catalog 层面的“服务端确定结束”证据。 */
export function isConfirmedTerminalTrigger(trigger: unknown): boolean

/** complete 已到但 body 尚未显式终止时，是否应先做一次有界 settle 再立 incident。 */
export function shouldDeferConfirmedTerminalIncident(
  trigger: unknown,
  diagnostic: { terminalEvidence?: unknown } | null | undefined,
): boolean

/** 把 conversation list async_status 分类为 active / complete / unknown。 */
export function classifyCatalogAsyncStatus(value: unknown): 'active' | 'complete' | 'unknown'

/** catalog 首次观察到 active 时，是否应以该时刻建立保守 late-start watchdog。 */
export function shouldStartCatalogWatchdog(input?: {
  alreadyActive?: boolean
  catalogUpdateTime?: unknown
  archivedUpdateTime?: unknown
  archivedTerminalState?: unknown
}): boolean

/** 根据 active 的 startType 选择普通 watchdog 或 catalog active-zombie watchdog。 */
export function watchdogTriggerForStartType(startType: unknown): 'watchdog:catalog-active-timeout' | 'watchdog:active-timeout'

/** watchdog 只在首次超时或“新进展后再次超时”时调查，不按固定间隔轮询 zombie。 */
export function shouldQueueWatchdogDiagnostic(
  active: { startedAt?: unknown, lastEventAt?: unknown, lastWatchdogAt?: unknown, lastDiagnosticTurnKey?: unknown } | null | undefined,
  now?: number,
  watchdogMs?: number,
): boolean

/** 从 body diagnostic 提取 watchdog 用的稳定 turn key。 */
export function watchdogDiagnosticTurnKey(diagnostic: {
  turnExchangeId?: unknown
  requestId?: unknown
  userMessageId?: unknown
  lastMessageId?: unknown
} | null | undefined): string | null

/** 若 watchdog 发现同一 conversation 已切到新 turn，则重置 late-start 计时。 */
export function reconcileWatchdogDiagnosticTurn(
  active: Record<string, unknown> | null | undefined,
  diagnostic: {
    turnExchangeId?: unknown
    requestId?: unknown
    userMessageId?: unknown
    lastMessageId?: unknown
  } | null | undefined,
  now?: number,
): { changed: boolean, turnKey: string | null, nextActive: any }

/** 把同步 trigger 映射成 incident kind。 */
export function incidentKindForTrigger(trigger: unknown): 'active-zombie' | 'watchdog-timeout' | 'abnormal-terminal'

/** 重启 daemon 时只继承仍未过期的 HTTP 429 circuit breaker。 */
export function restoreCooldownUntil(previousState: unknown, now?: number): number

/** cooldown 只冻结主动 API；返回 false 时 Guardian/WSS 仍应继续工作。 */
export function activeApiAllowed(cooldownUntil: unknown, now?: number): boolean

/** 单次 CDP 健康探活失败不立即拆 Guardian；连续达到阈值后才允许重建。 */
export function shouldRebuildGuardianAfterHealthFailures(
  consecutiveFailures: unknown,
  threshold?: unknown,
): boolean

/** deferred gap repair 的统一门控：WSS、debounce、最小间隔、cooldown 与并发状态必须同时满足。 */
export function shouldRunDeferredGapRepair(input: {
  now: number
  pendingLastAt: number | null
  lastAttemptAt?: number
  delayMs: number
  minIntervalMs: number
  activeSockets: number
  authAvailable: boolean
  cooldownUntil: unknown
  reconcileInFlight: boolean
  passiveCatalogAvailable?: boolean
}): boolean

/**
 * 根据 reconciliation 场景选择需要连续看到多少条稳定旧记录才可停止 catalog 扫描。
 * 短 WSS reconnect 默认一整页；startup/periodic/长盲区继续使用更深阈值。
 */
export function catalogStableOverlapTarget(
  reason: unknown,
  options?: { pageSize?: number, deepThreshold?: number },
): number

export type ConversationBackendRoute =
  | { kind: 'catalog', offset: number, limit: number, globalCatalog: boolean, conversationOrigin: string | null, excludeConversationOrigin: string | null, hideSnorlax: string | null }
  | { kind: 'body-latest', conversationId: string }
  | { kind: 'body-cursor', conversationId: string, before: string | null }
  | { kind: 'mapping', conversationId: string }

/** 归一化 ChatGPT conversation 私有 REST URL；不发网络请求。 */
export function classifyConversationBackendUrl(input: unknown, base?: string): ConversationBackendRoute | null

/** cooldown 期间只屏蔽 Guardian 的 conversation REST，WSS 不受影响。 */
export function shouldBlockGuardianConversationRest(input: unknown): boolean

/** 判断某个 passive response 是否足够新，可以替代本次 ready 后的主动 replay。 */
export function passiveObservationMatchesReady(capturedAt: unknown, readyAt: unknown, toleranceMs?: number): boolean

/** cooldown 恢复期使用更慢的 active request gap。 */
export function effectiveActiveRequestGap(baseGapMs: unknown, recoveryProbeRemaining: unknown, recoveryProbeGapMs: unknown): number

/** 只有“无 WSS”从本次 gap 起持续超过 grace 后，才允许重建 Guardian。 */
export function shouldRebuildGuardianForMissingWss(input: {
  now: number
  activeSockets: number
  gapStartedAt: number | null
  reconnectGraceMs: number
}): boolean

/** 从当前页面真实 backend 请求中提取短生命周期、允许复用的请求上下文字段。 */
export function sanitizeCapturedHeaders(headers: Record<string, unknown>): Record<string, unknown>

/** 从已存在的 ChatGPT conversation target URL 提取 conversation id。 */
export function conversationIdFromTargetUrl(value: unknown): string | null

/** 从 estuary 内容 URL 中只提取稳定 file id；忽略 ts/sig 等临时签名。 */
export function estuaryFileIdFromUrl(value: unknown): string | null

/** 校验 files/download resolver 返回的 signed estuary URL 是否与 stable file id 一致。 */
export function resolvedEstuaryUrlForFile(payload: unknown, fileId: unknown): string | null

/** 将 CDP Network.getResponseBody 返回值还原为原始响应字节。 */
export function decodeCdpResponseBodyBytes(result: { body?: unknown, base64Encoded?: unknown } | null | undefined): Buffer

/** 新 incident 或同一 incident 的 material lifecycle 升级才触发手机通知。 */
export function shouldNotifyIncidentTransition(
  before: null | {
    id?: unknown
    incidentKind?: unknown
    lifecycleClass?: unknown
    terminalEvidence?: unknown
  },
  after: null | {
    id?: unknown
    incidentKind?: unknown
    lifecycleClass?: unknown
    terminalEvidence?: unknown
  },
): boolean

