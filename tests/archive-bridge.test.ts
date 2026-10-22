import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  ArchiveBridgeServer,
  confirmCanonicalExactPrompt,
  ensureArchiveBridgeAuthToken,
  type ArchiveBridgeDataSource,
  type ArchiveBridgeTurnInput,
} from '../src/local/archive-bridge.ts'
import { ActorSubmissionQueue, isRetryableInfrastructureError, isSubmissionOutcomeUnknownError } from '../src/local/actor-submission-queue.ts'

test('Actor submission 把页面输入暂时缺失视为可重试基础设施错误', () => {
  expect(isRetryableInfrastructureError('ChatGPT actor prompt input not found')).toBe(true)
  expect(isRetryableInfrastructureError('ChatGPT actor composer element not found')).toBe(true)
  expect(isRetryableInfrastructureError(
    'ChatGPT actor project not found or not visible in sidebar: 课堂录音→笔记',
  )).toBe(true)
  expect(isRetryableInfrastructureError('invalid projectName')).toBe(false)
})

test('Project sidebar 瞬态不可见会进入重试且暴露 attempt-error 回调', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-project-retry-'))
  const queuePath = path.join(dir, 'queue.json')
  let attempts = 0
  const observedErrors: Array<{ status: string, attemptCount: number, lastError: string | null }> = []
  const queue = new ActorSubmissionQueue({
    filePath: queuePath,
    pollIntervalMs: 10,
    retryBaseMs: 100,
    retryMaxMs: 1000,
    submitTurn: async () => {
      attempts += 1
      if (attempts === 1) {
        throw new Error('ChatGPT actor project not found or not visible in sidebar: 课堂录音→笔记')
      }
      return { conversationId: 'recovered-cid' }
    },
    onAttemptError: async record => {
      observedErrors.push({
        status: record.status,
        attemptCount: record.attemptCount,
        lastError: record.lastError,
      })
    },
  })
  await queue.start()
  await queue.enqueue('project-retry', {
    text: '完整课堂转写',
    conversationId: null,
    projectName: '课堂录音→笔记',
    mode: 'new',
    targetMode: 'guardian',
  })

  const deadline = Date.now() + 1800
  while (Date.now() < deadline && queue.get('project-retry')?.status !== 'accepted') {
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  const record = queue.get('project-retry')
  expect(record?.status).toBe('accepted')
  expect(record?.result?.conversationId).toBe('recovered-cid')
  expect(attempts).toBe(2)
  expect(observedErrors).toEqual([{
    status: 'retry_waiting',
    attemptCount: 1,
    lastError: 'ChatGPT actor project not found or not visible in sidebar: 课堂录音→笔记',
  }])
  await queue.stop()
  await fs.rm(dir, { recursive: true, force: true })
})

test('正式 POST 结果未知必须 fail-closed，不能按 timeout 自动重试', () => {
  const message = 'ChatGPT actor submission outcome unknown after formal POST 123.45: no HTTP response arrived before timeout'
  expect(isSubmissionOutcomeUnknownError(message)).toBe(true)
  expect(isRetryableInfrastructureError(message)).toBe(false)
  expect(isSubmissionOutcomeUnknownError('CDP Runtime.evaluate timed out after 10000ms')).toBe(false)
})


test('canonical 精确 prompt 确认可认领原 conversation，且不做模糊匹配', () => {
  const archive = mockArchive()
  archive.getMessages = (conversationId: string) => conversationId === 'cid-1'
    ? [{ messageId: 'u1', ordinal: 1, role: 'user', text: 'exact prompt' }]
    : []

  const exact = confirmCanonicalExactPrompt(archive, {
    text: 'exact prompt',
    conversationId: 'cid-1',
    projectName: null,
    mode: 'continue',
    targetMode: 'guardian',
  })
  expect(exact).toEqual({ conversationId: 'cid-1', confirmedBy: 'canonical-exact-prompt' })

  const fuzzy = confirmCanonicalExactPrompt(archive, {
    text: 'exact prompt ',
    conversationId: 'cid-1',
    projectName: null,
    mode: 'continue',
    targetMode: 'guardian',
  })
  expect(fuzzy).toBeNull()
})

