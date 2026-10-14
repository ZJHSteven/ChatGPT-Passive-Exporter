import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { RequestEventLedger } from '../src/local/request-event-ledger.ts'

describe('RequestEventLedger', () => {
  test('只写结构化请求元数据，不需要正文或认证字段', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-request-ledger-'))
    const file = path.join(dir, 'events.jsonl')
    const ledger = new RequestEventLedger(file)

    await ledger.append({
      timestamp: 123456,
      source: 'archive-active',
      targetId: 'target-1',
      family: 'body',
      routeClass: 'body-latest',
      status: 429,
      retryAfter: '7',
      latencyMs: 42,
      backoffStage: -1,
    })
    await ledger.close()

    const rows = (await fs.readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(rows).toEqual([{
      timestamp: 123456,
      source: 'archive-active',
      targetId: 'target-1',
      family: 'body',
      routeClass: 'body-latest',
      status: 429,
      retryAfter: '7',
      latencyMs: 42,
      backoffStage: -1,
    }])
    expect(Object.keys(rows[0])).not.toEqual(expect.arrayContaining([
      'authorization',
      'cookie',
      'requestBody',
      'responseBody',
    ]))
  })
})

