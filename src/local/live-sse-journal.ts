import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

export type LiveSseJournalTransport = 'conversation' | 'resume' | 'turn-wss'

export interface LiveSseJournalIdentity {
  targetId: string
  cdpRequestId: string
  transport: LiveSseJournalTransport
  startedAt: number
}

export interface LiveSseJournalMark {
  event: string
  at?: number
  conversationId?: string | null
  turnExchangeId?: string | null
  bytesObserved?: number
  detail?: Record<string, unknown>
}

export interface LiveSseJournalSnapshot {
  filePath: string
  metaPath: string
  bytesWritten: number
  closed: boolean
}

function safeFileToken(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function utcDay(at: number): string {
  const date = new Date(at)
  if (!Number.isFinite(date.getTime())) return 'unknown-date'
  return date.toISOString().slice(0, 10)
}

/**
 * 一个 stream 对应一对本地文件：
 *
 * - `*.sse`：按浏览器实际到达顺序追加的 SSE 原始 UTF-8 字节；
 * - `*.meta.jsonl`：start/bound/done/fail 等极少量索引事件。
 *
 * 这里故意不把正文塞进 ActiveTurnRecorder。后者是可长期扫描的轻量控制面，
 * 而 SSE journal 是“黑匣子”证据，允许包含完整 assistant/tool/reasoning 正文以及
 * resume capability。两者物理分离后，普通诊断命令不会无意间把整段聊天正文打印出来。
 *
 * 每个 append 都立即排进 FileHandle.write()；不在内存里等待整条 turn 完成后再一次性写。
 * 因此 Node/Chrome/网络异常中断时，已经交给 OS 的前缀仍会留在 `.sse` 文件中。
 * finalize() 会额外 fsync + close；正常收口时把最后一小段 page cache 也明确刷到磁盘。
 */
export class LiveSseJournalStream {
  readonly filePath: string
  readonly metaPath: string
  readonly identity: LiveSseJournalIdentity

  private readonly ready: Promise<fs.FileHandle>
  private writeTail: Promise<void>
  private metaTail: Promise<void>
  private bytesWritten = 0
  private closed = false

  constructor(rootDir: string, identity: LiveSseJournalIdentity) {
    this.identity = { ...identity }
    const dir = path.join(rootDir, utcDay(identity.startedAt))
    const key = safeFileToken(`${identity.targetId}\0${identity.cdpRequestId}\0${identity.startedAt}`)
    const base = `${identity.startedAt}-${identity.transport}-${key}`
    this.filePath = path.join(dir, `${base}.sse`)
    this.metaPath = path.join(dir, `${base}.meta.jsonl`)

    this.ready = (async () => {
      await fs.mkdir(dir, { recursive: true })
      const handle = await fs.open(this.filePath, 'a')
      await fs.appendFile(this.metaPath, `${JSON.stringify({
        version: 1,
        event: 'stream-start',
        at: identity.startedAt,
        targetId: identity.targetId,
        cdpRequestId: identity.cdpRequestId,
        transport: identity.transport,
        file: path.basename(this.filePath),
      })}\n`)
      return handle
    })()
    this.writeTail = this.ready.then(() => undefined)
    this.metaTail = this.ready.then(() => undefined)
  }

  /** 追加已经解码好的 SSE 文本。turn-WSS 的 encoded_item 走这里。 */
  appendText(text: unknown): Promise<void> {
    if (typeof text !== 'string' || text.length === 0 || this.closed) return Promise.resolve()
    const bytes = Buffer.from(text, 'utf8')
    return this.appendBytes(bytes)
  }

  /** 追加 CDP `streamResourceContent` / `dataReceived.data` 提供的 base64 字节。 */
  appendBase64(data: unknown): Promise<void> {
    if (typeof data !== 'string' || data.length === 0 || this.closed) return Promise.resolve()
    return this.appendBytes(Buffer.from(data, 'base64'))
  }

  /**
   * 写低频索引事件。detail 只允许控制面字段；调用方不要把 message/content/raw SSE 塞进 meta。
   * 元数据和正文各自串行，meta 写失败不会破坏正文 writeTail。
   */
  mark(mark: LiveSseJournalMark): Promise<void> {
    if (!mark?.event) return Promise.resolve()
    const line = `${JSON.stringify({
      version: 1,
      event: mark.event,
      at: mark.at ?? Date.now(),
      conversationId: mark.conversationId ?? null,
      turnExchangeId: mark.turnExchangeId ?? null,
      bytesObserved: mark.bytesObserved ?? this.bytesWritten,
      ...(mark.detail ? { detail: mark.detail } : {}),
    })}\n`
    const write = this.metaTail.then(() => fs.appendFile(this.metaPath, line))
    this.metaTail = write.catch(() => undefined)
    return write
  }

  /** 正常或异常收口。重复调用安全；finalize 永远等待此前排队的正文写完。 */
  async finalize(mark: LiveSseJournalMark): Promise<LiveSseJournalSnapshot> {
    if (this.closed) return this.snapshot()
    this.closed = true
    const handle = await this.ready
    await this.writeTail
    await this.mark({
      ...mark,
      bytesObserved: mark.bytesObserved ?? this.bytesWritten,
    }).catch(() => undefined)
    await this.metaTail.catch(() => undefined)
    await handle.sync()
    await handle.close()
    return this.snapshot()
  }

  snapshot(): LiveSseJournalSnapshot {
    return {
      filePath: this.filePath,
      metaPath: this.metaPath,
      bytesWritten: this.bytesWritten,
      closed: this.closed,
    }
  }

  private appendBytes(bytes: Buffer): Promise<void> {
    if (bytes.byteLength === 0) return Promise.resolve()
    const write = this.writeTail.then(async () => {
      const handle = await this.ready
      await handle.write(bytes)
      this.bytesWritten += bytes.byteLength
    })
    // 一次磁盘错误只拒绝当前 append；后续调用仍可继续尝试，避免 Promise tail 被永久毒死。
    this.writeTail = write.catch(() => undefined)
    return write
  }
}

