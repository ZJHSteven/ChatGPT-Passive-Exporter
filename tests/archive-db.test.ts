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

  test('在线 messages[] 分页只做增量 merge，不会删除旧历史', () => {
    const db = tempDb()
    try {
      db.importRaw(payload())

      const live = {
        title: '三峡旅行研究',
        conversation_id: 'conversation-cn',
        current_node: 'a3',
        page_info: { has_previous_page: true, start_cursor: 'cursor-1' },
        messages: [
          {
            id: 'a2',
            author: { role: 'assistant' },
            recipient: 'all',
            channel: 'final',
            create_time: 2,
            content: { content_type: 'text', parts: ['国庆期间可以比较三峡船期；Trip.com 用来补库存。'] },
            metadata: {},
          },
          {
            id: 'u3',
            author: { role: 'user' },
            recipient: 'all',
            create_time: 3,
            content: { content_type: 'text', parts: ['继续比较重庆出发线路。'] },
            metadata: { turn_exchange_id: 'turn-2' },
          },
          {
            id: 'a3',
            author: { role: 'assistant' },
            recipient: 'all',
            channel: 'final',
            create_time: 4,
            content: { content_type: 'text', parts: ['重庆出发可以重点比较黄金系列。'] },
            metadata: { turn_exchange_id: 'turn-2' },
          },
        ],
      }

      const merged = db.mergeLiveMessagesPage(live, { observedAt: 1234, classifyTerminal: true })
      expect(merged.newMessageCount).toBe(2)
      expect(db.getMessages('conversation-cn').map(item => item.messageId)).toEqual(
        expect.arrayContaining(['u1', 'tool-call', 'a2', 'u3', 'a3']),
      )
      expect(db.search('重庆').some(hit => hit.conversationId === 'conversation-cn')).toBe(true)
      expect(db.db.prepare('SELECT count(*) AS n FROM live_observations').get()).toMatchObject({ n: 1 })
      expect(db.listIncidents({ status: 'open' })).toHaveLength(0)
    }
    finally {
      db.close()
    }
  })

  test('在线 plural 只记录 transport_parent_id，不把 metadata.parent_id 伪装成 mapping tree', () => {
    const db = tempDb()
    try {
      db.mergeLiveMessagesPage({
        title: 'Live branch fixture',
        conversation_id: 'branch-live',
        current_node: 'assistant-a',
        messages: [
          {
            id: 'user-root',
            author: { role: 'user' },
            recipient: 'all',
            content: { content_type: 'text', parts: ['原问题'] },
            metadata: {},
          },
          {
            id: 'assistant-a',
            author: { role: 'assistant' },
            recipient: 'all',
            channel: 'final',
            content: { content_type: 'text', parts: ['第一次回答'] },
            metadata: { parent_id: 'user-root' },
          },
        ],
      }, { observedAt: 1000 })

      // 第二次 observation 仍保留两个 live 节点，但 metadata.parent_id 只属于 transport 关联，
      // 不得据此制造 sibling tree；真正 sibling 要等 singular mapping 回填。
      db.mergeLiveMessagesPage({
        title: 'Live branch fixture',
        conversation_id: 'branch-live',
        current_node: 'assistant-b',
        messages: [
          {
            id: 'assistant-b',
            author: { role: 'assistant' },
            recipient: 'all',
            channel: 'final',
            content: { content_type: 'text', parts: ['第二次回答'] },
            metadata: { parent_id: 'user-root' },
          },
        ],
      }, { observedAt: 2000 })

      const nodes = db.db.prepare(`
        SELECT node_id AS nodeId, parent_id AS parentId, parent_source AS parentSource,
               transport_parent_id AS transportParentId, message_id AS messageId,
               children_json AS childrenJson
        FROM mapping_nodes
        WHERE conversation_id='branch-live'
        ORDER BY node_id
      `).all() as Array<{
        nodeId: string
        parentId: string | null
        parentSource: string | null
        transportParentId: string | null
        messageId: string | null
        childrenJson: string | null
      }>

      expect(nodes.map(node => [node.nodeId, node.parentId, node.transportParentId, node.messageId])).toEqual([
        ['assistant-a', null, 'user-root', 'assistant-a'],
        ['assistant-b', null, 'user-root', 'assistant-b'],
        ['user-root', null, null, 'user-root'],
      ])
      expect(nodes.every(node => node.parentSource === 'live-transport-only')).toBe(true)
      expect(nodes.every(node => node.childrenJson === null)).toBe(true)
    }
    finally {
      db.close()
    }
  })

  test('官方 mapping.parent 不会被后来的 metadata.parent_id 覆盖', () => {
    const db = tempDb()
    try {
      const source = db.beginOfficialExportSource({
        sourceKey: 'official-parent-test',
        displayName: 'fixture.zip',
        sourcePath: 'fixture.zip',
        fileSize: 1,
        fileMtimeMs: 1,
        observedAt: 1000,
        metadata: {},
      })
      db.importOfficialBatch(source.sourceId, [{
        id: 'parent-priority',
        title: 'Parent priority',
        current_node: 'assistant-1',
        mapping: {
          'user-1': {
            id: 'user-1',
            parent: null,
            children: ['assistant-1'],
            message: {
              id: 'user-1', author: { role: 'user' }, recipient: 'all',
              content: { content_type: 'text', parts: ['问题'] }, metadata: {},
            },
          },
          'assistant-1': {
            id: 'assistant-1',
            parent: 'user-1',
            children: [],
            message: {
              id: 'assistant-1', author: { role: 'assistant' }, recipient: 'all', channel: 'final',
              content: { content_type: 'text', parts: ['回答'] }, metadata: {},
            },
          },
        },
      }], { observedAt: 1000, partName: 'conversations-000.json' })

      // 模拟当前 plural payload：metadata.parent_id 故意与官方 mapping.parent 不同。
      db.mergeLiveMessagesPage({
        title: 'Parent priority',
        conversation_id: 'parent-priority',
        current_node: 'assistant-1',
        messages: [{
          id: 'assistant-1', author: { role: 'assistant' }, recipient: 'all', channel: 'final',
          content: { content_type: 'text', parts: ['更新后的回答'] },
          metadata: { parent_id: 'transport-parent-not-tree-parent' },
        }],
      }, { observedAt: 2000 })

      const row = db.db.prepare(`
        SELECT parent_id AS parentId, parent_source AS parentSource
        FROM mapping_nodes
        WHERE conversation_id='parent-priority' AND node_id='assistant-1'
      `).get()
      expect(row).toMatchObject({ parentId: 'user-1', parentSource: 'official-mapping' })
    }
    finally {
      db.close()
    }
  })

  test('current_node A→B→A 会保留 head 历史；重复观察同一 head 幂等', () => {
    const db = tempDb()
    try {
      const page = (head: string, text: string, updateTime: number) => ({
        title: 'Head history fixture',
        conversation_id: 'head-history',
        current_node: head,
        update_time: updateTime,
        messages: [
          {
            id: head,
            author: { role: 'assistant' },
            recipient: 'all',
            channel: 'final',
            content: { content_type: 'text', parts: [text] },
            metadata: {},
          },
        ],
      })

      db.mergeLiveMessagesPage(page('a', 'A1', 1), { observedAt: 1000, observationKind: 'wss:complete' })
      db.mergeLiveMessagesPage(page('a', 'A1', 1), { observedAt: 1100, observationKind: 'cursor-page' })
      db.mergeLiveMessagesPage(page('b', 'B', 2), { observedAt: 2000, observationKind: 'wss:complete' })
      db.mergeLiveMessagesPage(page('a', 'A2', 3), { observedAt: 3000, observationKind: 'wss:complete' })

      const history = db.db.prepare(`
        SELECT current_node AS currentNode, previous_node AS previousNode, observed_at AS observedAt
        FROM conversation_head_history
        WHERE conversation_id = 'head-history'
        ORDER BY observed_at, id
      `).all()

      expect(history).toEqual([
        { currentNode: 'a', previousNode: null, observedAt: 1000 },
        { currentNode: 'b', previousNode: 'a', observedAt: 2000 },
        { currentNode: 'a', previousNode: 'b', observedAt: 3000 },
      ])
    }
    finally {
      db.close()
    }
  })

  test('singular mapping 会把 edit/regenerate sibling 精确回填为 branch tree', () => {
    const db = tempDb()
    try {
      // 先模拟 modern plural：两个 assistant 都只知道同一个 transport_parent_id，不能据此建树。
      db.mergeLiveMessagesPage({
        title: 'Version tree fixture',
        conversation_id: 'version-tree',
        current_node: 'assistant-b',
        messages: [
          {
            id: 'user-a', author: { role: 'user' }, recipient: 'all',
            content: { content_type: 'text', parts: ['原问题'] },
            metadata: { has_versions: true, parent_id: 'transport-user-parent' },
          },
          {
            id: 'assistant-b', author: { role: 'assistant' }, recipient: 'all', channel: 'final',
            content: { content_type: 'text', parts: ['第二版回答'] },
            metadata: { parent_id: 'transport-assistant-parent' },
          },
        ],
      }, { observedAt: 1000 })

      // 再模拟 singular mapping：同一 user 下有两条 regenerate assistant sibling。
      const merged = db.mergeLiveMappingSnapshot({
        title: 'Version tree fixture',
        conversation_id: 'version-tree',
        current_node: 'assistant-b',
        mapping: {
          'root': { id: 'root', parent: null, children: ['user-a'], message: null },
          'user-a': {
            id: 'user-a', parent: 'root', children: ['assistant-a', 'assistant-b'],
            message: {
              id: 'user-a', author: { role: 'user' }, recipient: 'all',
              content: { content_type: 'text', parts: ['原问题'] },
              metadata: { has_versions: true, parent_id: 'transport-user-parent' },
            },
          },
          'assistant-a': {
            id: 'assistant-a', parent: 'user-a', children: [],
            message: {
              id: 'assistant-a', author: { role: 'assistant' }, recipient: 'all', channel: 'final',
              content: { content_type: 'text', parts: ['第一版回答'] }, metadata: {},
            },
          },
          'assistant-b': {
            id: 'assistant-b', parent: 'user-a', children: [],
            message: {
              id: 'assistant-b', author: { role: 'assistant' }, recipient: 'all', channel: 'final',
              content: { content_type: 'text', parts: ['第二版回答'] },
              metadata: { parent_id: 'transport-assistant-parent' },
            },
          },
        },
      }, { observedAt: 2000, observationKind: 'version-tree:test' })

      expect(merged.nodeCount).toBe(4)
      expect(merged.newMessageCount).toBe(1)
      const rows = db.db.prepare(`
        SELECT node_id AS nodeId, parent_id AS parentId, parent_source AS parentSource,
               transport_parent_id AS transportParentId, children_json AS childrenJson
        FROM mapping_nodes
        WHERE conversation_id='version-tree'
        ORDER BY node_id
      `).all() as Array<Record<string, unknown>>
      const user = rows.find(row => row.nodeId === 'user-a')
      expect(user).toMatchObject({
        parentId: 'root',
        parentSource: 'live-singular-mapping',
        transportParentId: 'transport-user-parent',
      })
      expect(JSON.parse(String(user?.childrenJson))).toEqual(['assistant-a', 'assistant-b'])
      expect(rows.find(row => row.nodeId === 'assistant-a')).toMatchObject({
        parentId: 'user-a', parentSource: 'live-singular-mapping',
      })
      expect(rows.find(row => row.nodeId === 'assistant-b')).toMatchObject({
        parentId: 'user-a', parentSource: 'live-singular-mapping', transportParentId: 'transport-assistant-parent',
      })
    }
    finally {
      db.close()
    }
  })

  test('complete 但没有 final 会开 incident；新 turn 正常完成后自动解除当前异常', () => {
    const db = tempDb()
    try {
      const broken = {
        title: '异常测试',
        conversation_id: 'incident-conversation',
        messages: [
          {
            id: 'u1',
            author: { role: 'user' },
            recipient: 'all',
            create_time: 1,
            content: { content_type: 'text', parts: ['执行任务'] },
            metadata: { turn_exchange_id: 'turn-broken' },
          },
          {
            id: 'r1',
            author: { role: 'assistant' },
            recipient: 'all',
            create_time: 2,
            content: { content_type: 'thoughts', parts: ['还在思考'] },
            metadata: { turn_exchange_id: 'turn-broken', reasoning_status: 'is_reasoning' },
          },
        ],
      }
      db.mergeLiveMessagesPage(broken, { classifyTerminal: true, observedAt: 1000 })
      expect(db.listIncidents({ status: 'open' })).toHaveLength(1)

      const recovered = {
        title: '异常测试',
        conversation_id: 'incident-conversation',
        messages: [
          ...broken.messages,
          {
            id: 'u2',
            author: { role: 'user' },
            recipient: 'all',
            create_time: 3,
            content: { content_type: 'text', parts: ['换一轮继续'] },
            metadata: { turn_exchange_id: 'turn-good' },
          },
          {
            id: 'a2',
            author: { role: 'assistant' },
            recipient: 'all',
            channel: 'final',
            create_time: 4,
            content: { content_type: 'text', parts: ['完成。'] },
            metadata: { turn_exchange_id: 'turn-good' },
          },
        ],
      }
      db.mergeLiveMessagesPage(recovered, { classifyTerminal: true, observedAt: 2000 })
      expect(db.listIncidents({ status: 'open' })).toHaveLength(0)
      expect(db.listIncidents({ status: 'resolved' })).toHaveLength(1)
      const row = db.db.prepare('SELECT incident_state AS incidentState FROM conversations WHERE id=?').get('incident-conversation')
      expect(row).toMatchObject({ incidentState: null })
    }
    finally {
      db.close()
    }
  })
})
