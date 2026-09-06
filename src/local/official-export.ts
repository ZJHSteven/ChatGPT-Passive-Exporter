/**
 * ChatGPT 官方 Data Export ZIP 的流式导入器。
 *
 * 为什么不先把 3GB ZIP 整体解压：
 * 1. 官方导出里大量 `.dat` 附件并不是建立 conversation SQLite 所必需；
 * 2. `conversations-xxx.json` 单片通常几十 MB，可以“逐片解压 → 解析 → 入库 → 释放”；
 * 3. 这样既避免额外占用数 GB 临时磁盘，也避免把整个 ZIP 一次读进内存。
 *
 * 数据完整性策略：
 * - conversations 分片：结构化导入所有 mapping branch，并保存每 conversation gzip raw snapshot；
 * - conversation_asset_file_names.json：结构化记录 asset ID → 原始路径；
 * - 其它 JSON（user/shared/group/codex/...）：保存 gzip source document；
 * - `.dat` 二进制本轮不重复塞进 SQLite，原始 ZIP 本身就是 lossless backing store，数据库保存 source_path。
 */
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { TextDecoder } from 'node:util'
import { Unzip, UnzipInflate, UnzipPassThrough } from 'fflate'
import type {
  ChatArchiveDb,
  OfficialBatchImportResult,
  SchemaFieldObservation,
} from './archive-db.ts'

export interface OfficialExportImportResult {
  zipPath: string
  sourceId: number
  observedAt: number
  skipped: boolean
  conversationCount: number
  nodeCount: number
  messageCount: number
  snapshotCount: number
  assetCount: number
  documentCount: number
}

type SchemaEntityKind = SchemaFieldObservation['entityKind']

function valueType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value === 'object' ? 'object' : typeof value
}

/**
 * schema 统计只记“某实体出现了哪些字段以及值类型”，不会保存正文内容。
 * 它的用途是回归：未来官方突然多一个字段，`archive schema` 一眼就能看到。
 */
class SchemaCollector {
  private readonly counts = new Map<string, number>()

  observe(kind: SchemaEntityKind, value: unknown): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return
    for (const [fieldName, fieldValue] of Object.entries(value as Record<string, unknown>)) {
      const key = `${kind}\u0000${fieldName}\u0000${valueType(fieldValue)}`
      this.counts.set(key, (this.counts.get(key) ?? 0) + 1)
    }
  }

  observeConversation(value: unknown): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return
    const conversation = value as Record<string, unknown>
    this.observe('conversation', conversation)
    const mapping = conversation.mapping
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) return

    for (const rawNode of Object.values(mapping as Record<string, unknown>)) {
      this.observe('node', rawNode)
      if (!rawNode || typeof rawNode !== 'object' || Array.isArray(rawNode)) continue
      const message = (rawNode as Record<string, unknown>).message
      this.observe('message', message)
      if (!message || typeof message !== 'object' || Array.isArray(message)) continue
      const messageRecord = message as Record<string, unknown>
      this.observe('author', messageRecord.author)
      this.observe('content', messageRecord.content)
      this.observe('metadata', messageRecord.metadata)
    }
  }

  toRows(): SchemaFieldObservation[] {
    return [...this.counts.entries()].map(([key, count]) => {
      const [entityKind, fieldName, fieldType] = key.split('\u0000')
      return {
        entityKind: entityKind as SchemaEntityKind,
        fieldName: fieldName ?? '',
        valueType: fieldType ?? 'unknown',
        count,
      }
    })
  }
}

function inferObservedAt(filePath: string, fileMtimeMs: number): number {
  const base = path.basename(filePath)
  // 新导出常见 `...-2026-09-01-11-07-52-xxxx.zip`；优先保留时分秒。
  const withTime = base.match(/(20\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})/)
  if (withTime) {
    const [, y, m, d, hh, mm, ss] = withTime
    return Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss))
  }
  const dateOnly = base.match(/(20\d{2})-(\d{2})-(\d{2})/)
  if (dateOnly) {
    const [, y, m, d] = dateOnly
    return Date.UTC(Number(y), Number(m) - 1, Number(d))
  }
  return Math.floor(fileMtimeMs)
}

function sourceKey(filePath: string, fileSize: number, fileMtimeMs: number): string {
  // 不对 3GB ZIP 每次做全文件 SHA；basename + size + mtime 足以作为本机幂等键。
  return `official-export:${path.basename(filePath)}:${fileSize}:${Math.floor(fileMtimeMs)}`
}

function isConversationPart(name: string): boolean {
  return /^conversations-\d+\.json$/i.test(path.basename(name))
}

function isJsonEntry(name: string): boolean {
  return name.toLowerCase().endsWith('.json') && !name.endsWith('/')
}

/** 把一个 ZIP entry 的 Uint8Array chunks 合并成连续字节。 */
function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.length
  }
  return merged
}

/**
 * 只解压被选中的 JSON entry；没有 `file.start()` 的 `.dat/chat.html` 会被跳过。
 * 使用同步 UnzipInflate 是刻意的：这样输入流 `end` 时，所有被选 entry 的 final 回调都已完成，
 * 不需要再维护一套 worker completion barrier。
 */
