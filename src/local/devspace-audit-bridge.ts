/**
 * DevSpace → ChatGPT Archive 的本地审计桥。
 *
 * 两个程序已经各自把事实写进 SQLite，因此这里不再引入 socket/HTTP 服务：
 * Archive 只需要低频读取 DevSpace 的 append-only tool_audit，并在 binding 已确认后
 * 把结果镜像回 DevSpace。整个桥只处理控制面 ID/时间/工具名，不读取工具输出正文。
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export interface DevSpaceAuditEvent {
  id: string
  metadataId: string
  /** DevSpace v12 起直接物化的 W3C trace-id；旧库/fixture 可缺省并回退解析 requestMetaJson。 */
  traceId?: string | null
  tool: string
  argsJson: string
  /** 旧 fixture / 兼容调用可以缺省；真实 SQLite poll 会返回 null 或最终值。 */
  resultJson?: string | null
  error?: string | null
  startedAt: string
  startedAtMs: number
  finishedAt: string | null
  requestMetaJson: string | null
}

/**
 * DevSpace tool_audit 的稳定分页游标。
 * startedAt 保留 SQLite 原始 ISO 字符串；auditId 负责区分同一毫秒内的多条记录。
 */
export interface DevSpaceAuditCursor {
  startedAt: string
  auditId: string
}

export interface DevSpaceMetadataActivity {
  metadataId: string
  firstAt: number
  lastAt: number
  auditCount: number
  audits: DevSpaceAuditEvent[]
}

/** 用于一次性历史 seed；这里只需要 metadata 的首末时间和调用数量。 */
export interface DevSpaceMetadataSummary {
  metadataId: string
  firstAt: number
  lastAt: number
  auditCount: number
}

/**
 * 某个 metadata 当前的工具活动状态。
 *
 * Archive 只用这些控制面字段判断“现在是否存在正在运行的 DevSpace 工具”和
 * “最后一次工具结束是什么时候”；不读取 result 正文，也不把它当 turn 终止证据。
 */
export interface DevSpaceMetadataToolState {
  metadataId: string
  title: string | null
  runningTools: number
  latestStartedAt: number | null
  latestFinishedAt: number | null
  latestAuditId: string | null
  lastFinishedAuditId: string | null
}

export interface DevSpaceBodyToolCall {
  tool: string
  argsJson: string
  startedAtMs: number
  /** canonical Body 中该 tool-call 所属的 request/generation。steering 时同一 TID 可出现多个 RID。 */
  requestId?: string | null
}

export interface DevSpaceTraceRequestPair {
  traceId: string
  requestId: string
}

export interface DevSpaceBindingMatch {
  activity: DevSpaceMetadataActivity
  exactMatches: number
  uniqueMatches: number
}

// 真机观测中 ChatGPT body 的 tool-call create_time 与 DevSpace tool_audit.started_at
// 绝大多数只差几秒；p99 < 30s。保留 120s 覆盖 Host/SQLite 落盘抖动，但禁止把几小时
// 甚至几天前另一个 conversation 的相同 tool+args 当成当前 turn 的 exact evidence。
const DEVSPACE_BINDING_TIME_TOLERANCE_MS = 120_000

export interface DevSpaceConversationBindingMirror {
  metadataId: string
  conversationId: string
  turnExchangeId?: string | null
  evidence: string
  confidence: string
  observedAt: number
}

/** Archive canonical matcher 回写给 DevSpace 的 trace→request/turn/conversation 镜像。 */
export interface DevSpaceTraceBindingMirror {
  traceId: string
  conversationId: string
  turnExchangeId: string
  requestId?: string | null
  evidence: string
  confidence: string
  observedAt: number
}

/** DevSpace v12 从 raw tool_audit 物化出的 trace↔metadata 历史成员事实。 */
export interface DevSpaceTraceMetadataMemberMirror {
  traceId: string
  metadataId: string
  firstSeenAt: number
  lastSeenAt: number
  firstAuditId: string
  lastAuditId: string
}

/** 默认沿用 DevSpace 自身的 storage.stateDir 默认值。 */
export function defaultDevSpaceDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME || env.USERPROFILE || homedir()
  return path.join(home, '.local', 'share', 'devspace', 'devspace.sqlite')
}

/**
 * 从一小段 audit 事件中按 metadata 分组。
 *
 * binding 算法只需要几十秒/几分钟的局部窗口，不应扫描整个 DevSpace 历史库。
 */
export function groupDevSpaceActivity(events: DevSpaceAuditEvent[]): DevSpaceMetadataActivity[] {
  const groups = new Map<string, DevSpaceAuditEvent[]>()
  for (const event of events) {
    const rows = groups.get(event.metadataId) ?? []
    rows.push(event)
    groups.set(event.metadataId, rows)
  }
  return [...groups.entries()].map(([metadataId, audits]) => {
    const ordered = [...audits].sort((a, b) => a.startedAtMs - b.startedAtMs || a.id.localeCompare(b.id))
    return {
      metadataId,
      firstAt: ordered[0]?.startedAtMs ?? 0,
      lastAt: ordered.at(-1)?.startedAtMs ?? 0,
      auditCount: ordered.length,
      audits: ordered,
    }
  }).sort((a, b) => a.firstAt - b.firstAt || a.metadataId.localeCompare(b.metadataId))
}

