/**
 * 导出器内部使用的稳定数据模型。
 *
 * ChatGPT Web 的私有响应结构会变化：旧接口常见 `mapping` 树，新接口已经出现
 * 有序 `messages[]`。如果 renderer 直接依赖这些私有字段，每次后端改版都会牵连
 * Markdown、JSON、附件下载和 UI。这里故意只保留导出所需的最小公共语义，
 * 让“后端格式变化”尽量只影响 adapter。
 */

export type CanonicalRole = 'user' | 'assistant' | 'tool' | 'system' | 'unknown'

/** 原始 ChatGPT 消息只做宽松描述；未知字段必须允许透传，而不是因为新字段直接崩溃。 */
export interface RawChatMessage {
  id?: string
  author?: {
    role?: string
    name?: string | null
  }
  content?: Record<string, unknown> & {
    content_type?: string
    parts?: unknown[]
    text?: string
  }
  metadata?: Record<string, unknown>
  recipient?: string
  channel?: string | null
  create_time?: number | null
  update_time?: number | null
  [key: string]: unknown
}

/** 新式 plural conversation 响应。 */
export interface MessagesConversationPayload {
  title?: string
  conversation_id?: string
  current_node?: string
  messages?: RawChatMessage[]
  page_info?: {
    has_previous_page?: boolean
    has_next_page?: boolean
    [key: string]: unknown
  }
  [key: string]: unknown
}

/** 旧式 singular conversation 响应中的树节点。 */
export interface MappingNode {
  id?: string
  parent?: string | null
  children?: string[]
  message?: RawChatMessage | null
  [key: string]: unknown
}

export interface MappingConversationPayload {
  title?: string
  conversation_id?: string
  current_node?: string
  mapping?: Record<string, MappingNode>
  [key: string]: unknown
}

export type RawConversationPayload = MessagesConversationPayload | MappingConversationPayload

/**
 * canonical message 仍保留 `raw` 引用。
 * 默认可读 Markdown 不会使用它，但 rich manifest 和未来兼容新 UI 类型时可以回看原字段。
 */
export interface CanonicalMessage {
  id: string
  role: CanonicalRole
  authorName?: string
  recipient: string
  channel?: string | null
  contentType: string
  text: string
  hidden: boolean
  createTime?: number | null
  metadata: Record<string, unknown>
  raw: RawChatMessage
}

export interface CanonicalConversation {
  title: string
  conversationId?: string
  currentNode?: string
  sourceFormat: 'messages' | 'mapping'
  messages: CanonicalMessage[]
  raw: RawConversationPayload
}

/** 富媒体/工具审计清单中的统一条目。 */
export interface RichManifestItem {
  kind: 'web-search' | 'app-connector' | 'image-group' | 'widget' | 'sandbox-file' | 'asset-pointer' | 'image-asset' | 'generated-image' | 'tool-call'
  messageId: string
  label: string
  data: unknown
}

export interface RichManifest {
  conversationId?: string
  title: string
  items: RichManifestItem[]
}

/** 页面 MAIN world 与 isolated content script 之间只传这一种消息。 */
export interface PassiveCaptureEnvelope {
  protocol: 'chatgpt-passive-exporter/v1'
  capturedAt: number
  url: string
  transport: 'fetch' | 'xhr'
  payload: unknown
}