async function forEachJsonEntry(
  zipPath: string,
  onEntry: (name: string, data: Uint8Array) => void,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let failed = false
    const fail = (error: unknown) => {
      if (failed) return
      failed = true
      reject(error instanceof Error ? error : new Error(String(error)))
    }

    const unzip = new Unzip((file) => {
      if (!isJsonEntry(file.name)) return
      const chunks: Uint8Array[] = []
      let total = 0
      file.ondata = (error, chunk, final) => {
        if (error) {
          fail(error)
          return
        }
        chunks.push(chunk)
        total += chunk.length
        if (!final || failed) return
        try {
          onEntry(file.name, concatChunks(chunks, total))
        }
        catch (entryError) {
          fail(entryError)
        }
      }
      file.start()
    })
    unzip.register(UnzipInflate)
    unzip.register(UnzipPassThrough)

    const input = createReadStream(zipPath, { highWaterMark: 1024 * 1024 })
    input.on('error', fail)
    input.on('data', (chunk) => {
      if (failed) return
      try {
        // Node 的 Readable 类型允许 data 事件在设置 encoding 后返回 string；
        // 这里虽然没有给 createReadStream 设置 encoding，运行时实际拿到的一直是 Buffer，
        // 但 TypeScript 仍保守地把回调参数推成 `string | Buffer`。显式归一化后，
        // fflate 的 Unzip 永远只收到 Uint8Array，也让类型契约和真实运行行为一致。
        const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
        unzip.push(bytes, false)
      }
      catch (error) {
        input.destroy()
        fail(error)
      }
    })
    input.on('end', () => {
      if (failed) return
      try {
        unzip.push(new Uint8Array(0), true)
        resolve()
      }
      catch (error) {
        fail(error)
      }
    })
  })
}

/** 导入一份官方 ZIP；数据库来源登记、schema 覆盖率和 missing 标记在这里形成闭环。 */
export async function importOfficialExportZip(
  db: ChatArchiveDb,
  inputPath: string,
  options: { rebuildSearchIndexes?: boolean } = {},
): Promise<OfficialExportImportResult> {
  const absolute = path.resolve(inputPath)
  const file = await stat(absolute)
  if (!file.isFile()) throw new Error(`Official export is not a file: ${absolute}`)
  const observedAt = inferObservedAt(absolute, file.mtimeMs)
  const source = db.beginOfficialExportSource({
    sourceKey: sourceKey(absolute, file.size, file.mtimeMs),
    displayName: path.basename(absolute),
    sourcePath: absolute,
    fileSize: file.size,
    fileMtimeMs: file.mtimeMs,
    observedAt,
    metadata: { format: 'chatgpt-official-data-export-zip' },
  })

  if (source.alreadyComplete) {
    const row = db.getSource(source.sourceId)
    return {
      zipPath: absolute,
      sourceId: source.sourceId,
      observedAt,
      skipped: true,
      conversationCount: row?.conversationCount ?? 0,
      nodeCount: 0,
      messageCount: 0,
      snapshotCount: 0,
      assetCount: row?.assetCount ?? 0,
      documentCount: 0,
    }
  }

  const decoder = new TextDecoder('utf-8')
  const schema = new SchemaCollector()
  const totals: OfficialBatchImportResult = {
    conversationCount: 0,
    nodeCount: 0,
    messageCount: 0,
    snapshotCount: 0,
  }
  let assetCount = 0
  let documentCount = 0

  await forEachJsonEntry(absolute, (name, bytes) => {
    const parsed = JSON.parse(decoder.decode(bytes)) as unknown
    if (isConversationPart(name)) {
      if (!Array.isArray(parsed)) throw new Error(`${name} is not a conversation array`)
      for (const conversation of parsed) schema.observeConversation(conversation)
      const result = db.importOfficialBatch(source.sourceId, parsed, { observedAt, partName: path.basename(name) })
      totals.conversationCount += result.conversationCount
      totals.nodeCount += result.nodeCount
      totals.messageCount += result.messageCount
      totals.snapshotCount += result.snapshotCount
      return
    }

    if (path.basename(name).toLowerCase() === 'conversation_asset_file_names.json') {
      assetCount = db.saveOfficialAssetManifest(source.sourceId, parsed, observedAt)
      db.saveSourceDocument(source.sourceId, { name: path.basename(name), value: parsed })
      documentCount += 1
      return
    }

    // 其它 JSON 都很小，直接保存压缩原文；以后想解析 group/codex/feedback 不需要重新翻 ZIP。
    db.saveSourceDocument(source.sourceId, { name: path.basename(name), value: parsed })
    documentCount += 1
  })

  db.saveSchemaFieldStats(source.sourceId, schema.toRows())
  db.finalizeOfficialExportSource(source.sourceId, {
    conversationCount: totals.conversationCount,
    assetCount,
  })
  if (options.rebuildSearchIndexes !== false) db.rebuildSearchIndexes()

  return {
    zipPath: absolute,
    sourceId: source.sourceId,
    observedAt,
    skipped: false,
    ...totals,
    assetCount,
    documentCount,
  }
}

/** 多份 Genesis ZIP 总是按 observedAt 从旧到新导入，保证 canonical row 最终落在最新快照。 */
export async function importOfficialExportZips(
  db: ChatArchiveDb,
  zipPaths: string[],
): Promise<OfficialExportImportResult[]> {
  const candidates = await Promise.all(zipPaths.map(async (inputPath) => {
    const absolute = path.resolve(inputPath)
    const file = await stat(absolute)
    return { absolute, observedAt: inferObservedAt(absolute, file.mtimeMs) }
  }))
  candidates.sort((a, b) => a.observedAt - b.observedAt || a.absolute.localeCompare(b.absolute))

  const results: OfficialExportImportResult[] = []
  for (const candidate of candidates) {
    results.push(await importOfficialExportZip(db, candidate.absolute, { rebuildSearchIndexes: false }))
  }
  db.rebuildSearchIndexes()
  return results
}

