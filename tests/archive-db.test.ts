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

  test('watchdog 未确认终止时不会把 open reasoning 尾巴误报为 incident，但显式 interrupted 仍可记录', () => {
    const db = tempDb()
    try {
      const running = {
        title: 'Watchdog fixture',
        conversation_id: 'watchdog-running',
        messages: [
          {
            id: 'u1', author: { role: 'user' }, recipient: 'all',
            content: { content_type: 'text', parts: ['执行长任务'] },
            metadata: { turn_exchange_id: 'turn-running' },
          },
          {
            id: 'r1', author: { role: 'assistant' }, recipient: 'all',
            content: { content_type: 'thoughts', parts: ['仍在处理中'] },
            metadata: { turn_exchange_id: 'turn-running', reasoning_status: 'is_reasoning' },
          },
        ],
      }
      db.mergeLiveMessagesPage(running, {
        observedAt: 1000,
        classifyTerminal: true,
        allowIncompleteTailIncident: false,
      })
      expect(db.listIncidents({ status: 'open' })).toHaveLength(0)

      const stopped = {
        ...running,
        conversation_id: 'watchdog-stopped',
        messages: [
          ...running.messages,
          {
            id: 'a2', author: { role: 'assistant' }, recipient: 'all', channel: 'final',
            content: { content_type: 'text', parts: ['被停止'] },
            metadata: {
              turn_exchange_id: 'turn-running',
              finish_details: { type: 'interrupted', reason: 'client_stopped' },
            },
          },
        ],
      }
      db.mergeLiveMessagesPage(stopped, {
        observedAt: 2000,
        classifyTerminal: true,
        allowIncompleteTailIncident: false,
      })
      expect(db.listIncidents({ status: 'open' }).some(item => item.conversationId === 'watchdog-stopped')).toBe(true)
    }
    finally {
      db.close()
    }
  })

  test('cursor 历史页只能补事实，不能覆盖最新 turn 的 current state 或 incident', () => {
    const db = tempDb()
    try {
      const latest = {
        title: '分页状态 fixture',
        conversation_id: 'page-state',
        current_node: 'tool-result',
        update_time: 20,
        messages: [
          {
            id: 'u-new', author: { role: 'user' }, recipient: 'all',
            content: { content_type: 'text', parts: ['新一轮'] },
            metadata: { turn_exchange_id: 'turn-new' },
          },
          {
            id: 'call-new', author: { role: 'assistant' }, recipient: 'api_tool.call_tool',
            content: { content_type: 'code', text: '{}' },
            metadata: { turn_exchange_id: 'turn-new' },
          },
          {
            id: 'tool-result', author: { role: 'tool' }, recipient: 'all',
            content: { content_type: 'code', text: '{"ok":true}' },
            metadata: { turn_exchange_id: 'turn-new' },
          },
        ],
      }
      db.mergeLiveMessagesPage(latest, {
        observedAt: 2000,
        classifyTerminal: true,
        allowIncompleteTailIncident: true,
        incidentKind: 'watchdog-timeout',
        updateCurrentState: true,
      })

      const oldPage = {
        title: '旧分页标题不应覆盖',
        conversation_id: 'page-state',
        current_node: 'old-final',
        update_time: 10,
        messages: [
          {
            id: 'u-old', author: { role: 'user' }, recipient: 'all',
            content: { content_type: 'text', parts: ['旧一轮'] },
            metadata: { turn_exchange_id: 'turn-old' },
          },
          {
            id: 'old-final', author: { role: 'assistant' }, recipient: 'all', channel: 'final',
            content: { content_type: 'text', parts: ['旧 final'] },
            metadata: { turn_exchange_id: 'turn-old' },
          },
        ],
      }
      db.mergeLiveMessagesPage(oldPage, {
        observedAt: 2100,
        classifyTerminal: false,
        updateCurrentState: false,
      })

      expect(db.db.prepare(`
        SELECT current_node AS currentNode, terminal_state AS terminalState,
               incident_state AS incidentState, title
        FROM conversations WHERE id='page-state'
      `).get()).toMatchObject({
        currentNode: 'tool-result',
        terminalState: 'none',
        incidentState: 'open',
        title: '分页状态 fixture',
      })
      expect(db.listIncidents({ status: 'open' })).toHaveLength(1)
      expect(db.listIncidents({ status: 'open' })[0]).toMatchObject({
        turnKey: 'turn-new',
        incidentKind: 'watchdog-timeout',
      })
      expect(db.listIncidents({ status: 'open' })[0]?.reason).toContain('超过 watchdog 阈值仍未收到 conversation-turn-complete')
    }
    finally {
      db.close()
    }
  })

  test('incident 以 turn 为稳定身份，同一 turn 升级而不同 turn 不互相覆盖', () => {
    const db = tempDb()
    try {
      const timedOut = {
        title: 'per-turn incident', conversation_id: 'per-turn', current_node: 'r1',
        messages: [
          { id: 'u1', author: { role: 'user' }, recipient: 'all', content: { content_type: 'text', parts: ['任务1'] }, metadata: { turn_exchange_id: 'turn-1' } },
          { id: 'r1', author: { role: 'assistant' }, recipient: 'all', content: { content_type: 'thoughts', parts: ['处理中'] }, metadata: { turn_exchange_id: 'turn-1', reasoning_status: 'is_reasoning' } },
        ],
      }
      db.mergeLiveMessagesPage(timedOut, {
        observedAt: 1000,
        classifyTerminal: true,
        allowIncompleteTailIncident: true,
        incidentKind: 'watchdog-timeout',
      })
      const firstId = db.listIncidents()[0]?.id

      const interrupted = {
        ...timedOut,
        current_node: 'a1',
        messages: [
          ...timedOut.messages,
          { id: 'a1', author: { role: 'assistant' }, recipient: 'all', channel: 'final', content: { content_type: 'text', parts: ['中断'] }, metadata: { turn_exchange_id: 'turn-1', finish_details: { type: 'interrupted', reason: 'client_stopped' } } },
        ],
      }
      db.mergeLiveMessagesPage(interrupted, { observedAt: 1100, classifyTerminal: true })
      expect(db.listIncidents()).toHaveLength(1)
      expect(db.listIncidents()[0]).toMatchObject({
        id: firstId,
        turnKey: 'turn-1',
        incidentKind: 'abnormal-terminal',
        status: 'open',
      })
      expect(db.listIncidents()[0]?.reason).toContain('client_stopped')

      const secondTurn = {
        title: 'per-turn incident', conversation_id: 'per-turn', current_node: 'r2',
        messages: [
          { id: 'u2', author: { role: 'user' }, recipient: 'all', content: { content_type: 'text', parts: ['任务2'] }, metadata: { turn_exchange_id: 'turn-2' } },
          { id: 'r2', author: { role: 'assistant' }, recipient: 'all', content: { content_type: 'thoughts', parts: ['又卡住'] }, metadata: { turn_exchange_id: 'turn-2', reasoning_status: 'is_reasoning' } },
        ],
      }
      db.mergeLiveMessagesPage(secondTurn, {
        observedAt: 2000,
        classifyTerminal: true,
        allowIncompleteTailIncident: true,
        incidentKind: 'watchdog-timeout',
      })
      expect(db.listIncidents()).toHaveLength(2)
      expect(db.listIncidents({ status: 'resolved' }).map(item => item.turnKey)).toContain('turn-1')
      expect(db.listIncidents({ status: 'open' }).map(item => item.turnKey)).toEqual(['turn-2'])
    }
    finally {
      db.close()
    }
  })

  test('cursor 历史页会补自己的 turn incident 与工具事实，但不会关闭当前 turn 红牌', () => {
    const db = tempDb()
    try {
      const current = {
        title: '历史 turn 补账 fixture',
        conversation_id: 'historical-turn-ledger',
        current_node: 'r-new',
        messages: [
          {
            id: 'u-new', author: { role: 'user' }, recipient: 'all',
            content: { content_type: 'text', parts: ['当前轮'] },
            metadata: { turn_exchange_id: 'turn-new' },
          },
          {
            id: 'r-new', author: { role: 'assistant' }, recipient: 'all',
            content: { content_type: 'thoughts', parts: ['仍在运行'] },
            metadata: { turn_exchange_id: 'turn-new', reasoning_status: 'is_reasoning' },
          },
        ],
      }
      db.mergeLiveMessagesPage(current, {
        observedAt: 1000,
        classifyTerminal: true,
        allowIncompleteTailIncident: true,
        incidentKind: 'watchdog-timeout',
        updateCurrentState: true,
      })

      const historicalPage = {
        title: '旧页标题不应覆盖',
        conversation_id: 'historical-turn-ledger',
        current_node: 'tool-old',
        messages: [
          {
            id: 'u-old', author: { role: 'user' }, recipient: 'all',
            content: { content_type: 'text', parts: ['旧轮'] },
            metadata: { turn_exchange_id: 'turn-old' },
          },
          {
            id: 'call-old', author: { role: 'assistant' }, recipient: 'api_tool.call_tool',
            content: { content_type: 'code', text: '{"tool":"demo"}' },
            metadata: { turn_exchange_id: 'turn-old', custom_marker: 'keep-me' },
          },
          {
            id: 'tool-old', author: { role: 'tool' }, recipient: 'all',
            content: { content_type: 'code', text: '{"ok":true}' },
            metadata: { turn_exchange_id: 'turn-old', tool_marker: 'kept' },
          },
        ],
      }
      db.mergeLiveMessagesPage(historicalPage, {
        observedAt: 2000,
        updateCurrentState: false,
        classifyTerminal: false,
        observationKind: 'cursor-page',
      })

      const open = db.listIncidents({ status: 'open' })
      const resolved = db.listIncidents({ status: 'resolved' })
      expect(open).toHaveLength(1)
      expect(open[0]).toMatchObject({ turnKey: 'turn-new', incidentKind: 'watchdog-timeout' })
      expect(resolved).toHaveLength(1)
      expect(resolved[0]).toMatchObject({ turnKey: 'turn-old', incidentKind: 'abnormal-terminal' })
      expect(resolved[0]?.reason).toContain('历史 turn 后续已经出现更新的 user turn')

      const currentState = db.db.prepare(`
        SELECT current_node AS currentNode, terminal_state AS terminalState,
               incident_state AS incidentState, title
        FROM conversations WHERE id='historical-turn-ledger'
      `).get()
      expect(currentState).toMatchObject({
        currentNode: 'r-new',
        terminalState: 'none',
        incidentState: 'open',
        title: '历史 turn 补账 fixture',
      })

      const oldTool = db.db.prepare(`
        SELECT text, metadata_json AS metadataJson
        FROM messages
        WHERE conversation_id='historical-turn-ledger' AND message_id='tool-old'
      `).get() as { text: string, metadataJson: string }
      expect(oldTool.text).toContain('ok')
      expect(JSON.parse(oldTool.metadataJson)).toMatchObject({ tool_marker: 'kept' })
    }
    finally {
      db.close()
    }
  })
})