/**
 * 从 ChatGPT body 的 api_tool.call_tool 节点解析 DevSpace 调用。
 *
 * binding 不再依赖“某个时间窗里只有一个 metadata”这种脆弱条件，而是比较
 * 两边都已经存在的 tool + args，并要求同一 fingerprint 的 audit/body 时间足够接近。
 */
export function parseDevSpaceBodyToolCall(
  text: string,
  startedAtMs: number,
  requestId: string | null = null,
): DevSpaceBodyToolCall | null {
  try {
    const payload = JSON.parse(text) as { path?: unknown, args?: unknown }
    const toolPath = typeof payload.path === 'string' ? payload.path : ''
    const segments = toolPath.split('/').filter(Boolean)
    const transport = String(segments[0] ?? '').trim().toLowerCase().replace(/[_-]+/g, ' ')
    // Backup Tunnel 与 DevSpace 走同一 MQ / tool_audit 数据源，只是 ChatGPT body 中
    // 暴露的 provider 名不同。绑定必须把它们视为同一个 transport family。
    if (transport !== 'devspace' && transport !== 'backup tunnel') return null
    const tool = segments.at(-1)
    if (!tool) return null
    return {
      tool,
      argsJson: JSON.stringify(payload.args ?? {}),
      startedAtMs,
      ...(requestId ? { requestId } : {}),
    }
  }
  catch {
    return null
  }
}

/**
 * 对 JSON 递归按 key 排序；ChatGPT body 与 DevSpace audit 可能只是对象 key 顺序不同，
 * 语义相同的参数必须得到同一 fingerprint。
 */
function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson)
  if (!value || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map(key => [key, canonicalJson(record[key])]),
  )
}

export function devSpaceToolArgsFingerprint(tool: string, argsJson: string): string | null {
  try {
    return tool + '\n' + JSON.stringify(canonicalJson(JSON.parse(argsJson)))
  }
  catch {
    return null
  }
}

/**
 * 从 DevSpace 安全落库的 handlerExtra 里提取 W3C trace-id。
 *
 * 这里只读取 allowlisted `traceparent`，不碰 Authorization/cookie 等敏感头。trace-id 只是
 * provisional turn identity；canonical Body 到达前不得把它视为协议级 turn_exchange_id。
 */
export function devSpaceTraceIdFromRequestMetaJson(requestMetaJson: string | null | undefined): string | null {
  if (!requestMetaJson) return null
  try {
    const parsed = JSON.parse(requestMetaJson) as Record<string, unknown>
    const handlerExtra = parsed['devspace/handlerExtra']
    if (!handlerExtra || typeof handlerExtra !== 'object' || Array.isArray(handlerExtra)) return null
    const requestInfo = (handlerExtra as Record<string, unknown>).requestInfo
    if (!requestInfo || typeof requestInfo !== 'object' || Array.isArray(requestInfo)) return null
    const safeHeaders = (requestInfo as Record<string, unknown>).safeHeaderValues
    if (!safeHeaders || typeof safeHeaders !== 'object' || Array.isArray(safeHeaders)) return null
    const traceparent = (safeHeaders as Record<string, unknown>).traceparent
    if (typeof traceparent !== 'string') return null
    const match = traceparent.trim().match(/^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/iu)
    const traceId = match?.[1]?.toLowerCase() ?? null
    if (!traceId || /^0{32}$/u.test(traceId)) return null
    return traceId
  }
  catch {
    return null
  }
}

/**
 * 用真实 tool + args + 局部时间一致性做 exact matching。
 *
 * 接受规则故意简单：
 * - 至少两个不同 exact fingerprints；或
 * - 只有一个 exact fingerprint，但它只出现在一个 metadata 中。
 * 同分候选一律不绑定。这样并发 3~4 个聊天也不需要靠时间猜测。
 */
