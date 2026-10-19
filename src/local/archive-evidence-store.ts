/**
 * Archive 冷取证存储：不可变 payload CAS + 逐观察事件 JSONL。
 *
 * 为什么不继续把大 raw JSON 塞进 Hot SQLite：
 * - canonical message / Watchdog / binding / FTS 属于日常热路径；
 * - raw conversation body / mapping snapshot 主要用于协议漂移与事故复盘，读取频率极低；
 * - 同一个 200KB~2MB body 会被 passive、WSS complete、watchdog、gap repair 重复观察，
 *   旧 live_observations 会为每个事件重复保存完整 gzip BLOB，导致容量随“观察次数”线性增长。
 *
 * 新模型把两种事实分开：
 * 1. payload 内容：按 raw JSON 的 SHA-256 寻址，压缩文件只保存一次；
 * 2. observation event：每次观察都 append 一条很小的 JSONL，保留时间/kind/endpoint/cursor。
 *
 * 写入顺序故意是“先 durable blob，后 event”：
 * - crash 在 blob 后、event 前，最多留下一个可 GC 的 orphan blob；
 * - 绝不会留下一个指向不存在 payload 的 event。
 *
 * 这里使用普通文件系统，而不是第二个 WAL SQLite。这样 Cold Evidence 不参与 Hot DB writer lock；
 * 同时避免依赖跨多个 WAL database 的 crash-atomic 语义。
 */

import fs from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { gzip, gunzip } from 'node:zlib'

export interface PreparedArchiveEvidence {
  rawText: string
  sha256: string
  compressed: Buffer
  rawBytes: number
}

export interface ArchiveEvidenceEventInput {
  conversationId?: string | null
  observationKind: string
  endpoint?: string | null
  pageCursor?: string | null
  observedAt: number
  prepared: PreparedArchiveEvidence
}

export interface StoredArchiveEvidence {
  eventId: string
  sha256: string
  relativePath: string
  rawBytes: number
  gzipBytes: number
  blobCreated: boolean
  eventRelativePath: string
}

export interface ArchiveEvidenceStoreStats {
  rootDir: string
  events: number
  uniqueBlobsCreated: number
  reusedBlobs: number
  rawBytesObserved: number
  gzipBytesObserved: number
  gzipBytesWritten: number
  dedupeSavedBytes: number
  lastWriteAt: number | null
  lastError: string | null
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function gzipAsync(input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    gzip(input, (error, result) => {
      if (error) reject(error)
      else resolve(result)
    })
  })
}

function gunzipAsync(input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    gunzip(input, (error, result) => {
      if (error) reject(error)
      else resolve(result)
    })
  })
}

/**
 * 在 zlib worker pool 中准备 raw JSON 证据。
 * JSON.stringify 本身仍是同步 JS，但大头 gzip 不再占用 daemon event loop。
 */
export async function prepareArchiveEvidence(payload: unknown): Promise<PreparedArchiveEvidence> {
  const rawText = JSON.stringify(payload)
  const input = Buffer.from(rawText, 'utf8')
  return {
    rawText,
    sha256: sha256Text(rawText),
    compressed: await gzipAsync(input),
    rawBytes: input.byteLength,
  }
}

/**
 * 外置 Cold Evidence 仓库。
 *
 * 目录布局：
 *   root/
 *     blobs/sha256/ab/cd/<64hex>.json.gz
 *     events/YYYY-MM-DD.jsonl
 *
 * 两级 hash 前缀避免单目录累计几十万文件；事件按 UTC 日期分片，便于 grep/归档/迁移。
 */
