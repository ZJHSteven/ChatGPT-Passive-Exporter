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
  test('DevSpace metadata 可先未绑定落盘，再原位绑定并保存 turn 状态', () => {
    const db = tempDb()
    try {
      const first = db.observeDevSpaceMetadata({
        metadataId: 'meta-chat-1',
        auditId: 'audit-1',
        auditAt: 1000,
      })
      expect(first).toMatchObject({
        metadataId: 'meta-chat-1',
        conversationId: null,
        firstSeenAt: 1000,
        lifecycleState: 'unbound',
        unboundWatchdogAt: null,
      })
      db.observeDevSpaceMetadata({
        metadataId: 'meta-chat-1',
        auditId: 'audit-2',
        auditAt: 2000,
      })
      expect(db.markDevSpaceUnboundWatchdog('meta-chat-1', 2200)).toMatchObject({
        unboundWatchdogAt: 2200,
      })
      const bound = db.bindDevSpaceMetadata({
        metadataId: 'meta-chat-1',
        conversationId: 'conversation-1',
        evidence: 'body:exact-tool-args',
        confidence: 'high',
        observedAt: 2500,
        lifecycleState: 'active',
      })
      expect(bound).toMatchObject({
        conversationId: 'conversation-1',
        firstSeenAt: 1000,
        lastSeenAt: 2000,
        boundAt: 2500,
        lifecycleState: 'active',
        unboundWatchdogAt: 2200,
      })
      expect(db.updateDevSpaceBindingTurn({
        conversationId: 'conversation-1',
        turnExchangeId: 'turn-1',
        requestId: 'request-1',
        observedAt: 3000,
        lifecycleState: 'closed',
      })).toBe(1)
      expect(db.getDevSpaceMetadataBinding('meta-chat-1')).toMatchObject({
        lastTurnExchangeId: 'turn-1',
        lastRequestId: 'request-1',
        lifecycleState: 'closed',
      })
    }
    finally {
      db.close()
    }
  })

  test('历史 metadata seed 只补首末时间，不覆盖既有 CID 绑定', () => {
    const db = tempDb()
    try {
      const seeded = db.seedDevSpaceMetadataHistory({
        metadataId: 'meta-history',
        firstSeenAt: 1000,
        lastSeenAt: 5000,
      })
      expect(seeded.created).toBe(true)
      expect(seeded.row).toMatchObject({
        metadataId: 'meta-history',
        conversationId: null,
        firstSeenAt: 1000,
        lastSeenAt: 5000,
        lifecycleState: 'unbound',
      })

      db.bindDevSpaceMetadata({
        metadataId: 'meta-history',
        conversationId: 'conversation-history',
        evidence: 'body:exact-tool-args-backfill',
        confidence: 'high',
        observedAt: 6000,
        lifecycleState: 'closed',
      })
      const reseeded = db.seedDevSpaceMetadataHistory({
        metadataId: 'meta-history',
        firstSeenAt: 500,
        lastSeenAt: 7000,
      })
      expect(reseeded.created).toBe(false)
      expect(reseeded.row).toMatchObject({
        conversationId: 'conversation-history',
        firstSeenAt: 500,
        lastSeenAt: 7000,
        evidence: 'body:exact-tool-args-backfill',
        lifecycleState: 'closed',
      })
    }
    finally {
      db.close()
    }
  })

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

  test('ImageGen 多图保存稳定 pointer 元数据，二进制状态独立于 SQLite message', () => {
    const db = tempDb()
    try {
      db.mergeLiveMessagesPage({
        title: 'ImageGen fixture',
        conversation_id: 'imagegen-conversation',
        current_node: 'recap',
        messages: [
          {
            id: 'u1', author: { role: 'user' }, recipient: 'all',
            content: { content_type: 'text', parts: ['画两张图'] },
            metadata: { turn_exchange_id: 'turn-image' },
          },
          {
            id: 'img-tool', author: { role: 'tool', name: 'image-tool' }, recipient: 'all', channel: 'final',
            content: {
              content_type: 'multimodal_text',
              parts: [1, 2].map(index => ({
                content_type: 'image_asset_pointer',
                asset_pointer: `sediment://file_0000000000000000000000000000000${index}`,
                mime_type: 'image/png',
                size_bytes: 1000 + index,
                width: 1024,
                height: 768,
                metadata: { generation: { gen_id: `gen-${index}`, orientation: 'landscape' } },
              })),
            },
            metadata: {
              turn_exchange_id: 'turn-image',
              permissions: [{ notification_channel_id: 'image_gen' }],
            },
          },
          {
            id: 'recap', author: { role: 'assistant' }, recipient: 'all',
            content: { content_type: 'reasoning_recap', parts: ['done'] },
            metadata: { turn_exchange_id: 'turn-image', reasoning_status: 'reasoning_ended' },
          },
        ],
      }, { observedAt: 1234, classifyTerminal: true, allowIncompleteTailIncident: true })

      const generatedResources = db.getResources('imagegen-conversation').filter(item => item.kind === 'generated-image')
      expect(generatedResources).toHaveLength(2)
      expect(JSON.stringify(generatedResources)).toContain('gen-1')

      const pending = db.listPendingGeneratedImageAssets()
      expect(pending).toHaveLength(2)
      expect(pending[0]).toMatchObject({
        conversationId: 'imagegen-conversation',
        messageId: 'img-tool',
        assetKind: 'generated-image',
        mimeType: 'image/png',
      })
      expect(db.findPendingGeneratedImageAssetByFileId('file_00000000000000000000000000000001')).toMatchObject({
        conversationId: 'imagegen-conversation',
        messageId: 'img-tool',
        partIndex: 0,
        expectedSizeBytes: 1001,
      })
      expect(db.findPendingGeneratedImageAssetByFileId('file_not_in_archive')).toBeNull()

      const event = db.getImageGenerationEvent('imagegen-conversation', 'turn-image')
      expect(event).toMatchObject({ messageId: 'img-tool', imageCount: 2, notificationSentAt: null })

      db.markImageAssetDownloaded(pending[0]!.assetPointer, {
        localPath: 'assets/file-1.png',
        sha256: 'abc123',
        actualSizeBytes: 1001,
        downloadedAt: 2000,
      })
      const hydratedResource = db.getResources('imagegen-conversation')
        .find(item => item.kind === 'generated-image' && (item.data as Record<string, unknown>).partIndex === 0)
      expect(hydratedResource?.data).toMatchObject({
        localPath: 'assets/file-1.png',
        sha256: 'abc123',
        actualSizeBytes: 1001,
        downloadedAt: 2000,
      })
      expect(db.findPendingGeneratedImageAssetByFileId('file_00000000000000000000000000000001')).toBeNull()
      expect(db.findPendingGeneratedImageAssetByFileId('file_00000000000000000000000000000002')).toMatchObject({
        partIndex: 1,
      })
      db.markImageGenerationNotificationSent('imagegen-conversation', 'img-tool', 3000)
      expect(db.listPendingGeneratedImageAssets()).toHaveLength(1)
      expect(db.getImageGenerationEvent('imagegen-conversation', 'turn-image')?.notificationSentAt).toBe(3000)
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

  test('浏览器内存 recovery 只插未知消息，不覆盖已有 canonical message', () => {
    const db = tempDb()
    try {
      db.mergeLiveMessagesPage({
        title: 'Recovery fixture',
        conversation_id: 'recovery-chat',
        current_node: 'assistant-final',
        messages: [
          {
            id: 'user-old',
            author: { role: 'user' },
            recipient: 'all',
            content: { content_type: 'text', parts: ['旧问题'] },
            metadata: { turn_exchange_id: 'turn-old', canonical_marker: 'keep-me' },
          },
          {
            id: 'assistant-final',
            author: { role: 'assistant' },
            recipient: 'all',
            channel: 'final',
            content: { content_type: 'text', parts: ['旧回答'] },
            metadata: { turn_exchange_id: 'turn-old' },
          },
        ],
      }, { observedAt: 1000, classifyTerminal: true })

      db.mergeLiveMessagesPage({
        title: 'Recovery fixture',
        conversation_id: 'recovery-chat',
        current_node: 'ui-length-cap',
        recovery: { kind: 'browser-memory-recovery', capturedAt: 2000 },
        messages: [
          {
            id: 'user-old',
            author: { role: 'user' },
            recipient: 'all',
            content: { content_type: 'text', parts: ['DOM 简化副本'] },
            metadata: { recovery_source: 'browser-memory' },
          },
          {
            id: 'user-recovered',
            author: { role: 'user' },
            recipient: 'all',
            content: { content_type: 'text', parts: ['又中断了继续'] },
            metadata: { recovery_source: 'browser-memory' },
          },
        ],
      }, {
        observedAt: 2000,
        observationKind: 'browser-memory-recovery',
        endpoint: 'offline://browser-memory-recovery',
        updateCurrentState: false,
        classifyTerminal: false,
        updateIncidents: false,
        insertUnknownOnly: true,
      })

      expect(db.getMessages('recovery-chat').map(item => item.messageId)).toEqual(
        expect.arrayContaining(['user-old', 'assistant-final', 'user-recovered']),
      )
      expect(db.db.prepare(
        'SELECT text, metadata_json AS metadataJson FROM messages WHERE conversation_id = ? AND message_id = ?',
      ).get('recovery-chat', 'user-old')).toMatchObject({
        text: '旧问题',
        metadataJson: expect.stringContaining('canonical_marker'),
      })
      expect(db.db.prepare(
        'SELECT current_node AS currentNode FROM conversations WHERE id = ?',
      ).get('recovery-chat')).toMatchObject({ currentNode: 'assistant-final' })
      expect(db.listIncidents()).toHaveLength(0)
      expect(db.db.prepare(
        'SELECT observation_kind AS observationKind, endpoint FROM live_observations WHERE conversation_id = ? ORDER BY id DESC LIMIT 1',
      ).get('recovery-chat')).toMatchObject({
        observationKind: 'browser-memory-recovery',
        endpoint: 'offline://browser-memory-recovery',
      })
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

  test('后续 body 即使 current_node 回退且不再携带新节点，本地 archive 也不会删除已落盘消息', () => {
    const db = tempDb()
    try {
      db.mergeLiveMessagesPage({
        title: 'Lossless head rollback fixture',
        conversation_id: 'lossless-head-rollback',
        current_node: 'assistant-b',
        messages: [
          {
            id: 'user-1', author: { role: 'user' }, recipient: 'all', create_time: 1,
            content: { content_type: 'text', parts: ['问题'] }, metadata: { turn_exchange_id: 'turn-1' },
          },
          {
            id: 'assistant-a', author: { role: 'assistant' }, recipient: 'all', create_time: 2,
            content: { content_type: 'text', parts: ['较早回答'] }, metadata: { turn_exchange_id: 'turn-1' },
          },
          {
            id: 'assistant-b', author: { role: 'assistant' }, recipient: 'all', create_time: 3,
            content: { content_type: 'text', parts: ['后来出现、之后被服务端 head 回退隐藏的回答'] },
            metadata: { turn_exchange_id: 'turn-1' },
          },
        ],
      }, { observedAt: 1000 })

      // 模拟后续服务器 canonical body 回到 assistant-a，并且响应本身也不再包含 assistant-b。
      // mergeLiveMessagesPage 必须只做 union/upsert，不能用这份“更短的新快照”删除本地证据。
      db.mergeLiveMessagesPage({
        title: 'Lossless head rollback fixture',
        conversation_id: 'lossless-head-rollback',
        current_node: 'assistant-a',
        messages: [
          {
            id: 'user-1', author: { role: 'user' }, recipient: 'all', create_time: 1,
            content: { content_type: 'text', parts: ['问题'] }, metadata: { turn_exchange_id: 'turn-1' },
          },
          {
            id: 'assistant-a', author: { role: 'assistant' }, recipient: 'all', create_time: 2,
            content: { content_type: 'text', parts: ['较早回答'] }, metadata: { turn_exchange_id: 'turn-1' },
          },
        ],
      }, { observedAt: 2000 })

      expect(db.getMessages('lossless-head-rollback').map(row => row.messageId)).toEqual([
        'user-1', 'assistant-a', 'assistant-b',
      ])
      expect(db.getMarkdown('lossless-head-rollback')).toContain('后来出现、之后被服务端 head 回退隐藏的回答')
      expect(db.list(10).find(row => row.id === 'lossless-head-rollback')?.currentNode).toBe('assistant-a')
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

  test('confirmed complete 的 context-only-no-output 会单独记账，而未确认终止时不会仅凭该尾型判死', () => {
    const db = tempDb()
    try {
      const contextOnly = {
        title: 'context-only fixture',
        conversation_id: 'context-only-conversation',
        current_node: 'ctx1',
        messages: [
          {
            id: 'u1', author: { role: 'user' }, recipient: 'all',
            content: { content_type: 'text', parts: ['继续'] },
            metadata: { turn_exchange_id: 'turn-context-only', request_id: 'request-context-only' },
          },
          {
            id: 'ctx1', author: { role: 'assistant' }, recipient: 'all',
            content: { content_type: 'model_editable_context', parts: [] },
            metadata: { turn_exchange_id: 'turn-context-only', request_id: 'request-context-only' },
          },
        ],
      }

      // 单独看到这种 body 形态时不能判死：模拟 watchdog / reconnect 尚无 confirmed complete。
      db.mergeLiveMessagesPage(contextOnly, {
        observedAt: 1000,
        classifyTerminal: true,
        allowIncompleteTailIncident: false,
      })
      expect(db.listIncidents({ status: 'open' })).toHaveLength(0)

      // 收到 WSS conversation-turn-complete 后，上层会把 allowIncompleteTailIncident 打开；
      // 此时同一个结构性尾型才成为 confirmed complete-no-final 的异常账目。
      db.mergeLiveMessagesPage(contextOnly, {
        observedAt: 2000,
        classifyTerminal: true,
        allowIncompleteTailIncident: true,
        observationKind: 'wss:conversation-turn-complete',
      })
      expect(db.listIncidents({ status: 'open' })).toHaveLength(1)
      expect(db.listIncidents({ status: 'open' })[0]).toMatchObject({
        turnKey: 'turn-context-only',
        incidentKind: 'abnormal-terminal',
        lifecycleClass: 'complete-no-final',
        tailShape: 'context-only-no-output',
        headState: 'aligned',
        headRollbackObserved: false,
        offHeadSameTurnCount: 0,
      })
    }
    finally {
      db.close()
    }
  })

  test('incident 同时保存 complete-no-final、tail 与 head/messages divergence 三个独立维度', () => {
    const db = tempDb()
    try {
      const body = {
        title: 'head divergence incident',
        conversation_id: 'head-divergence-incident',
        current_node: 'call1',
        messages: [
          {
            id: 'u1', author: { role: 'user' }, recipient: 'all', create_time: 1,
            content: { content_type: 'text', parts: ['go'] },
            metadata: { turn_exchange_id: 'turn-diverge', request_id: 'request-diverge' },
          },
          {
            id: 'call1', author: { role: 'assistant' }, recipient: 'functions.exec', channel: 'commentary',
            create_time: 2, status: 'in_progress', end_turn: null,
            content: { content_type: 'text', parts: [''] },
            metadata: { turn_exchange_id: 'turn-diverge', request_id: 'request-diverge' },
          },
          {
            id: 'tool1', author: { role: 'tool' }, recipient: 'all', create_time: 3,
            status: 'finished_successfully', content: { content_type: 'text', parts: [''] },
            metadata: { turn_exchange_id: 'turn-diverge', request_id: 'request-diverge' },
          },
          {
            id: 'thought2', author: { role: 'assistant' }, recipient: 'all', create_time: 4,
            status: 'finished_successfully', end_turn: false,
            content: { content_type: 'thoughts', parts: [''] },
            metadata: {
              turn_exchange_id: 'turn-diverge', request_id: 'request-diverge', reasoning_status: 'is_reasoning',
            },
          },
        ],
      }

      db.mergeLiveMessagesPage(body, {
        observedAt: 1000,
        classifyTerminal: true,
        allowIncompleteTailIncident: true,
        observationKind: 'body-page:wss:conversation-turn-complete',
      })

      expect(db.listIncidents({ status: 'open' })[0]).toMatchObject({
        lifecycleClass: 'complete-no-final',
        tailShape: 'reasoning-open',
        headState: 'behind-same-turn',
        headRollbackObserved: false,
        offHeadSameTurnCount: 2,
      })
      expect(db.listIncidents({ status: 'open' })[0]?.reason).toContain('已确认 turn 完成但没有 final')
    }
    finally {
      db.close()
    }
  })

  test('只有 head history 真正 A→B→A 时 incident 才记录 rollback evidence', () => {
    const db = tempDb()
    try {
      const messages = [
        {
          id: 'u1', author: { role: 'user' }, recipient: 'all', create_time: 1,
          content: { content_type: 'text', parts: ['go'] },
          metadata: { turn_exchange_id: 'turn-rollback' },
        },
        {
          id: 'a', author: { role: 'assistant' }, recipient: 'all', create_time: 2,
          content: { content_type: 'thoughts', parts: ['A'] },
          metadata: { turn_exchange_id: 'turn-rollback', reasoning_status: 'is_reasoning' },
        },
        {
          id: 'b', author: { role: 'assistant' }, recipient: 'all', create_time: 3,
          content: { content_type: 'thoughts', parts: ['B'] },
          metadata: { turn_exchange_id: 'turn-rollback', reasoning_status: 'is_reasoning' },
        },
      ]

      db.mergeLiveMessagesPage({
        title: 'rollback', conversation_id: 'rollback-incident', current_node: 'a', messages,
      }, { observedAt: 1000, classifyTerminal: false })
      db.mergeLiveMessagesPage({
        title: 'rollback', conversation_id: 'rollback-incident', current_node: 'b', messages,
      }, { observedAt: 2000, classifyTerminal: false })
      db.mergeLiveMessagesPage({
        title: 'rollback', conversation_id: 'rollback-incident', current_node: 'a', messages,
      }, {
        observedAt: 3000,
        classifyTerminal: true,
        allowIncompleteTailIncident: true,
        observationKind: 'body-page:wss:conversation-turn-complete',
      })

      expect(db.listIncidents({ status: 'open' })[0]).toMatchObject({
        lifecycleClass: 'complete-no-final',
        headState: 'behind-same-turn',
        headRollbackObserved: true,
        offHeadSameTurnCount: 1,
      })
    }
    finally {
      db.close()
    }
  })

  test('普通 reconcile 可刷新同 turn 已有 incident 的新 tail，但不得改写原终止来源或凭空新建立案', () => {
    const db = tempDb()
    try {
      const contextOnly = {
        title: 'incident refresh fixture',
        conversation_id: 'incident-refresh',
        current_node: 'ctx1',
        messages: [
          {
            id: 'u1', author: { role: 'user' }, recipient: 'all',
            content: { content_type: 'text', parts: ['继续'] },
            metadata: { turn_exchange_id: 'turn-refresh', request_id: 'request-refresh' },
          },
          {
            id: 'ctx1', author: { role: 'assistant' }, recipient: 'all',
            content: { content_type: 'model_editable_context', parts: [] },
            metadata: { turn_exchange_id: 'turn-refresh', request_id: 'request-refresh' },
          },
        ],
      }

      // 先模拟“旧版分类器在 WSS complete 时已经立案、但只记成 other”的历史账。
      db.mergeLiveMessagesPage(contextOnly, {
        observedAt: 1000,
        classifyTerminal: true,
        allowIncompleteTailIncident: true,
        observationKind: 'body-page:wss:conversation-turn-complete',
      })
      db.db.prepare(`
        UPDATE incidents
        SET tail_shape='other', reason='legacy other', diagnostic_json='{}'
        WHERE conversation_id='incident-refresh' AND turn_key='turn-refresh'
      `).run()

      // startup/reconnect 不是新的 terminal trigger，因此 classifyTerminal=false。
      // 它只能刷新已经存在的同 turn incident，不能把 source 改成 reconcile。
      db.mergeLiveMessagesPage(contextOnly, {
        observedAt: 2000,
        classifyTerminal: false,
        observationKind: 'body-page:reconcile:startup',
      })

      expect(db.listIncidents()).toHaveLength(1)
      expect(db.listIncidents()[0]).toMatchObject({
        status: 'open',
        tailShape: 'context-only-no-output',
        source: 'body-page:wss:conversation-turn-complete',
        lastObservedAt: 2000,
      })
      expect(db.listIncidents()[0]?.reason).toContain('已确认 turn 完成但没有 final')

      // 一个从未由可靠 terminal/watchdog 路径立案的新 turn，普通 reconcile 仍然不能创建事故。
      db.mergeLiveMessagesPage({
        ...contextOnly,
        conversation_id: 'incident-refresh-no-create',
      }, {
        observedAt: 3000,
        classifyTerminal: false,
        observationKind: 'body-page:reconcile:startup',
      })
      expect(db.listIncidents()).toHaveLength(1)
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
        lifecycleClass: 'watchdog-timeout',
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
        lifecycleClass: 'explicit-interrupted',
        status: 'open',
      })
      expect(db.listIncidents()[0]?.reason).toContain('client_stopped')

      // 后续普通 reconcile 即使拿到一个缺少 finish_details 的旧/不完整快照，也只能刷新
      // body 诊断，不能把已经确认的 explicit interrupted 降回 terminalEvidence=none。
      db.mergeLiveMessagesPage(timedOut, {
        observedAt: 1200,
        classifyTerminal: false,
        observationKind: 'body-page:reconcile:startup',
      })
      expect(db.listIncidents()[0]).toMatchObject({
        id: firstId,
        lifecycleClass: 'explicit-interrupted',
        terminalEvidence: 'client-stopped',
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

  test('catalog late-start watchdog 会落成 active-zombie lifecycle，而不是普通 watchdog-timeout', () => {
    const db = tempDb()
    try {
      db.mergeLiveMessagesPage({
        title: 'active zombie fixture',
        conversation_id: 'active-zombie-fixture',
        current_node: 'r1',
        messages: [
          { id: 'u1', author: { role: 'user' }, recipient: 'all', content: { content_type: 'text', parts: ['开始'] }, metadata: { turn_exchange_id: 'turn-zombie' } },
          { id: 'r1', author: { role: 'assistant' }, recipient: 'all', content: { content_type: 'thoughts', parts: ['处理中'] }, metadata: { turn_exchange_id: 'turn-zombie', reasoning_status: 'is_reasoning' } },
        ],
      }, {
        observedAt: 1000,
        classifyTerminal: true,
        allowIncompleteTailIncident: true,
        incidentKind: 'active-zombie',
      })

      const incident = db.listIncidents({ status: 'open' })[0]
      expect(incident).toMatchObject({
        turnKey: 'turn-zombie',
        incidentKind: 'active-zombie',
        lifecycleClass: 'active-zombie',
        terminalEvidence: 'none',
      })
      expect(incident?.reason).toContain('conversation list 持续保持 active')
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

  test('historical steering without explicit interruption does not become an incident', () => {
    const db = tempDb()
    try {
      db.mergeLiveMessagesPage({
        title: 'steering fixture',
        conversation_id: 'steering-history',
        current_node: 'a2',
        messages: [
          { id: 'u1', author: { role: 'user' }, recipient: 'all', content: { content_type: 'text', parts: ['first'] }, metadata: { turn_exchange_id: 'turn-1', request_id: 'req-1' } },
          { id: 'r1', author: { role: 'assistant' }, recipient: 'all', content: { content_type: 'thoughts', parts: ['thinking'] }, metadata: { turn_exchange_id: 'turn-1', request_id: 'req-1', reasoning_status: 'is_reasoning' } },
          { id: 'u-steer', author: { role: 'user' }, recipient: 'all', content: { content_type: 'text', parts: ['steer'] }, metadata: { turn_exchange_id: 'turn-1', request_id: 'req-1' } },
          { id: 'recap1', author: { role: 'assistant' }, recipient: 'all', content: { content_type: 'reasoning_recap', parts: ['done thinking'] }, metadata: { turn_exchange_id: 'turn-1', request_id: 'req-1', reasoning_status: 'reasoning_ended' } },
          { id: 'u2', author: { role: 'user' }, recipient: 'all', content: { content_type: 'text', parts: ['next turn'] }, metadata: { turn_exchange_id: 'turn-2', request_id: 'req-2' } },
          { id: 'a2', author: { role: 'assistant' }, recipient: 'all', channel: 'final', content: { content_type: 'text', parts: ['ok'] }, metadata: { turn_exchange_id: 'turn-2', request_id: 'req-2', finish_details: { type: 'stop', stop_tokens: [200002] } } },
        ],
      }, {
        observedAt: 3000,
        updateCurrentState: true,
        classifyTerminal: true,
        allowIncompleteTailIncident: true,
      })

      expect(db.listIncidents()).toHaveLength(0)
    }
    finally {
      db.close()
    }
  })
})
