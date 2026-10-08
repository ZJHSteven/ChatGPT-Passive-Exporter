import { describe, expect, test } from 'vitest'
import {
  activeApiAllowed,
  buildCooldownNotificationPayload,
  buildTurnFinalNotificationPayload,
  buildUnboundWatchdogNotificationPayload,
  buildWatchdogDeferredNotificationPayload,
  catalogStableOverlapTarget,
  classifyConversationBackendUrl,
  classifyCatalogAsyncStatus,
  effectiveActiveRequestGap,
  formatBeijingTime,
  isConversationTransportTopic,
  classifyConversationEvent,
  conversationIdFromTargetUrl,
  decodeCdpResponseBodyBytes,
  devSpaceFirstToolWatchdogState,
  estuaryFileIdFromUrl,
  resolvedEstuaryUrlForFile,
  extractConversationEvents,
  summarizeTurnTopicWssFrame,
  incidentKindForTrigger,
  isConfirmedTerminalTrigger,
  restoreCooldownUntil,
  sanitizeCapturedHeaders,
  passiveObservationMatchesReady,
  rearmCatalogWatchdogOnProgress,
  shouldBlockGuardianConversationRest,
  shouldRebuildGuardianAfterHealthFailures,
  shouldRunDeferredGapRepair,
  shouldQueueWatchdogDiagnostic,
  shouldRetainSeenDevSpaceAudit,
  shouldCloseWatchdogGenerationAfterSync,
  shouldRepairConversationTransport,
  shouldRetireWssSocketsForFrameNavigation,
  shouldAttachPassivePageObserver,
  watchdogDiagnosticTurnKey,
  watchdogTurnStartedAtFromPayload,
  reconcileWatchdogDiagnosticTurn,
  shouldStartCatalogWatchdog,
  shouldNotifyHistoricalIncidentForTrigger,
  shouldNotifyIncidentTransition,
  shouldNotifyTurnFinal,
  shouldRebuildGuardianForMissingWss,
  shouldSupersedeDevSpaceBinding,
  shouldClassifyTerminalForTrigger,
  shouldDeferConfirmedTerminalIncident,
  watchdogTriggerForStartType,
} from '../scripts/chatgpt-archive-daemon.mjs'

