import type { RawChatMessage, RawConversationPayload } from './types'

/**
 * “生命状态证据”和“当前快照尾部形态”必须严格分开。
 *
 * 重要原则：
 * - final / finish_details=interrupted 属于终止证据；
 * - 最后停在 tool call、reasoning 仍 open 只描述“快照现在长什么样”，不能证明 run 已死；
 * - 实时是否仍在运行，需要结合 stream_status / 其它服务器侧状态判断。
 */
export type RunTerminalEvidence =
  | 'final'
  | 'client-stopped'
  | 'interrupted'
  | 'none'

export type RunTailShape =
  | 'final'
  | 'tool-call-open'
  | 'reasoning-open'
  | 'reasoning-ended-no-final'
  | 'tool-result-returned'
  | 'other'

export interface RunDiagnostic {
  conversationId?: string
  currentNode?: string
  turnExchangeId?: string
  requestId?: string
  userMessageId?: string
  userMessageCount?: number
  /**
   * 同一 turn_exchange_id / request_id 内出现多个 user message，表示运行中 steering/follow-up。
   * 这不是新的 turn 边界，也不能仅凭“后来没有 final”推断为异常终止。
   */
  hasInTurnSteering?: boolean
  lastMessageId?: string
  lastRole?: string
  lastContentType?: string
  lastRecipient?: string

  /** 只表示 payload 本身是否含明确“已终止”证据。 */
  terminalEvidence: RunTerminalEvidence
  interruptedReason?: string
  hasFinal: boolean
  hasReasoningEnded: boolean

  /** 只描述最新持久化快照的尾部，不推断存活/死亡。 */
  tailShape: RunTailShape
  assistantToolCalls: number
  toolResults: number
  nodeCount: number

  /** 面向 UI 的保守描述。 */
  summary: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null
}

function metadataOf(message: RawChatMessage): Record<string, unknown> {
  return asRecord(message.metadata) ?? {}
}

function contentTypeOf(message: RawChatMessage): string {
  return typeof message.content?.content_type === 'string' ? message.content.content_type : ''
}

function roleOf(message: RawChatMessage): string {
  return typeof message.author?.role === 'string' ? message.author.role : 'unknown'
}

function turnExchangeIdOf(message: RawChatMessage): string | undefined {
  const value = metadataOf(message).turn_exchange_id
  return typeof value === 'string' && value ? value : undefined
}

function requestIdOf(message: RawChatMessage): string | undefined {
  const value = metadataOf(message).request_id
  return typeof value === 'string' && value ? value : undefined
}

function finishDetailsOf(message: RawChatMessage): Record<string, unknown> | null {
  return asRecord(metadataOf(message).finish_details)
}

function reasoningStatusOf(message: RawChatMessage): string | undefined {
  const value = metadataOf(message).reasoning_status
  return typeof value === 'string' ? value : undefined
}

function isFinalAssistant(message: RawChatMessage): boolean {
  if (roleOf(message) !== 'assistant') return false
  if (message.channel === 'final') return true

  // 当前 Web payload 常用 200002 表示最终回答 stop token。
  // 它只是 channel 缺失时的兼容 fallback，不作为唯一契约。
  const finish = finishDetailsOf(message)
  const stopTokens = Array.isArray(finish?.stop_tokens) ? finish.stop_tokens : []
  return stopTokens.includes(200002)
}

function isAssistantToolCall(message: RawChatMessage): boolean {
  if (roleOf(message) !== 'assistant') return false
  const recipient = typeof message.recipient === 'string' ? message.recipient : 'all'
  return recipient !== 'all'
}

function isToolResult(message: RawChatMessage): boolean {
  return roleOf(message) === 'tool'
}

/**
 * 兼容新式 `messages[]` 和 legacy `mapping`，只取当前分支。
 */
function orderedMessages(payload: RawConversationPayload): RawChatMessage[] {
  if (Array.isArray(payload.messages)) return payload.messages

  const mapping = asRecord((payload as Record<string, unknown>).mapping)
  if (!mapping) return []

  const currentNode = typeof payload.current_node === 'string' ? payload.current_node : undefined
  if (!currentNode) return []

  const reversed: RawChatMessage[] = []
  const seen = new Set<string>()
  let nodeId: string | undefined = currentNode

  while (nodeId && !seen.has(nodeId)) {
    seen.add(nodeId)
    const node = asRecord(mapping[nodeId])
    if (!node) break

    const message = asRecord(node.message) as RawChatMessage | null
    if (message) reversed.push(message)

    const parent = node.parent
    nodeId = typeof parent === 'string' && parent ? parent : undefined
  }

  return reversed.reverse()
}

function requestIdOfMessage(message: RawChatMessage): string | undefined {
  return requestIdOf(message)
}

