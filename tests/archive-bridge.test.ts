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
        terminalState: 'final',
        incidentState: null,
        lastFinishType: 'stop',
        lastFinishReason: null,
        lastReasoningStatus: 'finished',
      }].slice(0, limit)
    },
    search(query: string, limit = 20) {
      if (!query.includes('测试')) return []
      return [{
        conversationId: 'cid-1',
        messageId: 'm2',
        title: '测试会话',
        role: 'assistant',
        text: '你好！',
        rank: 0,
      }].slice(0, limit)
    },
    listIncidents() {
      return []
    },
    listActiveWatchdogs() {
      return []
    },
    getResources(conversationId: string) {
      if (conversationId !== 'cid-1') return []
      return [{
        messageId: 'm2',
        ordinal: 1,
        kind: 'web-search',
        label: '搜索测试',
        data: { query: '测试', sourceCount: 3 },
      }]
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
          turnExchangeId: 'turn-1',
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
          turnExchangeId: 'turn-1',
          finishType: 'stop',
          reasoningStatus: 'finished',
        },
        {
          messageId: 'reasoning-internal',
          ordinal: 4,
          role: 'assistant',
          recipient: 'assistant',
          channel: 'analysis',
          contentType: 'reasoning',
          text: '这里是模型内部推理，Reader 绝不能显示',
          hidden: 0,
          createTime: 2.5,
          turnExchangeId: 'turn-1',
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
  archive: ArchiveBridgeDataSource = mockArchive(),
  options: {
    submissionQueuePath?: string
    submissionQueuePollIntervalMs?: number
  } = {},
) {
  const bridge = new ArchiveBridgeServer({
    archive,
    authToken: TOKEN,
    submitTurn,
    host: '127.0.0.1',
    port: 0,
    submissionQueuePath: options.submissionQueuePath,
    submissionQueuePollIntervalMs: options.submissionQueuePollIntervalMs,
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
  test('未绑定 DevSpace metadata 作为 provisional conversation 出现在列表、详情和消息 API', async () => {
    const archive = mockArchive()
    archive.listDevSpaceRecoveryVirtualConversations = () => [{
      id: 'devspace-meta/abc123',
      title: '尚未绑定的工作流',
      sourceFormat: 'devspace-provisional',
      currentNode: null,
      capturedAt: 300,
      importedAt: 300,
      messageCount: 1,
      resourceCount: 0,
      terminalState: null,
      incidentState: null,
      lastFinishType: null,
      lastFinishReason: null,
      lastReasoningStatus: null,
      provisional: true,
      metadataId: 'v1/abc123456789',
      provisionalState: 'running',
    }]
    archive.getDevSpaceRecoveryMessages = (conversationId: string) => conversationId === 'devspace-meta/abc123'
      ? [{
          messageId: 'devspace-recovery:checkpoint-1:checkpoint',
          ordinal: 0,
          role: 'assistant',
          authorName: 'DevSpace Checkpoint',
          recipient: 'all',
          channel: 'commentary',
          contentType: 'text',
          text: '阶段一已完成。',
          hidden: 0,
          createTime: 4,
          status: 'provisional',
          provisional: true,
          recoverySource: 'devspace-checkpoint',
          recoveryKind: 'assistant-checkpoint',
          auditId: 'checkpoint-1',
          metadataId: 'v1/abc123456789',
          superseded: false,
        }]
      : []

    const { base, headers } = await startBridge(undefined, archive)
    const listResponse = await fetch(`${base}/v1/conversations?limit=10`, { headers })
    expect(listResponse.status).toBe(200)
    const listBody = await listResponse.json() as { conversations: Array<Record<string, unknown>> }
    expect(listBody.conversations[0]).toMatchObject({
      id: 'devspace-meta/abc123',
      title: '尚未绑定的工作流',
      provisional: true,
      metadataId: 'v1/abc123456789',
      lifecycleState: 'running',
    })

    const encoded = encodeURIComponent('devspace-meta/abc123')
    const detailResponse = await fetch(`${base}/v1/conversations/${encoded}`, { headers })
    expect(detailResponse.status).toBe(200)
    expect(await detailResponse.json()).toMatchObject({
      conversation: {
        id: 'devspace-meta/abc123',
        provisional: true,
        lifecycleState: 'running',
      },
      active: null,
      incidents: [],
    })

    const messagesResponse = await fetch(`${base}/v1/conversations/${encoded}/messages`, { headers })
    expect(messagesResponse.status).toBe(200)
    expect(await messagesResponse.json()).toMatchObject({
      canonicalCount: 0,
      provisionalCount: 1,
      messages: [{
        recoveryKind: 'assistant-checkpoint',
        recoverySource: 'devspace-checkpoint',
        text: '阶段一已完成。',
      }],
    })
  })

  test('messages API 在 canonical 尾部追加带 provenance 的 DevSpace provisional recovery', async () => {
    const archive = mockArchive()
    archive.getDevSpaceRecoveryMessages = (conversationId: string) => conversationId === 'cid-1'
      ? [{
          messageId: 'devspace-recovery:audit-1:conclusion',
          ordinal: 5,
          role: 'assistant',
          authorName: 'DevSpace Recover',
          recipient: 'all',
          channel: 'commentary',
          contentType: 'text',
          text: '已完成阶段一，现在继续核验。',
          hidden: 0,
          createTime: 4,
          status: 'provisional',
          provisional: true,
          recoverySource: 'devspace-audit',
          recoveryKind: 'assistant-conclusion',
          auditId: 'audit-1',
          metadataId: 'meta-1',
          superseded: false,
        }]
      : []
    const { base, headers } = await startBridge(undefined, archive)
    const response = await fetch(`${base}/v1/conversations/cid-1/messages`, { headers })
    expect(response.status).toBe(200)
    const body = await response.json() as {
      canonicalCount: number
      provisionalCount: number
      messages: Array<Record<string, unknown>>
    }
    expect(body.canonicalCount).toBe(4)
    expect(body.provisionalCount).toBe(1)
    expect(body.messages.at(-1)).toMatchObject({
      messageId: 'devspace-recovery:audit-1:conclusion',
      provisional: true,
      recoverySource: 'devspace-audit',
      recoveryKind: 'assistant-conclusion',
      auditId: 'audit-1',
      metadataId: 'meta-1',
      text: '已完成阶段一，现在继续核验。',
    })
  })

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
    const body = await messages.json() as {
      messages: Array<Record<string, unknown>>
      total: number
      hasMore: boolean
      nextBeforeOrdinal: number | null
    }
    expect(body.messages.map(item => item.messageId)).toEqual(['m1', 'm2', 'reasoning-internal'])
    expect(body).toMatchObject({ total: 3, hasMore: false, nextBeforeOrdinal: 1 })
    expect(JSON.stringify(body)).not.toContain('must-not-leak')
    expect(JSON.stringify(body)).not.toContain('内部隐藏消息')
    expect(JSON.stringify(body)).not.toContain('这里是模型内部推理')
    expect(body.messages.at(-1)).toMatchObject({
      messageId: 'reasoning-internal',
      reasoningRedacted: true,
      text: '',
      turnExchangeId: 'turn-1',
    })

    const tail = await fetch(`${base}/v1/conversations/cid-1/messages?limit=2`, { headers })
    expect(tail.status).toBe(200)
    expect(await tail.json()).toMatchObject({
      total: 3,
      hasMore: true,
      nextBeforeOrdinal: 3,
      messages: [
        { messageId: 'm2', ordinal: 3 },
        { messageId: 'reasoning-internal', ordinal: 4 },
      ],
    })

    const older = await fetch(`${base}/v1/conversations/cid-1/messages?limit=2&before_ordinal=3`, { headers })
    expect(older.status).toBe(200)
    expect(await older.json()).toMatchObject({
      total: 3,
      hasMore: false,
      nextBeforeOrdinal: 1,
      messages: [{ messageId: 'm1', ordinal: 1 }],
    })
  })

  test('search 和 worksite resolve 返回可供 LifeOps 使用的脱敏工作现场', async () => {
    const { base, headers } = await startBridge()

    const search = await fetch(`${base}/v1/search?q=${encodeURIComponent('测试')}&limit=10`, { headers })
    expect(search.status).toBe(200)
    expect(await search.json()).toMatchObject({
      query: '测试',
      hits: [{ conversationId: 'cid-1', title: '测试会话' }],
    })

    const resolved = await fetch(
      `${base}/v1/worksites/resolve?conversation_id=cid-1&turn_exchange_id=turn-1`,
      { headers },
    )
    expect(resolved.status).toBe(200)
    const body = await resolved.json() as { worksite: Record<string, unknown> }
    expect(body.worksite).toMatchObject({
      sourceEventId: 'turn:cid-1:turn-1',
      conversationId: 'cid-1',
      turnExchangeId: 'turn-1',
      title: '测试会话',
      runState: 'completed',
      reviewState: 'unread',
      inboxKind: 'turn',
      inboxHealth: 'healthy',
      url: 'https://chatgpt.com/c/cid-1',
    })
    expect(body.worksite).not.toHaveProperty('summary')
    expect(JSON.stringify(body)).not.toContain('这里是模型内部推理')

    const resources = await fetch(`${base}/v1/conversations/cid-1/resources`, { headers })
    expect(resources.status).toBe(200)
    expect(await resources.json()).toMatchObject({
      conversationId: 'cid-1',
      total: 1,
      hasMore: false,
      resources: [{ kind: 'web-search', label: '搜索测试', data: { query: '测试' } }],
    })
  })

  test('turn submit 校验输入，并把 cooldown 映射为 HTTP 429', async () => {
    const calls: ArchiveBridgeTurnInput[] = []
    const { base, headers } = await startBridge(async input => {
      calls.push(input)
      if (input.text === 'rate-limit') {
        throw new Error('ChatGPT actor blocked by active API cooldown until 2026-10-07T08:08:29.000Z')
      }
      return {
        conversationId: input.conversationId ?? 'new-cid',
        mode: input.mode === 'auto' ? 'continue' : input.mode,
        submittedAt: 123,
        boundAt: 456,
        runningConfirmed: true,
        // 这些字段只属于本机 Actor 取证面，Bridge 响应必须过滤掉。
        targetId: 'internal-target',
        cdpRequestId: 'x.1',
        domSignatureReady: 'internal-dom-signature',
      }
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
    const acceptedBody = await accepted.json() as { accepted: boolean, result: Record<string, unknown> }
    expect(acceptedBody).toEqual({
      accepted: true,
      result: {
        conversationId: 'cid-1',
        mode: 'continue',
        submittedAt: 123,
        boundAt: 456,
        runningConfirmed: true,
      },
    })
    expect(JSON.stringify(acceptedBody)).not.toContain('internal-target')
    expect(JSON.stringify(acceptedBody)).not.toContain('x.1')
    expect(JSON.stringify(acceptedBody)).not.toContain('internal-dom-signature')
    expect(calls.at(-1)).toEqual({
      text: '继续',
      conversationId: 'cid-1',
      projectName: null,
      mode: 'continue',
      targetMode: 'guardian',
    })

    const projectAccepted = await fetch(`${base}/v1/turns`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'new', projectName: '课堂录音→笔记', text: '完整课堂转写' }),
    })
    expect(projectAccepted.status).toBe(202)
    expect(calls.at(-1)).toEqual({
      text: '完整课堂转写',
      conversationId: null,
      projectName: '课堂录音→笔记',
      mode: 'new',
      targetMode: 'guardian',
    })

    const invalidProject = await fetch(`${base}/v1/turns`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'continue',
        conversationId: 'cid-1',
        projectName: '课堂录音→笔记',
        text: '不能混用',
      }),
    })
    expect(invalidProject.status).toBe(400)

    const limited = await fetch(`${base}/v1/turns`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'continue', conversationId: 'cid-1', text: 'rate-limit' }),
    })
    expect(limited.status).toBe(429)
  })

  test('带 idempotencyKey 的 turn 会排队去重并在 cooldown 后自动继续', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-bridge-queue-'))
    const queuePath = path.join(dir, 'actor-submissions.json')
    let attempts = 0
    const cooldownUntil = Date.now() + 80
    const started = await startBridge(async input => {
      attempts += 1
      if (attempts === 1) {
        throw new Error(
          'ChatGPT actor blocked by active API cooldown until '
          + new Date(cooldownUntil).toISOString(),
        )
      }
      return {
        conversationId: input.conversationId ?? 'queued-cid',
        mode: input.mode,
        submittedAt: Date.now(),
        boundAt: Date.now(),
        runningConfirmed: true,
      }
    }, mockArchive(), {
      submissionQueuePath: queuePath,
      submissionQueuePollIntervalMs: 10,
    })

    const body = {
      mode: 'new',
      projectName: '课堂录音→笔记',
      text: 'queued-note',
      idempotencyKey: 'classflow:lecture:test:notes',
    }
    const first = await fetch(started.base + '/v1/turns', {
      method: 'POST',
      headers: { ...started.headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    expect(first.status).toBe(202)
    const firstBody = await first.json() as { submission: { id: string, status: string } }
    const firstId = firstBody.submission.id

    let finalBody: {
      submission: {
        id: string
        status: string
        result?: Record<string, unknown>
      }
    } | null = null
    const deadline = Date.now() + 1500
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20))
      const response = await fetch(started.base + '/v1/turns', {
        method: 'POST',
        headers: { ...started.headers, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      finalBody = await response.json() as typeof finalBody
      if (finalBody?.submission.status === 'accepted') break
    }

    expect(finalBody?.submission.id).toBe(firstId)
    expect(finalBody?.submission.status).toBe('accepted')
    expect(finalBody?.submission.result?.conversationId).toBe('queued-cid')
    expect(attempts).toBe(2)

    const conflict = await fetch(started.base + '/v1/turns', {
      method: 'POST',
      headers: { ...started.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, text: 'different-payload' }),
    })
    expect(conflict.status).toBe(409)
    await fs.rm(dir, { recursive: true, force: true })
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