export class ArchiveEvidenceStore {
  readonly rootDir: string
  private readonly counters: ArchiveEvidenceStoreStats
  /**
   * 同一天多个 CDP response / WSS complete 可能并发写 observation event。
   * CAS blob 可并行准备，但 JSONL 时间线必须严格串行 append，避免两个 append 的完成顺序
   * 与调用顺序不一致，甚至在极端文件系统实现下出现行交叉。
   */
  private eventWriteTail: Promise<void> = Promise.resolve()

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir)
    this.counters = {
      rootDir: this.rootDir,
      events: 0,
      uniqueBlobsCreated: 0,
      reusedBlobs: 0,
      rawBytesObserved: 0,
      gzipBytesObserved: 0,
      gzipBytesWritten: 0,
      dedupeSavedBytes: 0,
      lastWriteAt: null,
      lastError: null,
    }
  }

  stats(): ArchiveEvidenceStoreStats {
    return { ...this.counters }
  }

  private blobRelativePath(sha256: string): string {
    const normalized = sha256.toLowerCase()
    if (!/^[0-9a-f]{64}$/u.test(normalized)) {
      throw new Error(`invalid SHA-256 evidence key: ${sha256}`)
    }
    return path.join('blobs', 'sha256', normalized.slice(0, 2), normalized.slice(2, 4), `${normalized}.json.gz`)
  }

  private eventRelativePath(observedAt: number): string {
    const date = new Date(observedAt)
    if (!Number.isFinite(date.getTime())) throw new Error(`invalid evidence observedAt: ${observedAt}`)
    return path.join('events', `${date.toISOString().slice(0, 10)}.jsonl`)
  }

  /**
   * 原子创建 CAS blob。
   *
   * 已存在同 SHA 文件时直接复用，不重新写盘。新 blob 先写随机临时文件并 fsync，再 rename；
   * 这样进程崩溃不会留下一个“文件名正确但内容只有一半”的正式 CAS 对象。
   */
  private async ensureBlob(prepared: PreparedArchiveEvidence): Promise<{ relativePath: string, created: boolean }> {
    const relativePath = this.blobRelativePath(prepared.sha256)
    const target = path.join(this.rootDir, relativePath)
    try {
      const existing = await fs.stat(target)
      if (existing.isFile() && existing.size > 0) return { relativePath, created: false }
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
    }

    await fs.mkdir(path.dirname(target), { recursive: true })
    const temp = `${target}.tmp-${process.pid}-${randomUUID()}`
    const handle = await fs.open(temp, 'wx')
    try {
      await handle.writeFile(prepared.compressed)
      await handle.sync()
    }
    finally {
      await handle.close()
    }

    try {
      await fs.rename(temp, target)
      return { relativePath, created: true }
    }
    catch (error) {
      // 单机正常只有一个 writer，但 CLI recovery / daemon 恰好并发时可能同时创建同一 SHA。
      // 若目标已由另一个 writer 成功创建，当前 temp 可以安全丢弃；其它错误继续向上抛。
      try {
        const existing = await fs.stat(target)
        if (existing.isFile() && existing.size > 0) {
          await fs.unlink(temp).catch(() => {})
          return { relativePath, created: false }
        }
      }
      catch {
        // 目标仍不存在，下面抛原始 rename 错误。
      }
      await fs.unlink(temp).catch(() => {})
      throw error
    }
  }

  private async appendEvent(eventPath: string, line: string): Promise<void> {
    const write = this.eventWriteTail
      .catch(() => {})
      .then(async () => {
        await fs.mkdir(path.dirname(eventPath), { recursive: true })
        const handle = await fs.open(eventPath, 'a')
        try {
          await handle.writeFile(line, 'utf8')
          await handle.sync()
        }
        finally {
          await handle.close()
        }
      })
    this.eventWriteTail = write.catch(() => {})
    await write
  }

  /**
   * 保存一次 observation：payload 去重，但 event 永不去重。
   */
  async recordObservation(input: ArchiveEvidenceEventInput): Promise<StoredArchiveEvidence> {
    const { prepared } = input
    try {
      const blob = await this.ensureBlob(prepared)
      const eventId = randomUUID()
      const eventRelativePath = this.eventRelativePath(input.observedAt)
      const eventPath = path.join(this.rootDir, eventRelativePath)

      const event = {
        version: 1,
        eventId,
        observedAt: Math.trunc(input.observedAt),
        conversationId: input.conversationId ?? null,
        observationKind: String(input.observationKind),
        endpoint: input.endpoint ?? null,
        pageCursor: input.pageCursor ?? null,
        payload: {
          sha256: prepared.sha256,
          relativePath: blob.relativePath.replaceAll('\\', '/'),
          rawBytes: prepared.rawBytes,
          gzipBytes: prepared.compressed.byteLength,
        },
      }
      await this.appendEvent(eventPath, `${JSON.stringify(event)}\n`)

      this.counters.events += 1
      this.counters.rawBytesObserved += prepared.rawBytes
      this.counters.gzipBytesObserved += prepared.compressed.byteLength
      if (blob.created) {
        this.counters.uniqueBlobsCreated += 1
        this.counters.gzipBytesWritten += prepared.compressed.byteLength
      }
      else {
        this.counters.reusedBlobs += 1
        this.counters.dedupeSavedBytes += prepared.compressed.byteLength
      }
      this.counters.lastWriteAt = Date.now()
      this.counters.lastError = null

      return {
        eventId,
        sha256: prepared.sha256,
        relativePath: blob.relativePath,
        rawBytes: prepared.rawBytes,
        gzipBytes: prepared.compressed.byteLength,
        blobCreated: blob.created,
        eventRelativePath,
      }
    }
    catch (error) {
      this.counters.lastError = error instanceof Error ? error.message : String(error)
      throw error
    }
  }

  /**
   * 取证/测试读取 helper。日常 Hot Reader 不应调用它；只有显式查看 raw evidence 才解压。
   */
  async readRawText(sha256: string): Promise<string> {
    const filePath = path.join(this.rootDir, this.blobRelativePath(sha256))
    return (await gunzipAsync(await fs.readFile(filePath))).toString('utf8')
  }
}
