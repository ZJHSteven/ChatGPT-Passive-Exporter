import { buildRichManifest } from './manifest'
import type { CanonicalConversation, CanonicalMessage } from './types'

const CITATION_MARKER_RE = /\uE200cite(?:\uE202[^\uE200\uE201]*)+\uE201/gu

export interface MarkdownExportOptions {
  /** 默认只导出 UI 可见的 User / Assistant 正文。 */
  includeReasoning?: boolean
  /** 工具模式主要用于调试/审计；默认关闭，避免数 MB 的 DevSpace 返回污染正文。 */
  includeTools?: boolean
  /** 工具正文可能含本地路径、命令输出甚至密钥；必须由用户明确打开。 */
  includeToolPayloads?: boolean
  /** 图片组、Web Search、App Connector、文件等以摘要附录保存。 */
  includeRichAppendix?: boolean
}

function getReferenceSources(reference: Record<string, unknown>): Array<Record<string, unknown>> {
  const sources: Array<Record<string, unknown>> = []
  const fields = ['items', 'sources', 'fallback_items'] as const

  for (const field of fields) {
    const value = reference[field]
    if (!Array.isArray(value)) continue
    for (const item of value) {
      if (item && typeof item === 'object') sources.push(item as Record<string, unknown>)
    }
  }

  return sources
}

function markdownLink(source: Record<string, unknown>): string | null {
  const title = typeof source.attribution === 'string' && source.attribution
    ? source.attribution
    : typeof source.title === 'string' && source.title
      ? source.title
      : typeof source.url === 'string'
        ? source.url
        : null
  const url = typeof source.url === 'string' ? source.url : null
  if (!title || !url) return null

  const escapedTitle = title.replaceAll('[', '\\[').replaceAll(']', '\\]').replaceAll('\n', ' ')
  const escapedUrl = url.replaceAll('<', '%3C').replaceAll('>', '%3E').replaceAll('\n', '')
  return `[${escapedTitle}](<${escapedUrl}>)`
}

/**
 * 将 ChatGPT 私有 UI citation marker 变成普通 Markdown 链接。
 * 这部分刻意沿用 pionxzh/chatgpt-exporter 的思路，而不是把 `cite...` 原样留在归档中。
 */
export function transformContentReferences(text: string, metadata: Record<string, unknown>): string {
  let output = text
    .replaceAll(/[\u00A0\u202F\u2007\u2060]/gu, ' ')
    .replaceAll(/[\u2010-\u2015\u2212]/gu, '-')
    .replaceAll(/[\uE203\uE204]/gu, '')

  const references = Array.isArray(metadata.content_references) ? metadata.content_references : []

  const normalRefs = references
    .filter((value): value is Record<string, unknown> => Boolean(value && typeof value === 'object'))
    .filter(reference => reference.type !== 'sources_footnote')
    .sort((a, b) => String(b.matched_text ?? '').length - String(a.matched_text ?? '').length)

  for (const reference of normalRefs) {
    const matched = typeof reference.matched_text === 'string' ? reference.matched_text : ''
    if (!matched) continue

    const links = getReferenceSources(reference).map(markdownLink).filter((value): value is string => Boolean(value))
    const replacement = links.length > 0
      ? `(${[...new Set(links)].join(', ')})`
      : typeof reference.alt === 'string'
        ? reference.alt
        : ''
    output = output.replaceAll(matched, replacement)
  }

  output = output.replace(CITATION_MARKER_RE, '')

  const footnoteSources = references
    .filter((value): value is Record<string, unknown> => Boolean(value && typeof value === 'object'))
    .filter(reference => reference.type === 'sources_footnote')
    .flatMap(getReferenceSources)
    .map(markdownLink)
    .filter((value): value is string => Boolean(value))

  if (footnoteSources.length > 0) {
    const unique = [...new Set(footnoteSources)]
    output = `${output.trimEnd()}\n\n**来源:**\n\n${unique.map(source => `- ${source}`).join('\n')}`
  }

  return output
}

function isReasoning(message: CanonicalMessage): boolean {
  return message.contentType === 'thoughts' || message.contentType === 'reasoning_recap'
}

