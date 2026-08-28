import type { RawChatMessage, RawConversationPayload } from './types'

/**
 * 一轮 ChatGPT Agent run 的离线诊断结果。
 *
 * 这里故意只使用 conversation payload 中已经持久化的字段，不依赖网页 DOM。
 * 好处是：哪怕手机/网页 UI 仍错误地显示“正在思考”，只要再次加载到这条会话，
 * 我们就能根据服务端已经保存的 finish_details / reasoning_status / tool message
 * 判断这一轮实际上是正常结束、被客户端中止，还是死在 tool call 后没有 result。
 */
export type RunOutcome =
  | 'complete'
  | 'client-stopped'
  | 'interrupted'
  | 'tool-result-missing'
  | 'reasoning-incomplete'
  | 'unknown'

export interface RunDiagnostic {
  outcome: RunOutcome
  conversationId?: string
  currentNode?: string
  turnExchangeId?: string
  requestId?: string
  userMessageId?: string
  lastMessageId?: string
  lastRole?: string
  lastContentType?: string
  lastRecipient?: string
  interruptedReason?: string
  hasFinal: boolean
  hasReasoningEnded: boolean
  assistantToolCalls: number
  toolResults: number
  nodeCount: number
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

  // 当前 Web payload 的最终可见回答通常使用 stop token 200002。
  // 不能把这个 token 当唯一契约，所以它只作为 channel 缺失时的兼容 fallback。
  const finish = finishDetailsOf(message)
  const stopTokens = Array.isArray(finish?.stop_tokens) ? finish.stop_tokens : []
  return stopTokens.includes(200002)
}

function isAssistantToolCall(message: RawChatMessage): boolean {
  if (roleOf(message) !== 'assistant') return false
  const recipient = typeof message.recipient === 'string' ? message.recipient : 'all'
  if (recipient === 'all') return false

  // 工具调用在新式 payload 里通常是 code；但 recipient 比 content_type 更稳定，
  // 因为 web.run/api_tool 等不同工具的 content 表示曾发生过变化。
  return true
}

function isToolResult(message: RawChatMessage): boolean {
  return roleOf(message) === 'tool'
}

/**
 * 兼容新式 `messages[]` 和 legacy `mapping`，提取当前可见分支/顺序中的消息。
 * legacy mapping 只沿 current_node 向 parent 回溯，避免把历史重试分支混进同一轮诊断。
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
 * 对 conversation 当前最后一轮做后验诊断。
 *
 * 判定优先级非常重要：
 * 1. 明确 `finish_details.type=interrupted` 最可信；
 * 2. 有 final 就视为完成；
 * 3. 最后停在 assistant→tool 且没有后续 tool result，视为 tool-result-missing；
 * 4. reasoning 只有 is_reasoning 而无 reasoning_ended，视为 reasoning-incomplete；
 * 5. 其余保持 unknown，不为了“给答案”而过度推断。
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

  const hasFinal = turn.some(isFinalAssistant)
  const hasReasoningEnded = turn.some(message => (
    reasoningStatusOf(message) === 'reasoning_ended'
    || contentTypeOf(message) === 'reasoning_recap'
  ))
  const hasReasoningActive = turn.some(message => reasoningStatusOf(message) === 'is_reasoning')
  const assistantToolCalls = turn.filter(isAssistantToolCall).length
  const toolResults = turn.filter(isToolResult).length

  const lastAssistantToolIndex = turn.findLastIndex(isAssistantToolCall)
  const hasToolResultAfterLastCall = lastAssistantToolIndex >= 0
    && turn.slice(lastAssistantToolIndex + 1).some(isToolResult)

  let outcome: RunOutcome = 'unknown'
  let summary = '最后一轮没有足够的持久化终止信息，暂时无法可靠归因。'
  const interruptedReason = typeof interrupted?.finish?.reason === 'string'
    ? interrupted.finish.reason
    : undefined

  if (interrupted) {
    if (interruptedReason === 'client_stopped') {
      outcome = 'client-stopped'
      summary = '最后一轮被客户端明确中止（client_stopped），不会自行继续。'
    }
    else {
      outcome = 'interrupted'
      summary = interruptedReason
        ? `最后一轮被中止：${interruptedReason}。`
        : '最后一轮被中止，但 payload 没有给出更具体原因。'
    }
  }
  else if (hasFinal) {
    outcome = 'complete'
    summary = '最后一轮已经产生 final answer，可视为正常完成。'
  }
  else if (lastAssistantToolIndex >= 0 && !hasToolResultAfterLastCall) {
    outcome = 'tool-result-missing'
    summary = '最后一轮停在工具调用之后，没有对应 tool result；很像工具已发出但回传/stream 丢失。'
  }
  else if (hasReasoningActive && !hasReasoningEnded) {
    outcome = 'reasoning-incomplete'
    summary = '最后一轮留下 is_reasoning，但没有 reasoning_ended/final，属于未完整收尾。'
  }

  const representative = last ?? user

  return {
    outcome,
    conversationId: typeof payload.conversation_id === 'string' ? payload.conversation_id : undefined,
    currentNode: typeof payload.current_node === 'string' ? payload.current_node : undefined,
    turnExchangeId: [...turn].reverse().map(turnExchangeIdOf).find(Boolean),
    requestId: [...turn].reverse().map(requestIdOf).find(Boolean),
    userMessageId: typeof user?.id === 'string' ? user.id : undefined,
    lastMessageId: typeof representative?.id === 'string' ? representative.id : undefined,
    lastRole: representative ? roleOf(representative) : undefined,
    lastContentType: representative ? contentTypeOf(representative) : undefined,
    lastRecipient: typeof representative?.recipient === 'string' ? representative.recipient : undefined,
    interruptedReason,
    hasFinal,
    hasReasoningEnded,
    assistantToolCalls,
    toolResults,
    nodeCount: turn.length,
    summary,
  }
}
