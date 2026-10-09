import fs from 'node:fs/promises'
import path from 'node:path'
import type { RunDiagnostic } from '../core/run-diagnostics'
import type { LiveTransportEvent } from './live-turn-transport'

/**
 * Active Turn Recorder 只保存“运行控制面”元数据，不保存用户正文、工具正文、Cookie、
 * Authorization 或任何完整 WSS frame。
 *
 * 设计目标不是取代 Archive SQLite，而是回答事故发生后最难还原的几个问题：
 * 1. 某个 complete 到来前，daemon 当时观测到多少个 active conversation？
 * 2. complete 对应的 request_id / turn_exchange_id 是什么？
 * 3. 该 turn 最终是 final、client_stopped，还是 reasoning-ended-no-final？
 * 4. 多个 conversation 是否在一个很窄的时间窗口里被一起收口？
 *
 * 注意：当前账户级 WSS 对普通 Web turn 经常只有 complete，没有可靠 start。因此这里记录的
 * activeCount 是“daemon 已观测到的 active 集合”，不是账户真实并发数的数学真值。
 * Phase 3 接入页面自己的 /f/conversation 发送事件后，才能把本机 turn start 补全。
 */

export interface WssLifecycleInput {
  conversationId: string
  type: string
  updateType: string | null
  startsTurn: boolean
  completesTurn: boolean
  asyncProgress: boolean
}

export interface ActiveTurnTraceBase {
  version: 1
  at: number
  kind: 'wss-lifecycle' | 'body-snapshot' | 'catalog-observation' | 'actor-submit'
  conversationId: string
}

export interface ActorSubmitTrace extends ActiveTurnTraceBase {
  kind: 'actor-submit'
  actorTargetId: string
  mode?: 'new' | 'continue' | 'steer'
  targetMode?: 'guardian' | 'dedicated'
  navigationMode?: 'already-there' | 'spa-new' | 'spa-project' | 'spa-conversation' | 'full-fallback'
  prepareRequestId: string | null
  prepareStatus: number | null
  sendHandlerAttempts: number
  cdpRequestId: string
  responseStatus: number | null
  responseMimeType: string | null
  boundAt: number
  bindDelayMs: number
  pageUrlBefore: string
  contextReadyAt?: number | null
  firstDataAt?: number | null
  runningConfirmed?: boolean
}

export interface WssLifecycleTrace extends ActiveTurnTraceBase {
  kind: 'wss-lifecycle'
  type: string
  updateType: string | null
  startsTurn: boolean
  completesTurn: boolean
  asyncProgress: boolean
  activeBefore: number
  activeAfter: number
  activeConversationIdsBefore: string[]
  activeConversationIdsAfter: string[]
}

export interface BodySnapshotTrace extends ActiveTurnTraceBase {
  kind: 'body-snapshot'
  trigger: string
  requestId: string | null
  turnExchangeId: string | null
  userMessageId: string | null
  lastMessageId: string | null
  terminalEvidence: RunDiagnostic['terminalEvidence']
  interruptedReason: string | null
  tailShape: RunDiagnostic['tailShape']
  currentNode: string | null
  currentNodeStatus: string | null
  currentNodeEndTurn: boolean | null
  headState: RunDiagnostic['headState']
  offHeadSameTurnMessageCount: number
  hasFinal: boolean
  hasReasoningEnded: boolean
  assistantToolCalls: number
  toolResults: number
  nodeCount: number
  activeObserved: number
  activeConversationIds: string[]
  /**
   * 预留给 Phase 3 的前端/实时流探针。
   * 当前 Archive body 没有稳定可验证的 protectionType 字段，因此必须保持 null，不能猜。
   */
  safetyReview: null
}

export interface CatalogObservationTrace extends ActiveTurnTraceBase {
  kind: 'catalog-observation'
  asyncStatus: number | string | null
  classifiedState: 'active' | 'complete'
  reason: string
  wasCatalogActive: boolean
  reliableActiveAfter: number
  reliableActiveConversationIdsAfter: string[]
  catalogActiveAfter: number
  catalogActiveConversationIdsAfter: string[]
}