export function matchDevSpaceCandidateForTurn(input: {
  activities: DevSpaceMetadataActivity[]
  bodyCalls: DevSpaceBodyToolCall[]
  alreadyBoundMetadataIds?: Iterable<string>
}): DevSpaceBindingMatch | null {
  if (input.bodyCalls.length === 0) return null
  const bound = new Set(input.alreadyBoundMetadataIds ?? [])
  const bodyByFingerprint = new Map<string, number[]>()
  for (const call of input.bodyCalls) {
    const fingerprint = devSpaceToolArgsFingerprint(call.tool, call.argsJson)
    if (!fingerprint) continue
    const times = bodyByFingerprint.get(fingerprint) ?? []
    times.push(call.startedAtMs)
    bodyByFingerprint.set(fingerprint, times)
  }
  const bodyFingerprints = new Set(bodyByFingerprint.keys())
  if (bodyFingerprints.size === 0) return null

  const auditMatchesBodyInTime = (fingerprint: string, startedAtMs: number) => {
    const times = bodyByFingerprint.get(fingerprint)
    return Boolean(times?.some(time => Math.abs(time - startedAtMs) <= DEVSPACE_BINDING_TIME_TOLERANCE_MS))
  }

  const fingerprintOwners = new Map<string, Set<string>>()
  for (const activity of input.activities) {
    // 已经绑定过的 metadata 仍然必须参与“这个 fingerprint 是否唯一”的所有者统计。
    // 否则一个 fingerprint 同时属于 meta-old(已绑定) 与 meta-new(未绑定) 时，
    // 跳过 meta-old 会把它错误地伪装成 meta-new 的唯一证据，造成误绑。
    for (const audit of activity.audits) {
      const fingerprint = devSpaceToolArgsFingerprint(audit.tool, audit.argsJson)
      if (!fingerprint || !bodyFingerprints.has(fingerprint)) continue
      if (!auditMatchesBodyInTime(fingerprint, audit.startedAtMs)) continue
      const owners = fingerprintOwners.get(fingerprint) ?? new Set<string>()
      owners.add(activity.metadataId)
      fingerprintOwners.set(fingerprint, owners)
    }
  }

  const scored: DevSpaceBindingMatch[] = []
  for (const activity of input.activities) {
    if (bound.has(activity.metadataId)) continue
    const exact = new Set<string>()
    for (const audit of activity.audits) {
      const fingerprint = devSpaceToolArgsFingerprint(audit.tool, audit.argsJson)
      if (fingerprint
        && bodyFingerprints.has(fingerprint)
        && auditMatchesBodyInTime(fingerprint, audit.startedAtMs)) exact.add(fingerprint)
    }
    if (exact.size === 0) continue
    const uniqueMatches = [...exact].filter(
      fingerprint => fingerprintOwners.get(fingerprint)?.size === 1,
    ).length
    scored.push({
      activity,
      exactMatches: exact.size,
      uniqueMatches,
    })
  }

  scored.sort((a, b) =>
    b.uniqueMatches - a.uniqueMatches
    || b.exactMatches - a.exactMatches
    || a.activity.metadataId.localeCompare(b.activity.metadataId))
  const best = scored[0]
  if (!best) return null
  const second = scored[1]
  if (second
    && second.uniqueMatches === best.uniqueMatches
    && second.exactMatches === best.exactMatches) return null
  if (best.uniqueMatches < 1 && best.exactMatches < 2) return null
  return best
}

/**
 * 在已经由 canonical matcher 选中的 metadata activity 内，收集真正参与该 turn exact
 * match 的 trace-id。与 metadata matcher 使用同一 fingerprint + 局部时间容差，因此不会再
 * 另造一套“10 秒窗口”身份规则。
 */
export function matchingDevSpaceTraceIdsForTurn(input: {
  activity: DevSpaceMetadataActivity
  bodyCalls: DevSpaceBodyToolCall[]
}): string[] {
  const bodyByFingerprint = new Map<string, number[]>()
  for (const call of input.bodyCalls) {
    const fingerprint = devSpaceToolArgsFingerprint(call.tool, call.argsJson)
    if (!fingerprint) continue
    const times = bodyByFingerprint.get(fingerprint) ?? []
    times.push(call.startedAtMs)
    bodyByFingerprint.set(fingerprint, times)
  }
  const traces = new Set<string>()
  for (const audit of input.activity.audits) {
    const fingerprint = devSpaceToolArgsFingerprint(audit.tool, audit.argsJson)
    const times = fingerprint ? bodyByFingerprint.get(fingerprint) : null
    if (!times?.some(time => Math.abs(time - audit.startedAtMs) <= DEVSPACE_BINDING_TIME_TOLERANCE_MS)) continue
    const traceId = typeof audit.traceId === 'string' && audit.traceId.trim()
      ? audit.traceId.trim().toLowerCase()
      : devSpaceTraceIdFromRequestMetaJson(audit.requestMetaJson)
    if (traceId) traces.add(traceId)
  }
  return [...traces].sort()
}

/**
 * 把同一 Turn Exchange 内的多个 trace 精确拆到各自 request_id。
 *
 * steering 会让一个 TID 内出现多个 request/generation；这时仅知道“多个 trace 属于同一 TID”
 * 还不够，必须继续证明 trace↔RID。这里仍复用 exact tool+args + ±120s 时间容差：
 * - trace 命中多个 RID：歧义，不输出；
 * - RID 被多个 trace 命中：歧义，不输出。
 *
 * 所以返回 pair 只包含双向单值证据。未来 Host 行为若改变，会 fail-closed 留 provisional。
 */
export function matchingDevSpaceTraceRequestPairsForTurn(input: {
  activity: DevSpaceMetadataActivity
  bodyCalls: DevSpaceBodyToolCall[]
}): DevSpaceTraceRequestPair[] {
  const bodyByFingerprint = new Map<string, Array<{ startedAtMs: number, requestId: string }>>()
  for (const call of input.bodyCalls) {
    const requestId = typeof call.requestId === 'string' ? call.requestId.trim() : ''
    if (!requestId) continue
    const fingerprint = devSpaceToolArgsFingerprint(call.tool, call.argsJson)
    if (!fingerprint) continue
    const calls = bodyByFingerprint.get(fingerprint) ?? []
    calls.push({ startedAtMs: call.startedAtMs, requestId })
    bodyByFingerprint.set(fingerprint, calls)
  }

  const requestIdsByTrace = new Map<string, Set<string>>()
  for (const audit of input.activity.audits) {
    const fingerprint = devSpaceToolArgsFingerprint(audit.tool, audit.argsJson)
    if (!fingerprint) continue
    const matchingCalls = (bodyByFingerprint.get(fingerprint) ?? []).filter(
      call => Math.abs(call.startedAtMs - audit.startedAtMs) <= DEVSPACE_BINDING_TIME_TOLERANCE_MS,
    )
    if (matchingCalls.length === 0) continue
    const traceId = typeof audit.traceId === 'string' && audit.traceId.trim()
      ? audit.traceId.trim().toLowerCase()
      : devSpaceTraceIdFromRequestMetaJson(audit.requestMetaJson)
    if (!traceId) continue
    const requestIds = requestIdsByTrace.get(traceId) ?? new Set<string>()
    for (const call of matchingCalls) requestIds.add(call.requestId)
    requestIdsByTrace.set(traceId, requestIds)
  }

  const uniqueTracePairs = [...requestIdsByTrace.entries()]
    .filter(([, requestIds]) => requestIds.size === 1)
    .map(([traceId, requestIds]) => ({ traceId, requestId: [...requestIds][0]! }))
  const traceOwnersByRequest = new Map<string, Set<string>>()
  for (const pair of uniqueTracePairs) {
    const owners = traceOwnersByRequest.get(pair.requestId) ?? new Set<string>()
    owners.add(pair.traceId)
    traceOwnersByRequest.set(pair.requestId, owners)
  }
  return uniqueTracePairs
    .filter(pair => traceOwnersByRequest.get(pair.requestId)?.size === 1)
    .sort((a, b) => a.traceId.localeCompare(b.traceId))
}

