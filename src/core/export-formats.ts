import type { CanonicalConversation, CanonicalMessage } from './types.ts'

export interface ReadableExportOptions {
  includeReasoning?: boolean
}

function isReasoning(message: CanonicalMessage): boolean {
  return message.contentType === 'thoughts' || message.contentType === 'reasoning_recap'
}

function visibleMessages(conversation: CanonicalConversation, options: ReadableExportOptions): CanonicalMessage[] {
  return conversation.messages.filter((message) => {
    if (message.hidden || message.role === 'system') return false
    if (message.contentType === 'model_editable_context' || message.contentType === 'user_editable_context') return false
    if (isReasoning(message)) return options.includeReasoning === true
    if (message.recipient !== 'all' || message.role === 'tool') return false
    return message.role === 'user' || message.role === 'assistant'
  })
}

function mergeAssistantContinuations(messages: CanonicalMessage[]): CanonicalMessage[] {
  const output: CanonicalMessage[] = []
  for (const message of messages) {
    const previous = output.at(-1)
    const canMerge = previous?.role === 'assistant'
      && message.role === 'assistant'
      && previous.recipient === 'all'
      && message.recipient === 'all'
      && previous.contentType === 'text'
      && message.contentType === 'text'

    if (!canMerge) {
      output.push({ ...message })
      continue
    }

    previous.text += `${previous.channel !== message.channel ? '\n\n' : '\n'}${message.text}`
  }
  return output
}

function roleLabel(message: CanonicalMessage): string {
  if (message.role === 'user') return 'You'
  if (message.role === 'assistant') return 'ChatGPT'
  return message.authorName ?? message.role
}

export function conversationToPlainText(
  conversation: CanonicalConversation,
  options: ReadableExportOptions = {},
): string {
  const messages = mergeAssistantContinuations(visibleMessages(conversation, options))
  return [
    conversation.title,
    '',
    ...messages.flatMap(message => [`${roleLabel(message)}:`, message.text.trim(), '']),
  ].join('\n').trimEnd() + '\n'
}

function escapeHtml(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export function conversationToHtml(
  conversation: CanonicalConversation,
  options: ReadableExportOptions = {},
): string {
  const messages = mergeAssistantContinuations(visibleMessages(conversation, options))
  const body = messages.map(message => `
    <section class="message ${message.role}">
      <div class="role">${escapeHtml(roleLabel(message))}</div>
      <div class="content">${escapeHtml(message.text).replaceAll('\n', '<br>')}</div>
    </section>`).join('\n')

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(conversation.title)}</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { max-width: 860px; margin: 0 auto; padding: 32px 20px 64px; line-height: 1.65; }
    h1 { font-size: 1.65rem; margin: 0 0 28px; }
    .message { padding: 18px 0; border-top: 1px solid color-mix(in srgb, currentColor 14%, transparent); }
    .role { font-weight: 700; margin-bottom: 8px; }
    .content { white-space: normal; overflow-wrap: anywhere; }
    @media (max-width: 640px) { body { padding: 20px 16px 48px; } }
  </style>
</head>
<body>
  <h1>${escapeHtml(conversation.title)}</h1>
${body}
</body>
</html>
`
}
