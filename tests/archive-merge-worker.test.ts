import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test } from 'vitest'
import { ChatArchiveDb } from '../src/local/archive-db.ts'
import { ArchiveMergeWorker } from '../src/local/archive-merge-worker-client.ts'

const tempDirs: string[] = []
const workers: ArchiveMergeWorker[] = []

afterEach(async () => {
  while (workers.length > 0) await workers.pop()?.close()
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

function createDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-merge-worker-'))
  tempDirs.push(dir)
  const filePath = path.join(dir, 'archive.sqlite')
  const db = new ChatArchiveDb(filePath)
  db.close()
  return filePath
}

function payload(text = 'worker merge'): unknown {
  return {
    title: 'Worker merge',
    conversation_id: 'worker-conversation',
    current_node: 'a1',
    messages: [{
      id: 'a1',
      author: { role: 'assistant' },
      recipient: 'all',
      channel: 'final',
      status: 'finished',
      content: { content_type: 'text', parts: [text] },
      metadata: { turn_exchange_id: 'turn-worker' },
    }],
  }
}

describe('ArchiveMergeWorker', () => {
  test('production Node strip-only loader can import the worker client directly', () => {
    const root = path.resolve(import.meta.dirname, '..')
    expect(() => execFileSync(
      process.execPath,
      ['--input-type=module', '-e', "await import('./src/local/archive-merge-worker-client.ts')"],
      { cwd: root, stdio: 'pipe' },
    )).not.toThrow()
  })

  test('merges canonical payload through a separate SQLite connection', async () => {
    const filePath = createDbPath()
    const worker = new ArchiveMergeWorker(filePath)
    workers.push(worker)

    const merged = await worker.mergeMessages(payload(), { observedAt: 1_000 })
    expect(merged).toMatchObject({
      conversationId: 'worker-conversation',
      newMessageCount: 1,
      totalMessageCount: 1,
    })
    expect(worker.stats()).toMatchObject({ completed: 1, failed: 0, pending: 0 })
    expect(worker.stats().threadId).toBeTypeOf('number')

    const verify = new ChatArchiveDb(filePath)
    try {
      expect(verify.db.prepare(`
        SELECT text FROM messages
        WHERE conversation_id='worker-conversation' AND message_id='a1'
      `).get()).toEqual({ text: 'worker merge' })
    }
    finally {
      verify.close()
    }
  })

  test('persists DevSpace recovery audit through the same Archive writer worker', async () => {
    const filePath = createDbPath()
    const worker = new ArchiveMergeWorker(filePath)
    workers.push(worker)

    await worker.upsertRecoveryAudit({
      auditId: 'audit-worker-1',
      conversationId: 'conversation-worker',
      metadataId: 'metadata-worker',
      tool: 'exec_command',
      toolFingerprint: 'fingerprint-worker',
      argsJson: '{"cmd":"echo worker"}',
      resultJson: null,
      error: null,
      conclusion: null,
      startedAt: 1_000,
      finishedAt: null,
      observedAt: 1_100,
    })

    const verify = new ChatArchiveDb(filePath)
    try {
      expect(verify.listDevSpaceRecoveryAudits('conversation-worker', true)).toMatchObject([{
        auditId: 'audit-worker-1',
        metadataId: 'metadata-worker',
        tool: 'exec_command',
        startedAt: 1_000,
        finishedAt: null,
      }])
    }
    finally {
      verify.close()
    }
  })

  test('SQLite writer stall in recovery audit worker does not block the main event loop', async () => {
    const filePath = createDbPath()
    const worker = new ArchiveMergeWorker(filePath)
    workers.push(worker)

    await worker.upsertRecoveryAudit({
      auditId: 'warm-audit',
      conversationId: 'conversation-worker',
      metadataId: 'metadata-worker',
      tool: 'read',
      toolFingerprint: 'warm-fingerprint',
      argsJson: '{}',
      startedAt: 1_000,
      observedAt: 1_000,
    })

    const lock = new DatabaseSync(filePath)
    lock.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; BEGIN IMMEDIATE;')
    let timerFired = false
    const startedAt = performance.now()
    const writePromise = worker.upsertRecoveryAudit({
      auditId: 'blocked-audit',
      conversationId: 'conversation-worker',
      metadataId: 'metadata-worker',
      tool: 'exec_command',
      toolFingerprint: 'blocked-fingerprint',
      argsJson: '{"cmd":"blocked"}',
      startedAt: 2_000,
      observedAt: 2_000,
    })
    const release = new Promise<void>((resolve) => {
      setTimeout(() => {
        timerFired = true
        lock.exec('COMMIT')
        lock.close()
        resolve()
      }, 80)
    })

    await Promise.all([writePromise, release])
    expect(timerFired).toBe(true)
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(70)
    expect(worker.stats().lastWorkerMs).toBeGreaterThanOrEqual(60)
  })

  test('SQLite writer stall in merge worker does not block the main event loop', async () => {
    const filePath = createDbPath()
    const worker = new ArchiveMergeWorker(filePath)
    workers.push(worker)

    // Warm the worker first so startup/module loading cannot hide the writer-lock wait.
    await worker.mergeMessages(payload('warm worker'), { observedAt: 1_000 })

    const lock = new DatabaseSync(filePath)
    lock.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; BEGIN IMMEDIATE;')
    let timerFired = false
    const startedAt = performance.now()
    const mergePromise = worker.mergeMessages(payload('blocked worker'), { observedAt: 2_000 })
    const release = new Promise<void>((resolve) => {
      setTimeout(() => {
        timerFired = true
        lock.exec('COMMIT')
        lock.close()
        resolve()
      }, 80)
    })

    const [merged] = await Promise.all([mergePromise, release])
    expect(timerFired).toBe(true)
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(70)
    expect(merged.newMessageCount).toBe(0)
    expect(worker.stats().lastWorkerMs).toBeGreaterThanOrEqual(60)
  })
})
