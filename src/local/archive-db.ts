import { mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { gzipSync } from 'node:zlib'
import { adaptConversation } from '../core/adapter.ts'
import { extractMessageText } from '../core/adapter.ts'
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

/** 一份外部数据源（官方 ZIP、被动 capture、在线 sync）在数据库中的登记信息。 */
export interface ArchiveSourceRow {
  id: number
  sourceKey: string
  kind: string
  displayName: string
  sourcePath: string | null
  observedAt: number
  importedAt: number
  completedAt: number | null
  isCompleteSnapshot: number
  conversationCount: number
  assetCount: number
}

/** 官方 Data Export ZIP 开始导入时需要登记的来源信息。 */
export interface OfficialExportSourceInput {
  sourceKey: string
  displayName: string
  sourcePath: string
  fileSize: number
  fileMtimeMs: number
  observedAt: number
  metadata?: Record<string, unknown>
}

/** 一片 conversations-xxx.json 导入后的统计。 */
export interface OfficialBatchImportResult {
  conversationCount: number
  nodeCount: number
  messageCount: number
  snapshotCount: number
}

/** ZIP 内非 conversation 的 JSON 文件也保存一份压缩副本，避免只保留聊天正文。 */
export interface SourceDocumentInput {
  name: string
  value: unknown
}

/** 字段覆盖率用于证明“哪些字段被我们见过”，而不是凭几个 fixture 猜 schema。 */
export interface SchemaFieldObservation {
  entityKind: 'conversation' | 'node' | 'message' | 'author' | 'content' | 'metadata'
  fieldName: string
  valueType: string
  count: number
}

function ensureParentDir(filePath: string): void {
  mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true })
}