export class DevSpaceAuditBridge {
  readonly dbPath: string
  private db: DatabaseSync | null = null
  private hasRequestMetaJson = false
  private hasTraceId = false
  private hasResultJson = false
  private hasError = false
  private hasBindingTable = false
  private hasTraceBindingTable = false
  private hasTraceMetadataMembersTable = false
  private hasMetadataContextTable = false

  constructor(dbPath: string) {
    this.dbPath = path.resolve(dbPath)
  }

  /** DB 尚未创建/迁移时返回 false；daemon 主循环稍后可重试，不把它当致命错误。 */
  open(): boolean {
    if (this.db) return true
    if (!existsSync(this.dbPath)) return false
    const db = new DatabaseSync(this.dbPath)
    db.exec('PRAGMA busy_timeout=1000')
    const toolAudit = db.prepare(`
      SELECT 1 AS ok FROM sqlite_master
      WHERE type='table' AND name='tool_audit'
      LIMIT 1
    `).get()
    if (!toolAudit) {
      db.close()
      return false
    }
    const columns = db.prepare('PRAGMA table_info(tool_audit)').all() as Array<{ name?: string }>
    this.hasRequestMetaJson = columns.some(column => column.name === 'request_meta_json')
    this.hasTraceId = columns.some(column => column.name === 'trace_id')
    this.hasResultJson = columns.some(column => column.name === 'result_json')
    this.hasError = columns.some(column => column.name === 'error')
    this.hasBindingTable = Boolean(db.prepare(`
      SELECT 1 AS ok FROM sqlite_master
      WHERE type='table' AND name='chatgpt_conversation_bindings'
      LIMIT 1
    `).get())
    this.hasTraceBindingTable = Boolean(db.prepare(`
      SELECT 1 AS ok FROM sqlite_master
      WHERE type='table' AND name='chatgpt_trace_bindings'
      LIMIT 1
    `).get())
    this.hasTraceMetadataMembersTable = Boolean(db.prepare(`
      SELECT 1 AS ok FROM sqlite_master
      WHERE type='table' AND name='chatgpt_trace_metadata_members'
      LIMIT 1
    `).get())
    this.hasMetadataContextTable = Boolean(db.prepare(`
      SELECT 1 AS ok FROM sqlite_master
      WHERE type='table' AND name='chatgpt_metadata_contexts'
      LIMIT 1
    `).get())
    this.db = db
    return true
  }

