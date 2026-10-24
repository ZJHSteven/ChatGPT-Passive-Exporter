import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test } from 'vitest'
import {
  ChatArchiveDb,
  devSpaceVirtualConversationId,
  preferredConversationTitle,
} from '../src/local/archive-db.ts'
import { prepareArchiveEvidence } from '../src/local/archive-evidence-store.ts'
import { devSpaceToolArgsFingerprint } from '../src/local/devspace-audit-bridge.ts'

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
  test('v4 database upgrades through current schema without genesis migration', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-archive-v4-upgrade-'))
    tempDirs.push(dir)
    const filePath = path.join(dir, 'archive.sqlite')
    const legacy = new DatabaseSync(filePath)
    legacy.exec('PRAGMA user_version=4')
    legacy.close()

    const db = new ChatArchiveDb(filePath)
    try {
      expect((db.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(7)
      expect(db.db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type='table' AND name='devspace_trace_turn_bindings'
      `).get()).toBeTruthy()
      expect(db.db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type='index' AND name='devspace_trace_turn_verified_turn'
      `).get()).toBeTruthy()
    }
    finally {
      db.close()
    }
  })

  test('v5 database adds touched-resource lookup index in v6', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-archive-v5-upgrade-'))
    tempDirs.push(dir)
    const filePath = path.join(dir, 'archive.sqlite')
    const legacy = new DatabaseSync(filePath)
    legacy.exec(`
      CREATE TABLE resources (
        row_id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        kind TEXT NOT NULL,
        label TEXT NOT NULL,
        data_json TEXT NOT NULL
      );
      CREATE INDEX resources_conversation_kind ON resources(conversation_id, kind);
      PRAGMA user_version=5;
    `)
    legacy.close()

    const db = new ChatArchiveDb(filePath)
    try {
      expect((db.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(7)
      expect(db.db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type='index' AND name='resources_conversation_message'
      `).get()).toBeTruthy()
    }
    finally {
      db.close()
    }
  })

  test('v6 database adds covering DevSpace tool evidence index in v7', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-archive-v6-upgrade-'))
    tempDirs.push(dir)
    const filePath = path.join(dir, 'archive.sqlite')
    const legacy = new DatabaseSync(filePath)
    legacy.exec(`
      CREATE TABLE messages (
        row_id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL,
        turn_exchange_id TEXT,
        create_time REAL,
        request_id TEXT,
        text TEXT NOT NULL DEFAULT '',
        recipient TEXT
      );
      PRAGMA user_version=6;
    `)
    legacy.close()

    const db = new ChatArchiveDb(filePath)
    try {
      expect((db.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(7)
      expect(db.db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type='index' AND name='messages_tool_turn_evidence'
      `).get()).toBeTruthy()
      const plan = db.db.prepare(`
        EXPLAIN QUERY PLAN
        SELECT create_time AS createTime, request_id AS requestId, text
        FROM messages INDEXED BY messages_tool_turn_evidence
        WHERE conversation_id=? AND turn_exchange_id=?
          AND recipient='api_tool.call_tool'
          AND create_time IS NOT NULL
          AND text<>''
        ORDER BY create_time ASC
      `).all('conversation-a', 'turn-a') as Array<{ detail?: string }>
      expect(plan.map(row => String(row.detail || '')).join('\n'))
        .toContain('USING INDEX messages_tool_turn_evidence')

      // SQLite does not always print the word "COVERING" for a partial covering index in
      // EXPLAIN QUERY PLAN. Inspect the VDBE instead: opening the table cursor and emitting a
      // DeferredSeek is harmless as long as every output Column comes from the index cursor and
      // the fat messages table cursor is never actually read.
      const roots = db.db.prepare(`
        SELECT name, rootpage FROM sqlite_master
        WHERE name IN ('messages', 'messages_tool_turn_evidence')
      `).all() as Array<{ name: string, rootpage: number }>
      const tableRoot = roots.find(row => row.name === 'messages')?.rootpage
      const indexRoot = roots.find(row => row.name === 'messages_tool_turn_evidence')?.rootpage
      const bytecode = db.db.prepare(`
        EXPLAIN
        SELECT create_time AS createTime, request_id AS requestId, text
        FROM messages INDEXED BY messages_tool_turn_evidence
        WHERE conversation_id=? AND turn_exchange_id=?
          AND recipient='api_tool.call_tool'
          AND create_time IS NOT NULL
          AND text<>''
        ORDER BY create_time ASC
      `).all('conversation-a', 'turn-a') as Array<{
        opcode?: string, p1?: number, p2?: number
      }>
      const tableCursor = bytecode.find(row => row.opcode === 'OpenRead' && row.p2 === tableRoot)?.p1
      const indexCursor = bytecode.find(row => row.opcode === 'OpenRead' && row.p2 === indexRoot)?.p1
      expect(tableCursor).toBeTypeOf('number')
      expect(indexCursor).toBeTypeOf('number')
      expect(bytecode.some(row => row.opcode === 'Column' && row.p1 === tableCursor)).toBe(false)
      expect(bytecode.filter(row => row.opcode === 'Column' && row.p1 === indexCursor).length)
        .toBeGreaterThanOrEqual(3)
    }
    finally {
      db.close()
    }
  })

  test('DevSpace trace turn identity stays provisional until canonical verification and fails closed on conflicts', () => {
    const db = tempDb()
    try {
      const traceA = '6adb960d0000000089326916dcbaf36c'
      const traceB = '6adb996200000000fc77a88c525c8229'
      expect(db.observeDevSpaceTraceTurn({
        traceId: traceA,
        metadataId: 'meta-a',
        auditId: 'audit-1',
        observedAt: 1_000,
      })).toMatchObject({
        traceId: traceA,
        metadataId: 'meta-a',
        status: 'provisional',
        conversationId: null,
        turnExchangeId: null,
      })
      expect(db.observeDevSpaceTraceTurn({
        traceId: traceA,
        metadataId: 'meta-a',
        auditId: 'audit-2',
        observedAt: 2_000,
      })).toMatchObject({
        firstSeenAt: 1_000,
        lastSeenAt: 2_000,
        firstAuditId: 'audit-1',
        lastAuditId: 'audit-2',
      })

      expect(db.verifyDevSpaceTraceTurn({
        traceId: traceA,
        metadataId: 'meta-a',
        conversationId: 'conversation-a',
        turnExchangeId: 'turn-a',
        requestId: 'request-a',
        verifiedAt: 3_000,
      })).toMatchObject({
        status: 'verified',
        conversationId: 'conversation-a',
        turnExchangeId: 'turn-a',
        requestId: 'request-a',
        verifiedAt: 3_000,
      })
      expect(db.getDevSpaceTraceTurnByTurn('conversation-a', 'turn-a')?.traceId).toBe(traceA)

      db.observeDevSpaceTraceTurn({
        traceId: traceB,
        metadataId: 'meta-a',
        auditId: 'audit-3',
        observedAt: 4_000,
      })
      expect(db.verifyDevSpaceTraceTurn({
        traceId: traceB,
        metadataId: 'meta-a',
        conversationId: 'conversation-a',
        turnExchangeId: 'turn-a',
        requestId: 'request-a',
        verifiedAt: 5_000,
      })?.status).toBe('conflict')
      expect(db.getDevSpaceTraceTurnByTrace(traceA)).toMatchObject({ status: 'conflict' })
      expect(db.getDevSpaceTraceTurnByTrace(traceB)).toMatchObject({ status: 'conflict' })
    }
    finally {
      db.close()
    }
  })

  test('占位标题不能覆盖真实标题，但后续真实重命名可以更新', () => {
    expect(preferredConversationTitle('正式标题', 'New chat', 'cid')).toBe('正式标题')
    expect(preferredConversationTitle('正式标题', '新聊天', 'cid')).toBe('正式标题')
    expect(preferredConversationTitle('正式标题', 'cid', 'cid')).toBe('正式标题')
    expect(preferredConversationTitle('New chat', '后来生成的标题', 'cid')).toBe('后来生成的标题')
    expect(preferredConversationTitle('旧真实标题', '用户新标题', 'cid')).toBe('用户新标题')
  })

  test('live body 不会把已知真实标题回退成 New chat', () => {
    const db = tempDb()
    try {
      const page = (title: string, text: string) => ({
        title,
        conversation_id: 'title-monotonic',
        current_node: 'a1',
        messages: [{
          id: 'a1', author: { role: 'assistant' }, recipient: 'all', channel: 'final',
          content: { content_type: 'text', parts: [text] }, metadata: { turn_exchange_id: 'turn-1' },
        }],
      })
      db.mergeLiveMessagesPage(page('已经生成的真实标题', 'one'), { observedAt: 1000 })
      db.mergeLiveMessagesPage(page('New chat', 'two'), { observedAt: 2000 })
      expect(db.db.prepare("SELECT title FROM conversations WHERE id='title-monotonic'").get())
        .toMatchObject({ title: '已经生成的真实标题' })

      db.mergeLiveMessagesPage(page('用户后来改的新标题', 'three'), { observedAt: 3000 })
      expect(db.db.prepare("SELECT title FROM conversations WHERE id='title-monotonic'").get())
        .toMatchObject({ title: '用户后来改的新标题' })
    }
    finally {
      db.close()
    }
  })

  test('完全相同的 live message 不重写肥 row；观察事实由 conversation/evidence 承担，canonical 变化仍完整 merge', () => {
    const db = tempDb()
    try {
      const page = (status: string) => ({
        title: 'no-op merge',
        conversation_id: 'noop-merge',
        current_node: 'a1',
        messages: [{
          id: 'a1',
          author: { role: 'assistant' },
          recipient: 'all',
          channel: 'final',
          status,
          content: { content_type: 'text', parts: ['same body'] },
          metadata: { turn_exchange_id: 'turn-1' },
        }],
      })

      const firstMerge = db.mergeLiveMessagesPage(page('finished'), { observedAt: 1000 })
      expect(firstMerge.timings).toMatchObject({
        fingerprintHits: 0,
        fatRowsRead: 0,
        fingerprintWrites: 1,
      })
      expect(db.db.prepare(`
        SELECT count(*) AS n FROM message_raw_fingerprints
        WHERE conversation_id='noop-merge' AND message_id='a1'
      `).get()).toEqual({ n: 1 })
      const first = db.db.prepare(`
        SELECT raw_json AS rawJson, last_seen_at AS lastSeenAt,
               source_observed_at AS sourceObservedAt, status
        FROM messages WHERE conversation_id='noop-merge' AND message_id='a1'
      `).get() as { rawJson: string, lastSeenAt: number, sourceObservedAt: number, status: string }

      const repeatedMerge = db.mergeLiveMessagesPage(page('finished'), { observedAt: 2000 })
      expect(repeatedMerge.timings).toMatchObject({
        fingerprintHits: 1,
        fatRowsRead: 0,
        fingerprintWrites: 0,
      })
      const repeated = db.db.prepare(`
        SELECT raw_json AS rawJson, last_seen_at AS lastSeenAt,
               source_observed_at AS sourceObservedAt, status
        FROM messages WHERE conversation_id='noop-merge' AND message_id='a1'
      `).get() as { rawJson: string, lastSeenAt: number, sourceObservedAt: number, status: string }
      expect(db.db.prepare(`
        SELECT last_seen_at AS lastSeenAt, source_observed_at AS sourceObservedAt
        FROM mapping_nodes WHERE conversation_id='noop-merge' AND node_id='a1'
      `).get()).toMatchObject({ lastSeenAt: 1000, sourceObservedAt: 1000 })
      expect(repeated).toMatchObject({
        rawJson: first.rawJson,
        lastSeenAt: 1000,
        sourceObservedAt: 1000,
        status: 'finished',
      })
      expect(db.db.prepare(
        "SELECT last_seen_at AS lastSeenAt FROM conversations WHERE id='noop-merge'",
      ).get()).toMatchObject({ lastSeenAt: 2000 })
      expect(db.db.prepare(
        "SELECT count(*) AS n FROM live_observations WHERE conversation_id='noop-merge'",
      ).get()).toMatchObject({ n: 2 })

      const changedMerge = db.mergeLiveMessagesPage(page('in_progress'), { observedAt: 3000 })
      expect(changedMerge.timings.fingerprintHits).toBe(0)
      expect(changedMerge.timings.fatRowsRead).toBe(1)
      const changed = db.db.prepare(`
        SELECT raw_json AS rawJson, last_seen_at AS lastSeenAt,
               source_observed_at AS sourceObservedAt, status
        FROM messages WHERE conversation_id='noop-merge' AND message_id='a1'
      `).get() as { rawJson: string, lastSeenAt: number, sourceObservedAt: number, status: string }
      expect(changed.status).toBe('in_progress')
      expect(changed.rawJson).not.toBe(first.rawJson)
      expect(changed.lastSeenAt).toBe(3000)
      expect(changed.sourceObservedAt).toBe(3000)
    }
    finally {
      db.close()
    }
  })

  test('singular mapping 改 raw canonical 时会失效 plural fingerprint cache', () => {
    const db = tempDb()
    try {
      const plural = {
        title: 'fingerprint invalidation',
        conversation_id: 'fingerprint-invalidation',
        current_node: 'a1',
        messages: [{
          id: 'a1',
          author: { role: 'assistant' },
          recipient: 'all',
          content: { content_type: 'text', parts: ['plural version'] },
          metadata: {},
        }],
      }
      db.mergeLiveMessagesPage(plural, { observedAt: 1000 })
      expect(db.db.prepare(`
        SELECT count(*) AS n FROM message_raw_fingerprints
        WHERE conversation_id='fingerprint-invalidation'
      `).get()).toEqual({ n: 1 })

      db.mergeLiveMappingSnapshot({
        title: 'fingerprint invalidation',
        conversation_id: 'fingerprint-invalidation',
        current_node: 'a1',
        mapping: {
          root: { id: 'root', parent: null, children: ['a1'], message: null },
          a1: {
            id: 'a1', parent: 'root', children: [],
            message: {
              id: 'a1',
              author: { role: 'assistant' },
              recipient: 'all',
              content: { content_type: 'text', parts: ['mapping version'] },
              metadata: {},
            },
          },
        },
      }, { observedAt: 2000 })

      expect(db.db.prepare(`
        SELECT count(*) AS n FROM message_raw_fingerprints
        WHERE conversation_id='fingerprint-invalidation'
      `).get()).toEqual({ n: 0 })

      const merged = db.mergeLiveMessagesPage(plural, { observedAt: 3000 })
      expect(merged.timings.fingerprintHits).toBe(0)
      expect(merged.timings.fatRowsRead).toBe(1)
      expect(db.db.prepare(`
        SELECT text FROM messages
        WHERE conversation_id='fingerprint-invalidation' AND message_id='a1'
      `).get()).toEqual({ text: 'plural version' })
    }
    finally {
      db.close()
    }
  })

  test('本地并发访问使用有限 busy timeout，避免瞬时写锁立即抛错', () => {
    const db = tempDb()
    try {
      expect(db.db.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 5000 })
    }
    finally {
      db.close()
    }
  })

  test('最新 schema 的只读打开不会因另一个 writer 持锁而执行稳态 migration 写事务', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-archive-open-lock-'))
    tempDirs.push(dir)
    const file = path.join(dir, 'archive.sqlite')
    const first = new ChatArchiveDb(file)
    expect(first.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 7 })
    first.close()

    const blocker = new DatabaseSync(file)
    blocker.exec(`
      PRAGMA journal_mode=WAL;
      BEGIN IMMEDIATE;
      INSERT INTO conversations (id, title, source_format, captured_at, imported_at)
      VALUES ('lock-holder', 'lock-holder', 'test', 0, 0);
    `)
    let second: ChatArchiveDb | null = null
    try {
      // 若 migrate() 仍在稳态执行 UPDATE/DDL 写操作，这里会等待 busy_timeout 后失败；
      // 最新 schema 下应只做 schema/数据检查，因此 WAL reader 可在 writer 持锁时立即打开。
      second = new ChatArchiveDb(file)
      expect(second.db.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 5000 })
    }
    finally {
      second?.close()
      blocker.exec('ROLLBACK')
      blocker.close()
    }
  })

  test('高于当前代码的 Archive schema 必须 fail-closed，不能由旧代码降级迁移', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-archive-future-schema-'))
    tempDirs.push(dir)
    const file = path.join(dir, 'archive.sqlite')
    const first = new ChatArchiveDb(file)
    first.close()
    const newer = new DatabaseSync(file)
    newer.exec('PRAGMA user_version=999')
    newer.close()
    expect(() => new ChatArchiveDb(file)).toThrow(/newer than supported/u)
  })

  test('v1 升到当前 schema 只执行增量 delta，不重跑历史 Genesis migration', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-archive-v2-delta-'))
    tempDirs.push(dir)
    const file = path.join(dir, 'archive.sqlite')
    const legacy = new DatabaseSync(file)
    legacy.exec(`
      CREATE TABLE messages (
        row_id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL
      );
      PRAGMA user_version=1;
    `)
    legacy.close()

    const upgraded = new ChatArchiveDb(file)
    try {
      expect(upgraded.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 7 })
      const columns = upgraded.db.prepare("PRAGMA table_info('messages')").all() as Array<{ name: string }>
      expect(columns.map(column => column.name)).toContain('raw_hash')
      expect(upgraded.db.prepare(`
        SELECT 1 AS ok FROM sqlite_master
        WHERE type='table' AND name='message_raw_fingerprints'
      `).get()).toEqual({ ok: 1 })
      expect(upgraded.db.prepare(`
        SELECT 1 AS ok FROM sqlite_master
        WHERE type='table' AND name='catalog_watchdog_watermarks'
      `).get()).toEqual({ ok: 1 })
      // 若这里错误重跑旧 migrate()，conversations 等整套 Genesis schema 会被创建出来。
      expect(upgraded.db.prepare(`
        SELECT 1 AS ok FROM sqlite_master
        WHERE type='table' AND name='conversations'
      `).get()).toBeUndefined()
    }
    finally {
      upgraded.close()
    }
  })

  test('v2 到当前版本只创建窄 side tables，不回填历史 message', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-archive-v3-delta-'))
    tempDirs.push(dir)
    const file = path.join(dir, 'archive.sqlite')
    const v2 = new DatabaseSync(file)
    v2.exec(`
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY
      );
      CREATE TABLE messages (
        row_id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL,
        raw_hash TEXT,
        UNIQUE(conversation_id, message_id)
      );
      INSERT INTO conversations(id) VALUES ('legacy-cid');
      INSERT INTO messages(conversation_id, message_id, raw_hash)
      VALUES ('legacy-cid', 'legacy-message', NULL);
      PRAGMA user_version=2;
    `)
    v2.close()

    const upgraded = new ChatArchiveDb(file)
    try {
      expect(upgraded.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 7 })
      expect(upgraded.db.prepare('SELECT count(*) AS n FROM message_raw_fingerprints').get())
        .toEqual({ n: 0 })
      expect(upgraded.db.prepare('SELECT count(*) AS n FROM catalog_watchdog_watermarks').get())
        .toEqual({ n: 0 })
      expect(upgraded.db.prepare(
        "SELECT raw_hash AS rawHash FROM messages WHERE message_id='legacy-message'",
      ).get()).toEqual({ rawHash: null })
    }
    finally {
      upgraded.close()
    }
  })

  test('catalog watchdog watermark 只锁住同一 catalog update_time，update_time 变化后允许新 generation', () => {
    const db = tempDb()
    try {
      expect(db.hasCatalogWatchdogCompleted('cid-catalog', 100)).toBe(false)
      db.markCatalogWatchdogCompleted('cid-catalog', 100, 1_000)
      expect(db.hasCatalogWatchdogCompleted('cid-catalog', 100)).toBe(true)
      expect(db.hasCatalogWatchdogCompleted('cid-catalog', '100')).toBe(true)
      expect(db.hasCatalogWatchdogCompleted('cid-catalog', 101)).toBe(false)

      db.markCatalogWatchdogCompleted('cid-catalog', 101, 2_000)
      expect(db.hasCatalogWatchdogCompleted('cid-catalog', 100)).toBe(false)
      expect(db.hasCatalogWatchdogCompleted('cid-catalog', 101)).toBe(true)

      db.markCatalogWatchdogCompleted('cid-null', null, 3_000)
      expect(db.hasCatalogWatchdogCompleted('cid-null', null)).toBe(true)
      expect(db.hasCatalogWatchdogCompleted('cid-null', undefined)).toBe(true)
    }
    finally {
      db.close()
    }
  })

  test('持久化 resume token 与自动恢复退避状态', () => {
    const db = tempDb()
    try {
      const saved = db.upsertLiveResumeCredential({
        conversationId: 'cid-resume',
        turnExchangeId: 'turn-resume',
        token: 'resume-capability-value',
        resumeOffset: '42',
        tokenSha256: 'abc123',
        tokenLength: 23,
        sourceTransport: 'conversation',
        seenAt: 1000,
      })
      expect(saved).toMatchObject({
        conversationId: 'cid-resume',
        turnExchangeId: 'turn-resume',
        token: 'resume-capability-value',
        resumeOffset: '42',
        resumeAttemptCount: 0,
      })
      db.markLiveResumeAttempt({
        conversationId: 'cid-resume',
        turnExchangeId: 'turn-resume',
        attemptedAt: 2000,
        nextResumeAt: 7000,
        status: 503,
        error: 'temporary network failure',
      })
      expect(db.getLiveResumeCredential('cid-resume', 'turn-resume')).toMatchObject({
        resumeAttemptCount: 1,
        lastResumeAttemptAt: 2000,
        nextResumeAt: 7000,
        lastResumeStatus: 503,
        lastResumeError: 'temporary network failure',
      })
    }
    finally {
      db.close()
    }
  })
  test('未绑定 metadata 先形成虚拟 conversation，checkpoint/工具尾部在 binding 后原位迁移', () => {
    const db = tempDb()
    try {
      const metadataId = 'v1/virtual-meta-12345678'
      const virtualId = devSpaceVirtualConversationId(metadataId)
      const observed = db.observeDevSpaceMetadata({
        metadataId,
        auditId: 'audit-checkpoint',
        auditAt: 10_000,
        displayTitle: '虚拟会话标题',
      })
      expect(observed).toMatchObject({
        conversationId: null,
        displayTitle: '虚拟会话标题',
      })

      const checkpointArgs = JSON.stringify({
        summary: '已经确认 provisional overlay 不会污染 canonical messages。',
        next: '转入 binding E2E。',
      })
      db.upsertDevSpaceRecoveryAudit({
        auditId: 'audit-checkpoint',
        conversationId: virtualId,
        metadataId,
        tool: 'checkpoint',
        toolFingerprint: devSpaceToolArgsFingerprint('checkpoint', checkpointArgs)!,
        argsJson: checkpointArgs,
        resultJson: JSON.stringify({ structuredContent: { result: 'recorded' } }),
        startedAt: 10_000,
        finishedAt: 10_100,
        observedAt: 10_100,
      })

      const execArgs = JSON.stringify({ cmd: 'echo tail', cwd: 'D:/Workspace' })
      db.upsertDevSpaceRecoveryAudit({
        auditId: 'audit-tail',
        conversationId: virtualId,
        metadataId,
        tool: 'exec_command',
        toolFingerprint: devSpaceToolArgsFingerprint('exec_command', execArgs)!,
        argsJson: execArgs,
        startedAt: 11_000,
        observedAt: 11_000,
      })

      expect(db.listDevSpaceRecoveryVirtualConversations()).toEqual([
        expect.objectContaining({
          id: virtualId,
          title: '虚拟会话标题',
          sourceFormat: 'devspace-provisional',
          provisional: true,
          metadataId,
          provisionalState: 'running',
        }),
      ])
      const virtualMessages = db.getDevSpaceRecoveryMessages(virtualId)
      expect(virtualMessages.map(row => row.recoveryKind)).toEqual([
        'assistant-checkpoint',
        'tool-call',
      ])
      expect(virtualMessages[0]).toMatchObject({
        recoverySource: 'devspace-checkpoint',
        text: '已经确认 provisional overlay 不会污染 canonical messages。\n\n下一阶段：转入 binding E2E。',
      })

      db.bindDevSpaceMetadata({
        metadataId,
        conversationId: 'canonical-cid',
        displayTitle: '虚拟会话标题',
        evidence: 'body:exact-tool-args',
        confidence: 'high',
        observedAt: 12_000,
      })
      expect(db.rebindDevSpaceRecoveryAudits(metadataId, 'canonical-cid')).toBe(2)
      expect(db.listDevSpaceRecoveryVirtualConversations()).toHaveLength(0)
      expect(db.getDevSpaceRecoveryMessages('canonical-cid').map(row => row.recoveryKind)).toEqual([
        'assistant-checkpoint',
        'tool-call',
      ])

      // checkpoint 不做模糊覆盖：只有 canonical assistant 明确包含完整 summary 才 supersede。
      expect(db.supersedeDevSpaceCheckpointFromAssistant({
        conversationId: 'canonical-cid',
        assistantText: '阶段完成，可以继续。',
        assistantStartedAt: 10_300,
        canonicalMessageId: 'assistant-vague',
      })).toBeNull()
      expect(db.supersedeDevSpaceCheckpointFromAssistant({
        conversationId: 'canonical-cid',
        assistantText: '进展：已经确认 provisional overlay 不会污染 canonical messages。接下来继续。',
        assistantStartedAt: 10_300,
        canonicalMessageId: 'assistant-exact',
        observedAt: 13_000,
      })).toBe('audit-checkpoint')
      expect(db.getDevSpaceRecoveryMessages('canonical-cid').map(row => row.recoveryKind)).toEqual([
        'tool-call',
      ])
    }
    finally {
      db.close()
    }
  })

  test('DevSpace recovery overlay 保留 provisional tool/conclusion，并被 canonical exact match 淘汰', () => {
    const db = tempDb()
    try {
      db.mergeLiveMessagesPage({
        title: 'Recovery overlay',
        conversation_id: 'recovery-overlay',
        current_node: 'u1',
        messages: [{
          id: 'u1',
          author: { role: 'user' },
          recipient: 'all',
          content: { content_type: 'text', parts: ['开始'] },
          metadata: {},
          create_time: 1,
        }],
      }, {
        observedAt: 1000,
        updateCurrentState: true,
        classifyCompletionIncident: false,
        updateIncidents: false,
      })

      const argsJson = JSON.stringify({ cwd: 'D:/Workspace', cmd: 'git status --short' })
      const fingerprint = devSpaceToolArgsFingerprint('exec_command', argsJson)
      expect(fingerprint).toBeTruthy()
      db.upsertDevSpaceRecoveryAudit({
        auditId: 'audit-recovery-1',
        conversationId: 'recovery-overlay',
        metadataId: 'meta-recovery',
        tool: 'exec_command',
        toolFingerprint: fingerprint!,
        argsJson,
        resultJson: JSON.stringify({ structuredContent: { result: 'clean' } }),
        conclusion: '已经完成修改，现在核验仓库状态。',
        startedAt: 10_000,
        finishedAt: 11_000,
        observedAt: 12_000,
      })

      expect(db.getMessages('recovery-overlay')).toHaveLength(1)
      const overlay = db.getDevSpaceRecoveryMessages('recovery-overlay')
      expect(overlay).toHaveLength(3)
      expect(overlay.map(row => row.recoveryKind)).toEqual([
        'assistant-conclusion',
        'tool-call',
        'tool-result',
      ])
      expect(overlay[0]).toMatchObject({
        provisional: true,
        text: '已经完成修改，现在核验仓库状态。',
        auditId: 'audit-recovery-1',
      })
      expect(overlay[2]).toMatchObject({ text: 'clean', status: 'finished' })

      // 时间太远时即使 fingerprint 相同也不能误吃另一轮重复命令。
      expect(db.supersedeDevSpaceRecoveryAudit({
        conversationId: 'recovery-overlay',
        toolFingerprint: fingerprint!,
        canonicalStartedAt: 10_000 + 10 * 60_000,
        canonicalMessageId: 'tool-call-far',
      })).toBeNull()
      expect(db.getDevSpaceRecoveryMessages('recovery-overlay')).toHaveLength(3)

      expect(db.supersedeDevSpaceRecoveryAudit({
        conversationId: 'recovery-overlay',
        toolFingerprint: fingerprint!,
        canonicalStartedAt: 10_500,
        canonicalMessageId: 'tool-call-real',
        observedAt: 20_000,
      })).toBe('audit-recovery-1')
      expect(db.getDevSpaceRecoveryMessages('recovery-overlay')).toHaveLength(0)
      expect(db.listDevSpaceRecoveryAudits('recovery-overlay', true)[0]).toMatchObject({
        supersededAt: 20_000,
        supersededByMessageId: 'tool-call-real',
      })
    }
    finally {
      db.close()
    }
  })

  test('canonical-tail-gap 作为正交 incident evidence，可与 active-zombie lifecycle 并存', () => {
    const db = tempDb()
    try {
      const merged = db.mergeLiveMessagesPage({
        title: 'Tail gap evidence',
        conversation_id: 'tail-gap-cid',
        current_node: 'a-gap',
        messages: [
          {
            id: 'u-gap',
            author: { role: 'user' },
            recipient: 'all',
            content: { content_type: 'text', parts: ['开始'] },
            metadata: { turn_exchange_id: 'turn-gap' },
            create_time: 1,
          },
          {
            id: 'a-gap',
            author: { role: 'assistant' },
            recipient: 'all',
            channel: 'commentary',
            content: { content_type: 'text', parts: ['处理中'] },
            metadata: { turn_exchange_id: 'turn-gap' },
            create_time: 2,
          },
        ],
      }, {
        observedAt: 2_000,
        updateCurrentState: true,
        classifyCompletionIncident: false,
        updateIncidents: false,
      })

      const argsJson = JSON.stringify({ cmd: 'echo later' })
      db.upsertDevSpaceRecoveryAudit({
        auditId: 'audit-later-tool',
        conversationId: 'tail-gap-cid',
        metadataId: 'meta-tail-gap',
        tool: 'exec_command',
        toolFingerprint: devSpaceToolArgsFingerprint('exec_command', argsJson)!,
        argsJson,
        startedAt: 12_000,
        finishedAt: 13_000,
        observedAt: 13_000,
      })
      const checkpointArgs = JSON.stringify({ summary: '后续 checkpoint' })
      db.upsertDevSpaceRecoveryAudit({
        auditId: 'audit-later-checkpoint',
        conversationId: 'tail-gap-cid',
        metadataId: 'meta-tail-gap',
        tool: 'checkpoint',
        toolFingerprint: devSpaceToolArgsFingerprint('checkpoint', checkpointArgs)!,
        argsJson: checkpointArgs,
        startedAt: 14_000,
        finishedAt: 15_000,
        observedAt: 15_000,
      })

      const summary = db.describeDevSpaceTailGap({
        conversationId: 'tail-gap-cid',
        turnExchangeId: merged.diagnostic.turnExchangeId,
        lastMessageId: merged.diagnostic.lastMessageId,
        metadataId: 'meta-tail-gap',
        bodyCompletionEvidence: merged.diagnostic.bodyCompletionEvidence,
      })
      expect(summary).toMatchObject({
        hasTailGap: true,
        recoveryAuditCount: 2,
        recoveryToolCount: 1,
        checkpointCount: 1,
      })
      expect(summary.gapMs).toBeGreaterThanOrEqual(13_000)

      const incident = db.ensureIncidentForEvidence({
        conversationId: 'tail-gap-cid',
        diagnostic: merged.diagnostic,
        observedAt: 16_000,
        source: 'test:tail-gap',
        reason: 'canonical body 明显落后于本地执行事实',
      })
      expect(incident).toMatchObject({
        lifecycleClass: 'abnormal-terminal',
        status: 'open',
      })
      const attached = db.attachCanonicalTailGapEvidence({
        conversationId: 'tail-gap-cid',
        turnExchangeId: merged.diagnostic.turnExchangeId,
        turnKey: incident!.turnKey,
        lastMessageId: merged.diagnostic.lastMessageId,
        metadataId: 'meta-tail-gap',
        bodyCompletionEvidence: merged.diagnostic.bodyCompletionEvidence,
        observedAt: 16_000,
      })
      expect(attached.incidentId).toBe(incident!.id)
      expect(db.listIncidentEvidence(incident!.id)).toEqual([
        expect.objectContaining({ evidenceType: 'canonical-tail-gap' }),
      ])

      // 后续 catalog 证据把同一 incident 升级为 active-zombie；正交 tail-gap evidence 不被覆盖。
      db.updateIncidentFromDiagnostic(
        'tail-gap-cid',
        merged.diagnostic,
        20_000,
        true,
        true,
        'active-zombie',
        'test:catalog-active',
      )
      const updated = db.listIncidents({ status: 'open' })[0]!
      expect(updated).toMatchObject({ lifecycleClass: 'active-zombie' })
      expect(updated.evidenceTypes).toContain('canonical-tail-gap')
      expect(db.listIncidentEvidence(updated.id)).toEqual([
        expect.objectContaining({ evidenceType: 'canonical-tail-gap' }),
      ])
    }
    finally {
      db.close()
    }
  })

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
      const restarted = db.observeDevSpaceMetadata({
        metadataId: 'meta-chat-1',
        auditId: 'audit-3',
        auditAt: 5000,
      })
      expect(restarted).toMatchObject({
        firstSeenAt: 5000,
        lastSeenAt: 5000,
        unboundWatchdogAt: null,
      })
      const bound = db.bindDevSpaceMetadata({
        metadataId: 'meta-chat-1',
        conversationId: 'conversation-1',
        evidence: 'body:exact-tool-args',
        confidence: 'high',
        observedAt: 5500,
        lifecycleState: 'active',
      })
      expect(bound).toMatchObject({
        conversationId: 'conversation-1',
        firstSeenAt: 5000,
        lastSeenAt: 5000,
        boundAt: 5500,
        lifecycleState: 'active',
        unboundWatchdogAt: null,
      })
      expect(db.updateDevSpaceBindingTurn({
        conversationId: 'conversation-1',
        turnExchangeId: 'turn-1',
        requestId: 'request-1',
        observedAt: 6000,
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

  test('active watchdog 可跨 daemon 重启原样恢复并在 complete 时删除', () => {
    const db = tempDb()
    try {
      db.upsertActiveWatchdog({
        conversationId: 'conversation-watchdog',
        startedAt: 1000,
        lastEventAt: 1800,
        lastWatchdogAt: null,
        startType: 'devspace:first-tool',
        lastDiagnosticTurnKey: 'turn-a',
        updatedAt: 2000,
      })
      expect(db.listActiveWatchdogs()).toEqual([{
        conversationId: 'conversation-watchdog',
        startedAt: 1000,
        lastEventAt: 1800,
        lastWatchdogAt: null,
        watchdogPendingAt: null,
        startType: 'devspace:first-tool',
        lastDiagnosticTurnKey: 'turn-a',
        updatedAt: 2000,
      }])

      db.upsertActiveWatchdog({
        conversationId: 'conversation-watchdog',
        startedAt: 1000,
        lastEventAt: 2500,
        lastWatchdogAt: 2400,
        watchdogPendingAt: 2450,
        startType: 'devspace:first-tool',
        lastDiagnosticTurnKey: 'turn-b',
        updatedAt: 2600,
      })
      expect(db.listActiveWatchdogs()[0]).toMatchObject({
        startedAt: 1000,
        lastEventAt: 2500,
        lastWatchdogAt: 2400,
        watchdogPendingAt: 2450,
        lastDiagnosticTurnKey: 'turn-b',
      })

      db.deleteActiveWatchdog('conversation-watchdog')
      expect(db.listActiveWatchdogs()).toEqual([])
    }
    finally {
      db.close()
    }
  })

  test('DevSpace audit durable cursor 以 started_at + audit id 单调推进并可跨重启读取', () => {
    const db = tempDb()
    try {
      expect(db.getDevSpaceAuditCursor()).toBeNull()

      expect(db.advanceDevSpaceAuditCursor({
        startedAt: '2026-10-16T00:47:32.484Z',
        auditId: 'audit-a',
        updatedAt: 1000,
      })).toEqual({
        consumerKey: 'archive-daemon',
        startedAt: '2026-10-16T00:47:32.484Z',
        auditId: 'audit-a',
        updatedAt: 1000,
      })

      // 同一毫秒内必须按 audit id 继续前进，不能因为时间戳相同而漏掉第二条。
      expect(db.advanceDevSpaceAuditCursor({
        startedAt: '2026-10-16T00:47:32.484Z',
        auditId: 'audit-b',
        updatedAt: 1100,
      })).toMatchObject({ auditId: 'audit-b', updatedAt: 1100 })

      // overlap/replay 提交旧游标时必须保持单调，不得把 durable 高水位倒退。
      expect(db.advanceDevSpaceAuditCursor({
        startedAt: '2026-10-16T00:47:31.999Z',
        auditId: 'audit-z',
        updatedAt: 9999,
      })).toEqual({
        consumerKey: 'archive-daemon',
        startedAt: '2026-10-16T00:47:32.484Z',
        auditId: 'audit-b',
        updatedAt: 1100,
      })
    }
    finally {
      db.close()
    }
  })

  test('未完成 DevSpace recovery audit 可在 daemon 重启后枚举并按 finish 回填', () => {
    const db = tempDb()
    try {
      db.upsertDevSpaceRecoveryAudit({
        auditId: 'audit-running',
        conversationId: 'conversation-a',
        metadataId: 'meta-a',
        tool: 'exec_command',
        toolFingerprint: 'exec_command\n{}',
        argsJson: '{}',
        resultJson: null,
        error: null,
        conclusion: null,
        startedAt: 1000,
        finishedAt: null,
        observedAt: 1100,
      })
      db.upsertDevSpaceRecoveryAudit({
        auditId: 'audit-done',
        conversationId: 'conversation-a',
        metadataId: 'meta-a',
        tool: 'read',
        toolFingerprint: 'read\n{}',
        argsJson: '{}',
        resultJson: '{"ok":true}',
        error: null,
        conclusion: null,
        startedAt: 1200,
        finishedAt: 1300,
        observedAt: 1400,
      })
      expect(db.listPendingDevSpaceRecoveryAuditIds()).toEqual(['audit-running'])
    }
    finally {
      db.close()
    }
  })

  test('turn notification ledger 只记录成功发送事实并可跨重启去重', () => {
    const db = tempDb()
    try {
      expect(db.hasTurnNotification('turn-final:conversation-a:turn-a')).toBe(false)
      db.markTurnNotificationSent({
        notificationKey: 'turn-final:conversation-a:turn-a',
        kind: 'turn-final',
        conversationId: 'conversation-a',
        turnKey: 'turn-a',
        sentAt: 1234,
        providerStatus: 200,
        payload: { title: 'ChatGPT 正常完成', body: '会话 A' },
      })
      expect(db.hasTurnNotification('turn-final:conversation-a:turn-a')).toBe(true)
      expect(db.getTurnNotification('turn-final:conversation-a:turn-a')).toMatchObject({
        notificationKey: 'turn-final:conversation-a:turn-a',
        kind: 'turn-final',
        conversationId: 'conversation-a',
        turnKey: 'turn-a',
        sentAt: 1234,
        providerStatus: 200,
      })

      // INSERT OR IGNORE 保留第一条成功发送事实；重复 WSS complete/settle 不会覆盖或重发。
      db.markTurnNotificationSent({
        notificationKey: 'turn-final:conversation-a:turn-a',
        kind: 'turn-final',
        conversationId: 'conversation-a',
        turnKey: 'turn-a',
        sentAt: 9999,
        providerStatus: 201,
        payload: { title: 'duplicate' },
      })
      expect(db.getTurnNotification('turn-final:conversation-a:turn-a')).toMatchObject({
        sentAt: 1234,
        providerStatus: 200,
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
        bigramIndexedMessageCount: 2,
      })
      const alignedFts = db.db.prepare(`
        SELECT count(*) AS n
        FROM message_fts f
        JOIN messages m
          ON m.row_id = f.rowid
         AND m.conversation_id = f.conversation_id
         AND m.message_id = f.message_id
      `).get() as { n: number }
      expect(Number(alignedFts.n)).toBe(2)
    }
    finally {
      db.close()
    }
  })

  test('Conversation-first 搜索：两字中文不再全表 LIKE，长中文走 trigram，英文走 unicode FTS', () => {
    const db = tempDb()
    try {
      db.importRaw(payload())

      const shortCn = db.searchConversations('三峡')
      expect(shortCn.length).toBeGreaterThan(0)
      expect(shortCn.some(hit => hit.conversationId === 'conversation-cn')).toBe(true)
      expect(shortCn[0]).toMatchObject({ hitCount: 2, titleMatched: true })
      expect(shortCn[0]?.snippets.length).toBeGreaterThan(0)

      const singleCn = db.searchConversations('峡')
      expect(singleCn.some(hit => hit.conversationId === 'conversation-cn')).toBe(true)
      expect(singleCn.find(hit => hit.conversationId === 'conversation-cn')?.snippets[0]?.text).toContain('[峡]')

      const longCn = db.searchConversations('长江三峡')
      expect(longCn.length).toBeGreaterThan(0)
      expect(longCn[0]?.snippets[0]?.text).toContain('[长江三峡]')

      const english = db.searchConversations('Trip')
      expect(english.length).toBeGreaterThan(0)
      expect(english[0]?.snippets[0]?.text).toContain('[Trip]')

      const rawMessages = db.searchMessages('Trip', 1)
      expect(rawMessages).toHaveLength(1)
      expect(rawMessages[0]?.text).toContain('[Trip]')
    }
    finally {
      db.close()
    }
  })

  test('旧库可单独补建 bigram 索引，不必重建其余 FTS', () => {
    const db = tempDb()
    try {
      db.importRaw(payload())
      db.db.exec('DELETE FROM message_fts_bigram')
      // `三峡` 同时出现在标题里，清空正文 bigram 后仍会正确命中标题；
      // 因此这里用只存在于正文中的两字词 `游轮` 验证旧库补索引。
      expect(db.searchConversations('游轮')).toHaveLength(0)

      const rebuilt = db.rebuildBigramSearchIndex()
      expect(rebuilt).toBe(2)
      expect(db.searchConversations('游轮').some(row => row.conversationId === 'conversation-cn')).toBe(true)
    }
    finally {
      db.close()
    }
  })

  test('Conversation limit 不会被单个高频聊天的 message hit 吃光，并支持 frequency/recent 排序', () => {
    const db = tempDb()
    try {
      const makeConversation = (id: string, title: string, capturedAt: number, count: number) => ({
        title,
        conversation_id: id,
        create_time: capturedAt,
        update_time: capturedAt,
        current_node: `${id}-a-${count - 1}`,
        messages: Array.from({ length: count }, (_, index) => ({
          id: `${id}-a-${index}`,
          author: { role: 'assistant' },
          recipient: 'all',
          create_time: capturedAt + index,
          content: { content_type: 'text', parts: [`共同关键词 LifeOps 第 ${index} 条`] },
          metadata: {},
        })),
      })
      db.importRaw(makeConversation('many-hits', '高频聊天', 100, 12), 100)
      db.importRaw(makeConversation('few-new', '较新聊天', 300, 2), 300)
      db.importRaw(makeConversation('few-old', '较旧聊天', 200, 1), 200)

      const relevance = db.searchConversations('LifeOps', { limit: 3, snippetsPerConversation: 2 })
      expect(relevance.map(row => row.conversationId)).toEqual(expect.arrayContaining(['many-hits', 'few-new', 'few-old']))
      expect(relevance.find(row => row.conversationId === 'many-hits')).toMatchObject({ hitCount: 12 })
      expect(relevance.find(row => row.conversationId === 'many-hits')?.snippets).toHaveLength(2)

      const frequency = db.searchConversations('LifeOps', { limit: 3, sort: 'frequency' })
      expect(frequency[0]?.conversationId).toBe('many-hits')

      const recent = db.searchConversations('LifeOps', { limit: 3, sort: 'recent' })
      expect(recent[0]?.conversationId).toBe('few-new')
    }
    finally {
      db.close()
    }
  })

  test('只索引可读正文，但仍保存 tool/resource 审计层', () => {
    const db = tempDb()
    try {
      db.importRaw(payload())
      expect(db.searchConversations('query')).toHaveLength(0)
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
      }, { observedAt: 1234, classifyCompletionIncident: true, allowIncompleteTailIncident: true })

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

      const merged = db.mergeLiveMessagesPage(live, { observedAt: 1234, classifyCompletionIncident: true })
      expect(merged.newMessageCount).toBe(2)
      expect(db.getMessages('conversation-cn').map(item => item.messageId)).toEqual(
        expect.arrayContaining(['u1', 'tool-call', 'a2', 'u3', 'a3']),
      )
      expect(db.searchConversations('重庆').some(hit => hit.conversationId === 'conversation-cn')).toBe(true)
      expect(db.db.prepare('SELECT count(*) AS n FROM live_observations').get()).toMatchObject({ n: 1 })
      expect(db.listIncidents({ status: 'open' })).toHaveLength(0)
    }
    finally {
      db.close()
    }
  })

  test('外置 Evidence durable 后，canonical body/mapping 可跳过 legacy live_observations BLOB', async () => {
    const db = tempDb()
    try {
      const live = {
        title: 'External evidence fixture',
        conversation_id: 'external-evidence-chat',
        current_node: 'assistant-1',
        messages: [
          {
            id: 'user-1',
            author: { role: 'user' },
            recipient: 'all',
            content: { content_type: 'text', parts: ['问题'] },
            metadata: { turn_exchange_id: 'turn-1' },
          },
          {
            id: 'assistant-1',
            author: { role: 'assistant' },
            recipient: 'all',
            channel: 'final',
            content: { content_type: 'text', parts: ['回答'] },
            metadata: { turn_exchange_id: 'turn-1' },
          },
        ],
      }
      const preparedBody = await prepareArchiveEvidence(live)
      const merged = db.mergeLiveMessagesPage(live, {
        observedAt: 1000,
        preparedObservation: preparedBody,
        skipLegacyObservation: true,
      })
      expect(merged.newMessageCount).toBe(2)
      expect(db.getMessages('external-evidence-chat')).toHaveLength(2)
      expect(db.db.prepare('SELECT count(*) AS n FROM live_observations').get()).toMatchObject({ n: 0 })

      const mapping = {
        title: 'External evidence fixture',
        conversation_id: 'external-evidence-chat',
        current_node: 'assistant-1',
        mapping: {
          root: { id: 'root', parent: null, children: ['user-1'], message: null },
          'user-1': {
            id: 'user-1', parent: 'root', children: ['assistant-1'],
            message: live.messages[0],
          },
          'assistant-1': {
            id: 'assistant-1', parent: 'user-1', children: [],
            message: live.messages[1],
          },
        },
      }
      const preparedMapping = await prepareArchiveEvidence(mapping)
      const mapped = db.mergeLiveMappingSnapshot(mapping, {
        observedAt: 2000,
        observationKind: 'mapping-snapshot:test-external',
        preparedObservation: preparedMapping,
        skipLegacyObservation: true,
      })
      expect(mapped.nodeCount).toBe(3)
      expect(db.db.prepare('SELECT count(*) AS n FROM live_observations').get()).toMatchObject({ n: 0 })
      expect(db.db.prepare(`
        SELECT parent_id AS parentId, parent_source AS parentSource
        FROM mapping_nodes
        WHERE conversation_id='external-evidence-chat' AND node_id='assistant-1'
      `).get()).toMatchObject({
        parentId: 'user-1',
        parentSource: 'live-singular-mapping',
      })
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
      }, { observedAt: 1000, classifyCompletionIncident: true })

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
        classifyCompletionIncident: false,
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

  test('同一 message_id 的滞后 body 只带更短文本前缀时，不得回吃 SSE 已观察到的更长正文', () => {
    const db = tempDb()
    try {
      db.mergeLiveMessagesPage({
        title: 'Monotonic live evidence fixture',
        conversation_id: 'monotonic-live-evidence',
        messages: [
          {
            id: 'assistant-1',
            author: { role: 'assistant' },
            recipient: 'all',
            channel: 'final',
            status: 'in_progress',
            end_turn: null,
            content: { content_type: 'text', parts: ['已经由 SSE 看到的完整一些的正文'] },
            metadata: { turn_exchange_id: 'turn-1', request_id: 'req-1' },
          },
        ],
      }, {
        observedAt: 1000,
        observationKind: 'live-sse-partial',
        updateCurrentState: false,
        updateIncidents: false,
        preserveObservedTextPrefix: true,
      })

      db.mergeLiveMessagesPage({
        title: 'Monotonic live evidence fixture',
        conversation_id: 'monotonic-live-evidence',
        current_node: 'assistant-1',
        messages: [
          {
            id: 'assistant-1',
            author: { role: 'assistant' },
            recipient: 'all',
            channel: 'final',
            status: 'finished_successfully',
            end_turn: true,
            content: { content_type: 'text', parts: ['已经由 SSE 看到的'] },
            metadata: { turn_exchange_id: 'turn-1', request_id: 'req-1', body_checkpoint: true },
          },
        ],
      }, {
        observedAt: 2000,
        observationKind: 'body-page:test',
        preserveObservedTextPrefix: true,
      })

      const row = db.db.prepare(`
        SELECT text, status, end_turn AS endTurn, content_json AS contentJson, metadata_json AS metadataJson
        FROM messages
        WHERE conversation_id = 'monotonic-live-evidence' AND message_id = 'assistant-1'
      `).get() as {
        text: string
        status: string
        endTurn: number
        contentJson: string
        metadataJson: string
      }
      expect(row.text).toBe('已经由 SSE 看到的完整一些的正文')
      expect(row.status).toBe('finished_successfully')
      expect(row.endTurn).toBe(1)
      expect(JSON.parse(row.contentJson)).toMatchObject({
        parts: ['已经由 SSE 看到的完整一些的正文'],
      })
      expect(JSON.parse(row.metadataJson)).toMatchObject({ body_checkpoint: true })
      expect(db.list(10).find(item => item.id === 'monotonic-live-evidence')?.currentNode).toBe('assistant-1')

      // 新 payload 若真正比现有正文更长，应正常前进，不被“保护旧证据”反向锁死。
      db.mergeLiveMessagesPage({
        title: 'Monotonic live evidence fixture',
        conversation_id: 'monotonic-live-evidence',
        current_node: 'assistant-1',
        messages: [
          {
            id: 'assistant-1',
            author: { role: 'assistant' },
            recipient: 'all',
            channel: 'final',
            status: 'finished_successfully',
            end_turn: true,
            content: { content_type: 'text', parts: ['已经由 SSE 看到的完整一些的正文，以及后来 Body 新增的结尾'] },
            metadata: { turn_exchange_id: 'turn-1', request_id: 'req-1' },
          },
        ],
      }, {
        observedAt: 3000,
        preserveObservedTextPrefix: true,
      })
      expect(
        db.db.prepare(`
          SELECT text FROM messages
          WHERE conversation_id = 'monotonic-live-evidence' AND message_id = 'assistant-1'
        `).get(),
      ).toMatchObject({
        text: '已经由 SSE 看到的完整一些的正文，以及后来 Body 新增的结尾',
      })
    }
    finally {
      db.close()
    }
  })

  test('sparse plural/singular snapshots preserve existing turn/request identity', () => {
    const db = tempDb()
    try {
      db.mergeLiveMessagesPage({
        title: 'Sparse identity fixture',
        conversation_id: 'sparse-identity',
        current_node: 'assistant-1',
        messages: [{
          id: 'assistant-1', author: { role: 'assistant' }, recipient: 'all', channel: 'commentary',
          create_time: 1,
          status: 'finished_successfully', end_turn: true,
          content: { content_type: 'text', parts: ['first'] },
          metadata: {
            turn_exchange_id: 'turn-stable', request_id: 'req-stable',
            finish_details: { type: 'stop' },
          },
        }],
      }, { observedAt: 1000 })

      db.mergeLiveMappingSnapshot({
        title: 'Sparse identity fixture',
        conversation_id: 'sparse-identity',
        current_node: 'assistant-1',
        mapping: {
          'assistant-1': {
            id: 'assistant-1', parent: null, children: [],
            message: {
              id: 'assistant-1', author: { role: 'assistant' }, recipient: 'all', channel: 'commentary',
              create_time: 1,
              content: { content_type: 'text', parts: ['second'] },
              metadata: {},
            },
          },
        },
      }, { observedAt: 2000, observationKind: 'sparse-identity:singular' })

      db.mergeLiveMessagesPage({
        title: 'Sparse identity fixture',
        conversation_id: 'sparse-identity',
        current_node: 'assistant-1',
        messages: [{
          id: 'assistant-1', author: { role: 'assistant' }, recipient: 'all', channel: 'commentary',
          create_time: 1,
          content: { content_type: 'text', parts: ['third'] },
          metadata: {},
        }],
      }, { observedAt: 3000 })

      expect(db.db.prepare(`
        SELECT turn_exchange_id AS turnId, request_id AS requestId,
               status, end_turn AS endTurn, finish_type AS finishType
        FROM messages
        WHERE conversation_id='sparse-identity' AND message_id='assistant-1'
      `).get()).toEqual({
        turnId: 'turn-stable', requestId: 'req-stable',
        status: 'finished_successfully', endTurn: 1, finishType: 'stop',
      })

      db.mergeLiveMappingSnapshot({
        title: 'Sparse identity fixture',
        conversation_id: 'sparse-identity',
        current_node: 'assistant-1',
        mapping: {
          'assistant-1': {
            id: 'assistant-1', parent: null, children: [],
            message: {
              id: 'assistant-1', author: { role: 'assistant' }, recipient: 'all', channel: 'commentary',
              create_time: 1,
              status: 'in_progress', end_turn: false,
              content: { content_type: 'text', parts: ['fourth'] },
              metadata: {
                turn_exchange_id: 'turn-new', request_id: 'req-new',
                finish_details: { type: 'interrupted' },
              },
            },
          },
        },
      }, { observedAt: 4000, observationKind: 'sparse-identity:explicit-update' })

      expect(db.db.prepare(`
        SELECT turn_exchange_id AS turnId, request_id AS requestId,
               status, end_turn AS endTurn, finish_type AS finishType
        FROM messages
        WHERE conversation_id='sparse-identity' AND message_id='assistant-1'
      `).get()).toEqual({
        turnId: 'turn-new', requestId: 'req-new',
        status: 'in_progress', endTurn: 0, finishType: 'interrupted',
      })
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
      db.mergeLiveMessagesPage(broken, { classifyCompletionIncident: true, observedAt: 1000 })
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
      db.mergeLiveMessagesPage(recovered, { classifyCompletionIncident: true, observedAt: 2000 })
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
        classifyCompletionIncident: true,
        allowIncompleteTailIncident: false,
      })
      expect(db.listIncidents({ status: 'open' })).toHaveLength(0)

      // 收到 WSS conversation-turn-complete 后，上层会把 allowIncompleteTailIncident 打开；
      // 此时同一个结构性尾型才成为 confirmed complete-no-final 的异常账目。
      db.mergeLiveMessagesPage(contextOnly, {
        observedAt: 2000,
        classifyCompletionIncident: true,
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
        classifyCompletionIncident: true,
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
      }, { observedAt: 1000, classifyCompletionIncident: false })
      db.mergeLiveMessagesPage({
        title: 'rollback', conversation_id: 'rollback-incident', current_node: 'b', messages,
      }, { observedAt: 2000, classifyCompletionIncident: false })
      db.mergeLiveMessagesPage({
        title: 'rollback', conversation_id: 'rollback-incident', current_node: 'a', messages,
      }, {
        observedAt: 3000,
        classifyCompletionIncident: true,
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
        classifyCompletionIncident: true,
        allowIncompleteTailIncident: true,
        observationKind: 'body-page:wss:conversation-turn-complete',
      })
      db.db.prepare(`
        UPDATE incidents
        SET tail_shape='other', reason='legacy other', diagnostic_json='{}'
        WHERE conversation_id='incident-refresh' AND turn_key='turn-refresh'
      `).run()

      // startup/reconnect 不是新的 completion trigger，因此 classifyCompletionIncident=false。
      // 它只能刷新已经存在的同 turn incident，不能把 source 改成 reconcile。
      db.mergeLiveMessagesPage(contextOnly, {
        observedAt: 2000,
        classifyCompletionIncident: false,
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
        classifyCompletionIncident: false,
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
        classifyCompletionIncident: true,
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
        classifyCompletionIncident: true,
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
        classifyCompletionIncident: true,
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
        classifyCompletionIncident: false,
        updateCurrentState: false,
      })

      expect(db.db.prepare(`
        SELECT current_node AS currentNode, terminal_state AS bodyCompletionState,
               incident_state AS incidentState, title
        FROM conversations WHERE id='page-state'
      `).get()).toMatchObject({
        currentNode: 'tool-result',
        bodyCompletionState: 'none',
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
        classifyCompletionIncident: true,
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
      db.mergeLiveMessagesPage(interrupted, { observedAt: 1100, classifyCompletionIncident: true })
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
      // Body 诊断不能把已经确认的 explicit interrupted 降回 bodyCompletionEvidence=none。
      db.mergeLiveMessagesPage(timedOut, {
        observedAt: 1200,
        classifyCompletionIncident: false,
        observationKind: 'body-page:reconcile:startup',
      })
      expect(db.listIncidents()[0]).toMatchObject({
        id: firstId,
        lifecycleClass: 'explicit-interrupted',
        bodyCompletionEvidence: 'client-stopped',
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
        classifyCompletionIncident: true,
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
        classifyCompletionIncident: true,
        allowIncompleteTailIncident: true,
        incidentKind: 'active-zombie',
      })

      const incident = db.listIncidents({ status: 'open' })[0]
      expect(incident).toMatchObject({
        turnKey: 'turn-zombie',
        incidentKind: 'active-zombie',
        lifecycleClass: 'active-zombie',
        bodyCompletionEvidence: 'none',
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
        classifyCompletionIncident: true,
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
        classifyCompletionIncident: false,
        observationKind: 'cursor-page',
      })

      const open = db.listIncidents({ status: 'open' })
      const resolved = db.listIncidents({ status: 'resolved' })
      expect(open).toHaveLength(1)
      expect(open[0]).toMatchObject({ turnKey: 'turn-new', incidentKind: 'watchdog-timeout' })
      expect(resolved).toHaveLength(1)
      expect(resolved[0]).toMatchObject({
        turnKey: 'turn-old',
        incidentKind: 'abnormal-terminal',
        lifecycleClass: 'abnormal-terminal',
        bodyCompletionEvidence: 'none',
      })
      expect(resolved[0]?.reason).toContain('历史 turn 后续已经出现更新的 user turn')
      expect(resolved[0]?.reason).toContain('未观察到该 turn 的 conversation-turn-complete 证据')

      const currentState = db.db.prepare(`
        SELECT current_node AS currentNode, terminal_state AS bodyCompletionState,
               incident_state AS incidentState, title
        FROM conversations WHERE id='historical-turn-ledger'
      `).get()
      expect(currentState).toMatchObject({
        currentNode: 'r-new',
        bodyCompletionState: 'none',
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

  test('历史 turn 补账只 resolve 已有 Active Zombie，不得把 lifecycle/source 降级成 abnormal-terminal', () => {
    const db = tempDb()
    try {
      db.mergeLiveMessagesPage({
        title: '历史 Active Zombie 保真',
        conversation_id: 'historical-active-zombie-preserve',
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
            metadata: { turn_exchange_id: 'turn-old' },
          },
          {
            id: 'tool-old', author: { role: 'tool' }, recipient: 'all',
            content: { content_type: 'code', text: '{"ok":true}' },
            metadata: { turn_exchange_id: 'turn-old' },
          },
        ],
      }, {
        observedAt: 1000,
        classifyCompletionIncident: true,
        allowIncompleteTailIncident: true,
        incidentKind: 'active-zombie',
        observationKind: 'body-page:watchdog:active-timeout',
      })

      const before = db.listIncidents({ status: 'open' })[0]
      expect(before).toMatchObject({
        turnKey: 'turn-old',
        incidentKind: 'active-zombie',
        lifecycleClass: 'active-zombie',
        source: 'body-page:watchdog:active-timeout',
      })

      db.mergeLiveMessagesPage({
        title: '历史 Active Zombie 保真',
        conversation_id: 'historical-active-zombie-preserve',
        current_node: 'final-new',
        messages: [
          {
            id: 'u-old', author: { role: 'user' }, recipient: 'all',
            content: { content_type: 'text', parts: ['旧轮'] },
            metadata: { turn_exchange_id: 'turn-old' },
          },
          {
            id: 'tool-old', author: { role: 'tool' }, recipient: 'all',
            content: { content_type: 'code', text: '{"ok":true}' },
            metadata: { turn_exchange_id: 'turn-old' },
          },
          {
            id: 'u-new', author: { role: 'user' }, recipient: 'all',
            content: { content_type: 'text', parts: ['新轮'] },
            metadata: { turn_exchange_id: 'turn-new' },
          },
          {
            id: 'final-new', author: { role: 'assistant' }, recipient: 'all',
            content: { content_type: 'text', parts: ['完成'] },
            status: 'finished_successfully', end_turn: true,
            metadata: { turn_exchange_id: 'turn-new', finish_details: { type: 'stop' } },
          },
        ],
      }, {
        observedAt: 2000,
        classifyCompletionIncident: true,
        observationKind: 'passive-native',
        updateCurrentState: true,
      })

      const resolved = db.listIncidents({ status: 'resolved' })
        .find(incident => incident.turnKey === 'turn-old')
      expect(resolved).toMatchObject({
        id: before?.id,
        incidentKind: 'active-zombie',
        lifecycleClass: 'active-zombie',
        source: 'body-page:watchdog:active-timeout',
        status: 'resolved',
      })
      expect(resolved?.reason).toContain('conversation list 持续保持 active')
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
        classifyCompletionIncident: true,
        allowIncompleteTailIncident: true,
      })

      expect(db.listIncidents()).toHaveLength(0)
    }
    finally {
      db.close()
    }
  })

  test('DevSpace binding evidence queue dedupes unchanged turns and persists match state', () => {
    const db = tempDb()
    try {
      const first = db.upsertDevSpaceBindingTurnEvidence({
        conversationId: 'queue-cid',
        turnExchangeId: 'queue-turn',
        firstToolAt: 10_000,
        lastToolAt: 12_000,
        toolCallCount: 3,
        evidenceRevision: 'rev-a',
        observedAt: 20_000,
      })
      expect(first.created).toBe(true)
      expect(first.changed).toBe(true)
      expect(first.row).toMatchObject({
        status: 'pending',
        firstQueuedAt: 20_000,
        lastQueuedAt: 20_000,
        attemptCount: 0,
      })

      db.markDevSpaceBindingTurnEvidenceAttempt(
        'queue-cid',
        'queue-turn',
        21_000,
        'rev-a',
        'meta-rev-a',
      )
      const unchanged = db.upsertDevSpaceBindingTurnEvidence({
        conversationId: 'queue-cid',
        turnExchangeId: 'queue-turn',
        firstToolAt: 10_000,
        lastToolAt: 12_000,
        toolCallCount: 3,
        evidenceRevision: 'rev-a',
        observedAt: 30_000,
      })
      expect(unchanged.changed).toBe(false)
      expect(unchanged.row).toMatchObject({
        lastQueuedAt: 20_000,
        lastAttemptAt: 21_000,
        attemptCount: 1,
        lastAttemptEvidenceRevision: 'rev-a',
        lastAttemptMetadataRevision: 'meta-rev-a',
      })

      const changed = db.upsertDevSpaceBindingTurnEvidence({
        conversationId: 'queue-cid',
        turnExchangeId: 'queue-turn',
        firstToolAt: 10_000,
        lastToolAt: 13_000,
        toolCallCount: 4,
        evidenceRevision: 'rev-b',
        observedAt: 31_000,
      })
      expect(changed.changed).toBe(true)
      expect(changed.row).toMatchObject({
        lastQueuedAt: 31_000,
        evidenceRevision: 'rev-b',
        toolCallCount: 4,
      })
      expect(db.listPendingDevSpaceBindingTurnEvidence({
        overlapStartAt: 11_500,
        overlapEndAt: 11_500,
      })).toHaveLength(1)
      expect(db.listPendingDevSpaceBindingTurnEvidence({
        overlapStartAt: 50_000,
        overlapEndAt: 60_000,
      })).toHaveLength(0)

      db.markDevSpaceBindingTurnEvidenceMatched({
        conversationId: 'queue-cid',
        turnExchangeId: 'queue-turn',
        metadataId: 'meta-queue',
        matchedAt: 32_000,
        evidenceRevision: 'rev-b',
        metadataRevision: 'meta-rev-b',
      })
      expect(db.getDevSpaceBindingTurnEvidence('queue-cid', 'queue-turn')).toMatchObject({
        status: 'matched',
        matchedMetadataId: 'meta-queue',
        attemptCount: 2,
        lastAttemptEvidenceRevision: 'rev-b',
        lastAttemptMetadataRevision: 'meta-rev-b',
      })
      expect(db.listPendingDevSpaceBindingTurnEvidence()).toHaveLength(0)
    }
    finally {
      db.close()
    }
  })

})