describe('ChatGPT Archive daemon WSS parser', () => {
  test('当前 exact body 只允许纠正历史 backfill，不覆盖另一个在线 exact binding', () => {
    expect(shouldSupersedeDevSpaceBinding(
      { conversationId: 'old', evidence: 'body:exact-tool-args-backfill' },
      { conversationId: 'new', evidence: 'body:exact-tool-args' },
    )).toBe(true)
    expect(shouldSupersedeDevSpaceBinding(
      { conversationId: 'old', evidence: 'body:exact-tool-args' },
      { conversationId: 'new', evidence: 'body:exact-tool-args' },
    )).toBe(false)
    expect(shouldSupersedeDevSpaceBinding(
      { conversationId: 'same', evidence: 'body:exact-tool-args-backfill' },
      { conversationId: 'same', evidence: 'body:exact-tool-args' },
    )).toBe(false)
  })

  test('只有顶层 ChatGPT document replacement 才淘汰旧 WSS；iframe/其它站点/SPA 不误判', () => {
    expect(shouldRetireWssSocketsForFrameNavigation({
      url: 'https://chatgpt.com/c/6ac5ebe1-c5c4-83ea-afc9-66a9cef1dd59',
    })).toBe(true)
    expect(shouldRetireWssSocketsForFrameNavigation({
      url: 'https://chatgpt.com/',
      parentId: '',
    })).toBe(true)
    expect(shouldRetireWssSocketsForFrameNavigation({
      url: 'https://chatgpt.com/some-frame',
      parentId: 'parent-frame-id',
    })).toBe(false)
    expect(shouldRetireWssSocketsForFrameNavigation({
      url: 'https://example.com/',
    })).toBe(false)
    expect(shouldRetireWssSocketsForFrameNavigation(null)).toBe(false)
  })

  test('Guardian 也属于被动页面 observer：物理合并后仍能抓 Actor SSE', () => {
    const guardian = {
      id: 'guardian-target',
      type: 'page',
      url: 'https://chatgpt.com/c/example?chatgpt-archive-guardian=1',
      webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/guardian-target',
    }
    expect(shouldAttachPassivePageObserver(guardian)).toBe(true)
    expect(shouldAttachPassivePageObserver({
      ...guardian,
      type: 'service_worker',
    })).toBe(false)
    expect(shouldAttachPassivePageObserver({
      ...guardian,
      url: 'https://example.com/',
    })).toBe(false)
    expect(shouldAttachPassivePageObserver({
      ...guardian,
      webSocketDebuggerUrl: '',
    })).toBe(false)
  })

  test('429 cooldown 通知文案包含原因、路由与预计解除时间', () => {
    expect(buildCooldownNotificationPayload({
      reason: 'active body HTTP 429',
      cooldownUntil: Date.parse('2026-10-06T09:02:52.322Z'),
      route: '/backend-api/conversation/example',
      retryAfter: '120',
    })).toEqual({
      title: 'ChatGPT API 429 冷却',
      body: [
        '原因：active body HTTP 429',
        '请求：/backend-api/conversation/example',
        'Retry-After：120',
        '主动 API 冷却至：2026-10-06 17:02:52 北京时间',
        'WSS/CDP 被动监听继续运行；滑动延长只记日志，不重复通知。',
      ].join('\n'),
    })
  })

  test('人类可见时间统一格式化为北京时间，数据库仍可继续保存绝对时间戳', () => {
    expect(formatBeijingTime(Date.parse('2026-10-07T11:40:30.073Z')))
      .toBe('2026-10-07 19:40:30 北京时间')
  })

  test('conversation transport repair 只跟随 conversation carrier 换代', () => {
    expect(isConversationTransportTopic('conversations')).toBe(true)
    expect(isConversationTransportTopic('alder-conversations')).toBe(true)
    expect(isConversationTransportTopic('app_notifications')).toBe(false)
    expect(isConversationTransportTopic('resource-updates')).toBe(false)

    // Guardian 第一次建立 conversation carrier 是正常初始化，不应额外扫 catalog。
    expect(shouldRepairConversationTransport(false, null, 'socket-a')).toBe(false)
    // 同一 socket 重复订阅 conversations/alder 不算换代。
    expect(shouldRepairConversationTransport(true, 'socket-a', 'socket-a')).toBe(false)
    // 无论旧 carrier 已先关闭（current=null）还是 overlap handover，都应 repair。
    expect(shouldRepairConversationTransport(true, null, 'socket-b')).toBe(true)
    expect(shouldRepairConversationTransport(true, 'socket-a', 'socket-b')).toBe(true)
  })

  test('turn-topic WSS 只提取 subscribe/ACK/catchup/live 控制面，不泄露 encoded_item 正文', () => {
    const topic = 'conversation-turn-11111111-2222-3333-4444-555555555555'
    const sent = JSON.stringify([{ id: 5, command: { type: 'subscribe', topic_id: topic, offset: '0' } }])
    expect(summarizeTurnTopicWssFrame(sent)).toEqual([
      { source: 'subscribe', topic, offset: '0' },
    ])

    const catchup = {
      type: 'message',
      topic_id: topic,
      offset: 'opaque-1',
      payload: {
        type: 'conversation-turn-stream',
        payload: {
          type: 'stream-item',
          stream_item_id: 'item-1',
          parent_stream_item_id: 'parent-1',
          encoded_item: 'data: {"secret":"must-not-leak"}\n\n',
        },
      },
    }
    const received = JSON.stringify([
      { type: 'reply', reply: { type: 'subscribe', topic_id: topic, recovered: true, last_offset: 'opaque-1', catchups: [catchup] } },
      { ...catchup, offset: 'opaque-2' },
      { type: 'message', topic_id: topic, payload: { type: 'conversation-turn-stream', payload: { type: 'done' } } },
    ])
    const summary = summarizeTurnTopicWssFrame(received)
    expect(summary).toEqual([
      { source: 'reply', topic, recovered: true, catchupCount: 1, lastOffsetPresent: true },
      {
        source: 'catchup', topic, innerType: 'stream-item', hasEncodedItem: true,
        encodedBytes: Buffer.byteLength('data: {"secret":"must-not-leak"}\n\n'), offsetPresent: true,
        streamItemIdPresent: true, parentStreamItemIdPresent: true,
      },
      {
        source: 'message', topic, innerType: 'stream-item', hasEncodedItem: true,
        encodedBytes: Buffer.byteLength('data: {"secret":"must-not-leak"}\n\n'), offsetPresent: true,
        streamItemIdPresent: true, parentStreamItemIdPresent: true,
      },
      {
        source: 'message', topic, innerType: 'done', hasEncodedItem: false,
        encodedBytes: 0, offsetPresent: false, streamItemIdPresent: false, parentStreamItemIdPresent: false,
      },
    ])
    expect(JSON.stringify(summary)).not.toContain('must-not-leak')
  })

  test('图片下载辅助只提取稳定 conversation/file id，不依赖短期签名', () => {
    expect(conversationIdFromTargetUrl('https://chatgpt.com/c/6ab3d7db-3f04-83e9-bad2-8abd105c3898')).toBe('6ab3d7db-3f04-83e9-bad2-8abd105c3898')
    expect(conversationIdFromTargetUrl('https://chatgpt.com/?chatgpt-archive-guardian=1')).toBeNull()
    expect(conversationIdFromTargetUrl('https://example.com/c/not-chatgpt')).toBeNull()

    expect(estuaryFileIdFromUrl('https://chatgpt.com/backend-api/estuary/content?id=file_abc123&ts=1&sig=temporary')).toBe('file_abc123')
    expect(estuaryFileIdFromUrl('https://sub.chatgpt.com/backend-api/estuary/content?id=file_abc123&ts=1')).toBe('file_abc123')
    expect(estuaryFileIdFromUrl('https://chatgpt.com/backend-api/conversations/file_abc123')).toBeNull()
    expect(estuaryFileIdFromUrl('https://example.com/backend-api/estuary/content?id=file_abc123')).toBeNull()
  })

  test('CDP 图片响应按 base64 标记无损还原二进制', () => {
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff])
    expect(decodeCdpResponseBodyBytes({
      body: binary.toString('base64'),
      base64Encoded: true,
    })).toEqual(binary)
    expect(decodeCdpResponseBodyBytes({
      body: 'plain text',
      base64Encoded: false,
    })).toEqual(Buffer.from('plain text', 'utf8'))
  })

  test('files/download resolver 只接受同一 file id 的 ChatGPT estuary URL', () => {
    const fileId = 'file_abc123'
    const valid = 'https://chatgpt.com/backend-api/estuary/content?id=file_abc123&ts=1&sig=temporary'
    expect(resolvedEstuaryUrlForFile({ status: 'success', download_url: valid }, fileId)).toBe(valid)
    // 当前前端 bundle 兼容缺失 status；只要 download_url 合法仍可使用。
    expect(resolvedEstuaryUrlForFile({ download_url: valid }, fileId)).toBe(valid)
    expect(resolvedEstuaryUrlForFile({ status: 'error', download_url: valid }, fileId)).toBeNull()
    expect(resolvedEstuaryUrlForFile({ status: 'success', download_url: 'https://chatgpt.com/backend-api/estuary/content?id=file_other&sig=x' }, fileId)).toBeNull()
    expect(resolvedEstuaryUrlForFile({ status: 'success', download_url: 'https://example.com/backend-api/estuary/content?id=file_abc123&sig=x' }, fileId)).toBeNull()
    expect(resolvedEstuaryUrlForFile({ status: 'success', download_url: 'http://chatgpt.com/backend-api/estuary/content?id=file_abc123&sig=x' }, fileId)).toBeNull()
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
    expect(isConfirmedTerminalTrigger('reconcile:periodic:async-complete:settle')).toBe(true)
    expect(isConfirmedTerminalTrigger('watchdog:active-timeout')).toBe(false)
    expect(isConfirmedTerminalTrigger('reconcile:wss-reconnect')).toBe(false)
    expect(shouldNotifyHistoricalIncidentForTrigger('reconcile:startup')).toBe(false)
    expect(shouldNotifyHistoricalIncidentForTrigger('watchdog:active-timeout')).toBe(false)
    expect(shouldNotifyHistoricalIncidentForTrigger('reconcile:gap-repair')).toBe(false)
  })

  test('complete 首次 body 未收敛时只延迟立案一次，settle 复核不再循环', () => {
    expect(shouldDeferConfirmedTerminalIncident(
      'wss:conversation-turn-complete',
      { terminalEvidence: 'none' },
    )).toBe(true)
    expect(shouldDeferConfirmedTerminalIncident(
      'wss:conversation-turn-complete:settle',
      { terminalEvidence: 'none' },
    )).toBe(false)
    expect(shouldDeferConfirmedTerminalIncident(
      'reconcile:periodic:async-complete',
      { terminalEvidence: 'none' },
    )).toBe(true)
    expect(shouldDeferConfirmedTerminalIncident(
      'wss:conversation-turn-complete',
      { terminalEvidence: 'final' },
    )).toBe(false)
    expect(shouldDeferConfirmedTerminalIncident(
      'wss:conversation-turn-complete',
      { terminalEvidence: 'interrupted' },
    )).toBe(false)
    expect(shouldDeferConfirmedTerminalIncident(
      'watchdog:active-timeout',
      { terminalEvidence: 'none' },
    )).toBe(false)
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

  test('catalog generation 已诊断后保持 tombstone；真实 progress 才从新时刻重新武装', () => {
    expect(shouldCloseWatchdogGenerationAfterSync('watchdog:catalog-active-timeout', {
      watchdogTurnChanged: false,
      watchdogTurnAlreadyTimedOut: false,
    })).toBe(false)

    const diagnosed = {
      startedAt: 1_000,
      lastEventAt: 1_000,
      lastWatchdogAt: 46 * 60_000,
      watchdogPendingAt: null,
      startType: 'catalog:async-active:gap-repair',
      lastDiagnosticTurnKey: 'turn-a',
    }
    const rearmed = rearmCatalogWatchdogOnProgress(diagnosed, 100 * 60_000)
    expect(rearmed).toEqual({
      ...diagnosed,
      startedAt: 100 * 60_000,
      lastEventAt: 100 * 60_000,
      lastWatchdogAt: null,
      watchdogPendingAt: null,
    })
    expect(shouldQueueWatchdogDiagnostic(rearmed, 100 * 60_000 + 45 * 60_000 - 1, 45 * 60_000)).toBe(false)
    expect(shouldQueueWatchdogDiagnostic(rearmed, 100 * 60_000 + 45 * 60_000, 45 * 60_000)).toBe(true)
  })

  test('DevSpace audit overlap 的 seen-id 只在 cursor 已越过查询下界后删除', () => {
    // 即使这条事件现实中已经过去很多小时，只要 cursor 仍停在它附近，下一轮 overlap
    // 仍会把它查出来，所以必须继续保留去重。
    expect(shouldRetainSeenDevSpaceAudit(1_000, 1_001, 10_000)).toBe(true)
    expect(shouldRetainSeenDevSpaceAudit(10_000, 20_000, 10_000)).toBe(true)
    // cursor 前进到查询下界已经严格越过该事件后，才可安全释放 seen-id。
    expect(shouldRetainSeenDevSpaceAudit(9_999, 20_000, 10_000)).toBe(false)
  })

  test('watchdog 首次超时只调查一次；新进展后再次静默满窗口才重新武装', () => {
    const watchdogMs = 30 * 60_000
    const active = { startedAt: 0, lastEventAt: 0, lastWatchdogAt: null }
    expect(shouldQueueWatchdogDiagnostic(active, watchdogMs - 1, watchdogMs)).toBe(false)
    expect(shouldQueueWatchdogDiagnostic(active, watchdogMs, watchdogMs)).toBe(true)

    const diagnosed = { ...active, lastWatchdogAt: watchdogMs }
    // 没有任何新进展时，即使又过很多个 watchdog 窗口也不重复抓 body。
    expect(shouldQueueWatchdogDiagnostic(diagnosed, watchdogMs * 2, watchdogMs)).toBe(false)
    expect(shouldQueueWatchdogDiagnostic(diagnosed, watchdogMs * 20, watchdogMs)).toBe(false)

    const progressed = { ...diagnosed, lastEventAt: watchdogMs + 5_000 }
    expect(shouldQueueWatchdogDiagnostic(progressed, watchdogMs * 2, watchdogMs)).toBe(false)
    expect(shouldQueueWatchdogDiagnostic(progressed, watchdogMs * 2 + 5_000, watchdogMs)).toBe(true)
  })

  test('DevSpace first-tool 新 turn 不能继承上一轮 binding 的 turn key', () => {
    const active = devSpaceFirstToolWatchdogState(1_000)
    expect(active).toEqual({
      startedAt: 1_000,
      lastEventAt: 1_000,
      lastWatchdogAt: null,
      watchdogPendingAt: null,
      startType: 'devspace:first-tool',
      lastDiagnosticTurnKey: null,
    })

    // 第一次 45min body 才认识本轮 turn；这不是“换 turn”，因此 startedAt 不得重置。
    const firstDiagnostic = reconcileWatchdogDiagnosticTurn(
      { ...active, lastWatchdogAt: 46_000 },
      { turnExchangeId: 'turn-current' },
      50_000,
    )
    expect(firstDiagnostic.changed).toBe(false)
    expect(firstDiagnostic.nextActive).toMatchObject({
      startedAt: 1_000,
      lastDiagnosticTurnKey: 'turn-current',
    })
  })

  test('catalog watchdog 不能把旧 turn 的计时跨到同 conversation 的新 turn', () => {
    const active = {
      startedAt: 0,
      lastEventAt: 0,
      lastWatchdogAt: 30 * 60_000,
      lastDiagnosticTurnKey: 'turn-a',
      startType: 'catalog:async-active:periodic',
    }
    expect(watchdogDiagnosticTurnKey({
      turnExchangeId: 'turn-b', requestId: 'req-b', userMessageId: 'user-b', lastMessageId: 'last-b',
    })).toBe('turn-b')

    const changed = reconcileWatchdogDiagnosticTurn(active, { turnExchangeId: 'turn-b' }, 40 * 60_000)
    expect(changed).toMatchObject({ changed: true, turnKey: 'turn-b' })
    expect(changed.nextActive).toMatchObject({
      startedAt: 40 * 60_000,
      lastEventAt: 40 * 60_000,
      lastWatchdogAt: null,
      lastDiagnosticTurnKey: 'turn-b',
    })
    expect(shouldQueueWatchdogDiagnostic(changed.nextActive, 70 * 60_000 - 1, 30 * 60_000)).toBe(false)
    expect(shouldQueueWatchdogDiagnostic(changed.nextActive, 70 * 60_000, 30 * 60_000)).toBe(true)

    const same = reconcileWatchdogDiagnosticTurn(changed.nextActive, { turnExchangeId: 'turn-b' }, 71 * 60_000)
    expect(same.changed).toBe(false)
    expect(same.nextActive.startedAt).toBe(40 * 60_000)
  })

  test('晚发现新 turn 时优先使用 body 里的真实 user create_time，而不是发现时刻重新计 45 分钟', () => {
    const userStartedAtMs = 100_000
    const payload = {
      messages: [{
        id: 'user-b',
        author: { role: 'user' },
        create_time: userStartedAtMs / 1000,
        metadata: { turn_exchange_id: 'turn-b', request_id: 'req-b' },
      }],
    }
    const diagnostic = { turnExchangeId: 'turn-b', requestId: 'req-b', userMessageId: 'user-b' }
    expect(watchdogTurnStartedAtFromPayload(payload, diagnostic)).toBe(userStartedAtMs)

    const reconciled = reconcileWatchdogDiagnosticTurn({
      startedAt: 0,
      lastEventAt: 120_000,
      lastWatchdogAt: 90_000,
      watchdogPendingAt: 90_000,
      lastDiagnosticTurnKey: 'turn-a',
      startType: 'catalog:async-active:gap-repair',
    }, diagnostic, 4_000_000, userStartedAtMs)

    expect(reconciled).toMatchObject({
      changed: true,
      turnKey: 'turn-b',
      turnStartedAt: userStartedAtMs,
      turnStartSource: 'body-user-create-time',
    })
    expect(reconciled.nextActive).toMatchObject({
      startedAt: userStartedAtMs,
      lastEventAt: 120_000,
      lastWatchdogAt: null,
      watchdogPendingAt: null,
      lastDiagnosticTurnKey: 'turn-b',
    })
  })

  test('watchdog 诊断完成即关闭本 generation；只有刚发现且尚未超时的新 turn 保留', () => {
    expect(shouldCloseWatchdogGenerationAfterSync('watchdog:active-timeout', {
      watchdogTurnChanged: false,
      watchdogTurnAlreadyTimedOut: false,
    })).toBe(true)
    expect(shouldCloseWatchdogGenerationAfterSync('watchdog:catalog-active-timeout', {
      watchdogTurnChanged: true,
      watchdogTurnAlreadyTimedOut: false,
    })).toBe(false)
    expect(shouldCloseWatchdogGenerationAfterSync('watchdog:catalog-active-timeout', {
      watchdogTurnChanged: true,
      watchdogTurnAlreadyTimedOut: true,
    })).toBe(false)
    expect(shouldCloseWatchdogGenerationAfterSync('wss:conversation-turn-complete', {
      watchdogTurnChanged: false,
      watchdogTurnAlreadyTimedOut: true,
    })).toBe(false)
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

  test('Watchdog cooldown deferred 通知明确“已到点但尚未归因”并带聊天链接', () => {
    const payload = buildWatchdogDeferredNotificationPayload({
      conversationId: 'conversation-a',
      title: '继续处理异常终止',
      startedAt: 1_000,
      now: 46 * 60_000 + 1_000,
      cooldownUntil: 60 * 60_000,
    })
    expect(payload.title).toContain('Watchdog 已超时')
    expect(payload.body).toContain('继续处理异常终止')
    expect(payload.body).toContain('429 cooldown')
    expect(payload.body).toContain('46 分钟')
    expect(payload.url).toContain('/c/conversation-a')
  })

  test('未绑定 watchdog 到点也通知，但不猜 CID 或聊天名', () => {
    const payload = buildUnboundWatchdogNotificationPayload({
      metadataId: 'v1/abcdefghijklmnopqrstuvwxyz0123456789',
      startedAt: 1_000,
      now: 50 * 60_000 + 1_000,
    })
    expect(payload.title).toContain('会话未绑定')
    expect(payload.body).toContain('50 分钟')
    expect(payload.body).toContain('不能猜聊天名或 CID')
    expect(payload).not.toHaveProperty('url')
  })

  test('正常 final 只在在线终态/Watchdog 路径通知，历史 startup/periodic 不补轰炸', () => {
    const diagnostic = { terminalEvidence: 'final', hasImageGenerationFinal: false, imageGenerationCount: 0 }
    expect(shouldNotifyTurnFinal('wss:conversation-turn-complete', diagnostic)).toBe(true)
    expect(shouldNotifyTurnFinal('wss:conversation-turn-complete:settle', diagnostic)).toBe(true)
    expect(shouldNotifyTurnFinal('watchdog:active-timeout', diagnostic)).toBe(true)
    expect(shouldNotifyTurnFinal('checkpoint:body-terminal', diagnostic)).toBe(true)
    expect(shouldNotifyTurnFinal('reconcile:gap-repair', diagnostic)).toBe(true)
    expect(shouldNotifyTurnFinal('reconcile:wss-reconnect', diagnostic)).toBe(true)
    expect(shouldNotifyTurnFinal('reconcile:guardian-recover', diagnostic)).toBe(true)
    expect(shouldNotifyTurnFinal('reconcile:cooldown-recover', diagnostic)).toBe(true)
    expect(shouldNotifyTurnFinal('reconcile:startup', diagnostic)).toBe(false)
    expect(shouldNotifyTurnFinal('reconcile:periodic', diagnostic)).toBe(false)
    expect(shouldNotifyTurnFinal('wss:conversation-turn-complete', { terminalEvidence: 'none' })).toBe(false)

    const payload = buildTurnFinalNotificationPayload({
      conversationId: 'conversation-a',
      title: '正常长任务',
      diagnostic,
    })
    expect(payload.title).toContain('正常完成')
    expect(payload.body).toContain('正常长任务')
    expect(payload.body).toContain('canonical body 已确认 final')
  })

  test('短 WSS/gap repair 只需一整页稳定 overlap，startup/periodic 继续深扫描', () => {
    expect(catalogStableOverlapTarget('wss-reconnect', { pageSize: 28, deepThreshold: 56 })).toBe(28)
    expect(catalogStableOverlapTarget('gap-repair', { pageSize: 28, deepThreshold: 56 })).toBe(28)
    expect(catalogStableOverlapTarget('startup', { pageSize: 28, deepThreshold: 56 })).toBe(28)
    expect(catalogStableOverlapTarget('periodic', { pageSize: 28, deepThreshold: 84 })).toBe(84)
    expect(catalogStableOverlapTarget('guardian-recover', { pageSize: 28, deepThreshold: 56 })).toBe(28)
    // deepThreshold 即使被错误配置得比一页还小，也不能让深同步比短 gap 更激进。
    expect(catalogStableOverlapTarget('startup', { pageSize: 28, deepThreshold: 1 })).toBe(28)
  })

  test('conversation backend URL 分类能区分全量 list、TPP list、正文和 cursor', () => {
   expect(classifyConversationBackendUrl('/backend-api/conversations?offset=0&limit=28&order=updated&is_archived=false&is_starred=false')).toEqual({
      kind: 'catalog', offset: 0, limit: 28, globalCatalog: true, conversationOrigin: null, excludeConversationOrigin: null, hideSnorlax: null,
   })
   expect(classifyConversationBackendUrl('/backend-api/conversations?conversation_origin=tpp&expand=false&hide_snorlax=false&limit=20&order=updated&offset=0')).toMatchObject({
     kind: 'catalog', offset: 0, limit: 20, globalCatalog: false, conversationOrigin: 'tpp',
   })
    expect(classifyConversationBackendUrl('/backend-api/conversations?exclude_conversation_origin=tpp&expand=false&hide_snorlax=false&is_archived=false&is_starred=false&limit=20&order=updated&offset=0')).toMatchObject({
      kind: 'catalog', offset: 0, limit: 20, globalCatalog: false, conversationOrigin: null, excludeConversationOrigin: 'tpp',
    })
    expect(classifyConversationBackendUrl('/backend-api/conversations/c1?include_has_versions=true&num_turns=10')).toEqual({
      kind: 'body-latest', conversationId: 'c1',
    })
    expect(classifyConversationBackendUrl('/backend-api/conversations/c1/messages?before=abc&include_has_versions=true&num_turns=10')).toEqual({
      kind: 'body-cursor', conversationId: 'c1', before: 'abc',
    })
    expect(classifyConversationBackendUrl('/backend-api/conversation/c1')).toEqual({ kind: 'mapping', conversationId: 'c1' })
    expect(classifyConversationBackendUrl('https://example.com/backend-api/conversations?offset=0')).toBeNull()
  })

  test('Guardian cooldown block 只匹配 conversation REST；passive body 必须足够新才可替代 replay', () => {
    expect(shouldBlockGuardianConversationRest('https://chatgpt.com/backend-api/conversations?offset=0&limit=28&order=updated&is_archived=false&is_starred=false')).toBe(true)
    expect(shouldBlockGuardianConversationRest('https://chatgpt.com/backend-api/conversations/c1?num_turns=10')).toBe(true)
    expect(shouldBlockGuardianConversationRest('wss://chatgpt.com/ws')).toBe(false)
    expect(passiveObservationMatchesReady(10_000, 9_000)).toBe(true)
    expect(passiveObservationMatchesReady(8_000, 10_000, 1_500)).toBe(false)
    expect(passiveObservationMatchesReady(8_600, 10_000, 1_500)).toBe(true)
  })

  test('cooldown 恢复期先 slow-start，成功探针清零后恢复正常间隔', () => {
    expect(effectiveActiveRequestGap(6000, 3, 30_000)).toBe(30_000)
    expect(effectiveActiveRequestGap(5000, 1, 30_000)).toBe(30_000)
    expect(effectiveActiveRequestGap(6000, 0, 30_000)).toBe(6000)
    expect(effectiveActiveRequestGap(60_000, 2, 30_000)).toBe(60_000)
  })

  test('Guardian 单次/偶发 CDP 探活失败不会立刻拆页，连续达到阈值才重建', () => {
    expect(shouldRebuildGuardianAfterHealthFailures(1, 3)).toBe(false)
    expect(shouldRebuildGuardianAfterHealthFailures(2, 3)).toBe(false)
    expect(shouldRebuildGuardianAfterHealthFailures(3, 3)).toBe(true)
    expect(shouldRebuildGuardianAfterHealthFailures(4, 3)).toBe(true)
    expect(shouldRebuildGuardianAfterHealthFailures(1, 1)).toBe(true)
  })

  test('deferred gap repair 必须等待 WSS/debounce；cooldown 时仅允许已有 passive catalog 的纯被动 repair', () => {
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
      now: 999_999,
      authAvailable: false,
      cooldownUntil: 1_000_000,
      passiveCatalogAvailable: true,
    })).toBe(true)
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
      'ChatGPT-Account-ID': 'acct-1',
      'OAI-DID': 'device-1',
      'OAI-Session-ID': 'fresh-session',
      Originator: 'web',
      'X-OAI-IS-Client-Observation': '1',
      'X-OAI-MCP-Form-Version': '2',
      'X-OpenAI-Codex-Window-Type': 'main',
      'X-OpenAI-Web-Frontend': '1',
      'X-OAI-Turn-Trace-ID': 'must-not-copy-globally',
      Cookie: 'must-not-copy',
      'User-Agent': 'must-not-copy',
      Referer: 'must-not-copy',
    })).toEqual({
      authorization: 'Bearer fresh-token',
      'chatgpt-account-id': 'acct-1',
      'oai-did': 'device-1',
      'oai-session-id': 'fresh-session',
      originator: 'web',
      'x-oai-is-client-observation': '1',
      'x-oai-mcp-form-version': '2',
      'x-openai-codex-window-type': 'main',
      'x-openai-web-frontend': '1',
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
