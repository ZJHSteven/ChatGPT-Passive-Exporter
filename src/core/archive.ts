import { buildRichManifest } from './manifest'
import type { CanonicalConversation, CanonicalMessage } from './types'

/**
 * 默认 JSON 归档不是“私有 API 原样转存”。
 * 原始 tool metadata 中可能包含 session/subject/organization 等运行时标识，Connector
 * 正文也可能非常大。为了让日常导出文件更安全、稳定，这里只输出 canonical 的可读字段
 * + rich manifest。真正 raw payload 将来单独放在“高级/原始导出”入口，并明确警告。
 */
function portableMessage(message: CanonicalMessage): Record<string, unknown> {
  const metadata: Record<string, unknown> = {}

  // 只保留对模型/回答审计有意义、且不属于认证凭据的字段。
  for (const key of [
    'request_id',
    'turn_exchange_id',
    'working_turn_id',
    'model_slug',
    'default_model_slug',
    'resolved_model_slug',
    'thinking_effort',
    'finish_details',
    'reasoning_status',
    'reasoning_title',
    'finished_duration_sec',
    'content_references',
    'citations',
    'search_result_groups',
    'invoked_resource',
  ]) {
    if (key in message.metadata) metadata[key] = message.metadata[key]
  }

  const isToolPayload = message.role === 'tool' || message.recipient !== 'all'

  return {
    id: message.id,
    role: message.role,
    authorName: message.authorName,
    recipient: message.recipient,
    channel: message.channel,
    contentType: message.contentType,
    // 默认 JSON 也不复制工具正文；工具清单仍能看到“调用了什么”。
    text: isToolPayload ? undefined : message.text,
    toolPayloadOmitted: isToolPayload && message.text.length > 0 ? true : undefined,
    hidden: message.hidden,
    createTime: message.createTime,
    metadata,
  }
}

export function buildPortableArchive(conversation: CanonicalConversation): Record<string, unknown> {
  return {
    format: 'chatgpt-passive-exporter/archive-v1',
    title: conversation.title,
    conversationId: conversation.conversationId,
    currentNode: conversation.currentNode,
    sourceFormat: conversation.sourceFormat,
    exportedAt: new Date().toISOString(),
    messages: conversation.messages.map(portableMessage),
    richManifest: buildRichManifest(conversation),
  }
}
