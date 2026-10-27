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
import type { PreparedArchiveEvidence } from './archive-evidence-store.ts'

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

export type ArchiveSearchSort = 'relevance' | 'recent' | 'frequency'

export interface ArchiveConversationSearchOptions {
  /** 最多返回多少个不同 Conversation。 */
  limit?: number
  /** 每个 Conversation 最多返回多少条代表性正文命中；命中总数仍通过 hitCount 单独返回。 */
  snippetsPerConversation?: number
  /** relevance=最佳匹配优先；recent=最新聊天优先；frequency=正文命中次数优先。 */
  sort?: ArchiveSearchSort
}

export interface ArchiveConversationSearchResult {
  conversationId: string
  title: string
  capturedAt: number
  /** 只统计正文 message 命中数；标题命中通过 titleMatched 单独表示，避免标题被每条 FTS 行重复计算。 */
  hitCount: number
  /** FTS5 bm25 的最佳正文命中排名；仅标题命中时为 null。数值越小（通常越负）越相关。 */
  bestRank: number | null
  titleMatched: boolean
  /** Bridge 用这两个内部元数据计算 lifecycleState，HTTP 返回前会将它们隐藏。 */
  /** Legacy SQLite `terminal_state`; runtime meaning is the latest canonical Body completion state. */
  bodyCompletionState: string | null
  lastFinishType: string | null
  snippets: ArchiveSearchHit[]
}

type ArchiveSearchIndex = 'message_fts' | 'message_fts_trigram' | 'message_fts_bigram'

interface ArchiveSearchPlan {
  table: ArchiveSearchIndex
  expression: string
}

interface ArchiveSearchRankRow {
  conversationId: string
  messageId: string
  rank: number
}

interface ArchiveSearchMetaRow {
  id: string
  title: string
  capturedAt: number
  bodyCompletionState: string | null
  lastFinishType: string | null
}

const CJK_CODEPOINT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u

function normalizedConversationTitle(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : ''
}

/**
 * ChatGPT 在新会话自动命名尚未完成、或某些旧快照/分页响应里，会再次给出
 * New chat / 新聊天。这种占位符不是一次真实的“重命名”，不能覆盖已经见过的
 * 可读标题；否则同一 conversation 会在真实标题与 New chat 之间来回跳。
 */
export function isPlaceholderConversationTitle(value: unknown, conversationId: string | null = null): boolean {
  const title = normalizedConversationTitle(value)
  if (!title) return true
  if (conversationId && title === conversationId) return true
  return /^(?:new chat|新聊天)$/iu.test(title)
}

export function preferredConversationTitle(
  existingTitle: unknown,
  incomingTitle: unknown,
  conversationId: string | null = null,
): string {
  const existing = normalizedConversationTitle(existingTitle)
  const incoming = normalizedConversationTitle(incomingTitle)
  if (isPlaceholderConversationTitle(incoming, conversationId)
    && !isPlaceholderConversationTitle(existing, conversationId)) {
    return existing
  }
  return incoming || existing || conversationId || ''
}

/**
 * 为“一到两字 CJK 任意子串”生成紧凑的短词 token。
 * 同一 message 内同时保存去重 unigram + 相邻 bigram；例如 `长江三峡` 会生成
 * `长 江 三 峡 长江 江三 三峡`。这样搜索 `肾` 或 `三峡` 都不需要 `%LIKE%` 扫全库。
 */
function cjkShortTokens(text: string): string {
  const codepoints = Array.from(text)
  const tokens = new Set<string>()
  for (const codepoint of codepoints) {
    if (CJK_CODEPOINT.test(codepoint)) tokens.add(codepoint)
  }
  for (let index = 0; index + 1 < codepoints.length; index += 1) {
    const left = codepoints[index]!
    const right = codepoints[index + 1]!
    if (CJK_CODEPOINT.test(left) && CJK_CODEPOINT.test(right)) tokens.add(`${left}${right}`)
  }
  return [...tokens].join(' ')
}

/** 为 bigram 命中生成与 FTS snippet 类似的短上下文，并用 [] 标出真实子串。 */
function substringSnippet(text: string, query: string): string {
  const index = text.indexOf(query)
  if (index < 0) return text.slice(0, 260)
  const start = Math.max(0, index - 80)
  const end = Math.min(text.length, index + query.length + 160)
  const prefix = start > 0 ? ' … ' : ''
  const suffix = end < text.length ? ' … ' : ''
  return `${prefix}${text.slice(start, index)}[${text.slice(index, index + query.length)}]${text.slice(index + query.length, end)}${suffix}`
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
  bodyCompletionState: string | null
  incidentState: string | null
  lastFinishType: string | null
  lastFinishReason: string | null
  lastReasoningStatus: string | null
  /** 仅 Bridge/Reader 展示层使用；canonical conversations 永远不设置该标记。 */
  provisional?: boolean
  metadataId?: string | null
  provisionalState?: 'running' | 'idle'
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
  /**
   * live merge 热路径分段计时。
   *
   * 这里故意记录 wall time，而不是把“SQLite 慢”当成一个不可拆的黑盒：
   * - prepare: canonical adapter / JSON stringify / known-id lookup；
   * - messageWrite: conversation/head + message/mapping/parts 的事务内写入；
   * - observation: raw observation 的 sha256 + gzip + BLOB insert；
   * - derived: FTS/resources/count 等派生层更新；
   * - commit: WAL commit 本身；
   * - postMerge: diagnostic / incident ledger / 最终 count 读取。
   *
   * daemon 只会对明显慢页记录这些值，避免正常采集日志膨胀。
   */
  timings: {
    totalMs: number
    prepareMs: number
    fingerprintReadMs: number
    existingReadMs: number
    writerLockWaitMs: number
    conversationHeadMs: number
    messageWriteMs: number
    observationMs: number
    derivedMs: number
    commitMs: number
    postMergeMs: number
    fullRewriteMessages: number
    observationOnlyTouches: number
    fingerprintHits: number
    fatRowsRead: number
    fingerprintWrites: number
    rawJsonBytes: number
    observationGzipBytes: number
  }
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
  /** Legacy SQLite column `terminal_evidence`; runtime meaning is canonical Body completion evidence only. */
  bodyCompletionEvidence: string
  tailShape: string
  /** canonical current_node 与本次 plural messages[] 的相对关系。 */
  headState: string | null
  /** 是否已经在 head history 中真实观察到 A→B→A/返回旧 head。 */
  headRollbackObserved: boolean
  /** current_node 之后、仍属于同一 turn 的 off-head message 数量。 */
  offHeadSameTurnCount: number
  source: string
  diagnosticJson: string
  /** 正交证据标签，例如 canonical-tail-gap；可与 lifecycleClass 同时存在。 */
  evidenceTypes: string[]
}

/** Incident 的正交证据维度；同一 incident 可以同时拥有多个 evidence type。 */
export interface ArchiveIncidentEvidenceRow {
  incidentId: string
  evidenceType: string
  firstObservedAt: number
  lastObservedAt: number
  evidenceJson: string
}

/** DevSpace 聊天级 metadata 与 canonical ChatGPT conversation 的持久 binding。 */
export interface DevSpaceMetadataBindingRow {
  metadataId: string
  conversationId: string | null
  displayTitle: string | null
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
  lifecycleState: 'unbound' | 'active' | 'closed'
}

/** Canonical turn evidence queue row for DevSpace binding. */
export interface DevSpaceBindingTurnEvidenceRow {
  conversationId: string
  turnExchangeId: string
  firstToolAt: number
  lastToolAt: number
  toolCallCount: number
  evidenceRevision: string
  status: 'pending' | 'matched'
  matchedMetadataId: string | null
  firstQueuedAt: number
  lastQueuedAt: number
  lastAttemptAt: number | null
  attemptCount: number
  lastAttemptEvidenceRevision: string | null
  lastAttemptMetadataRevision: string | null
}

/** Narrow canonical tool-call rows used to build DevSpace turn binding evidence. */
export interface DevSpaceTurnToolCallRow {
  createTime: number
  requestId: string | null
  text: string
}

/**
 * DevSpace W3C trace-id 的低延迟 request/generation 身份层。
 *
 * 实测层级是 Conversation → Turn Exchange → Request/Generation → Trace → Metadata members：
 * - 同一 Turn Exchange 在 steering 时可以有多个 request/trace；
 * - 同一 trace 可以因为 MCP reconnect 等原因先后出现多个 metadata；
 * - metadata 自身还可能跨 turn/trace 再次出现。
 *
 * 因此本行只保存 trace 的 canonical 上级；`metadataId` 是兼容旧库的“首个成员”字段，
 * 真正的成员关系由 `devspace_trace_metadata_members` 一对多保存。
 */
export interface DevSpaceTraceTurnBindingRow {
  traceId: string
  metadataId: string
  firstSeenAt: number
  lastSeenAt: number
  firstAuditId: string
  lastAuditId: string
  conversationId: string | null
  turnExchangeId: string | null
  requestId: string | null
  status: 'provisional' | 'verified' | 'conflict'
  verifiedAt: number | null
  conflictReason: string | null
}

/** 一个 trace 下观察到的 metadata 成员；metadata 可跨多个 trace 再次出现。 */
export interface DevSpaceTraceMetadataMemberRow {
  traceId: string
  metadataId: string
  firstSeenAt: number
  lastSeenAt: number
  firstAuditId: string
  lastAuditId: string
}

/**
 * 未绑定 metadata 的稳定 synthetic conversation id。
 *
 * 内部使用 SHA-256 的 16 hex 前缀，避免把超长 openai/session 直接塞进 URL；完整 metadata ID
 * 仍保存在 binding/recovery 表中用于精确定位。synthetic id 只存在于 provisional 展示层。
 */
export function devSpaceVirtualConversationId(metadataId: string): string {
  const normalized = metadataId.trim()
  const digest = createHash('sha256').update(normalized || 'unknown').digest('hex').slice(0, 16)
  return `devspace-meta/${digest}`
}

export function shortDevSpaceMetadataAlias(metadataId: string): string {
  const normalized = metadataId.trim().replace(/^v1\//u, '')
  return normalized ? `meta/${normalized.slice(0, 8)}` : 'meta/unknown'
}

/**
 * DevSpace tool_audit 的本地 recovery 镜像。
 *
 * 这些记录只用于 Conversation Body 暂不可得时的 provisional 展示；它们不是第一方 ChatGPT
 * message，也绝不参与 terminal / incident / mapping 判定。canonical body 后续出现相同 tool+args
 * 时会把对应 audit 标记 superseded，而不是删除取证事实。
 */
export interface DevSpaceRecoveryAuditRow {
  auditId: string
  conversationId: string
  metadataId: string
  tool: string
  toolFingerprint: string
  argsJson: string
  resultJson: string | null
  error: string | null
  conclusion: string | null
  startedAt: number
  finishedAt: number | null
  firstSeenAt: number
  lastSeenAt: number
  supersededAt: number | null
  supersededByMessageId: string | null
}

/**
 * Archive 消费 DevSpace append-only tool_audit 的 durable 高水位。
 *
 * startedAt 使用 DevSpace SQLite 中原始 ISO 时间字符串，而不是重新格式化成 epoch：
 * SQLite 对 ISO-8601 UTC 字符串可以稳定按字典序排序；同一毫秒出现多条 audit 时再用
 * auditId 做第二排序键。这样 daemon 即使离线数小时，重启后也能从最后确认消费的位置
 * 严格续读，而不是依赖“往回看几分钟”的脆弱时间窗。
 */
export interface DevSpaceAuditCursorRow {
  consumerKey: string
  startedAt: string
  auditId: string
  updatedAt: number
}

/** canonical Body 与 DevSpace recovery overlay 的尾部差异摘要。 */
export interface DevSpaceTailGapSummary {
  conversationId: string
  turnExchangeId: string | null
  metadataId: string | null
  canonicalTailAt: number | null
  recoveryLastAt: number | null
  gapMs: number
  recoveryAuditCount: number
  recoveryToolCount: number
  checkpointCount: number
  hasTailGap: boolean
}

/** daemon 重启后需要原样恢复的 conversation watchdog 计时状态。 */
export interface ActiveWatchdogStateRow {
  conversationId: string
  startedAt: number
  lastEventAt: number
  lastWatchdogAt: number | null
  watchdogPendingAt: number | null
  startType: string
  lastDiagnosticTurnKey: string | null
  updatedAt: number
}

/**
 * ChatGPT `/f/conversation` SSE 下发的恢复 capability。
 *
 * token 只用于同一 turn 的 `/f/conversation/resume`，不是账户级长期认证凭据；
 * 这里持久化 raw token 是为了 daemon 重启/瞬时断网后仍能恢复同一条流。
 */
export interface LiveResumeCredentialRow {
  turnKey: string
  conversationId: string
  turnExchangeId: string | null
  token: string
  resumeOffset: string | null
  tokenSha256: string
  tokenLength: number
  sourceTransport: string
  firstSeenAt: number
  lastSeenAt: number
  lastResumeAttemptAt: number | null
  resumeAttemptCount: number
  nextResumeAt: number | null
  lastResumeStatus: number | null
  lastResumeError: string | null
}

/**
 * Bark/其它旁路通知的持久去重记录。
 *
 * 这里只在远端 provider 已确认成功后写入，因此：
 * - daemon 重启不会重复发送已经成功的通知；
 * - 发送失败不会把 key 永久占住，后续同一事实再次被观察时仍可重试；
 * - 运行期并发重复由 daemon 的 in-flight Set 兜底。
 */
export interface TurnNotificationLedgerRow {
  notificationKey: string
  kind: string
  conversationId: string | null
  turnKey: string | null
  sentAt: number
  providerStatus: number | null
  payloadJson: string
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
  const rawEvidenceTypes = typeof row.evidenceTypesRaw === 'string'
    ? row.evidenceTypesRaw
    : ''
  const { evidenceTypesRaw: _evidenceTypesRaw, ...rest } = row
  return {
    ...rest,
    headRollbackObserved: Number(row.headRollbackObserved) === 1,
    evidenceTypes: rawEvidenceTypes ? rawEvidenceTypes.split('\u001f').filter(Boolean) : [],
  } as unknown as ArchiveIncidentRow
}

function ensureParentDir(filePath: string): void {
  mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true })
}

function json(value: unknown): string {
  return JSON.stringify(value)
}