function isVisibleConversationMessage(message: CanonicalMessage, options: MarkdownExportOptions): boolean {
  if (message.hidden || message.role === 'system') return false
  if (message.contentType === 'model_editable_context' || message.contentType === 'user_editable_context') return false
  if (isReasoning(message)) return options.includeReasoning === true

  if (message.role === 'tool' || message.recipient !== 'all') return options.includeTools === true
  return message.role === 'user' || message.role === 'assistant'
}

/**
 * commentary/final 在原始 JSON 中可能是多个连续 assistant 节点；UI 里用户把它看成一轮回答。
 * 默认导出也应合并，避免出现几十个连续 “ChatGPT:” 小节。
 */
function mergeAssistantContinuations(messages: CanonicalMessage[]): CanonicalMessage[] {
  const merged: CanonicalMessage[] = []

  for (const current of messages) {
    const previous = merged.at(-1)
    const canMerge = previous?.role === 'assistant'
      && current.role === 'assistant'
      && previous.recipient === 'all'
      && current.recipient === 'all'
      && previous.contentType === 'text'
      && current.contentType === 'text'

    if (!canMerge) {
      merged.push({ ...current, metadata: { ...current.metadata } })
      continue
    }

    const separator = previous.channel !== current.channel ? '\n\n' : '\n'
    previous.text += separator + current.text

    for (const key of ['citations', 'content_references']) {
      const left = previous.metadata[key]
      const right = current.metadata[key]
      if (Array.isArray(right)) {
        previous.metadata[key] = [...(Array.isArray(left) ? left : []), ...right]
      }
    }
  }

  return merged
}

function authorHeading(message: CanonicalMessage): string {
  if (message.role === 'user') return 'You'
  if (message.role === 'assistant') return 'ChatGPT'
  if (message.role === 'tool') return `Tool${message.authorName ? ` (${message.authorName})` : ''}`
  return message.role
}

function renderMessage(message: CanonicalMessage, options: MarkdownExportOptions): string {
  if ((message.role === 'tool' || message.recipient !== 'all') && options.includeToolPayloads !== true) {
    const direction = message.role === 'assistant' ? 'Tool call' : 'Tool result'
    return `#### ${direction}:\n\`${message.recipient === 'all' ? message.authorName ?? 'tool' : message.recipient}\`\n\n> Payload omitted by default.`
  }

  const body = message.role === 'assistant'
    ? transformContentReferences(message.text, message.metadata)
    : message.text
  return `#### ${authorHeading(message)}:\n${body}`
}

function renderRichAppendix(conversation: CanonicalConversation): string {
  const manifest = buildRichManifest(conversation)
  if (manifest.items.length === 0) return ''

  const counts = new Map<string, number>()
  for (const item of manifest.items) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1)

  const summary = [...counts.entries()].map(([kind, count]) => `- ${kind}: ${count}`).join('\n')
  const sandboxFiles = manifest.items
    .filter(item => item.kind === 'sandbox-file')
    .map(item => `- ${item.label}`)
    .join('\n')

  return [
    '## Rich content manifest',
    '',
    '> 此附录是结构摘要；完整结构请看 canonical/raw JSON。默认不展开 Connector/工具正文，以避免泄露会话运行时敏感字段。',
    '',
    summary,
    sandboxFiles ? `\n### Generated files\n\n${sandboxFiles}` : '',
  ].filter(Boolean).join('\n')
}

/** 输出与 ChatGPT Exporter 风格相近的 Markdown；默认最小、可读、稳定。 */
export function conversationToMarkdown(
  conversation: CanonicalConversation,
  options: MarkdownExportOptions = {},
): string {
  const selected = conversation.messages.filter(message => isVisibleConversationMessage(message, options))
  const merged = options.includeTools ? selected : mergeAssistantContinuations(selected)
  const main = merged.map(message => renderMessage(message, options)).join('\n\n')
  const appendix = options.includeRichAppendix ? renderRichAppendix(conversation) : ''

  return [
    `# ${conversation.title}`,
    '',
    main,
    appendix ? `\n${appendix}` : '',
  ].join('\n').replace(/\r\n?/g, '\n').trimEnd() + '\n'
}
