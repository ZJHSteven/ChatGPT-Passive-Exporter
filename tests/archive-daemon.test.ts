import { describe, expect, test } from 'vitest'
import {
  activeApiAllowed,
  catalogStableOverlapTarget,
  classifyCatalogAsyncStatus,
  classifyConversationEvent,
  conversationIdFromTargetUrl,
  estuaryFileIdFromUrl,
  extractConversationEvents,
  incidentKindForTrigger,
  isConfirmedTerminalTrigger,
  restoreCooldownUntil,
  sanitizeCapturedHeaders,
  shouldRebuildGuardianAfterHealthFailures,
  shouldRunDeferredGapRepair,
  shouldStartCatalogWatchdog,
  shouldNotifyIncidentTransition,
  shouldRebuildGuardianForMissingWss,
  shouldClassifyTerminalForTrigger,
  watchdogTriggerForStartType,
} from '../scripts/chatgpt-archive-daemon.mjs'

describe('ChatGPT Archive daemon WSS parser', () => {
  test('图片下载辅助只提取稳定 conversation/file id，不依赖短期签名', () => {
    expect(conversationIdFromTargetUrl('https://chatgpt.com/c/6ab3d7db-3f04-83e9-bad2-8abd105c3898')).toBe('6ab3d7db-3f04-83e9-bad2-8abd105c3898')
    expect(conversationIdFromTargetUrl('https://chatgpt.com/?chatgpt-archive-guardian=1')).toBeNull()
    expect(conversationIdFromTargetUrl('https://example.com/c/not-chatgpt')).toBeNull()

    expect(estuaryFileIdFromUrl('https://chatgpt.com/backend-api/estuary/content?id=file_abc123&ts=1&sig=temporary')).toBe('file_abc123')
    expect(estuaryFileIdFromUrl('https://chatgpt.com/backend-api/conversations/file_abc123')).toBeNull()
  })
  test('从 conversations / alder-conversations topic 中提取 conversation id、事件类型与来源 topic', () => {
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
        topic_id: 'alder-conversations',
        payload: {
          type: 'conversation-history-update',
          payload: {
            conversation_id: 'conversation-4',
          },
        },
      },
    ])

    expect(extractConversationEvents(frame)).toEqual([
      { conversationId: 'conversation-1', type: 'conversation-turn-complete', updateType: null, topic: 'conversations' },
      { conversationId: 'conversation-2', type: 'conversation-created', updateType: null, topic: 'conversations' },
      { conversationId: 'conversation-3', type: 'conversation-update', updateType: 'async-task-update-message', topic: 'conversations' },
      { conversationId: 'conversation-4', type: 'conversation-history-update', updateType: null, topic: 'alder-conversations' },
    ])
  })

  test('忽略非 conversation catalogue topic 与非法帧', () => {
    expect(extractConversationEvents('not-json')).toEqual([])
    expect(extractConversationEvents(JSON.stringify({
      topic_id: 'app_notifications',
      payload: { type: 'conversation-turn-complete', conversation_id: 'wrong-topic' },
    }))).toEqual([])
    expect(extractConversationEvents(JSON.stringify({
      topic_id: 'resource-updates',
      payload: { type: 'conversation-history-update', conversation_id: 'wrong-topic-2' },
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
    expect(shouldClassifyTerminalForTrigger('reconcile:gap-repair')).toBe(true)
    expect(shouldClassifyTerminalForTrigger('reconcile:cooldown-recover')).toBe(true)
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

  test('catalog active 建立保守 late-start，并抑制同一已终止 update 的重复 watchdog', () => {
    expect(shouldStartCatalogWatchdog({
      alreadyActive: false,
      catalogUpdateTime: 200,
      archivedUpdateTime: 100,
      archivedTerminalState: 'final',
    })).toBe(true)
    expect(shouldStartCatalogWatchdog({
      alreadyActive: false,
      catalogUpdateTime: 100,
      archivedUpdateTime: 100,
      archivedTerminalState: 'final',
    })).toBe(false)
    expect(shouldStartCatalogWatchdog({
      alreadyActive: false,
      catalogUpdateTime: 100,
      archivedUpdateTime: 100,
      archivedTerminalState: 'none',
    })).toBe(true)
    expect(shouldStartCatalogWatchdog({ alreadyActive: true })).toBe(false)

    expect(watchdogTriggerForStartType('catalog:async-active:wss-reconnect')).toBe('watchdog:catalog-active-timeout')
    expect(watchdogTriggerForStartType('conversation-update:async-task-update-message')).toBe('watchdog:active-timeout')
    expect(incidentKindForTrigger('watchdog:catalog-active-timeout')).toBe('active-zombie')
    expect(incidentKindForTrigger('watchdog:active-timeout')).toBe('watchdog-timeout')
    expect(incidentKindForTrigger('wss:conversation-turn-complete')).toBe('abnormal-terminal')
  })

  test('daemon 重启继承未过期的 429 cooldown，但不复活旧 cooldown', () => {
    expect(restoreCooldownUntil({ cooldownUntil: 2000 }, 1000)).toBe(2000)
    expect(restoreCooldownUntil({ cooldownUntil: 1000 }, 1000)).toBe(0)
    expect(restoreCooldownUntil({ cooldownUntil: 999 }, 1000)).toBe(0)
    expect(restoreCooldownUntil({ cooldownUntil: 'garbled' }, 1000)).toBe(0)
    expect(restoreCooldownUntil(null, 1000)).toBe(0)
    expect(activeApiAllowed(2000, 1000)).toBe(false)
    expect(activeApiAllowed(1000, 1000)).toBe(true)
    expect(activeApiAllowed(0, 1000)).toBe(true)
  })

  test('短 WSS/gap repair 只需一整页稳定 overlap，startup/periodic 继续深扫描', () => {
    expect(catalogStableOverlapTarget('wss-reconnect', { pageSize: 28, deepThreshold: 56 })).toBe(28)
    expect(catalogStableOverlapTarget('gap-repair', { pageSize: 28, deepThreshold: 56 })).toBe(28)
    expect(catalogStableOverlapTarget('startup', { pageSize: 28, deepThreshold: 56 })).toBe(56)
    expect(catalogStableOverlapTarget('periodic', { pageSize: 28, deepThreshold: 84 })).toBe(84)
    expect(catalogStableOverlapTarget('guardian-recover', { pageSize: 28, deepThreshold: 56 })).toBe(56)
    // deepThreshold 即使被错误配置得比一页还小，也不能让深同步比短 gap 更激进。
    expect(catalogStableOverlapTarget('startup', { pageSize: 28, deepThreshold: 1 })).toBe(28)
  })

  test('Guardian 单次/偶发 CDP 探活失败不会立刻拆页，连续达到阈值才重建', () => {
    expect(shouldRebuildGuardianAfterHealthFailures(1, 3)).toBe(false)
    expect(shouldRebuildGuardianAfterHealthFailures(2, 3)).toBe(false)
    expect(shouldRebuildGuardianAfterHealthFailures(3, 3)).toBe(true)
    expect(shouldRebuildGuardianAfterHealthFailures(4, 3)).toBe(true)
    expect(shouldRebuildGuardianAfterHealthFailures(1, 1)).toBe(true)
  })

  test('deferred gap repair 必须等待 WSS、debounce、最小间隔，并尊重 429 cooldown', () => {
    const base = {
      pendingLastAt: 100_000,
      lastAttemptAt: 0,
      delayMs: 30_000,
      minIntervalMs: 600_000,
      activeSockets: 1,
      authAvailable: true,
      cooldownUntil: 0,
      reconcileInFlight: false,
    }
    expect(shouldRunDeferredGapRepair({ ...base, now: 129_999 })).toBe(false)
    expect(shouldRunDeferredGapRepair({ ...base, now: 130_000 })).toBe(true)
    expect(shouldRunDeferredGapRepair({ ...base, now: 999_999, activeSockets: 0 })).toBe(false)
    expect(shouldRunDeferredGapRepair({ ...base, now: 999_999, authAvailable: false })).toBe(false)
    expect(shouldRunDeferredGapRepair({ ...base, now: 999_999, cooldownUntil: 1_000_000 })).toBe(false)
    expect(shouldRunDeferredGapRepair({
      ...base,
      now: 700_000,
      pendingLastAt: 650_000,
      lastAttemptAt: 200_000,
    })).toBe(false)
    expect(shouldRunDeferredGapRepair({
      ...base,
      now: 800_000,
      pendingLastAt: 650_000,
      lastAttemptAt: 200_000,
    })).toBe(true)
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

  test('手机通知只跟随新 incident 或 material lifecycle 升级，不跟随 tail 文案抖动', () => {
    const watchdog = {
      id: 'incident-1', incidentKind: 'watchdog-timeout', lifecycleClass: 'watchdog-timeout', terminalEvidence: 'none',
    }
    const sameWatchdog = { ...watchdog, tailShape: 'tool-result-returned', reason: 'body refreshed' }
    const confirmed = {
      ...watchdog, incidentKind: 'abnormal-terminal', lifecycleClass: 'complete-no-final', terminalEvidence: 'none',
    }
    const interrupted = {
      ...confirmed, lifecycleClass: 'explicit-interrupted', terminalEvidence: 'client-stopped',
    }

    expect(shouldNotifyIncidentTransition(null, watchdog)).toBe(true)
    expect(shouldNotifyIncidentTransition(watchdog, sameWatchdog)).toBe(false)
    expect(shouldNotifyIncidentTransition(watchdog, confirmed)).toBe(true)
    expect(shouldNotifyIncidentTransition(confirmed, interrupted)).toBe(true)
    expect(shouldNotifyIncidentTransition(interrupted, null)).toBe(false)
    expect(shouldNotifyIncidentTransition(interrupted, { ...interrupted, id: 'incident-2' })).toBe(true)
  })
})
