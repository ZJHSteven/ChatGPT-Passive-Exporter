import { describe, expect, test } from 'vitest'
import { buildActorSubmitTrace } from '../src/local/active-turn-recorder.ts'
import { conversationIdFromUrl } from '../src/local/chatgpt-actor.ts'

describe('ChatGPT single actor helpers', () => {
  test('只把真实 /c/<uuid> 视为 conversation 绑定完成', () => {
    expect(conversationIdFromUrl('https://chatgpt.com/')).toBeNull()
    expect(conversationIdFromUrl('https://chatgpt.com/c/WEB:temporary-id')).toBeNull()
    expect(conversationIdFromUrl('https://chatgpt.com/branch/source/message')).toBeNull()
    expect(conversationIdFromUrl('https://chatgpt.com/c/6aae3805-792c-83ea-8ad7-ebe9d0c083b1')).toBe(
      '6aae3805-792c-83ea-8ad7-ebe9d0c083b1',
    )
  })

  test('actor-submit 使用 requestWillBeSent 时刻作为可靠本地 start', () => {
    expect(buildActorSubmitTrace({
      submittedAt: 1000,
      boundAt: 1350,
      conversationId: '6aae3805-792c-83ea-8ad7-ebe9d0c083b1',
      actorTargetId: 'target-1',
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
      cdpRequestId: '123.45',
      responseStatus: 200,
      responseMimeType: 'text/event-stream',
      boundAt: 1350,
      bindDelayMs: 350,
      pageUrlBefore: 'https://chatgpt.com/',
    })
  })
})

