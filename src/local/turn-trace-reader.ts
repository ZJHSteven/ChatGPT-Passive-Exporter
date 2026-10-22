import fs from 'node:fs/promises'
import type { ActiveTurnTrace, BodySnapshotTrace, WssLifecycleTrace } from './active-turn-recorder'

export interface CompletionBurstItem {
  conversationId: string
  completeAt: number
  activeBefore: number
  requestId: string | null
  turnExchangeId: string | null
  bodyCompletionEvidence: string | null
  tailShape: string | null
}

export interface CompletionBurst {
  startAt: number
  endAt: number
  durationMs: number
  count: number
  conversations: string[]
  maxObservedActiveBefore: number
  items: CompletionBurstItem[]
}

function isTraceRecord(value: unknown): value is ActiveTurnTrace {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return record.version === 1
    && typeof record.at === 'number'
    && typeof record.kind === 'string'
    && typeof record.conversationId === 'string'
}

/**
 * 解析 JSONL 时逐行容错：一次进程崩溃最多可能留下最后一行截断，不能因此让整份事故账本不可读。
 */
export function parseTurnTraceLines(text: string): ActiveTurnTrace[] {
  const records: ActiveTurnTrace[] = []
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line)
      if (isTraceRecord(parsed)) records.push(parsed)
    }
    catch {
      // 忽略单行损坏/半写入；其它完整行仍可用于事故取证。
    }
  }
  return records.sort((a, b) => a.at - b.at)
}

/**
 * 只读取文件尾部，避免长期运行几个月后每次 CLI 查看都把整份 JSONL 读进内存。
 */
export async function readTurnTraceTail(filePath: string, maxBytes = 2 * 1024 * 1024): Promise<ActiveTurnTrace[]> {
  const handle = await fs.open(filePath, 'r')
  try {
    const stat = await handle.stat()
    const bytes = Math.min(stat.size, Math.max(1, maxBytes))
    const start = Math.max(0, stat.size - bytes)
    const buffer = Buffer.alloc(bytes)
    await handle.read(buffer, 0, bytes, start)
    let text = buffer.toString('utf8')
    // 从文件中段开始读时，第一行可能只有后半截；直接丢掉它，避免误报 JSON parse error。
    if (start > 0) {
      const firstNewline = text.indexOf('\n')
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : ''
    }
    return parseTurnTraceLines(text)
  }
  finally {
    await handle.close()
  }
}

function bodySnapshotsByConversation(records: ActiveTurnTrace[]): Map<string, BodySnapshotTrace[]> {
  const result = new Map<string, BodySnapshotTrace[]>()
  for (const record of records) {
    if (record.kind !== 'body-snapshot') continue
    const list = result.get(record.conversationId) ?? []
    list.push(record)
    result.set(record.conversationId, list)
  }
  return result
}

function diagnosticAfter(
  snapshots: BodySnapshotTrace[] | undefined,
  completeAt: number,
  maxDelayMs: number,
): BodySnapshotTrace | null {
  if (!snapshots) return null
  return snapshots.find(record => record.at >= completeAt && record.at - completeAt <= maxDelayMs) ?? null
}

/**
 * 把相邻 complete 聚成“批量收口簇”。例如 2026-09-18 的三个异常 conversation 在 16 秒内
 * 先后 complete，这里会直接给出同一个 burst，而不必再人工对三份 daemon log。
 */
export function clusterCompletionBursts(
  records: ActiveTurnTrace[],
  clusterMs = 30_000,
  diagnosticDelayMs = 120_000,
): CompletionBurst[] {
  const completes = records
    .filter((record): record is WssLifecycleTrace => (
      record.kind === 'wss-lifecycle' && record.completesTurn
    ))
    .sort((a, b) => a.at - b.at)
  const snapshots = bodySnapshotsByConversation(records)
  const groups: WssLifecycleTrace[][] = []
  let current: WssLifecycleTrace[] = []

  for (const record of completes) {
    const previous = current.at(-1)
    if (!previous || record.at - previous.at <= clusterMs) current.push(record)
    else {
      if (current.length >= 2) groups.push(current)
      current = [record]
    }
  }
  if (current.length >= 2) groups.push(current)

  return groups.map((group) => {
    const startAt = group[0]!.at
    const endAt = group.at(-1)!.at
    const items = group.map((record) => {
      const body = diagnosticAfter(snapshots.get(record.conversationId), record.at, diagnosticDelayMs)
      return {
        conversationId: record.conversationId,
        completeAt: record.at,
        activeBefore: record.activeBefore,
        requestId: body?.requestId ?? null,
        turnExchangeId: body?.turnExchangeId ?? null,
        bodyCompletionEvidence: body?.bodyCompletionEvidence ?? null,
        tailShape: body?.tailShape ?? null,
      }
    })
    return {
      startAt,
      endAt,
      durationMs: endAt - startAt,
      count: group.length,
      conversations: [...new Set(group.map(record => record.conversationId))],
      maxObservedActiveBefore: Math.max(...group.map(record => record.activeBefore)),
      items,
    }
  })
}

