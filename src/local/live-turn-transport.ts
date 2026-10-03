import { createHash } from 'node:crypto'

export type LiveTransportKind = 'conversation' | 'resume' | 'turn-wss'
export type LiveTransportEventType =
  | 'stream-bound'
  | 'resume-token'
  | 'safety-review'
  | 'stream-handoff'
  | 'message-stream-complete'
  | 'done'
  | 'stream-finished'
  | 'stream-failed'

export interface LiveTransportEvent {
  version: 1
  at: number
  kind: 'live-transport'
  event: LiveTransportEventType
  transport: LiveTransportKind
  cdpRequestId: string
  requestStartedAt: number
  conversationId: string | null
  turnExchangeId: string | null
  bytesObserved: number
  pingCount: number
  resumeTokenSeen?: boolean
  resumeTokenLength?: number
  resumeTokenSha256?: string
  safetyReviewActive?: boolean | null
  protectionType?: string | null
  handoffTopics?: string[]
  loadingFailedReason?: string | null
}

function safeString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function findStringField(value: unknown, keys: string[], depth = 0): string | null {
  if (!value || depth > 5) return null
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = findStringField(child, keys, depth + 1)
      if (found) return found
    }
    return null
  }
  if (typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  for (const key of keys) {
    const found = safeString(record[key])
    if (found) return found
  }
  for (const child of Object.values(record)) {
    if (!child || typeof child !== 'object') continue
    const found = findStringField(child, keys, depth + 1)
    if (found) return found
  }
  return null
}

