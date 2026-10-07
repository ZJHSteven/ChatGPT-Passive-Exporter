import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  ArchiveBridgeServer,
  ensureArchiveBridgeAuthToken,
  type ArchiveBridgeDataSource,
  type ArchiveBridgeTurnInput,
} from '../src/local/archive-bridge.ts'

const TOKEN = 'test-token-that-is-long-enough-for-bridge-auth-1234567890'
const servers: ArchiveBridgeServer[] = []

function mockArchive(): ArchiveBridgeDataSource {
  return {
    list(limit = 50) {
      return [{
        id: 'cid-1',
        title: '测试会话',
        sourceFormat: 'messages',
        currentNode: 'm2',
        capturedAt: 200,
        importedAt: 210,
        messageCount: 3,
        resourceCount: 0,
      }].slice(0, limit)
    },
    getMessages(conversationId: string) {
      if (conversationId !== 'cid-1') return []
      return [
        {
          messageId: 'm1',
          ordinal: 1,
          role: 'user',
          recipient: 'all',
          channel: null,
          contentType: 'text',
          text: '你好',
          hidden: 0,
          createTime: 1,
          // 任意额外 raw 字段都不应该被 Bridge 原样透出。
          metadataJson: '{"secret":"must-not-leak"}',
        },
        {
          messageId: 'hidden',
          ordinal: 2,
          role: 'assistant',
          recipient: 'all',
          contentType: 'text',
          text: '内部隐藏消息',
          hidden: 1,
          createTime: 2,
        },
        {
          messageId: 'm2',
          ordinal: 3,
          role: 'assistant',
          recipient: 'all',
          contentType: 'text',
          text: '你好！',
          hidden: 0,
          createTime: 3,
        },
      ]
    },
  }
}

async function startBridge(
  submitTurn: (input: ArchiveBridgeTurnInput) => Promise<Record<string, unknown>> = async input => ({
    conversationId: input.conversationId ?? 'new-cid',
    cdpRequestId: '123.45',
  }),
) {
  const bridge = new ArchiveBridgeServer({
    archive: mockArchive(),
    authToken: TOKEN,
    submitTurn,
    host: '127.0.0.1',
    port: 0,
  })
  servers.push(bridge)
  await bridge.start()
  return {
    bridge,
    base: `http://127.0.0.1:${bridge.port}`,
    headers: { authorization: `Bearer ${TOKEN}` },
  }
}

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop()!
    await server.stop().catch(() => {})
  }
})

describe('Archive Bridge', () => {
  test('token 首次随机生成，后续重启复用同一份本地凭据', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-bridge-auth-'))
    const file = path.join(dir, 'auth.local.json')
    try {
      const first = await ensureArchiveBridgeAuthToken(file)
      const second = await ensureArchiveBridgeAuthToken(file)
      expect(first).toBe(second)
      expect(first.length).toBeGreaterThanOrEqual(32)
      const stored = JSON.parse(await fs.readFile(file, 'utf8'))
      expect(stored).toMatchObject({ version: 1, token: first })
      expect(typeof stored.createdAt).toBe('number')
    }
    finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test('health 不需要凭据，其余 API 必须 Bearer 鉴权', async () => {
    const { base } = await startBridge()
    const health = await fetch(`${base}/health`)
    expect(health.status).toBe(200)
    expect(await health.json()).toMatchObject({ ok: true, version: 1 })

    const denied = await fetch(`${base}/v1/conversations`)
    expect(denied.status).toBe(401)
    expect(denied.headers.get('www-authenticate')).toBe('Bearer')
  })

  test('conversation/messages 只暴露收缩后的 canonical 字段并过滤 hidden', async () => {
    const { base, headers } = await startBridge()
    const list = await fetch(`${base}/v1/conversations?limit=10`, { headers })
    expect(list.status).toBe(200)
    expect(await list.json()).toMatchObject({
      conversations: [{ id: 'cid-1', title: '测试会话' }],
    })

    const messages = await fetch(`${base}/v1/conversations/cid-1/messages`, { headers })
    expect(messages.status).toBe(200)
    const body = await messages.json() as { messages: Array<Record<string, unknown>> }
    expect(body.messages.map(item => item.messageId)).toEqual(['m1', 'm2'])
    expect(JSON.stringify(body)).not.toContain('must-not-leak')
    expect(JSON.stringify(body)).not.toContain('内部隐藏消息')
  })

  test('turn submit 校验输入，并把 cooldown 映射为 HTTP 429', async () => {
    const calls: ArchiveBridgeTurnInput[] = []
    const { base, headers } = await startBridge(async input => {
      calls.push(input)
      if (input.text === 'rate-limit') {
        throw new Error('ChatGPT actor blocked by active API cooldown until 2026-10-07T08:08:29.000Z')
      }
      return { conversationId: input.conversationId ?? 'new-cid', cdpRequestId: 'x.1' }
    })

    const invalid = await fetch(`${base}/v1/turns`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'steer', text: 'hello' }),
    })
    expect(invalid.status).toBe(400)

    const accepted = await fetch(`${base}/v1/turns`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'continue', conversationId: 'cid-1', text: '继续' }),
    })
    expect(accepted.status).toBe(202)
    expect(calls.at(-1)).toEqual({
      text: '继续',
      conversationId: 'cid-1',
      mode: 'continue',
      targetMode: 'guardian',
    })

    const limited = await fetch(`${base}/v1/turns`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'continue', conversationId: 'cid-1', text: 'rate-limit' }),
    })
    expect(limited.status).toBe(429)
  })

  test('SSE 先发 bridge-ready，再广播脱敏 lifecycle 事件', async () => {
    const { bridge, base, headers } = await startBridge()
    const controller = new AbortController()
    const response = await fetch(`${base}/v1/events`, { headers, signal: controller.signal })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()

    const first = decoder.decode((await reader.read()).value)
    expect(first).toContain('event: bridge-ready')

    bridge.publish({
      version: 1,
      at: 123,
      kind: 'live-transport',
      conversationId: 'cid-1',
      turnExchangeId: 'turn-1',
      requestId: 'req-1',
      event: 'message-stream-complete',
      transport: 'conversation',
    })
    const second = decoder.decode((await reader.read()).value)
    expect(second).toContain('event: live-transport')
    expect(second).toContain('"conversationId":"cid-1"')
    expect(second).not.toContain('token')

    controller.abort()
    await reader.cancel().catch(() => {})
  })
})