/**
 * 把页面中的消息切成真实的 turn。
 *
 * 2026-09-20 的真机样本证明：用户在模型仍运行时发送 follow-up/steering，新的 user message
 * 仍然可以沿用**同一个** `turn_exchange_id` 和 `request_id`。因此“看到 user 就开新 turn”会把
 * 一个正常 steering 错拆成两个 turn，并进一步制造假的 reasoning-ended-no-final incident。
 *
 * 边界优先级：
 * 1. `turn_exchange_id` 变化：第一方最明确的 turn 身份；
 * 2. 缺少 turn_exchange_id 时，`request_id` 变化；
 * 3. 两类协议 ID 都缺失时，才退回传统的 user-message 边界。
 */
function splitLogicalTurns(messages: RawChatMessage[]): RawChatMessage[][] {
  const turns: RawChatMessage[][] = []
  let current: RawChatMessage[] = []
  let currentTurnExchangeId: string | undefined
  let currentRequestId: string | undefined

  const flush = () => {
    if (current.length > 0) turns.push(current)
    current = []
    currentTurnExchangeId = undefined
    currentRequestId = undefined
  }

  for (const message of messages) {
    const messageTurnExchangeId = turnExchangeIdOf(message)
    const messageRequestId = requestIdOfMessage(message)

    const hasStableCurrentIdentity = Boolean(currentTurnExchangeId || currentRequestId)
    const sameStableIdentity = Boolean(
      (currentTurnExchangeId && messageTurnExchangeId === currentTurnExchangeId)
      || (!currentTurnExchangeId && currentRequestId && messageRequestId === currentRequestId),
    )
    const explicitlyDifferentIdentity = Boolean(
      (currentTurnExchangeId && messageTurnExchangeId && messageTurnExchangeId !== currentTurnExchangeId)
      || (!currentTurnExchangeId && currentRequestId && messageRequestId && messageRequestId !== currentRequestId),
    )
    const fallbackUserBoundary = roleOf(message) === 'user'
      && current.length > 0
      && !hasStableCurrentIdentity
      && !messageTurnExchangeId
      && !messageRequestId

    if (explicitlyDifferentIdentity || fallbackUserBoundary) flush()

    current.push(message)
    if (!currentTurnExchangeId && messageTurnExchangeId) currentTurnExchangeId = messageTurnExchangeId
    if (!currentRequestId && messageRequestId) currentRequestId = messageRequestId

    // 对带协议 ID 的消息，只有“明确不同”才切 turn；同 ID 的 user 就是 steering。
    // 无 ID 的 system/tool 辅助消息继续附着到当前 turn，不单独制造边界。
    void sameStableIdentity
  }
  flush()
  return turns
}

function latestTurn(messages: RawChatMessage[]): RawChatMessage[] {
  return splitLogicalTurns(messages).at(-1) ?? messages
}

/**
 * 把一个 conversation page 中可见的消息按 user 边界拆成多个 turn，并逐 turn 复用
 * `diagnoseLatestRun()` 做诊断。
 *
 * 重要：page/cursor 只是传输容器，不是运行状态单位。一个 `num_turns=10` 页面会天然
 * 包含多个 turn；一次漏同步后，最新页也可能同时包含“漏掉的旧 turn + 当前 turn”。
 * 因此 incident 必须消费这里返回的逐-turn 结果，而不能只看整页最后一轮。
 */
export function diagnoseRuns(payload: RawConversationPayload): RunDiagnostic[] {
  const messages = orderedMessages(payload)
  if (messages.length === 0) return []
  const turns = splitLogicalTurns(messages)

  return turns.map((turn, index) => {
    const lastMessageId = typeof turn.at(-1)?.id === 'string' ? turn.at(-1)!.id : undefined
    const currentNode = index === turns.length - 1 && typeof payload.current_node === 'string'
      ? payload.current_node
      : lastMessageId
    return diagnoseLatestRun({
      ...payload,
      messages: turn,
      current_node: currentNode,
    } as RawConversationPayload)
  })
}

/**
 * 对 conversation 当前最后一轮做“快照诊断”。
 *
 * 注意：这个函数不回答“它现在还活着吗”。它只回答：
 * 1. payload 里有没有明确终止证据？
 * 2. 最新持久化节点现在停在什么形态？
 *
 * 是否仍在运行必须交给 stream_status / 服务器状态层判断。
 */
