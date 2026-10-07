import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { buildActorSubmitTrace } from '../src/local/active-turn-recorder.ts'
import {
  actorConversationUrl,
  buildActorDomObservationExpression,
  conversationIdFromUrl,
  resolveActorSendMode,
  sendActorPrompt,
} from '../src/local/chatgpt-actor.ts'

describe('ChatGPT single actor helpers', () => {
  test('只把真实 /c/<uuid> 视为 conversation 绑定完成', () => {
    expect(conversationIdFromUrl('https://chatgpt.com/')).toBeNull()
    expect(conversationIdFromUrl('https://chatgpt.com/c/WEB:temporary-id')).toBeNull()
    expect(conversationIdFromUrl('https://chatgpt.com/branch/source/message')).toBeNull()
    expect(conversationIdFromUrl('https://chatgpt.com/c/6aae3805-792c-83ea-8ad7-ebe9d0c083b1')).toBe(
      '6aae3805-792c-83ea-8ad7-ebe9d0c083b1',
    )
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
})

