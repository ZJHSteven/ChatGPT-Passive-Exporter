import { describe, expect, test } from 'vitest'
import {
  classifyConversationEvent,
  extractConversationEvents,
  shouldClassifyTerminalForTrigger,
} from '../scripts/chatgpt-archive-daemon.mjs'

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
      {
        type: 'message',
        topic_id: 'conversations',
        payload: {
          type: 'conversation-update',
          update_type: 'async-task-update-message',
          conversation_id: 'conversation-3',
          update_content: { private_body: 'must not be copied into event identity' },
        },
      },
    ])

    expect(extractConversationEvents(frame)).toEqual([
      { conversationId: 'conversation-1', type: 'conversation-turn-complete', updateType: null },
      { conversationId: 'conversation-2', type: 'conversation-created', updateType: null },
      { conversationId: 'conversation-3', type: 'conversation-update', updateType: 'async-task-update-message' },
    ])
  })

  test('忽略非 conversations topic 与非法帧', () => {
    expect(extractConversationEvents('not-json')).toEqual([])
    expect(extractConversationEvents(JSON.stringify({
      topic_id: 'app_notifications',
      payload: { type: 'conversation-turn-complete', conversation_id: 'wrong-topic' },
    }))).toEqual([])
  })

  test('dirty 与 sync-ready 分离：真实 async update 建立 active，complete 才立即同步', () => {
    expect(classifyConversationEvent('conversation-turn-start')).toMatchObject({
      dirty: true,
      syncReady: false,
      startsTurn: true,
      completesTurn: false,
    })
    expect(classifyConversationEvent('conversation-created')).toMatchObject({
      dirty: true,
      syncReady: false,
      startsTurn: false,
    })
    expect(classifyConversationEvent('conversation-update', 'async-task-update-message')).toMatchObject({
      dirty: true,
      syncReady: false,
      startsTurn: true,
      asyncProgress: true,
    })
    expect(classifyConversationEvent('conversation-turn-complete')).toMatchObject({
      dirty: true,
      syncReady: true,
      completesTurn: true,
    })
    expect(classifyConversationEvent('conversation-title-generated')).toMatchObject({
      dirty: true,
      syncReady: false,
      startsTurn: false,
    })
  })

  test('只有 realtime complete 与 watchdog 诊断允许创建 incident', () => {
    expect(shouldClassifyTerminalForTrigger('wss:conversation-turn-complete')).toBe(true)
    expect(shouldClassifyTerminalForTrigger('watchdog:active-timeout')).toBe(true)
    expect(shouldClassifyTerminalForTrigger('reconcile:startup')).toBe(false)
    expect(shouldClassifyTerminalForTrigger('reconcile:periodic')).toBe(false)
    expect(shouldClassifyTerminalForTrigger('wss:conversation-created')).toBe(false)
  })
})
