import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import { ActorSubmissionQueue } from '../src/local/actor-submission-queue.ts'

test('disabled Actor auto retry never resends and never resurrects stale submissions', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-actor-no-retry-'))
  const filePath = path.join(dir, 'submissions.json')
  const key = 'classflow:lecture:test:summary:v2:0:initial'
  const input = { text: 'summary', conversationId: 'cid', projectName: null,
    mode: 'continue' as const, targetMode: 'guardian' as const }
  let attempts = 0
  const submitTurn = async (): Promise<Record<string, unknown>> => {
    attempts += 1
    throw new Error('CDP input verification failed before POST')
  }
  const makeQueue = () => new ActorSubmissionQueue({
    filePath, submitTurn, autoRetry: false, pollIntervalMs: 10,
    retryBaseMs: 20, retryMaxMs: 100,
  })
  try {
    const first = makeQueue()
    await first.start()
    await first.enqueue(key, input)
    const deadline = Date.now() + 2000
    while (first.get(key)?.status !== 'failed' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(first.get(key)?.status).toBe('failed')
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(attempts).toBe(1)
    await first.stop()

    const restarted = makeQueue()
    await restarted.start()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(restarted.get(key)?.status).toBe('failed')
    expect(attempts).toBe(1)
    await restarted.stop()

    // Legacy retry-waiting jobs must be terminated on the next launch.
    const oldState = JSON.parse(await fs.readFile(filePath, 'utf8'))
    oldState.records[0].status = 'retry_waiting'
    oldState.records[0].lastError = 'CDP timeout'
    oldState.records[0].nextAttemptAt = Date.now() - 1000
    await fs.writeFile(filePath, JSON.stringify(oldState))
    const recovered = makeQueue()
    await recovered.start()
    expect(recovered.get(key)?.status).toBe('failed')
    expect(recovered.get(key)?.lastError).toContain('automatic Actor retry disabled')
    expect(attempts).toBe(1)
    await recovered.stop()

    // Interrupted processing is also not replayed: the POST outcome may be unknown.
    const interrupted = JSON.parse(await fs.readFile(filePath, 'utf8'))
    interrupted.records[0].status = 'processing'
    await fs.writeFile(filePath, JSON.stringify(interrupted))
    const final = makeQueue()
    await final.start()
    expect(final.get(key)?.status).toBe('failed')
    expect(final.get(key)?.lastError).toContain('prior processing outcome unknown')
    expect(attempts).toBe(1)
    await final.stop()
  }
  finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
