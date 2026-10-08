import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { LifeOpsSyncClient, loadLifeOpsSyncConfig } from '../src/local/lifeops-sync.ts'

const tempDirs: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true })
})

async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lifeops-sync-'))
  tempDirs.push(dir)
  return dir
}

describe('LifeOps sync outbox', () => {
  test('配置文件缺失等价于未启用；有效配置会规范化 URL', async () => {
    const dir = await tempDir()
    expect(await loadLifeOpsSyncConfig(path.join(dir, 'missing.json'))).toBeNull()

    const configPath = path.join(dir, 'config.json')
    await fs.writeFile(configPath, JSON.stringify({
      enabled: true,
      baseUrl: 'https://lifeops.example.com/',
      accessClientId: 'id',
      accessClientSecret: 'secret',
      ingestToken: 'ingest',
    }))
    expect(await loadLifeOpsSyncConfig(configPath)).toMatchObject({
      baseUrl: 'https://lifeops.example.com',
      accessClientId: 'id',
      ingestToken: 'ingest',
    })
  })

  test('同一个 sourceEventId 会合并更新，成功后从持久 outbox 删除', async () => {
    const dir = await tempDir()
    const pendingPath = path.join(dir, 'pending.json')
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      expect(body.summary).toBe('new summary')
      expect((init?.headers as Record<string, string>)['cf-access-client-id']).toBe('id')
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    const client = new LifeOpsSyncClient({
      enabled: true,
      baseUrl: 'https://lifeops.example.com',
      accessClientId: 'id',
      accessClientSecret: 'secret',
      ingestToken: 'ingest',
    }, { fetchImpl, pendingPath })
    await client.start()
    client.enqueue({ sourceEventId: 'turn:c1:t1', conversationId: 'c1', turnExchangeId: 't1', title: 'Title', summary: 'old' })
    client.enqueue({ sourceEventId: 'turn:c1:t1', conversationId: 'c1', turnExchangeId: 't1', title: 'Title', summary: 'new summary' })
    await new Promise(resolve => setTimeout(resolve, 25))

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(client.pendingCount).toBe(0)
    // stop() 会等待最后一次持久化链完成；只有此后才把磁盘 outbox 视为稳定快照。
    await client.stop()
    const persisted = JSON.parse(await fs.readFile(pendingPath, 'utf8')) as { jobs: unknown[] }
    expect(persisted.jobs).toHaveLength(0)
  })

  test('失败会保留 outbox，不把 secret 写入队列文件', async () => {
    const dir = await tempDir()
    const pendingPath = path.join(dir, 'pending.json')
    const fetchImpl = vi.fn(async () => new Response('denied', { status: 503 })) as unknown as typeof fetch
    const client = new LifeOpsSyncClient({
      enabled: true,
      baseUrl: 'https://lifeops.example.com',
      accessClientId: 'sensitive-id',
      accessClientSecret: 'sensitive-secret',
      ingestToken: 'sensitive-ingest',
    }, { fetchImpl, pendingPath })
    await client.start()
    client.enqueue({ conversationId: 'c2', title: 'Conversation' })
    await new Promise(resolve => setTimeout(resolve, 25))

    expect(client.pendingCount).toBe(1)
    const text = await fs.readFile(pendingPath, 'utf8')
    expect(text).toContain('Conversation')
    expect(text).not.toContain('sensitive-secret')
    expect(text).not.toContain('sensitive-ingest')
    expect(text).not.toContain('sensitive-id')
    await client.stop()
  })

  test('metadata-only incident 可以先入 outbox，随后用同一 sourceEventId 补齐 conversation', async () => {
    const dir = await tempDir()
    const pendingPath = path.join(dir, 'pending.json')
    const bodies: Array<Record<string, unknown>> = []
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    const client = new LifeOpsSyncClient({
      enabled: true,
      baseUrl: 'https://lifeops.example.com',
      accessClientId: 'id',
      accessClientSecret: 'secret',
      ingestToken: 'ingest',
    }, { fetchImpl, pendingPath })
    await client.start()

    client.enqueue({
      sourceEventId: 'incident:metadata-1:watchdog',
      metadataId: 'metadata-1',
      inboxKind: 'incident',
      inboxHealth: 'incident',
      incidentType: 'active-zombie',
    })
    // 在第一轮网络 pump 前，用同一事件身份补齐 canonical identity；只应发送最新 payload。
    client.enqueue({
      sourceEventId: 'incident:metadata-1:watchdog',
      metadataId: 'metadata-1',
      conversationId: 'cid-1',
      turnExchangeId: 'turn-1',
      title: '后来绑定到真实聊天',
      inboxKind: 'incident',
      inboxHealth: 'incident',
      incidentType: 'active-zombie',
    })
    await new Promise(resolve => setTimeout(resolve, 25))

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(bodies[0]).toMatchObject({
      sourceEventId: 'incident:metadata-1:watchdog',
      metadataId: 'metadata-1',
      conversationId: 'cid-1',
      turnExchangeId: 'turn-1',
    })
    await client.stop()
  })
})