test('ambiguous submission 会先 canonical 确认，命中时不做第二次 POST', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-ambiguous-confirm-'))
  const queuePath = path.join(dir, 'queue.json')
  let attempts = 0
  let confirms = 0
  const queue = new ActorSubmissionQueue({
    filePath: queuePath,
    pollIntervalMs: 10,
    retryBaseMs: 100,
    retryMaxMs: 1000,
    submitTurn: async () => {
      attempts += 1
      throw new Error('ChatGPT actor submission outcome unknown after formal POST 1.1: no HTTP response arrived before timeout')
    },
    confirmTurn: async () => {
      confirms += 1
      return { conversationId: 'confirmed-cid', confirmedBy: 'canonical-exact-prompt' }
    },
  })
  await queue.start()
  await queue.enqueue('ambiguous-confirm', {
    text: 'exact prompt',
    conversationId: null,
    projectName: '课堂录音→笔记',
    mode: 'new',
    targetMode: 'guardian',
  })
  const deadline = Date.now() + 1500
  while (Date.now() < deadline && queue.get('ambiguous-confirm')?.status !== 'accepted') {
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  const record = queue.get('ambiguous-confirm')
  expect(record?.status).toBe('accepted')
  expect(record?.result?.conversationId).toBe('confirmed-cid')
  expect(attempts).toBe(1)
  expect(confirms).toBeGreaterThanOrEqual(1)
  await queue.stop()
  await fs.rm(dir, { recursive: true, force: true })
})