export function diagnoseLatestRun(payload: RawConversationPayload): RunDiagnostic {
  const messages = orderedMessages(payload)
  const turn = latestTurn(messages)
  const last = turn.at(-1)
  const user = turn.find(message => roleOf(message) === 'user')
  const userMessageCount = turn.filter(message => roleOf(message) === 'user').length

  const interrupted = [...turn]
    .reverse()
    .map(message => ({ message, finish: finishDetailsOf(message) }))
    .find(item => item.finish?.type === 'interrupted')

  const interruptedReason = typeof interrupted?.finish?.reason === 'string'
    ? interrupted.finish.reason
    : undefined

  const hasFinal = turn.some(isFinalAssistant)
  const hasReasoningEnded = turn.some(message => (
    reasoningStatusOf(message) === 'reasoning_ended'
    || contentTypeOf(message) === 'reasoning_recap'
  ))
  const lastReasoningActiveIndex = turn.findLastIndex(message => reasoningStatusOf(message) === 'is_reasoning')
  const lastReasoningEndedIndex = turn.findLastIndex(message => (
    reasoningStatusOf(message) === 'reasoning_ended'
    || contentTypeOf(message) === 'reasoning_recap'
  ))
  const assistantToolCalls = turn.filter(isAssistantToolCall).length
  const toolResults = turn.filter(isToolResult).length

  const lastAssistantToolIndex = turn.findLastIndex(isAssistantToolCall)
  const lastToolResultIndex = turn.findLastIndex(isToolResult)
  const hasToolResultAfterLastCall = lastAssistantToolIndex >= 0
    && turn.slice(lastAssistantToolIndex + 1).some(isToolResult)

  let terminalEvidence: RunTerminalEvidence = 'none'
  if (interruptedReason === 'client_stopped') terminalEvidence = 'client-stopped'
  else if (interrupted) terminalEvidence = 'interrupted'
  else if (hasFinal) terminalEvidence = 'final'

  let tailShape: RunTailShape = 'other'
  if (hasFinal) tailShape = 'final'
  else {
    // 不再用一串“是否曾经出现过 X”的条件互相覆盖，而是只看这一 turn 最后一个真正具有
    // 运行语义的事件。这样 `reasoning → tool call → tool result` 一定归到 tool result；
    // `tool result → reasoning` 一定归到 reasoning；`reasoning_recap` 后没有 final 也能被单独识别。
    const lastSemanticIndex = Math.max(
      lastAssistantToolIndex,
      lastToolResultIndex,
      lastReasoningActiveIndex,
      lastReasoningEndedIndex,
    )
    if (lastSemanticIndex === lastAssistantToolIndex && lastAssistantToolIndex >= 0 && !hasToolResultAfterLastCall) {
      tailShape = 'tool-call-open'
    }
    else if (lastSemanticIndex === lastToolResultIndex && lastToolResultIndex >= 0) {
      tailShape = 'tool-result-returned'
    }
    else if (lastSemanticIndex === lastReasoningActiveIndex && lastReasoningActiveIndex >= 0) {
      tailShape = 'reasoning-open'
    }
    else if (lastSemanticIndex === lastReasoningEndedIndex && lastReasoningEndedIndex >= 0) {
      tailShape = 'reasoning-ended-no-final'
    }
  }

  let summary = '当前 payload 没有明确终止证据；仅凭这份快照不能判断 run 是否仍在执行。'
  if (terminalEvidence === 'final') {
    summary = 'payload 已包含 final answer，可确认这一轮已经正常完成。'
  }
  else if (terminalEvidence === 'client-stopped') {
    summary = 'payload 明确记录 client_stopped，可确认这一轮被客户端中止。'
  }
  else if (terminalEvidence === 'interrupted') {
    summary = interruptedReason
      ? `payload 明确记录 interrupted：${interruptedReason}。`
      : 'payload 明确记录 interrupted，但没有更具体原因。'
  }
  else if (tailShape === 'tool-call-open') {
    summary = '最新持久化节点停在 assistant→tool call，尚未看到对应 tool result；这可能只是工具仍在执行，不能据此判死。'
  }
  else if (tailShape === 'reasoning-open') {
    summary = '最新快照仍有 is_reasoning 且尚无 reasoning_ended/final；这可能只是模型仍在思考，不能据此判死。'
  }
  else if (tailShape === 'reasoning-ended-no-final') {
    summary = '最新运行语义已经到 reasoning_ended/reasoning_recap，但仍没有 final answer；这表示推理阶段已经收尾，正文终态仍缺失。'
  }
  else if (tailShape === 'tool-result-returned') {
    summary = '最新工具结果已经回来，但当前 payload 尚无明确终止证据；不能据此判死，仍需服务器状态确认是否继续运行。'
  }

  const representative = last ?? user

  return {
    conversationId: typeof payload.conversation_id === 'string' ? payload.conversation_id : undefined,
    currentNode: typeof payload.current_node === 'string' ? payload.current_node : undefined,
    turnExchangeId: [...turn].reverse().map(turnExchangeIdOf).find(Boolean),
    requestId: [...turn].reverse().map(requestIdOf).find(Boolean),
    userMessageId: typeof user?.id === 'string' ? user.id : undefined,
    userMessageCount,
    hasInTurnSteering: userMessageCount > 1,
    lastMessageId: typeof representative?.id === 'string' ? representative.id : undefined,
    lastRole: representative ? roleOf(representative) : undefined,
    lastContentType: representative ? contentTypeOf(representative) : undefined,
    lastRecipient: typeof representative?.recipient === 'string' ? representative.recipient : undefined,
    terminalEvidence,
    interruptedReason,
    hasFinal,
    hasReasoningEnded,
    tailShape,
    assistantToolCalls,
    toolResults,
    nodeCount: turn.length,
    summary,
  }
}
