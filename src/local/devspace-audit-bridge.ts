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
  tool: string
  argsJson: string
  startedAt: string
  startedAtMs: number
  finishedAt: string | null
  requestMetaJson: string | null
}

export interface DevSpaceMetadataActivity {
  metadataId: string
  firstAt: number
  lastAt: number
  auditCount: number
  audits: DevSpaceAuditEvent[]
}

export interface DevSpaceConversationBindingMirror {
  metadataId: string
  conversationId: string
  turnExchangeId?: string | null
  evidence: string
  confidence: string
  observedAt: number
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
 * 当前 turn 已由 body 确认后，挑选唯一的未绑定 metadata 候选。
 *
 * 这里故意只做“唯一候选”而不是打分猜测：tool_audit 时间必须落在 turn 窗口内，
 * 且该 turn 必须真实出现过工具调用。若同时有两个 metadata 活跃，则返回 null，
 * 等后续更强 correlation metadata 或其它证据再解，不制造错误永久绑定。
 */
export function uniqueDevSpaceCandidateForTurn(input: {
  activities: DevSpaceMetadataActivity[]
  turnStartAt: number
  turnEndAt: number
  toolCallCount: number
  alreadyBoundMetadataIds?: Iterable<string>
  beforeSlackMs?: number
  afterSlackMs?: number
}): DevSpaceMetadataActivity | null {
  if (input.toolCallCount <= 0) return null
  const bound = new Set(input.alreadyBoundMetadataIds ?? [])
  const start = input.turnStartAt - (input.beforeSlackMs ?? 10_000)
  const end = input.turnEndAt + (input.afterSlackMs ?? 60_000)
  const candidates = input.activities.filter((activity) => {
    if (bound.has(activity.metadataId)) return false
    return activity.audits.some(audit => audit.startedAtMs >= start && audit.startedAtMs <= end)
  })
  return candidates.length === 1 ? candidates[0]! : null
}

export class DevSpaceAuditBridge {
  readonly dbPath: string
  private db: DatabaseSync | null = null
  private hasRequestMetaJson = false
  private hasBindingTable = false

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
    this.hasBindingTable = Boolean(db.prepare(`
      SELECT 1 AS ok FROM sqlite_master
      WHERE type='table' AND name='chatgpt_conversation_bindings'
      LIMIT 1
    `).get())
    this.db = db
    return true
  }

  pollSince(sinceAtMs: number, limit = 250): DevSpaceAuditEvent[] {
    if (!this.open() || !this.db) return []
    const requestMetaExpr = this.hasRequestMetaJson ? 'request_meta_json' : 'NULL'
    const rows = this.db.prepare(`
      SELECT id, metadata_id AS metadataId, tool, started_at AS startedAt,
             finished_at AS finishedAt, ${requestMetaExpr} AS requestMetaJson
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

  activityBetween(startAtMs: number, endAtMs: number, limit = 500): DevSpaceMetadataActivity[] {
    return groupDevSpaceActivity(
      this.pollSince(startAtMs, limit).filter(event => event.startedAtMs <= endAtMs),
    )
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

  close(): void {
    this.db?.close()
    this.db = null
  }
}
