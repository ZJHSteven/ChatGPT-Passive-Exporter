import { describe, expect, test } from 'vitest'
import {
  classifyCatalogAsyncStatus,
  classifyConversationEvent,
  extractConversationEvents,
  isConfirmedTerminalTrigger,
  sanitizeCapturedHeaders,
  shouldRebuildGuardianForMissingWss,
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
      {
        type: 'message',
        topic_id: 'conversations',
        payload: {
          type: 'conversation-history-update',
          payload: {
            conversation_id: 'conversation-4',
          },
        },
      },
    ])

    expect(extractConversationEvents(frame)).toEqual([
      { conversationId: 'conversation-1', type: 'conversation-turn-complete', updateType: null },
      { conversationId: 'conversation-2', type: 'conversation-created', updateType: null },
      { conversationId: 'conversation-3', type: 'conversation-update', updateType: 'async-task-update-message' },
      { conversationId: 'conversation-4', type: 'conversation-history-update', updateType: null },
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
    // 2026-09-13 的统一桌面 App 逆向表明该事件会使 Chat history source refresh；
    // 但同日两次当前 Web 普通 turn 实验均未收到它，因此暂时只作为 stale/dirty 信号。
    // 在拿到“远端设备发消息 → Guardian 收到 history-update”的真实 frame 前，不擅自当 turn start。
    expect(classifyConversationEvent('conversation-history-update')).toMatchObject({
      dirty: true,
      syncReady: false,
      startsTurn: false,
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

    expect(isConfirmedTerminalTrigger('wss:conversation-turn-complete')).toBe(true)
    expect(isConfirmedTerminalTrigger('reconcile:periodic:async-complete')).toBe(true)
    expect(isConfirmedTerminalTrigger('watchdog:active-timeout')).toBe(false)
    expect(isConfirmedTerminalTrigger('reconcile:wss-reconnect')).toBe(false)
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

  test('WSS 恢复 grace 从本次 socket gap 起算，而不是 Guardian 启动时间', () => {
    const gapStartedAt = 100_000
    expect(shouldRebuildGuardianForMissingWss({
      now: 119_999,
      activeSockets: 0,
      gapStartedAt,
      reconnectGraceMs: 20_000,
    })).toBe(false)
    expect(shouldRebuildGuardianForMissingWss({
      now: 120_000,
      activeSockets: 0,
      gapStartedAt,
      reconnectGraceMs: 20_000,
    })).toBe(true)
    expect(shouldRebuildGuardianForMissingWss({
      now: 999_999,
      activeSockets: 1,
      gapStartedAt,
      reconnectGraceMs: 20_000,
    })).toBe(false)
    expect(shouldRebuildGuardianForMissingWss({
      now: 999_999,
      activeSockets: 0,
      gapStartedAt: null,
      reconnectGraceMs: 20_000,
    })).toBe(false)
  })

  test('请求上下文白名单大小写无关，且不会复制 cookie / user-agent 等浏览器应自行生成的头', () => {
    expect(sanitizeCapturedHeaders({
      Authorization: 'Bearer fresh-token',
      'OAI-Session-ID': 'fresh-session',
      'X-OAI-IS-Client-Observation': '1',
      Cookie: 'must-not-copy',
      'User-Agent': 'must-not-copy',
      Referer: 'must-not-copy',
    })).toEqual({
      authorization: 'Bearer fresh-token',
      'oai-session-id': 'fresh-session',
      'x-oai-is-client-observation': '1',
    })
  })
})
