import { describe, expect, test } from 'vitest'
import {
  buildBodySnapshotTrace,
  buildCatalogObservationTrace,
  buildWssLifecycleTrace,
} from '../src/local/active-turn-recorder.ts'

describe('Active Turn Recorder', () => {
  test('complete 会同时保留删除 active turn 前后的并发快照', () => {
    const trace = buildWssLifecycleTrace({
      at: 123,
      event: {
        conversationId: 'conversation-b',
        type: 'conversation-turn-complete',
        updateType: null,
        startsTurn: false,
        completesTurn: true,
        asyncProgress: false,
      },
      activeBeforeIds: ['conversation-b', 'conversation-a'],
      activeAfterIds: ['conversation-a'],
    })

    expect(trace).toMatchObject({
      at: 123,
      conversationId: 'conversation-b',
      activeBefore: 2,
      activeAfter: 1,
      activeConversationIdsBefore: ['conversation-a', 'conversation-b'],
      activeConversationIdsAfter: ['conversation-a'],
    })
  })

  test('没有可靠 start 的 complete 仍可记录，但不会虚构 active 并发', () => {
    const trace = buildWssLifecycleTrace({
      at: 456,
      event: {
        conversationId: 'conversation-new',
        type: 'conversation-turn-complete',
        updateType: null,
        startsTurn: false,
        completesTurn: true,
        asyncProgress: false,
      },
      activeBeforeIds: [],
      activeAfterIds: [],
    })

    expect(trace.activeBefore).toBe(0)
    expect(trace.activeAfter).toBe(0)
    expect(trace.startsTurn).toBe(false)
    expect(trace.completesTurn).toBe(true)
  })

  test('body snapshot 绑定 request/turn 身份、工具活动和异常尾型', () => {
    const trace = buildBodySnapshotTrace({
      at: 789,
      conversationId: 'conversation-1',
      trigger: 'wss:conversation-turn-complete',
      activeConversationIds: ['conversation-3', 'conversation-2'],
      diagnostic: {
        conversationId: 'conversation-1',
        requestId: 'request-1',
        turnExchangeId: 'turn-1',
        userMessageId: 'user-1',
        lastMessageId: 'recap-1',
        terminalEvidence: 'none',
        hasFinal: false,
        hasReasoningEnded: true,
        tailShape: 'reasoning-ended-no-final',
        assistantToolCalls: 5,
        toolResults: 5,
        nodeCount: 14,
        summary: 'test summary',
      },
    })

    expect(trace).toMatchObject({
      requestId: 'request-1',
      turnExchangeId: 'turn-1',
      terminalEvidence: 'none',
      tailShape: 'reasoning-ended-no-final',
      assistantToolCalls: 5,
      toolResults: 5,
      activeObserved: 2,
      activeConversationIds: ['conversation-2', 'conversation-3'],
      safetyReview: null,
    })
  })

  test('catalog 只记录真实观察到的 active/complete 状态，不携带伪 start 时间', () => {
    const trace = buildCatalogObservationTrace({
      at: 1000,
      conversationId: 'conversation-1',
      asyncStatus: 4,
      classifiedState: 'complete',
      reason: 'periodic',
      wasCatalogActive: true,
      reliableActiveAfterIds: ['conversation-2'],
      catalogActiveAfterIds: ['conversation-3'],
    })

    expect(trace).toEqual({
      version: 1,
      at: 1000,
      kind: 'catalog-observation',
      conversationId: 'conversation-1',
      asyncStatus: 4,
      classifiedState: 'complete',
      reason: 'periodic',
      wasCatalogActive: true,
      reliableActiveAfter: 1,
      reliableActiveConversationIdsAfter: ['conversation-2'],
      catalogActiveAfter: 1,
      catalogActiveConversationIdsAfter: ['conversation-3'],
    })
  })
})

