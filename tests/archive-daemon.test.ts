import { describe, expect, test } from 'vitest'
import {
  classifyCatalogAsyncStatus,
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
          // 2026-09-13 当前第一方真实 frame：conversation_id 位于事件 payload 的下一层，
          // 不能假设它和 conversation-turn-complete 的 type 是兄弟字段。
          payload: {
            conversation_id: 'conversation-1',
            private_body: 'do not need to copy this into event queue',
          },
          metadata: null,
        },
      },
      {
        type: 'message',
        topic_id: 'conversations',
        payload: {
          type: 'conversation-created',
          payload: {
            conversation_id: 'conversation-2',
          },
        },
      },
      {
        type: 'message',
        topic_id: 'conversations',
        payload: {
          type: 'conversation-update',
          payload: {
            conversation_id: 'conversation-3',
            update_type: 'async-task-update-message',
            update_content: { private_body: 'must not be copied into event identity' },
          },
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

  test('realtime complete/watchdog/gap repair 允许 incident；startup 历史补账不允许', () => {
    expect(shouldClassifyTerminalForTrigger('wss:conversation-turn-complete')).toBe(true)
    expect(shouldClassifyTerminalForTrigger('watchdog:active-timeout')).toBe(true)
    expect(shouldClassifyTerminalForTrigger('reconcile:startup')).toBe(false)
    expect(shouldClassifyTerminalForTrigger('reconcile:periodic')).toBe(true)
    expect(shouldClassifyTerminalForTrigger('reconcile:wss-reconnect')).toBe(true)
    expect(shouldClassifyTerminalForTrigger('reconcile:guardian-recover')).toBe(true)
    expect(shouldClassifyTerminalForTrigger('wss:conversation-created')).toBe(false)
  })

  test('conversation list async_status 只把已实测值分类为 active/complete', () => {
    expect(classifyCatalogAsyncStatus(3)).toBe('active')
    expect(classifyCatalogAsyncStatus('3')).toBe('active')
    expect(classifyCatalogAsyncStatus(5)).toBe('active')
    expect(classifyCatalogAsyncStatus(4)).toBe('complete')
    expect(classifyCatalogAsyncStatus(null)).toBe('unknown')
    expect(classifyCatalogAsyncStatus(0)).toBe('unknown')
    expect(classifyCatalogAsyncStatus('garbled')).toBe('unknown')
  })
})
