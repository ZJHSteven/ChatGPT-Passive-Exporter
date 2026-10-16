import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { LiveSseJournalStream } from '../src/local/live-sse-journal.ts'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })))
})

describe('LiveSseJournalStream', () => {
  test('按调用顺序实时追加原始 SSE，并在 finalize 后保留完整字节', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-live-sse-'))
    tempDirs.push(root)
    const stream = new LiveSseJournalStream(root, {
      targetId: 'target-1',
      cdpRequestId: '123.45',
      transport: 'conversation',
      startedAt: Date.UTC(2026, 9, 16, 8, 0, 0),
    })

    const first = 'data: {"conversation_id":"c1","message":{"id":"m1"}}\n\n'
    const second = 'data: [DONE]\n\n'
    await Promise.all([
      stream.appendBase64(Buffer.from(first).toString('base64')),
      stream.appendText(second),
    ])

    // finalize 之前就已经是 append-only 文件；不要求整条 turn 完成才出现正文。
    expect(await fs.readFile(stream.filePath, 'utf8')).toBe(first + second)

    const snapshot = await stream.finalize({
      event: 'stream-finished',
      conversationId: 'c1',
      bytesObserved: Buffer.byteLength(first + second),
    })
    expect(snapshot.closed).toBe(true)
    expect(snapshot.bytesWritten).toBe(Buffer.byteLength(first + second))
    expect(await fs.readFile(snapshot.filePath, 'utf8')).toBe(first + second)

    const meta = (await fs.readFile(snapshot.metaPath, 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))
    expect(meta[0]).toMatchObject({
      event: 'stream-start',
      targetId: 'target-1',
      cdpRequestId: '123.45',
      transport: 'conversation',
    })
    expect(meta.at(-1)).toMatchObject({
      event: 'stream-finished',
      conversationId: 'c1',
      bytesObserved: Buffer.byteLength(first + second),
    })
  })

  test('低频 mark 不混入正文，关闭后重复 append/finalize 也不会破坏已保存前缀', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-live-sse-'))
    tempDirs.push(root)
    const stream = new LiveSseJournalStream(root, {
      targetId: 'target-2',
      cdpRequestId: 'wss:1:topic',
      transport: 'turn-wss',
      startedAt: Date.UTC(2026, 9, 16, 8, 1, 0),
    })

    await stream.appendText('data: {"conversation_id":"c2"}\n\n')
    await stream.mark({ event: 'stream-bound', conversationId: 'c2', turnExchangeId: 't2' })
    await stream.finalize({ event: 'stream-failed', conversationId: 'c2', detail: { reason: 'socket-closed' } })

    const before = await fs.readFile(stream.filePath, 'utf8')
    await stream.appendText('data: SHOULD-NOT-APPEAR\n\n')
    const again = await stream.finalize({ event: 'ignored-second-finalize' })
    expect(await fs.readFile(stream.filePath, 'utf8')).toBe(before)
    expect(again.closed).toBe(true)

    const metaText = await fs.readFile(stream.metaPath, 'utf8')
    expect(metaText).toContain('stream-bound')
    expect(metaText).toContain('stream-failed')
    expect(metaText).not.toContain('SHOULD-NOT-APPEAR')
  })
})

