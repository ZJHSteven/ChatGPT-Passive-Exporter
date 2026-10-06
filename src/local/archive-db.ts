import { mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { gunzipSync, gzipSync } from 'node:zlib'
import { adaptConversation } from '../core/adapter.ts'
import { extractMessageText } from '../core/adapter.ts'
import { buildRichManifest } from '../core/manifest.ts'
import { extractImageAssets } from '../core/image-assets.ts'
import { conversationToMarkdown } from '../core/markdown.ts'
import { diagnoseLatestRun, diagnoseRuns, type RunDiagnostic } from '../core/run-diagnostics.ts'
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

export interface LiveMergeResult {
  conversationId: string
  title: string
  pageMessageCount: number
  newMessageCount: number
  totalMessageCount: number
  resourceCount: number
  diagnostic: RunDiagnostic
}

export interface LiveMappingMergeResult {
  conversationId: string
  title: string
  nodeCount: number
  messageCount: number
  newMessageCount: number
  totalMessageCount: number
  resourceCount: number
}

export interface ArchiveIncidentRow {
  id: string
  conversationId: string
  turnExchangeId: string | null
  turnKey: string
  incidentKind: 'watchdog-timeout' | 'active-zombie' | 'abnormal-terminal'
  /** 生命周期主类：回答“这一轮为什么算事故”，不与 tail/head 结构混在一起。 */
  lifecycleClass: 'complete-no-final' | 'watchdog-timeout' | 'active-zombie' | 'explicit-interrupted' | 'abnormal-terminal'
  detectedAt: number
  lastObservedAt: number
  resolvedAt: number | null
  status: 'open' | 'resolved'
  reason: string
  terminalEvidence: string
  tailShape: string
  /** canonical current_node 与本次 plural messages[] 的相对关系。 */
  headState: string | null
  /** 是否已经在 head history 中真实观察到 A→B→A/返回旧 head。 */
  headRollbackObserved: boolean
  /** current_node 之后、仍属于同一 turn 的 off-head message 数量。 */
  offHeadSameTurnCount: number
  source: string
  diagnosticJson: string
}

/** DevSpace 聊天级 metadata 与 canonical ChatGPT conversation 的持久 binding。 */
export interface DevSpaceMetadataBindingRow {
  metadataId: string
  conversationId: string | null
  firstSeenAt: number
  lastSeenAt: number
  boundAt: number | null
  lastVerifiedAt: number | null
  evidence: string | null
  confidence: string | null
  lastTurnExchangeId: string | null
  lastRequestId: string | null
  lastAuditId: string | null
  lastAuditAt: number | null
  unboundWatchdogAt: number | null
  unboundNotificationSentAt: number | null
  lifecycleState: 'unbound' | 'active' | 'closed'
}

/**
 * 在线 conversation body 中发现的图片资产映射。
 *
 * 注意：这里只存“索引 + 校验元数据 + 本地文件位置”，PNG/JPEG 二进制始终放在 SQLite 外。
 * `assetPointer` 是长期稳定身份；带 sig 的 estuary URL 只是瞬时下载能力，绝不写进本表。
 */
export interface ImageAssetRow {
  conversationId: string
  messageId: string
  partIndex: number
  assetPointer: string
  fileId: string | null
  assetKind: 'generated-image' | 'image-asset'
  mimeType: string | null
  expectedSizeBytes: number | null
  width: number | null
  height: number | null
  genId: string | null
  parentGenId: string | null
  turnExchangeId: string | null
  firstSeenAt: number
  lastSeenAt: number
  localPath: string | null
  sha256: string | null
  actualSizeBytes: number | null
  downloadedAt: number | null
  lastDownloadAttemptAt: number | null
  downloadError: string | null
  notificationSentAt: number | null
}

function normalizeIncidentRow(row: Record<string, unknown>): ArchiveIncidentRow {
  return {
    ...row,
    headRollbackObserved: Number(row.headRollbackObserved) === 1,
  } as unknown as ArchiveIncidentRow
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
        parent_source TEXT,
        transport_parent_id TEXT,
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

      -- conversation body 中的图片资产只保存元数据与本地文件引用；大二进制不进入 SQLite。
      -- 同一个 message 可以有多张图，因此稳定主键必须包含 part_index。
      CREATE TABLE IF NOT EXISTS image_assets (
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL,
        part_index INTEGER NOT NULL,
        asset_pointer TEXT NOT NULL,
        file_id TEXT,
        asset_kind TEXT NOT NULL,
        mime_type TEXT,
        expected_size_bytes INTEGER,
        width INTEGER,
        height INTEGER,
        gen_id TEXT,
        parent_gen_id TEXT,
        turn_exchange_id TEXT,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        local_path TEXT,
        sha256 TEXT,
        actual_size_bytes INTEGER,
        downloaded_at INTEGER,
        last_download_attempt_at INTEGER,
        download_error TEXT,
        notification_sent_at INTEGER,
        PRIMARY KEY(conversation_id, message_id, part_index)
      );

      CREATE INDEX IF NOT EXISTS image_assets_pointer
        ON image_assets(asset_pointer);

      CREATE INDEX IF NOT EXISTS image_assets_pending_generated
        ON image_assets(asset_kind, downloaded_at, last_download_attempt_at);

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

      -- 在线 body/list/WSS 派生的原始观测单独留档。它和官方 ZIP snapshot 不同：
      -- 同一 conversation 可以在一天里被观察很多次，因此这里使用自增 observation id，
      -- 不能复用 conversation_snapshots 的 (source_id, conversation_id) 唯一键。
      CREATE TABLE IF NOT EXISTS live_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT,
        observation_kind TEXT NOT NULL,
        endpoint TEXT,
        page_cursor TEXT,
        observed_at INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        raw_json_gzip BLOB NOT NULL
      );

      CREATE INDEX IF NOT EXISTS live_observations_conversation_time
        ON live_observations(conversation_id, observed_at DESC);

      -- current_node 只是“这一时刻服务端/前端选中的 head”，不是历史消息的唯一真相。
      -- ChatGPT 在 edit / regenerate / stale-client / branch switch 场景下可能出现 A→B→A；
      -- conversations.current_node 只能保存最新值，因此另外保存 head 变化时间线。
      CREATE TABLE IF NOT EXISTS conversation_head_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        current_node TEXT NOT NULL,
        previous_node TEXT,
        observed_at INTEGER NOT NULL,
        payload_update_time REAL,
        observation_kind TEXT NOT NULL,
        endpoint TEXT
      );

      CREATE INDEX IF NOT EXISTS conversation_head_history_conversation_time
        ON conversation_head_history(conversation_id, observed_at DESC);

      -- incident 是“某一轮的异常历史”，不是 conversation 永久属性。
      -- conversations.incident_state 只保存当前快速状态；完整历史在本表。
      CREATE TABLE IF NOT EXISTS incidents (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        turn_exchange_id TEXT,
        turn_key TEXT,
        incident_kind TEXT NOT NULL DEFAULT 'abnormal-terminal',
        lifecycle_class TEXT,
        detected_at INTEGER NOT NULL,
        last_observed_at INTEGER,
        resolved_at INTEGER,
        status TEXT NOT NULL,
        reason TEXT NOT NULL,
        terminal_evidence TEXT NOT NULL,
        tail_shape TEXT NOT NULL,
        head_state TEXT,
        head_rollback INTEGER NOT NULL DEFAULT 0,
        off_head_same_turn_count INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL,
        diagnostic_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS incidents_conversation_status
        ON incidents(conversation_id, status, detected_at DESC);

      -- DevSpace 的 openai/session 是 conversation 级匿名键，不是 turn key。
      -- 未绑定 metadata 也必须先落盘：第一次 remote tool call 就是我们想保留的 start 下界；
      -- 后续一旦通过 WSS/body/correlation 解出 canonical conversation，再原位补 binding。
      CREATE TABLE IF NOT EXISTS devspace_metadata_bindings (
        metadata_id TEXT PRIMARY KEY,
        conversation_id TEXT,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        bound_at INTEGER,
        last_verified_at INTEGER,
        evidence TEXT,
        confidence TEXT,
        last_turn_exchange_id TEXT,
        last_request_id TEXT,
        last_audit_id TEXT,
        last_audit_at INTEGER,
        unbound_watchdog_at INTEGER,
        unbound_notification_sent_at INTEGER,
        lifecycle_state TEXT NOT NULL DEFAULT 'unbound'
      );

      CREATE INDEX IF NOT EXISTS devspace_metadata_bindings_conversation
        ON devspace_metadata_bindings(conversation_id, last_seen_at DESC);

      CREATE INDEX IF NOT EXISTS devspace_metadata_bindings_unbound
        ON devspace_metadata_bindings(lifecycle_state, last_seen_at DESC);
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
    // `metadata.parent_id` 与官方 mapping.parent 不是同一个语义：2026-09-13 在真实长会话中
    // 观察到大量不一致。额外记录 parent 来源，避免后来的 plural body 把官方树关系覆盖掉。
    this.ensureColumn('mapping_nodes', 'parent_source', 'TEXT')
    this.ensureColumn('mapping_nodes', 'transport_parent_id', 'TEXT')
    this.ensureColumn('incidents', 'turn_key', 'TEXT')
    this.ensureColumn('incidents', 'incident_kind', "TEXT NOT NULL DEFAULT 'abnormal-terminal'")
    this.ensureColumn('incidents', 'last_observed_at', 'INTEGER')
    this.ensureColumn('incidents', 'lifecycle_class', 'TEXT')
    this.ensureColumn('incidents', 'head_state', 'TEXT')
    this.ensureColumn('incidents', 'head_rollback', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('incidents', 'off_head_same_turn_count', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('devspace_metadata_bindings', 'unbound_watchdog_at', 'INTEGER')
    this.ensureColumn('devspace_metadata_bindings', 'unbound_notification_sent_at', 'INTEGER')

    // Incident 的稳定身份必须属于某一个 turn，而不是“这个 conversation 当前有一张红牌”。
    // 旧库已有少量 incident：优先沿用 turn_exchange_id；极少数没有 turn id 的历史行退化用自身 id，
    // 只为保证迁移唯一性。新写入会使用 turn_exchange_id/user message/last message 生成稳定 turn_key。
    this.db.prepare(`
      UPDATE incidents
      SET turn_key = COALESCE(NULLIF(turn_key, ''), NULLIF(turn_exchange_id, ''), id),
          last_observed_at = COALESCE(last_observed_at, resolved_at, detected_at),
          lifecycle_class = COALESCE(NULLIF(lifecycle_class, ''), CASE
            WHEN incident_kind = 'watchdog-timeout' THEN 'watchdog-timeout'
            WHEN terminal_evidence IN ('client-stopped', 'interrupted') THEN 'explicit-interrupted'
            WHEN source LIKE '%conversation-turn-complete%'
              OR source LIKE '%async-complete%'
              OR reason LIKE '历史 turn 后续已经出现更新的 user turn%'
            THEN 'complete-no-final'
            ELSE 'abnormal-terminal'
          END)
      WHERE turn_key IS NULL OR turn_key = ''
         OR last_observed_at IS NULL
         OR lifecycle_class IS NULL OR lifecycle_class = ''
    `).run()
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS incidents_conversation_turn
      ON incidents(conversation_id, turn_key)
    `)

    // 旧 live merge 曾把 metadata.parent_id 直接塞进 parent_id。现在已确认该字段属于
    // transport/request 关联，不是 mapping tree 边，因此一次性搬到独立列并清空伪树边。
    // official-mapping 行完全不受影响；迁移可重复执行，因为只匹配旧来源标记。
    const inferredParents = this.db.prepare(`
      SELECT DISTINCT conversation_id AS conversationId, parent_id AS parentId
      FROM mapping_nodes
      WHERE parent_source = 'live-metadata-inferred' AND parent_id IS NOT NULL
    `).all() as Array<{ conversationId: string, parentId: string }>
    if (inferredParents.length > 0) {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        this.db.prepare(`
          UPDATE mapping_nodes
          SET transport_parent_id = COALESCE(transport_parent_id, parent_id),
              parent_id = NULL,
              parent_source = 'live-transport-only'
          WHERE parent_source = 'live-metadata-inferred'
        `).run()
        const rebuildChildren = this.db.prepare(`
          UPDATE mapping_nodes
          SET children_json = (
            SELECT json_group_array(node_id)
            FROM (
              SELECT node_id
              FROM mapping_nodes child
              WHERE child.conversation_id = ? AND child.parent_id = ?
              ORDER BY COALESCE(child.source_observed_at, 0), child.node_id
            )
          )
          WHERE conversation_id = ? AND node_id = ?
        `)
        for (const row of inferredParents) {
          rebuildChildren.run(row.conversationId, row.parentId, row.conversationId, row.parentId)
        }
        this.db.exec('COMMIT')
      }
      catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
    }
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
        conversation_id, node_id, parent_id, parent_source, message_id, children_json, extra_json,
        first_seen_at, last_seen_at, source_observed_at
      ) VALUES (?, ?, ?, 'official-mapping', ?, ?, ?, ?, ?, ?)
      ON CONFLICT(conversation_id, node_id) DO UPDATE SET
        first_seen_at=min(mapping_nodes.first_seen_at, excluded.first_seen_at),
        last_seen_at=max(mapping_nodes.last_seen_at, excluded.last_seen_at),
        -- 官方 Data Export 的 mapping.parent 是真正的树边，优先级高于在线
        -- messages[].metadata.parent_id；即使官方快照时间早于 live observation，也不能反过来。
        parent_id=excluded.parent_id,
        parent_source='official-mapping',
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

  /**
   * 重建全文索引。
   *
   * Genesis 导入故意把 FTS 放到所有 ZIP merge 完以后一次性执行。旧实现每导一个 conversation
   * 就对三张 FTS 表做 DELETE/SELECT/INSERT，真实 5000+ conversation 上会退化成非常慢的
   * O(N × FTS-maintenance) 工作。这里直接清空派生索引并顺序扫描 canonical messages 一次。
   *
   * 在线增量同步以后可以再加“只重建 dirty conversation”的 overload；全量 Genesis 先走最快、
   * 最容易证明一致性的全 rebuild。
   */
  rebuildSearchIndexes(options: { includeAuditText?: boolean } = {}): void {
    const messages = this.db.prepare(`
      SELECT
        m.conversation_id AS conversationId,
        m.message_id AS messageId,
        c.title AS title,
        m.role,
        m.channel,
        m.content_type AS contentType,
        m.text,
        m.hidden,
        m.recipient
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      ORDER BY m.row_id
    `).iterate() as Iterable<{
      conversationId: string
      messageId: string
      title: string
      role: string
      channel: string | null
      contentType: string
      text: string
      hidden: number
      recipient: string
    }>

    const insertFts = this.db.prepare('INSERT INTO message_fts (conversation_id, message_id, title, role, text) VALUES (?, ?, ?, ?, ?)')
    const insertTrigram = this.db.prepare('INSERT INTO message_fts_trigram (conversation_id, message_id, title, role, text) VALUES (?, ?, ?, ?, ?)')
    const insertAll = this.db.prepare('INSERT INTO message_fts_all (conversation_id, message_id, title, role, channel, content_type, text) VALUES (?, ?, ?, ?, ?, ?, ?)')

    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.exec(`
        DELETE FROM message_fts;
        DELETE FROM message_fts_trigram;
        DELETE FROM message_fts_all;
      `)
      for (const message of messages) {
        if (options.includeAuditText && message.text.trim()) {
          insertAll.run(
            message.conversationId,
            message.messageId,
            message.title,
            message.role,
            message.channel,
            message.contentType,
            message.text,
          )
        }
        if (
          message.hidden === 0
          && message.recipient === 'all'
          && (message.role === 'user' || message.role === 'assistant')
          && message.text.trim()
        ) {
          insertFts.run(message.conversationId, message.messageId, message.title, message.role, message.text)
          insertTrigram.run(message.conversationId, message.messageId, message.title, message.role, message.text)
        }
      }
      this.db.exec('COMMIT')
    }
    catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * 只为一次显式的“全审计搜索”建立巨大 tool/reasoning 索引。
   * 默认 Genesis 不调用它，避免长 Agent 工具返回把常驻数据库构建拉到数 GB 内存。
   */
  rebuildAuditSearchIndex(): void {
    this.rebuildSearchIndexes({ includeAuditText: true })
  }

  /** 返回一页 message id 中哪些已经存在，用于 body cursor overlap 停止判定。 */
  knownMessageIds(conversationId: string, messageIds: string[]): Set<string> {
    const known = new Set<string>()
    const query = this.db.prepare(`
      SELECT 1 AS present
      FROM messages
      WHERE conversation_id = ? AND message_id = ?
      LIMIT 1
    `)
    for (const messageId of messageIds) {
      if (query.get(conversationId, messageId)) known.add(messageId)
    }
    return known
  }

  /**
   * 合并当前 first-party plural body 的一页 messages[]。
   *
   * 与 importRaw() 的关键区别：这里永远不删除 conversation 历史。页面只返回最近 10 turns
   * 也没关系；已存在 message 按 observedAt 更新 canonical，未知 message 插入，本地更老消息保留。
   */
  mergeLiveMessagesPage(
    payload: unknown,
    options: {
      observedAt?: number
      endpoint?: string
      pageCursor?: string | null
      observationKind?: string
      /** 只有 WSS complete / watchdog terminal verification 才允许新建 incident。 */
      classifyTerminal?: boolean
      /**
       * 这一页是否代表 conversation 的“当前最新头”。
       * cursor 历史页只能补 messages/nodes/raw observation，绝不能覆盖 current_node、head history、
       * terminal_state 或 incident_state。daemon 只会给第一页传 true。
       */
      updateCurrentState?: boolean
      /** watchdog 超时和已确认 abnormal terminal 都是 incident，但语义不同。 */
      incidentKind?: 'watchdog-timeout' | 'active-zombie' | 'abnormal-terminal'
      /**
       * 是否允许这次 merge 更新 incident ledger。
       *
       * 浏览器内存/离线 forensic recovery 只是在补“已经观察到、但 canonical body 没持久化”的
       * 消息事实；它本身不是服务器 lifecycle 证据，因此必须能完全跳过 incident 推断/刷新。
       */
      updateIncidents?: boolean
      /**
       * 只插入当前数据库里还不存在的 message_id。
       *
       * 浏览器内存 recovery 的 payload 通常只含 DOM 可见字段，信息量远少于 first-party body；
       * 已知 message 若被这种简化 payload upsert，会反向覆盖 canonical metadata/raw_json。
       * 因此 recovery 必须使用 insertUnknownOnly=true，正常 live body 同步仍保持完整 upsert。
       */
      insertUnknownOnly?: boolean
      /**
       * 是否已有外部证据确认这一轮已经结束。
       * false 时仍可记录 explicit client_stopped/interrupted，但不能把 open reasoning/tool 尾巴
       * 单独解释成异常终止；这用于 watchdog / gap repair 防止误报仍在正常运行的长任务。
       */
      allowIncompleteTailIncident?: boolean
    } = {},
  ): LiveMergeResult {
    const conversation = adaptConversation(payload)
    if (conversation.sourceFormat !== 'messages') throw new Error('Live merge currently requires a plural messages[] payload')
    const conversationId = conversation.conversationId
    if (!conversationId) throw new Error('Live messages payload has no conversation_id')

    const rawPayload = record(payload)
    const observedAt = options.observedAt ?? Date.now()
    const now = Date.now()
    const updateCurrentState = options.updateCurrentState !== false
    const rawText = json(payload)
    const messageIds = conversation.messages.map(message => message.id)
    const knownBefore = this.knownMessageIds(conversationId, messageIds)

    const upsertConversation = this.db.prepare(`
      INSERT INTO conversations (
        id, title, source_format, current_node, captured_at, imported_at,
        message_count, resource_count, markdown,
        create_time, update_time, first_seen_at, last_seen_at, source_missing
      ) VALUES (?, ?, 'messages', ?, ?, ?, 0, 0, '', ?, ?, ?, ?, 0)
      ON CONFLICT(id) DO UPDATE SET
        title=excluded.title,
        source_format='messages',
        current_node=COALESCE(excluded.current_node, conversations.current_node),
        captured_at=max(conversations.captured_at, excluded.captured_at),
        imported_at=excluded.imported_at,
        create_time=COALESCE(conversations.create_time, excluded.create_time),
        update_time=CASE
          WHEN excluded.update_time IS NULL THEN conversations.update_time
          WHEN conversations.update_time IS NULL THEN excluded.update_time
          ELSE max(conversations.update_time, excluded.update_time)
        END,
        first_seen_at=min(COALESCE(conversations.first_seen_at, excluded.first_seen_at), excluded.first_seen_at),
        last_seen_at=max(COALESCE(conversations.last_seen_at, excluded.last_seen_at), excluded.last_seen_at),
        source_missing=0
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(conversation_id, message_id) DO UPDATE SET
        last_seen_at=max(COALESCE(messages.last_seen_at, excluded.last_seen_at), excluded.last_seen_at),
        role=excluded.role,
        author_name=excluded.author_name,
        recipient=excluded.recipient,
        channel=excluded.channel,
        content_type=excluded.content_type,
        text=excluded.text,
        hidden=excluded.hidden,
        create_time=COALESCE(excluded.create_time, messages.create_time),
        metadata_json=excluded.metadata_json,
        role_raw=excluded.role_raw,
        update_time=COALESCE(excluded.update_time, messages.update_time),
        status=excluded.status,
        end_turn=excluded.end_turn,
        weight=excluded.weight,
        request_id=excluded.request_id,
        turn_exchange_id=excluded.turn_exchange_id,
        model_slug=excluded.model_slug,
        resolved_model_slug=excluded.resolved_model_slug,
        finish_type=excluded.finish_type,
        finish_reason=excluded.finish_reason,
        reasoning_status=excluded.reasoning_status,
        author_json=excluded.author_json,
        content_json=excluded.content_json,
        raw_json=excluded.raw_json,
        source_observed_at=max(COALESCE(messages.source_observed_at, 0), excluded.source_observed_at)
    `)
    const insertPart = this.db.prepare(`
      INSERT INTO message_parts (
        conversation_id, message_id, part_index, source_field, part_kind, text_value, json_value
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    /**
     * 新式 plural body 虽然没有旧 `mapping{}` 大对象，但每条 message 常带 metadata.parent_id。
     * 2026-09-13 的真实对账证明：这个字段**不能**等同于旧 mapping.parent，甚至经常指向一个
     * 根本不存在于官方 mapping 的 transport/request id。因此：
     * - `message.id` 仍可安全作为 node_id（Genesis 103260/103260 一致）；
     * - metadata.parent_id 只进入 `transport_parent_id`；
     * - 真正的 parent_id / children_json 只接受 official/singular mapping。
     *
     * 没有 exact mapping 时宁可暂时没有树边，也不能制造一个看似完整但语义错误的 branch tree。
     */
    const upsertMappingNode = this.db.prepare(`
      INSERT INTO mapping_nodes (
        conversation_id, node_id, parent_id, parent_source, transport_parent_id,
        message_id, children_json, extra_json,
        first_seen_at, last_seen_at, source_observed_at
      ) VALUES (?, ?, NULL, 'live-transport-only', ?, ?, NULL, '{}', ?, ?, ?)
      ON CONFLICT(conversation_id, node_id) DO UPDATE SET
        first_seen_at=min(mapping_nodes.first_seen_at, excluded.first_seen_at),
        last_seen_at=max(mapping_nodes.last_seen_at, excluded.last_seen_at),
        transport_parent_id=COALESCE(excluded.transport_parent_id, mapping_nodes.transport_parent_id),
        parent_source=CASE
          WHEN mapping_nodes.parent_source IN ('official-mapping', 'live-singular-mapping')
          THEN mapping_nodes.parent_source
          ELSE 'live-transport-only'
        END,
        message_id=COALESCE(excluded.message_id, mapping_nodes.message_id),
        source_observed_at=max(mapping_nodes.source_observed_at, excluded.source_observed_at)
    `)
    const latestRecordedHead = this.db.prepare(`
      SELECT current_node AS currentNode
      FROM conversation_head_history
      WHERE conversation_id = ?
      ORDER BY observed_at DESC, id DESC
      LIMIT 1
    `)
    const insertHeadHistory = this.db.prepare(`
      INSERT INTO conversation_head_history (
        conversation_id, current_node, previous_node, observed_at,
        payload_update_time, observation_kind, endpoint
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `)

    this.db.exec('BEGIN IMMEDIATE')
    try {
      const conversationExists = Boolean(this.db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(conversationId))
      if (updateCurrentState || !conversationExists) {
        upsertConversation.run(
          conversationId,
          conversation.title,
          conversation.currentNode ?? null,
          observedAt,
          now,
          numberValue(rawPayload.create_time),
          numberValue(rawPayload.update_time),
          observedAt,
          observedAt,
        )
      }

      // 连续 cursor page / 重试经常带同一个 current_node；只记录真正的 head 变化，
      // 既能审计 A→B→A，又不会让分页同步把该表刷成另一份 observation 日志。
      if (updateCurrentState && conversation.currentNode) {
        const priorHead = latestRecordedHead.get(conversationId) as { currentNode?: string } | undefined
        if (priorHead?.currentNode !== conversation.currentNode) {
          insertHeadHistory.run(
            conversationId,
            conversation.currentNode,
            priorHead?.currentNode ?? null,
            observedAt,
            numberValue(rawPayload.update_time),
            options.observationKind ?? 'body-page',
            options.endpoint ?? null,
          )
        }
      }

      conversation.messages.forEach((message, pageOrdinal) => {
        if (options.insertUnknownOnly === true && knownBefore.has(message.id)) return
        const rawMessage = record(message.raw)
        const author = record(rawMessage.author)
        const content = record(rawMessage.content)
        const metadata = record(rawMessage.metadata)
        const finishDetails = record(metadata.finish_details)
        const parentId = stringValue(metadata.parent_id)
        upsertMessage.run(
          conversationId,
          message.id,
          pageOrdinal,
          message.role,
          message.authorName ?? null,
          message.recipient,
          message.channel ?? null,
          message.contentType,
          message.text,
          message.hidden ? 1 : 0,
          numberValue(rawMessage.create_time),
          json(metadata),
          canonicalRole(author.role),
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
          observedAt,
          observedAt,
          observedAt,
        )

        upsertMappingNode.run(
          conversationId,
          message.id,
          parentId,
          message.id,
          observedAt,
          observedAt,
          observedAt,
        )

        this.db.prepare('DELETE FROM message_parts WHERE conversation_id = ? AND message_id = ?').run(conversationId, message.id)
        if (Array.isArray(content.parts)) {
          content.parts.forEach((part, partIndex) => {
            const kind = part === null ? 'null' : Array.isArray(part) ? 'array' : typeof part === 'object' ? 'object' : typeof part
            insertPart.run(
              conversationId,
              message.id,
              partIndex,
              'parts',
              kind,
              typeof part === 'string' ? part : null,
              typeof part === 'string' ? null : json(part),
            )
          })
        }
      })

      this.db.prepare(`
        INSERT INTO live_observations (
          conversation_id, observation_kind, endpoint, page_cursor, observed_at, sha256, raw_json_gzip
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        conversationId,
        options.observationKind ?? 'body-page',
        options.endpoint ?? null,
        options.pageCursor ?? null,
        observedAt,
        sha256Text(rawText),
        gzipSync(Buffer.from(rawText, 'utf8')),
      )

      this.rebuildConversationDerivedInsideTransaction(conversationId)
      this.db.exec('COMMIT')
    }
    catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }

    const diagnostics = diagnoseRuns(payload as never)
    const diagnostic = diagnostics.at(-1) ?? diagnoseLatestRun(payload as never)

    if (options.updateIncidents !== false) {
    // page/cursor 只是运输容器：所有已经被“后续 user turn”越过的旧 turn，都有资格补自己的
    // 历史 incident。它们绝不能更新 conversation 当前汇总状态，也不能把另一个当前 turn 的
    // open incident 顺手 resolve 掉。cursor 历史页中的所有完整 user turn 都属于这种情况；
    // latest 第一页则只有最后一个 turn 是“当前”，前面的 turn 全部按历史处理。
    const historicalDiagnostics = updateCurrentState ? diagnostics.slice(0, -1) : diagnostics
    for (const historical of historicalDiagnostics) {
      // 没有 userMessageId 的片段可能是未来协议下的分页边界残片；没有稳定 turn 身份时，
      // 宁可只保存事实数据，也不凭残片制造历史事故。
      if (!historical.userMessageId) continue
      // `other` 只表示“没有识别到 final，也没有识别到明确的 reasoning/tool 运行尾型”。
      // 其中会混入 user-only、system-only、编辑/分支残片等情况；历史补账不能仅凭“后面有
      // 新 user turn”就把这些模糊形态全部登记成事故。显式 interrupted/client_stopped 例外。
      const explicitHistoricalAbnormal = historical.terminalEvidence === 'client-stopped'
        || historical.terminalEvidence === 'interrupted'
      // 运行中 steering 会在同一 turn_exchange_id / request_id 内插入新的 user message。
      // 这类 turn 随后即使以 reasoning-ended-no-final 收尾，也不能仅凭“后来出现新 turn”
      // 自动推断为异常；只有显式 interrupted/client_stopped 才保留历史 incident。
      if (!explicitHistoricalAbnormal && historical.hasInTurnSteering) continue
      if (!explicitHistoricalAbnormal && historical.tailShape === 'other') continue
      this.updateIncidentFromDiagnostic(
        conversationId,
        historical,
        observedAt,
        true,
        true,
        'abnormal-terminal',
        `${options.observationKind ?? 'realtime-body'}:historical-turn`,
        false,
        true,
      )
    }
    if (updateCurrentState) {
      this.updateIncidentFromDiagnostic(
        conversationId,
        diagnostic,
        observedAt,
        options.classifyTerminal === true,
        options.allowIncompleteTailIncident !== false,
        options.incidentKind ?? 'abnormal-terminal',
        options.observationKind ?? 'realtime-body',
        true,
        false,
      )
    }
    }
    const counts = this.db.prepare(`
      SELECT message_count AS messageCount, resource_count AS resourceCount
      FROM conversations WHERE id = ?
    `).get(conversationId) as { messageCount: number, resourceCount: number }
    return {
      conversationId,
      title: conversation.title,
      pageMessageCount: conversation.messages.length,
      newMessageCount: messageIds.filter(id => !knownBefore.has(id)).length,
      totalMessageCount: Number(counts.messageCount),
      resourceCount: Number(counts.resourceCount),
      diagnostic,
    }
  }

  /**
   * 合并 first-party legacy singular `/backend-api/conversation/{id}` 的完整 mapping tree。
   *
   * 该接口只在 modern plural 明确出现 `metadata.has_versions=true`、而本地还没有 exact mapping
   * 时按需调用。它与旧 `importRaw()` 的最大区别是**绝不 DELETE conversation**：
   * - 所有 mapping node 按 node_id union/upsert；
   * - sibling branch 的 message 同样按 message_id union/upsert；
   * - 已经存在但当前 singular snapshot 没展示的历史节点仍然保留；
   * - mapping.parent / children 记为 `live-singular-mapping`，可覆盖此前 transport-only 占位。
   *
   * 这让 edit user prompt / regenerate assistant 的树关系有一条真正 first-party 的事实源，
   * 而不是继续猜 `messages[].metadata.parent_id`。
   */
  mergeLiveMappingSnapshot(
    payload: unknown,
    options: {
      observedAt?: number
      endpoint?: string
      observationKind?: string
    } = {},
  ): LiveMappingMergeResult {
    const rawConversation = record(payload)
    const mapping = record(rawConversation.mapping)
    const conversationId = stringValue(rawConversation.conversation_id) ?? stringValue(rawConversation.id)
    if (!conversationId || Object.keys(mapping).length === 0) {
      throw new Error('Live mapping snapshot has no conversation_id or mapping')
    }

    const canonical = adaptConversation(rawConversation)
    const observedAt = options.observedAt ?? Date.now()
    const now = Date.now()
    const rawText = json(payload)
    const messageIds = Object.values(mapping)
      .map(node => stringValue(record(record(node).message).id))
      .filter((id): id is string => Boolean(id))
    const knownBefore = this.knownMessageIds(conversationId, messageIds)

    const upsertConversation = this.db.prepare(`
      INSERT INTO conversations (
        id, title, source_format, current_node, captured_at, imported_at,
        message_count, resource_count, markdown,
        create_time, update_time, first_seen_at, last_seen_at, source_missing
      ) VALUES (?, ?, 'mapping', ?, ?, ?, 0, 0, '', ?, ?, ?, ?, 0)
      ON CONFLICT(id) DO UPDATE SET
        title=excluded.title,
        current_node=COALESCE(excluded.current_node, conversations.current_node),
        captured_at=max(conversations.captured_at, excluded.captured_at),
        imported_at=excluded.imported_at,
        create_time=COALESCE(conversations.create_time, excluded.create_time),
        update_time=CASE
          WHEN excluded.update_time IS NULL THEN conversations.update_time
          WHEN conversations.update_time IS NULL THEN excluded.update_time
          ELSE max(conversations.update_time, excluded.update_time)
        END,
        first_seen_at=min(COALESCE(conversations.first_seen_at, excluded.first_seen_at), excluded.first_seen_at),
        last_seen_at=max(COALESCE(conversations.last_seen_at, excluded.last_seen_at), excluded.last_seen_at),
        source_missing=0
    `)
    const upsertNode = this.db.prepare(`
      INSERT INTO mapping_nodes (
        conversation_id, node_id, parent_id, parent_source, transport_parent_id,
        message_id, children_json, extra_json, first_seen_at, last_seen_at, source_observed_at
      ) VALUES (?, ?, ?, 'live-singular-mapping', ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(conversation_id, node_id) DO UPDATE SET
        first_seen_at=min(mapping_nodes.first_seen_at, excluded.first_seen_at),
        last_seen_at=max(mapping_nodes.last_seen_at, excluded.last_seen_at),
        parent_id=excluded.parent_id,
        parent_source='live-singular-mapping',
        transport_parent_id=COALESCE(excluded.transport_parent_id, mapping_nodes.transport_parent_id),
        message_id=COALESCE(excluded.message_id, mapping_nodes.message_id),
        children_json=excluded.children_json,
        extra_json=excluded.extra_json,
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
        last_seen_at=max(COALESCE(messages.last_seen_at, excluded.last_seen_at), excluded.last_seen_at),
        ordinal=excluded.ordinal,
        role=excluded.role,
        author_name=excluded.author_name,
        recipient=excluded.recipient,
        channel=excluded.channel,
        content_type=excluded.content_type,
        text=excluded.text,
        hidden=excluded.hidden,
        create_time=COALESCE(excluded.create_time, messages.create_time),
        metadata_json=excluded.metadata_json,
        node_id=excluded.node_id,
        role_raw=excluded.role_raw,
        update_time=COALESCE(excluded.update_time, messages.update_time),
        status=excluded.status,
        end_turn=excluded.end_turn,
        weight=excluded.weight,
        request_id=excluded.request_id,
        turn_exchange_id=excluded.turn_exchange_id,
        model_slug=excluded.model_slug,
        resolved_model_slug=excluded.resolved_model_slug,
        finish_type=excluded.finish_type,
        finish_reason=excluded.finish_reason,
        reasoning_status=excluded.reasoning_status,
        author_json=excluded.author_json,
        content_json=excluded.content_json,
        raw_json=excluded.raw_json,
        source_observed_at=max(COALESCE(messages.source_observed_at, 0), excluded.source_observed_at)
    `)
    const insertPart = this.db.prepare(`
      INSERT INTO message_parts (
        conversation_id, message_id, part_index, source_field, part_kind, text_value, json_value
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    const latestRecordedHead = this.db.prepare(`
      SELECT current_node AS currentNode
      FROM conversation_head_history
      WHERE conversation_id = ?
      ORDER BY observed_at DESC, id DESC
      LIMIT 1
    `)
    const insertHeadHistory = this.db.prepare(`
      INSERT INTO conversation_head_history (
        conversation_id, current_node, previous_node, observed_at,
        payload_update_time, observation_kind, endpoint
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `)

    this.db.exec('BEGIN IMMEDIATE')
    try {
      upsertConversation.run(
        conversationId,
        stringValue(rawConversation.title) ?? canonical.title,
        stringValue(rawConversation.current_node),
        observedAt,
        now,
        numberValue(rawConversation.create_time),
        numberValue(rawConversation.update_time),
        observedAt,
        observedAt,
      )

      const currentNode = stringValue(rawConversation.current_node)
      if (currentNode) {
        const priorHead = latestRecordedHead.get(conversationId) as { currentNode?: string } | undefined
        if (priorHead?.currentNode !== currentNode) {
          insertHeadHistory.run(
            conversationId,
            currentNode,
            priorHead?.currentNode ?? null,
            observedAt,
            numberValue(rawConversation.update_time),
            options.observationKind ?? 'mapping-snapshot',
            options.endpoint ?? null,
          )
        }
      }

      let ordinal = 0
      for (const [mappingKey, rawNodeValue] of Object.entries(mapping)) {
        const rawNode = record(rawNodeValue)
        const nodeId = stringValue(rawNode.id) ?? mappingKey
        const rawMessage = record(rawNode.message)
        const messageId = stringValue(rawMessage.id)
        const metadata = record(rawMessage.metadata)
        upsertNode.run(
          conversationId,
          nodeId,
          stringValue(rawNode.parent),
          stringValue(metadata.parent_id),
          messageId,
          Array.isArray(rawNode.children) ? json(rawNode.children) : null,
          jsonWithoutKeys(rawNode, NODE_KNOWN_KEYS),
          observedAt,
          observedAt,
          observedAt,
        )

        if (messageId) {
          const author = record(rawMessage.author)
          const content = record(rawMessage.content)
          const finishDetails = record(metadata.finish_details)
          const roleRaw = canonicalRole(author.role)
          upsertMessage.run(
            conversationId,
            messageId,
            ordinal,
            roleRaw,
            stringValue(author.name),
            stringValue(rawMessage.recipient) ?? 'all',
            stringValue(rawMessage.channel),
            stringValue(content.content_type) ?? 'unknown',
            extractMessageText(rawMessage),
            metadata.is_visually_hidden_from_conversation === true ? 1 : 0,
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
            observedAt,
            observedAt,
            observedAt,
          )

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
        }
        ordinal += 1
      }

      this.db.prepare(`
        INSERT INTO live_observations (
          conversation_id, observation_kind, endpoint, page_cursor, observed_at, sha256, raw_json_gzip
        ) VALUES (?, ?, ?, NULL, ?, ?, ?)
      `).run(
        conversationId,
        options.observationKind ?? 'mapping-snapshot',
        options.endpoint ?? null,
        observedAt,
        sha256Text(rawText),
        gzipSync(Buffer.from(rawText, 'utf8')),
      )

      this.rebuildConversationDerivedInsideTransaction(conversationId)
      this.db.exec('COMMIT')
    }
    catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }

    const counts = this.db.prepare(`
      SELECT message_count AS messageCount, resource_count AS resourceCount
      FROM conversations WHERE id = ?
    `).get(conversationId) as { messageCount: number, resourceCount: number }
    return {
      conversationId,
      title: stringValue(rawConversation.title) ?? canonical.title,
      nodeCount: Object.keys(mapping).length,
      messageCount: messageIds.length,
      newMessageCount: messageIds.filter(id => !knownBefore.has(id)).length,
      totalMessageCount: Number(counts.messageCount),
      resourceCount: Number(counts.resourceCount),
    }
  }

  /**
   * 用已经保存在数据库里的“最新官方 conversation snapshot”修复 mapping tree 的 parent。
   *
   * 背景：早期 live merge 曾错误把 messages[].metadata.parent_id 当成 mapping.parent，因此
   * 2026-09-01 Genesis 之后又被在线同步碰过的旧节点，parent_id 可能被推断值覆盖。好在官方
   * snapshot 始终以 gzip 原样保留，所以这里可以离线、零网络地恢复权威 parent；官方包之后
   * 才出现的新节点则保留 `live-metadata-inferred`，等待未来官方快照或更可靠在线版本协议确认。
   *
   * 这是可重复执行的修复操作：同一个节点每次都会得到相同的官方 parent。修复后按数据库里
   * 当前全部 parent_id 重新计算 children_json，因此不会把 Genesis 之后新增的 live-only child
   * 从父节点 children 列表里意外删掉。
   */
  repairMappingParentsFromOfficialSnapshots(): { conversations: number, nodes: number, inferredOnly: number } {
    const latestSnapshots = this.db.prepare(`
      SELECT s.conversation_id AS conversationId, s.raw_json_gzip AS rawGzip
      FROM conversation_snapshots s
      WHERE s.source_id = (
        SELECT s2.source_id
        FROM conversation_snapshots s2
        WHERE s2.conversation_id = s.conversation_id
        ORDER BY s2.observed_at DESC, s2.source_id DESC
        LIMIT 1
      )
      ORDER BY s.conversation_id
    `)
    const updateOfficialParent = this.db.prepare(`
      UPDATE mapping_nodes
      SET parent_id = ?, parent_source = 'official-mapping'
      WHERE conversation_id = ? AND node_id = ?
    `)
    const updateChildren = this.db.prepare(`
      UPDATE mapping_nodes
      SET children_json = (
        SELECT json_group_array(node_id)
        FROM (
          SELECT node_id
          FROM mapping_nodes child
          WHERE child.conversation_id = ? AND child.parent_id = ?
          ORDER BY COALESCE(child.source_observed_at, 0), child.node_id
        )
      )
      WHERE conversation_id = ? AND node_id = ?
    `)
    const parentRows = this.db.prepare(`
      SELECT DISTINCT conversation_id AS conversationId, parent_id AS parentId
      FROM mapping_nodes
      WHERE parent_id IS NOT NULL
    `)

    let conversations = 0
    let nodes = 0
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const row of latestSnapshots.iterate() as Iterable<{ conversationId: string, rawGzip: Uint8Array }>) {
        const raw = JSON.parse(gunzipSync(Buffer.from(row.rawGzip)).toString('utf8')) as unknown
        const mapping = record(record(raw).mapping)
        if (Object.keys(mapping).length === 0) continue
        conversations += 1
        for (const [mappingKey, nodeValue] of Object.entries(mapping)) {
          const node = record(nodeValue)
          const nodeId = stringValue(node.id) ?? mappingKey
          const result = updateOfficialParent.run(stringValue(node.parent), row.conversationId, nodeId)
          nodes += Number(result.changes)
        }
      }

      // parent 被修回官方语义以后，children 必须跟当前数据库中的全部节点重新一致。
      for (const row of parentRows.iterate() as Iterable<{ conversationId: string, parentId: string }>) {
        updateChildren.run(row.conversationId, row.parentId, row.conversationId, row.parentId)
      }
      // 旧数据库在新增 parent_source 列时，Genesis 之后才出现的 live-only 行会暂时是 NULL。
      // 官方 snapshot 已经在上面全部打上 official-mapping，剩余“有 parent 但无标记”的行
      // 只能来自旧 live merge，因此统一补成推断来源；根节点 parent=NULL 则不强行猜来源。
      this.db.prepare(`
        UPDATE mapping_nodes
        SET parent_source = 'live-metadata-inferred'
        WHERE parent_source IS NULL AND parent_id IS NOT NULL
      `).run()
      this.db.exec('COMMIT')
    }
    catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }

    const inferredOnly = Number((this.db.prepare(`
      SELECT count(*) AS n
      FROM mapping_nodes
      WHERE parent_source = 'live-metadata-inferred'
    `).get() as { n: number }).n)
    return { conversations, nodes, inferredOnly }
  }

  /** 在线增量只重建一个 conversation 的派生表，避免全库 FTS/资源重算。 */
  private rebuildConversationDerivedInsideTransaction(conversationId: string): void {
    const conversationRow = this.db.prepare('SELECT title FROM conversations WHERE id = ?').get(conversationId) as { title: string }
    const rows = [...this.db.prepare(`
      SELECT row_id AS rowId, message_id AS messageId, role, author_name AS authorName,
             recipient, channel, content_type AS contentType, text, hidden,
             create_time AS createTime, raw_json AS rawJson
      FROM messages
      WHERE conversation_id = ?
      ORDER BY COALESCE(create_time, 0), row_id
    `).iterate(conversationId)] as Array<{
      rowId: number
      messageId: string
      role: string
      authorName: string | null
      recipient: string
      channel: string | null
      contentType: string
      text: string
      hidden: number
      createTime: number | null
      rawJson: string
    }>

    const updateOrdinal = this.db.prepare('UPDATE messages SET ordinal = ? WHERE row_id = ?')
    rows.forEach((row, index) => updateOrdinal.run(index, row.rowId))

    this.db.prepare('DELETE FROM message_fts WHERE conversation_id = ?').run(conversationId)
    this.db.prepare('DELETE FROM message_fts_trigram WHERE conversation_id = ?').run(conversationId)
    this.db.prepare('DELETE FROM resources WHERE conversation_id = ?').run(conversationId)
    const insertFts = this.db.prepare('INSERT INTO message_fts (conversation_id, message_id, title, role, text) VALUES (?, ?, ?, ?, ?)')
    const insertTrigram = this.db.prepare('INSERT INTO message_fts_trigram (conversation_id, message_id, title, role, text) VALUES (?, ?, ?, ?, ?)')
    const insertResource = this.db.prepare('INSERT INTO resources (conversation_id, message_id, ordinal, kind, label, data_json) VALUES (?, ?, ?, ?, ?, ?)')
    const upsertImageAsset = this.db.prepare(`
      INSERT INTO image_assets (
        conversation_id, message_id, part_index, asset_pointer, file_id, asset_kind,
        mime_type, expected_size_bytes, width, height, gen_id, parent_gen_id, turn_exchange_id,
        first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(conversation_id, message_id, part_index) DO UPDATE SET
        asset_pointer=excluded.asset_pointer,
        file_id=excluded.file_id,
        asset_kind=excluded.asset_kind,
        mime_type=excluded.mime_type,
        expected_size_bytes=excluded.expected_size_bytes,
        width=excluded.width,
        height=excluded.height,
        gen_id=excluded.gen_id,
        parent_gen_id=excluded.parent_gen_id,
        turn_exchange_id=excluded.turn_exchange_id,
        last_seen_at=max(image_assets.last_seen_at, excluded.last_seen_at)
    `)

    const rawMessages: unknown[] = []
    let resourceOrdinal = 0
    for (const row of rows) {
      if (row.hidden === 0 && row.recipient === 'all' && (row.role === 'user' || row.role === 'assistant') && row.text.trim()) {
        insertFts.run(conversationId, row.messageId, conversationRow.title, row.role, row.text)
        insertTrigram.run(conversationId, row.messageId, conversationRow.title, row.role, row.text)
      }
      try {
        const rawMessage = JSON.parse(row.rawJson)
        rawMessages.push(rawMessage)
        const manifest = buildRichManifest(adaptConversation({
          title: conversationRow.title,
          conversation_id: conversationId,
          messages: [rawMessage],
        }))
        for (const item of manifest.items) {
          insertResource.run(conversationId, item.messageId || row.messageId, resourceOrdinal++, item.kind, item.label, json(item.data))
        }

        const rawRecord = record(rawMessage)
        const rawMetadata = record(rawRecord.metadata)
        const turnExchangeId = stringValue(rawMetadata.turn_exchange_id)
        const seenAt = Date.now()
        for (const asset of extractImageAssets(rawRecord)) {
          upsertImageAsset.run(
            conversationId,
            row.messageId,
            asset.partIndex,
            asset.assetPointer,
            asset.fileId ?? null,
            asset.generated ? 'generated-image' : 'image-asset',
            asset.mimeType ?? null,
            asset.sizeBytes ?? null,
            asset.width ?? null,
            asset.height ?? null,
            asset.genId ?? null,
            asset.parentGenId ?? null,
            turnExchangeId,
            seenAt,
            seenAt,
          )
        }
      }
      catch {
        // 单条派生 JSON 损坏不影响 canonical message；raw observation 仍保留用于以后修复。
      }
    }

    let markdown = ''
    if (rawMessages.length > 0) {
      const canonical = adaptConversation({
        title: conversationRow.title,
        conversation_id: conversationId,
        messages: rawMessages,
      })
      if (visibleForMarkdown(canonical)) markdown = conversationToMarkdown(canonical)
    }
    this.db.prepare(`
      UPDATE conversations
      SET message_count = ?, resource_count = ?, markdown = ?, imported_at = ?
      WHERE id = ?
    `).run(rows.length, resourceOrdinal, markdown, Date.now(), conversationId)
  }

  /** 列出仍未落盘的 ImageGen 图片；供 Guardian 的机会式被动补全使用。 */
  listPendingGeneratedImageAssets(limit = 50, retryBefore = Date.now() - 5 * 60_000): ImageAssetRow[] {
    const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)))
    return [...this.db.prepare(`
      SELECT conversation_id AS conversationId, message_id AS messageId, part_index AS partIndex,
             asset_pointer AS assetPointer, file_id AS fileId, asset_kind AS assetKind,
             mime_type AS mimeType, expected_size_bytes AS expectedSizeBytes,
             width, height, gen_id AS genId, parent_gen_id AS parentGenId,
             turn_exchange_id AS turnExchangeId,
             first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt,
             local_path AS localPath, sha256, actual_size_bytes AS actualSizeBytes,
             downloaded_at AS downloadedAt, last_download_attempt_at AS lastDownloadAttemptAt,
             download_error AS downloadError, notification_sent_at AS notificationSentAt
      FROM image_assets
      WHERE asset_kind='generated-image' AND downloaded_at IS NULL
        AND (last_download_attempt_at IS NULL OR last_download_attempt_at <= ?)
      ORDER BY first_seen_at, conversation_id, message_id, part_index
      LIMIT ?
    `).iterate(retryBefore, safeLimit)] as unknown as ImageAssetRow[]
  }

  /**
   * 按 ChatGPT Web 的稳定 file id 找一条仍未落盘的 ImageGen 资产。
   *
   * 这个查询专供“被动网络响应捕获”使用：页面已经自然请求了某个
   * `/backend-api/estuary/content?id=file_*`，daemon 只需要确认该 file id
   * 确实属于已经归档的 generated-image，随后才能读取这次浏览器已经收到的响应体。
   *
   * 与 `listPendingGeneratedImageAssets()` 不同，这里**不应用失败重试冷却**：
   * 既然浏览器此刻已经自然拿到了响应，就应该立即利用这次机会，不应因为几分钟前
   * 的 DOM fallback 失败而把一份现成响应丢掉。
   */
  findPendingGeneratedImageAssetByFileId(fileId: string): ImageAssetRow | null {
    const row = this.db.prepare(`
      SELECT conversation_id AS conversationId, message_id AS messageId, part_index AS partIndex,
             asset_pointer AS assetPointer, file_id AS fileId, asset_kind AS assetKind,
             mime_type AS mimeType, expected_size_bytes AS expectedSizeBytes,
             width, height, gen_id AS genId, parent_gen_id AS parentGenId,
             turn_exchange_id AS turnExchangeId,
             first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt,
             local_path AS localPath, sha256, actual_size_bytes AS actualSizeBytes,
             downloaded_at AS downloadedAt, last_download_attempt_at AS lastDownloadAttemptAt,
             download_error AS downloadError, notification_sent_at AS notificationSentAt
      FROM image_assets
      WHERE asset_kind='generated-image' AND downloaded_at IS NULL AND file_id=?
      ORDER BY first_seen_at, conversation_id, message_id, part_index
      LIMIT 1
    `).get(fileId) as ImageAssetRow | undefined
    return row ?? null
  }

  /** 把成功下载后的本地 blob 信息回写到所有引用同一稳定 pointer 的行。 */
  markImageAssetDownloaded(
    assetPointer: string,
    input: { localPath: string, sha256: string, actualSizeBytes: number, downloadedAt?: number },
  ): void {
    const at = input.downloadedAt ?? Date.now()
    this.db.prepare(`
      UPDATE image_assets
      SET local_path=?, sha256=?, actual_size_bytes=?, downloaded_at=?,
          last_download_attempt_at=?, download_error=NULL
      WHERE asset_pointer=?
    `).run(input.localPath, input.sha256, input.actualSizeBytes, at, at, assetPointer)
  }

  /** 下载失败只记短错误摘要，stable pointer 仍保留，后续再次看到页面时可以重试。 */
  markImageAssetDownloadError(assetPointer: string, error: string, attemptedAt = Date.now()): void {
    this.db.prepare(`
      UPDATE image_assets
      SET last_download_attempt_at=?, download_error=?
      WHERE asset_pointer=?
    `).run(attemptedAt, error.slice(0, 500), assetPointer)
  }

  /** ImageGen 手机提示按 message 去重；同一 message 的多张图片只推一次。 */
  markImageGenerationNotificationSent(conversationId: string, messageId: string, sentAt = Date.now()): void {
    this.db.prepare(`
      UPDATE image_assets
      SET notification_sent_at=COALESCE(notification_sent_at, ?)
      WHERE conversation_id=? AND message_id=? AND asset_kind='generated-image'
    `).run(sentAt, conversationId, messageId)
  }

  /** 找到某个 turn 的 ImageGen 结果组，供 daemon 构造 warning 通知。 */
  getImageGenerationEvent(conversationId: string, turnExchangeId?: string): {
    conversationId: string
    messageId: string
    imageCount: number
    notificationSentAt: number | null
  } | null {
    const row = turnExchangeId
      ? this.db.prepare(`
          SELECT conversation_id AS conversationId, message_id AS messageId, count(*) AS imageCount,
                 min(notification_sent_at) AS notificationSentAt
          FROM image_assets
          WHERE conversation_id=? AND turn_exchange_id=? AND asset_kind='generated-image'
          GROUP BY conversation_id, message_id
          ORDER BY max(last_seen_at) DESC
          LIMIT 1
        `).get(conversationId, turnExchangeId)
      : this.db.prepare(`
          SELECT conversation_id AS conversationId, message_id AS messageId, count(*) AS imageCount,
                 min(notification_sent_at) AS notificationSentAt
          FROM image_assets
          WHERE conversation_id=? AND asset_kind='generated-image'
          GROUP BY conversation_id, message_id
          ORDER BY max(last_seen_at) DESC
          LIMIT 1
        `).get(conversationId)
    return (row ?? null) as {
      conversationId: string
      messageId: string
      imageCount: number
      notificationSentAt: number | null
    } | null
  }

  /**
   * complete 事件后的最新 body 诊断会更新“当前异常”；历史 incident 永远不删除。
   * 新 turn / 恢复 final 会把旧 open incident 标为 resolved，避免 conversation 永久红牌。
   */
  updateIncidentFromDiagnostic(
    conversationId: string,
    diagnostic: RunDiagnostic,
    observedAt = Date.now(),
    allowCreate = true,
    allowIncompleteTailIncident = true,
    requestedKind: 'watchdog-timeout' | 'active-zombie' | 'abnormal-terminal' = 'abnormal-terminal',
    source = 'realtime-body',
    updateConversationState = true,
    historicalEnded = false,
  ): void {
    const latestTurn = diagnostic.turnExchangeId ?? null
    const turnKey = diagnostic.turnExchangeId
      ?? diagnostic.userMessageId
      ?? diagnostic.lastMessageId
      ?? diagnostic.currentNode
      ?? `unknown:${observedAt}`

    // 一旦最新 body 已经进入另一个 turn，旧 turn 的 open incident 只能变成“历史已继续”，
    // 绝不能让旧红牌继续污染 conversation 当前状态。历史行保留，只改变 status/resolved_at。
    if (updateConversationState) {
      this.db.prepare(`
        UPDATE incidents
        SET status='resolved',
            resolved_at=COALESCE(resolved_at, ?),
            last_observed_at=?
        WHERE conversation_id=? AND status='open' AND turn_key<>?
      `).run(observedAt, observedAt, conversationId, turnKey)
    }

    const currentIncident = this.db.prepare(`
      SELECT id, status, incident_kind AS incidentKind,
             lifecycle_class AS lifecycleClass,
             terminal_evidence AS terminalEvidence,
             reason
      FROM incidents
      WHERE conversation_id=? AND turn_key=?
      LIMIT 1
    `).get(conversationId, turnKey) as {
      id: string
      status: string
      incidentKind: string
      lifecycleClass: string | null
      terminalEvidence: string | null
      reason: string | null
    } | undefined

    // head history 只有在 current_node 真正变化时才插一行；因此同一个 head 出现两次以上，
    // 就意味着中间至少去过另一个 head（A→B→A）。这里只记录证据，不把“主动切 branch”
    // 和“异常回退”擅自合并成同一个根因。
    const headRollbackObserved = diagnostic.currentNode
      ? Number((this.db.prepare(`
          SELECT count(*) AS n
          FROM conversation_head_history
          WHERE conversation_id = ? AND current_node = ?
        `).get(conversationId, diagnostic.currentNode) as { n: number }).n) >= 2
      : false

    if (diagnostic.terminalEvidence === 'final' && currentIncident?.status === 'open') {
      this.db.prepare(`
        UPDATE incidents
        SET status='resolved', resolved_at=COALESCE(resolved_at, ?), last_observed_at=?
        WHERE id=?
      `).run(observedAt, observedAt, currentIncident.id)
    }

    // “这一次 observation 有没有资格创建 incident”和“一个已经存在的 incident 能不能吸收
    // 更完整的新诊断”是两回事。
    //
    // 典型现场：WSS conversation-turn-complete 已经可靠地为某 turn 立案，但当时旧版诊断器只把
    // `user + model_editable_context` 识别成笼统 `other`。升级分类器后，startup/reconnect reconcile
    // 本身不应凭一个普通 body fetch **新建**事故，但它完全有资格把同一 turn 的既有事故刷新成
    // `context-only-no-output`。否则 incident ledger 会永久冻结在创建时的旧分类。
    //
    // 这里故意保留原 incident 的 source：最初的 WSS/catalog/watchdog 信号才是“为什么当时可以
    // 判定/调查这个 turn”的生命状态证据；普通 reconcile 只是更新 body 诊断，不能冒充新的
    // terminal source。watchdog 的 reason 也保留 timeout 语义前缀。
    if (
      !allowCreate
      && currentIncident?.status === 'open'
      && diagnostic.terminalEvidence !== 'final'
    ) {
      // reconcile 只能补“body 现在长什么样”，不能推翻已经由更强 lifecycle 信号建立的事实。
      // 两类典型降级必须阻止：
      // 1. WSS complete 已确认 complete-no-final，后续仅凭 tool-result/reasoning tail 的 summary
      //    不能把 reason 刷回“不能据此判死”；
      // 2. 已明确 client_stopped/interrupted，后续某个缺少 finish_details 的普通快照不能把
      //    terminal_evidence 从 interrupted 降回 none。
      const preserveExplicitTerminal = currentIncident.lifecycleClass === 'explicit-interrupted'
        && diagnostic.terminalEvidence === 'none'
      const refreshedTerminalEvidence = preserveExplicitTerminal
        ? currentIncident.terminalEvidence
        : diagnostic.terminalEvidence
      const refreshedReason = currentIncident.lifecycleClass === 'active-zombie'
        ? `conversation list 持续保持 active 超过 watchdog 阈值，且尚未观察到正常收口；${diagnostic.summary}`
        : currentIncident.incidentKind === 'watchdog-timeout'
          ? `超过 watchdog 阈值仍未收到 conversation-turn-complete；${diagnostic.summary}`
        : currentIncident.lifecycleClass === 'complete-no-final'
          ? `已确认 turn 完成但没有 final；${diagnostic.summary}`
          : preserveExplicitTerminal
            ? (currentIncident.reason || diagnostic.summary)
            : diagnostic.summary
      this.db.prepare(`
        UPDATE incidents
        SET last_observed_at=?,
            reason=?,
            terminal_evidence=?,
            tail_shape=?,
            head_state=?,
            head_rollback=?,
            off_head_same_turn_count=?,
            diagnostic_json=?
        WHERE id=?
      `).run(
        observedAt,
        refreshedReason,
        refreshedTerminalEvidence,
        diagnostic.tailShape,
        diagnostic.headState,
        headRollbackObserved ? 1 : 0,
        diagnostic.offHeadSameTurnMessageCount,
        json(diagnostic),
        currentIncident.id,
      )
    }

    const explicitAbnormal = diagnostic.terminalEvidence === 'client-stopped'
      || diagnostic.terminalEvidence === 'interrupted'
    const inferredAbnormal = diagnostic.terminalEvidence === 'none'
      && diagnostic.tailShape !== 'final'
      && (requestedKind === 'watchdog-timeout' || requestedKind === 'active-zombie' || !diagnostic.hasInTurnSteering)
    const abnormal = explicitAbnormal || (allowIncompleteTailIncident && inferredAbnormal)
    if (allowCreate && abnormal && diagnostic.terminalEvidence !== 'final') {
      // 同一 turn 从“超时疑似卡住”演进成明确 client_stopped/interrupted 时，升级同一条 incident，
      // 不再因为 terminal/tail 字段变化制造第二条事故记录。
      const effectiveKind: 'watchdog-timeout' | 'active-zombie' | 'abnormal-terminal' = explicitAbnormal
        ? 'abnormal-terminal'
        : requestedKind
      const lifecycleClass: ArchiveIncidentRow['lifecycleClass'] = explicitAbnormal
        ? 'explicit-interrupted'
        : effectiveKind === 'active-zombie'
          ? 'active-zombie'
        : effectiveKind === 'watchdog-timeout'
          ? 'watchdog-timeout'
          : (allowIncompleteTailIncident || historicalEnded)
              ? 'complete-no-final'
              : 'abnormal-terminal'
      const incidentId = currentIncident?.id ?? sha256Text(`${conversationId}:${turnKey}`).slice(0, 24)
      const reason = historicalEnded && !explicitAbnormal
        ? `历史 turn 后续已经出现更新的 user turn，可确认该轮已经结束；该轮属于 complete-no-final，持久化尾部为 ${diagnostic.tailShape}。`
        : effectiveKind === 'active-zombie'
          ? `conversation list 持续保持 active 超过 watchdog 阈值，且 body 仍未出现 final/明确终止；${diagnostic.summary}`
        : effectiveKind === 'watchdog-timeout'
          ? `超过 watchdog 阈值仍未收到 conversation-turn-complete；${diagnostic.summary}`
          : lifecycleClass === 'complete-no-final'
            ? `已确认 turn 完成但没有 final；${diagnostic.summary}`
            : diagnostic.summary
      this.db.prepare(`
        INSERT INTO incidents (
          id, conversation_id, turn_exchange_id, turn_key, incident_kind, lifecycle_class,
          detected_at, last_observed_at, resolved_at, status,
          reason, terminal_evidence, tail_shape,
          head_state, head_rollback, off_head_same_turn_count,
          source, diagnostic_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'open', ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(conversation_id, turn_key) DO UPDATE SET
          turn_exchange_id=COALESCE(excluded.turn_exchange_id, incidents.turn_exchange_id),
          incident_kind=CASE
            WHEN incidents.incident_kind='abnormal-terminal' OR excluded.incident_kind='abnormal-terminal'
            THEN 'abnormal-terminal'
            ELSE excluded.incident_kind
          END,
          lifecycle_class=excluded.lifecycle_class,
          last_observed_at=excluded.last_observed_at,
          resolved_at=NULL,
          status='open',
          reason=excluded.reason,
          terminal_evidence=excluded.terminal_evidence,
          tail_shape=excluded.tail_shape,
          head_state=excluded.head_state,
          head_rollback=excluded.head_rollback,
          off_head_same_turn_count=excluded.off_head_same_turn_count,
          source=excluded.source,
          diagnostic_json=excluded.diagnostic_json
      `).run(
        incidentId,
        conversationId,
        latestTurn,
        turnKey,
        effectiveKind,
        lifecycleClass,
        observedAt,
        observedAt,
        reason,
        diagnostic.terminalEvidence,
        diagnostic.tailShape,
        diagnostic.headState,
        headRollbackObserved ? 1 : 0,
        diagnostic.offHeadSameTurnMessageCount,
        source,
        json(diagnostic),
      )

      // 历史补账表示“事故发生过，但用户后来已经进入了更新 turn”。因此保留 incident 事实，
      // 但立刻标为 resolved，不能因为翻旧 cursor 而重新点亮当前 conversation 的红牌。
      if (historicalEnded) {
        this.db.prepare(`
          UPDATE incidents
          SET status='resolved', resolved_at=COALESCE(resolved_at, ?), last_observed_at=?
          WHERE conversation_id=? AND turn_key=?
        `).run(observedAt, observedAt, conversationId, turnKey)
      }
    }

    if (updateConversationState) {
      const currentOpen = this.db.prepare(`
        SELECT count(*) AS n
        FROM incidents
        WHERE conversation_id = ? AND turn_key = ? AND status = 'open'
      `).get(conversationId, turnKey) as { n: number }
      this.db.prepare(`
        UPDATE conversations
        SET terminal_state=?, incident_state=?, last_finish_reason=?, last_monitor_checked_at=?
        WHERE id=?
      `).run(
        diagnostic.terminalEvidence,
        Number(currentOpen.n) > 0 ? 'open' : null,
        diagnostic.interruptedReason ?? null,
        observedAt,
        conversationId,
      )
    }
  }

  listIncidents(options: { status?: 'open' | 'resolved', limit?: number } = {}): ArchiveIncidentRow[] {
    const limit = Math.max(1, Math.min(1000, options.limit ?? 100))
    if (options.status) {
      const rows = this.db.prepare(`
        SELECT id, conversation_id AS conversationId, turn_exchange_id AS turnExchangeId,
               turn_key AS turnKey, incident_kind AS incidentKind,
               lifecycle_class AS lifecycleClass,
               detected_at AS detectedAt, last_observed_at AS lastObservedAt,
               resolved_at AS resolvedAt, status, reason,
               terminal_evidence AS terminalEvidence, tail_shape AS tailShape,
               head_state AS headState, head_rollback AS headRollbackObserved,
               off_head_same_turn_count AS offHeadSameTurnCount,
               source, diagnostic_json AS diagnosticJson
        FROM incidents WHERE status = ? ORDER BY detected_at DESC LIMIT ?
      `).all(options.status, limit) as unknown as Array<Record<string, unknown>>
      return rows.map(normalizeIncidentRow)
    }
    const rows = this.db.prepare(`
      SELECT id, conversation_id AS conversationId, turn_exchange_id AS turnExchangeId,
             turn_key AS turnKey, incident_kind AS incidentKind,
             lifecycle_class AS lifecycleClass,
             detected_at AS detectedAt, last_observed_at AS lastObservedAt,
             resolved_at AS resolvedAt, status, reason,
             terminal_evidence AS terminalEvidence, tail_shape AS tailShape,
             head_state AS headState, head_rollback AS headRollbackObserved,
             off_head_same_turn_count AS offHeadSameTurnCount,
             source, diagnostic_json AS diagnosticJson
      FROM incidents ORDER BY detected_at DESC LIMIT ?
    `).all(limit) as unknown as Array<Record<string, unknown>>
    return rows.map(normalizeIncidentRow)
  }

  /**
   * 从已经落库的原始 message JSON 重建富媒体/工具资源目录。
   *
   * `resources` 是一个“可重建派生索引”，不是事实源：真正无损的数据仍在 messages.raw_json
   * 和 conversation_snapshots。官方 Data Export 的导入路径会保存每条 message 的 raw_json，
   * 因此在多份 ZIP 做完 union 后统一重建，可以避免逐 source 插入时的版本覆盖问题。
   *
   * 旧版 `importRaw()` 产生的行历史上可能没有 raw_json（默认 `{}`）；这些消息已有自己当时
   * 生成的 resources，所以这里仅删除/重建“raw_json 可用”的消息资源，避免误伤旧归档。
   */
  rebuildDerivedResources(): number {
    const selectMessages = this.db.prepare(`
      SELECT
        m.conversation_id AS conversationId,
        m.message_id AS messageId,
        c.title AS title,
        m.raw_json AS rawJson,
        COALESCE(m.source_observed_at, m.last_seen_at, m.first_seen_at, c.captured_at) AS sourceObservedAt
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      WHERE m.raw_json IS NOT NULL
        AND m.raw_json <> ''
        AND m.raw_json <> '{}'
      ORDER BY m.conversation_id, m.ordinal, m.message_id
    `)
    const insertResource = this.db.prepare(`
      INSERT INTO resources (
        conversation_id, message_id, ordinal, kind, label, data_json
      ) VALUES (?, ?, ?, ?, ?, ?)
    `)
    const updateConversationCount = this.db.prepare(`
      UPDATE conversations
      SET resource_count = (
        SELECT count(*) FROM resources r WHERE r.conversation_id = conversations.id
      )
    `)
    const upsertImageAsset = this.db.prepare(`
      INSERT INTO image_assets (
        conversation_id, message_id, part_index, asset_pointer, file_id, asset_kind,
        mime_type, expected_size_bytes, width, height, gen_id, parent_gen_id, turn_exchange_id,
        first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(conversation_id, message_id, part_index) DO UPDATE SET
        asset_pointer=excluded.asset_pointer,
        file_id=excluded.file_id,
        asset_kind=excluded.asset_kind,
        mime_type=excluded.mime_type,
        expected_size_bytes=excluded.expected_size_bytes,
        width=excluded.width,
        height=excluded.height,
        gen_id=excluded.gen_id,
        parent_gen_id=excluded.parent_gen_id,
        turn_exchange_id=excluded.turn_exchange_id,
        last_seen_at=max(image_assets.last_seen_at, excluded.last_seen_at)
    `)

    let inserted = 0
    const ordinals = new Map<string, number>()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      // 只清理由 raw_json 可重建的 message；旧 prototype/importRaw 产生的资源保持不动。
      this.db.exec(`
        DELETE FROM resources
        WHERE EXISTS (
          SELECT 1
          FROM messages m
          WHERE m.conversation_id = resources.conversation_id
            AND m.message_id = resources.message_id
            AND m.raw_json IS NOT NULL
            AND m.raw_json <> ''
            AND m.raw_json <> '{}'
        )
      `)

      for (const rawRow of selectMessages.iterate()) {
        const row = rawRow as Record<string, unknown>
        const conversationId = stringValue(row.conversationId)
        const messageId = stringValue(row.messageId)
        const title = stringValue(row.title) ?? 'ChatGPT Conversation'
        const rawJson = stringValue(row.rawJson)
        if (!conversationId || !messageId || !rawJson) continue

        let rawMessage: unknown
        try {
          rawMessage = JSON.parse(rawJson)
        }
        catch {
          // 某条派生索引素材损坏不应阻断整个 archive；raw snapshot 仍可用于后续修复。
          continue
        }

        // adapter 对 messages[] 会只处理这一条消息，因此可以复用已有 manifest 逻辑，
        // 不在 SQLite 层复制一套 Web Search / widget / asset-pointer 解析规则。
        const oneMessage = adaptConversation({
          title,
          conversation_id: conversationId,
          messages: [rawMessage],
        })
        const manifest = buildRichManifest(oneMessage)
        for (const item of manifest.items) {
          const ordinal = ordinals.get(conversationId) ?? 0
          insertResource.run(
            conversationId,
            item.messageId || messageId,
            ordinal,
            item.kind,
            item.label,
            json(item.data),
          )
          ordinals.set(conversationId, ordinal + 1)
          inserted += 1
        }

        const rawRecord = record(rawMessage)
        const metadata = record(rawRecord.metadata)
        const turnExchangeId = stringValue(metadata.turn_exchange_id)
        const seenAt = numberValue(row.sourceObservedAt) ?? Date.now()
        for (const asset of extractImageAssets(rawRecord)) {
          upsertImageAsset.run(
            conversationId,
            messageId,
            asset.partIndex,
            asset.assetPointer,
            asset.fileId ?? null,
            asset.generated ? 'generated-image' : 'image-asset',
            asset.mimeType ?? null,
            asset.sizeBytes ?? null,
            asset.width ?? null,
            asset.height ?? null,
            asset.genId ?? null,
            asset.parentGenId ?? null,
            turnExchangeId,
            seenAt,
            seenAt,
          )
        }
      }

      updateConversationCount.run()
      this.db.exec('COMMIT')
    }
    catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return inserted
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

  /** 记录一次 DevSpace tool audit；第一次时间永远不被后续调用覆盖。 */
  observeDevSpaceMetadata(input: {
    metadataId: string
    auditId: string
    auditAt: number
  }): DevSpaceMetadataBindingRow {
    const metadataId = input.metadataId.trim()
    if (!metadataId) throw new Error('metadataId must not be empty')
    const auditAt = Math.max(0, Math.trunc(input.auditAt))
    this.db.prepare(`
      INSERT INTO devspace_metadata_bindings (
        metadata_id, conversation_id, first_seen_at, last_seen_at,
        last_audit_id, last_audit_at, lifecycle_state
      ) VALUES (?, NULL, ?, ?, ?, ?, 'unbound')
      ON CONFLICT(metadata_id) DO UPDATE SET
        last_seen_at=max(devspace_metadata_bindings.last_seen_at, excluded.last_seen_at),
        last_audit_id=CASE
          WHEN excluded.last_audit_at >= COALESCE(devspace_metadata_bindings.last_audit_at, 0)
          THEN excluded.last_audit_id ELSE devspace_metadata_bindings.last_audit_id END,
        last_audit_at=max(COALESCE(devspace_metadata_bindings.last_audit_at, 0), excluded.last_audit_at)
    `).run(metadataId, auditAt, auditAt, input.auditId, auditAt)
    return this.getDevSpaceMetadataBinding(metadataId)!
  }

  getDevSpaceMetadataBinding(metadataId: string): DevSpaceMetadataBindingRow | null {
    const row = this.db.prepare(`
      SELECT metadata_id AS metadataId, conversation_id AS conversationId,
             first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt,
             bound_at AS boundAt, last_verified_at AS lastVerifiedAt,
             evidence, confidence,
             last_turn_exchange_id AS lastTurnExchangeId,
             last_request_id AS lastRequestId,
             last_audit_id AS lastAuditId, last_audit_at AS lastAuditAt,
             lifecycle_state AS lifecycleState
      FROM devspace_metadata_bindings
      WHERE metadata_id = ?
      LIMIT 1
    `).get(metadataId) as DevSpaceMetadataBindingRow | undefined
    return row ?? null
  }

  getDevSpaceMetadataBindingsForConversation(conversationId: string): DevSpaceMetadataBindingRow[] {
    return this.db.prepare(`
      SELECT metadata_id AS metadataId, conversation_id AS conversationId,
             first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt,
             bound_at AS boundAt, last_verified_at AS lastVerifiedAt,
             evidence, confidence,
             last_turn_exchange_id AS lastTurnExchangeId,
             last_request_id AS lastRequestId,
             last_audit_id AS lastAuditId, last_audit_at AS lastAuditAt,
             lifecycle_state AS lifecycleState
      FROM devspace_metadata_bindings
      WHERE conversation_id = ?
      ORDER BY bound_at ASC, metadata_id ASC
    `).all(conversationId) as unknown as DevSpaceMetadataBindingRow[]
  }

  listDevSpaceMetadataBindings(input: {
    onlyUnbound?: boolean
    sinceAt?: number
    limit?: number
  } = {}): DevSpaceMetadataBindingRow[] {
    const clauses: string[] = []
    const params: Array<string | number> = []
    if (input.onlyUnbound) clauses.push('conversation_id IS NULL')
    if (input.sinceAt !== undefined) {
      clauses.push('last_seen_at >= ?')
      params.push(Math.max(0, Math.trunc(input.sinceAt)))
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    params.push(Math.max(1, Math.trunc(input.limit ?? 100)))
    return this.db.prepare(`
      SELECT metadata_id AS metadataId, conversation_id AS conversationId,
             first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt,
             bound_at AS boundAt, last_verified_at AS lastVerifiedAt,
             evidence, confidence,
             last_turn_exchange_id AS lastTurnExchangeId,
             last_request_id AS lastRequestId,
             last_audit_id AS lastAuditId, last_audit_at AS lastAuditAt,
             lifecycle_state AS lifecycleState
      FROM devspace_metadata_bindings
      ${where}
      ORDER BY last_seen_at DESC
      LIMIT ?
    `).all(...params) as unknown as DevSpaceMetadataBindingRow[]
  }

  /** Archive 负责推断；一旦绑定，后续 observe 不再把 lifecycle 打回 unbound。 */
  bindDevSpaceMetadata(input: {
    metadataId: string
    conversationId: string
    evidence: string
    confidence: string
    observedAt: number
    turnExchangeId?: string | null
    requestId?: string | null
    lifecycleState?: 'active' | 'closed'
  }): DevSpaceMetadataBindingRow {
    const observedAt = Math.max(0, Math.trunc(input.observedAt))
    const existing = this.getDevSpaceMetadataBinding(input.metadataId)
    const firstSeenAt = existing?.firstSeenAt ?? observedAt
    this.db.prepare(`
      INSERT INTO devspace_metadata_bindings (
        metadata_id, conversation_id, first_seen_at, last_seen_at,
        bound_at, last_verified_at, evidence, confidence,
        last_turn_exchange_id, last_request_id, lifecycle_state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(metadata_id) DO UPDATE SET
        conversation_id=excluded.conversation_id,
        bound_at=COALESCE(devspace_metadata_bindings.bound_at, excluded.bound_at),
        last_verified_at=excluded.last_verified_at,
        evidence=excluded.evidence,
        confidence=excluded.confidence,
        last_turn_exchange_id=COALESCE(excluded.last_turn_exchange_id, devspace_metadata_bindings.last_turn_exchange_id),
        last_request_id=COALESCE(excluded.last_request_id, devspace_metadata_bindings.last_request_id),
        lifecycle_state=excluded.lifecycle_state
    `).run(
      input.metadataId,
      input.conversationId,
      firstSeenAt,
      Math.max(existing?.lastSeenAt ?? 0, observedAt),
      observedAt,
      observedAt,
      input.evidence,
      input.confidence,
      input.turnExchangeId ?? null,
      input.requestId ?? null,
      input.lifecycleState ?? 'active',
    )
    return this.getDevSpaceMetadataBinding(input.metadataId)!
  }

  updateDevSpaceBindingTurn(input: {
    conversationId: string
    turnExchangeId?: string | null
    requestId?: string | null
    observedAt: number
    lifecycleState?: 'active' | 'closed'
  }): number {
    const result = this.db.prepare(`
      UPDATE devspace_metadata_bindings
      SET last_turn_exchange_id=COALESCE(?, last_turn_exchange_id),
          last_request_id=COALESCE(?, last_request_id),
          last_verified_at=max(COALESCE(last_verified_at, 0), ?),
          lifecycle_state=COALESCE(?, lifecycle_state)
      WHERE conversation_id = ?
    `).run(
      input.turnExchangeId ?? null,
      input.requestId ?? null,
      Math.max(0, Math.trunc(input.observedAt)),
      input.lifecycleState ?? null,
      input.conversationId,
    )
    return Number(result.changes)
  }

  conversationTurnToolWindow(conversationId: string, turnExchangeId: string): {
    startAt: number
    endAt: number
    toolCallCount: number
  } | null {
    const row = this.db.prepare(`
      SELECT min(create_time) AS minCreateTime,
             max(create_time) AS maxCreateTime,
             sum(CASE WHEN role='assistant' AND recipient <> 'all' THEN 1 ELSE 0 END) AS toolCallCount
      FROM messages
      WHERE conversation_id = ?
        AND turn_exchange_id = ?
        AND create_time IS NOT NULL
    `).get(conversationId, turnExchangeId) as {
      minCreateTime: number | null
      maxCreateTime: number | null
      toolCallCount: number | null
    } | undefined
    if (!row || !Number.isFinite(row.minCreateTime) || !Number.isFinite(row.maxCreateTime)) return null
    return {
      startAt: Number(row.minCreateTime) * 1000,
      endAt: Number(row.maxCreateTime) * 1000,
      toolCallCount: Number(row.toolCallCount || 0),
    }
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
    // 图片二进制下载状态是“可变的本地缓存状态”，不能反向写进可重建的 resources.data_json；
    // 否则下一次 reindex 就会把 local_path/hash 等本地事实抹掉。CLI 查询时再把 image_assets
    // 动态叠加到结构化资源上，既保持 resources 可重建，又让用户一眼看到图片是否已经落盘。
    const imageRows = this.db.prepare(`
      SELECT message_id AS messageId, part_index AS partIndex,
             local_path AS localPath, sha256, actual_size_bytes AS actualSizeBytes,
             downloaded_at AS downloadedAt, last_download_attempt_at AS lastDownloadAttemptAt,
             download_error AS downloadError
      FROM image_assets
      WHERE conversation_id = ?
    `).all(conversationId) as unknown as Array<{
      messageId: string
      partIndex: number
      localPath: string | null
      sha256: string | null
      actualSizeBytes: number | null
      downloadedAt: number | null
      lastDownloadAttemptAt: number | null
      downloadError: string | null
    }>
    const imageState = new Map(imageRows.map(item => [`${item.messageId}:${item.partIndex}`, item]))

    return rows.map(({ dataJson, ...row }) => {
      const data = JSON.parse(dataJson) as Record<string, unknown>
      if (row.kind !== 'generated-image' && row.kind !== 'image-asset') return { ...row, data }
      const partIndex = typeof data.partIndex === 'number' ? data.partIndex : null
      if (partIndex === null || typeof row.messageId !== 'string') return { ...row, data }
      const local = imageState.get(`${row.messageId}:${partIndex}`)
      if (!local) return { ...row, data }
      return {
        ...row,
        data: {
          ...data,
          localPath: local.localPath,
          sha256: local.sha256,
          actualSizeBytes: local.actualSizeBytes,
          downloadedAt: local.downloadedAt,
          lastDownloadAttemptAt: local.lastDownloadAttemptAt,
          downloadError: local.downloadError,
        },
      }
    })
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
