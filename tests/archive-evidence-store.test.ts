import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  ArchiveEvidenceStore,
  prepareArchiveEvidence,
} from '../src/local/archive-evidence-store.ts'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

function tempEvidenceStore(): { dir: string, store: ArchiveEvidenceStore } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-archive-evidence-'))
  tempDirs.push(dir)
  return { dir, store: new ArchiveEvidenceStore(dir) }
}

describe('ArchiveEvidenceStore', () => {
  test('相同 raw payload 只保存一个 CAS blob，但每次 observation event 都永久保留', async () => {
    const { dir, store } = tempEvidenceStore()
    const payload = {
      conversation_id: 'cid-evidence',
      messages: [{ id: 'm1', content: { parts: ['同一份 ground truth'] } }],
    }
    const prepared = await prepareArchiveEvidence(payload)

    const first = await store.recordObservation({
      conversationId: 'cid-evidence',
      observationKind: 'body-page:passive-native',
      endpoint: '/backend-api/conversations/cid-evidence',
      observedAt: Date.UTC(2026, 9, 19, 8, 0, 0),
      prepared,
    })
    const second = await store.recordObservation({
      conversationId: 'cid-evidence',
      observationKind: 'body-page:wss:conversation-turn-complete',
      endpoint: '/backend-api/conversations/cid-evidence',
      observedAt: Date.UTC(2026, 9, 19, 8, 0, 1),
      prepared,
    })

    expect(first.sha256).toBe(second.sha256)
    expect(first.blobCreated).toBe(true)
    expect(second.blobCreated).toBe(false)
    expect(await store.readRawText(prepared.sha256)).toBe(JSON.stringify(payload))

    const eventPath = path.join(dir, 'events', '2026-10-19.jsonl')
    const events = (await fsp.readFile(eventPath, 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))
    expect(events).toHaveLength(2)
    expect(events.map(event => event.observationKind)).toEqual([
      'body-page:passive-native',
      'body-page:wss:conversation-turn-complete',
    ])
    expect(events.every(event => event.payload.sha256 === prepared.sha256)).toBe(true)

    const stats = store.stats()
    expect(stats.events).toBe(2)
    expect(stats.uniqueBlobsCreated).toBe(1)
    expect(stats.reusedBlobs).toBe(1)
    expect(stats.dedupeSavedBytes).toBe(prepared.compressed.byteLength)
    expect(stats.gzipBytesWritten).toBe(prepared.compressed.byteLength)
  })

  test('不同 payload 分别生成独立 immutable blob', async () => {
    const { store } = tempEvidenceStore()
    const first = await prepareArchiveEvidence({ value: 'A' })
    const second = await prepareArchiveEvidence({ value: 'B' })

    const firstStored = await store.recordObservation({
      observationKind: 'fixture-a',
      observedAt: Date.UTC(2026, 9, 19, 8, 1, 0),
      prepared: first,
    })
    const secondStored = await store.recordObservation({
      observationKind: 'fixture-b',
      observedAt: Date.UTC(2026, 9, 19, 8, 1, 1),
      prepared: second,
    })

    expect(firstStored.sha256).not.toBe(secondStored.sha256)
    expect(firstStored.blobCreated).toBe(true)
    expect(secondStored.blobCreated).toBe(true)
    expect(store.stats()).toMatchObject({
      events: 2,
      uniqueBlobsCreated: 2,
      reusedBlobs: 0,
      dedupeSavedBytes: 0,
    })
  })
})
