import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { adaptConversation } from '../core/adapter.ts'
import { buildRichManifest } from '../core/manifest.ts'
import { conversationToMarkdown } from '../core/markdown.ts'
import type { CanonicalConversation } from '../core/types.ts'

export interface ArchiveImportResult {
  conversationId: string
  title: string
  messageCount: number
  visibleMessageCount: number
  resourceCount: number
  sourceFormat: 'messages' | 'mapping'
}

export interface ArchiveSearchHit {
  conversationId: string
  messageId: string
  title: string
  role: string
  text: string
  rank: number
}

export interface ArchiveConversationRow {
  id: string
  title: string
  sourceFormat: string
  currentNode: string | null
  capturedAt: number
  importedAt: number
  messageCount: number
  resourceCount: number
}

function ensureParentDir(filePath: string): void {
  mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true })
}

function json(value: unknown): string {
  return JSON.stringify(value)
}

function visibleForMarkdown(conversation: CanonicalConversation): boolean {
  return conversation.messages.some(message =>
    !message.hidden
    && (message.role === 'user' || message.role === 'assistant')
    && message.recipient === 'all'
    && message.text.trim().length > 0,
  )
}

/**
 * 本地 ChatGPT 归档数据库。
 *
 * 设计重点：
 * - 原始 ChatGPT 私有 schema 不成为本地查询契约；先走 canonical adapter。
 * - SQLite 保存规范化 message/resource，原始 snapshot 由上层文件仓库独立保存。
 * - FTS 只索引可读 User/Assistant 正文，不把巨大 tool result、connector JSON、raw CoT
 *   塞进全文索引；这些仍可从 message/resource 表按需审计。
 */
export class ChatArchiveDb {
  readonly db: DatabaseSync
  readonly filePath: string

  constructor(filePath: string) {
    this.filePath = filePath
    ensureParentDir(filePath)
    this.db = new DatabaseSync(filePath)
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL;')
    this.migrate()
  }

