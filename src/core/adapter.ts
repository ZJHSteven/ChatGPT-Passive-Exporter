import type {
  CanonicalConversation,
  CanonicalMessage,
  CanonicalRole,
  MappingConversationPayload,
  MessagesConversationPayload,
  RawChatMessage,
  RawConversationPayload,
} from './types'

/**
 * 判断捕获到的对象是不是“值得作为 conversation 保存”的响应。
 *
 * 这里故意使用结构特征而不是固定 URL：URL 仍由 capture 层做第一道白名单，
 * adapter 再验证正文至少含 `messages[]` 或 `mapping{}`，避免误把侧边栏列表、
 * feature flags 等其他 ChatGPT JSON 当成聊天正文。
 */
export function isConversationPayload(value: unknown): value is RawConversationPayload {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return Array.isArray(record.messages)
    || Boolean(record.mapping && typeof record.mapping === 'object' && !Array.isArray(record.mapping))
}

function normalizeRole(role: unknown): CanonicalRole {
  if (role === 'user' || role === 'assistant' || role === 'tool' || role === 'system') return role
  return 'unknown'
}

/**
 * 将 ChatGPT 多种 content shape 转成“供检索/Markdown 使用”的纯文本。
 * 富媒体对象不会在这里强行 stringify；它们会由 manifest 单独保留原始结构。
 */
export function extractMessageText(message: RawChatMessage): string {
  const content = message.content
  if (!content) return ''

  if (typeof content.text === 'string') return content.text

  if (Array.isArray(content.parts)) {
    return content.parts
      .filter((part): part is string => typeof part === 'string')
      .join('\n')
  }

  // reasoning_recap 等新类型有时把正文放在 `content` 字段；宽松兼容但不影响默认导出过滤。
  const embedded = (content as Record<string, unknown>).content
  return typeof embedded === 'string' ? embedded : ''
}

function canonicalizeMessage(message: RawChatMessage, fallbackId: string): CanonicalMessage {
  const metadata = message.metadata && typeof message.metadata === 'object' ? message.metadata : {}
  return {
    id: typeof message.id === 'string' ? message.id : fallbackId,
    role: normalizeRole(message.author?.role),
    authorName: message.author?.name ?? undefined,
    recipient: typeof message.recipient === 'string' ? message.recipient : 'all',
    channel: message.channel,
    contentType: typeof message.content?.content_type === 'string' ? message.content.content_type : 'unknown',
    text: extractMessageText(message),
    hidden: metadata.is_visually_hidden_from_conversation === true,
    createTime: message.create_time,
    metadata,
    raw: message,
  }
}

/** 新式 `messages[]` 已按当前显示分支排序，因此不能再拿旧 mapping 的 parent 规则套它。 */
function fromMessages(payload: MessagesConversationPayload): CanonicalConversation {
  const messages = (payload.messages ?? []).map((message, index) => canonicalizeMessage(message, `message-${index}`))

  return {
    title: typeof payload.title === 'string' && payload.title ? payload.title : 'ChatGPT Conversation',
    conversationId: typeof payload.conversation_id === 'string' ? payload.conversation_id : undefined,
    currentNode: typeof payload.current_node === 'string' ? payload.current_node : undefined,
    sourceFormat: 'messages',
    messages,
    raw: payload,
  }
}

/**
 * 旧式 `mapping` 是树；只导出 `current_node` 所在分支。
 * 这与 ChatGPT Exporter 的经典行为一致，可避免“编辑后产生的兄弟分支”混入正文。
 */
function fromMapping(payload: MappingConversationPayload): CanonicalConversation {
  const mapping = payload.mapping ?? {}
  let nodeId = typeof payload.current_node === 'string' ? payload.current_node : undefined

  if (!nodeId) {
    nodeId = Object.values(mapping).find(node => !node.children?.length)?.id
  }

  const reverse: RawChatMessage[] = []
  const visited = new Set<string>()

  while (nodeId && !visited.has(nodeId)) {
    visited.add(nodeId)
    const node = mapping[nodeId]
    if (!node) break
    if (node.message) reverse.push(node.message)
    nodeId = typeof node.parent === 'string' ? node.parent : undefined
  }

  reverse.reverse()

  return {
    title: typeof payload.title === 'string' && payload.title ? payload.title : 'ChatGPT Conversation',
    conversationId: typeof payload.conversation_id === 'string' ? payload.conversation_id : undefined,
    currentNode: typeof payload.current_node === 'string' ? payload.current_node : undefined,
    sourceFormat: 'mapping',
    messages: reverse.map((message, index) => canonicalizeMessage(message, `mapping-message-${index}`)),
    raw: payload,
  }
}

/** 唯一公开入口：后续所有 exporter 都只接受 canonical conversation。 */
export function adaptConversation(payload: unknown): CanonicalConversation {
  if (!isConversationPayload(payload)) throw new TypeError('捕获内容不是已支持的 ChatGPT conversation payload')
  return Array.isArray((payload as MessagesConversationPayload).messages)
    ? fromMessages(payload as MessagesConversationPayload)
    : fromMapping(payload as MappingConversationPayload)
}