function handoffTopics(value: unknown): string[] {
  if (!value || typeof value !== 'object') return []
  const options = (value as Record<string, unknown>).options
  if (!Array.isArray(options)) return []
  return [...new Set(options
    .map(option => option && typeof option === 'object'
      ? safeString((option as Record<string, unknown>).topic_id ?? (option as Record<string, unknown>).topicId)
      : null)
    .filter((item): item is string => Boolean(item)))]
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * 只解析 ChatGPT SSE 的控制面，不保存 message/content/tool/reasoning 正文。
 *
 * 这个 parser 刻意不重建 assistant 文本；Archive canonical body 仍负责正文。Phase 3 在这里回答的
 * 是“流是否还活着、是否进入 review/handoff、resume credential 是否出现、怎样结束”。
 */
export class LiveTurnTransportTracker {
  readonly cdpRequestId: string
  readonly transport: LiveTransportKind
  readonly requestStartedAt: number

  private buffer = ''
  private conversationId: string | null = null
  private turnExchangeId: string | null = null
  private bytesObserved = 0
  private pingCount = 0
  private boundEmitted = false
  private doneSeen = false
  private lastSafetyActive: boolean | null | undefined = undefined
  private seenResumeHashes = new Set<string>()
  private seenHandoffTopics = new Set<string>()
  private readonly emit: (event: LiveTransportEvent) => void

  constructor(input: {
    cdpRequestId: string
    transport: LiveTransportKind
    requestStartedAt?: number
    emit: (event: LiveTransportEvent) => void
  }) {
    this.cdpRequestId = input.cdpRequestId
    this.transport = input.transport
    this.requestStartedAt = input.requestStartedAt ?? Date.now()
    this.emit = input.emit
  }

  ingestBase64(data: unknown, at = Date.now()): void {
    if (typeof data !== 'string' || !data) return
    this.ingestText(Buffer.from(data, 'base64').toString('utf8'), at)
  }

  ingestText(text: string, at = Date.now()): void {
    if (!text) return
    this.bytesObserved += Buffer.byteLength(text, 'utf8')
    this.buffer += text
    while (true) {
      const match = /\r?\n\r?\n/u.exec(this.buffer)
      if (!match || match.index === undefined) break
      const block = this.buffer.slice(0, match.index)
      this.buffer = this.buffer.slice(match.index + match[0].length)
      this.ingestBlock(block, at)
    }
  }

  finish(at = Date.now()): void {
    if (this.buffer.trim()) this.ingestBlock(this.buffer, at)
    this.buffer = ''
    this.emitEvent('stream-finished', at)
  }

  fail(reason: unknown, at = Date.now()): void {
    if (this.doneSeen) {
      this.emitEvent('stream-finished', at)
      return
    }
    this.emitEvent('stream-failed', at, {
      loadingFailedReason: safeString(reason) ?? String(reason ?? 'unknown').slice(0, 240),
    })
  }

  private ingestBlock(block: string, at: number): void {
    const trimmed = block.trim()
    if (!trimmed) return
    if (trimmed.startsWith(':')) {
      if (/^:\s*ping\b/iu.test(trimmed)) this.pingCount += 1
      return
    }

    const dataLines = block.split(/\r?\n/u)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart())
    if (dataLines.length === 0) return
    const joined = dataLines.join('\n').trim()
    if (joined === '[DONE]') {
      this.doneSeen = true
      this.emitEvent('done', at)
      return
    }

    // delta_encoding 等事件可能连续给多个独立 data JSON；先尝试合并，失败再逐行解析。
    const candidates = [joined, ...dataLines].filter((value, index, values) => value && values.indexOf(value) === index)
    for (const candidate of candidates) {
      let parsed: unknown
      try { parsed = JSON.parse(candidate) }
      catch { continue }
      if (!parsed || typeof parsed !== 'object') continue
      this.ingestObject(parsed as Record<string, unknown>, at)
    }
  }

  private ingestObject(value: Record<string, unknown>, at: number): void {
    const cid = findStringField(value, ['conversation_id', 'conversationId'])
    const tid = findStringField(value, ['turn_exchange_id', 'turnExchangeId'])
    if (cid) this.conversationId = cid
    if (tid) this.turnExchangeId = tid
    if (this.conversationId && !this.boundEmitted) {
      this.boundEmitted = true
      this.emitEvent('stream-bound', at)
    }

    const type = safeString(value.type)
    if (type === 'resume_conversation_token') {
      const token = safeString(value.token)
      if (!token) return
      const hash = sha256(token)
      if (this.seenResumeHashes.has(hash)) return
      this.seenResumeHashes.add(hash)
      this.emitEvent('resume-token', at, {
        resumeTokenSeen: true,
        resumeTokenLength: token.length,
        resumeTokenSha256: hash,
      })
      return
    }

    if (type === 'safety_review_update') {
      const active = typeof value.active === 'boolean' ? value.active : null
      if (active === this.lastSafetyActive) return
      this.lastSafetyActive = active
      this.emitEvent('safety-review', at, {
        safetyReviewActive: active,
        protectionType: safeString(value.protection_type ?? value.protectionType),
      })
      return
    }

    if (type === 'stream_handoff') {
      const topics = handoffTopics(value)
      const newTopics = topics.filter(topic => !this.seenHandoffTopics.has(topic))
      if (newTopics.length === 0 && this.seenHandoffTopics.size > 0) return
      for (const topic of topics) this.seenHandoffTopics.add(topic)
      this.emitEvent('stream-handoff', at, { handoffTopics: [...this.seenHandoffTopics].sort() })
      return
    }

    if (type === 'message_stream_complete') this.emitEvent('message-stream-complete', at)
  }

  private emitEvent(event: LiveTransportEventType, at: number, extra: Partial<LiveTransportEvent> = {}): void {
    this.emit({
      version: 1,
      at,
      kind: 'live-transport',
      event,
      transport: this.transport,
      cdpRequestId: this.cdpRequestId,
      requestStartedAt: this.requestStartedAt,
      conversationId: this.conversationId,
      turnExchangeId: this.turnExchangeId,
      bytesObserved: this.bytesObserved,
      pingCount: this.pingCount,
      ...extra,
    })
  }
}

