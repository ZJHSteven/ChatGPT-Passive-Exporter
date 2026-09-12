import type {
  MappingConversationPayload,
  MessagesConversationPayload,
  PassiveCaptureEnvelope,
  RawChatMessage,
  RawConversationPayload,
} from './types'

/**
 * Conversation snapshot 的完整性结论。
 *
 * ChatGPT Web 会对同一个 `/backend-api/conversations/<id>` 发出不同粒度的请求：
 * 有时是完整正文，有时只是 `num_turns=2` 一类尾部窗口。过去 Exporter 只保存一个
 * `latest` 指针，导致“最后收到的 partial payload”覆盖了之前的完整 snapshot，随后
 * Markdown/JSON 就只剩最后一两轮。
 *
 * 这里把“拿到了 conversation JSON”和“拿到了完整 conversation”明确拆开：
 * - `complete`：可以直接用于完整导出；
 * - `partial`：已经明确缺少更早历史；
 * - `unknown`：没有足够分页元数据证明完整，完整导出时必须主动补取/回退。
 */
export type SnapshotCompleteness = 'complete' | 'partial' | 'unknown'

export interface SnapshotAssessment {
  conversationId?: string
  messageCount: number
  completeness: SnapshotCompleteness
  reason: string
}

function messageCount(payload: RawConversationPayload): number {
  if (Array.isArray((payload as MessagesConversationPayload).messages)) {
    return (payload as MessagesConversationPayload).messages?.length ?? 0
  }
  const mapping = (payload as MappingConversationPayload).mapping
  return mapping && typeof mapping === 'object' ? Object.keys(mapping).length : 0
}

export function conversationIdFromPayload(payload: RawConversationPayload): string | undefined {
  return typeof payload.conversation_id === 'string' && payload.conversation_id
    ? payload.conversation_id
    : undefined
}

/**
 * 判断 payload 本身是否足以证明完整。
 *
 * plural `messages[]`：
 * - `has_previous_page === true` 明确是 partial；
 * - `has_previous_page === false` 明确覆盖到最早历史；
 * - 缺少 page_info 时不猜，返回 unknown。
 *
 * legacy singular `mapping`：当前 ChatGPT singular endpoint 的语义是整棵 conversation
 * mapping，adapter 再沿 current_node 取当前分支，因此把它视为完整 fallback。
 */
export function assessConversationPayload(payload: RawConversationPayload): SnapshotAssessment {
  const id = conversationIdFromPayload(payload)
  const count = messageCount(payload)

  if (Array.isArray((payload as MessagesConversationPayload).messages)) {
    const pageInfo = (payload as MessagesConversationPayload).page_info
    if (pageInfo?.has_previous_page === true) {
      return {
        conversationId: id,
        messageCount: count,
        completeness: 'partial',
        reason: 'plural payload 明确标记 has_previous_page=true，前面仍有历史。',
      }
    }
    if (pageInfo?.has_previous_page === false) {
      return {
        conversationId: id,
        messageCount: count,
        completeness: 'complete',
        reason: 'plural payload 明确标记 has_previous_page=false，已覆盖到最早历史。',
      }
    }
    return {
      conversationId: id,
      messageCount: count,
      completeness: 'unknown',
      reason: 'plural payload 缺少 has_previous_page，无法证明完整。',
    }
  }

  const mapping = (payload as MappingConversationPayload).mapping
  if (mapping && typeof mapping === 'object') {
    return {
      conversationId: id,
      messageCount: count,
      completeness: 'complete',
      reason: 'legacy singular mapping 作为完整 conversation fallback。',
    }
  }

  return {
    conversationId: id,
    messageCount: count,
    completeness: 'unknown',
    reason: '未知 conversation payload 形态。',
  }
}

/** 从被动捕获 envelope 补充 URL 中的 conversation id。 */
export function assessPassiveEnvelope(envelope: PassiveCaptureEnvelope): SnapshotAssessment {
  const payload = envelope.payload as RawConversationPayload
  const assessed = assessConversationPayload(payload)
  if (assessed.conversationId) return assessed

  try {
    const url = new URL(envelope.url, location.href)
    const id = url.pathname.match(/^\/backend-api\/conversations?\/([^/?#]+)/u)?.[1]
    return { ...assessed, conversationId: id }
  }
  catch {
    return assessed
  }
}

/**
 * 同一 conversation 多次被动捕获时选择“更值得保留”的 snapshot。
 * 完整性优先级永远高于时间：旧的完整 snapshot 不能被新的 2-turn partial 覆盖。
 * 同一完整性等级下，再保留消息更多的；最后才以 capturedAt 决胜。
 */
export function preferPassiveSnapshot(
  current: PassiveCaptureEnvelope | undefined,
  incoming: PassiveCaptureEnvelope,
): PassiveCaptureEnvelope {
  if (!current) return incoming

  const rank: Record<SnapshotCompleteness, number> = { complete: 2, unknown: 1, partial: 0 }
  const a = assessPassiveEnvelope(current)
  const b = assessPassiveEnvelope(incoming)
  if (rank[b.completeness] !== rank[a.completeness]) {
    return rank[b.completeness] > rank[a.completeness] ? incoming : current
  }
  if (b.messageCount !== a.messageCount) return b.messageCount > a.messageCount ? incoming : current
  return incoming.capturedAt >= current.capturedAt ? incoming : current
}

/**
 * 把 modern plural cursor 分页重新拼成一个可交给现有 adapter/exporter 的完整 messages payload。
 *
 * ChatGPT 当前分页方向是“最新页 → before cursor → 更老页”。调用方因此会把 pages 按
 * [latest, older-1, older-2, ...] 传入。这里反向遍历，恢复成旧→新的自然顺序；同一个
 * message id 如果跨页重叠，只保留更新方向更靠后的那份（也就是更接近 latest 的 snapshot）。
 * 没有 id 的未知消息不擅自丢弃，而用页序号+行序号作为内部去重 key 保留。
 */
export function mergePluralConversationPages(
  pagesNewestToOldest: MessagesConversationPayload[],
): MessagesConversationPayload {
  if (pagesNewestToOldest.length === 0) throw new Error('Cannot merge zero plural conversation pages')

  const latest = pagesNewestToOldest[0]
  const orderedKeys: string[] = []
  const byKey = new Map<string, RawChatMessage>()

  for (let reverseIndex = pagesNewestToOldest.length - 1; reverseIndex >= 0; reverseIndex -= 1) {
    const page = pagesNewestToOldest[reverseIndex]
    const messages = Array.isArray(page.messages) ? page.messages : []
    messages.forEach((message, messageIndex) => {
      const key = typeof message.id === 'string' && message.id
        ? `id:${message.id}`
        : `anonymous:${reverseIndex}:${messageIndex}`
      if (!byKey.has(key)) orderedKeys.push(key)
      byKey.set(key, message)
    })
  }

  const oldest = pagesNewestToOldest.at(-1) ?? latest
  const latestPageInfo = latest.page_info ?? {}
  const oldestPageInfo = oldest.page_info ?? {}
  return {
    ...latest,
    messages: orderedKeys.map(key => byKey.get(key)!).filter(Boolean),
    page_info: {
      ...latestPageInfo,
      has_previous_page: false,
      start_cursor: oldestPageInfo.start_cursor ?? latestPageInfo.start_cursor,
      end_cursor: latestPageInfo.end_cursor ?? oldestPageInfo.end_cursor,
      has_next_page: false,
    },
  }
}

