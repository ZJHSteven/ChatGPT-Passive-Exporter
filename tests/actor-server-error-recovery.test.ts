import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { recoverRecentActorSseErrors } from '../src/local/actor-server-error-recovery.ts'
import type { ActorSubmissionServerError } from '../src/local/actor-submission-queue.ts'

const dirs: string[] = []
afterEach(async () => {
  while (dirs.length) await fs.rm(dirs.pop()!, { recursive: true, force: true })
})

test('历史 SSE 错误可恢复且不需任何网页请求，空文件和超大流会被跳过', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-sse-error-recovery-'))
  dirs.push(root)
  const folder = path.join(root, '2026-10-29')
  await fs.mkdir(folder)
  const stream = [
    'data: "v1"',
    '',
    'data: ' + JSON.stringify({
      o: 'add', p: '', c: 0,
      v: {
        conversation_id: 'cid-old',
        message: {
          id: 'user-old',
          author: { role: 'user' },
          content: { content_type: 'text', parts: ['old prompt'] },
          metadata: { turn_exchange_id: 'turn-old', request_id: 'req-old' },
        },
      },
    }),
    '',
    'data: ' + JSON.stringify({
      conversation_id: 'cid-old',
      error: '你提交的消息过长，请编辑后重新发送。',
      error_code: 'input_too_large',
      error_reason: 'last_user_message',
    }),
    '',
    '',
  ].join('\n')
  await fs.writeFile(path.join(folder, 'old.sse'), stream, 'utf8')
  await fs.writeFile(path.join(folder, 'old.meta.jsonl'), '{}\n', 'utf8')
  await fs.writeFile(path.join(folder, 'empty.sse'), '', 'utf8')
  await fs.writeFile(path.join(folder, 'empty.meta.jsonl'), '{}\n', 'utf8')
  const recovered: ActorSubmissionServerError[] = []
  const result = await recoverRecentActorSseErrors(root, async error => {
    recovered.push(error)
  }, { maxFileBytes: 2048 })
  expect(result).toEqual({ checked: 1, recovered: 1 })
  expect(recovered[0]).toMatchObject({
    conversationId: 'cid-old',
    turnExchangeId: 'turn-old',
    code: 'input_too_large',
    reason: 'last_user_message',
  })
  const skipped = await recoverRecentActorSseErrors(root, async error => {
    recovered.push(error)
  }, { maxFileBytes: 40 })
  expect(skipped).toEqual({ checked: 0, recovered: 0 })
  expect(recovered).toHaveLength(1)
})
