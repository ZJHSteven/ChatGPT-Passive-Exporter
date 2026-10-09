import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { buildActorSubmitTrace } from '../src/local/active-turn-recorder.ts'
import {
  DEFAULT_ACTOR_MIN_SUBMIT_GAP_MS,
  actorSubmitGapDelayMs,
  actorConversationUrl,
  actorResponseMimeAccepted,
  buildActorDomObservationExpression,
  conversationIdFromUrl,
  normalizeActorProjectName,
  resolveActorSendMode,
  sendActorPrompt,
} from '../src/local/chatgpt-actor.ts'

describe('ChatGPT single actor helpers', () => {
  test('全局主动提交至少间隔 5 秒，并且等待不会出现负数', () => {
    expect(DEFAULT_ACTOR_MIN_SUBMIT_GAP_MS).toBe(5_000)
    expect(actorSubmitGapDelayMs(null, 10_000)).toBe(0)
    expect(actorSubmitGapDelayMs(10_000, 12_000)).toBe(3_000)
    expect(actorSubmitGapDelayMs(10_000, 15_000)).toBe(0)
    expect(actorSubmitGapDelayMs(10_000, 16_000)).toBe(0)
  })

  test('只把真实 /c/<uuid> 视为 conversation 绑定完成', () => {
    expect(conversationIdFromUrl('https://chatgpt.com/')).toBeNull()
    expect(conversationIdFromUrl('https://chatgpt.com/c/WEB:temporary-id')).toBeNull()
    expect(conversationIdFromUrl('https://chatgpt.com/branch/source/message')).toBeNull()
    expect(conversationIdFromUrl('https://chatgpt.com/c/6aae3805-792c-83ea-8ad7-ebe9d0c083b1')).toBe(
      '6aae3805-792c-83ea-8ad7-ebe9d0c083b1',
    )
    expect(conversationIdFromUrl('https://chatgpt.com/g/g-p-demo-project/c/6aae3805-792c-83ea-8ad7-ebe9d0c083b1')).toBe(
      '6aae3805-792c-83ea-8ad7-ebe9d0c083b1',
    )
  })

  test('Project 名称只接受单行非空文本', () => {
    expect(normalizeActorProjectName('  课堂录音→笔记  ')).toBe('课堂录音→笔记')
    expect(normalizeActorProjectName(null)).toBeNull()
    expect(() => normalizeActorProjectName('  ')).toThrow(/must not be empty/u)
    expect(() => normalizeActorProjectName('课堂\n笔记')).toThrow(/single-line/u)
  })

  test('Actor 新聊天与续聊 URL 都只接受 canonical UUID', () => {
    expect(actorConversationUrl()).toBe('https://chatgpt.com/')
    expect(actorConversationUrl('6aae3805-792c-83ea-8ad7-ebe9d0c083b1')).toBe(
      'https://chatgpt.com/c/6aae3805-792c-83ea-8ad7-ebe9d0c083b1',
    )
    expect(() => actorConversationUrl('WEB:temporary-id')).toThrow(/invalid ChatGPT conversation UUID/u)
  })

  test('Actor auto 会按当前 live 状态选择 new / continue / steer', () => {
    const cid = '6aae3805-792c-83ea-8ad7-ebe9d0c083b1'
    expect(resolveActorSendMode({ requestedMode: 'auto' })).toBe('new')
    expect(resolveActorSendMode({
      requestedMode: 'auto',
      requestedConversationId: cid,
      currentConversationId: null,
    })).toBe('continue')
    expect(resolveActorSendMode({
      requestedMode: 'auto',
      requestedConversationId: cid,
      currentConversationId: cid,
      stopVisible: true,
    })).toBe('steer')
  })

  test('Actor 不允许在 waiting-for-final / 非当前页上冒充 steer', () => {
    const cid = '6aae3805-792c-83ea-8ad7-ebe9d0c083b1'
    expect(() => resolveActorSendMode({
      requestedMode: 'auto',
      requestedConversationId: cid,
      currentConversationId: cid,
      waitingForFinal: true,
    })).toThrow(/waiting for full answer/u)
    expect(() => resolveActorSendMode({
      requestedMode: 'steer',
      requestedConversationId: cid,
      currentConversationId: '6aae3805-792c-83ea-8ad7-ebe9d0c083b2',
      stopVisible: true,
    })).toThrow(/current page/u)
    expect(() => resolveActorSendMode({
      requestedMode: 'steer',
      requestedConversationId: cid,
      currentConversationId: cid,
      stopVisible: false,
    })).toThrow(/live-attached/u)
    expect(() => resolveActorSendMode({
      requestedMode: 'continue',
      requestedConversationId: cid,
      currentConversationId: cid,
      stopVisible: true,
    })).toThrow(/still live/u)
    expect(() => resolveActorSendMode({
      requestedMode: 'continue',
      requestedConversationId: cid,
      currentConversationId: cid,
      waitingForFinal: true,
    })).toThrow(/current context is incomplete/u)
  })

  test('DOM 观察表达式经过 template literal 后仍是合法 JavaScript', () => {
    const expression = buildActorDomObservationExpression()

    // 这里只编译、不执行。document / location 等浏览器全局只有运行时才会解析，
    // 因此可以精准覆盖“外层 template literal 吃掉正则转义导致 SyntaxError”这一类回归。
    expect(() => new Function(`return ${expression}`)).not.toThrow()
    expect(expression).toContain("new RegExp('^/c/[0-9a-f-]{20,}(?:/|$)', 'iu')")
    expect(expression).toContain('(^|\\s)(send|发送)(\\s|$)')
  })

  test('new/continue 与 steer 使用各自第一方响应 MIME 契约', () => {
    expect(actorResponseMimeAccepted('new', 'text/event-stream')).toBe(true)
    expect(actorResponseMimeAccepted('continue', 'text/event-stream; charset=utf-8')).toBe(true)
    expect(actorResponseMimeAccepted('steer', 'application/json')).toBe(true)
    expect(actorResponseMimeAccepted('steer', 'application/json; charset=utf-8')).toBe(true)

    expect(actorResponseMimeAccepted('new', 'application/json')).toBe(false)
    expect(actorResponseMimeAccepted('continue', 'application/json')).toBe(false)
    expect(actorResponseMimeAccepted('steer', 'text/event-stream')).toBe(false)

    // CDP 偶尔可能没有给出 MIME；这种情况下仍由 HTTP 2xx、conversation identity 与页面状态
    // 继续闭环，不能因为一个可选字段缺失把已接受请求误判成协议漂移。
    expect(actorResponseMimeAccepted('new', null)).toBe(true)
    expect(actorResponseMimeAccepted('steer', null)).toBe(true)
  })

  test('actor-submit 使用 requestWillBeSent 时刻作为可靠本地 start', () => {
    expect(buildActorSubmitTrace({
      submittedAt: 1000,
      boundAt: 1350,
      conversationId: '6aae3805-792c-83ea-8ad7-ebe9d0c083b1',
      actorTargetId: 'target-1',
      prepareRequestId: '123.44',
      prepareStatus: 200,
      sendHandlerAttempts: 2,
      cdpRequestId: '123.45',
      responseStatus: 200,
      responseMimeType: 'text/event-stream',
      pageUrlBefore: 'https://chatgpt.com/',
    })).toEqual({
      version: 1,
      at: 1000,
      kind: 'actor-submit',
      conversationId: '6aae3805-792c-83ea-8ad7-ebe9d0c083b1',
      actorTargetId: 'target-1',
      prepareRequestId: '123.44',
      prepareStatus: 200,
      sendHandlerAttempts: 2,
      cdpRequestId: '123.45',
      responseStatus: 200,
      responseMimeType: 'text/event-stream',
      boundAt: 1350,
      bindDelayMs: 350,
      pageUrlBefore: 'https://chatgpt.com/',
    })
  })

  test('Guardian lease 被存活进程持有时，第二个 Actor 不会越锁进入页面操作', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'actor-lease-held-'))
    const statePath = path.join(dir, 'actor.json')
    const daemonStatePath = path.join(dir, 'daemon.json')
    const lockPath = `${daemonStatePath}.actor.lock`
    await fs.writeFile(lockPath, JSON.stringify({
      version: 1,
      pid: process.pid,
      acquiredAt: Date.now(),
      token: 'held-by-this-test',
      targetMode: 'guardian',
    }))

    try {
      await expect(sendActorPrompt({
        cdpHttp: 'http://127.0.0.1:1',
        statePath,
        daemonStatePath,
        tracePath: path.join(dir, 'trace.jsonl'),
        prompt: 'lease-test',
        targetMode: 'guardian',
        timeoutMs: 150,
      })).rejects.toThrow(/actor lease timeout/u)
      expect(await fs.readFile(lockPath, 'utf8')).toContain('held-by-this-test')
    }
    finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test('dead-owner Guardian lease 会被回收，后续失败也必须释放新 lease', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'actor-lease-stale-'))
    const statePath = path.join(dir, 'actor.json')
    const daemonStatePath = path.join(dir, 'daemon.json')
    const lockPath = `${daemonStatePath}.actor.lock`
    await fs.writeFile(lockPath, JSON.stringify({
      version: 1,
      pid: 2_000_000_000,
      acquiredAt: Date.now(),
      token: 'dead-owner',
      targetMode: 'guardian',
    }))

    try {
      // stale owner 被清掉以后会真正拿到新 lease；随后因为测试 daemon state 没有 Guardian
      // 而安全失败。关键断言是 finally 仍把新 lease 删除，不留下永久死锁。
      await expect(sendActorPrompt({
        cdpHttp: 'http://127.0.0.1:1',
        statePath,
        daemonStatePath,
        tracePath: path.join(dir, 'trace.jsonl'),
        prompt: 'lease-stale-test',
        targetMode: 'guardian',
        timeoutMs: 500,
      })).rejects.toThrow(/Guardian target is unavailable/u)
      await expect(fs.access(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    }
    finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

