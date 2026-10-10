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

export type TurnTopicWssSummary =
  | { source: 'subscribe', topic: string, offset: string | null }
  | { source: 'reply', topic: string, recovered: boolean | null, catchupCount: number, lastOffsetPresent: boolean }
  | { source: 'catchup' | 'message', topic: string, innerType: string | null, hasEncodedItem: boolean, encodedBytes: number, offsetPresent: boolean, streamItemIdPresent: boolean, parentStreamItemIdPresent: boolean }

/** 脱敏汇总第一方 conversation-turn-* subscribe/ACK/catchup/live frame。 */
export function summarizeTurnTopicWssFrame(payloadData: unknown): TurnTopicWssSummary[]

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

/** catalog 服务端 update_time 真正前进后，从 progress 时刻重新武装 watchdog。 */
export function recordCatalogWatchdogProgress<T extends Record<string, unknown> | null | undefined>(
  active: T,
  now?: number,
): T

/** DevSpace overlap 中仍可能被下一轮 poll 返回的 audit id 必须继续保留去重。 */
export function shouldRetainSeenDevSpaceAudit(
  eventAt: unknown,
  pollSinceAt: unknown,
  overlapMs?: number,
): boolean

/** 根据 active 的 startType 选择普通 watchdog 或 catalog active-zombie watchdog。 */
export function watchdogTriggerForStartType(startType: unknown): 'watchdog:catalog-active-timeout' | 'watchdog:active-timeout'

/** DevSpace first-tool 启动新 turn watchdog；当前 turn key 在第一次 body 诊断前必须保持 unknown。 */
export function devSpaceFirstToolWatchdogState(auditAt: number): {
  startedAt: number
  lastEventAt: number
  lastWatchdogAt: null
  watchdogPendingAt: null
  startType: 'devspace:first-tool'
  lastDiagnosticTurnKey: null
}

/** 当前 canonical exact match 只允许覆盖 legacy backfill binding，不覆盖另一个在线 exact binding。 */
export function shouldSupersedeDevSpaceBinding(
  existing: { conversationId?: unknown, evidence?: unknown } | null | undefined,
  candidate: { conversationId?: unknown, evidence?: unknown } | null | undefined,
): boolean

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

/** 从 canonical body 的当前 user node 恢复该 turn 的真实开始时间（epoch ms）。 */
export function watchdogTurnStartedAtFromPayload(
  payload: { messages?: unknown[] } | null | undefined,
  diagnostic: {
    turnExchangeId?: unknown
    requestId?: unknown
    userMessageId?: unknown
  } | null | undefined,
): number | null

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
  observedTurnStartedAt?: number | null,
): {
  changed: boolean
  turnKey: string | null
  turnStartedAt?: number | null
  turnStartSource?: 'body-user-create-time' | 'diagnostic-observed-at' | null
  nextActive: any
}

/** watchdog 诊断成功后决定当前 generation 是否应立即关闭。 */
export function shouldCloseWatchdogGenerationAfterSync(
  trigger: unknown,
  result: { watchdogTurnChanged?: unknown, watchdogTurnAlreadyTimedOut?: unknown } | null | undefined,
): boolean

/** 把同步 trigger 映射成 incident kind。 */
export function incidentKindForTrigger(trigger: unknown): 'active-zombie' | 'watchdog-timeout' | 'abnormal-terminal'

/** 重启 daemon 时只继承仍未过期的 HTTP 429 circuit breaker。 */
export function restoreCooldownUntil(previousState: unknown, now?: number): number
export function resumeRetryDelayMs(attemptNumber: unknown): number
export function shouldRetireIdleLiveTransport(
  state: {
    transport?: unknown
    conversationId?: unknown
    lastDataAt?: unknown
  } | null | undefined,
  options?: {
    now?: number
    idleMs?: number
    hasResumeCredential?: boolean
  },
): boolean
export function terminalStateSupersedesResumeCredential(
  row: { terminalState?: unknown, lastSeenAt?: unknown } | null | undefined,
  credentialSeenAt: unknown,
): boolean

/** cooldown 只冻结主动 API；返回 false 时 Guardian/WSS 仍应继续工作。 */
export function activeApiAllowed(cooldownUntil: unknown, now?: number): boolean

/** 将绝对时间戳格式化为人类可读的北京时间字符串；内部存储仍保持 epoch/UTC。 */
export function formatBeijingTime(value: unknown): string

/** 生成一次“首次进入 429 cooldown”的独立运行状态通知文案。 */
export function buildCooldownNotificationPayload(input: {
  reason: unknown
  cooldownUntil: unknown
  route?: string | null
  retryAfter?: string | null
}): {
  title: string
  body: string
}

export function buildWatchdogDeferredNotificationPayload(input: {
  conversationId: string
  title?: string | null
  startedAt: number
  now?: number
  cooldownUntil: number
}): { title: string, body: string, url?: string }

export function buildWatchdogTimeoutNotificationPayload(input: {
  conversationId: string
  title?: string | null
  startedAt: number
  now?: number
}): { title: string, body: string, url?: string }

