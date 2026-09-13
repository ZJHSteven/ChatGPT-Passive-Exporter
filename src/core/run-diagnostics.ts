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
  | 'tool-result-returned'
  | 'other'

export interface RunDiagnostic {
  conversationId?: string
  currentNode?: string
  turnExchangeId?: string
  requestId?: string
  userMessageId?: string
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

function latestTurn(messages: RawChatMessage[]): RawChatMessage[] {
  let lastUserIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (roleOf(messages[index]!) === 'user') {
      lastUserIndex = index
      break
    }
  }
  return lastUserIndex >= 0 ? messages.slice(lastUserIndex) : messages
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
  else if (
    lastAssistantToolIndex >= 0
    && !hasToolResultAfterLastCall
    && lastAssistantToolIndex > lastReasoningActiveIndex
  ) tailShape = 'tool-call-open'
  else if (
    lastReasoningActiveIndex >= 0
    && lastReasoningActiveIndex > lastReasoningEndedIndex
    && lastReasoningActiveIndex > lastToolResultIndex
    && lastReasoningActiveIndex > lastAssistantToolIndex
  ) tailShape = 'reasoning-open'
  else if (
    lastAssistantToolIndex >= 0
    && hasToolResultAfterLastCall
    && lastToolResultIndex > lastReasoningActiveIndex
  ) tailShape = 'tool-result-returned'

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
  else if (tailShape === 'tool-result-returned') {
    summary = '最新工具结果已经回来，但当前 payload 尚无明确终止证据；仍需服务器状态确认是否继续运行。'
  }

  const representative = last ?? user

  return {
    conversationId: typeof payload.conversation_id === 'string' ? payload.conversation_id : undefined,
    currentNode: typeof payload.current_node === 'string' ? payload.current_node : undefined,
    turnExchangeId: [...turn].reverse().map(turnExchangeIdOf).find(Boolean),
    requestId: [...turn].reverse().map(requestIdOf).find(Boolean),
    userMessageId: typeof user?.id === 'string' ? user.id : undefined,
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