  /**
   * 读取一个 metadata 当前的 idle/running 状态。
   *
   * 查询只命中 metadata_id 索引，并且只取少量时间/ID 字段；即使主循环每 60 秒
   * 对少数活跃 metadata 做 durable catch-up，也远轻于任何 ChatGPT 网络请求。
   */
  metadataToolState(metadataId: string): DevSpaceMetadataToolState | null {
    if (!this.open() || !this.db) return null
    // `tool_audit_metadata_started_idx(metadata_id, started_at DESC)` 是 DevSpace 当前已有的稳定索引。
    // 旧实现虽然也以 metadata_id 过滤，但同时做 MAX(finished_at) / ORDER BY finished_at；finished_at
    // 没有任何索引，于是 SQLite 必须对该 metadata 的全部历史行回 800MiB 肥表（result_json 也在同一
    // row）读取 finished_at。真实生产里热缓存通常几毫秒，冷页/并发写时却能同步卡主线程 1~4 秒。
    //
    // 这里先用 covering started 索引拿最新 start，然后只读取“当前并行 batch”的有界窗口。
    // 这与下面原本的 orphan 语义一致：真正并行工具 start 很接近；若后来已有 >60s 更新的新 start，
    // 更早未完成记录本来就不再阻止 idle，因此 latest finish 也应由当前 generation 决定，而不是
    // 再扫描 metadata 的全部历史。
    const latestStart = this.db.prepare(`
      SELECT started_at AS startedAt
      FROM tool_audit
      WHERE metadata_id = ?
      ORDER BY started_at DESC
      LIMIT 1
    `).get(metadataId) as { startedAt?: string } | undefined
    if (!latestStart?.startedAt) return null
    const latestStartedAtMs = Date.parse(latestStart.startedAt)
    if (!Number.isFinite(latestStartedAtMs)) return null

    /**
     * 异常终止可能留下永久 finished_at=NULL 的历史 audit，不能让它永远阻止 idle。
     *
     * 真正并行的 MCP tools 来自同一模型 tool batch，start 会非常接近；单个长命令即使
     * 跑 40+ 分钟，它自己仍然是“最新 start”，因此不会被这里误清。只有当 metadata
     * 后来已经出现了明显更晚（>60s）的新 tool start 时，旧 NULL 才视为孤儿记录。
     */
    const concurrentBatchFloor = new Date(latestStartedAtMs - 60_000).toISOString()
    const currentBatch = this.db.prepare(`
      SELECT id, started_at AS startedAt, finished_at AS finishedAt
      FROM tool_audit
      WHERE metadata_id = ?
        AND started_at >= ?
    `).all(metadataId, concurrentBatchFloor) as Array<{
      id: string
      startedAt: string
      finishedAt: string | null
    }>
    if (currentBatch.length === 0) return null

    const latest = currentBatch.reduce((best, row) => {
      if (!best) return row
      if (row.startedAt > best.startedAt) return row
      if (row.startedAt === best.startedAt && row.id > best.id) return row
      return best
    }, null as typeof currentBatch[number] | null)
    const finishedRows = currentBatch.filter(row => Boolean(row.finishedAt))
    const lastFinished = finishedRows.reduce((best, row) => {
      if (!best) return row
      const rowFinished = String(row.finishedAt || '')
      const bestFinished = String(best.finishedAt || '')
      if (rowFinished > bestFinished) return row
      if (rowFinished === bestFinished && row.id > best.id) return row
      return best
    }, null as typeof currentBatch[number] | null)

    // DevSpace 可能在 Archive 之后才热升级到 v10；首次缺表时允许重新探测。
    if (!this.hasMetadataContextTable) {
      this.hasMetadataContextTable = Boolean(this.db.prepare(`
        SELECT 1 AS ok FROM sqlite_master
        WHERE type='table' AND name='chatgpt_metadata_contexts'
        LIMIT 1
      `).get())
    }
    const context = this.hasMetadataContextTable
      ? this.db.prepare(`
          SELECT title
          FROM chatgpt_metadata_contexts
          WHERE metadata_id = ?
          LIMIT 1
        `).get(metadataId) as { title?: string } | undefined
      : undefined

    const parseOptionalTime = (value: string | null | undefined) => {
      if (!value) return null
      const parsed = Date.parse(value)
      return Number.isFinite(parsed) ? parsed : null
    }
    return {
      metadataId,
      title: typeof context?.title === 'string' && context.title.trim() ? context.title.trim() : null,
      runningTools: currentBatch.filter(row => !row.finishedAt).length,
      latestStartedAt: latestStartedAtMs,
      latestFinishedAt: parseOptionalTime(lastFinished?.finishedAt),
      latestAuditId: latest?.id ?? null,
      lastFinishedAuditId: lastFinished?.id ?? null,
    }
  }

  /** daemon 重启后只恢复最近几分钟有真实 start/finish 活动的 metadata，不扫描全历史。 */
  recentMetadataToolStates(sinceActivityAtMs: number, limit = 200): DevSpaceMetadataToolState[] {
    if (!this.open() || !this.db) return []
    const since = new Date(Math.max(0, sinceActivityAtMs)).toISOString()
    const rows = this.db.prepare(`
      SELECT metadata_id AS metadataId
      FROM tool_audit
      WHERE metadata_id IS NOT NULL
        AND metadata_id <> ''
        AND (started_at >= ? OR finished_at >= ?)
      GROUP BY metadata_id
      ORDER BY MAX(COALESCE(finished_at, started_at)) DESC
      LIMIT ?
    `).all(since, since, Math.max(1, Math.trunc(limit))) as Array<{ metadataId: string }>
    return rows
      .map(row => this.metadataToolState(row.metadataId))
      .filter((state): state is DevSpaceMetadataToolState => Boolean(state))
  }

  pollSince(sinceAtMs: number, limit = 250): DevSpaceAuditEvent[] {
    if (!this.open() || !this.db) return []
    const requestMetaExpr = this.hasRequestMetaJson ? 'request_meta_json' : 'NULL'
    const resultJsonExpr = this.hasResultJson ? 'result_json' : 'NULL'
    const errorExpr = this.hasError ? 'error' : 'NULL'
    const rows = this.db.prepare(`
      SELECT id, metadata_id AS metadataId, tool, args_json AS argsJson,
             ${resultJsonExpr} AS resultJson, ${errorExpr} AS error,
             started_at AS startedAt, finished_at AS finishedAt,
             ${requestMetaExpr} AS requestMetaJson
      FROM tool_audit
      WHERE metadata_id IS NOT NULL
        AND metadata_id <> ''
        AND started_at >= ?
      ORDER BY started_at ASC, id ASC
      LIMIT ?
    `).all(new Date(Math.max(0, sinceAtMs)).toISOString(), Math.max(1, limit)) as Array<{
      id: string
      metadataId: string
      tool: string
      argsJson: string
      resultJson: string | null
      error: string | null
      startedAt: string
      finishedAt: string | null
      requestMetaJson: string | null
    }>
    return rows.flatMap((row) => {
      const startedAtMs = Date.parse(row.startedAt)
      if (!Number.isFinite(startedAtMs)) return []
      return [{
        ...row,
        startedAtMs,
      }]
    })
  }

