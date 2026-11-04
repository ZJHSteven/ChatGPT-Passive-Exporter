import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { ActorSubmissionQueue } from '../src/local/actor-submission-queue.ts'

const input = {
  text: '课堂原文', conversationId: 'cid-test', projectName: null,
  mode: 'continue' as const, targetMode: 'guardian' as const,
}

async function waitFor(queue: ActorSubmissionQueue, key: string, status: string) {
  const deadline = Date.now() + 4_000
  while (Date.now() < deadline) {
    if (queue.get(key)?.status === status) return queue.get(key)!
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`Timed out waiting for ${status}: ${JSON.stringify(queue.get(key))}`)
}

describe('Actor 有界自动恢复与幂等安全', () => {
  test('Guardian 未就绪和编辑器输入不一致由队列自动修复后完成，不转交 ClassFlow', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'actor-bounded-'))
    let attempts = 0
    const q = new ActorSubmissionQueue({
      filePath: path.join(dir, 'q.json'), autoRetry: true, maxAttempts: 4,
      pollIntervalMs: 10, retryBaseMs: 100, retryMaxMs: 1000,
      submitTurn: async () => {
        attempts++
        if (attempts === 1) throw new Error('ChatGPT Guardian target is not reachable through CDP')
        if (attempts === 2) throw new Error('CDP input verification failed before POST')
        return { conversationId: 'cid-test', responseStatus: 200 }
      },
    })
    try {
      await q.start()
      await q.enqueue('canary-summary', input)
      const accepted = await waitFor(q, 'canary-summary', 'accepted')
      expect(accepted.attemptCount).toBe(3)
      expect(attempts).toBe(3)
      expect(accepted.result).toMatchObject({ responseStatus: 200 })
    }
    finally { await q.stop(); await fs.rm(dir, { recursive: true, force: true }) }
  })

  test('持续失焦也最多四次，此后永久终止，重启不会复活', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'actor-bounded-'))
    const filePath = path.join(dir, 'q.json')
    let attempts = 0
    const mk = () => new ActorSubmissionQueue({
      filePath, autoRetry: true, maxAttempts: 4, pollIntervalMs: 10,
      retryBaseMs: 100, retryMaxMs: 1000,
      submitTurn: async () => { attempts++; throw new Error('CDP input verification failed before POST') },
    })
    try {
      const first = mk()
      await first.start()
      await first.enqueue('bad-composer', input)
      const failed = await waitFor(first, 'bad-composer', 'failed')
      expect(failed.attemptCount).toBe(4)
      expect(attempts).toBe(4)
      await first.stop()
      const restarted = mk()
      await restarted.start()
      await new Promise(resolve => setTimeout(resolve, 180))
      expect(restarted.get('bad-composer')?.status).toBe('failed')
      expect(attempts).toBe(4)
      await restarted.stop()
    }
    finally { await fs.rm(dir, { recursive: true, force: true }) }
  })

  test('HTTP 413 与正式 POST 结果未知均不盲目重发', async () => {
    for (const message of [
      'ChatGPT actor new request failed with HTTP 413',
      'ChatGPT actor submission outcome unknown after formal POST foo',
    ]) {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'actor-bounded-'))
      let attempts = 0
      const q = new ActorSubmissionQueue({
        filePath: path.join(dir, 'q.json'), autoRetry: true,
        pollIntervalMs: 10, retryBaseMs: 100,
        submitTurn: async () => { attempts++; throw new Error(message) },
      })
      try {
        await q.start()
        await q.enqueue('fatal-or-ambiguous', input)
        await waitFor(q, 'fatal-or-ambiguous', 'failed')
        expect(attempts).toBe(1)
      }
      finally { await q.stop(); await fs.rm(dir, { recursive: true, force: true }) }
    }
  })

  test('崩溃恢复中的 processing 未确认时不重放；旧失败和取消记录不复活', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'actor-bounded-'))
    const filePath = path.join(dir, 'q.json')
    let sent = 0
    const base = new ActorSubmissionQueue({
      filePath, autoRetry: false, pollIntervalMs: 10,
      submitTurn: async () => { sent++; throw new Error('CDP timed out') },
    })
    try {
      await base.start()
      await base.enqueue('operator-canceled', input)
      await waitFor(base, 'operator-canceled', 'failed')
      await base.stop()
      const state = JSON.parse(await fs.readFile(filePath, 'utf8'))
      state.records.push({ ...state.records[0], id: 'different', idempotencyKey: 'interrupted', status: 'processing' })
      await fs.writeFile(filePath, JSON.stringify(state))
      const restored = new ActorSubmissionQueue({
        filePath, autoRetry: true, maxAttempts: 4, pollIntervalMs: 10,
        submitTurn: async () => { sent++; return { responseStatus: 200 } },
        confirmTurn: async () => null,
      })
      await restored.start()
      await new Promise(resolve => setTimeout(resolve, 150))
      expect(restored.get('operator-canceled')?.status).toBe('failed')
      expect(restored.get('interrupted')?.status).toBe('failed')
      expect(restored.get('interrupted')?.lastError).toContain('canonical review required')
      expect(sent).toBe(1)
      await restored.stop()
    }
    finally { await fs.rm(dir, { recursive: true, force: true }) }
  })
})
