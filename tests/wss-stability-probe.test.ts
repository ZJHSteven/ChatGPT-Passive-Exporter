import { describe, expect, it } from 'vitest'
import { summarizeFrame } from '../scripts/wss-stability-probe.mjs'

/**
 * WSS 探针最重要的安全契约测试。
 *
 * 我们需要看见 connect / subscribe / recovered / topic 等“协议控制字段”，
 * 但绝不能为了诊断方便把 conversation_id、消息正文、用户 ID 等业务内容写进日志。
 */
describe('WSS stability probe frame summarizer', () => {
  it('能解析 ChatGPT 当前使用的对象数组控制帧', () => {
    const frame = JSON.stringify([
      {
        id: 1,
        command: {
          type: 'connect',
          presence: { type: 'presence', state: 'foreground' },
        },
      },
      {
        id: 2,
        command: {
          type: 'subscribe',
          topic: 'conversations',
        },
      },
    ])

    const result = summarizeFrame(frame)

    expect(result.topLevelType).toBe('array')
    expect(result.arrayLength).toBe(2)
    expect(result.controls).toContainEqual({ type: 'connect' })
    expect(result.controls).toContainEqual({ type: 'subscribe', topic: 'conversations' })
  })

  it('保留 recovered 等控制信息，但不会泄漏 conversation_id 或正文', () => {
    const frame = JSON.stringify([
      {
        type: 'reply',
        reply: {
          type: 'subscribe',
          topic_id: 'conversations',
          recovered: false,
        },
      },
      {
        type: 'message',
        topic_id: 'conversations',
        payload: {
          type: 'conversation-turn-complete',
          conversation_id: 'secret-conversation-id',
          message: 'very private message body',
        },
      },
    ])

    const result = summarizeFrame(frame)
    const serialized = JSON.stringify(result)

    expect(result.controls).toContainEqual({ type: 'subscribe', topic_id: 'conversations', recovered: false })
    expect(result.controls).toContainEqual({ type: 'conversation-turn-complete' })
    expect(serialized).not.toContain('secret-conversation-id')
    expect(serialized).not.toContain('very private message body')
  })

  it('非 JSON 业务帧只记录长度，不会默认保存原文', () => {
    const result = summarizeFrame('private arbitrary payload')

    expect(result.bytes).toBeGreaterThan(0)
    expect(result).not.toHaveProperty('controlText')
  })
})

