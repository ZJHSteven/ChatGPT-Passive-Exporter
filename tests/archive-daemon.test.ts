import { describe, expect, test } from 'vitest'
import { extractConversationEvents } from '../scripts/chatgpt-archive-daemon.mjs'

describe('ChatGPT Archive daemon WSS parser', () => {
  test('从 conversations topic 中提取 conversation id 与事件类型', () => {
    const frame = JSON.stringify([
      {
        type: 'message',
        topic_id: 'conversations',
        payload: {
          type: 'conversation-turn-complete',
          conversation_id: 'conversation-1',
          private_body: 'do not need to copy this into event queue',
        },
      },
      {
        type: 'message',
        topic_id: 'conversations',
        payload: {
          type: 'conversation-created',
          conversation_id: 'conversation-2',
        },
      },
    ])

    expect(extractConversationEvents(frame)).toEqual([
      { conversationId: 'conversation-1', type: 'conversation-turn-complete' },
      { conversationId: 'conversation-2', type: 'conversation-created' },
    ])
  })

  test('忽略非 conversations topic 与非法帧', () => {
    expect(extractConversationEvents('not-json')).toEqual([])
    expect(extractConversationEvents(JSON.stringify({
      topic_id: 'app_notifications',
      payload: { type: 'conversation-turn-complete', conversation_id: 'wrong-topic' },
    }))).toEqual([])
  })
})