function catalogWatchdogUpdateTimeKey(value: unknown): string {
  if (value === null || value === undefined || value === '') return '__unknown__'
  return String(value)
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
const ARCHIVE_SCHEMA_VERSION = 8

export class ChatArchiveDb {
  readonly db: DatabaseSync
  readonly filePath: string

  constructor(filePath: string) {
    this.filePath = filePath
    ensureParentDir(filePath)
    this.db = new DatabaseSync(filePath)
    // Archive 会被 daemon、CLI search/read、LifeOps 等多个本机进程同时打开。
    // 生产事故已证实：瞬时写锁若在 busy_timeout=0 下直接抛 SQLITE_BUSY，
    // 再叠加外层事件回调缺少隔离，就可能把常驻 daemon 整个打死。
    // 5 秒只用于等待本机极短事务；真正长期锁仍会明确失败，不会无限挂起。
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;')
    let schemaVersion = Number((this.db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined)?.user_version ?? 0)
    if (schemaVersion > ARCHIVE_SCHEMA_VERSION) {
      this.db.close()
      throw new Error(`Archive schema v${schemaVersion} is newer than supported v${ARCHIVE_SCHEMA_VERSION}`)
    }
    // v0 是 user_version 引入前的历史库/全新库，只有它需要执行那套完整 Genesis migration。
    // 之后必须严格按版本做 delta migration；否则仅仅增加一个列，也会让 12GB 生产库重新执行
    // 历史 incident/mapping backfill，既慢又扩大升级风险。
    if (schemaVersion < 1) {
      this.migrate()
      schemaVersion = 1
      this.db.exec('PRAGMA user_version=1')
    }
    if (schemaVersion < 2) {
      this.migrateV2()
      schemaVersion = 2
      this.db.exec('PRAGMA user_version=2')
    }
    if (schemaVersion < 3) {
      this.migrateV3()
      schemaVersion = 3
      this.db.exec('PRAGMA user_version=3')
    }
    if (schemaVersion < 4) {
      this.migrateV4()
      schemaVersion = 4
      this.db.exec('PRAGMA user_version=4')
    }
    if (schemaVersion < 5) {
      this.migrateV5()
      schemaVersion = 5
      this.db.exec('PRAGMA user_version=5')
    }
    if (schemaVersion < 6) {
      this.migrateV6()
      schemaVersion = 6
      this.db.exec('PRAGMA user_version=6')
    }
    if (schemaVersion < 7) {
      this.migrateV7()
      schemaVersion = 7
      this.db.exec('PRAGMA user_version=7')
    }
    if (schemaVersion < 8) {
      this.migrateV8()
      schemaVersion = 8
      this.db.exec('PRAGMA user_version=8')
    }
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

      -- Reader 的 canonical ordinal 完整性检查只需要 conversation_id + ordinal；
      -- 可见节点统计/分页则只需要 hidden=0 的同一组窄键。生产 4.9GB messages 主表上，
      -- 若 visible count 需要回表读取 hidden，8 条长聊天会从约 10ms 的 covering-index
      -- 工作退化到约 180~210ms。partial index 让控制面不必触碰肥 message row。
      CREATE INDEX IF NOT EXISTS messages_conversation_visible_ordinal
        ON messages(conversation_id, ordinal)
        WHERE hidden=0;

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

      CREATE INDEX IF NOT EXISTS resources_conversation_message
        ON resources(conversation_id, message_id);

      CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(
        conversation_id UNINDEXED,
        message_id UNINDEXED,
        title,
        role UNINDEXED,
        text,
        tokenize='unicode61'
      );

      -- unicode61 适合英文/数字，也能高效处理真实库中的一字/两字 CJK token 查询。
      -- trigram 专门补 3+ 字符连续子串；不要再把短 CJK 直接降级成无界 LIKE 全表扫描。
      CREATE VIRTUAL TABLE IF NOT EXISTS message_fts_trigram USING fts5(
        conversation_id UNINDEXED,
        message_id UNINDEXED,
        title,
        role UNINDEXED,
        text,
        tokenize='trigram'
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS message_fts_bigram USING fts5(
        conversation_id UNINDEXED,
        message_id UNINDEXED,
        grams,
        tokenize='unicode61'
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

      -- Incident 主类回答生命周期问题；这里保存可并存的正交证据维度。
      -- 例如同一 turn 可以同时是 active-zombie，并且存在 canonical-tail-gap。
      CREATE TABLE IF NOT EXISTS incident_evidence (
        incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
        evidence_type TEXT NOT NULL,
        first_observed_at INTEGER NOT NULL,
        last_observed_at INTEGER NOT NULL,
        evidence_json TEXT NOT NULL,
        PRIMARY KEY (incident_id, evidence_type)
      );

      CREATE INDEX IF NOT EXISTS incident_evidence_type_time
        ON incident_evidence(evidence_type, last_observed_at DESC);

      -- DevSpace 的 openai/session 是 conversation 级匿名键，不是 turn key。
      -- 未绑定 metadata 也必须先落盘：第一次 remote tool call 就是我们想保留的 start 下界；
      -- 后续一旦通过 WSS/body/correlation 解出 canonical conversation，再原位补 binding。
      CREATE TABLE IF NOT EXISTS devspace_metadata_bindings (
        metadata_id TEXT PRIMARY KEY,
        conversation_id TEXT,
        display_title TEXT,
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
        lifecycle_state TEXT NOT NULL DEFAULT 'unbound'
      );

      CREATE INDEX IF NOT EXISTS devspace_metadata_bindings_conversation
        ON devspace_metadata_bindings(conversation_id, last_seen_at DESC);

      CREATE INDEX IF NOT EXISTS devspace_metadata_bindings_unbound
        ON devspace_metadata_bindings(lifecycle_state, last_seen_at DESC);

      CREATE TABLE IF NOT EXISTS devspace_binding_turn_evidence (
        conversation_id TEXT NOT NULL,
        turn_exchange_id TEXT NOT NULL,
        first_tool_at INTEGER NOT NULL,
        last_tool_at INTEGER NOT NULL,
        tool_call_count INTEGER NOT NULL,
        evidence_revision TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        matched_metadata_id TEXT,
        first_queued_at INTEGER NOT NULL,
        last_queued_at INTEGER NOT NULL,
        last_attempt_at INTEGER,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_attempt_evidence_revision TEXT,
        last_attempt_metadata_revision TEXT,
        PRIMARY KEY (conversation_id, turn_exchange_id)
      );

      CREATE INDEX IF NOT EXISTS devspace_binding_turn_evidence_pending_time
        ON devspace_binding_turn_evidence(status, first_tool_at, last_tool_at);

      CREATE TABLE IF NOT EXISTS devspace_trace_turn_bindings (
        trace_id TEXT PRIMARY KEY,
        -- 兼容字段：保留首次观察到的 metadata。真正的 trace→metadata 关系在
        -- devspace_trace_metadata_members 中是一对多，绝不能再把本列当唯一成员。
        metadata_id TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        first_audit_id TEXT NOT NULL,
        last_audit_id TEXT NOT NULL,
        conversation_id TEXT,
        turn_exchange_id TEXT,
        request_id TEXT,
        status TEXT NOT NULL DEFAULT 'provisional',
        verified_at INTEGER,
        conflict_reason TEXT
      );

      CREATE INDEX IF NOT EXISTS devspace_trace_turn_bindings_metadata_time
        ON devspace_trace_turn_bindings(metadata_id, last_seen_at DESC);

      CREATE INDEX IF NOT EXISTS devspace_trace_turn_verified_turn
        ON devspace_trace_turn_bindings(conversation_id, turn_exchange_id, last_seen_at DESC)
        WHERE conversation_id IS NOT NULL
          AND turn_exchange_id IS NOT NULL;

      -- 一个 request/generation 的 trace 可以因为 MCP reconnect 等原因先后出现多个
      -- openai/session metadata；metadata 自身也可能在后续 turn/trace 再次出现。
      -- 因此成员关系必须独立保存，不能把 metadata_id 塞在 trace 主表里做 1:1。
      CREATE TABLE IF NOT EXISTS devspace_trace_metadata_members (
        trace_id TEXT NOT NULL,
        metadata_id TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        first_audit_id TEXT NOT NULL,
        last_audit_id TEXT NOT NULL,
        PRIMARY KEY (trace_id, metadata_id)
      ) WITHOUT ROWID;

      CREATE INDEX IF NOT EXISTS devspace_trace_metadata_members_metadata_time
        ON devspace_trace_metadata_members(metadata_id, last_seen_at DESC);

      -- DevSpace Recover overlay：只保存本地审计事实，不冒充 first-party messages。
      -- canonical body 后续出现相同 tool+args 时只打 superseded 标记，保留原始取证链。
      CREATE TABLE IF NOT EXISTS devspace_recovery_audits (
        audit_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        metadata_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        tool_fingerprint TEXT NOT NULL,
        args_json TEXT NOT NULL,
        result_json TEXT,
        error TEXT,
        conclusion TEXT,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        superseded_at INTEGER,
        superseded_by_message_id TEXT
      );

      CREATE INDEX IF NOT EXISTS devspace_recovery_audits_conversation
        ON devspace_recovery_audits(conversation_id, superseded_at, started_at, audit_id);

      CREATE INDEX IF NOT EXISTS devspace_recovery_audits_fingerprint
        ON devspace_recovery_audits(conversation_id, tool_fingerprint, superseded_at, started_at);

      -- DevSpace audit 的 durable 消费游标。
      -- 一个 consumer 一行；Archive daemon 当前使用固定 consumer key。游标只在整条 audit
      -- 已完成 observe/recovery/watchdog 处理后推进，因此进程崩溃最多造成安全重放，不会漏过。
      CREATE TABLE IF NOT EXISTS devspace_audit_consumer_state (
        consumer_key TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        audit_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- Watchdog 属于 conversation/turn 生命周期，不属于某一个 metadata。
      -- 同一 conversation 可能先后出现多个 openai/session，因此把 active timer 独立持久化。
      -- daemon 重启后必须恢复原 started_at；绝不能用“最近一条 tool audit”重新起表。
      CREATE TABLE IF NOT EXISTS active_watchdogs (
        conversation_id TEXT PRIMARY KEY,
        started_at INTEGER NOT NULL,
        last_event_at INTEGER NOT NULL,
        last_watchdog_at INTEGER,
        watchdog_pending_at INTEGER,
        start_type TEXT NOT NULL,
        last_diagnostic_turn_key TEXT,
        updated_at INTEGER NOT NULL
      );

      -- SSE resume capability：只属于本地控制面，不通过 Bridge/Reader 下发。
      -- turn_exchange_id 尚未出现时先以 conversation id 作为临时 turn_key；后续收到更强 turn id
      -- 时以新 key 覆盖/并存，恢复器始终优先取最近一条。
      CREATE TABLE IF NOT EXISTS live_resume_credentials (
        turn_key TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        turn_exchange_id TEXT,
        token TEXT NOT NULL,
        resume_offset TEXT,
        token_sha256 TEXT NOT NULL,
        token_length INTEGER NOT NULL,
        source_transport TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        last_resume_attempt_at INTEGER,
        resume_attempt_count INTEGER NOT NULL DEFAULT 0,
        next_resume_at INTEGER,
        last_resume_status INTEGER,
        last_resume_error TEXT
      );

      CREATE INDEX IF NOT EXISTS live_resume_credentials_conversation
        ON live_resume_credentials(conversation_id, last_seen_at DESC);

      -- 通知本身是旁路副作用，但用户明确要求“每个 turn 的终态都有可见结果”。
      -- 因此成功发送后持久记账，避免 WSS 重复 complete、settle recheck、daemon restart
      -- 造成同一 turn 反复 Bark。失败不落本表，让后续同事实观察仍有机会重试。
      CREATE TABLE IF NOT EXISTS turn_notification_ledger (
        notification_key TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        conversation_id TEXT,
        turn_key TEXT,
        sent_at INTEGER NOT NULL,
        provider_status INTEGER,
        payload_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS turn_notification_ledger_conversation
        ON turn_notification_ledger(conversation_id, sent_at DESC);

      -- Catalog Watchdog 的局部 anti-resurrection 水位。
      -- 只记“某个 conversation 的这一份 catalog update_time 已经跨过一次 Watchdog 硬边界”，
      -- 不再把整个 conversation 留在 active_watchdogs 里充当墓碑。update_time 真正变化时可自然开始
      -- 新的 catalog observation generation；DevSpace/WSS 等可靠 activity 完全不受该表影响。
      CREATE TABLE IF NOT EXISTS catalog_watchdog_watermarks (
        conversation_id TEXT PRIMARY KEY,
        update_time_key TEXT NOT NULL,
        completed_at INTEGER NOT NULL
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
    this.ensureColumn('devspace_metadata_bindings', 'display_title', 'TEXT')
    this.ensureColumn('devspace_binding_turn_evidence', 'last_attempt_evidence_revision', 'TEXT')
    this.ensureColumn('devspace_binding_turn_evidence', 'last_attempt_metadata_revision', 'TEXT')

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
    // turn_exchange_id 是历史库后补列，因此这个索引必须在 ensureColumn 之后创建；
    // fresh DB 的初始 messages schema 还没有该列，过早 CREATE INDEX 会让整个 migration 失败。
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS messages_tool_turn_time
        ON messages(conversation_id, turn_exchange_id, create_time)
        WHERE recipient='api_tool.call_tool'
          AND turn_exchange_id IS NOT NULL
          AND create_time IS NOT NULL
          AND text<>'';
    `)
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
    this.ensureColumn('active_watchdogs', 'watchdog_pending_at', 'INTEGER')

    // Incident 的稳定身份必须属于某一个 turn，而不是“这个 conversation 当前有一张红牌”。
    // 旧库已有少量 incident：优先沿用 turn_exchange_id；极少数没有 turn id 的历史行退化用自身 id，
    // 只为保证迁移唯一性。新写入会使用 turn_exchange_id/user message/last message 生成稳定 turn_key。
    const incidentIdentityBackfillNeeded = this.db.prepare(`
      SELECT 1 AS needed
      FROM incidents
      WHERE turn_key IS NULL OR turn_key = ''
         OR last_observed_at IS NULL
         OR lifecycle_class IS NULL OR lifecycle_class = ''
      LIMIT 1
    `).get()
    if (incidentIdentityBackfillNeeded) {
      this.db.prepare(`
        UPDATE incidents
        SET turn_key = COALESCE(NULLIF(turn_key, ''), NULLIF(turn_exchange_id, ''), id),
            last_observed_at = COALESCE(last_observed_at, resolved_at, detected_at),
            lifecycle_class = COALESCE(NULLIF(lifecycle_class, ''), CASE
              WHEN incident_kind = 'watchdog-timeout' THEN 'watchdog-timeout'
              WHEN terminal_evidence IN ('client-stopped', 'interrupted') THEN 'explicit-interrupted'
              WHEN source LIKE '%conversation-turn-complete%'
                OR source LIKE '%async-complete%'
              THEN 'complete-no-final'
              ELSE 'abnormal-terminal'
            END)
        WHERE turn_key IS NULL OR turn_key = ''
           OR last_observed_at IS NULL
           OR lifecycle_class IS NULL OR lifecycle_class = ''
      `).run()
    }

    // historical-turn 只证明“后面已经出现新的 user turn，因此旧轮已经结束”；它并不能证明
    // Archive 当时观察到了 conversation-turn-complete。过去把这类记录也归为 complete-no-final
    // 会污染 lifecycle 统计。只有显式 interrupted/client_stopped 例外，其余历史无-final 统一
    // 回收到 generic abnormal-terminal；source/reason/diagnostic 仍保留完整取证事实。
    const historicalLifecycleBackfillNeeded = this.db.prepare(`
      SELECT 1 AS needed
      FROM incidents
      WHERE source LIKE '%:historical-turn'
        AND terminal_evidence='none'
        AND lifecycle_class='complete-no-final'
      LIMIT 1
    `).get()
    if (historicalLifecycleBackfillNeeded) {
      this.db.prepare(`
        UPDATE incidents
        SET lifecycle_class='abnormal-terminal',
            reason=CASE
              WHEN reason LIKE '历史 turn 后续已经出现更新的 user turn%'
              THEN '历史 turn 后续已经出现更新的 user turn，可确认该轮已结束且没有 final；未观察到该 turn 的 conversation-turn-complete 证据。'
              ELSE reason
            END
        WHERE source LIKE '%:historical-turn'
          AND terminal_evidence='none'
          AND lifecycle_class='complete-no-final'
      `).run()
    }
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

  /**
   * v2：为 Hot message 增加窄 raw hash。
   *
   * 这是纯 schema delta，不回填 44 万历史行。历史 raw_hash 保持 NULL，首次被自然 Body 触碰时
   * 再懒填；因此升级成本与 4.9GB messages payload 大小无关，也不会制造一次全库 writer lock。
   */
  private migrateV2(): void {
    this.ensureColumn('messages', 'raw_hash', 'TEXT')
  }

  /**
   * v3：窄 message raw fingerprint side table。
   *
   * `messages.raw_hash` 是在 4.9GB 肥表尾部 ALTER 出来的列；直接从 messages 读取它仍可能需要
   * 访问承载 raw_json 的大 record/overflow page。side table 则只有主键+64字节 hash，可作为真正
   * 的热 no-op 判定结构。这里故意不做历史 backfill：首次自然 Body 触碰旧消息时才从旧 raw_json
   * 核验并懒填，避免升级时扫描 44 万条历史肥 row。
   */
  private migrateV3(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS message_raw_fingerprints (
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL,
        raw_hash TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (conversation_id, message_id)
      ) WITHOUT ROWID;
    `)
  }

  /** v4：把 catalog stale-active 防复活从 active Watchdog generation 中拆成独立持久水位。 */
  private migrateV4(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS catalog_watchdog_watermarks (
        conversation_id TEXT PRIMARY KEY,
        update_time_key TEXT NOT NULL,
        completed_at INTEGER NOT NULL
      );
    `)
  }

  /** v5：DevSpace trace-id 的 provisional→canonical turn 双向身份层。 */
  private migrateV5(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS devspace_trace_turn_bindings (
        trace_id TEXT PRIMARY KEY,
        metadata_id TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        first_audit_id TEXT NOT NULL,
        last_audit_id TEXT NOT NULL,
        conversation_id TEXT,
        turn_exchange_id TEXT,
        request_id TEXT,
        status TEXT NOT NULL DEFAULT 'provisional',
        verified_at INTEGER,
        conflict_reason TEXT
      );

      CREATE INDEX IF NOT EXISTS devspace_trace_turn_bindings_metadata_time
        ON devspace_trace_turn_bindings(metadata_id, last_seen_at DESC);

      CREATE UNIQUE INDEX IF NOT EXISTS devspace_trace_turn_verified_turn
        ON devspace_trace_turn_bindings(conversation_id, turn_exchange_id)
        WHERE status='verified'
          AND conversation_id IS NOT NULL
          AND turn_exchange_id IS NOT NULL;
    `)
  }

  /** v6：live touched-resource refresh 必须按 conversation+message 精确删除，不能扫整聊天。 */
  private migrateV6(): void {
    const resourceColumns = this.db.prepare('PRAGMA table_info(resources)').all() as Array<{ name?: string }>
    if (resourceColumns.length === 0) return
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS resources_conversation_message
        ON resources(conversation_id, message_id);
    `)
  }

  /**
   * v7 was briefly released with a large covering index for DevSpace binding evidence reads.
   * Production may therefore already report user_version=7. The final implementation moved the
   * evidence read into the Archive worker instead, so v7 is retained as a compatibility tombstone:
   * new upgrades advance monotonically but do not create or require that optional index.
   */
  private migrateV7(): void {
    // Intentionally empty. Never downgrade an already-issued SQLite user_version.
  }

  /**
   * v8：把 trace 从“伪 Turn 1:1”修正为 request/generation identity graph。
   *
   * 旧 v5 schema 同时做了两个过强假设：
   * 1. 一个 trace 只能有一个 metadata；
   * 2. 一个 canonical Turn Exchange 只能有一个 verified trace。
   *
   * 真实样本已经同时推翻两点。这里不重写 raw facts，而是新增 trace→metadata 成员表、
   * 放开 Turn→trace 多成员，并把旧实现制造的 metadata-mismatch / turn-remap 假冲突修复。
   * `trace-remap`（同一 trace 被映射到不同 canonical turn）仍然保留为真正冲突。
   */
  private migrateV8(): void {
    this.db.exec(`
      -- 正常 v5+ 生产库一定已有本表；但升级逻辑仍保持自包含，允许测试夹具/部分恢复库
      -- 只声明 user_version 而缺少旧表时继续安全前进。
      CREATE TABLE IF NOT EXISTS devspace_trace_turn_bindings (
        trace_id TEXT PRIMARY KEY,
        metadata_id TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        first_audit_id TEXT NOT NULL,
        last_audit_id TEXT NOT NULL,
        conversation_id TEXT,
        turn_exchange_id TEXT,
        request_id TEXT,
        status TEXT NOT NULL DEFAULT 'provisional',
        verified_at INTEGER,
        conflict_reason TEXT
      );

      DROP INDEX IF EXISTS devspace_trace_turn_verified_turn;

      CREATE INDEX IF NOT EXISTS devspace_trace_turn_verified_turn
        ON devspace_trace_turn_bindings(conversation_id, turn_exchange_id, last_seen_at DESC)
        WHERE conversation_id IS NOT NULL
          AND turn_exchange_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS devspace_trace_metadata_members (
        trace_id TEXT NOT NULL,
        metadata_id TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        first_audit_id TEXT NOT NULL,
        last_audit_id TEXT NOT NULL,
        PRIMARY KEY (trace_id, metadata_id)
      ) WITHOUT ROWID;

      CREATE INDEX IF NOT EXISTS devspace_trace_metadata_members_metadata_time
        ON devspace_trace_metadata_members(metadata_id, last_seen_at DESC);

      INSERT OR IGNORE INTO devspace_trace_metadata_members (
        trace_id, metadata_id, first_seen_at, last_seen_at, first_audit_id, last_audit_id
      )
      SELECT trace_id, metadata_id, first_seen_at, last_seen_at, first_audit_id, last_audit_id
      FROM devspace_trace_turn_bindings
      WHERE metadata_id <> '';

      UPDATE devspace_trace_turn_bindings
      SET status=CASE
            WHEN conversation_id IS NOT NULL AND turn_exchange_id IS NOT NULL THEN 'verified'
            ELSE 'provisional'
          END,
          conflict_reason=NULL
      WHERE status='conflict'
        AND (
          conflict_reason LIKE 'metadata-mismatch:%'
          OR conflict_reason LIKE 'turn-remap:%'
        );
    `)
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
        status=CASE WHEN excluded.source_observed_at >= COALESCE(messages.source_observed_at, 0) THEN COALESCE(excluded.status, messages.status) ELSE messages.status END,
        end_turn=CASE WHEN excluded.source_observed_at >= COALESCE(messages.source_observed_at, 0) THEN COALESCE(excluded.end_turn, messages.end_turn) ELSE messages.end_turn END,
        weight=CASE WHEN excluded.source_observed_at >= COALESCE(messages.source_observed_at, 0) THEN excluded.weight ELSE messages.weight END,
        request_id=CASE WHEN excluded.source_observed_at >= COALESCE(messages.source_observed_at, 0) THEN COALESCE(excluded.request_id, messages.request_id) ELSE messages.request_id END,
        turn_exchange_id=CASE WHEN excluded.source_observed_at >= COALESCE(messages.source_observed_at, 0) THEN COALESCE(excluded.turn_exchange_id, messages.turn_exchange_id) ELSE messages.turn_exchange_id END,
        model_slug=CASE WHEN excluded.source_observed_at >= COALESCE(messages.source_observed_at, 0) THEN excluded.model_slug ELSE messages.model_slug END,
        resolved_model_slug=CASE WHEN excluded.source_observed_at >= COALESCE(messages.source_observed_at, 0) THEN excluded.resolved_model_slug ELSE messages.resolved_model_slug END,
        finish_type=CASE WHEN excluded.source_observed_at >= COALESCE(messages.source_observed_at, 0) THEN COALESCE(excluded.finish_type, messages.finish_type) ELSE messages.finish_type END,
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
    const getConversationTitle = this.db.prepare(
      'SELECT title FROM conversations WHERE id = ?',
    )
    const invalidateMessageFingerprints = this.db.prepare(
      'DELETE FROM message_raw_fingerprints WHERE conversation_id = ?',
    )

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
        // official import 可以改 canonical raw_json；fingerprint 只是 plural no-op cache，任何非 plural
        // raw writer 都先整 conversation 失效，避免陈旧 hash 让后续 Body 错误走快路。
        invalidateMessageFingerprints.run(conversationId)

        // Markdown 仍按当前分支生成；完整树则进入 mapping_nodes/messages。
        const canonical = adaptConversation(rawConversation)
        const markdown = visibleForMarkdown(canonical) ? conversationToMarkdown(canonical) : ''
        const allMessages = Object.values(mapping)
          .map(node => record(node).message)
          .filter(message => message && typeof message === 'object' && !Array.isArray(message))
        upsertConversation.run(
          conversationId,
          preferredConversationTitle(
            (getConversationTitle.get(conversationId) as { title?: string } | undefined)?.title,
            stringValue(rawConversation.title) ?? 'ChatGPT Conversation',
            conversationId,
          ),
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
        m.row_id AS rowId,
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
      rowId: number
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

    const insertFts = this.db.prepare('INSERT INTO message_fts (rowid, conversation_id, message_id, title, role, text) VALUES (?, ?, ?, ?, ?, ?)')
    const insertTrigram = this.db.prepare('INSERT INTO message_fts_trigram (rowid, conversation_id, message_id, title, role, text) VALUES (?, ?, ?, ?, ?, ?)')
    const insertBigram = this.db.prepare('INSERT INTO message_fts_bigram (rowid, conversation_id, message_id, grams) VALUES (?, ?, ?, ?)')
    const insertAll = this.db.prepare('INSERT INTO message_fts_all (rowid, conversation_id, message_id, title, role, channel, content_type, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')

    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.exec(`
        DELETE FROM message_fts;
        DELETE FROM message_fts_trigram;
        DELETE FROM message_fts_bigram;
        DELETE FROM message_fts_all;
      `)
      for (const message of messages) {
        if (options.includeAuditText && message.text.trim()) {
          insertAll.run(
            message.rowId,
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
          insertFts.run(message.rowId, message.conversationId, message.messageId, message.title, message.role, message.text)
          insertTrigram.run(message.rowId, message.conversationId, message.messageId, message.title, message.role, message.text)
          const grams = cjkShortTokens(message.text)
          if (grams) insertBigram.run(message.rowId, message.conversationId, message.messageId, grams)
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

  /**
   * 只重建“两字 CJK”专用 bigram 索引。
   *
   * 生产库已经有健康的 unicode61/trigram FTS；为了给旧库补建 bigram，不应调用完整
   * `rebuildSearchIndexes()` 去重复改写两个大索引和资源派生表。这里直接读取 trigram FTS
   * 已筛选过的可读正文（约数万行），生成紧凑 bigram token 后写入新表。
   *
   * 返回写入的 message 数，便于部署脚本/人工验收确认不是空索引。
   */
  rebuildBigramSearchIndex(): number {
    const rows = this.db.prepare(`
      SELECT m.row_id AS rowId, f.conversation_id AS conversationId, f.message_id AS messageId, f.text
      FROM message_fts_trigram f
      JOIN messages m
        ON m.conversation_id = f.conversation_id
       AND m.message_id = f.message_id
    `).iterate() as Iterable<{ rowId: number, conversationId: string, messageId: string, text: string }>
    const insertBigram = this.db.prepare(
      'INSERT INTO message_fts_bigram (rowid, conversation_id, message_id, grams) VALUES (?, ?, ?, ?)',
    )

    let inserted = 0
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.exec('DELETE FROM message_fts_bigram')
      for (const row of rows) {
        const grams = cjkShortTokens(row.text)
        if (!grams) continue
        insertBigram.run(row.rowId, row.conversationId, row.messageId, grams)
        inserted += 1
      }
      this.db.exec('COMMIT')
    }
    catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }

    // 一次性全量写入后主动合并 FTS segment，后续短词搜索无需承担碎片整理成本。
    this.db.prepare("INSERT INTO message_fts_bigram(message_fts_bigram) VALUES('optimize')").run()
    return inserted
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
      /** 只有 WSS complete / Watchdog 等 completion trigger 才允许按当前 Body 建立 incident。 */
      classifyCompletionIncident?: boolean
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
       * live 传输可能领先于随后到达的 canonical body checkpoint。
       * 若同一 message_id 已观察到更长文本，而新 payload 只携带其严格前缀，
       * 保留更长的 content/text；status/end_turn/metadata/current_node 等其余字段仍以
       * 新 payload 为准。双方文本并非 prefix 时仍按新 payload 更新，避免把真实 replace/edit
       * 错当成“回退”。
       */
      preserveObservedTextPrefix?: boolean
      /**
       * 是否已有外部证据确认这一轮已经结束。
       * false 时仍可记录 explicit client_stopped/interrupted，但不能把 open reasoning/tool 尾巴
       * 单独解释成异常终止；这用于 watchdog / gap repair 防止误报仍在正常运行的长任务。
       */
      allowIncompleteTailIncident?: boolean
      /**
       * daemon 可提前在线程池完成 forensic observation 的 JSON/gzip 准备。
       * 若省略则保持旧同步 fallback，供 CLI/测试/其它调用方使用。
       */
      preparedObservation?: PreparedArchiveEvidence
      /**
       * 外部 Cold Evidence 已经 durable 落盘时，Hot SQLite 不再重复写 raw_json_gzip。
       * 旧 CLI/测试/尚未迁移的 SSE 路径省略此项，继续使用 legacy live_observations fallback。
       */
      skipLegacyObservation?: boolean
    } = {},
  ): LiveMergeResult {
    const mergeStartedAt = performance.now()
    const conversation = adaptConversation(payload)
    if (conversation.sourceFormat !== 'messages') throw new Error('Live merge currently requires a plural messages[] payload')
    const conversationId = conversation.conversationId
    if (!conversationId) throw new Error('Live messages payload has no conversation_id')

    const rawPayload = record(payload)
    const observedAt = options.observedAt ?? Date.now()
    const now = Date.now()
    const updateCurrentState = options.updateCurrentState !== false
    const rawText = options.preparedObservation?.rawText ?? json(payload)
    const messageIds = conversation.messages.map(message => message.id)
    const knownBefore = this.knownMessageIds(conversationId, messageIds)
    const incomingRawJson = new Map<string, string>()
    const incomingRawHash = new Map<string, string>()
    for (const message of conversation.messages) {
      const rawJson = json(record(message.raw))
      incomingRawJson.set(message.id, rawJson)
      incomingRawHash.set(message.id, sha256Text(rawJson))
    }

    type MessageFingerprintRow = { messageId: string, rawHash: string }
    const existingFingerprints = new Map<string, string>()
    const knownIds = messageIds.filter(id => knownBefore.has(id))
    const fingerprintReadStartedAt = performance.now()
    for (let offset = 0; offset < knownIds.length; offset += 300) {
      const ids = knownIds.slice(offset, offset + 300)
      if (ids.length === 0) continue
      const placeholders = ids.map(() => '?').join(',')
      const rows = this.db.prepare(`
        SELECT message_id AS messageId, raw_hash AS rawHash
        FROM message_raw_fingerprints
        WHERE conversation_id = ? AND message_id IN (${placeholders})
      `).all(conversationId, ...ids) as unknown as MessageFingerprintRow[]
      for (const row of rows) existingFingerprints.set(row.messageId, row.rawHash)
    }
    const fingerprintReadMs = performance.now() - fingerprintReadStartedAt

    type ExistingMessageContent = {
      messageId: string
      text?: unknown
      contentJson?: unknown
      rawJson?: unknown
    }
    const existingMessageContent = new Map<string, ExistingMessageContent>()
    const loadExistingMessageContent = (ids: string[]) => {
      for (let offset = 0; offset < ids.length; offset += 300) {
        const chunk = ids.slice(offset, offset + 300)
        if (chunk.length === 0) continue
        const placeholders = chunk.map(() => '?').join(',')
        const rows = this.db.prepare(`
          SELECT message_id AS messageId, text, content_json AS contentJson, raw_json AS rawJson
          FROM messages
          WHERE conversation_id = ? AND message_id IN (${placeholders})
        `).all(conversationId, ...chunk) as unknown as ExistingMessageContent[]
        for (const row of rows) existingMessageContent.set(row.messageId, row)
      }
    }
    const existingReadStartedAt = performance.now()
    // fingerprint 命中说明 incoming raw canonical 与上次已核验版本完全相同，不再把对应
    // raw_json/content_json 从 4.9GB messages 肥表搬进 Node。缺 fingerprint 或 hash 不同才回退
    // 旧全文核验；因此这条快路是 additive cache，不是新的 source of truth。
    const fatReadIds = knownIds.filter((messageId) => {
      const stored = existingFingerprints.get(messageId)
      const incoming = incomingRawHash.get(messageId)
      return !stored || !incoming || stored !== incoming
    })
    loadExistingMessageContent(fatReadIds)
    let existingReadMs = performance.now() - existingReadStartedAt
    const prepareFinishedAt = performance.now()

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
        status=COALESCE(excluded.status, messages.status),
        end_turn=COALESCE(excluded.end_turn, messages.end_turn),
        weight=excluded.weight,
        request_id=COALESCE(excluded.request_id, messages.request_id),
        turn_exchange_id=COALESCE(excluded.turn_exchange_id, messages.turn_exchange_id),
        model_slug=excluded.model_slug,
        resolved_model_slug=excluded.resolved_model_slug,
        finish_type=COALESCE(excluded.finish_type, messages.finish_type),
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

    const touchedMessageIds: string[] = []
    const observationOnlyMessageIds: string[] = []
    const fingerprintUpdates = new Map<string, string>()
    let fingerprintHits = 0
    let conversationHeadMs = 0
    let messageWriteMs = 0
    let writerLockWaitMs = 0
    let observationMs = 0
    let derivedMs = 0
    let commitMs = 0
    let observationGzipBytes = 0
    const writerLockStartedAt = performance.now()
    this.db.exec('BEGIN IMMEDIATE')
    writerLockWaitMs = performance.now() - writerLockStartedAt
    try {
      const conversationHeadStartedAt = performance.now()
      const existingConversation = this.db.prepare(
        'SELECT title FROM conversations WHERE id = ?',
      ).get(conversationId) as { title?: string } | undefined
      const conversationExists = Boolean(existingConversation)
      const mergedTitle = preferredConversationTitle(existingConversation?.title, conversation.title, conversationId)
      const conversationTitleChanged = Boolean(existingConversation && existingConversation.title !== mergedTitle)
      if (conversationTitleChanged) {
        // title 变化需要让当前页 FTS title 走原来的完整刷新语义。绝大多数 Body 不会改 title，
        // 因此只有这个极少分支允许在拿到 writer lock 后补读此前被 fingerprint 快路省掉的 raw。
        const missingForTitleRefresh = knownIds.filter(messageId => !existingMessageContent.has(messageId))
        if (missingForTitleRefresh.length > 0) {
          const titleRefreshReadStartedAt = performance.now()
          loadExistingMessageContent(missingForTitleRefresh)
          existingReadMs += performance.now() - titleRefreshReadStartedAt
        }
      }
      if (updateCurrentState || !conversationExists) {
        upsertConversation.run(
          conversationId,
          mergedTitle,
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
      conversationHeadMs = performance.now() - conversationHeadStartedAt

      const messageWriteStartedAt = performance.now()
      conversation.messages.forEach((message, pageOrdinal) => {
        if (options.insertUnknownOnly === true && knownBefore.has(message.id)) return
        const rawMessage = record(message.raw)
        const originalRawJson = incomingRawJson.get(message.id) ?? json(rawMessage)
        const originalRawHash = incomingRawHash.get(message.id) ?? sha256Text(originalRawJson)
        const storedFingerprint = existingFingerprints.get(message.id)
        if (
          !conversationTitleChanged
          && knownBefore.has(message.id)
          && storedFingerprint
          && storedFingerprint === originalRawHash
        ) {
          fingerprintHits += 1
          observationOnlyMessageIds.push(message.id)
          return
        }
        let effectiveRawMessage = rawMessage
        let effectiveText = message.text
        const author = record(rawMessage.author)
        let content = record(rawMessage.content)
        const metadata = record(rawMessage.metadata)
        const finishDetails = record(metadata.finish_details)
        const parentId = stringValue(metadata.parent_id)
        const existing = knownBefore.has(message.id)
          ? existingMessageContent.get(message.id)
          : undefined

        if (options.preserveObservedTextPrefix === true) {
          const existingText = typeof existing?.text === 'string' ? existing.text : ''
          const incomingText = typeof message.text === 'string' ? message.text : ''
          if (
            existingText.length > incomingText.length
            && existingText.startsWith(incomingText)
            && typeof existing?.contentJson === 'string'
          ) {
            try {
              const existingContent = record(JSON.parse(existing.contentJson))
              effectiveText = existingText
              content = existingContent
              effectiveRawMessage = { ...rawMessage, content: existingContent }
            }
            catch {
              // content_json 理论上始终由本库 JSON.stringify 生成；若历史库损坏，宁可退回新 payload，
              // 也不要让“保留更长证据”这条辅助规则阻塞整个 canonical merge。
            }
          }
        }

        const effectiveRawJson = effectiveRawMessage === rawMessage
          ? originalRawJson
          : json(effectiveRawMessage)
        const effectiveRawHash = effectiveRawMessage === rawMessage
          ? originalRawHash
          : sha256Text(effectiveRawJson)
        // first-party Body 经常重复返回完全相同的 canonical message。旧实现即使 raw_json
        // 一个字节都没变，也会重写大 TEXT/JSON、DELETE+INSERT message_parts，并把该行再次
        // 送进三套 FTS/resources rebuild；newMessages=0 的真实页面因此仍可同步耗时数百毫秒。
        // raw canonical 完全相同时，正文/metadata/状态/资源派生都不可能改变，只推进“本次又看见”
        // 的观察时间即可。若标题变化则保留旧完整路径，让本页 FTS title 按原语义刷新。
        if (!conversationTitleChanged && typeof existing?.rawJson === 'string' && existing.rawJson === effectiveRawJson) {
          fingerprintUpdates.set(message.id, effectiveRawHash)
          observationOnlyMessageIds.push(message.id)
          return
        }

        touchedMessageIds.push(message.id)
        fingerprintUpdates.set(message.id, effectiveRawHash)

        upsertMessage.run(
          conversationId,
          message.id,
          pageOrdinal,
          message.role,
          message.authorName ?? null,
          message.recipient,
          message.channel ?? null,
          stringValue(content.content_type) ?? message.contentType,
          effectiveText,
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
          effectiveRawJson,
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
      const fingerprintEntries = [...fingerprintUpdates.entries()]
      for (let offset = 0; offset < fingerprintEntries.length; offset += 100) {
        const entries = fingerprintEntries.slice(offset, offset + 100)
        const valuesSql = entries.map(() => '(?, ?, ?, ?)').join(',')
        const params = entries.flatMap(([messageId, rawHash]) => [conversationId, messageId, rawHash, observedAt])
        this.db.prepare(`
          INSERT INTO message_raw_fingerprints (
            conversation_id, message_id, raw_hash, updated_at
          ) VALUES ${valuesSql}
          ON CONFLICT(conversation_id, message_id) DO UPDATE SET
            raw_hash=excluded.raw_hash,
            updated_at=excluded.updated_at
        `).run(...params)
      }
      // no-op Body 常常一次重复数百条完全相同 message。逐条对 messages/mapping/image
      // 各跑一条 UPDATE，会制造 N*3 次 JS<->SQLite 边界调用。更关键的是 messages 是挂着巨大
      // raw_json 的肥 row：SQLite 即使只改 last_seen_at，也会重写整条 record/overflow payload。
      // Cold Evidence event 已经永久记录“本次再次观察到同一 payload”，conversation.last_seen_at
      // 也会推进；因此 raw canonical 完全相同的 message 不应再改自身 version timestamp。
      // mapping/image 目前仍保留 seen-time 语义，先单独去掉最昂贵的 messages 肥-row rewrite。
      // Identical canonical messages already advance conversation.last_seen_at and Cold Evidence.
      // Do not rewrite mapping/image rows merely to say “observed again”: that creates writer
      // amplification with no canonical change. A 2026-10-24 production sample spent ~10s in
      // this observation-only batch while just one of 699 messages had actually changed.
      messageWriteMs = performance.now() - messageWriteStartedAt

      const observationStartedAt = performance.now()
      if (options.skipLegacyObservation === true) {
        // raw payload 已经先进入外置 CAS + event journal；Hot SQLite 只承担 canonical/runtime。
        observationGzipBytes = options.preparedObservation?.compressed.byteLength ?? 0
      }
      else {
        const compressedObservation = options.preparedObservation?.compressed
          ?? gzipSync(Buffer.from(rawText, 'utf8'))
        observationGzipBytes = compressedObservation.byteLength
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
          options.preparedObservation?.sha256 ?? sha256Text(rawText),
          compressedObservation,
        )
      }
      observationMs = performance.now() - observationStartedAt

      const derivedStartedAt = performance.now()
      if (touchedMessageIds.length > 0) {
        this.rebuildConversationDerivedInsideTransaction(conversationId, touchedMessageIds)
      }
      derivedMs = performance.now() - derivedStartedAt
      const commitStartedAt = performance.now()
      this.db.exec('COMMIT')
      commitMs = performance.now() - commitStartedAt
    }
    catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }

    const postMergeStartedAt = performance.now()
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
      const explicitHistoricalAbnormal = historical.bodyCompletionEvidence === 'client-stopped'
        || historical.bodyCompletionEvidence === 'interrupted'
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
        options.classifyCompletionIncident === true,
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
      timings: {
        totalMs: performance.now() - mergeStartedAt,
        prepareMs: prepareFinishedAt - mergeStartedAt,
        fingerprintReadMs,
        existingReadMs,
        writerLockWaitMs,
        conversationHeadMs,
        messageWriteMs,
        observationMs,
        derivedMs,
        commitMs,
        postMergeMs: performance.now() - postMergeStartedAt,
        fullRewriteMessages: touchedMessageIds.length,
        observationOnlyTouches: observationOnlyMessageIds.length,
        fingerprintHits,
        fatRowsRead: existingMessageContent.size,
        fingerprintWrites: fingerprintUpdates.size,
        rawJsonBytes: Buffer.byteLength(rawText, 'utf8'),
        observationGzipBytes,
      },
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
      preparedObservation?: PreparedArchiveEvidence
      skipLegacyObservation?: boolean
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
    const rawText = options.preparedObservation?.rawText ?? json(payload)
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
        status=COALESCE(excluded.status, messages.status),
        end_turn=COALESCE(excluded.end_turn, messages.end_turn),
        weight=excluded.weight,
        request_id=COALESCE(excluded.request_id, messages.request_id),
        turn_exchange_id=COALESCE(excluded.turn_exchange_id, messages.turn_exchange_id),
        model_slug=excluded.model_slug,
        resolved_model_slug=excluded.resolved_model_slug,
        finish_type=COALESCE(excluded.finish_type, messages.finish_type),
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
      // singular mapping 同样能覆盖 message.raw_json。先失效整个 conversation 的窄 cache；
      // 下一次 plural Body 会安全回退全文核验并懒填，而不是信任可能陈旧的 fingerprint。
      this.db.prepare(
        'DELETE FROM message_raw_fingerprints WHERE conversation_id = ?',
      ).run(conversationId)
      const existingConversation = this.db.prepare(
        'SELECT title FROM conversations WHERE id = ?',
      ).get(conversationId) as { title?: string } | undefined
      upsertConversation.run(
        conversationId,
        preferredConversationTitle(
          existingConversation?.title,
          stringValue(rawConversation.title) ?? canonical.title,
          conversationId,
        ),
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

      if (options.skipLegacyObservation !== true) {
        this.db.prepare(`
          INSERT INTO live_observations (
            conversation_id, observation_kind, endpoint, page_cursor, observed_at, sha256, raw_json_gzip
          ) VALUES (?, ?, ?, NULL, ?, ?, ?)
        `).run(
          conversationId,
          options.observationKind ?? 'mapping-snapshot',
          options.endpoint ?? null,
          observedAt,
          options.preparedObservation?.sha256 ?? sha256Text(rawText),
          options.preparedObservation?.compressed ?? gzipSync(Buffer.from(rawText, 'utf8')),
        )
      }

      this.rebuildConversationDerivedInsideTransaction(conversationId, messageIds)
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

  /**
   * 在线增量只刷新本页实际触碰到的 message 派生数据。
   *
   * 旧实现虽然没有重建“全库”，但每个 live page 都会把当前 Conversation 的全部 messages
   * 重新做三套 FTS、resources 和 markdown。对几千条消息的长聊天，这会同步阻塞 daemon
   * 主线程数秒到数十秒，连同进程的 Archive Bridge HTTP 也得不到调度。
   *
   * touchedMessageIds 存在时：
   * - live 热路径不再重写整聊天 ordinal；Reader 读取时按 create_time,row_id 动态生成稳定游标；
   * - FTS/resources 只删除并重建 touched messages；
   * - message/resource count 用 SQL 汇总；
   * - markdown 不在采集热路径生成，getMarkdown() 读取 live conversation 时按需计算。
   *
   * touchedMessageIds 省略时仍保留完整重建语义，供未来显式 repair/reindex 使用。
   */
  private rebuildConversationDerivedInsideTransaction(conversationId: string, touchedMessageIds?: string[]): void {
    const conversationRow = this.db.prepare('SELECT title FROM conversations WHERE id = ?').get(conversationId) as { title: string }

    const selectRowsSql = `
      SELECT row_id AS rowId, message_id AS messageId, role, author_name AS authorName,
             recipient, channel, content_type AS contentType, text, hidden,
             create_time AS createTime, raw_json AS rawJson
      FROM messages
      WHERE conversation_id = ?
    `
    type DerivedRow = {
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
    }

    let rows: DerivedRow[]
    const touched = touchedMessageIds
      ? [...new Set(touchedMessageIds.filter(Boolean))]
      : null
    if (touched) {
      rows = []
      for (let offset = 0; offset < touched.length; offset += 400) {
        const chunk = touched.slice(offset, offset + 400)
        if (chunk.length === 0) continue
        const placeholders = chunk.map(() => '?').join(',')
        rows.push(...this.db.prepare(`${selectRowsSql} AND message_id IN (${placeholders}) ORDER BY COALESCE(create_time, 0), row_id`).all(
          conversationId,
          ...chunk,
        ) as unknown as DerivedRow[])
      }
    }
    else {
      rows = this.db.prepare(`${selectRowsSql} ORDER BY COALESCE(create_time, 0), row_id`).all(conversationId) as unknown as DerivedRow[]
      this.db.prepare('DELETE FROM message_fts WHERE conversation_id = ?').run(conversationId)
      this.db.prepare('DELETE FROM message_fts_trigram WHERE conversation_id = ?').run(conversationId)
      this.db.prepare('DELETE FROM message_fts_bigram WHERE conversation_id = ?').run(conversationId)
      this.db.prepare('DELETE FROM resources WHERE conversation_id = ?').run(conversationId)
    }

    if (touched && touched.length > 0) {
      // FTS5 的 conversation_id/message_id 是 UNINDEXED 辅助列；逐条 DELETE 会让虚表反复扫描。
      // 必须按页批量删：每套 FTS 每批最多一次 scan，再批量重新插入 touched rows。
      for (let offset = 0; offset < touched.length; offset += 400) {
        const chunk = touched.slice(offset, offset + 400)
        const placeholders = chunk.map(() => '?').join(',')
        const chunkRows = rows.filter(row => chunk.includes(row.messageId))
        const rowIds = chunkRows.map(row => row.rowId)
        if (rowIds.length > 0) {
          const rowIdPlaceholders = rowIds.map(() => '?').join(',')
          this.db.prepare(`DELETE FROM message_fts WHERE rowid IN (${rowIdPlaceholders})`).run(...rowIds)
          this.db.prepare(`DELETE FROM message_fts_trigram WHERE rowid IN (${rowIdPlaceholders})`).run(...rowIds)
          this.db.prepare(`DELETE FROM message_fts_bigram WHERE rowid IN (${rowIdPlaceholders})`).run(...rowIds)
        }
        this.db.prepare(`DELETE FROM resources WHERE conversation_id = ? AND message_id IN (${placeholders})`).run(
          conversationId, ...chunk,
        )
      }
    }
    const insertFts = this.db.prepare('INSERT INTO message_fts (rowid, conversation_id, message_id, title, role, text) VALUES (?, ?, ?, ?, ?, ?)')
    const insertTrigram = this.db.prepare('INSERT INTO message_fts_trigram (rowid, conversation_id, message_id, title, role, text) VALUES (?, ?, ?, ?, ?, ?)')
    const insertBigram = this.db.prepare('INSERT INTO message_fts_bigram (rowid, conversation_id, message_id, grams) VALUES (?, ?, ?, ?)')
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
    for (const row of rows) {
      if (row.hidden === 0 && row.recipient === 'all' && (row.role === 'user' || row.role === 'assistant') && row.text.trim()) {
        insertFts.run(row.rowId, conversationId, row.messageId, conversationRow.title, row.role, row.text)
        insertTrigram.run(row.rowId, conversationId, row.messageId, conversationRow.title, row.role, row.text)
        const grams = cjkShortTokens(row.text)
        if (grams) insertBigram.run(row.rowId, conversationId, row.messageId, grams)
      }
      try {
        const rawMessage = JSON.parse(row.rawJson)
        rawMessages.push(rawMessage)
        const manifest = buildRichManifest(adaptConversation({
          title: conversationRow.title,
          conversation_id: conversationId,
          messages: [rawMessage],
        }))
        for (const [itemIndex, item] of manifest.items.entries()) {
          // 存储 ordinal 仅用于资源内部稳定键；展示顺序由 getResources() 按 message 时间动态生成。
          const resourceOrdinal = row.rowId * 100_000 + itemIndex
          insertResource.run(conversationId, item.messageId || row.messageId, resourceOrdinal, item.kind, item.label, json(item.data))
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

    let markdown: string | null = null
    if (!touched && rawMessages.length > 0) {
      const canonical = adaptConversation({
        title: conversationRow.title,
        conversation_id: conversationId,
        messages: rawMessages,
      })
      if (visibleForMarkdown(canonical)) markdown = conversationToMarkdown(canonical)
    }
    const messageCount = Number((this.db.prepare(
      'SELECT count(*) AS n FROM messages WHERE conversation_id = ?',
    ).get(conversationId) as { n: number }).n)
    const resourceCount = Number((this.db.prepare(
      'SELECT count(*) AS n FROM resources WHERE conversation_id = ?',
    ).get(conversationId) as { n: number }).n)
    this.db.prepare(`
      UPDATE conversations
      SET message_count = ?,
          resource_count = ?,
          markdown = CASE WHEN ? IS NULL THEN markdown ELSE ? END,
          imported_at = ?
      WHERE id = ?
    `).run(messageCount, resourceCount, markdown, markdown, Date.now(), conversationId)
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
             terminal_evidence AS bodyCompletionEvidence,
             reason
      FROM incidents
      WHERE conversation_id=? AND turn_key=?
      LIMIT 1
    `).get(conversationId, turnKey) as {
      id: string
      status: string
      incidentKind: string
      lifecycleClass: string | null
      bodyCompletionEvidence: string | null
      reason: string | null
    } | undefined

    const explicitAbnormal = diagnostic.bodyCompletionEvidence === 'client-stopped'
      || diagnostic.bodyCompletionEvidence === 'interrupted'

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

    // 历史补账的职责是确认“这个旧 turn 后来已经被新 user turn 越过”，而不是重写当时已经
    // 由更强实时证据建立的 lifecycle。尤其不能把 Watchdog/Active Zombie/complete-no-final
    // 洗成 generic abnormal-terminal。若旧 incident 已存在且历史 body 没有新增明确 interrupted
    // 证据，只刷新 body 结构并 resolve；kind/lifecycle/source/reason/evidence 全部保留。
    // 显式 client_stopped/interrupted 仍允许继续走下面的升级逻辑，因为那是更强的新终态证据。
    if (historicalEnded && currentIncident && !explicitAbnormal) {
      this.db.prepare(`
        UPDATE incidents
        SET status='resolved',
            resolved_at=COALESCE(resolved_at, ?),
            last_observed_at=?,
            tail_shape=?,
            head_state=?,
            head_rollback=?,
            off_head_same_turn_count=?,
            diagnostic_json=?
        WHERE id=?
      `).run(
        observedAt,
        observedAt,
        diagnostic.tailShape,
        diagnostic.headState,
        headRollbackObserved ? 1 : 0,
        diagnostic.offHeadSameTurnMessageCount,
        json(diagnostic),
        currentIncident.id,
      )
      return
    }

    if (diagnostic.bodyCompletionEvidence === 'final' && currentIncident?.status === 'open') {
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
      && diagnostic.bodyCompletionEvidence !== 'final'
    ) {
      // reconcile 只能补“body 现在长什么样”，不能推翻已经由更强 lifecycle 信号建立的事实。
      // 两类典型降级必须阻止：
      // 1. WSS complete 已确认 complete-no-final，后续仅凭 tool-result/reasoning tail 的 summary
      //    不能把 reason 刷回“不能据此判死”；
      // 2. 已明确 client_stopped/interrupted，后续某个缺少 finish_details 的普通快照不能把
      //    terminal_evidence 从 interrupted 降回 none。
      const preserveExplicitCompletion = currentIncident.lifecycleClass === 'explicit-interrupted'
        && diagnostic.bodyCompletionEvidence === 'none'
      const refreshedBodyCompletionEvidence = preserveExplicitCompletion
        ? currentIncident.bodyCompletionEvidence
        : diagnostic.bodyCompletionEvidence
      const refreshedReason = currentIncident.lifecycleClass === 'active-zombie'
        ? `conversation list 持续保持 active 超过 watchdog 阈值，且尚未观察到正常收口；${diagnostic.summary}`
        : currentIncident.incidentKind === 'watchdog-timeout'
          ? `超过 watchdog 阈值仍未收到 conversation-turn-complete；${diagnostic.summary}`
        : currentIncident.lifecycleClass === 'complete-no-final'
          ? `已确认 turn 完成但没有 final；${diagnostic.summary}`
          : preserveExplicitCompletion
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
        refreshedBodyCompletionEvidence,
        diagnostic.tailShape,
        diagnostic.headState,
        headRollbackObserved ? 1 : 0,
        diagnostic.offHeadSameTurnMessageCount,
        json(diagnostic),
        currentIncident.id,
      )
    }

    const inferredAbnormal = diagnostic.bodyCompletionEvidence === 'none'
      && diagnostic.tailShape !== 'final'
      && (requestedKind === 'watchdog-timeout' || requestedKind === 'active-zombie' || !diagnostic.hasInTurnSteering)
    const abnormal = explicitAbnormal || (allowIncompleteTailIncident && inferredAbnormal)
    if (allowCreate && abnormal && diagnostic.bodyCompletionEvidence !== 'final') {
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
          : historicalEnded
            ? 'abnormal-terminal'
          : allowIncompleteTailIncident
              ? 'complete-no-final'
              : 'abnormal-terminal'
      const incidentId = currentIncident?.id ?? sha256Text(`${conversationId}:${turnKey}`).slice(0, 24)
      const reason = historicalEnded && !explicitAbnormal
        ? `历史 turn 后续已经出现更新的 user turn，可确认该轮已结束且没有 final；未观察到该 turn 的 conversation-turn-complete 证据；持久化尾部为 ${diagnostic.tailShape}。`
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
        diagnostic.bodyCompletionEvidence,
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
        diagnostic.bodyCompletionEvidence,
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
               terminal_evidence AS bodyCompletionEvidence, tail_shape AS tailShape,
               head_state AS headState, head_rollback AS headRollbackObserved,
               off_head_same_turn_count AS offHeadSameTurnCount,
               source, diagnostic_json AS diagnosticJson,
               (SELECT group_concat(evidence_type, char(31))
                FROM incident_evidence e WHERE e.incident_id=incidents.id) AS evidenceTypesRaw
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
             terminal_evidence AS bodyCompletionEvidence, tail_shape AS tailShape,
             head_state AS headState, head_rollback AS headRollbackObserved,
             off_head_same_turn_count AS offHeadSameTurnCount,
             source, diagnostic_json AS diagnosticJson,
             (SELECT group_concat(evidence_type, char(31))
              FROM incident_evidence e WHERE e.incident_id=incidents.id) AS evidenceTypesRaw
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
    const existingTitle = (this.db.prepare(
      'SELECT title FROM conversations WHERE id = ?',
    ).get(conversationId) as { title?: string } | undefined)?.title

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
      INSERT INTO message_fts (rowid, conversation_id, message_id, title, role, text)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    const insertTrigram = this.db.prepare(`
      INSERT INTO message_fts_trigram (rowid, conversation_id, message_id, title, role, text)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    const insertBigram = this.db.prepare(`
      INSERT INTO message_fts_bigram (rowid, conversation_id, message_id, grams)
      VALUES (?, ?, ?, ?)
    `)

    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('DELETE FROM message_fts WHERE conversation_id = ?').run(conversationId)
      this.db.prepare('DELETE FROM message_fts_trigram WHERE conversation_id = ?').run(conversationId)
      this.db.prepare('DELETE FROM message_fts_bigram WHERE conversation_id = ?').run(conversationId)
      // conversations 的 ON DELETE CASCADE 会清理旧 messages/resources；随后同 ID 重建最新 snapshot。
      this.db.prepare('DELETE FROM conversations WHERE id = ?').run(conversationId)
      upsertConversation.run(
        conversationId,
        preferredConversationTitle(existingTitle, conversation.title, conversationId),
        conversation.sourceFormat,
        conversation.currentNode ?? null,
        capturedAt,
        now,
        conversation.messages.length,
        manifest.items.length,
        markdown,
      )

      const rowIds = new Map<string, number>()
      conversation.messages.forEach((message, ordinal) => {
        const insertedMessage = insertMessage.run(
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
        rowIds.set(message.id, Number(insertedMessage.lastInsertRowid))
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
        const rowId = rowIds.get(message.id)
        if (!rowId) return
        insertFts.run(
          rowId,
          conversationId,
          message.id,
          conversation.title,
          message.role,
          message.text,
        )
        insertTrigram.run(
          rowId,
          conversationId,
          message.id,
          conversation.title,
          message.role,
          message.text,
        )
        const grams = cjkShortTokens(message.text)
        if (grams) insertBigram.run(rowId, conversationId, message.id, grams)
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

  /**
   * 为普通用户查询选择最快且语义最合适的 FTS 索引。
   *
   * - 3+ CJK 先走 trigram：它能做连续子串匹配，例如“长江三峡”。
   * - 其他查询先走 unicode61：英文/数字以及“两字中文”都能在现有真实库中毫秒级命中。
   * - 3+ 非 CJK 若 unicode61 没有结果，再尝试 trigram，兼容 `Ops` 命中 `LifeOps` 这类子串。
   *
   * 旧实现把两字 CJK 直接丢到 `%LIKE%` 全表扫描；真实库中“搜索”超过 60 秒仍未结束，
   * 而 unicode61 同一查询只有几十毫秒，因此这里明确禁止把短 CJK 直接送进无界 LIKE。
   */
  private resolveSearchPlan(query: string): ArchiveSearchPlan | null {
    const codepointLength = Array.from(query).length
    const hasCjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(query)
    const indexOrder: ArchiveSearchIndex[] = hasCjk && codepointLength <= 2
      ? ['message_fts_bigram', 'message_fts']
      : hasCjk && codepointLength >= 3
        ? ['message_fts_trigram', 'message_fts']
        : codepointLength >= 3
          ? ['message_fts', 'message_fts_trigram']
          : ['message_fts']

    // 默认允许调用者使用 FTS5 的 AND/OR/引号等语法；若语法不完整，再把整段当普通字面短语重试。
    const rawExpression = (table: ArchiveSearchIndex) => table === 'message_fts_bigram'
      ? `{grams} : (${query})`
      : `{text} : (${query})`
    const literalExpression = (table: ArchiveSearchIndex) => table === 'message_fts_bigram'
      ? `{grams} : "${query.replaceAll('"', '""')}"`
      : `{text} : "${query.replaceAll('"', '""')}"`

    for (const table of indexOrder) {
      for (const expression of [rawExpression(table), literalExpression(table)]) {
        try {
          const row = this.db.prepare(`SELECT 1 AS found FROM ${table} WHERE ${table} MATCH ? LIMIT 1`).get(expression)
          if (row) return { table, expression }
        }
        catch {
          // 当前表达式不是合法 FTS5 语法时继续尝试字面短语或下一索引；搜索本身不能因此崩溃。
        }
      }
    }
    return null
  }

  /** 读取 FTS 命中的轻量排名行；这里只拿 ID/rank，不生成正文 snippet，因此即使高频词也很轻。 */
  private readSearchRankRows(plan: ArchiveSearchPlan): ArchiveSearchRankRow[] {
    return this.db.prepare(`
      SELECT
        conversation_id AS conversationId,
        message_id AS messageId,
        bm25(${plan.table}) AS rank
      FROM ${plan.table}
      WHERE ${plan.table} MATCH ?
    `).all(plan.expression) as unknown as ArchiveSearchRankRow[]
  }

  private readBigramSnippets(
    query: string,
    selectedConversationIds: string[],
    rankRows: ArchiveSearchRankRow[],
    snippetsPerConversation: number,
  ): Map<string, ArchiveSearchHit[]> {
    const result = new Map<string, ArchiveSearchHit[]>()
    if (selectedConversationIds.length === 0) return result
    const selected = new Set(selectedConversationIds)
    const rankByMessage = new Map<string, number>()
    for (const row of rankRows) {
      if (!selected.has(row.conversationId)) continue
      rankByMessage.set(`${row.conversationId}\u0000${row.messageId}`, row.rank)
    }
    const placeholders = selectedConversationIds.map(() => '?').join(',')
    const rows = this.db.prepare(`
      SELECT m.conversation_id AS conversationId, m.message_id AS messageId,
             c.title AS title, m.role AS role, m.text AS text
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      WHERE m.conversation_id IN (${placeholders})
        AND m.hidden = 0
        AND m.recipient = 'all'
        AND m.role IN ('user', 'assistant')
        AND instr(m.text, ?) > 0
    `).all(...selectedConversationIds, query) as Array<Omit<ArchiveSearchHit, 'rank'>>
    const hits = rows
      .map(row => ({
        ...row,
        text: substringSnippet(row.text, query),
        rank: rankByMessage.get(`${row.conversationId}\u0000${row.messageId}`) ?? 0,
      }))
      .filter(row => rankByMessage.has(`${row.conversationId}\u0000${row.messageId}`))
      .sort((left, right) => left.rank - right.rank)
    for (const row of hits) {
      const bucket = result.get(row.conversationId) ?? []
      if (bucket.length < snippetsPerConversation) bucket.push(row)
      result.set(row.conversationId, bucket)
    }
    return result
  }

  /** 批量读取 Conversation 元数据；分块避免未来聊天数增大后撞 SQLite 参数数量上限。 */
  private readSearchConversationMeta(conversationIds: string[]): Map<string, ArchiveSearchMetaRow> {
    const result = new Map<string, ArchiveSearchMetaRow>()
    for (let offset = 0; offset < conversationIds.length; offset += 400) {
      const chunk = conversationIds.slice(offset, offset + 400)
      if (chunk.length === 0) continue
      const placeholders = chunk.map(() => '?').join(',')
      const rows = this.db.prepare(`
        SELECT
          id,
          title,
          captured_at AS capturedAt,
          terminal_state AS bodyCompletionState,
          last_finish_type AS lastFinishType
        FROM conversations
        WHERE id IN (${placeholders})
      `).all(...chunk) as unknown as ArchiveSearchMetaRow[]
      for (const row of rows) result.set(row.id, row)
    }
    return result
  }

  /**
   * Archive 的默认搜索语义：Conversation-first。
   *
   * 全部 message 命中先只用于统计/排名，不做任何全局 message LIMIT；
   * 真正的 limit 作用在“不同 Conversation”上。入选后才读取少量 snippets，
   * 因此一个超长聊天即使命中 1000 次，也只占一个 Conversation 席位。
   */
  searchConversations(query: string, options: ArchiveConversationSearchOptions = {}): ArchiveConversationSearchResult[] {
    const normalized = query.trim()
    if (!normalized) return []

    const safeLimit = Math.max(1, Math.min(200, Math.trunc(options.limit ?? 20)))
    const snippetsPerConversation = Math.max(1, Math.min(10, Math.trunc(options.snippetsPerConversation ?? 3)))
    const sort: ArchiveSearchSort = options.sort ?? 'relevance'
    const plan = this.resolveSearchPlan(normalized)
    const rankRows = plan ? this.readSearchRankRows(plan) : []

    const aggregates = new Map<string, { hitCount: number, bestRank: number | null, titleMatched: boolean }>()
    for (const row of rankRows) {
      const current = aggregates.get(row.conversationId) ?? { hitCount: 0, bestRank: null, titleMatched: false }
      current.hitCount += 1
      current.bestRank = current.bestRank === null ? row.rank : Math.min(current.bestRank, row.rank)
      aggregates.set(row.conversationId, current)
    }

    // 标题只有几千行，直接 LIKE 非常轻；标题命中单独记布尔值，绝不按每条 message 重复计数。
    const pattern = `%${normalized.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`
    const titleRows = this.db.prepare(`
      SELECT
        id,
        title,
        captured_at AS capturedAt,
        terminal_state AS bodyCompletionState,
        last_finish_type AS lastFinishType
      FROM conversations
      WHERE title LIKE ? ESCAPE '\\'
    `).all(pattern) as unknown as ArchiveSearchMetaRow[]
    for (const row of titleRows) {
      const current = aggregates.get(row.id) ?? { hitCount: 0, bestRank: null, titleMatched: false }
      current.titleMatched = true
      aggregates.set(row.id, current)
    }

    if (aggregates.size === 0) return []

    const meta = this.readSearchConversationMeta([...aggregates.keys()])
    // titleRows 已经读过一次元数据，直接复用，避免标题命中项再查一遍。
    for (const row of titleRows) meta.set(row.id, row)

    const candidates = [...aggregates.entries()]
      .map(([conversationId, aggregate]) => {
        const row = meta.get(conversationId)
        if (!row) return null
        return { conversationId, ...aggregate, ...row }
      })
      .filter((row): row is NonNullable<typeof row> => row !== null)

    const rankValue = (value: number | null) => value ?? Number.POSITIVE_INFINITY
    const relevanceCompare = (left: typeof candidates[number], right: typeof candidates[number]) =>
      Number(right.titleMatched) - Number(left.titleMatched)
      || rankValue(left.bestRank) - rankValue(right.bestRank)
      || right.hitCount - left.hitCount
      || right.capturedAt - left.capturedAt

    candidates.sort((left, right) => {
      if (sort === 'recent') {
        return right.capturedAt - left.capturedAt || relevanceCompare(left, right)
      }
      if (sort === 'frequency') {
        return right.hitCount - left.hitCount
          || Number(right.titleMatched) - Number(left.titleMatched)
          || rankValue(left.bestRank) - rankValue(right.bestRank)
          || right.capturedAt - left.capturedAt
      }
      return relevanceCompare(left, right)
    })

    const selected = candidates.slice(0, safeLimit)
    const snippets = new Map<string, ArchiveSearchHit[]>()
    if (plan && selected.length > 0 && plan.table === 'message_fts_bigram') {
      const bigramSnippets = this.readBigramSnippets(
        normalized,
        selected.map(row => row.conversationId),
        rankRows,
        snippetsPerConversation,
      )
      for (const [conversationId, rows] of bigramSnippets) snippets.set(conversationId, rows)
    }
    else if (plan && selected.length > 0) {
      const selectedIds = selected.map(row => row.conversationId)
      const placeholders = selectedIds.map(() => '?').join(',')
      const rows = this.db.prepare(`
        SELECT
          conversation_id AS conversationId,
          message_id AS messageId,
          title,
          role,
          snippet(${plan.table}, 4, '[', ']', ' … ', 24) AS text,
          bm25(${plan.table}) AS rank
        FROM ${plan.table}
        WHERE ${plan.table} MATCH ?
          AND conversation_id IN (${placeholders})
        ORDER BY rank
      `).all(plan.expression, ...selectedIds) as unknown as ArchiveSearchHit[]

      for (const row of rows) {
        const bucket = snippets.get(row.conversationId) ?? []
        if (bucket.length < snippetsPerConversation) bucket.push(row)
        snippets.set(row.conversationId, bucket)
      }
    }

    return selected.map(row => ({
      conversationId: row.conversationId,
      title: row.title,
      capturedAt: row.capturedAt,
      hitCount: row.hitCount,
      bestRank: row.bestRank,
      titleMatched: row.titleMatched,
      bodyCompletionState: row.bodyCompletionState,
      lastFinishType: row.lastFinishType,
      snippets: snippets.get(row.conversationId) ?? [],
    }))
  }

  /** 默认 `search()` 已迁移为 Conversation-first，便于旧调用方自然获得正确语义。 */
  search(query: string, limit = 20): ArchiveConversationSearchResult[] {
    return this.searchConversations(query, { limit })
  }

  /**
   * 原始 message-level 搜索只作为调试/展开入口保留。
   * 它不再被 Conversation 搜索拿来做全局 LIMIT，因此不会影响 Conversation recall。
   */
  searchMessages(query: string, limit = 20): ArchiveSearchHit[] {
    const normalized = query.trim()
    if (!normalized) return []
    const safeLimit = Math.max(1, Math.min(200, Math.trunc(limit)))
    const plan = this.resolveSearchPlan(normalized)
    if (!plan) return []
    if (plan.table === 'message_fts_bigram') {
      const rankRows = this.readSearchRankRows(plan)
        .sort((left, right) => left.rank - right.rank)
        .slice(0, safeLimit)
      const snippets = this.readBigramSnippets(
        normalized,
        [...new Set(rankRows.map(row => row.conversationId))],
        rankRows,
        safeLimit,
      )
      const wanted = new Set(rankRows.map(row => `${row.conversationId}\u0000${row.messageId}`))
      return [...snippets.values()]
        .flat()
        .filter(row => wanted.has(`${row.conversationId}\u0000${row.messageId}`))
        .sort((left, right) => left.rank - right.rank)
        .slice(0, safeLimit)
    }
    return this.db.prepare(`
      SELECT
        conversation_id AS conversationId,
        message_id AS messageId,
        title,
        role,
        snippet(${plan.table}, 4, '[', ']', ' … ', 24) AS text,
        bm25(${plan.table}) AS rank
      FROM ${plan.table}
      WHERE ${plan.table} MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(plan.expression, safeLimit) as unknown as ArchiveSearchHit[]
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
        resource_count AS resourceCount,
        terminal_state AS bodyCompletionState,
        incident_state AS incidentState,
        last_finish_type AS lastFinishType,
        last_finish_reason AS lastFinishReason,
        last_reasoning_status AS lastReasoningStatus
      FROM conversations
      ORDER BY captured_at DESC, imported_at DESC
      LIMIT ?
    `).all(Math.max(1, Math.min(1000, limit))) as unknown as ArchiveConversationRow[]
  }

  getConversationSummary(conversationId: string): ArchiveConversationRow | null {
    const row = this.db.prepare(`
      SELECT
        id,
        title,
        source_format AS sourceFormat,
        current_node AS currentNode,
        captured_at AS capturedAt,
        imported_at AS importedAt,
        message_count AS messageCount,
        resource_count AS resourceCount,
        terminal_state AS bodyCompletionState,
        incident_state AS incidentState,
        last_finish_type AS lastFinishType,
        last_finish_reason AS lastFinishReason,
        last_reasoning_status AS lastReasoningStatus
      FROM conversations
      WHERE id = ?
      LIMIT 1
    `).get(conversationId) as unknown as ArchiveConversationRow | undefined
    return row ?? null
  }

  getMarkdown(conversationId: string): string | null {
    const row = this.db.prepare(
      'SELECT title, source_format AS sourceFormat, markdown FROM conversations WHERE id = ?',
    ).get(conversationId) as { title?: string, sourceFormat?: string, markdown?: string } | undefined
    if (!row) return null

    // Live plural/mapping 会持续增量变化；把 markdown 从采集写热路径移到显式读取时再生成，
    // 避免每页同步都扫描/解析整段长聊天。这里直接使用 canonical messages 表字段重建，
    // 不依赖历史行是否保存了完整 raw_json；官方静态导入仍直接复用持久化 markdown。
    if (row.sourceFormat === 'messages' || row.sourceFormat === 'mapping') {
      const storedMessages = this.db.prepare(`
        SELECT message_id AS messageId, role, author_name AS authorName, recipient,
               content_type AS contentType, text, hidden, create_time AS createTime,
               metadata_json AS metadataJson
        FROM messages
        WHERE conversation_id = ?
        ORDER BY COALESCE(create_time, 0), row_id
      `).all(conversationId) as Array<{
        messageId: string
        role: string
        authorName: string | null
        recipient: string
        contentType: string
        text: string
        hidden: number
        createTime: number | null
        metadataJson: string
      }>
      if (storedMessages.length === 0) return ''
      const rawMessages = storedMessages.map(message => {
        let metadata: Record<string, unknown> = {}
        try { metadata = JSON.parse(message.metadataJson) as Record<string, unknown> }
        catch { /* 保留空 metadata，正文仍然可读。 */ }
        if (message.hidden) metadata = { ...metadata, is_visually_hidden_from_conversation: true }
        return {
          id: message.messageId,
          author: { role: message.role, name: message.authorName },
          recipient: message.recipient,
          create_time: message.createTime,
          content: {
            content_type: message.contentType,
            parts: [message.text],
          },
          metadata,
        }
      })
      const canonical = adaptConversation({
        title: row.title ?? '',
        conversation_id: conversationId,
        messages: rawMessages,
      })
      return visibleForMarkdown(canonical) ? conversationToMarkdown(canonical) : ''
    }

    return typeof row.markdown === 'string' ? row.markdown : null
  }

  /** 记录一次 DevSpace tool audit；第一次时间永远不被后续调用覆盖。 */
  observeDevSpaceMetadata(input: {
    metadataId: string
    auditId: string
    auditAt: number
    displayTitle?: string | null
  }): DevSpaceMetadataBindingRow {
    const metadataId = input.metadataId.trim()
    if (!metadataId) throw new Error('metadataId must not be empty')
    const auditAt = Math.max(0, Math.trunc(input.auditAt))
    this.db.prepare(`
      INSERT INTO devspace_metadata_bindings (
        metadata_id, conversation_id, display_title, first_seen_at, last_seen_at,
        last_audit_id, last_audit_at, lifecycle_state
      ) VALUES (?, NULL, ?, ?, ?, ?, ?, 'unbound')
      ON CONFLICT(metadata_id) DO UPDATE SET
        display_title=COALESCE(NULLIF(excluded.display_title, ''), devspace_metadata_bindings.display_title),
        first_seen_at=CASE
          WHEN devspace_metadata_bindings.conversation_id IS NULL
            AND devspace_metadata_bindings.unbound_watchdog_at IS NOT NULL
            AND excluded.last_audit_at > devspace_metadata_bindings.unbound_watchdog_at
          THEN excluded.first_seen_at
          ELSE devspace_metadata_bindings.first_seen_at
        END,
        last_seen_at=max(devspace_metadata_bindings.last_seen_at, excluded.last_seen_at),
        last_audit_id=CASE
          WHEN excluded.last_audit_at >= COALESCE(devspace_metadata_bindings.last_audit_at, 0)
          THEN excluded.last_audit_id ELSE devspace_metadata_bindings.last_audit_id END,
        last_audit_at=max(COALESCE(devspace_metadata_bindings.last_audit_at, 0), excluded.last_audit_at),
        unbound_watchdog_at=CASE
          WHEN devspace_metadata_bindings.conversation_id IS NULL
            AND devspace_metadata_bindings.unbound_watchdog_at IS NOT NULL
            AND excluded.last_audit_at > devspace_metadata_bindings.unbound_watchdog_at
          THEN NULL
          ELSE devspace_metadata_bindings.unbound_watchdog_at
        END
    `).run(
      metadataId,
      input.displayTitle?.trim() || null,
      auditAt,
      auditAt,
      input.auditId,
      auditAt,
    )
    return this.getDevSpaceMetadataBinding(metadataId)!
  }

  /**
   * 把 DevSpace 过去已经存在的 metadata 先补进 Archive binding 表。
   *
   * 这一步只补“这个 metadata 曾经出现过、首末时间是什么”，绝不猜 conversation_id。
   * 后续 exact tool+args backfill 会再决定能否可靠绑定。历史 seed 不进入内存 watchdog，
   * 因而不会把几周前的 metadata 误当成“当前正在运行”的 turn。
   */
  seedDevSpaceMetadataHistory(input: {
    metadataId: string
    firstSeenAt: number
    lastSeenAt: number
  }): { row: DevSpaceMetadataBindingRow, created: boolean } {
    const metadataId = input.metadataId.trim()
    if (!metadataId) throw new Error('metadataId must not be empty')
    const firstSeenAt = Math.max(0, Math.trunc(input.firstSeenAt))
    const lastSeenAt = Math.max(firstSeenAt, Math.trunc(input.lastSeenAt))
    const existing = this.getDevSpaceMetadataBinding(metadataId)
    this.db.prepare(`
      INSERT INTO devspace_metadata_bindings (
        metadata_id, conversation_id, first_seen_at, last_seen_at, lifecycle_state
      ) VALUES (?, NULL, ?, ?, 'unbound')
      ON CONFLICT(metadata_id) DO UPDATE SET
        first_seen_at=min(devspace_metadata_bindings.first_seen_at, excluded.first_seen_at),
        last_seen_at=max(devspace_metadata_bindings.last_seen_at, excluded.last_seen_at)
    `).run(metadataId, firstSeenAt, lastSeenAt)
    return {
      row: this.getDevSpaceMetadataBinding(metadataId)!,
      created: !existing,
    }
  }

  getDevSpaceMetadataBinding(metadataId: string): DevSpaceMetadataBindingRow | null {
    const row = this.db.prepare(`
      SELECT metadata_id AS metadataId, conversation_id AS conversationId,
             display_title AS displayTitle,
             first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt,
             bound_at AS boundAt, last_verified_at AS lastVerifiedAt,
             evidence, confidence,
             last_turn_exchange_id AS lastTurnExchangeId,
             last_request_id AS lastRequestId,
             last_audit_id AS lastAuditId, last_audit_at AS lastAuditAt,
             unbound_watchdog_at AS unboundWatchdogAt,
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
             display_title AS displayTitle,
             first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt,
             bound_at AS boundAt, last_verified_at AS lastVerifiedAt,
             evidence, confidence,
             last_turn_exchange_id AS lastTurnExchangeId,
             last_request_id AS lastRequestId,
             last_audit_id AS lastAuditId, last_audit_at AS lastAuditAt,
             unbound_watchdog_at AS unboundWatchdogAt,
             lifecycle_state AS lifecycleState
      FROM devspace_metadata_bindings
      WHERE conversation_id = ?
      ORDER BY bound_at ASC, metadata_id ASC
    `).all(conversationId) as unknown as DevSpaceMetadataBindingRow[]
  }

  /** 把 DevSpace audit 的当前最新状态幂等镜像到 recovery overlay。 */
  upsertDevSpaceRecoveryAudit(input: {
    auditId: string
    conversationId: string
    metadataId: string
    tool: string
    toolFingerprint: string
    argsJson: string
    resultJson?: string | null
    error?: string | null
    conclusion?: string | null
    startedAt: number
    finishedAt?: number | null
    observedAt?: number
  }): void {
    const observedAt = Math.max(0, Math.trunc(input.observedAt ?? Date.now()))
    const startedAt = Math.max(0, Math.trunc(input.startedAt))
    const finishedAt = input.finishedAt === null || input.finishedAt === undefined
      ? null
      : Math.max(startedAt, Math.trunc(input.finishedAt))
    this.db.prepare(`
      INSERT INTO devspace_recovery_audits (
        audit_id, conversation_id, metadata_id, tool, tool_fingerprint, args_json,
        result_json, error, conclusion, started_at, finished_at,
        first_seen_at, last_seen_at, superseded_at, superseded_by_message_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
      ON CONFLICT(audit_id) DO UPDATE SET
        conversation_id=excluded.conversation_id,
        metadata_id=excluded.metadata_id,
        tool=excluded.tool,
        tool_fingerprint=excluded.tool_fingerprint,
        args_json=excluded.args_json,
        result_json=COALESCE(excluded.result_json, devspace_recovery_audits.result_json),
        error=COALESCE(excluded.error, devspace_recovery_audits.error),
        conclusion=COALESCE(excluded.conclusion, devspace_recovery_audits.conclusion),
        started_at=excluded.started_at,
        finished_at=COALESCE(excluded.finished_at, devspace_recovery_audits.finished_at),
        last_seen_at=max(devspace_recovery_audits.last_seen_at, excluded.last_seen_at)
    `).run(
      input.auditId,
      input.conversationId,
      input.metadataId,
      input.tool,
      input.toolFingerprint,
      input.argsJson,
      input.resultJson ?? null,
      input.error ?? null,
      input.conclusion?.trim() || null,
      startedAt,
      finishedAt,
      observedAt,
      observedAt,
    )
  }

  listDevSpaceRecoveryAudits(conversationId: string, includeSuperseded = false): DevSpaceRecoveryAuditRow[] {
    const whereSuperseded = includeSuperseded ? '' : 'AND superseded_at IS NULL'
    return this.db.prepare(`
      SELECT audit_id AS auditId, conversation_id AS conversationId, metadata_id AS metadataId,
             tool, tool_fingerprint AS toolFingerprint, args_json AS argsJson,
             result_json AS resultJson, error, conclusion,
             started_at AS startedAt, finished_at AS finishedAt,
             first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt,
             superseded_at AS supersededAt, superseded_by_message_id AS supersededByMessageId
      FROM devspace_recovery_audits
      WHERE conversation_id = ? ${whereSuperseded}
      ORDER BY started_at ASC, audit_id ASC
    `).all(conversationId) as unknown as DevSpaceRecoveryAuditRow[]
  }

  /**
   * 读取某个 DevSpace audit consumer 的 durable 高水位。
   */
  getDevSpaceAuditCursor(consumerKey = 'archive-daemon'): DevSpaceAuditCursorRow | null {
    const row = this.db.prepare(`
      SELECT consumer_key AS consumerKey,
             started_at AS startedAt,
             audit_id AS auditId,
             updated_at AS updatedAt
      FROM devspace_audit_consumer_state
      WHERE consumer_key = ?
      LIMIT 1
    `).get(consumerKey) as DevSpaceAuditCursorRow | undefined
    return row ?? null
  }

  /**
   * 单调推进 durable DevSpace audit 游标。
   *
   * 网络/UDP 重复门铃、daemon overlap replay 都可能再次提交旧游标；这里在 SQLite 层保证
   * `(started_at, audit_id)` 只能前进不能后退。这样调用方无需依赖进程内去重来保证持久正确性。
   */
  advanceDevSpaceAuditCursor(input: {
    consumerKey?: string
    startedAt: string
    auditId: string
    updatedAt?: number
  }): DevSpaceAuditCursorRow {
    const consumerKey = input.consumerKey?.trim() || 'archive-daemon'
    const startedAt = input.startedAt.trim()
    const auditId = input.auditId.trim()
    if (!startedAt) throw new Error('DevSpace audit cursor startedAt must not be empty')
    if (!auditId) throw new Error('DevSpace audit cursor auditId must not be empty')
    const updatedAt = Math.max(0, Math.trunc(input.updatedAt ?? Date.now()))
    this.db.prepare(`
      INSERT INTO devspace_audit_consumer_state (
        consumer_key, started_at, audit_id, updated_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(consumer_key) DO UPDATE SET
        started_at=CASE
          WHEN excluded.started_at > devspace_audit_consumer_state.started_at
            OR (excluded.started_at = devspace_audit_consumer_state.started_at
              AND excluded.audit_id > devspace_audit_consumer_state.audit_id)
          THEN excluded.started_at ELSE devspace_audit_consumer_state.started_at END,
        audit_id=CASE
          WHEN excluded.started_at > devspace_audit_consumer_state.started_at
            OR (excluded.started_at = devspace_audit_consumer_state.started_at
              AND excluded.audit_id > devspace_audit_consumer_state.audit_id)
          THEN excluded.audit_id ELSE devspace_audit_consumer_state.audit_id END,
        updated_at=CASE
          WHEN excluded.started_at > devspace_audit_consumer_state.started_at
            OR (excluded.started_at = devspace_audit_consumer_state.started_at
              AND excluded.audit_id > devspace_audit_consumer_state.audit_id)
          THEN excluded.updated_at ELSE devspace_audit_consumer_state.updated_at END
    `).run(consumerKey, startedAt, auditId, updatedAt)
    return this.getDevSpaceAuditCursor(consumerKey)!
  }

  /**
   * daemon 可能在 audit start 已消费、finish UPDATE 尚未收到时崩溃。
   * cursor 只负责“新 audit 行”不会漏；这些尚无 finished_at 的 recovery 行需要在重启后
   * 按 audit id 再读 DevSpace SQLite 一次，补齐 result/error/finished_at。
   */
  listPendingDevSpaceRecoveryAuditIds(limit = 1000): string[] {
    return (this.db.prepare(`
      SELECT audit_id AS auditId
      FROM devspace_recovery_audits
      WHERE finished_at IS NULL
      ORDER BY started_at ASC, audit_id ASC
      LIMIT ?
    `).all(Math.max(1, Math.trunc(limit))) as Array<{ auditId: string }>).map(row => row.auditId)
  }

  /**
   * 计算 canonical turn 尾部与 DevSpace recovery audit 尾部的差异。
   * metadataId 已知时严格限定该 metadata；否则只按 conversation + 时间窗统计。
   */
  describeDevSpaceTailGap(input: {
    conversationId: string
    turnExchangeId?: string | null
    lastMessageId?: string | null
    metadataId?: string | null
    bodyCompletionEvidence?: string | null
    minGapMs?: number
    beforeAt?: number | null
  }): DevSpaceTailGapSummary {
    const conversationId = input.conversationId
    const turnExchangeId = input.turnExchangeId?.trim() || null
    const metadataId = input.metadataId?.trim() || null
    const minGapMs = Math.max(0, Math.trunc(input.minGapMs ?? 5_000))

    let canonicalTailAt: number | null = null
    if (turnExchangeId) {
      const row = this.db.prepare(`
        SELECT MAX(CAST(create_time * 1000 AS INTEGER)) AS tailAt
        FROM messages
        WHERE conversation_id = ?
          AND turn_exchange_id = ?
          AND create_time IS NOT NULL
      `).get(conversationId, turnExchangeId) as { tailAt?: number | null } | undefined
      const value = Number(row?.tailAt)
      if (Number.isFinite(value) && value > 0) canonicalTailAt = value
    }
    if (canonicalTailAt === null && input.lastMessageId) {
      const row = this.db.prepare(`
        SELECT CAST(create_time * 1000 AS INTEGER) AS tailAt
        FROM messages
        WHERE conversation_id = ? AND message_id = ? AND create_time IS NOT NULL
        LIMIT 1
      `).get(conversationId, input.lastMessageId) as { tailAt?: number | null } | undefined
      const value = Number(row?.tailAt)
      if (Number.isFinite(value) && value > 0) canonicalTailAt = value
    }

    if (canonicalTailAt === null) {
      return {
        conversationId, turnExchangeId, metadataId,
        canonicalTailAt: null, recoveryLastAt: null, gapMs: 0,
        recoveryAuditCount: 0, recoveryToolCount: 0, checkpointCount: 0,
        hasTailGap: false,
      }
    }

    const clauses = [
      'conversation_id = ?',
      'superseded_at IS NULL',
      'COALESCE(finished_at, started_at) > ?',
    ]
    const params: Array<string | number> = [conversationId, canonicalTailAt]
    if (metadataId) {
      clauses.push('metadata_id = ?')
      params.push(metadataId)
    }
    if (Number.isFinite(Number(input.beforeAt)) && Number(input.beforeAt) > canonicalTailAt) {
      clauses.push('started_at < ?')
      params.push(Math.trunc(Number(input.beforeAt)))
    }

    const row = this.db.prepare(`
      SELECT COUNT(*) AS recoveryAuditCount,
             SUM(CASE WHEN tool = 'checkpoint' THEN 1 ELSE 0 END) AS checkpointCount,
             MAX(COALESCE(finished_at, started_at)) AS recoveryLastAt
      FROM devspace_recovery_audits
      WHERE ${clauses.join(' AND ')}
    `).get(...params) as {
      recoveryAuditCount?: number | null
      checkpointCount?: number | null
      recoveryLastAt?: number | null
    } | undefined

    const recoveryAuditCount = Math.max(0, Number(row?.recoveryAuditCount || 0))
    const checkpointCount = Math.max(0, Number(row?.checkpointCount || 0))
    const recoveryToolCount = Math.max(0, recoveryAuditCount - checkpointCount)
    const rawLast = Number(row?.recoveryLastAt)
    const recoveryLastAt = Number.isFinite(rawLast) && rawLast > 0 ? rawLast : null
    const gapMs = recoveryLastAt === null ? 0 : Math.max(0, recoveryLastAt - canonicalTailAt)
    return {
      conversationId,
      turnExchangeId,
      metadataId,
      canonicalTailAt,
      recoveryLastAt,
      gapMs,
      recoveryAuditCount,
      recoveryToolCount,
      checkpointCount,
      hasTailGap: String(input.bodyCompletionEvidence || 'none') !== 'final'
        && recoveryAuditCount > 0
        && gapMs >= minGapMs,
    }
  }

  upsertIncidentEvidence(input: {
    incidentId: string
    evidenceType: string
    observedAt?: number
    evidence: unknown
  }): ArchiveIncidentEvidenceRow {
    const observedAt = Math.max(0, Math.trunc(input.observedAt ?? Date.now()))
    const evidenceJson = json(input.evidence)
    this.db.prepare(`
      INSERT INTO incident_evidence (
        incident_id, evidence_type, first_observed_at, last_observed_at, evidence_json
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(incident_id, evidence_type) DO UPDATE SET
        last_observed_at=excluded.last_observed_at,
        evidence_json=excluded.evidence_json
    `).run(input.incidentId, input.evidenceType, observedAt, observedAt, evidenceJson)
    return this.db.prepare(`
      SELECT incident_id AS incidentId, evidence_type AS evidenceType,
             first_observed_at AS firstObservedAt, last_observed_at AS lastObservedAt,
             evidence_json AS evidenceJson
      FROM incident_evidence
      WHERE incident_id = ? AND evidence_type = ?
    `).get(input.incidentId, input.evidenceType) as unknown as ArchiveIncidentEvidenceRow
  }

  listIncidentEvidence(incidentId: string): ArchiveIncidentEvidenceRow[] {
    return this.db.prepare(`
      SELECT incident_id AS incidentId, evidence_type AS evidenceType,
             first_observed_at AS firstObservedAt, last_observed_at AS lastObservedAt,
             evidence_json AS evidenceJson
      FROM incident_evidence
      WHERE incident_id = ?
      ORDER BY first_observed_at ASC, evidence_type ASC
    `).all(incidentId) as unknown as ArchiveIncidentEvidenceRow[]
  }

  /**
   * 为“已经有独立异常证据、但尚无 lifecycle 终止证据”的当前 turn 建一个通用 incident 壳。
   * 典型用途是 canonical-tail-gap：它证明 persistence/body 已落后于真实执行，但并不声称已经
   * 收到 conversation-turn-complete，也不声称 catalog 一定是 active-zombie。
   */
  ensureIncidentForEvidence(input: {
    conversationId: string
    diagnostic: RunDiagnostic
    observedAt?: number
    source: string
    reason: string
  }): ArchiveIncidentRow | null {
    const diagnostic = input.diagnostic
    if (diagnostic.bodyCompletionEvidence === 'final') return null
    const observedAt = Math.max(0, Math.trunc(input.observedAt ?? Date.now()))
    const turnKey = diagnostic.turnExchangeId
      ?? diagnostic.userMessageId
      ?? diagnostic.lastMessageId
      ?? diagnostic.currentNode
      ?? null
    if (!turnKey) return null

    const existing = this.db.prepare(`
      SELECT id, conversation_id AS conversationId, turn_exchange_id AS turnExchangeId,
             turn_key AS turnKey, incident_kind AS incidentKind, lifecycle_class AS lifecycleClass,
             detected_at AS detectedAt, last_observed_at AS lastObservedAt,
             resolved_at AS resolvedAt, status, reason,
             terminal_evidence AS bodyCompletionEvidence, tail_shape AS tailShape,
             head_state AS headState, head_rollback AS headRollbackObserved,
             off_head_same_turn_count AS offHeadSameTurnCount,
             source, diagnostic_json AS diagnosticJson
      FROM incidents
      WHERE conversation_id=? AND turn_key=?
      LIMIT 1
    `).get(input.conversationId, turnKey) as Record<string, unknown> | undefined
    if (existing) return normalizeIncidentRow(existing)

    const headRollbackObserved = diagnostic.currentNode
      ? Number((this.db.prepare(`
          SELECT count(*) AS n
          FROM conversation_head_history
          WHERE conversation_id = ? AND current_node = ?
        `).get(input.conversationId, diagnostic.currentNode) as { n: number }).n) >= 2
      : false
    const incidentId = sha256Text(`${input.conversationId}:${turnKey}`).slice(0, 24)
    this.db.prepare(`
      INSERT INTO incidents (
        id, conversation_id, turn_exchange_id, turn_key, incident_kind, lifecycle_class,
        detected_at, last_observed_at, resolved_at, status,
        reason, terminal_evidence, tail_shape,
        head_state, head_rollback, off_head_same_turn_count,
        source, diagnostic_json
      ) VALUES (?, ?, ?, ?, 'abnormal-terminal', 'abnormal-terminal', ?, ?, NULL, 'open', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      incidentId,
      input.conversationId,
      diagnostic.turnExchangeId ?? null,
      turnKey,
      observedAt,
      observedAt,
      input.reason,
      diagnostic.bodyCompletionEvidence,
      diagnostic.tailShape,
      diagnostic.headState,
      headRollbackObserved ? 1 : 0,
      diagnostic.offHeadSameTurnMessageCount,
      input.source,
      json(diagnostic),
    )
    this.db.prepare(`
      UPDATE conversations
      SET incident_state='open', last_monitor_checked_at=?
      WHERE id=?
    `).run(observedAt, input.conversationId)
    const created = this.db.prepare(`
      SELECT id, conversation_id AS conversationId, turn_exchange_id AS turnExchangeId,
             turn_key AS turnKey, incident_kind AS incidentKind, lifecycle_class AS lifecycleClass,
             detected_at AS detectedAt, last_observed_at AS lastObservedAt,
             resolved_at AS resolvedAt, status, reason,
             terminal_evidence AS bodyCompletionEvidence, tail_shape AS tailShape,
             head_state AS headState, head_rollback AS headRollbackObserved,
             off_head_same_turn_count AS offHeadSameTurnCount,
             source, diagnostic_json AS diagnosticJson
      FROM incidents WHERE id=?
    `).get(incidentId) as Record<string, unknown>
    return normalizeIncidentRow(created)
  }

  /**
   * 将当前 turn 的 canonical-tail-gap 证据附着到已有 incident。
   * 如果当前 turn 尚无 incident，只返回 gap 摘要；是否立案由 daemon 的 5 分钟诊断语义决定。
   */
  attachCanonicalTailGapEvidence(input: {
    conversationId: string
    turnExchangeId?: string | null
    turnKey?: string | null
    lastMessageId?: string | null
    metadataId?: string | null
    bodyCompletionEvidence?: string | null
    observedAt?: number
    beforeAt?: number | null
  }): { summary: DevSpaceTailGapSummary, incidentId: string | null } {
    const summary = this.describeDevSpaceTailGap(input)
    if (!summary.hasTailGap) return { summary, incidentId: null }
    const turnKey = input.turnKey?.trim() || input.turnExchangeId?.trim() || input.lastMessageId?.trim() || null
    if (!turnKey) return { summary, incidentId: null }
    const incident = this.db.prepare(`
      SELECT id FROM incidents
      WHERE conversation_id = ? AND turn_key = ?
      LIMIT 1
    `).get(input.conversationId, turnKey) as { id?: string } | undefined
    if (!incident?.id) return { summary, incidentId: null }
    this.upsertIncidentEvidence({
      incidentId: incident.id,
      evidenceType: 'canonical-tail-gap',
      observedAt: input.observedAt,
      evidence: summary,
    })
    return { summary, incidentId: incident.id }
  }

  /** 历史回填：只看 incident 对应 turn 的 canonical tail 到下一条 user 之前的 recovery audit。 */
  backfillCanonicalTailGapEvidence(minGapMs = 5_000, observedAt = Date.now()): number {
    const incidents = this.db.prepare(`
      SELECT id, conversation_id AS conversationId,
             turn_exchange_id AS turnExchangeId, turn_key AS turnKey,
             terminal_evidence AS bodyCompletionEvidence
      FROM incidents
    `).all() as unknown as Array<{
      id: string
      conversationId: string
      turnExchangeId: string | null
      turnKey: string
      bodyCompletionEvidence: string
    }>
    let changed = 0
    for (const incident of incidents) {
      if (incident.bodyCompletionEvidence === 'final') continue
      const tailRow = incident.turnExchangeId
        ? this.db.prepare(`
            SELECT MAX(create_time) AS tailSec
            FROM messages WHERE conversation_id=? AND turn_exchange_id=? AND create_time IS NOT NULL
          `).get(incident.conversationId, incident.turnExchangeId) as { tailSec?: number | null } | undefined
        : this.db.prepare(`
            SELECT create_time AS tailSec
            FROM messages WHERE conversation_id=? AND message_id=? AND create_time IS NOT NULL LIMIT 1
          `).get(incident.conversationId, incident.turnKey) as { tailSec?: number | null } | undefined
      const tailSec = Number(tailRow?.tailSec)
      if (!Number.isFinite(tailSec) || tailSec <= 0) continue
      const nextUser = this.db.prepare(`
        SELECT MIN(create_time) AS nextUserSec
        FROM messages
        WHERE conversation_id=? AND role='user' AND create_time>?
      `).get(incident.conversationId, tailSec + 0.001) as { nextUserSec?: number | null } | undefined
      const nextUserSec = Number(nextUser?.nextUserSec)
      const beforeAt = Number.isFinite(nextUserSec) && nextUserSec > 0
        ? Math.trunc(nextUserSec * 1000)
        : null
      const summary = this.describeDevSpaceTailGap({
        conversationId: incident.conversationId,
        turnExchangeId: incident.turnExchangeId,
        lastMessageId: incident.turnExchangeId ? null : incident.turnKey,
        bodyCompletionEvidence: incident.bodyCompletionEvidence,
        minGapMs,
        beforeAt,
      })
      if (!summary.hasTailGap) continue
      this.upsertIncidentEvidence({
        incidentId: incident.id,
        evidenceType: 'canonical-tail-gap',
        observedAt,
        evidence: { ...summary, historicalBackfill: true, beforeAt },
      })
      changed += 1
    }
    return changed
  }

  /**
   * metadata 从 synthetic provisional conversation 绑定到真实 CID 时原位迁移 recovery 事实。
   * 不复制、不删除 audit；forensic identity 仍由 audit_id + metadata_id 保持稳定。
   */
  rebindDevSpaceRecoveryAudits(metadataId: string, conversationId: string): number {
    const result = this.db.prepare(`
      UPDATE devspace_recovery_audits
      SET conversation_id = ?
      WHERE metadata_id = ? AND conversation_id <> ?
    `).run(conversationId, metadataId, conversationId)
    return Number(result.changes)
  }

  /**
   * Reader/Bridge 专用的 provisional conversation 列表。
   * canonical `conversations` 表完全不插 synthetic 行；这里只把未绑定 metadata + active recovery
   * 动态投影成可浏览的虚拟会话。
   */
  listDevSpaceRecoveryVirtualConversations(limit = 100): ArchiveConversationRow[] {
    const bindings = this.listDevSpaceMetadataBindings({ onlyUnbound: true, limit: Math.max(1, Math.trunc(limit)) })
    const rows: ArchiveConversationRow[] = []
    for (const binding of bindings) {
      const id = devSpaceVirtualConversationId(binding.metadataId)
      const recoveryMessages = this.getDevSpaceRecoveryMessages(id)
      if (recoveryMessages.length === 0) continue
      rows.push({
        id,
        title: binding.displayTitle?.trim() || shortDevSpaceMetadataAlias(binding.metadataId),
        sourceFormat: 'devspace-provisional',
        currentNode: null,
        capturedAt: binding.lastSeenAt,
        importedAt: binding.lastSeenAt,
        messageCount: recoveryMessages.length,
        resourceCount: 0,
        bodyCompletionState: null,
        incidentState: null,
        lastFinishType: null,
        lastFinishReason: null,
        lastReasoningStatus: null,
        provisional: true,
        metadataId: binding.metadataId,
        provisionalState: recoveryMessages.some(message => message.status === 'running') ? 'running' : 'idle',
      })
    }
    return rows
  }

  /**
   * canonical body 已出现相同 tool+args 时，淘汰最近的一个 provisional audit。
   * 时间窗与 binding exact matcher 保持同量级，避免同一命令在很久以后重复执行时误匹配。
   */
  supersedeDevSpaceRecoveryAudit(input: {
    conversationId: string
    toolFingerprint: string
    canonicalStartedAt: number
    canonicalMessageId: string
    observedAt?: number
    toleranceMs?: number
  }): string | null {
    const toleranceMs = Math.max(0, Math.trunc(input.toleranceMs ?? 120_000))
    const startedAt = Math.max(0, Math.trunc(input.canonicalStartedAt))
    const candidate = this.db.prepare(`
      SELECT audit_id AS auditId
      FROM devspace_recovery_audits
      WHERE conversation_id = ?
        AND tool_fingerprint = ?
        AND superseded_at IS NULL
        AND started_at BETWEEN ? AND ?
      ORDER BY abs(started_at - ?) ASC, started_at ASC, audit_id ASC
      LIMIT 1
    `).get(
      input.conversationId,
      input.toolFingerprint,
      Math.max(0, startedAt - toleranceMs),
      startedAt + toleranceMs,
      startedAt,
    ) as { auditId?: string } | undefined
    if (!candidate?.auditId) return null
    this.db.prepare(`
      UPDATE devspace_recovery_audits
      SET superseded_at = COALESCE(superseded_at, ?),
          superseded_by_message_id = COALESCE(superseded_by_message_id, ?)
      WHERE audit_id = ?
    `).run(
      Math.max(0, Math.trunc(input.observedAt ?? Date.now())),
      input.canonicalMessageId,
      candidate.auditId,
    )
    return candidate.auditId
  }

  /**
   * checkpoint 的 provisional assistant 节点不应仅因为 canonical tool-call 到达就消失。
   * 只有 canonical assistant commentary 明确复述完整 summary，且时间足够接近时才视为覆盖。
   * 这里使用“完整 summary 是 assistant 文本子串”的高置信规则，不做向量/模糊语义猜测。
   */
  supersedeDevSpaceCheckpointFromAssistant(input: {
    conversationId: string
    assistantText: string
    assistantStartedAt: number
    canonicalMessageId: string
    observedAt?: number
    toleranceMs?: number
  }): string | null {
    const assistantText = input.assistantText.trim().replace(/\s+/gu, ' ')
    if (!assistantText) return null
    const toleranceMs = Math.max(0, Math.trunc(input.toleranceMs ?? 120_000))
    const startedAt = Math.max(0, Math.trunc(input.assistantStartedAt))
    const candidates = this.db.prepare(`
      SELECT audit_id AS auditId, args_json AS argsJson, started_at AS startedAt
      FROM devspace_recovery_audits
      WHERE conversation_id = ?
        AND tool = 'checkpoint'
        AND superseded_at IS NULL
        AND started_at BETWEEN ? AND ?
      ORDER BY abs(started_at - ?) ASC, started_at ASC, audit_id ASC
    `).all(
      input.conversationId,
      Math.max(0, startedAt - toleranceMs),
      startedAt + toleranceMs,
      startedAt,
    ) as Array<{ auditId: string, argsJson: string, startedAt: number }>
    for (const candidate of candidates) {
      let summary = ''
      try {
        const parsed = JSON.parse(candidate.argsJson) as Record<string, unknown>
        summary = typeof parsed.summary === 'string' ? parsed.summary.trim().replace(/\s+/gu, ' ') : ''
      }
      catch {
        summary = ''
      }
      if (summary.length < 8 || !assistantText.includes(summary)) continue
      this.db.prepare(`
        UPDATE devspace_recovery_audits
        SET superseded_at = COALESCE(superseded_at, ?),
            superseded_by_message_id = COALESCE(superseded_by_message_id, ?)
        WHERE audit_id = ?
      `).run(
        Math.max(0, Math.trunc(input.observedAt ?? Date.now())),
        input.canonicalMessageId,
        candidate.auditId,
      )
      return candidate.auditId
    }
    return null
  }

  /**
   * 给 Reader/Bridge 生成可见的 provisional message overlay。
   * canonical `messages` 表完全不变；这里仅把 audit 映射成 UI 友好的三类节点。
   */
  getDevSpaceRecoveryMessages(conversationId: string): Array<Record<string, unknown>> {
    const audits = this.listDevSpaceRecoveryAudits(conversationId, false)
    if (audits.length === 0) return []
    const canonicalMax = this.db.prepare(
      'SELECT COALESCE(MAX(ordinal), -1) AS maxOrdinal FROM messages WHERE conversation_id = ?',
    ).get(conversationId) as { maxOrdinal?: number } | undefined
    let ordinal = Number(canonicalMax?.maxOrdinal ?? -1) + 1
    const rows: Array<Record<string, unknown>> = []

    const resultText = (audit: DevSpaceRecoveryAuditRow): string => {
      if (audit.error) return audit.error
      if (!audit.resultJson) return ''
      try {
        const parsed = JSON.parse(audit.resultJson) as Record<string, unknown>
        const structured = parsed.structuredContent as Record<string, unknown> | undefined
        if (typeof structured?.result === 'string') return structured.result
        const content = Array.isArray(parsed.content) ? parsed.content : []
        const firstText = content.find(item => item && typeof item === 'object' && typeof (item as Record<string, unknown>).text === 'string') as Record<string, unknown> | undefined
        if (typeof firstText?.text === 'string') return firstText.text
        return audit.resultJson
      }
      catch {
        return audit.resultJson
      }
    }

    for (const audit of audits) {
      const base = {
        provisional: true,
        recoverySource: 'devspace-audit',
        auditId: audit.auditId,
        metadataId: audit.metadataId,
        superseded: false,
      }

      if (audit.tool === 'checkpoint') {
        try {
          const parsed = JSON.parse(audit.argsJson) as Record<string, unknown>
          const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : ''
          const next = typeof parsed.next === 'string' ? parsed.next.trim() : ''
          if (summary) {
            rows.push({
              ...base,
              recoverySource: 'devspace-checkpoint',
              messageId: `devspace-recovery:${audit.auditId}:checkpoint`,
              ordinal: ordinal++,
              role: 'assistant',
              authorName: 'DevSpace Checkpoint',
              recipient: 'all',
              channel: 'commentary',
              contentType: 'text',
              text: next ? `${summary}\n\n下一阶段：${next}` : summary,
              hidden: 0,
              createTime: audit.startedAt / 1000,
              status: 'provisional',
              endTurn: false,
              recoveryKind: 'assistant-checkpoint',
            })
            continue
          }
        }
        catch {
          // malformed checkpoint 仍按普通 tool audit 展示，避免 recovery 数据静默丢失。
        }
      }
      if (audit.conclusion) {
        rows.push({
          ...base,
          messageId: `devspace-recovery:${audit.auditId}:conclusion`,
          ordinal: ordinal++,
          role: 'assistant',
          authorName: 'DevSpace Recover',
          recipient: 'all',
          channel: 'commentary',
          contentType: 'text',
          text: audit.conclusion,
          hidden: 0,
          createTime: audit.startedAt / 1000,
          status: 'provisional',
          endTurn: false,
          recoveryKind: 'assistant-conclusion',
        })
      }

      let parsedArgs: unknown = {}
      try { parsedArgs = JSON.parse(audit.argsJson) }
      catch { parsedArgs = audit.argsJson }
      rows.push({
        ...base,
        messageId: `devspace-recovery:${audit.auditId}:call`,
        ordinal: ordinal++,
        role: 'assistant',
        authorName: 'DevSpace Recover',
        recipient: 'api_tool.call_tool',
        channel: 'commentary',
        contentType: 'code',
        text: JSON.stringify({
          path: `/devspace/recovery/${audit.tool}`,
          args: parsedArgs,
        }),
        hidden: 0,
        createTime: audit.startedAt / 1000,
        status: audit.finishedAt ? 'finished' : 'running',
        endTurn: false,
        recoveryKind: 'tool-call',
        tool: audit.tool,
      })

      if (audit.finishedAt !== null) {
        rows.push({
          ...base,
          messageId: `devspace-recovery:${audit.auditId}:result`,
          ordinal: ordinal++,
          role: 'tool',
          authorName: audit.tool,
          recipient: 'all',
          channel: 'commentary',
          contentType: 'text',
          text: resultText(audit),
          hidden: 0,
          createTime: audit.finishedAt / 1000,
          status: audit.error ? 'error' : 'finished',
          endTurn: false,
          recoveryKind: 'tool-result',
          tool: audit.tool,
        })
      }
    }
    return rows
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
             display_title AS displayTitle,
             first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt,
             bound_at AS boundAt, last_verified_at AS lastVerifiedAt,
             evidence, confidence,
             last_turn_exchange_id AS lastTurnExchangeId,
             last_request_id AS lastRequestId,
             last_audit_id AS lastAuditId, last_audit_at AS lastAuditAt,
             unbound_watchdog_at AS unboundWatchdogAt,
             lifecycle_state AS lifecycleState
      FROM devspace_metadata_bindings
      ${where}
      ORDER BY last_seen_at DESC
      LIMIT ?
    `).all(...params) as unknown as DevSpaceMetadataBindingRow[]
  }

  /** Archive 负责推断；一旦绑定，后续 observe 不再把 lifecycle 打回 unbound。 */
  upsertDevSpaceBindingTurnEvidence(input: {
    conversationId: string
    turnExchangeId: string
    firstToolAt: number
    lastToolAt: number
    toolCallCount: number
    evidenceRevision: string
    observedAt: number
  }): { row: DevSpaceBindingTurnEvidenceRow, changed: boolean, created: boolean } {
    const existing = this.getDevSpaceBindingTurnEvidence(input.conversationId, input.turnExchangeId)
    const firstToolAt = Math.max(0, Math.trunc(input.firstToolAt))
    const lastToolAt = Math.max(firstToolAt, Math.trunc(input.lastToolAt))
    const toolCallCount = Math.max(1, Math.trunc(input.toolCallCount))
    const observedAt = Math.max(0, Math.trunc(input.observedAt))
    const evidenceRevision = input.evidenceRevision.trim()
    const changed = !existing
      || existing.evidenceRevision !== evidenceRevision
      || existing.firstToolAt !== firstToolAt
      || existing.lastToolAt !== lastToolAt
      || existing.toolCallCount !== toolCallCount
    this.db.prepare(`
      INSERT INTO devspace_binding_turn_evidence (
        conversation_id, turn_exchange_id,
        first_tool_at, last_tool_at, tool_call_count, evidence_revision,
        status, matched_metadata_id,
        first_queued_at, last_queued_at, last_attempt_at, attempt_count
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, NULL, 0)
      ON CONFLICT(conversation_id, turn_exchange_id) DO UPDATE SET
        last_queued_at=CASE
          WHEN devspace_binding_turn_evidence.evidence_revision <> excluded.evidence_revision
            OR devspace_binding_turn_evidence.first_tool_at <> excluded.first_tool_at
            OR devspace_binding_turn_evidence.last_tool_at <> excluded.last_tool_at
            OR devspace_binding_turn_evidence.tool_call_count <> excluded.tool_call_count
          THEN max(devspace_binding_turn_evidence.last_queued_at, excluded.last_queued_at)
          ELSE devspace_binding_turn_evidence.last_queued_at
        END,
        first_tool_at=excluded.first_tool_at,
        last_tool_at=excluded.last_tool_at,
        tool_call_count=excluded.tool_call_count,
        evidence_revision=excluded.evidence_revision
    `).run(
      input.conversationId,
      input.turnExchangeId,
      firstToolAt,
      lastToolAt,
      toolCallCount,
      evidenceRevision,
      observedAt,
      observedAt,
    )
    return {
      row: this.getDevSpaceBindingTurnEvidence(input.conversationId, input.turnExchangeId)!,
      changed,
      created: !existing,
    }
  }

  readDevSpaceTurnToolCallRows(
    conversationId: string,
    turnExchangeId: string,
  ): DevSpaceTurnToolCallRow[] {
    return this.db.prepare(`
      SELECT create_time AS createTime, request_id AS requestId, text
      FROM messages INDEXED BY messages_tool_turn_time
      WHERE conversation_id=? AND turn_exchange_id=?
        AND recipient='api_tool.call_tool'
        AND create_time IS NOT NULL
        AND text<>''
      ORDER BY create_time ASC
    `).all(conversationId, turnExchangeId) as unknown as DevSpaceTurnToolCallRow[]
  }

  getDevSpaceBindingTurnEvidence(
    conversationId: string,
    turnExchangeId: string,
  ): DevSpaceBindingTurnEvidenceRow | null {
    const row = this.db.prepare(`
      SELECT conversation_id AS conversationId,
             turn_exchange_id AS turnExchangeId,
             first_tool_at AS firstToolAt,
             last_tool_at AS lastToolAt,
             tool_call_count AS toolCallCount,
             evidence_revision AS evidenceRevision,
             status,
             matched_metadata_id AS matchedMetadataId,
             first_queued_at AS firstQueuedAt,
             last_queued_at AS lastQueuedAt,
             last_attempt_at AS lastAttemptAt,
             attempt_count AS attemptCount,
             last_attempt_evidence_revision AS lastAttemptEvidenceRevision,
             last_attempt_metadata_revision AS lastAttemptMetadataRevision
      FROM devspace_binding_turn_evidence
      WHERE conversation_id=? AND turn_exchange_id=?
    `).get(conversationId, turnExchangeId) as DevSpaceBindingTurnEvidenceRow | undefined
    return row ?? null
  }

  listPendingDevSpaceBindingTurnEvidence(input: {
    overlapStartAt?: number
    overlapEndAt?: number
    includeMatched?: boolean
    limit?: number
  } = {}): DevSpaceBindingTurnEvidenceRow[] {
    // 默认契约仍然是“pending only”，避免启动恢复把所有历史 matched turn 重扫一遍。
    // 只有新 audit 到达、需要检查 rotation/steering 新成员时，调用方显式 includeMatched。
    const clauses = [input.includeMatched ? `status IN ('pending', 'matched')` : `status='pending'`]
    const params: Array<string | number> = []
    if (input.overlapStartAt !== undefined && input.overlapEndAt !== undefined) {
      const startAt = Math.max(0, Math.trunc(input.overlapStartAt))
      const endAt = Math.max(startAt, Math.trunc(input.overlapEndAt))
      clauses.push('first_tool_at <= ?')
      clauses.push('last_tool_at >= ?')
      params.push(endAt, startAt)
    }
    params.push(Math.max(1, Math.min(10_000, Math.trunc(input.limit ?? 1000))))
    const where = clauses.join(' AND ')
    return this.db.prepare(`
      SELECT conversation_id AS conversationId,
             turn_exchange_id AS turnExchangeId,
             first_tool_at AS firstToolAt,
             last_tool_at AS lastToolAt,
             tool_call_count AS toolCallCount,
             evidence_revision AS evidenceRevision,
             status,
             matched_metadata_id AS matchedMetadataId,
             first_queued_at AS firstQueuedAt,
             last_queued_at AS lastQueuedAt,
             last_attempt_at AS lastAttemptAt,
             attempt_count AS attemptCount,
             last_attempt_evidence_revision AS lastAttemptEvidenceRevision,
             last_attempt_metadata_revision AS lastAttemptMetadataRevision
      FROM devspace_binding_turn_evidence
      WHERE ${where}
      ORDER BY last_queued_at DESC
      LIMIT ?
    `).all(...params) as unknown as DevSpaceBindingTurnEvidenceRow[]
  }

  /**
   * 启动历史修复专用：只挑已经有 canonical metadata match、但关联 trace 仍 provisional 的 turn。
   *
   * 旧 schema 曾经把 trace 的第二 metadata 丢掉，而且 trace verifier 还因为性能裁剪拿不到
   * trace-id；v8/v12 升级后只需要把这小批历史 matched evidence 再走一次现有 exact matcher。
   * 时间 overlap 仍沿用正式 matcher 的 ±120s 边界，避免把同一 metadata 跨 turn 复用误连。
   */
  listDevSpaceMatchedEvidenceForProvisionalTraces(limit = 1000): DevSpaceBindingTurnEvidenceRow[] {
    return this.db.prepare(`
      SELECT DISTINCT
             e.conversation_id AS conversationId,
             e.turn_exchange_id AS turnExchangeId,
             e.first_tool_at AS firstToolAt,
             e.last_tool_at AS lastToolAt,
             e.tool_call_count AS toolCallCount,
             e.evidence_revision AS evidenceRevision,
             e.status AS status,
             e.matched_metadata_id AS matchedMetadataId,
             e.first_queued_at AS firstQueuedAt,
             e.last_queued_at AS lastQueuedAt,
             e.last_attempt_at AS lastAttemptAt,
             e.attempt_count AS attemptCount,
             e.last_attempt_evidence_revision AS lastAttemptEvidenceRevision,
             e.last_attempt_metadata_revision AS lastAttemptMetadataRevision
      FROM devspace_binding_turn_evidence e
      JOIN devspace_trace_metadata_members m
        ON m.metadata_id=e.matched_metadata_id
      JOIN devspace_trace_turn_bindings t
        ON t.trace_id=m.trace_id
       AND t.status='provisional'
      WHERE e.status='matched'
        AND e.matched_metadata_id IS NOT NULL
        AND e.last_tool_at >= t.first_seen_at - 120000
        AND e.first_tool_at <= t.last_seen_at + 120000
      ORDER BY e.last_tool_at DESC
      LIMIT ?
    `).all(Math.max(1, Math.min(10_000, Math.trunc(limit)))) as unknown as DevSpaceBindingTurnEvidenceRow[]
  }

  markDevSpaceBindingTurnEvidenceAttempt(
    conversationId: string,
    turnExchangeId: string,
    attemptedAt: number,
    evidenceRevision: string,
    metadataRevision: string,
  ): void {
    this.db.prepare(`
      UPDATE devspace_binding_turn_evidence
      SET last_attempt_at=?,
          attempt_count=attempt_count+1,
          last_attempt_evidence_revision=?,
          last_attempt_metadata_revision=?
      WHERE conversation_id=? AND turn_exchange_id=?
    `).run(
      Math.max(0, Math.trunc(attemptedAt)),
      evidenceRevision,
      metadataRevision,
      conversationId,
      turnExchangeId,
    )
  }

  markDevSpaceBindingTurnEvidenceMatched(input: {
    conversationId: string
    turnExchangeId: string
    metadataId: string
    matchedAt: number
    evidenceRevision: string
    metadataRevision: string
  }): void {
    this.db.prepare(`
      UPDATE devspace_binding_turn_evidence
      SET status='matched',
          matched_metadata_id=?,
          last_attempt_at=?,
          attempt_count=attempt_count+1,
          last_attempt_evidence_revision=?,
          last_attempt_metadata_revision=?
      WHERE conversation_id=? AND turn_exchange_id=?
    `).run(
      input.metadataId,
      Math.max(0, Math.trunc(input.matchedAt)),
      input.evidenceRevision,
      input.metadataRevision,
      input.conversationId,
      input.turnExchangeId,
    )
  }

  observeDevSpaceTraceTurn(input: {
    traceId: string
    metadataId: string
    auditId: string
    observedAt: number
  }): DevSpaceTraceTurnBindingRow {
    const traceId = input.traceId.trim().toLowerCase()
    const metadataId = input.metadataId.trim()
    const auditId = input.auditId.trim()
    const observedAt = Math.max(0, Math.trunc(input.observedAt))
    const row = this.db.prepare(`
      INSERT INTO devspace_trace_turn_bindings (
        trace_id, metadata_id,
        first_seen_at, last_seen_at,
        first_audit_id, last_audit_id,
        status
      ) VALUES (?, ?, ?, ?, ?, ?, 'provisional')
      ON CONFLICT(trace_id) DO UPDATE SET
        last_seen_at=max(devspace_trace_turn_bindings.last_seen_at, excluded.last_seen_at),
        last_audit_id=CASE
          WHEN excluded.last_seen_at >= devspace_trace_turn_bindings.last_seen_at
          THEN excluded.last_audit_id
          ELSE devspace_trace_turn_bindings.last_audit_id
        END
      RETURNING trace_id AS traceId, metadata_id AS metadataId,
                first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt,
                first_audit_id AS firstAuditId, last_audit_id AS lastAuditId,
                conversation_id AS conversationId,
                turn_exchange_id AS turnExchangeId,
                request_id AS requestId,
                status,
                verified_at AS verifiedAt,
                conflict_reason AS conflictReason
    `).get(traceId, metadataId, observedAt, observedAt, auditId, auditId) as DevSpaceTraceTurnBindingRow | undefined
    if (!row) throw new Error(`DevSpace trace observation failed: ${traceId}`)

    // metadata 是 trace 的成员，而不是 trace identity。本表允许同一个 metadata 后续出现在
    // 另一个 trace；主键只约束同一 trace 内同一 metadata 不重复。
    this.db.prepare(`
      INSERT INTO devspace_trace_metadata_members (
        trace_id, metadata_id,
        first_seen_at, last_seen_at,
        first_audit_id, last_audit_id
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(trace_id, metadata_id) DO UPDATE SET
        last_seen_at=max(devspace_trace_metadata_members.last_seen_at, excluded.last_seen_at),
        last_audit_id=CASE
          WHEN excluded.last_seen_at >= devspace_trace_metadata_members.last_seen_at
          THEN excluded.last_audit_id
          ELSE devspace_trace_metadata_members.last_audit_id
        END
    `).run(traceId, metadataId, observedAt, observedAt, auditId, auditId)
    return row
  }

  /**
   * 把 DevSpace v12 从 raw tool_audit 物化出的历史 trace↔metadata member 无损补进 Archive。
   *
   * 这是 migration/backfill API，不改变 canonical status/CID/TID/RID；只修正 trace 与 member 的
   * 首末时间/audit 边界。这样 DevSpace 仍是 raw execution facts 的事实源，Archive 不需要猜。
   */
  backfillDevSpaceTraceMetadataMember(input: {
    traceId: string
    metadataId: string
    firstSeenAt: number
    lastSeenAt: number
    firstAuditId: string
    lastAuditId: string
  }): { created: boolean, changed: boolean } {
    const traceId = input.traceId.trim().toLowerCase()
    const metadataId = input.metadataId.trim()
    const firstSeenAt = Math.max(0, Math.trunc(input.firstSeenAt))
    const lastSeenAt = Math.max(firstSeenAt, Math.trunc(input.lastSeenAt))
    const firstAuditId = input.firstAuditId.trim()
    const lastAuditId = input.lastAuditId.trim()
    const before = this.db.prepare(`
      SELECT first_seen_at AS firstSeenAt,
             last_seen_at AS lastSeenAt,
             first_audit_id AS firstAuditId,
             last_audit_id AS lastAuditId
      FROM devspace_trace_metadata_members
      WHERE trace_id=? AND metadata_id=?
    `).get(traceId, metadataId) as {
      firstSeenAt: number
      lastSeenAt: number
      firstAuditId: string
      lastAuditId: string
    } | undefined

    this.db.prepare(`
      INSERT INTO devspace_trace_turn_bindings (
        trace_id, metadata_id,
        first_seen_at, last_seen_at,
        first_audit_id, last_audit_id,
        status
      ) VALUES (?, ?, ?, ?, ?, ?, 'provisional')
      ON CONFLICT(trace_id) DO UPDATE SET
        first_seen_at=min(devspace_trace_turn_bindings.first_seen_at, excluded.first_seen_at),
        first_audit_id=CASE
          WHEN excluded.first_seen_at < devspace_trace_turn_bindings.first_seen_at
          THEN excluded.first_audit_id
          ELSE devspace_trace_turn_bindings.first_audit_id
        END,
        last_seen_at=max(devspace_trace_turn_bindings.last_seen_at, excluded.last_seen_at),
        last_audit_id=CASE
          WHEN excluded.last_seen_at >= devspace_trace_turn_bindings.last_seen_at
          THEN excluded.last_audit_id
          ELSE devspace_trace_turn_bindings.last_audit_id
        END
    `).run(traceId, metadataId, firstSeenAt, lastSeenAt, firstAuditId, lastAuditId)

    this.db.prepare(`
      INSERT INTO devspace_trace_metadata_members (
        trace_id, metadata_id,
        first_seen_at, last_seen_at,
        first_audit_id, last_audit_id
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(trace_id, metadata_id) DO UPDATE SET
        first_seen_at=min(devspace_trace_metadata_members.first_seen_at, excluded.first_seen_at),
        first_audit_id=CASE
          WHEN excluded.first_seen_at < devspace_trace_metadata_members.first_seen_at
          THEN excluded.first_audit_id
          ELSE devspace_trace_metadata_members.first_audit_id
        END,
        last_seen_at=max(devspace_trace_metadata_members.last_seen_at, excluded.last_seen_at),
        last_audit_id=CASE
          WHEN excluded.last_seen_at >= devspace_trace_metadata_members.last_seen_at
          THEN excluded.last_audit_id
          ELSE devspace_trace_metadata_members.last_audit_id
        END
    `).run(traceId, metadataId, firstSeenAt, lastSeenAt, firstAuditId, lastAuditId)

    const after = this.db.prepare(`
      SELECT first_seen_at AS firstSeenAt,
             last_seen_at AS lastSeenAt,
             first_audit_id AS firstAuditId,
             last_audit_id AS lastAuditId
      FROM devspace_trace_metadata_members
      WHERE trace_id=? AND metadata_id=?
    `).get(traceId, metadataId) as {
      firstSeenAt: number
      lastSeenAt: number
      firstAuditId: string
      lastAuditId: string
    }
    const changed = !before
      || before.firstSeenAt !== after.firstSeenAt
      || before.lastSeenAt !== after.lastSeenAt
      || before.firstAuditId !== after.firstAuditId
      || before.lastAuditId !== after.lastAuditId
    return { created: !before, changed }
  }

  verifyDevSpaceTraceTurn(input: {
    traceId: string
    metadataId: string
    conversationId: string
    turnExchangeId: string
    requestId?: string | null
    verifiedAt: number
  }): DevSpaceTraceTurnBindingRow | null {
    const traceId = input.traceId.trim().toLowerCase()
    const metadataId = input.metadataId.trim()
    const conversationId = input.conversationId.trim()
    const turnExchangeId = input.turnExchangeId.trim()
    const requestId = input.requestId?.trim() || null
    const verifiedAt = Math.max(0, Math.trunc(input.verifiedAt))
    const existing = this.getDevSpaceTraceTurnByTrace(traceId)
    if (!existing) return null

    // verify 可能由 trace 的第二个 metadata 成员触发。metadata 不同本身绝不是冲突；
    // observe 阶段已经把每个 raw metadata 原样登记到成员表中。
    void metadataId
    if (existing.status === 'conflict') return existing
    if (existing.status === 'verified'
      && (existing.conversationId !== conversationId || existing.turnExchangeId !== turnExchangeId)) {
      this.db.prepare(`
        UPDATE devspace_trace_turn_bindings
        SET status='conflict', conflict_reason=?
        WHERE trace_id=?
      `).run(
        `trace-remap:${existing.conversationId}:${existing.turnExchangeId}:${conversationId}:${turnExchangeId}`,
        traceId,
      )
      return this.getDevSpaceTraceTurnByTrace(traceId)
    }

    if (existing.status === 'verified'
      && existing.requestId
      && requestId
      && existing.requestId !== requestId) {
      this.db.prepare(`
        UPDATE devspace_trace_turn_bindings
        SET status='conflict', conflict_reason=?
        WHERE trace_id=?
      `).run(`request-remap:${existing.requestId}:${requestId}`, traceId)
      return this.getDevSpaceTraceTurnByTrace(traceId)
    }

    // 当前 190/190 可验证样本中 request_id↔trace_id 双向一一。把它作为强 observational
    // invariant 做冲突检测，但不再错误要求 Turn Exchange↔trace 一一；steering 正常允许
    // 同一 turn_exchange_id 下出现多个 request/trace。
    const otherRequestTrace = requestId
      ? this.db.prepare(`
          SELECT trace_id AS traceId
          FROM devspace_trace_turn_bindings
          WHERE request_id=? AND status='verified' AND trace_id<>?
          LIMIT 1
        `).get(requestId, traceId) as { traceId?: string } | undefined
      : undefined
    if (otherRequestTrace?.traceId) {
      const reason = `request-trace-remap:${requestId}:${otherRequestTrace.traceId}:${traceId}`
      this.db.prepare(`
        UPDATE devspace_trace_turn_bindings
        SET status='conflict', conflict_reason=?
        WHERE trace_id IN (?, ?)
      `).run(reason, otherRequestTrace.traceId, traceId)
      return this.getDevSpaceTraceTurnByTrace(traceId)
    }

    this.db.prepare(`
      UPDATE devspace_trace_turn_bindings
      SET conversation_id=?,
          turn_exchange_id=?,
          request_id=COALESCE(?, request_id),
          status='verified',
          verified_at=?,
          conflict_reason=NULL
      WHERE trace_id=?
    `).run(conversationId, turnExchangeId, requestId, verifiedAt, traceId)
    return this.getDevSpaceTraceTurnByTrace(traceId)
  }

  getDevSpaceTraceTurnByTrace(traceId: string): DevSpaceTraceTurnBindingRow | null {
    const row = this.db.prepare(`
      SELECT trace_id AS traceId, metadata_id AS metadataId,
             first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt,
             first_audit_id AS firstAuditId, last_audit_id AS lastAuditId,
             conversation_id AS conversationId,
             turn_exchange_id AS turnExchangeId,
             request_id AS requestId,
             status,
             verified_at AS verifiedAt,
             conflict_reason AS conflictReason
      FROM devspace_trace_turn_bindings
      WHERE trace_id=?
    `).get(traceId.trim().toLowerCase()) as DevSpaceTraceTurnBindingRow | undefined
    return row ?? null
  }

  getDevSpaceTraceTurnByTurn(
    conversationId: string,
    turnExchangeId: string,
  ): DevSpaceTraceTurnBindingRow | null {
    const row = this.db.prepare(`
      SELECT trace_id AS traceId, metadata_id AS metadataId,
             first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt,
             first_audit_id AS firstAuditId, last_audit_id AS lastAuditId,
             conversation_id AS conversationId,
             turn_exchange_id AS turnExchangeId,
             request_id AS requestId,
             status,
             verified_at AS verifiedAt,
             conflict_reason AS conflictReason
      FROM devspace_trace_turn_bindings
      WHERE conversation_id=? AND turn_exchange_id=?
      ORDER BY CASE status WHEN 'verified' THEN 0 WHEN 'provisional' THEN 1 ELSE 2 END,
               last_seen_at DESC
      LIMIT 1
    `).get(conversationId, turnExchangeId) as DevSpaceTraceTurnBindingRow | undefined
    return row ?? null
  }

  /** 同一 Turn Exchange 在 steering 时可以有多个 request/trace，因此提供完整列表。 */
  listDevSpaceTraceTurnsByTurn(
    conversationId: string,
    turnExchangeId: string,
  ): DevSpaceTraceTurnBindingRow[] {
    return this.db.prepare(`
      SELECT trace_id AS traceId, metadata_id AS metadataId,
             first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt,
             first_audit_id AS firstAuditId, last_audit_id AS lastAuditId,
             conversation_id AS conversationId,
             turn_exchange_id AS turnExchangeId,
             request_id AS requestId,
             status,
             verified_at AS verifiedAt,
             conflict_reason AS conflictReason
      FROM devspace_trace_turn_bindings
      WHERE conversation_id=? AND turn_exchange_id=?
      ORDER BY first_seen_at ASC, trace_id ASC
    `).all(conversationId, turnExchangeId) as unknown as DevSpaceTraceTurnBindingRow[]
  }

  /** 启动时用于把既有 canonical trace identity 小规模镜像回 DevSpace。 */
  listVerifiedDevSpaceTraceTurns(limit = 10_000): DevSpaceTraceTurnBindingRow[] {
    return this.db.prepare(`
      SELECT trace_id AS traceId, metadata_id AS metadataId,
             first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt,
             first_audit_id AS firstAuditId, last_audit_id AS lastAuditId,
             conversation_id AS conversationId,
             turn_exchange_id AS turnExchangeId,
             request_id AS requestId,
             status,
             verified_at AS verifiedAt,
             conflict_reason AS conflictReason
      FROM devspace_trace_turn_bindings
      WHERE status='verified'
        AND conversation_id IS NOT NULL
        AND turn_exchange_id IS NOT NULL
      ORDER BY verified_at ASC, trace_id ASC
      LIMIT ?
    `).all(Math.max(1, Math.min(100_000, Math.trunc(limit)))) as unknown as DevSpaceTraceTurnBindingRow[]
  }

  /** 返回一个 trace 下所有 metadata 成员；同一 metadata 允许出现在多个 trace 中。 */
  listDevSpaceTraceMetadataMembers(traceId: string): DevSpaceTraceMetadataMemberRow[] {
    return this.db.prepare(`
      SELECT trace_id AS traceId,
             metadata_id AS metadataId,
             first_seen_at AS firstSeenAt,
             last_seen_at AS lastSeenAt,
             first_audit_id AS firstAuditId,
             last_audit_id AS lastAuditId
      FROM devspace_trace_metadata_members
      WHERE trace_id=?
      ORDER BY first_seen_at ASC, metadata_id ASC
    `).all(traceId.trim().toLowerCase()) as unknown as DevSpaceTraceMetadataMemberRow[]
  }

  /**
   * 找到某个 metadata 最近所属的 trace。
   *
   * metadata 可以跨 turn/trace 复用，因此这里明确按成员的 last_seen_at 取“最近一次”，
   * 绝不能把 metadata 当成永久 trace key。主要用于 daemon 重启后恢复 provisional identity。
   */
  getLatestDevSpaceTraceTurnForMetadata(metadataId: string): DevSpaceTraceTurnBindingRow | null {
    const row = this.db.prepare(`
      SELECT t.trace_id AS traceId,
             t.metadata_id AS metadataId,
             t.first_seen_at AS firstSeenAt,
             t.last_seen_at AS lastSeenAt,
             t.first_audit_id AS firstAuditId,
             t.last_audit_id AS lastAuditId,
             t.conversation_id AS conversationId,
             t.turn_exchange_id AS turnExchangeId,
             t.request_id AS requestId,
             t.status,
             t.verified_at AS verifiedAt,
             t.conflict_reason AS conflictReason
      FROM devspace_trace_metadata_members m
      JOIN devspace_trace_turn_bindings t ON t.trace_id=m.trace_id
      WHERE m.metadata_id=?
      ORDER BY m.last_seen_at DESC, t.last_seen_at DESC, t.trace_id ASC
      LIMIT 1
    `).get(metadataId.trim()) as DevSpaceTraceTurnBindingRow | undefined
    return row ?? null
  }


  bindDevSpaceMetadata(input: {
    metadataId: string
    conversationId: string
    displayTitle?: string | null
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
        metadata_id, conversation_id, display_title, first_seen_at, last_seen_at,
        bound_at, last_verified_at, evidence, confidence,
        last_turn_exchange_id, last_request_id, lifecycle_state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(metadata_id) DO UPDATE SET
        conversation_id=excluded.conversation_id,
        display_title=COALESCE(NULLIF(excluded.display_title, ''), devspace_metadata_bindings.display_title),
        bound_at=CASE
          WHEN devspace_metadata_bindings.conversation_id IS NULL
            OR devspace_metadata_bindings.conversation_id <> excluded.conversation_id
          THEN excluded.bound_at
          ELSE COALESCE(devspace_metadata_bindings.bound_at, excluded.bound_at)
        END,
        last_verified_at=excluded.last_verified_at,
        evidence=excluded.evidence,
        confidence=excluded.confidence,
        last_turn_exchange_id=COALESCE(excluded.last_turn_exchange_id, devspace_metadata_bindings.last_turn_exchange_id),
        last_request_id=COALESCE(excluded.last_request_id, devspace_metadata_bindings.last_request_id),
        unbound_watchdog_at=NULL,
        lifecycle_state=excluded.lifecycle_state
    `).run(
      input.metadataId,
      input.conversationId,
      input.displayTitle?.trim() || null,
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

  /**
   * 未绑定 metadata 自己也有真实 watchdog 生命周期。
   * 这里只持久化“已经跨过 watchdog 阈值”这个事实；timeout 本身不是 incident，
   * 不直接发送通知。真正的通知仍由后续 body/status 诊断结果决定。
   */
  markDevSpaceUnboundWatchdog(metadataId: string, detectedAt: number): DevSpaceMetadataBindingRow | null {
    this.db.prepare(`
      UPDATE devspace_metadata_bindings
      SET unbound_watchdog_at=COALESCE(unbound_watchdog_at, ?)
      WHERE metadata_id = ? AND conversation_id IS NULL
    `).run(Math.max(0, Math.trunc(detectedAt)), metadataId)
    return this.getDevSpaceMetadataBinding(metadataId)
  }

  upsertActiveWatchdog(input: Omit<ActiveWatchdogStateRow, 'updatedAt' | 'watchdogPendingAt'> & {
    watchdogPendingAt?: number | null
    updatedAt?: number
  }): void {
    const updatedAt = Math.max(0, Math.trunc(input.updatedAt ?? Date.now()))
    this.db.prepare(`
      INSERT INTO active_watchdogs (
        conversation_id, started_at, last_event_at, last_watchdog_at, watchdog_pending_at,
        start_type, last_diagnostic_turn_key, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET
        started_at=excluded.started_at,
        last_event_at=excluded.last_event_at,
        last_watchdog_at=excluded.last_watchdog_at,
        watchdog_pending_at=excluded.watchdog_pending_at,
        start_type=excluded.start_type,
        last_diagnostic_turn_key=excluded.last_diagnostic_turn_key,
        updated_at=excluded.updated_at
    `).run(
      input.conversationId,
      Math.max(0, Math.trunc(input.startedAt)),
      Math.max(0, Math.trunc(input.lastEventAt)),
      input.lastWatchdogAt === null ? null : Math.max(0, Math.trunc(input.lastWatchdogAt)),
      input.watchdogPendingAt === null || input.watchdogPendingAt === undefined
        ? null
        : Math.max(0, Math.trunc(input.watchdogPendingAt)),
      input.startType,
      input.lastDiagnosticTurnKey ?? null,
      updatedAt,
    )
  }

  deleteActiveWatchdog(conversationId: string): void {
    this.db.prepare('DELETE FROM active_watchdogs WHERE conversation_id = ?').run(conversationId)
  }

  deleteActiveWatchdogIfStartedAt(conversationId: string, startedAt: number): boolean {
    const result = this.db.prepare(`
      DELETE FROM active_watchdogs
      WHERE conversation_id = ? AND started_at = ?
    `).run(conversationId, Math.max(0, Math.trunc(startedAt)))
    return Number(result.changes) > 0
  }

  markCatalogWatchdogCompleted(conversationId: string, catalogUpdateTime: unknown, completedAt = Date.now()): void {
    const updateTimeKey = catalogWatchdogUpdateTimeKey(catalogUpdateTime)
    this.db.prepare(`
      INSERT INTO catalog_watchdog_watermarks (conversation_id, update_time_key, completed_at)
      VALUES (?, ?, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET
        update_time_key=excluded.update_time_key,
        completed_at=excluded.completed_at
    `).run(
      conversationId,
      updateTimeKey,
      Math.max(0, Math.trunc(completedAt)),
    )
  }

  hasCatalogWatchdogCompleted(conversationId: string, catalogUpdateTime: unknown): boolean {
    const row = this.db.prepare(`
      SELECT update_time_key AS updateTimeKey
      FROM catalog_watchdog_watermarks
      WHERE conversation_id = ?
      LIMIT 1
    `).get(conversationId) as { updateTimeKey?: string } | undefined
    return row?.updateTimeKey === catalogWatchdogUpdateTimeKey(catalogUpdateTime)
  }

  listActiveWatchdogs(limit = 1000): ActiveWatchdogStateRow[] {
    return this.db.prepare(`
      SELECT conversation_id AS conversationId,
             started_at AS startedAt,
             last_event_at AS lastEventAt,
             last_watchdog_at AS lastWatchdogAt,
             watchdog_pending_at AS watchdogPendingAt,
             start_type AS startType,
             last_diagnostic_turn_key AS lastDiagnosticTurnKey,
             updated_at AS updatedAt
      FROM active_watchdogs
      ORDER BY started_at ASC
      LIMIT ?
    `).all(Math.max(1, Math.trunc(limit))) as unknown as ActiveWatchdogStateRow[]
  }

  upsertLiveResumeCredential(input: {
    conversationId: string
    turnExchangeId?: string | null
    token: string
    resumeOffset?: string | null
    tokenSha256: string
    tokenLength: number
    sourceTransport: string
    seenAt?: number
  }): LiveResumeCredentialRow {
    const seenAt = Math.max(0, Math.trunc(input.seenAt ?? Date.now()))
    const turnExchangeId = input.turnExchangeId?.trim() || null
    const turnKey = turnExchangeId || input.conversationId
    this.db.prepare(`
      INSERT INTO live_resume_credentials (
        turn_key, conversation_id, turn_exchange_id, token, resume_offset, token_sha256, token_length,
        source_transport, first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(turn_key) DO UPDATE SET
        conversation_id=excluded.conversation_id,
        turn_exchange_id=excluded.turn_exchange_id,
        token=excluded.token,
        resume_offset=excluded.resume_offset,
        token_sha256=excluded.token_sha256,
        token_length=excluded.token_length,
        source_transport=excluded.source_transport,
        last_seen_at=excluded.last_seen_at
    `).run(
      turnKey,
      input.conversationId,
      turnExchangeId,
      input.token,
      input.resumeOffset ?? null,
      input.tokenSha256,
      Math.max(0, Math.trunc(input.tokenLength)),
      input.sourceTransport,
      seenAt,
      seenAt,
    )
    return this.getLiveResumeCredential(input.conversationId, turnExchangeId)!
  }

  getLiveResumeCredential(
    conversationId: string,
    turnExchangeId?: string | null,
  ): LiveResumeCredentialRow | null {
    const turnKey = turnExchangeId?.trim() || null
    const row = turnKey
      ? this.db.prepare(`
          SELECT turn_key AS turnKey, conversation_id AS conversationId,
                 turn_exchange_id AS turnExchangeId, token, resume_offset AS resumeOffset,
                 token_sha256 AS tokenSha256, token_length AS tokenLength,
                 source_transport AS sourceTransport, first_seen_at AS firstSeenAt,
                 last_seen_at AS lastSeenAt, last_resume_attempt_at AS lastResumeAttemptAt,
                 resume_attempt_count AS resumeAttemptCount, next_resume_at AS nextResumeAt,
                 last_resume_status AS lastResumeStatus, last_resume_error AS lastResumeError
          FROM live_resume_credentials WHERE turn_key = ? LIMIT 1
        `).get(turnKey)
      : this.db.prepare(`
          SELECT turn_key AS turnKey, conversation_id AS conversationId,
                 turn_exchange_id AS turnExchangeId, token, resume_offset AS resumeOffset,
                 token_sha256 AS tokenSha256, token_length AS tokenLength,
                 source_transport AS sourceTransport, first_seen_at AS firstSeenAt,
                 last_seen_at AS lastSeenAt, last_resume_attempt_at AS lastResumeAttemptAt,
                 resume_attempt_count AS resumeAttemptCount, next_resume_at AS nextResumeAt,
                 last_resume_status AS lastResumeStatus, last_resume_error AS lastResumeError
          FROM live_resume_credentials
          WHERE conversation_id = ?
          ORDER BY last_seen_at DESC
          LIMIT 1
        `).get(conversationId)
    return (row as LiveResumeCredentialRow | undefined) ?? null
  }

  markLiveResumeAttempt(input: {
    conversationId: string
    turnExchangeId?: string | null
    attemptedAt?: number
    nextResumeAt?: number | null
    status?: number | null
    error?: string | null
  }): void {
    const credential = this.getLiveResumeCredential(input.conversationId, input.turnExchangeId)
    if (!credential) return
    this.db.prepare(`
      UPDATE live_resume_credentials
      SET last_resume_attempt_at=?,
          resume_attempt_count=resume_attempt_count+1,
          next_resume_at=?,
          last_resume_status=?,
          last_resume_error=?
      WHERE turn_key=?
    `).run(
      Math.max(0, Math.trunc(input.attemptedAt ?? Date.now())),
      input.nextResumeAt === null || input.nextResumeAt === undefined
        ? null
        : Math.max(0, Math.trunc(input.nextResumeAt)),
      input.status ?? null,
      input.error ?? null,
      credential.turnKey,
    )
  }

  hasTurnNotification(notificationKey: string): boolean {
    const row = this.db.prepare(
      'SELECT 1 AS found FROM turn_notification_ledger WHERE notification_key = ? LIMIT 1',
    ).get(notificationKey) as { found?: number } | undefined
    return row?.found === 1
  }

  markTurnNotificationSent(input: {
    notificationKey: string
    kind: string
    conversationId?: string | null
    turnKey?: string | null
    sentAt?: number
    providerStatus?: number | null
    payload: unknown
  }): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO turn_notification_ledger (
        notification_key, kind, conversation_id, turn_key, sent_at, provider_status, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.notificationKey,
      input.kind,
      input.conversationId ?? null,
      input.turnKey ?? null,
      Math.max(0, Math.trunc(input.sentAt ?? Date.now())),
      input.providerStatus ?? null,
      JSON.stringify(input.payload ?? null),
    )
  }

  getTurnNotification(notificationKey: string): TurnNotificationLedgerRow | null {
    const row = this.db.prepare(`
      SELECT notification_key AS notificationKey,
             kind,
             conversation_id AS conversationId,
             turn_key AS turnKey,
             sent_at AS sentAt,
             provider_status AS providerStatus,
             payload_json AS payloadJson
      FROM turn_notification_ledger
      WHERE notification_key = ?
      LIMIT 1
    `).get(notificationKey) as unknown as TurnNotificationLedgerRow | undefined
    return row ?? null
  }

  getMessages(conversationId: string): Array<Record<string, unknown>> {
    return this.db.prepare(`
      SELECT
        message_id AS messageId,
        ROW_NUMBER() OVER (ORDER BY COALESCE(create_time, 0), row_id) - 1 AS ordinal,
        role,
        author_name AS authorName,
        recipient,
        channel,
        content_type AS contentType,
        text,
        hidden,
        create_time AS createTime,
        status,
        end_turn AS endTurn,
        request_id AS requestId,
        turn_exchange_id AS turnExchangeId,
        finish_type AS finishType,
        finish_reason AS finishReason,
        reasoning_status AS reasoningStatus,
        model_slug AS modelSlug,
        resolved_model_slug AS resolvedModelSlug
      FROM messages
      WHERE conversation_id = ?
      ORDER BY COALESCE(create_time, 0), row_id
    `).all(conversationId) as unknown as Array<Record<string, unknown>>
  }

  /**
   * Reader 专用分页：先在 SQLite 内确定 ordinal 与目标页，再读取这一页的正文。
   *
   * getMessages() 是完整导出语义，不能用于“最近几 turn”的热路径，否则工具密集型长聊天会把
   * 整个 Conversation 的大段 text 先复制进 Node，再由 Bridge 丢掉绝大多数行。
   */
  getMessagesPage(
    conversationId: string,
    options: { limit?: number, beforeOrdinal?: number | null } = {},
  ): {
    messages: Array<Record<string, unknown>>
    canonicalCount: number
    visibleCount: number
    eligibleVisibleCount: number
    hasMore: boolean
    nextBeforeOrdinal: number | null
  } {
    const limit = Math.max(1, Math.min(200, Math.trunc(options.limit ?? 120)))
    const beforeOrdinal = options.beforeOrdinal === null || options.beforeOrdinal === undefined
      ? null
      : Math.trunc(options.beforeOrdinal)
    // Reader 的分页边界只负责“别把整条 Conversation 一次性搬进 Node”，
    // 不能顺手改变 canonical 节点语义。tool call / tool result / API / system /
    // developer / reasoning 节点都仍属于这条 Conversation，应该参与 ordinal 与分页；
    // reasoning 正文是否对外展示由 Bridge 的 sanitize 层单独处理。
    const readerVisibleSql = 'hidden = 0'
    // 绝不能为了 visibleCount 把 ordinal 完整性检查从窄 covering index 拖回肥 messages 表。
    // 两个 count 拆开后，各自只读最小索引；生产 8 条 4k~5k-message 长聊天从约 200ms
    // 降到约 10~15ms 的 count 总成本。
    const counts = this.db.prepare(`
      SELECT count(*) AS canonicalCount,
             min(ordinal) AS minOrdinal,
             max(ordinal) AS maxOrdinal,
             count(DISTINCT ordinal) AS distinctOrdinalCount,
             sum(CASE WHEN ordinal IS NULL THEN 1 ELSE 0 END) AS nullOrdinalCount
      FROM messages INDEXED BY messages_conversation_ordinal
      WHERE conversation_id = ?
    `).get(conversationId) as {
      canonicalCount?: number
      minOrdinal?: number | null
      maxOrdinal?: number | null
      distinctOrdinalCount?: number
      nullOrdinalCount?: number
    } | undefined
    const visible = this.db.prepare(`
      SELECT count(*) AS visibleCount
      FROM messages INDEXED BY messages_conversation_visible_ordinal
      WHERE conversation_id = ? AND hidden = 0
    `).get(conversationId) as { visibleCount?: number } | undefined
    const canonicalCount = Number(counts?.canonicalCount ?? 0)
    const visibleCount = Number(visible?.visibleCount ?? 0)
    // Live 热路径已经不再每次全表重写 ordinal，但绝大多数 canonical Conversation 的
    // 持久 ordinal 仍然是完整的 0..N-1。先用 O(N) 但只走窄索引的完整性检查；一旦成立，
    // 后续页就能直接利用 messages_conversation_ordinal 做毫秒级 keyset/range 读取。
    // 极少数历史/中间态若 ordinal 有洞、重复或 NULL，则自动回退动态 ROW_NUMBER，正确性优先。
    const storedOrdinalUsable = canonicalCount === 0 || (
      Number(counts?.nullOrdinalCount ?? 0) === 0
      && Number(counts?.distinctOrdinalCount ?? 0) === canonicalCount
      && Number(counts?.minOrdinal ?? 0) === 0
      && Number(counts?.maxOrdinal ?? -1) === canonicalCount - 1
    )

    let messages: Array<Record<string, unknown>>
    let eligibleVisibleCount = visibleCount
    if (storedOrdinalUsable) {
      const beforeClause = beforeOrdinal === null ? '' : 'AND ordinal < ?'
      const pageArgs: Array<string | number> = beforeOrdinal === null
        ? [conversationId, limit]
        : [conversationId, beforeOrdinal, limit]
      messages = this.db.prepare(`
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
          create_time AS createTime,
          status,
          end_turn AS endTurn,
          request_id AS requestId,
          turn_exchange_id AS turnExchangeId,
          finish_type AS finishType,
          finish_reason AS finishReason,
          reasoning_status AS reasoningStatus,
          model_slug AS modelSlug,
          resolved_model_slug AS resolvedModelSlug
        FROM messages INDEXED BY messages_conversation_visible_ordinal
        WHERE conversation_id = ? AND ${readerVisibleSql} ${beforeClause}
        ORDER BY ordinal DESC
        LIMIT ?
      `).all(...pageArgs).reverse() as unknown as Array<Record<string, unknown>>
      if (beforeOrdinal !== null) {
        const eligible = this.db.prepare(`
          SELECT count(*) AS n
          FROM messages INDEXED BY messages_conversation_visible_ordinal
          WHERE conversation_id = ? AND ${readerVisibleSql} AND ordinal < ?
        `).get(conversationId, beforeOrdinal) as { n?: number } | undefined
        eligibleVisibleCount = Number(eligible?.n ?? 0)
      }
    }
    else {
      const beforeClause = beforeOrdinal === null ? '' : 'AND o.ordinal < ?'
      const pageArgs: Array<string | number> = beforeOrdinal === null
        ? [conversationId, limit]
        : [conversationId, beforeOrdinal, limit]
      messages = this.db.prepare(`
        WITH ordered AS (
          SELECT row_id,
                 ROW_NUMBER() OVER (ORDER BY COALESCE(create_time, 0), row_id) - 1 AS ordinal
          FROM messages
          WHERE conversation_id = ?
        ), page_ids AS (
          SELECT o.row_id, o.ordinal
          FROM ordered o
          JOIN messages m ON m.row_id = o.row_id
          WHERE ${readerVisibleSql.replaceAll('hidden', 'm.hidden')
            .replaceAll('role', 'm.role')
            .replaceAll('recipient', 'm.recipient')
            .replaceAll('channel', 'm.channel')
            .replaceAll('content_type', 'm.content_type')} ${beforeClause}
          ORDER BY o.ordinal DESC
          LIMIT ?
        )
        SELECT
          m.message_id AS messageId,
          p.ordinal AS ordinal,
          m.role,
          m.author_name AS authorName,
          m.recipient,
          m.channel,
          m.content_type AS contentType,
          m.text,
          m.hidden,
          m.create_time AS createTime,
          m.status,
          m.end_turn AS endTurn,
          m.request_id AS requestId,
          m.turn_exchange_id AS turnExchangeId,
          m.finish_type AS finishType,
          m.finish_reason AS finishReason,
          m.reasoning_status AS reasoningStatus,
          m.model_slug AS modelSlug,
          m.resolved_model_slug AS resolvedModelSlug
        FROM page_ids p
        JOIN messages m ON m.row_id = p.row_id
        ORDER BY p.ordinal ASC
      `).all(...pageArgs) as unknown as Array<Record<string, unknown>>
      if (beforeOrdinal !== null) {
        const eligible = this.db.prepare(`
          WITH ordered AS (
            SELECT row_id,
                   ROW_NUMBER() OVER (ORDER BY COALESCE(create_time, 0), row_id) - 1 AS ordinal
            FROM messages
            WHERE conversation_id = ?
          )
          SELECT count(*) AS n
          FROM ordered o
          JOIN messages m ON m.row_id = o.row_id
          WHERE ${readerVisibleSql.replaceAll('hidden', 'm.hidden')
            .replaceAll('role', 'm.role')
            .replaceAll('recipient', 'm.recipient')
            .replaceAll('channel', 'm.channel')
            .replaceAll('content_type', 'm.content_type')} AND o.ordinal < ?
        `).get(conversationId, beforeOrdinal) as { n?: number } | undefined
        eligibleVisibleCount = Number(eligible?.n ?? 0)
      }
    }

    const nextBeforeOrdinal = messages.length > 0 && Number.isFinite(Number(messages[0]!.ordinal))
      ? Number(messages[0]!.ordinal)
      : null
    return {
      messages,
      canonicalCount,
      visibleCount,
      eligibleVisibleCount,
      hasMore: eligibleVisibleCount > messages.length,
      nextBeforeOrdinal,
    }
  }

  getResources(conversationId: string): Array<Record<string, unknown>> {
    const rows = this.db.prepare(`
      SELECT r.message_id AS messageId,
             ROW_NUMBER() OVER (ORDER BY COALESCE(m.create_time, 0), m.row_id, r.ordinal) - 1 AS ordinal,
             r.kind, r.label, r.data_json AS dataJson
      FROM resources r
      LEFT JOIN messages m
        ON m.conversation_id = r.conversation_id
       AND m.message_id = r.message_id
      WHERE r.conversation_id = ?
      ORDER BY COALESCE(m.create_time, 0), m.row_id, r.ordinal
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
    const bigramIndexedMessageCount = Number((this.db.prepare('SELECT count(*) AS n FROM message_fts_bigram').get() as { n: number }).n)
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
      bigramIndexedMessageCount,
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
