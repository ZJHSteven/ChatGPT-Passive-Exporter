import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { ChatArchiveDb } from '../src/local/archive-db.ts'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

function tempDb(): ChatArchiveDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-archive-test-'))
  tempDirs.push(dir)
  return new ChatArchiveDb(path.join(dir, 'archive.sqlite'))
}

function payload() {
  return {
    title: '三峡旅行研究',
    conversation_id: 'conversation-cn',
    current_node: 'a2',
    messages: [
      {
        id: 'u1',
        author: { role: 'user' },
        recipient: 'all',
        content: { content_type: 'text', parts: ['帮我研究长江三峡游轮和 Trip.com。'] },
        metadata: {},
      },
      {
        id: 'tool-call',
        author: { role: 'assistant' },
        recipient: 'web.run',
        content: { content_type: 'code', text: '{"query":"三峡"}' },
        metadata: {},
      },
      {
        id: 'a2',
        author: { role: 'assistant' },
        recipient: 'all',
        content: { content_type: 'text', parts: ['国庆期间可以比较三峡船期；Trip.com 用来补库存。'] },
        metadata: {
          content_references: [
            {
              type: 'image_group',
              layout: 'carousel',
              images: [{ image_ref_id: 'turn0image0' }],
            },
          ],
        },
      },
    ],
  }
}

describe('ChatArchiveDb', () => {
  test('导入 canonical conversation 并避免重复累计', () => {
    const db = tempDb()
    try {
      const first = db.importRaw(payload())
      expect(first.conversationId).toBe('conversation-cn')
      expect(first.messageCount).toBe(3)
      expect(first.visibleMessageCount).toBe(2)
      expect(first.resourceCount).toBeGreaterThan(0)

      db.importRaw(payload())
      expect(db.stats()).toMatchObject({
        conversationCount: 1,
        messageCount: 3,
        indexedMessageCount: 2,
        trigramIndexedMessageCount: 2,
      })
    }
    finally {
      db.close()
    }
  })

  test('中文两字短词走 fallback，长中文短语走 trigram，英文走 unicode FTS', () => {
    const db = tempDb()
    try {
      db.importRaw(payload())

      const shortCn = db.search('三峡')
      expect(shortCn.length).toBeGreaterThan(0)
      expect(shortCn.some(hit => hit.conversationId === 'conversation-cn')).toBe(true)

      const longCn = db.search('长江三峡')
      expect(longCn.length).toBeGreaterThan(0)
      expect(longCn[0]?.text).toContain('[长江三峡]')

      const english = db.search('Trip')
      expect(english.length).toBeGreaterThan(0)
      expect(english[0]?.text).toContain('[Trip]')
    }
    finally {
      db.close()
    }
  })

  test('只索引可读正文，但仍保存 tool/resource 审计层', () => {
    const db = tempDb()
    try {
      db.importRaw(payload())
      expect(db.search('query')).toHaveLength(0)
      expect(db.getMessages('conversation-cn')).toHaveLength(3)
      expect(db.getResources('conversation-cn').some(item => item.kind === 'tool-call')).toBe(true)
      expect(db.getResources('conversation-cn').some(item => item.kind === 'image-group')).toBe(true)
      expect(db.getMarkdown('conversation-cn')).toContain('#### You:')
    }
    finally {
      db.close()
    }
  })
})