export type ActiveTurnTrace = WssLifecycleTrace | BodySnapshotTrace | CatalogObservationTrace | ActorSubmitTrace | LiveTransportEvent

/**
 * 为了让 JSONL 可稳定 diff / 测试，conversation id 一律排序后写出。
 */
export function sortedConversationIds(ids: Iterable<string>): string[] {
  return [...ids].filter(Boolean).sort()
}

export function buildWssLifecycleTrace(input: {
  at: number
  event: WssLifecycleInput
  activeBeforeIds: Iterable<string>
  activeAfterIds: Iterable<string>
}): WssLifecycleTrace {
  const before = sortedConversationIds(input.activeBeforeIds)
  const after = sortedConversationIds(input.activeAfterIds)
  return {
    version: 1,
    at: input.at,
    kind: 'wss-lifecycle',
    conversationId: input.event.conversationId,
    type: input.event.type,
    updateType: input.event.updateType,
    startsTurn: input.event.startsTurn,
    completesTurn: input.event.completesTurn,
    asyncProgress: input.event.asyncProgress,
    activeBefore: before.length,
    activeAfter: after.length,
    activeConversationIdsBefore: before,
    activeConversationIdsAfter: after,
  }
}

export function buildBodySnapshotTrace(input: {
  at: number
  conversationId: string
  trigger: string
  diagnostic: RunDiagnostic
  activeConversationIds: Iterable<string>
}): BodySnapshotTrace {
  const activeIds = sortedConversationIds(input.activeConversationIds)
  return {
    version: 1,
    at: input.at,
    kind: 'body-snapshot',
    conversationId: input.conversationId,
    trigger: input.trigger,
    requestId: input.diagnostic.requestId ?? null,
    turnExchangeId: input.diagnostic.turnExchangeId ?? null,
    userMessageId: input.diagnostic.userMessageId ?? null,
    lastMessageId: input.diagnostic.lastMessageId ?? null,
    terminalEvidence: input.diagnostic.terminalEvidence,
    interruptedReason: input.diagnostic.interruptedReason ?? null,
    tailShape: input.diagnostic.tailShape,
    currentNode: input.diagnostic.currentNode ?? null,
    currentNodeStatus: input.diagnostic.currentNodeStatus ?? null,
    currentNodeEndTurn: input.diagnostic.currentNodeEndTurn ?? null,
    headState: input.diagnostic.headState,
    offHeadSameTurnMessageCount: input.diagnostic.offHeadSameTurnMessageCount,
    hasFinal: input.diagnostic.hasFinal,
    hasReasoningEnded: input.diagnostic.hasReasoningEnded,
    assistantToolCalls: input.diagnostic.assistantToolCalls,
    toolResults: input.diagnostic.toolResults,
    nodeCount: input.diagnostic.nodeCount,
    activeObserved: activeIds.length,
    activeConversationIds: activeIds,
    safetyReview: null,
  }
}

export function buildCatalogObservationTrace(input: {
  at: number
  conversationId: string
  asyncStatus: number | string | null
  classifiedState: 'active' | 'complete'
  reason: string
  wasCatalogActive: boolean
  reliableActiveAfterIds: Iterable<string>
  catalogActiveAfterIds: Iterable<string>
}): CatalogObservationTrace {
  const reliableAfter = sortedConversationIds(input.reliableActiveAfterIds)
  const catalogAfter = sortedConversationIds(input.catalogActiveAfterIds)
  return {
    version: 1,
    at: input.at,
    kind: 'catalog-observation',
    conversationId: input.conversationId,
    asyncStatus: input.asyncStatus,
    classifiedState: input.classifiedState,
    reason: input.reason,
    wasCatalogActive: input.wasCatalogActive,
    reliableActiveAfter: reliableAfter.length,
    reliableActiveConversationIdsAfter: reliableAfter,
    catalogActiveAfter: catalogAfter.length,
    catalogActiveConversationIdsAfter: catalogAfter,
  }
}

