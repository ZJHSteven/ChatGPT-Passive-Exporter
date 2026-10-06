import { describe, expect, test } from 'vitest'
import {
  activeApiAllowed,
  buildCooldownNotificationPayload,
  catalogStableOverlapTarget,
  classifyConversationBackendUrl,
  classifyCatalogAsyncStatus,
  effectiveActiveRequestGap,
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
  shouldBlockGuardianConversationRest,
  shouldRebuildGuardianAfterHealthFailures,
  shouldRunDeferredGapRepair,
  shouldQueueWatchdogDiagnostic,
  shouldRepairConversationTransport,
  watchdogDiagnosticTurnKey,
  reconcileWatchdogDiagnosticTurn,
  shouldStartCatalogWatchdog,
  shouldNotifyHistoricalIncidentForTrigger,
  shouldNotifyIncidentTransition,
  shouldRebuildGuardianForMissingWss,
  shouldClassifyTerminalForTrigger,
  shouldDeferConfirmedTerminalIncident,
  watchdogTriggerForStartType,
} from '../scripts/chatgpt-archive-daemon.mjs'

describe('ChatGPT Archive daemon WSS parser', () => {
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
        '主动 API 冷却至：2026-10-06T09:02:52.322Z',
        'WSS/CDP 被动监听继续运行；滑动延长只记日志，不重复通知。',
      ].join('\n'),
    })
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
    expect(shouldNotifyHistoricalIncidentForTrigger('watchdog:active-timeout')).toBe(true)
    expect(shouldNotifyHistoricalIncidentForTrigger('reconcile:gap-repair')).toBe(true)
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