export function buildWatchdogDiagnosisNotificationPayload(input: {
  conversationId: string
  title?: string | null
  diagnostic?: { terminalEvidence?: unknown, tailShape?: unknown } | null
  incident?: { reason?: unknown } | null
}): { title: string, body: string, url: string }

export function buildUnboundWatchdogNotificationPayload(input: {
  metadataId: string
  title?: string | null
  startedAt: number
  now?: number
}): { title: string, body: string }

export function buildTurnFinalNotificationPayload(input: {
  conversationId: string
  title?: string | null
  diagnostic?: { hasImageGenerationFinal?: unknown, imageGenerationCount?: unknown } | null
}): { title: string, body: string, url: string }

/** 返回本轮主循环刚跨过的 DevSpace 工具静默阈值（当前固定为 1/3/5 分钟）。 */
export function crossedDevSpaceIdleThresholds(
  previousIdleMs: unknown,
  currentIdleMs: unknown,
): number[]

/** 5 分钟 DevSpace 静默提前核验模式：已绑定直读 body，未绑定复用 catalog gap-repair。 */
export function devSpaceIdleRepairMode(
  thresholdMs: unknown,
  conversationId?: string | null,
): 'none' | 'bound-body' | 'unbound-catalog'

/** 生成独立 DevSpace Bug 分组的软提醒；它不表示 ChatGPT turn 已终止。 */
export function buildDevSpaceIdleNotificationPayload(input: {
  conversationId?: string | null
  title?: string | null
  metadataId?: unknown
  thresholdMs: unknown
}): {
  title: string
  body: string
  group: string
  url?: string
}

/** 把完整 DevSpace metadata 压缩成可口述、可前缀回查的 meta/XXXXXXXX。 */
export function shortDevSpaceMetadataAlias(metadataId: unknown): string

/** 从工具 args JSON 中读取非空 conclusion；损坏 JSON / 空字符串均返回 null。 */
export function extractDevSpaceConclusion(argsJson: unknown): string | null

/** 从独立 checkpoint 工具 args 中读取 summary/next；损坏 JSON / 空 summary 返回 null。 */
export function extractDevSpaceCheckpoint(argsJson: unknown): {
  summary: string
  next: string | null
} | null

/** 生成独立 DevSpace Conclusion 分组的阶段性结论通知。 */
export function buildDevSpaceConclusionNotificationPayload(input: {
  conversationId?: string | null
  title?: string | null
  metadataId?: unknown
  tool?: unknown
  conclusion?: unknown
}): {
  title: string
  body: string
  group: string
  url?: string
}

/** 生成独立 DevSpace Checkpoint 分组的阶段进展通知。 */
export function buildDevSpaceCheckpointNotificationPayload(input: {
  conversationId?: string | null
  title?: string | null
  metadataId?: unknown
  summary?: unknown
  next?: unknown
}): {
  title: string
  body: string
  group: string
  url?: string
}

export function shouldNotifyTurnFinal(
  trigger: unknown,
  diagnostic: { terminalEvidence?: unknown } | null | undefined,
): boolean

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

/**
 * 判断一个 CDP target 是否应该挂普通页面被动 observer。
 * Guardian 兼任 Actor 后也必须返回 true，这样它自己发出的 SSE 仍能进入 Phase 3 LiveTurn。
 */
export function shouldAttachPassivePageObserver(target: {
  type?: unknown
  url?: unknown
  webSocketDebuggerUrl?: unknown
} | null | undefined): boolean

/** 判断某个 passive response 是否足够新，可以替代本次 ready 后的主动 replay。 */
export function passiveObservationMatchesReady(capturedAt: unknown, readyAt: unknown, toleranceMs?: number): boolean

/** cooldown 恢复期使用更慢的 active request gap。 */
export function effectiveActiveRequestGap(baseGapMs: unknown, recoveryProbeRemaining: unknown, recoveryProbeGapMs: unknown): number

/** 判断 WSS topic 是否属于 conversation 生命周期传输面。 */
export function isConversationTransportTopic(topic: unknown): boolean

/** 同一 Guardian 内 conversation carrier requestId 换代时才触发 gap repair。 */
export function shouldRepairConversationTransport(
  observedCarrierBefore: unknown,
  currentRequestId: unknown,
  nextRequestId: unknown,
): boolean

/** 顶层 ChatGPT document replacement 时旧 document WSS 不再算 active；iframe/SPA 不触发。 */
export function shouldRetireWssSocketsForFrameNavigation(frame: {
  parentId?: unknown
  url?: unknown
} | null | undefined): boolean

/** 只有“无 WSS”从本次 gap 起持续超过 grace 后，才允许重建 Guardian。 */
export function shouldRebuildGuardianForMissingWss(input: {
  now: number
  activeSockets: number
  gapStartedAt: number | null
  reconnectGraceMs: number
}): boolean

/** 从当前页面真实 backend 请求中提取短生命周期、允许复用的请求上下文字段。 */
export const CAPTURED_HEADER_ALLOWLIST: string[]
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

/** startup 只补历史事实，不发送历史 incident 手机通知；其它实时/恢复触发允许。 */
export function shouldNotifyHistoricalIncidentForTrigger(trigger: unknown): boolean

