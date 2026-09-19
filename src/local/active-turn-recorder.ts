import fs from 'node:fs/promises'
import path from 'node:path'
import type { RunDiagnostic } from '../core/run-diagnostics'

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
  kind: 'wss-lifecycle' | 'body-snapshot' | 'catalog-observation'
  conversationId: string
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

export type ActiveTurnTrace = WssLifecycleTrace | BodySnapshotTrace | CatalogObservationTrace

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
 * 极薄的 NDJSON writer。
 *
 * append 由 daemon 顺序/低频调用；WSS 回调会 fire-and-forget，但 Node 的 appendFile 每次都是
 * 完整的一行原子追加，不在内存里长期缓存事故证据。目录创建只做一次。
 */
export class ActiveTurnRecorder {
  readonly filePath: string
  private readonly ready: Promise<void>

  constructor(filePath: string) {
    this.filePath = filePath
    this.ready = fs.mkdir(path.dirname(filePath), { recursive: true }).then(() => undefined)
  }

  async append(record: ActiveTurnTrace): Promise<void> {
    await this.ready
    await fs.appendFile(this.filePath, `${JSON.stringify(record)}\n`)
  }
}