  /**
   * 从 durable `(started_at, id)` 高水位之后严格续读。
   *
   * 与旧 pollSince(time) 最大的区别是：这里不会因为 daemon 离线超过固定 lookback 而漏行，
   * 也不会在同一毫秒有多条 audit 时只靠时间戳跳过兄弟记录。调用方可以反复按最后一条
   * 返回记录分页，直到结果少于 limit，即表示已经追平当前 DevSpace SQLite 头部。
   */
  pollAfter(cursor: DevSpaceAuditCursor, limit = 250): DevSpaceAuditEvent[] {
    if (!this.open() || !this.db) return []
    const requestMetaExpr = this.hasRequestMetaJson ? 'request_meta_json' : 'NULL'
    const resultJsonExpr = this.hasResultJson ? 'result_json' : 'NULL'
    const errorExpr = this.hasError ? 'error' : 'NULL'
    const rows = this.db.prepare(`
      SELECT id, metadata_id AS metadataId, tool, args_json AS argsJson,
             ${resultJsonExpr} AS resultJson, ${errorExpr} AS error,
             started_at AS startedAt, finished_at AS finishedAt,
             ${requestMetaExpr} AS requestMetaJson
      FROM tool_audit
      WHERE metadata_id IS NOT NULL
        AND metadata_id <> ''
        -- SQLite 对 row-value 比较采用字典序，语义正好就是 durable (started_at,id)
        -- keyset cursor。旧 OR 写法会让真实 800MiB DevSpace DB 退化成从头扫描
        -- tool_audit_started_idx，并为 ORDER BY 第二列建临时 B-tree；生产实测取 1 行也要
        -- 195~216ms。tuple keyset 可直接从 started_at 索引 seek，实测降到亚毫秒级。
        AND (started_at, id) > (?, ?)
      ORDER BY started_at ASC, id ASC
      LIMIT ?
    `).all(
      cursor.startedAt,
      cursor.auditId,
      Math.max(1, Math.trunc(limit)),
    ) as Array<{
      id: string
      metadataId: string
      tool: string
      argsJson: string
      resultJson: string | null
      error: string | null
      startedAt: string
      finishedAt: string | null
      requestMetaJson: string | null
    }>
    return rows.flatMap((row) => {
      const startedAtMs = Date.parse(row.startedAt)
      return Number.isFinite(startedAtMs) ? [{ ...row, startedAtMs }] : []
    })
  }

  /** 当前 DevSpace audit 头部；首次升级 durable cursor 时用于建立明确 bootstrap 边界。 */
  latestAuditCursor(): DevSpaceAuditCursor | null {
    if (!this.open() || !this.db) return null
    const row = this.db.prepare(`
      SELECT started_at AS startedAt, id AS auditId
      FROM tool_audit
      WHERE metadata_id IS NOT NULL AND metadata_id <> ''
      ORDER BY started_at DESC, id DESC
      LIMIT 1
    `).get() as DevSpaceAuditCursor | undefined
    return row ?? null
  }

  /**
   * 按 append-only audit id 读取当前最新状态。
   *
   * 同一个 audit 会先 INSERT(start)，结束时再 UPDATE(result/finished_at)。UDP finish 门铃到达时
   * 增量 poll 可能因为 seen-id 去重不再进入 handler，因此 recovery overlay 需要能按 id 重读最终行。
   */
  auditById(auditId: string): DevSpaceAuditEvent | null {
    if (!this.open() || !this.db || !auditId) return null
    const requestMetaExpr = this.hasRequestMetaJson ? 'request_meta_json' : 'NULL'
    const resultJsonExpr = this.hasResultJson ? 'result_json' : 'NULL'
    const errorExpr = this.hasError ? 'error' : 'NULL'
    const row = this.db.prepare(`
      SELECT id, metadata_id AS metadataId, tool, args_json AS argsJson,
             ${resultJsonExpr} AS resultJson, ${errorExpr} AS error,
             started_at AS startedAt, finished_at AS finishedAt,
             ${requestMetaExpr} AS requestMetaJson
      FROM tool_audit
      WHERE id = ?
      LIMIT 1
    `).get(auditId) as {
      id: string
      metadataId: string
      tool: string
      argsJson: string
      resultJson: string | null
      error: string | null
      startedAt: string
      finishedAt: string | null
      requestMetaJson: string | null
    } | undefined
    if (!row) return null
    const startedAtMs = Date.parse(row.startedAt)
    if (!Number.isFinite(startedAtMs)) return null
    return { ...row, startedAtMs }
  }

