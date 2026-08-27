import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { adaptConversation } from '../src/core/adapter'
import { buildRichManifest } from '../src/core/manifest'
import { conversationToMarkdown } from '../src/core/markdown'

/**
 * 本机真实复杂样本契约。
 *
 * 这个文件本身不把私人聊天复制进新仓库；开发机存在 Travel 项目时跑真实 integration test，
 * 公共 CI 没有该私有 fixture 时自动跳过。另有 synthetic 单测负责公共 CI 的基础覆盖。
 */
const fixturePath = path.resolve(
  process.cwd(),
  '../Travel/三峡/archive/raw/chatgpt-tourism-main.json',
)
const describeReal = fs.existsSync(fixturePath) ? describe : describe.skip

describeReal('真实样本：旅游插件与平台比较', () => {
  const raw = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as unknown
  const conversation = adaptConversation(raw)
  const manifest = buildRichManifest(conversation)

  test('识别 2026 messages[] 会话结构', () => {
    expect(conversation.title).toBe('旅游插件与平台比较')
    expect(conversation.sourceFormat).toBe('messages')
    expect(conversation.messages).toHaveLength(129)

    const roleCounts = Object.groupBy(conversation.messages, message => message.role)
    expect(roleCounts.user).toHaveLength(3)
    expect(roleCounts.assistant).toHaveLength(71)
    expect(roleCounts.tool).toHaveLength(45)
    expect(roleCounts.system).toHaveLength(10)
  })

  test('默认 Markdown 恢复为 3 轮 You + ChatGPT，而不是 129 个内部节点', () => {
    const markdown = conversationToMarkdown(conversation)
    expect(markdown.match(/^#### You:$/gmu)).toHaveLength(3)
    expect(markdown.match(/^#### ChatGPT:$/gmu)).toHaveLength(3)
    expect(markdown).not.toContain('#### Tool')
    expect(markdown).not.toContain('reasoning_recap')
  })

  test('富媒体清单识别 Web、Connector、图片、Widget 与生成文件', () => {
    const byKind = Object.groupBy(manifest.items, item => item.kind)

    expect(byKind['image-group']).toHaveLength(5)
    expect(byKind.widget).toHaveLength(1)
    expect(byKind['sandbox-file']).toHaveLength(7)
    expect(byKind['app-connector']).toHaveLength(5)
    expect(byKind['tool-call']).toHaveLength(34)

    const appLabels = byKind['app-connector']?.map(item => item.label) ?? []
    expect(appLabels.filter(label => label === 'Trip.com')).toHaveLength(2)

    const files = byKind['sandbox-file']?.map(item => item.label) ?? []
    expect(files.some(file => file.endsWith('Travel_ThreeGorges_v0.1.zip'))).toBe(true)
    expect(files.some(file => file.endsWith('three_gorges.sqlite'))).toBe(true)
  })
})