test('ambiguous submission canonical 未命中时最多只重发一次', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-ambiguous-retry-'))
  const queuePath = path.join(dir, 'queue.json')
  let attempts = 0
  const queue = new ActorSubmissionQueue({
    filePath: queuePath,
    pollIntervalMs: 10,
    retryBaseMs: 100,
    retryMaxMs: 1000,
    submitTurn: async () => {
      attempts += 1
      throw new Error(`ChatGPT actor submission outcome unknown after formal POST ${attempts}.1: no HTTP response arrived before timeout`)
    },
    confirmTurn: async () => null,
  })
  await queue.start()
  await queue.enqueue('ambiguous-retry', {
    text: 'exact prompt',
    conversationId: null,
    projectName: '课堂录音→笔记',
    mode: 'new',
    targetMode: 'guardian',
  })
  const deadline = Date.now() + 1800
  while (Date.now() < deadline && queue.get('ambiguous-retry')?.status !== 'failed') {
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  const record = queue.get('ambiguous-retry')
  expect(record?.status).toBe('failed')
  expect(record?.attemptCount).toBe(2)
  expect(attempts).toBe(2)
  await queue.stop()
  await fs.rm(dir, { recursive: true, force: true })
})

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
        bodyCompletionState: 'final',
        incidentState: null,
        lastFinishType: 'stop',
        lastFinishReason: null,
        lastReasoningStatus: 'finished',
      }].slice(0, limit)
    },
    searchConversations(query: string, options: { limit?: number, snippetsPerConversation?: number, sort?: 'relevance' | 'recent' | 'frequency' } = {}) {
      if (!query.includes('测试')) return []
      return [{
        conversationId: 'cid-1',
        title: '测试会话',
        capturedAt: 200,
        hitCount: 1,
        bestRank: -1,
        titleMatched: true,
        bodyCompletionState: 'final',
        lastFinishType: 'stop',
        snippets: [{
          conversationId: 'cid-1',
          messageId: 'm2',
          title: '测试会话',
          role: 'assistant',
          text: '你好！',
          rank: -1,
        }].slice(0, options.snippetsPerConversation ?? 3),
      }].slice(0, options.limit ?? 20)
    },
    searchMessages(query: string, limit = 20) {
      if (!query.includes('测试')) return []
      return [{ conversationId: 'cid-1', messageId: 'm2', title: '测试会话', role: 'assistant', text: '你好！', rank: -1 }].slice(0, limit)
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
      bodyCompletionState: null,
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

  test('conversation/messages 保留完整非 hidden 节点，并只隐藏 reasoning 正文', async () => {
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
      contentRedacted: true,
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

  test('messages API 有分页数据源时不读取整条 Conversation，并保留 tool/API 节点正文', async () => {
    const archive = mockArchive()
    let fullReadCalled = false
    archive.getMessages = () => {
      fullReadCalled = true
      return []
    }
    archive.getMessagesPage = () => ({
      messages: [
        {
          messageId: 'visible-user',
          ordinal: 100,
          role: 'user',
          recipient: 'all',
          contentType: 'text',
          text: '用户正文',
          hidden: 0,
          turnExchangeId: 'turn-latest',
        },
        {
          messageId: 'internal-call',
          ordinal: 101,
          role: 'assistant',
          recipient: 'api_tool.call_tool',
          contentType: 'text',
          text: '工具调用参数',
          hidden: 0,
          turnExchangeId: 'turn-latest',
        },
        {
          messageId: 'internal-result',
          ordinal: 102,
          role: 'tool',
          recipient: 'all',
          contentType: 'text',
          text: '工具调用结果',
          hidden: 0,
          turnExchangeId: 'turn-latest',
        },
        {
          messageId: 'visible-assistant',
          ordinal: 103,
          role: 'assistant',
          recipient: 'all',
          channel: 'final',
          contentType: 'text',
          text: '最终回复',
          hidden: 0,
          turnExchangeId: 'turn-latest',
        },
      ],
      canonicalCount: 1000,
      visibleCount: 980,
      eligibleVisibleCount: 980,
      hasMore: true,
      nextBeforeOrdinal: 100,
    })

    const { base, headers } = await startBridge(undefined, archive)
    const response = await fetch(`${base}/v1/conversations/cid-1/messages?limit=4`, { headers })
    expect(response.status).toBe(200)
    const body = await response.json() as {
      canonicalCount: number
      messages: Array<Record<string, unknown>>
    }
    expect(fullReadCalled).toBe(false)
    expect(body.canonicalCount).toBe(1000)
    expect(body.messages).toHaveLength(4)
    expect(body.messages[0]).toMatchObject({
      messageId: 'visible-user',
      text: '用户正文',
      contentRedacted: false,
    })
    expect(body.messages[1]).toMatchObject({
      messageId: 'internal-call',
      text: '工具调用参数',
      contentRedacted: false,
    })
    expect(body.messages[2]).toMatchObject({
      messageId: 'internal-result',
      text: '工具调用结果',
      contentRedacted: false,
    })
    expect(body.messages[3]).toMatchObject({
      messageId: 'visible-assistant',
      text: '最终回复',
      contentRedacted: false,
    })
  })

  test('search 和 worksite resolve 返回可供 LifeOps 使用的脱敏工作现场', async () => {
    const { base, headers } = await startBridge()

    const search = await fetch(`${base}/v1/search?q=${encodeURIComponent('测试')}&limit=10&sort=frequency&snippets_per_conversation=2`, { headers })
    expect(search.status).toBe(200)
    expect(await search.json()).toMatchObject({
      query: '测试',
      sort: 'frequency',
      conversationLimit: 10,
      snippetsPerConversation: 2,
      conversations: [{
        conversationId: 'cid-1',
        title: '测试会话',
        capturedAt: 200,
        lifecycleState: 'completed',
        hitCount: 1,
        snippets: [{ messageId: 'm2' }],
      }],
      timing: { searchMs: expect.any(Number), enrichMs: expect.any(Number), totalMs: expect.any(Number) },
    })

    const rawSearch = await fetch(`${base}/v1/search/messages?q=${encodeURIComponent('测试')}&limit=1`, { headers })
    expect(rawSearch.status).toBe(200)
    expect(await rawSearch.json()).toMatchObject({ hits: [{ conversationId: 'cid-1', messageId: 'm2' }] })

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

    const lookup = await fetch(
      started.base + '/v1/submissions?key=' + encodeURIComponent(body.idempotencyKey),
      { headers: started.headers },
    )
    expect(lookup.status).toBe(200)
    const lookupBody = await lookup.json() as { submission: { id: string } }
    expect(lookupBody.submission.id).toBe(firstId)
    expect(JSON.stringify(lookupBody)).not.toContain('queued-note')

    type SubmissionResponse = {
      submission: {
        id: string
        status: string
        result?: Record<string, unknown>
      }
    }
    let finalBody: SubmissionResponse | null = null
    const deadline = Date.now() + 1500
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20))
      const response = await fetch(started.base + '/v1/turns', {
        method: 'POST',
        headers: { ...started.headers, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      finalBody = await response.json() as SubmissionResponse
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