  /** 绑定刚建立时只回填这个 metadata 的局部时间窗，不扫描整个 DevSpace 历史库。 */
  auditsForMetadata(metadataId: string, startAtMs: number, endAtMs: number, limit = 500): DevSpaceAuditEvent[] {
    if (!this.open() || !this.db || !metadataId) return []
    const requestMetaExpr = this.hasRequestMetaJson ? 'request_meta_json' : 'NULL'
    const resultJsonExpr = this.hasResultJson ? 'result_json' : 'NULL'
    const errorExpr = this.hasError ? 'error' : 'NULL'
    const rows = this.db.prepare(`
      SELECT id, metadata_id AS metadataId, tool, args_json AS argsJson,
             ${resultJsonExpr} AS resultJson, ${errorExpr} AS error,
             started_at AS startedAt, finished_at AS finishedAt,
             ${requestMetaExpr} AS requestMetaJson
      FROM tool_audit
      WHERE metadata_id = ?
        AND started_at >= ?
        AND started_at <= ?
      ORDER BY started_at ASC, id ASC
      LIMIT ?
    `).all(
      metadataId,
      new Date(Math.max(0, startAtMs)).toISOString(),
      new Date(Math.max(startAtMs, endAtMs)).toISOString(),
      Math.max(1, Math.trunc(limit)),
    ) as Array<{
      id: string
      metadataId: string
      tool: string
      argsJson: string
      resultJson: string | null
      error: string | null
      startedAt: string
      finishedAt: string | null
      requestMetaJson: string | null
    }>
    return rows.flatMap(row => {
      const startedAtMs = Date.parse(row.startedAt)
      return Number.isFinite(startedAtMs) ? [{ ...row, startedAtMs }] : []
    })
  }

  activityBetween(startAtMs: number, endAtMs: number, limit = 500): DevSpaceMetadataActivity[] {
    if (!this.open() || !this.db) return []
    const start = new Date(Math.max(0, startAtMs)).toISOString()
    const end = new Date(Math.max(startAtMs, endAtMs)).toISOString()
    // Binding matcher 只需要 tool+args+started_at。旧实现调用 pollSince(start, 5000)
    // 后才在 JS 里 <= end 过滤，会把窗口之后的大量 result_json/request_meta 一并从
    // 800MiB DevSpace DB 搬出来；真实 ±2min 窗口最终只有 1~5 个 activity，却可耗时
    // 400~500ms。这里直接让 SQLite 用 started_at 索引做闭区间查询，并只选 matcher 字段。
    const traceIdExpr = this.hasTraceId ? 'trace_id' : 'NULL'
    const rows = this.db.prepare(`
      SELECT id, metadata_id AS metadataId, ${traceIdExpr} AS traceId, tool, args_json AS argsJson,
             started_at AS startedAt
      FROM tool_audit
      WHERE metadata_id IS NOT NULL
        AND metadata_id <> ''
        AND started_at >= ?
        AND started_at <= ?
      ORDER BY started_at ASC, id ASC
      LIMIT ?
    `).all(start, end, Math.max(1, Math.trunc(limit))) as Array<{
      id: string
      metadataId: string
      traceId: string | null
      tool: string
      argsJson: string
      startedAt: string
    }>
    return groupDevSpaceActivity(rows.flatMap(row => {
      const startedAtMs = Date.parse(row.startedAt)
      if (!Number.isFinite(startedAtMs)) return []
      return [{
        ...row,
        startedAtMs,
        resultJson: null,
        error: null,
        finishedAt: null,
        requestMetaJson: null,
      }]
    }))
  }

  /**
   * 返回 DevSpace 历史上出现过的所有 conversation metadata 摘要。
   *
   * 这一步只做 GROUP BY，不读取 args/result 大字段；用于 Archive 启动时把历史 metadata
   * 先 seed 进自己的 binding 表。真正身份判断仍由后续 exact tool+args matcher 完成。
   */
  metadataSummaries(limit = 10_000): DevSpaceMetadataSummary[] {
    if (!this.open() || !this.db) return []
    const rows = this.db.prepare(`
      SELECT metadata_id AS metadataId,
             MIN(started_at) AS firstAt,
             MAX(started_at) AS lastAt,
             COUNT(*) AS auditCount
      FROM tool_audit
      WHERE metadata_id IS NOT NULL
        AND metadata_id <> ''
      GROUP BY metadata_id
      ORDER BY MIN(started_at) ASC, metadata_id ASC
      LIMIT ?
    `).all(Math.max(1, Math.trunc(limit))) as Array<{
      metadataId: string
      firstAt: string
      lastAt: string
      auditCount: number
    }>
    return rows.flatMap(row => {
      const firstAt = Date.parse(row.firstAt)
      const lastAt = Date.parse(row.lastAt)
      if (!Number.isFinite(firstAt) || !Number.isFinite(lastAt)) return []
      return [{
        metadataId: row.metadataId,
        firstAt,
        lastAt,
        auditCount: Number(row.auditCount || 0),
      }]
    })
  }