function json(value: unknown): string {
  return JSON.stringify(value)
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function booleanValue(value: unknown): number | null {
  return typeof value === 'boolean' ? (value ? 1 : 0) : null
}

function canonicalRole(value: unknown): string {
  return typeof value === 'string' && value ? value : 'unknown'
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function jsonWithoutKeys(value: Record<string, unknown>, excluded: ReadonlySet<string>): string {
  const rest: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (!excluded.has(key)) rest[key] = item
  }
  return json(rest)
}

const CONVERSATION_KNOWN_KEYS = new Set([
  'id', 'conversation_id', 'title', 'create_time', 'update_time', 'current_node', 'mapping',
  'conversation_template_id', 'default_model_slug', 'is_archived', 'is_do_not_remember',
  'is_read_only', 'is_starred', 'is_study_mode', 'memory_scope', 'pinned_time', 'plugin_ids', 'voice',
])
const NODE_KNOWN_KEYS = new Set(['id', 'parent', 'children', 'message'])

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

      -- 数据源表让“官方 ZIP / 被动 capture / 在线 sync”成为一等公民。
      -- source_key 必须稳定且幂等：同一份 ZIP 重跑不会制造第二个来源。
      CREATE TABLE IF NOT EXISTS archive_sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_key TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        display_name TEXT NOT NULL,
        source_path TEXT,
        file_size INTEGER,
        file_mtime_ms REAL,
        observed_at INTEGER NOT NULL,
        imported_at INTEGER NOT NULL,
        completed_at INTEGER,
        is_complete_snapshot INTEGER NOT NULL DEFAULT 0,
        conversation_count INTEGER NOT NULL DEFAULT 0,
        asset_count INTEGER NOT NULL DEFAULT 0,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );

      -- 每一份 source 对每个 conversation 都保存 gzip 后的完整 JSON snapshot。
      -- 规范化表负责查询；snapshot 负责“未来 parser 写错了也还能重建”。
      CREATE TABLE IF NOT EXISTS conversation_snapshots (
        source_id INTEGER NOT NULL REFERENCES archive_sources(id) ON DELETE CASCADE,
        conversation_id TEXT NOT NULL,
        part_name TEXT,
        record_ordinal INTEGER,
        observed_at INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        raw_json_gzip BLOB NOT NULL,
        PRIMARY KEY(source_id, conversation_id)
      );

      CREATE INDEX IF NOT EXISTS conversation_snapshots_conversation
        ON conversation_snapshots(conversation_id, observed_at);

      -- mapping 是树而不是线性 transcript；必须保留所有 branch node。
      CREATE TABLE IF NOT EXISTS mapping_nodes (
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        node_id TEXT NOT NULL,
        parent_id TEXT,
        message_id TEXT,
        children_json TEXT,
        extra_json TEXT NOT NULL DEFAULT '{}',
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        source_observed_at INTEGER NOT NULL,
        PRIMARY KEY(conversation_id, node_id)
      );

      CREATE INDEX IF NOT EXISTS mapping_nodes_parent
        ON mapping_nodes(conversation_id, parent_id);

      -- content.parts 可能既有字符串也有 asset pointer / multimodal object。
      -- 分拆后既可检索文本，也不会丢结构化 part。
      CREATE TABLE IF NOT EXISTS message_parts (
        conversation_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        part_index INTEGER NOT NULL,
        source_field TEXT NOT NULL,
        part_kind TEXT NOT NULL,
        text_value TEXT,
        json_value TEXT,
        PRIMARY KEY(conversation_id, message_id, source_field, part_index),
        FOREIGN KEY(conversation_id, message_id)
          REFERENCES messages(conversation_id, message_id) ON DELETE CASCADE
      );

      -- 官方导出里的附件 manifest。二进制仍留在原 ZIP，数据库记录可定位的 source+entry。
      CREATE TABLE IF NOT EXISTS archive_assets (
        asset_id TEXT PRIMARY KEY,
        original_name TEXT,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        last_source_id INTEGER REFERENCES archive_sources(id),
        source_missing INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS asset_snapshots (
        source_id INTEGER NOT NULL REFERENCES archive_sources(id) ON DELETE CASCADE,
        asset_id TEXT NOT NULL,
        original_name TEXT,
        PRIMARY KEY(source_id, asset_id)
      );

      -- user.json / shared_conversations.json / codex.json 等小型 JSON 也留档。
      CREATE TABLE IF NOT EXISTS source_documents (
        source_id INTEGER NOT NULL REFERENCES archive_sources(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        raw_json_gzip BLOB NOT NULL,
        PRIMARY KEY(source_id, name)
      );

      -- 记录真实导出里每类对象出现过哪些 key / value type，供 schema 演进回归。
      CREATE TABLE IF NOT EXISTS schema_field_stats (
        source_id INTEGER NOT NULL REFERENCES archive_sources(id) ON DELETE CASCADE,
        entity_kind TEXT NOT NULL,
        field_name TEXT NOT NULL,
        value_type TEXT NOT NULL,
        count INTEGER NOT NULL,
        PRIMARY KEY(source_id, entity_kind, field_name, value_type)
      );

      -- 全文本审计索引：默认 search 仍走“可读正文”索引；未来 --scope all 可查工具/reasoning。
      CREATE VIRTUAL TABLE IF NOT EXISTS message_fts_all USING fts5(
        conversation_id UNINDEXED,
        message_id UNINDEXED,
        title,
        role UNINDEXED,
        channel UNINDEXED,
        content_type UNINDEXED,
        text,
        tokenize='trigram'
      );
    `)

    // 旧 prototype 数据库已经存在于用户机器上，因此采用“增量加列”而不是粗暴 DROP/重建。
    this.ensureColumn('conversations', 'create_time', 'REAL')
    this.ensureColumn('conversations', 'update_time', 'REAL')
    this.ensureColumn('conversations', 'conversation_template_id', 'TEXT')
    this.ensureColumn('conversations', 'default_model_slug', 'TEXT')
    this.ensureColumn('conversations', 'is_archived', 'INTEGER')
    this.ensureColumn('conversations', 'is_do_not_remember', 'INTEGER')
    this.ensureColumn('conversations', 'is_read_only', 'INTEGER')
    this.ensureColumn('conversations', 'is_starred', 'INTEGER')
    this.ensureColumn('conversations', 'is_study_mode', 'INTEGER')
    this.ensureColumn('conversations', 'memory_scope', 'TEXT')
    this.ensureColumn('conversations', 'pinned_time', 'REAL')
    this.ensureColumn('conversations', 'plugin_ids_json', 'TEXT')
    this.ensureColumn('conversations', 'voice_json', 'TEXT')
    this.ensureColumn('conversations', 'extra_json', "TEXT NOT NULL DEFAULT '{}'")
    this.ensureColumn('conversations', 'first_seen_at', 'INTEGER')
    this.ensureColumn('conversations', 'last_seen_at', 'INTEGER')
    this.ensureColumn('conversations', 'last_source_id', 'INTEGER')
    this.ensureColumn('conversations', 'source_missing', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('conversations', 'terminal_state', 'TEXT')
    this.ensureColumn('conversations', 'incident_state', 'TEXT')
    this.ensureColumn('conversations', 'last_finish_type', 'TEXT')
    this.ensureColumn('conversations', 'last_finish_reason', 'TEXT')
    this.ensureColumn('conversations', 'last_reasoning_status', 'TEXT')
    this.ensureColumn('conversations', 'last_monitor_checked_at', 'INTEGER')

    this.ensureColumn('messages', 'node_id', 'TEXT')
    this.ensureColumn('messages', 'role_raw', 'TEXT')
    this.ensureColumn('messages', 'update_time', 'REAL')
    this.ensureColumn('messages', 'status', 'TEXT')
    this.ensureColumn('messages', 'end_turn', 'INTEGER')
    this.ensureColumn('messages', 'weight', 'REAL')
    this.ensureColumn('messages', 'request_id', 'TEXT')
    this.ensureColumn('messages', 'turn_exchange_id', 'TEXT')
    this.ensureColumn('messages', 'model_slug', 'TEXT')
    this.ensureColumn('messages', 'resolved_model_slug', 'TEXT')
    this.ensureColumn('messages', 'finish_type', 'TEXT')
    this.ensureColumn('messages', 'finish_reason', 'TEXT')
    this.ensureColumn('messages', 'reasoning_status', 'TEXT')
    this.ensureColumn('messages', 'author_json', "TEXT NOT NULL DEFAULT '{}'")
    this.ensureColumn('messages', 'content_json', "TEXT NOT NULL DEFAULT '{}'")
    this.ensureColumn('messages', 'raw_json', "TEXT NOT NULL DEFAULT '{}'")
    this.ensureColumn('messages', 'first_seen_at', 'INTEGER')
    this.ensureColumn('messages', 'last_seen_at', 'INTEGER')
    this.ensureColumn('messages', 'source_observed_at', 'INTEGER')
  }

  /** SQLite 没有通用的 `ADD COLUMN IF NOT EXISTS`，所以先用 PRAGMA 检查旧库。 */
  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>
    if (columns.some(item => item.name === column)) return
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }

  /**
   * 登记一份官方 Data Export。若上次导入中途异常，调用方可以继续覆盖同一个 source_id；
   * 已完成来源默认由 orchestration 层直接跳过，保证幂等且避免重复解压 3GB ZIP。
   */
  beginOfficialExportSource(input: OfficialExportSourceInput): { sourceId: number, alreadyComplete: boolean } {
    const existing = this.db.prepare(`
      SELECT id, completed_at AS completedAt
      FROM archive_sources
      WHERE source_key = ?
    `).get(input.sourceKey) as { id: number, completedAt: number | null } | undefined

    if (existing) return { sourceId: existing.id, alreadyComplete: existing.completedAt !== null }

    const result = this.db.prepare(`
      INSERT INTO archive_sources (
        source_key, kind, display_name, source_path, file_size, file_mtime_ms,
        observed_at, imported_at, metadata_json
      ) VALUES (?, 'official-export', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.sourceKey,
      input.displayName,
      input.sourcePath,
      input.fileSize,
      input.fileMtimeMs,
      input.observedAt,
      Date.now(),
      json(input.metadata ?? {}),
    )
    return { sourceId: Number(result.lastInsertRowid), alreadyComplete: false }
  }

  /**
   * 导入官方 export 的一片 conversation 数组。
   *
   * 和旧 `importRaw()` 最大区别：这里绝不只取 current branch，也绝不先 DELETE conversation。
   * 每个 mapping node/message 都按稳定 ID 做 union/upsert；较新来源更新 canonical 行，旧来源
   * 独有节点仍然保留。完整原对象另存 gzip snapshot，所以未知字段也不会丢。
   */
  importOfficialBatch(
    sourceId: number,
    payloads: unknown[],
    options: { observedAt: number, partName: string },
  ): OfficialBatchImportResult {
    const source = this.db.prepare('SELECT observed_at AS observedAt FROM archive_sources WHERE id = ?').get(sourceId) as { observedAt: number } | undefined
    if (!source) throw new Error(`Unknown archive source: ${sourceId}`)

    const upsertConversation = this.db.prepare(`
      INSERT INTO conversations (
        id, title, source_format, current_node, captured_at, imported_at,
        message_count, resource_count, markdown,
        create_time, update_time, conversation_template_id, default_model_slug,
        is_archived, is_do_not_remember, is_read_only, is_starred, is_study_mode,
        memory_scope, pinned_time, plugin_ids_json, voice_json, extra_json,
        first_seen_at, last_seen_at, last_source_id, source_missing
      ) VALUES (
        ?, ?, 'mapping', ?, ?, ?, ?, 0, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0
      )
      ON CONFLICT(id) DO UPDATE SET
        first_seen_at = min(COALESCE(conversations.first_seen_at, excluded.first_seen_at), excluded.first_seen_at),
        last_seen_at = max(COALESCE(conversations.last_seen_at, excluded.last_seen_at), excluded.last_seen_at),
        source_missing = CASE WHEN excluded.last_seen_at >= COALESCE(conversations.last_seen_at, 0) THEN 0 ELSE conversations.source_missing END,
        title = CASE WHEN excluded.last_seen_at >= COALESCE(conversations.last_seen_at, 0) THEN excluded.title ELSE conversations.title END,
        source_format = CASE WHEN excluded.last_seen_at >= COALESCE(conversations.last_seen_at, 0) THEN excluded.source_format ELSE conversations.source_format END,
        current_node = CASE WHEN excluded.last_seen_at >= COALESCE(conversations.last_seen_at, 0) THEN excluded.current_node ELSE conversations.current_node END,
        captured_at = max(conversations.captured_at, excluded.captured_at),
        imported_at = excluded.imported_at,
        message_count = max(conversations.message_count, excluded.message_count),
        markdown = CASE WHEN excluded.last_seen_at >= COALESCE(conversations.last_seen_at, 0) THEN excluded.markdown ELSE conversations.markdown END,
        create_time = CASE WHEN excluded.last_seen_at >= COALESCE(conversations.last_seen_at, 0) THEN excluded.create_time ELSE conversations.create_time END,
        update_time = CASE WHEN excluded.last_seen_at >= COALESCE(conversations.last_seen_at, 0) THEN excluded.update_time ELSE conversations.update_time END,
        conversation_template_id = CASE WHEN excluded.last_seen_at >= COALESCE(conversations.last_seen_at, 0) THEN excluded.conversation_template_id ELSE conversations.conversation_template_id END,
        default_model_slug = CASE WHEN excluded.last_seen_at >= COALESCE(conversations.last_seen_at, 0) THEN excluded.default_model_slug ELSE conversations.default_model_slug END,
        is_archived = CASE WHEN excluded.last_seen_at >= COALESCE(conversations.last_seen_at, 0) THEN excluded.is_archived ELSE conversations.is_archived END,
        is_do_not_remember = CASE WHEN excluded.last_seen_at >= COALESCE(conversations.last_seen_at, 0) THEN excluded.is_do_not_remember ELSE conversations.is_do_not_remember END,
        is_read_only = CASE WHEN excluded.last_seen_at >= COALESCE(conversations.last_seen_at, 0) THEN excluded.is_read_only ELSE conversations.is_read_only END,
        is_starred = CASE WHEN excluded.last_seen_at >= COALESCE(conversations.last_seen_at, 0) THEN excluded.is_starred ELSE conversations.is_starred END,
        is_study_mode = CASE WHEN excluded.last_seen_at >= COALESCE(conversations.last_seen_at, 0) THEN excluded.is_study_mode ELSE conversations.is_study_mode END,
        memory_scope = CASE WHEN excluded.last_seen_at >= COALESCE(conversations.last_seen_at, 0) THEN excluded.memory_scope ELSE conversations.memory_scope END,
        pinned_time = CASE WHEN excluded.last_seen_at >= COALESCE(conversations.last_seen_at, 0) THEN excluded.pinned_time ELSE conversations.pinned_time END,
        plugin_ids_json = CASE WHEN excluded.last_seen_at >= COALESCE(conversations.last_seen_at, 0) THEN excluded.plugin_ids_json ELSE conversations.plugin_ids_json END,
        voice_json = CASE WHEN excluded.last_seen_at >= COALESCE(conversations.last_seen_at, 0) THEN excluded.voice_json ELSE conversations.voice_json END,
        extra_json = CASE WHEN excluded.last_seen_at >= COALESCE(conversations.last_seen_at, 0) THEN excluded.extra_json ELSE conversations.extra_json END,
        last_source_id = CASE WHEN excluded.last_seen_at >= COALESCE(conversations.last_seen_at, 0) THEN excluded.last_source_id ELSE conversations.last_source_id END
    `)
    const upsertNode = this.db.prepare(`
      INSERT INTO mapping_nodes (
        conversation_id, node_id, parent_id, message_id, children_json, extra_json,
        first_seen_at, last_seen_at, source_observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(conversation_id, node_id) DO UPDATE SET
        first_seen_at=min(mapping_nodes.first_seen_at, excluded.first_seen_at),
        last_seen_at=max(mapping_nodes.last_seen_at, excluded.last_seen_at),
        parent_id=CASE WHEN excluded.source_observed_at >= mapping_nodes.source_observed_at THEN excluded.parent_id ELSE mapping_nodes.parent_id END,
        message_id=CASE WHEN excluded.source_observed_at >= mapping_nodes.source_observed_at THEN excluded.message_id ELSE mapping_nodes.message_id END,
        children_json=CASE WHEN excluded.source_observed_at >= mapping_nodes.source_observed_at AND excluded.children_json IS NOT NULL THEN excluded.children_json ELSE mapping_nodes.children_json END,
        extra_json=CASE WHEN excluded.source_observed_at >= mapping_nodes.source_observed_at THEN excluded.extra_json ELSE mapping_nodes.extra_json END,
        source_observed_at=max(mapping_nodes.source_observed_at, excluded.source_observed_at)
    `)
    const upsertMessage = this.db.prepare(`
      INSERT INTO messages (
        conversation_id, message_id, ordinal, role, author_name, recipient, channel,
        content_type, text, hidden, create_time, metadata_json,
        node_id, role_raw, update_time, status, end_turn, weight,
        request_id, turn_exchange_id, model_slug, resolved_model_slug,
        finish_type, finish_reason, reasoning_status,
        author_json, content_json, raw_json,
        first_seen_at, last_seen_at, source_observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(conversation_id, message_id) DO UPDATE SET
        first_seen_at=min(COALESCE(messages.first_seen_at, excluded.first_seen_at), excluded.first_seen_at),
        last_seen_at=max(COALESCE(messages.last_seen_at, excluded.last_seen_at), excluded.last_seen_at),
        ordinal=CASE WHEN excluded.source_observed_at >= COALESCE(messages.source_observed_at, 0) THEN excluded.ordinal ELSE messages.ordinal END,
        role=CASE WHEN excluded.source_observed_at >= COALESCE(messages.source_observed_at, 0) THEN excluded.role ELSE messages.role END,
        author_name=CASE WHEN excluded.source_observed_at >= COALESCE(messages.source_observed_at, 0) THEN excluded.author_name ELSE messages.author_name END,
        recipient=CASE WHEN excluded.source_observed_at >= COALESCE(messages.source_observed_at, 0) THEN excluded.recipient ELSE messages.recipient END,
        channel=CASE WHEN excluded.source_observed_at >= COALESCE(messages.source_observed_at, 0) THEN excluded.channel ELSE messages.channel END,
        content_type=CASE WHEN excluded.source_observed_at >= COALESCE(messages.source_observed_at, 0) THEN excluded.content_type ELSE messages.content_type END,
        text=CASE WHEN excluded.source_observed_at >= COALESCE(messages.source_observed_at, 0) THEN excluded.text ELSE messages.text END,
        hidden=CASE WHEN excluded.source_observed_at >= COALESCE(messages.source_observed_at, 0) THEN excluded.hidden ELSE messages.hidden END,
        create_time=CASE WHEN excluded.source_observed_at >= COALESCE(messages.source_observed_at, 0) THEN excluded.create_time ELSE messages.create_time END,
        metadata_json=CASE WHEN excluded.source_observed_at >= COALESCE(messages.source_observed_at, 0) THEN excluded.metadata_json ELSE messages.metadata_json END,
        node_id=CASE WHEN excluded.source_observed_at >= COALESCE(messages.source_observed_at, 0) THEN excluded.node_id ELSE messages.node_id END,
        role_raw=CASE WHEN excluded.source_observed_at >= COALESCE(messages.source_observed_at, 0) THEN excluded.role_raw ELSE messages.role_raw END,
        update_time=CASE WHEN excluded.source_observed_at >= COALESCE(messages.source_observed_at, 0) THEN excluded.update_time ELSE messages.update_time END,
        status=CASE WHEN excluded.source_observed_at >= COALESCE(messages.source_observed_at, 0) THEN excluded.status ELSE messages.status END,
        end_turn=CASE WHEN excluded.source_observed_at >= COALESCE(messages.source_observed_at, 0) THEN excluded.end_turn ELSE messages.end_turn END,
        weight=CASE WHEN excluded.source_observed_at >= COALESCE(messages.source_observed_at, 0) THEN excluded.weight ELSE messages.weight END,
        request_id=CASE WHEN excluded.source_observed_at >= COALESCE(messages.source_observed_at, 0) THEN excluded.request_id ELSE messages.request_id END,
        turn_exchange_id=CASE WHEN excluded.source_observed_at >= COALESCE(messages.source_observed_at, 0) THEN excluded.turn_exchange_id ELSE messages.turn_exchange_id END,
        model_slug=CASE WHEN excluded.source_observed_at >= COALESCE(messages.source_observed_at, 0) THEN excluded.model_slug ELSE messages.model_slug END,
        resolved_model_slug=CASE WHEN excluded.source_observed_at >= COALESCE(messages.source_observed_at, 0) THEN excluded.resolved_model_slug ELSE messages.resolved_model_slug END,
        finish_type=CASE WHEN excluded.source_observed_at >= COALESCE(messages.source_observed_at, 0) THEN excluded.finish_type ELSE messages.finish_type END,
        finish_reason=CASE WHEN excluded.source_observed_at >= COALESCE(messages.source_observed_at, 0) THEN excluded.finish_reason ELSE messages.finish_reason END,
        reasoning_status=CASE WHEN excluded.source_observed_at >= COALESCE(messages.source_observed_at, 0) THEN excluded.reasoning_status ELSE messages.reasoning_status END,
        author_json=CASE WHEN excluded.source_observed_at >= COALESCE(messages.source_observed_at, 0) THEN excluded.author_json ELSE messages.author_json END,
        content_json=CASE WHEN excluded.source_observed_at >= COALESCE(messages.source_observed_at, 0) THEN excluded.content_json ELSE messages.content_json END,
        raw_json=CASE WHEN excluded.source_observed_at >= COALESCE(messages.source_observed_at, 0) THEN excluded.raw_json ELSE messages.raw_json END,
        source_observed_at=max(COALESCE(messages.source_observed_at, 0), excluded.source_observed_at)
    `)
    const insertPart = this.db.prepare(`
      INSERT INTO message_parts (
        conversation_id, message_id, part_index, source_field, part_kind, text_value, json_value
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    const insertSnapshot = this.db.prepare(`
      INSERT OR REPLACE INTO conversation_snapshots (
        source_id, conversation_id, part_name, record_ordinal, observed_at, sha256, raw_json_gzip
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `)

    let conversationCount = 0
    let nodeCount = 0
    let messageCount = 0
    let snapshotCount = 0
    const now = Date.now()

    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (let recordOrdinal = 0; recordOrdinal < payloads.length; recordOrdinal += 1) {
        const rawConversation = record(payloads[recordOrdinal])
        const conversationId = stringValue(rawConversation.conversation_id) ?? stringValue(rawConversation.id)
        const mapping = record(rawConversation.mapping)
        if (!conversationId || Object.keys(mapping).length === 0) continue

        // Markdown 仍按当前分支生成；完整树则进入 mapping_nodes/messages。
        const canonical = adaptConversation(rawConversation)
        const markdown = visibleForMarkdown(canonical) ? conversationToMarkdown(canonical) : ''
        const allMessages = Object.values(mapping)
          .map(node => record(node).message)
          .filter(message => message && typeof message === 'object' && !Array.isArray(message))
        upsertConversation.run(
          conversationId,
          stringValue(rawConversation.title) ?? 'ChatGPT Conversation',
          stringValue(rawConversation.current_node),
          options.observedAt,
          now,
          allMessages.length,
          markdown,
          numberValue(rawConversation.create_time),
          numberValue(rawConversation.update_time),
          stringValue(rawConversation.conversation_template_id),
          stringValue(rawConversation.default_model_slug),
          booleanValue(rawConversation.is_archived),
          booleanValue(rawConversation.is_do_not_remember),
          booleanValue(rawConversation.is_read_only),
          booleanValue(rawConversation.is_starred),
          booleanValue(rawConversation.is_study_mode),
          stringValue(rawConversation.memory_scope),
          numberValue(rawConversation.pinned_time),
          json(rawConversation.plugin_ids ?? null),
          json(rawConversation.voice ?? null),
          jsonWithoutKeys(rawConversation, CONVERSATION_KNOWN_KEYS),
          options.observedAt,
          options.observedAt,
          sourceId,
        )

        let ordinal = 0
        for (const [mappingKey, rawNodeValue] of Object.entries(mapping)) {
          const rawNode = record(rawNodeValue)
          const nodeId = stringValue(rawNode.id) ?? mappingKey
          const rawMessage = record(rawNode.message)
          const messageId = stringValue(rawMessage.id)
          upsertNode.run(
            conversationId,
            nodeId,
            stringValue(rawNode.parent),
            messageId,
            Array.isArray(rawNode.children) ? json(rawNode.children) : null,
            jsonWithoutKeys(rawNode, NODE_KNOWN_KEYS),
            options.observedAt,
            options.observedAt,
            options.observedAt,
          )
          nodeCount += 1

          if (messageId) {
            const author = record(rawMessage.author)
            const content = record(rawMessage.content)
            const metadata = record(rawMessage.metadata)
            const finishDetails = record(metadata.finish_details)
            const roleRaw = canonicalRole(author.role)
            const text = extractMessageText(rawMessage)
            const hidden = metadata.is_visually_hidden_from_conversation === true ? 1 : 0
            upsertMessage.run(
              conversationId,
              messageId,
              ordinal,
              roleRaw,
              stringValue(author.name),
              stringValue(rawMessage.recipient) ?? 'all',
              stringValue(rawMessage.channel),
              stringValue(content.content_type) ?? 'unknown',
              text,
              hidden,
              numberValue(rawMessage.create_time),
              json(metadata),
              nodeId,
              roleRaw,
              numberValue(rawMessage.update_time),
              stringValue(rawMessage.status),
              booleanValue(rawMessage.end_turn),
              numberValue(rawMessage.weight),
              stringValue(metadata.request_id),
              stringValue(metadata.turn_exchange_id),
              stringValue(metadata.model_slug),
              stringValue(metadata.resolved_model_slug),
              stringValue(finishDetails.type),
              stringValue(finishDetails.reason),
              stringValue(metadata.reasoning_status),
              json(author),
              json(content),
              json(rawMessage),
              options.observedAt,
              options.observedAt,
              options.observedAt,
            )

            // 来源按时间顺序导入；较新 message 的 part 会替换旧 structured part，旧版本仍在 snapshot。
            this.db.prepare('DELETE FROM message_parts WHERE conversation_id = ? AND message_id = ?').run(conversationId, messageId)
            if (Array.isArray(content.parts)) {
              content.parts.forEach((part, partIndex) => {
                const kind = part === null ? 'null' : Array.isArray(part) ? 'array' : typeof part === 'object' ? 'object' : typeof part
                insertPart.run(
                  conversationId,
                  messageId,
                  partIndex,
                  'parts',
                  kind,
                  typeof part === 'string' ? part : null,
                  typeof part === 'string' ? null : json(part),
                )
              })
            }
            for (const [sourceField, part] of [['text', content.text], ['content', content.content]] as const) {
              if (typeof part === 'string') insertPart.run(conversationId, messageId, 0, sourceField, 'string', part, null)
            }
            messageCount += 1
          }
          ordinal += 1
        }

        const rawText = json(rawConversation)
        insertSnapshot.run(
          sourceId,
          conversationId,
          options.partName,
          recordOrdinal,
          options.observedAt,
          sha256Text(rawText),
          gzipSync(Buffer.from(rawText, 'utf8')),
        )
        snapshotCount += 1
        conversationCount += 1

        this.reindexConversation(conversationId)
      }
      this.db.exec('COMMIT')
    }
    catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }

    return { conversationCount, nodeCount, messageCount, snapshotCount }
  }

  /** 把官方 ZIP 内的小型 JSON 文档一起压缩保存，便于未来重建导出语义。 */
  saveSourceDocument(sourceId: number, input: SourceDocumentInput): void {
    const raw = json(input.value)
    this.db.prepare(`
      INSERT OR REPLACE INTO source_documents (source_id, name, sha256, raw_json_gzip)
      VALUES (?, ?, ?, ?)
    `).run(sourceId, input.name, sha256Text(raw), gzipSync(Buffer.from(raw, 'utf8')))
  }

  /** 导入 `conversation_asset_file_names.json`；二进制文件本身仍可从 source_path 的 ZIP 定位。 */
  saveOfficialAssetManifest(sourceId: number, manifest: unknown, observedAt: number): number {
    const entries = record(manifest)
    const insertSnapshot = this.db.prepare(`
      INSERT OR REPLACE INTO asset_snapshots (source_id, asset_id, original_name)
      VALUES (?, ?, ?)
    `)
    const upsertAsset = this.db.prepare(`
      INSERT INTO archive_assets (
        asset_id, original_name, first_seen_at, last_seen_at, last_source_id, source_missing
      ) VALUES (?, ?, ?, ?, ?, 0)
      ON CONFLICT(asset_id) DO UPDATE SET
        first_seen_at=min(archive_assets.first_seen_at, excluded.first_seen_at),
        original_name=CASE WHEN excluded.last_seen_at >= archive_assets.last_seen_at THEN excluded.original_name ELSE archive_assets.original_name END,
        last_source_id=CASE WHEN excluded.last_seen_at >= archive_assets.last_seen_at THEN excluded.last_source_id ELSE archive_assets.last_source_id END,
        source_missing=CASE WHEN excluded.last_seen_at >= archive_assets.last_seen_at THEN 0 ELSE archive_assets.source_missing END,
        last_seen_at=max(archive_assets.last_seen_at, excluded.last_seen_at)
    `)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const [assetId, originalName] of Object.entries(entries)) {
        insertSnapshot.run(sourceId, assetId, typeof originalName === 'string' ? originalName : json(originalName))
        upsertAsset.run(assetId, typeof originalName === 'string' ? originalName : json(originalName), observedAt, observedAt, sourceId)
      }
      this.db.exec('COMMIT')
    }
    catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return Object.keys(entries).length
  }

  saveSchemaFieldStats(sourceId: number, observations: SchemaFieldObservation[]): void {
    const insert = this.db.prepare(`
      INSERT OR REPLACE INTO schema_field_stats (
        source_id, entity_kind, field_name, value_type, count
      ) VALUES (?, ?, ?, ?, ?)
    `)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('DELETE FROM schema_field_stats WHERE source_id = ?').run(sourceId)
      for (const item of observations) insert.run(sourceId, item.entityKind, item.fieldName, item.valueType, item.count)
      this.db.exec('COMMIT')
    }
    catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * 完成一份“完整官方快照”后才计算 source_missing。
   * 只有当前 source 是数据库里时间最新的完整官方快照时才做缺失标记，避免以后补导旧 ZIP
   * 把新数据错误标成 missing。
   */
  finalizeOfficialExportSource(sourceId: number, counts: { conversationCount: number, assetCount: number }): void {
    const source = this.db.prepare(`
      SELECT observed_at AS observedAt FROM archive_sources WHERE id = ?
    `).get(sourceId) as { observedAt: number } | undefined
    if (!source) throw new Error(`Unknown archive source: ${sourceId}`)

    const now = Date.now()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(`
        UPDATE archive_sources
        SET completed_at = ?, is_complete_snapshot = 1, conversation_count = ?, asset_count = ?
        WHERE id = ?
      `).run(now, counts.conversationCount, counts.assetCount, sourceId)

      const newer = this.db.prepare(`
        SELECT count(*) AS n
        FROM archive_sources
        WHERE kind = 'official-export'
          AND is_complete_snapshot = 1
          AND observed_at > ?
      `).get(source.observedAt) as { n: number }

      if (Number(newer.n) === 0) {
        this.db.prepare(`
          UPDATE conversations
          SET source_missing = CASE
            WHEN EXISTS (
              SELECT 1 FROM conversation_snapshots s
              WHERE s.source_id = ? AND s.conversation_id = conversations.id
            ) THEN 0
            WHEN EXISTS (
              SELECT 1
              FROM conversation_snapshots s
              JOIN archive_sources src ON src.id = s.source_id
              WHERE s.conversation_id = conversations.id
                AND src.kind = 'official-export'
                AND src.is_complete_snapshot = 1
                AND src.observed_at < ?
            ) THEN 1
            ELSE source_missing
          END
        `).run(sourceId, source.observedAt)

        this.db.prepare(`
          UPDATE archive_assets
          SET source_missing = CASE
            WHEN EXISTS (
              SELECT 1 FROM asset_snapshots s
              WHERE s.source_id = ? AND s.asset_id = archive_assets.asset_id
            ) THEN 0
            WHEN EXISTS (
              SELECT 1
              FROM asset_snapshots s
              JOIN archive_sources src ON src.id = s.source_id
              WHERE s.asset_id = archive_assets.asset_id
                AND src.kind = 'official-export'
                AND src.is_complete_snapshot = 1
                AND src.observed_at < ?
            ) THEN 1
            ELSE source_missing
          END
        `).run(sourceId, source.observedAt)
      }
      this.db.exec('COMMIT')
    }
    catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** FTS 是派生索引，统一从当前 canonical message 行重建，避免 snapshot 重复产生 FTS 重复项。 */
  private reindexConversation(conversationId: string): void {
    const conversation = this.db.prepare('SELECT title FROM conversations WHERE id = ?').get(conversationId) as { title: string } | undefined
    if (!conversation) return
    const messages = this.db.prepare(`
      SELECT message_id AS messageId, role, channel, content_type AS contentType, text, hidden, recipient
      FROM messages
      WHERE conversation_id = ?
    `).all(conversationId) as Array<{
      messageId: string
      role: string
      channel: string | null
      contentType: string
      text: string
      hidden: number
      recipient: string
    }>

    this.db.prepare('DELETE FROM message_fts WHERE conversation_id = ?').run(conversationId)
    this.db.prepare('DELETE FROM message_fts_trigram WHERE conversation_id = ?').run(conversationId)
    this.db.prepare('DELETE FROM message_fts_all WHERE conversation_id = ?').run(conversationId)
    const insertFts = this.db.prepare('INSERT INTO message_fts (conversation_id, message_id, title, role, text) VALUES (?, ?, ?, ?, ?)')
    const insertTrigram = this.db.prepare('INSERT INTO message_fts_trigram (conversation_id, message_id, title, role, text) VALUES (?, ?, ?, ?, ?)')
    const insertAll = this.db.prepare('INSERT INTO message_fts_all (conversation_id, message_id, title, role, channel, content_type, text) VALUES (?, ?, ?, ?, ?, ?, ?)')

    for (const message of messages) {
      if (message.text.trim()) {
        insertAll.run(conversationId, message.messageId, conversation.title, message.role, message.channel, message.contentType, message.text)
      }
      if (
        message.hidden === 0
        && message.recipient === 'all'
        && (message.role === 'user' || message.role === 'assistant')
        && message.text.trim()
      ) {
        insertFts.run(conversationId, message.messageId, conversation.title, message.role, message.text)
        insertTrigram.run(conversationId, message.messageId, conversation.title, message.role, message.text)
      }
    }
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

  getSource(sourceId: number): ArchiveSourceRow | null {
    const row = this.db.prepare(`
      SELECT
        id,
        source_key AS sourceKey,
        kind,
        display_name AS displayName,
        source_path AS sourcePath,
        observed_at AS observedAt,
        imported_at AS importedAt,
        completed_at AS completedAt,
        is_complete_snapshot AS isCompleteSnapshot,
        conversation_count AS conversationCount,
        asset_count AS assetCount
      FROM archive_sources
      WHERE id = ?
    `).get(sourceId) as unknown as ArchiveSourceRow | undefined
    return row ?? null
  }

  listSources(): ArchiveSourceRow[] {
    return this.db.prepare(`
      SELECT
        id,
        source_key AS sourceKey,
        kind,
        display_name AS displayName,
        source_path AS sourcePath,
        observed_at AS observedAt,
        imported_at AS importedAt,
        completed_at AS completedAt,
        is_complete_snapshot AS isCompleteSnapshot,
        conversation_count AS conversationCount,
        asset_count AS assetCount
      FROM archive_sources
      ORDER BY observed_at, id
    `).all() as unknown as ArchiveSourceRow[]
  }

  schemaFields(sourceId?: number): SchemaFieldObservation[] {
    const rows = sourceId === undefined
      ? this.db.prepare(`
          SELECT entity_kind AS entityKind, field_name AS fieldName, value_type AS valueType, sum(count) AS count
          FROM schema_field_stats
          GROUP BY entity_kind, field_name, value_type
          ORDER BY entity_kind, field_name, value_type
        `).all()
      : this.db.prepare(`
          SELECT entity_kind AS entityKind, field_name AS fieldName, value_type AS valueType, count
          FROM schema_field_stats
          WHERE source_id = ?
          ORDER BY entity_kind, field_name, value_type
        `).all(sourceId)
    return rows as unknown as SchemaFieldObservation[]
  }

  stats(): Record<string, number> {
    const conversationCount = Number((this.db.prepare('SELECT count(*) AS n FROM conversations').get() as { n: number }).n)
    const messageCount = Number((this.db.prepare('SELECT count(*) AS n FROM messages').get() as { n: number }).n)
    const resourceCount = Number((this.db.prepare('SELECT count(*) AS n FROM resources').get() as { n: number }).n)
    const indexedMessageCount = Number((this.db.prepare('SELECT count(*) AS n FROM message_fts').get() as { n: number }).n)
    const trigramIndexedMessageCount = Number((this.db.prepare('SELECT count(*) AS n FROM message_fts_trigram').get() as { n: number }).n)
    const mappingNodeCount = Number((this.db.prepare('SELECT count(*) AS n FROM mapping_nodes').get() as { n: number }).n)
    const snapshotCount = Number((this.db.prepare('SELECT count(*) AS n FROM conversation_snapshots').get() as { n: number }).n)
    const sourceCount = Number((this.db.prepare('SELECT count(*) AS n FROM archive_sources').get() as { n: number }).n)
    const assetCount = Number((this.db.prepare('SELECT count(*) AS n FROM archive_assets').get() as { n: number }).n)
    const sourceMissingConversationCount = Number((this.db.prepare('SELECT count(*) AS n FROM conversations WHERE source_missing = 1').get() as { n: number }).n)
    const sourceMissingAssetCount = Number((this.db.prepare('SELECT count(*) AS n FROM archive_assets WHERE source_missing = 1').get() as { n: number }).n)
    const allIndexedMessageCount = Number((this.db.prepare('SELECT count(*) AS n FROM message_fts_all').get() as { n: number }).n)
    return {
      conversationCount,
      messageCount,
      resourceCount,
      indexedMessageCount,
      trigramIndexedMessageCount,
      mappingNodeCount,
      snapshotCount,
      sourceCount,
      assetCount,
      sourceMissingConversationCount,
      sourceMissingAssetCount,
      allIndexedMessageCount,
    }
  }
}
