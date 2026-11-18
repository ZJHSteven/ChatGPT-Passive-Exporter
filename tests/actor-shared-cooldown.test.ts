import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import { ActorSubmissionQueue } from '../src/local/actor-submission-queue.ts'
import { ActorPreSubmitCooldownError } from '../src/local/chatgpt-actor.ts'

/** 测试只使用临时文件和假的提交函数，不接入真实 ChatGPT，也不会产生任何 POST。 */
const input = {
  text: 'ClassFlow 标题生成回归测试',
  conversationId: 'existing-conversation',
  projectName: null,
  mode: 'continue' as const,
  targetMode: 'guardian' as const,
}

async function until<T>(read: () => T | null | undefined, accept: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    const value = read()
    if (value != null && accept(value)) return value
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('Actor 测试超时：预期状态未出现')
}

test('共享 Retry-After 未结束时只排队、不进浏览器、不扣除 Actor 尝试次数', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-actor-shared-gate-'))
  const filePath = path.join(dir, 'queue.json')
  const key = 'classflow:lecture:gate:title'
  const deadline = Date.now() + 230
  let actualRuns = 0
  const queue = new ActorSubmissionQueue({
    filePath, pollIntervalMs: 10, maxAttempts: 1,
    getNotBefore: () => deadline,
    submitTurn: async () => {
      actualRuns += 1
      return { conversationId: 'existing-conversation', accepted: true }
    },
  })
  try {
    await queue.start()
    await queue.enqueue(key, input)
    const deferred = await until(() => queue.get(key), record => record.status === 'retry_waiting')
    expect(deferred.attemptCount).toBe(0)
    expect(actualRuns).toBe(0)
    expect(deferred.nextAttemptAt).toBe(deadline)
    const accepted = await until(() => queue.get(key), record => record.status === 'accepted')
    expect(accepted.attemptCount).toBe(1)
    expect(actualRuns).toBe(1)
  }
  finally {
    await queue.stop()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('导航前的新冷却属于未正式提交，退还次数；真实 POST 429 不退还', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-actor-budget-gate-'))
  const firstKey = 'classflow:lecture:late-gate:title'
  let calls = 0
  const queue = new ActorSubmissionQueue({
    filePath: path.join(dir, 'queue.json'),
    pollIntervalMs: 10, maxAttempts: 1,
    submitTurn: async () => {
      calls += 1
      if (calls === 1) {
        throw new ActorPreSubmitCooldownError(new Date(Date.now() + 140).toISOString())
      }
      return { conversationId: 'existing-conversation', accepted: true }
    },
  })
  try {
    await queue.start()
    await queue.enqueue(firstKey, input)
    const deferred = await until(() => queue.get(firstKey), record => record.status === 'retry_waiting')
    expect(deferred.attemptCount).toBe(0)
    const accepted = await until(() => queue.get(firstKey), record => record.status === 'accepted')
    expect(accepted.attemptCount).toBe(1)
    expect(calls).toBe(2)
  }
  finally {
    await queue.stop()
  }

  let realPostAttempts = 0
  const real = new ActorSubmissionQueue({
    filePath: path.join(dir, 'real-post.json'),
    pollIntervalMs: 10, maxAttempts: 1,
    submitTurn: async () => {
      realPostAttempts += 1
      throw new Error('ChatGPT actor formal POST received HTTP 429')
    },
  })
  try {
    await real.start()
    await real.enqueue('classflow:lecture:actual-post:title', input)
    const failed = await until(() => real.get('classflow:lecture:actual-post:title'), record => record.status === 'failed')
    expect(failed.attemptCount).toBe(1)
    expect(realPostAttempts).toBe(1)
  }
  finally {
    await real.stop()
    await fs.rm(dir, { recursive: true, force: true })
  }
})