  /**
   * 读取 DevSpace v12 已从 raw audit 回填出的 trace↔metadata 成员。
   *
   * 这是一次启动/迁移级的百行窄表扫描，不碰 args/result/requestMeta 大字段；用于 Archive
   * 首次升级 v8 时补回旧 schema 无法表达的第二 metadata 成员。DevSpace 未升级 v12 时
   * 安全返回空数组，未来 live audit 仍会逐步建立成员关系。
   */
  traceMetadataMembers(limit = 10_000): DevSpaceTraceMetadataMemberMirror[] {
    if (!this.open() || !this.db) return []
    if (!this.hasTraceMetadataMembersTable) {
      this.hasTraceMetadataMembersTable = Boolean(this.db.prepare(`
        SELECT 1 AS ok FROM sqlite_master
        WHERE type='table' AND name='chatgpt_trace_metadata_members'
        LIMIT 1
      `).get())
    }
    if (!this.hasTraceMetadataMembersTable) return []
    const rows = this.db.prepare(`
      SELECT trace_id AS traceId,
             metadata_id AS metadataId,
             first_seen_at AS firstSeenAt,
             last_seen_at AS lastSeenAt,
             first_audit_id AS firstAuditId,
             last_audit_id AS lastAuditId
      FROM chatgpt_trace_metadata_members
      ORDER BY first_seen_at ASC, trace_id ASC, metadata_id ASC
      LIMIT ?
    `).all(Math.max(1, Math.trunc(limit))) as Array<{
      traceId: string
      metadataId: string
      firstSeenAt: string
      lastSeenAt: string
      firstAuditId: string
      lastAuditId: string
    }>
    return rows.flatMap(row => {
      const firstSeenAt = Date.parse(row.firstSeenAt)
      const lastSeenAt = Date.parse(row.lastSeenAt)
      if (!Number.isFinite(firstSeenAt) || !Number.isFinite(lastSeenAt)) return []
      return [{
        traceId: row.traceId.trim().toLowerCase(),
        metadataId: row.metadataId,
        firstSeenAt,
        lastSeenAt,
        firstAuditId: row.firstAuditId,
        lastAuditId: row.lastAuditId,
      }]
    })
  }

  /**
   * Archive 是 binding 的 authoritative 推断端；DevSpace 这里只保存一份镜像。
   * 老 DevSpace 进程尚未跑新 migration 时表可能不存在，此时返回 false，稍后再镜像即可。
   */
  mirrorBinding(binding: DevSpaceConversationBindingMirror): boolean {
    if (!this.open() || !this.db) return false
    if (!this.hasBindingTable) {
      // DevSpace 可能在 Archive 已经常驻以后才完成热重载/migration；需要镜像时重新探测，
      // 避免因为启动瞬间缺表就一直等到 Archive 自己重启。
      this.hasBindingTable = Boolean(this.db.prepare(`
        SELECT 1 AS ok FROM sqlite_master
        WHERE type='table' AND name='chatgpt_conversation_bindings'
        LIMIT 1
      `).get())
    }
    if (!this.hasBindingTable) return false
    const observedAt = new Date(binding.observedAt).toISOString()
    this.db.prepare(`
      INSERT INTO chatgpt_conversation_bindings (
        metadata_id, conversation_id, turn_exchange_id,
        bound_at, last_verified_at, evidence, confidence
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(metadata_id) DO UPDATE SET
        conversation_id=excluded.conversation_id,
        turn_exchange_id=COALESCE(excluded.turn_exchange_id, chatgpt_conversation_bindings.turn_exchange_id),
        last_verified_at=excluded.last_verified_at,
        evidence=excluded.evidence,
        confidence=excluded.confidence
    `).run(
      binding.metadataId,
      binding.conversationId,
      binding.turnExchangeId ?? null,
      observedAt,
      observedAt,
      binding.evidence,
      binding.confidence,
    )
    return true
  }

  /**
   * 把 Archive 已 canonical verify 的 trace 身份镜像回 DevSpace。
   *
   * DevSpace 是本地 Recovery 的事实执行端，但 canonical CID/TID/RID 仍由 Archive 推断；
   * 因此这里只接受已验证关系，不在 DevSpace 侧自行猜 conversation/turn。旧生产 DevSpace 尚未
   * 部署 v12 时表不存在，返回 false 即可，不能反向阻塞 Archive 主链。
   */
  mirrorTraceBinding(binding: DevSpaceTraceBindingMirror): boolean {
    if (!this.open() || !this.db) return false
    if (!this.hasTraceBindingTable) {
      this.hasTraceBindingTable = Boolean(this.db.prepare(`
        SELECT 1 AS ok FROM sqlite_master
        WHERE type='table' AND name='chatgpt_trace_bindings'
        LIMIT 1
      `).get())
    }
    if (!this.hasTraceBindingTable) return false
    const observedAt = new Date(binding.observedAt).toISOString()
    this.db.prepare(`
      INSERT INTO chatgpt_trace_bindings (
        trace_id, conversation_id, turn_exchange_id, request_id,
        status, verified_at, evidence, confidence,
        first_seen_at, last_seen_at, conflict_reason
      ) VALUES (?, ?, ?, ?, 'verified', ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(trace_id) DO UPDATE SET
        conversation_id=excluded.conversation_id,
        turn_exchange_id=excluded.turn_exchange_id,
        request_id=COALESCE(excluded.request_id, chatgpt_trace_bindings.request_id),
        status='verified',
        verified_at=excluded.verified_at,
        evidence=excluded.evidence,
        confidence=excluded.confidence,
        first_seen_at=COALESCE(chatgpt_trace_bindings.first_seen_at, excluded.first_seen_at),
        last_seen_at=CASE
          WHEN chatgpt_trace_bindings.last_seen_at IS NULL THEN excluded.last_seen_at
          WHEN excluded.last_seen_at > chatgpt_trace_bindings.last_seen_at THEN excluded.last_seen_at
          ELSE chatgpt_trace_bindings.last_seen_at
        END,
        conflict_reason=NULL
    `).run(
      binding.traceId.trim().toLowerCase(),
      binding.conversationId,
      binding.turnExchangeId,
      binding.requestId ?? null,
      observedAt,
      binding.evidence,
      binding.confidence,
      observedAt,
      observedAt,
    )
    return true
  }

  close(): void {
    this.db?.close()
    this.db = null
  }
}