  close(): void {
    this.db.close()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        source_format TEXT NOT NULL,
        current_node TEXT,
        captured_at INTEGER NOT NULL,
        imported_at INTEGER NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0,
        resource_count INTEGER NOT NULL DEFAULT 0,
        markdown TEXT NOT NULL DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS messages (
        row_id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        role TEXT NOT NULL,
        author_name TEXT,
        recipient TEXT NOT NULL,
        channel TEXT,
        content_type TEXT NOT NULL,
        text TEXT NOT NULL,
        hidden INTEGER NOT NULL,
        create_time REAL,
        metadata_json TEXT NOT NULL,
        UNIQUE(conversation_id, message_id)
      );

      CREATE INDEX IF NOT EXISTS messages_conversation_ordinal
        ON messages(conversation_id, ordinal);

      CREATE TABLE IF NOT EXISTS resources (
        row_id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        kind TEXT NOT NULL,
        label TEXT NOT NULL,
        data_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS resources_conversation_kind
        ON resources(conversation_id, kind);

      CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(
        conversation_id UNINDEXED,
        message_id UNINDEXED,
        title,
        role UNINDEXED,
        text,
        tokenize='unicode61'
      );

      -- unicode61 适合英文单词，但不会把连续中文切成任意可搜索短语。
      -- trigram 专门补中文/任意子串；两字符查询再由 LIKE fallback 兜底。
      CREATE VIRTUAL TABLE IF NOT EXISTS message_fts_trigram USING fts5(
        conversation_id UNINDEXED,
        message_id UNINDEXED,
        title,
        role UNINDEXED,
        text,
        tokenize='trigram'
      );
    `)
  }

  importRaw(payload: unknown, capturedAt = Date.now()): ArchiveImportResult {
    const conversation = adaptConversation(payload)
    const conversationId = conversation.conversationId
    if (!conversationId) throw new Error('Conversation payload has no conversation_id')

    const manifest = buildRichManifest(conversation)
    const markdown = visibleForMarkdown(conversation) ? conversationToMarkdown(conversation) : ''
    const now = Date.now()
    const visibleMessages = conversation.messages.filter(message =>
      !message.hidden
      && (message.role === 'user' || message.role === 'assistant')
      && message.recipient === 'all'
      && message.text.trim().length > 0,
    )

    const upsertConversation = this.db.prepare(`
      INSERT INTO conversations (
        id, title, source_format, current_node, captured_at, imported_at,
        message_count, resource_count, markdown
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title=excluded.title,
        source_format=excluded.source_format,
        current_node=excluded.current_node,
        captured_at=excluded.captured_at,
        imported_at=excluded.imported_at,
        message_count=excluded.message_count,
        resource_count=excluded.resource_count,
        markdown=excluded.markdown
    `)
    const insertMessage = this.db.prepare(`
      INSERT INTO messages (
        conversation_id, message_id, ordinal, role, author_name, recipient,
        channel, content_type, text, hidden, create_time, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const insertResource = this.db.prepare(`
      INSERT INTO resources (
        conversation_id, message_id, ordinal, kind, label, data_json
      ) VALUES (?, ?, ?, ?, ?, ?)
    `)
    const insertFts = this.db.prepare(`
      INSERT INTO message_fts (conversation_id, message_id, title, role, text)
      VALUES (?, ?, ?, ?, ?)
    `)
    const insertTrigram = this.db.prepare(`
      INSERT INTO message_fts_trigram (conversation_id, message_id, title, role, text)
      VALUES (?, ?, ?, ?, ?)
    `)

    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('DELETE FROM message_fts WHERE conversation_id = ?').run(conversationId)
      this.db.prepare('DELETE FROM message_fts_trigram WHERE conversation_id = ?').run(conversationId)
      // conversations 的 ON DELETE CASCADE 会清理旧 messages/resources；随后同 ID 重建最新 snapshot。
      this.db.prepare('DELETE FROM conversations WHERE id = ?').run(conversationId)
      upsertConversation.run(
        conversationId,
        conversation.title,
        conversation.sourceFormat,
        conversation.currentNode ?? null,
        capturedAt,
        now,
        conversation.messages.length,
        manifest.items.length,
        markdown,
      )

      conversation.messages.forEach((message, ordinal) => {
        insertMessage.run(
          conversationId,
          message.id,
          ordinal,
          message.role,
          message.authorName ?? null,
          message.recipient,
          message.channel ?? null,
          message.contentType,
          message.text,
          message.hidden ? 1 : 0,
          message.createTime ?? null,
          json(message.metadata),
        )
      })

      manifest.items.forEach((item, ordinal) => {
        insertResource.run(
          conversationId,
          item.messageId,
          ordinal,
          item.kind,
          item.label,
          json(item.data),
        )
      })

      visibleMessages.forEach((message) => {
        insertFts.run(
          conversationId,
          message.id,
          conversation.title,
          message.role,
          message.text,
        )
        insertTrigram.run(
          conversationId,
          message.id,
          conversation.title,
          message.role,
          message.text,
        )
      })
      this.db.exec('COMMIT')
    }
    catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }

    return {
      conversationId,
      title: conversation.title,
      messageCount: conversation.messages.length,
      visibleMessageCount: visibleMessages.length,
      resourceCount: manifest.items.length,
      sourceFormat: conversation.sourceFormat,
    }
  }

  search(query: string, limit = 20): ArchiveSearchHit[] {
    const normalized = query.trim()
    if (!normalized) return []
    const safeLimit = Math.max(1, Math.min(200, limit))
    const codepointLength = Array.from(normalized).length
    const hasCjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(normalized)

    // 3+ 字符中文/日文/韩文优先走 trigram，支持“长江三峡”这类连续文本子串。
    if (hasCjk && codepointLength >= 3) {
      const rows = this.db.prepare(`
        SELECT
          conversation_id AS conversationId,
          message_id AS messageId,
          title,
          role,
          snippet(message_fts_trigram, 4, '[', ']', ' … ', 24) AS text,
          bm25(message_fts_trigram, 2.5, 1.0) AS rank
        FROM message_fts_trigram
        WHERE message_fts_trigram MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(normalized, safeLimit) as unknown as ArchiveSearchHit[]
      if (rows.length > 0) return rows
    }

    // 英文/数字/较长分词查询继续用 unicode61，保留单词级 FTS 排名。
    if (!hasCjk) {
      try {
        const rows = this.db.prepare(`
          SELECT
            conversation_id AS conversationId,
            message_id AS messageId,
            title,
            role,
            snippet(message_fts, 4, '[', ']', ' … ', 24) AS text,
            bm25(message_fts, 2.5, 1.0) AS rank
          FROM message_fts
          WHERE message_fts MATCH ?
          ORDER BY rank
          LIMIT ?
        `).all(normalized, safeLimit) as unknown as ArchiveSearchHit[]
        if (rows.length > 0) return rows
      }
      catch {
        // 用户输入包含 FTS 运算符/未闭合引号时，不让搜索直接失败，下面 LIKE 仍能工作。
      }
    }

    // FTS5 trigram 最小 token 长度是 3；“三峡”“英国”等高频两字词必须能搜。
    // LIKE 只扫我们已经筛过的可读 User/Assistant messages，不扫巨大 tool result。
    const pattern = `%${normalized.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`
    const rows = this.db.prepare(`
      SELECT
        m.conversation_id AS conversationId,
        m.message_id AS messageId,
        c.title AS title,
        m.role AS role,
        substr(m.text, max(1, instr(m.text, ?) - 80), 260) AS text,
        0.0 AS rank
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      WHERE m.hidden = 0
        AND m.recipient = 'all'
        AND m.role IN ('user', 'assistant')
        AND (m.text LIKE ? ESCAPE '\\' OR c.title LIKE ? ESCAPE '\\')
      ORDER BY m.create_time DESC, m.ordinal DESC
      LIMIT ?
    `).all(normalized, pattern, pattern, safeLimit) as unknown as ArchiveSearchHit[]
    return rows
  }

  list(limit = 50): ArchiveConversationRow[] {
    return this.db.prepare(`
      SELECT
        id,
        title,
        source_format AS sourceFormat,
        current_node AS currentNode,
        captured_at AS capturedAt,
        imported_at AS importedAt,
        message_count AS messageCount,
        resource_count AS resourceCount
      FROM conversations
      ORDER BY captured_at DESC, imported_at DESC
      LIMIT ?
    `).all(Math.max(1, Math.min(1000, limit))) as unknown as ArchiveConversationRow[]
  }

  getMarkdown(conversationId: string): string | null {
    const row = this.db.prepare('SELECT markdown FROM conversations WHERE id = ?').get(conversationId) as { markdown?: string } | undefined
    return typeof row?.markdown === 'string' ? row.markdown : null
  }

  getMessages(conversationId: string): Array<Record<string, unknown>> {
    return this.db.prepare(`
      SELECT
        message_id AS messageId,
        ordinal,
        role,
        author_name AS authorName,
        recipient,
        channel,
        content_type AS contentType,
        text,
        hidden,
        create_time AS createTime
      FROM messages
      WHERE conversation_id = ?
      ORDER BY ordinal
    `).all(conversationId) as unknown as Array<Record<string, unknown>>
  }

  getResources(conversationId: string): Array<Record<string, unknown>> {
    const rows = this.db.prepare(`
      SELECT message_id AS messageId, ordinal, kind, label, data_json AS dataJson
      FROM resources
      WHERE conversation_id = ?
      ORDER BY ordinal
    `).all(conversationId) as unknown as Array<Record<string, unknown> & { dataJson: string }>
    return rows.map(({ dataJson, ...row }) => ({ ...row, data: JSON.parse(dataJson) }))
  }

  stats(): Record<string, number> {
    const conversationCount = Number((this.db.prepare('SELECT count(*) AS n FROM conversations').get() as { n: number }).n)
    const messageCount = Number((this.db.prepare('SELECT count(*) AS n FROM messages').get() as { n: number }).n)
    const resourceCount = Number((this.db.prepare('SELECT count(*) AS n FROM resources').get() as { n: number }).n)
    const indexedMessageCount = Number((this.db.prepare('SELECT count(*) AS n FROM message_fts').get() as { n: number }).n)
    const trigramIndexedMessageCount = Number((this.db.prepare('SELECT count(*) AS n FROM message_fts_trigram').get() as { n: number }).n)
    return { conversationCount, messageCount, resourceCount, indexedMessageCount, trigramIndexedMessageCount }
  }
}
