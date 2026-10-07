import { describe, expect, test } from 'vitest'

import {
  checkpointSafetyStopReason,
  checkpointProbeDelayMs,
  createCheckpointWatch,
  normalizeCheckpointStreamStatus,
  recordCheckpointBody,
  recordCheckpointError,
  recordCheckpointStatus,
} from '../src/local/checkpoint-refresh.ts'

describe('Phase 3 checkpoint refresh state machine', () => {
  test('stream_status 只认已验证的 streaming/complete，未知值不猜', () => {
    expect(normalizeCheckpointStreamStatus('IS_STREAMING')).toBe('streaming')
    expect(normalizeCheckpointStreamStatus('streaming')).toBe('streaming')
    expect(normalizeCheckpointStreamStatus('COMPLETE')).toBe('complete')
    expect(normalizeCheckpointStreamStatus('completed')).toBe('complete')
    expect(normalizeCheckpointStreamStatus('QUEUED')).toBe('unknown')
    expect(normalizeCheckpointStreamStatus(null)).toBe('unknown')
  })

  test('cadence 保持在第一方实测的 7~10 秒区间并可测试边界', () => {
    expect(checkpointProbeDelayMs(7_000, 10_000, 0)).toBe(7_000)
    expect(checkpointProbeDelayMs(7_000, 10_000, 0.5)).toBe(8_500)
    expect(checkpointProbeDelayMs(7_000, 10_000, 1)).toBe(10_000)
  })

  test('watcher 不伪造真实 turn start，第一次 probe 可独立延迟', () => {
    const state = createCheckpointWatch({
      conversationId: 'cid-1',
      source: 'catalog:async-active',
      now: 1_000,
      firstProbeDelayMs: 1_500,
    })

    expect(state.startedAt).toBe(1_000)
    expect(state.nextProbeAt).toBe(2_500)
    expect(state.turnExchangeId).toBeNull()
    expect(state.requestId).toBeNull()
  })

  test('status/body/error 各自只推进自己负责的状态', () => {
    const initial = createCheckpointWatch({
      conversationId: 'cid-2',
      source: 'passive-catalog',
      now: 10_000,
    })
    const streaming = recordCheckpointStatus({
      state: initial,
      rawStatus: 'IS_STREAMING',
      now: 11_000,
      nextDelayMs: 8_000,
    })
    expect(streaming.lastStatus).toBe('streaming')
    expect(streaming.probes).toBe(1)
    expect(streaming.nextProbeAt).toBe(19_000)

    const withBody = recordCheckpointBody({
      state: streaming,
      now: 11_100,
      currentNode: 'node-1',
      updateTime: 123.5,
      turnExchangeId: 'turn-1',
      requestId: 'request-1',
    })
    expect(withBody.bodyRefreshes).toBe(1)
    expect(withBody.lastCurrentNode).toBe('node-1')
    expect(withBody.lastUpdateTime).toBe(123.5)
    expect(withBody.turnExchangeId).toBe('turn-1')
    expect(withBody.requestId).toBe('request-1')
    expect(withBody.lastProgressAt).toBe(11_100)
    expect(withBody.progressEvents).toBe(1)

    const sameBody = recordCheckpointBody({
      state: withBody,
      now: 15_000,
      currentNode: 'node-1',
      updateTime: 123.5,
      turnExchangeId: 'turn-1',
      requestId: 'request-1',
    })
    expect(sameBody.lastProgressAt).toBe(11_100)
    expect(sameBody.progressEvents).toBe(1)

    const advancedBody = recordCheckpointBody({
      state: sameBody,
      now: 16_000,
      currentNode: 'node-2',
      updateTime: 124.5,
    })
    expect(advancedBody.lastProgressAt).toBe(16_000)
    expect(advancedBody.progressEvents).toBe(2)

    const errored = recordCheckpointError({
      state: advancedBody,
      now: 12_000,
      error: 'HTTP 503',
      retryDelayMs: 30_000,
    })
    expect(errored.consecutiveErrors).toBe(1)
    expect(errored.lastError).toBe('HTTP 503')
    expect(errored.nextProbeAt).toBe(42_000)

    const complete = recordCheckpointStatus({
      state: errored,
      rawStatus: 'COMPLETE',
      now: 42_000,
      nextDelayMs: 8_000,
    })
    expect(complete.lastStatus).toBe('complete')
    expect(complete.consecutiveErrors).toBe(0)
    expect(complete.lastError).toBeNull()
  })

  test('主动 polling 在年龄、请求预算、无进展任一边界前 fail-closed', () => {
    const base = createCheckpointWatch({
      conversationId: 'cid-safe',
      source: 'devspace:first-tool',
      now: 1_000,
    })
    expect(checkpointSafetyStopReason({
      state: base,
      now: 120_999,
      maxWatchMs: 120_000,
      maxRequests: 24,
      noProgressMs: 60_000,
    })).toBeNull()
    expect(checkpointSafetyStopReason({
      state: base,
      now: 121_000,
      maxWatchMs: 120_000,
      maxRequests: 24,
      noProgressMs: 60_000,
    })).toBe('watch-age-limit')

    const budgeted = {
      ...base,
      probes: 12,
      bodyRefreshes: 12,
    }
    expect(checkpointSafetyStopReason({
      state: budgeted,
      now: 2_000,
      maxWatchMs: 120_000,
      maxRequests: 24,
      noProgressMs: 60_000,
    })).toBe('request-budget-limit')

    const progressed = recordCheckpointBody({
      state: base,
      now: 10_000,
      currentNode: 'node-1',
      updateTime: 1,
    })
    expect(checkpointSafetyStopReason({
      state: progressed,
      now: 69_999,
      maxWatchMs: 300_000,
      maxRequests: 100,
      noProgressMs: 60_000,
    })).toBeNull()
    expect(checkpointSafetyStopReason({
      state: progressed,
      now: 70_000,
      maxWatchMs: 300_000,
      maxRequests: 100,
      noProgressMs: 60_000,
    })).toBe('no-progress-limit')
  })
})

