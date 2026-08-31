import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { adaptConversation } from '../src/core/adapter'
import { conversationToHtml, conversationToPlainText } from '../src/core/export-formats'

const fixture = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), 'tests/fixtures/complex-messages.json'), 'utf8'),
) as unknown

describe('Companion 可读导出格式', () => {
  const conversation = adaptConversation(fixture)

  test('纯文本默认只保留用户与可见助手正文', () => {
    const text = conversationToPlainText(conversation)
    expect(text).toContain('You:')
    expect(text).toContain('ChatGPT:')
    expect(text).toContain('I will inspect the available sources.')
    expect(text).toContain('Here is the result.')
    expect(text).not.toContain('api_tool.call_tool')
    expect(text).not.toContain('hidden')
  })

  test('HTML 为独立可打开文档并转义模型 HTML', () => {
    let replaced = false
    const mutated = {
      ...conversation,
      messages: conversation.messages.map((message) => {
        if (!replaced && message.role === 'user' && !message.hidden) {
          replaced = true
          return { ...message, text: '<script>alert(1)</script> **hello**' }
        }
        return message
      }),
    }
    const html = conversationToHtml(mutated)
    expect(html).toContain('<!doctype html>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('ChatGPT')
  })
})