/**
 * Phase 3 的本地 actor 可以直接看到 `/backend-api/f/conversation` 的 requestWillBeSent，
 * 因而这比账户级 WSS/catalog 更接近“真实 turn start”。新聊天发出时 URL 还没有 UUID，
 * actor 会先在内存里保留 submittedAt，等同一个 document 路由到 `/c/<UUID>` 后再一次性落盘。
 */
export function buildActorSubmitTrace(input: {
  submittedAt: number
  boundAt: number
  conversationId: string
  actorTargetId: string
  mode?: 'new' | 'continue' | 'steer'
  targetMode?: 'guardian' | 'dedicated'
  navigationMode?: 'already-there' | 'spa-new' | 'spa-project' | 'spa-conversation' | 'full-fallback'
  cdpRequestId: string
  prepareRequestId?: string | null
  prepareStatus?: number | null
  sendHandlerAttempts?: number
  responseStatus?: number | null
  responseMimeType?: string | null
  pageUrlBefore: string
  contextReadyAt?: number | null
  firstDataAt?: number | null
  runningConfirmed?: boolean
}): ActorSubmitTrace {
  return {
    version: 1,
    at: input.submittedAt,
    kind: 'actor-submit',
    conversationId: input.conversationId,
    actorTargetId: input.actorTargetId,
    ...(input.mode ? { mode: input.mode } : {}),
    ...(input.targetMode ? { targetMode: input.targetMode } : {}),
    ...(input.navigationMode ? { navigationMode: input.navigationMode } : {}),
    prepareRequestId: input.prepareRequestId ?? null,
    prepareStatus: input.prepareStatus ?? null,
    sendHandlerAttempts: input.sendHandlerAttempts ?? 1,
    cdpRequestId: input.cdpRequestId,
    responseStatus: input.responseStatus ?? null,
    responseMimeType: input.responseMimeType ?? null,
    boundAt: input.boundAt,
    bindDelayMs: Math.max(0, input.boundAt - input.submittedAt),
    pageUrlBefore: input.pageUrlBefore,
    ...(input.contextReadyAt !== undefined ? { contextReadyAt: input.contextReadyAt } : {}),
    ...(input.firstDataAt !== undefined ? { firstDataAt: input.firstDataAt } : {}),
    ...(input.runningConfirmed !== undefined ? { runningConfirmed: input.runningConfirmed } : {}),
  }
}

/**
 * 极薄的 NDJSON writer。
 *
 * append 由 daemon 顺序/低频调用；WSS 回调会 fire-and-forget，但 Node 的 appendFile 每次都是
 * 完整的一行原子追加，不在内存里长期缓存事故证据。目录创建只做一次。
 */
export class ActiveTurnRecorder {
  readonly filePath: string
  private readonly ready: Promise<void>
  private writeTail: Promise<void>

  constructor(filePath: string) {
    this.filePath = filePath
    this.ready = fs.mkdir(path.dirname(filePath), { recursive: true }).then(() => undefined)
    this.writeTail = this.ready
  }

  append(record: ActiveTurnTrace): Promise<void> {
    const line = `${JSON.stringify(record)}\n`
    // WSS / SSE 回调会 fire-and-forget 并发调用 append。多个 fs.appendFile 虽然各自追加整行，
    // 但 Promise 完成/内核排队顺序不保证与 emit 顺序完全一致；forensic trace 必须严格保序。
    // 用单条 Promise tail 串行化所有 writer，同时让一次失败只拒绝自己的 append，不把队列毒死。
    const write = this.writeTail.then(() => fs.appendFile(this.filePath, line))
    this.writeTail = write.catch(() => undefined)
    return write
  }
}

