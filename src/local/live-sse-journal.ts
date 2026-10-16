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
  preReadyChunkPath: string
  bytesWritten: number
  preReadyBytesWritten: number
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
  readonly preReadyChunkPath: string
  readonly identity: LiveSseJournalIdentity

  private readonly ready: Promise<fs.FileHandle>
  private writeTail: Promise<void>
  private metaTail: Promise<void>
  private preReadyTail: Promise<void>
  private bytesWritten = 0
  private preReadyBytesWritten = 0
  private closed = false

  constructor(rootDir: string, identity: LiveSseJournalIdentity) {
    this.identity = { ...identity }
    const dir = path.join(rootDir, utcDay(identity.startedAt))
    const key = safeFileToken(`${identity.targetId}\0${identity.cdpRequestId}\0${identity.startedAt}`)
    const base = `${identity.startedAt}-${identity.transport}-${key}`
    // 用局部常量喂给下面的异步初始化闭包。虽然实例字段在语义上已经先赋值，
    // TypeScript 对 constructor 内嵌 async closure 的 definite-assignment 分析不会做这层时序推断。
    const filePath = path.join(dir, `${base}.sse`)
    const metaPath = path.join(dir, `${base}.meta.jsonl`)
    const preReadyChunkPath = path.join(dir, `${base}.pre-ready.jsonl`)
    this.filePath = filePath
    this.metaPath = metaPath
    this.preReadyChunkPath = preReadyChunkPath

    this.ready = (async () => {
      await fs.mkdir(dir, { recursive: true })
      const handle = await fs.open(filePath, 'a')
      await fs.appendFile(metaPath, `${JSON.stringify({
        version: 1,
        event: 'stream-start',
        at: identity.startedAt,
        targetId: identity.targetId,
        cdpRequestId: identity.cdpRequestId,
        transport: identity.transport,
        file: path.basename(filePath),
      })}\n`)
      return handle
    })()
    this.writeTail = this.ready.then(() => undefined)
    this.metaTail = this.ready.then(() => undefined)
    this.preReadyTail = this.ready.then(() => undefined)
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
   * `Network.streamResourceContent()` 尚未完成时，Chrome 仍可能先发 `Network.dataReceived`。
   * 这些 chunk 在最终字节序里位于 `bufferedData` 之后，不能抢先写入 `.sse`，否则顺序会倒置；
   * 但如果只放内存 pending，daemon 在这几秒钟内崩溃又会丢掉已经观察到的字节。
   *
   * 所以 pre-ready chunk 立即写一份独立 WAL。每行只保存到达时间、顺序号、长度和 base64 原字节；
   * `streamResourceContent()` 成功后，调用方仍按 `bufferedData -> pending chunks` 的正确顺序写 `.sse`。
   * WAL 不参与正常解析，只用于 crash/recovery forensic；即使最终 `.sse` 完整，也保留它作为证据。
   */
  appendPreReadyBase64(data: unknown, input: { at?: number, sequence: number }): Promise<void> {
    if (typeof data !== 'string' || data.length === 0 || this.closed) return Promise.resolve()
    const bytes = Buffer.from(data, 'base64')
    const line = `${JSON.stringify({
      version: 1,
      at: input.at ?? Date.now(),
      sequence: input.sequence,
      bytes: bytes.byteLength,
      dataBase64: data,
    })}\n`
    const write = this.preReadyTail.then(async () => {
      await this.ready
      await fs.appendFile(this.preReadyChunkPath, line)
      this.preReadyBytesWritten += bytes.byteLength
    })
    this.preReadyTail = write.catch(() => undefined)
    return write
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
    await this.preReadyTail.catch(() => undefined)
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
      preReadyChunkPath: this.preReadyChunkPath,
      bytesWritten: this.bytesWritten,
      preReadyBytesWritten: this.preReadyBytesWritten,
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

