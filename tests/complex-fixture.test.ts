import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { adaptConversation } from '../src/core/adapter'
import { buildPortableArchive } from '../src/core/archive'
import { buildRichManifest } from '../src/core/manifest'
import { conversationToMarkdown } from '../src/core/markdown'

/**
 * 公共 CI 使用的脱敏复杂 fixture。
 * 它不是用户真实聊天，但刻意保留当前 ChatGPT 最容易让导出器坏掉的结构：
 * commentary/final continuation、tool call/result、Web metadata、App Connector、
 * image_group、client_defined_widget、sandbox 文件以及隐藏 thoughts。
 */
const fixture = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), 'tests/fixtures/complex-messages.json'), 'utf8'),
) as unknown

describe('脱敏复杂 messages[] fixture', () => {
  const conversation = adaptConversation(fixture)
  const manifest = buildRichManifest(conversation)

  test('统一模型保留完整内部节点', () => {
    expect(conversation.sourceFormat).toBe('messages')
    expect(conversation.conversationId).toBe('fixture-conversation')
    expect(conversation.messages).toHaveLength(9)
  })

  test('默认 Markdown 只输出一轮用户和一轮合并后的助手正文', () => {
    const markdown = conversationToMarkdown(conversation)
    expect(markdown.match(/^#### You:$/gmu)).toHaveLength(1)
    expect(markdown.match(/^#### ChatGPT:$/gmu)).toHaveLength(1)
    expect(markdown).toContain('I will inspect the available sources.')
    expect(markdown).toContain('Here is the result.')
    expect(markdown).not.toContain('hidden')
    expect(markdown).not.toContain('api_tool.call_tool')
  })

  test('manifest 将富内容分层归档', () => {
    const byKind = Object.groupBy(manifest.items, item => item.kind)
    expect(byKind['web-search']).toHaveLength(1)
    expect(byKind['app-connector']).toHaveLength(1)
    expect(byKind['image-group']).toHaveLength(1)
    expect(byKind.widget).toHaveLength(1)
    expect(byKind['sandbox-file']).toHaveLength(1)
    expect(byKind['tool-call']).toHaveLength(2)
    expect(byKind['app-connector']?.[0]?.label).toBe('Trip.com')
  })

  test('安全 archive 不复制原始工具正文', () => {
    const archive = buildPortableArchive(conversation)
    const serialized = JSON.stringify(archive)
    expect(serialized).toContain('fixture-conversation')
    expect(serialized).not.toContain('"tool":"search"')
  })
})
