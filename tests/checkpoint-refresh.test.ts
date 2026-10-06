import { describe, expect, test } from 'vitest'

import {
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

    const errored = recordCheckpointError({
      state: withBody,
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
})

