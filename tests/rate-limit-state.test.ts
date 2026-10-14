import { describe, expect, test } from 'vitest'
import {
  CATALOG_BACKOFF_MS,
  familyBackoffUntil,
  familyProbationRemaining,
  familyRateLimitAllowed,
  guardianBlockedUrlPatterns,
  recordFamily429,
  recordFamilySuccess,
  restoreFamilyRateLimitSnapshot,
} from '../src/local/rate-limit-state.ts'

describe('family rate-limit state', () => {
  test('旧版 cooldownUntil 只做一次 legacy global 迁移', () => {
    const now = 1_000_000
    const state = restoreFamilyRateLimitSnapshot({ cooldownUntil: now + 60_000 }, now)
    expect(state.legacyGlobalUntil).toBe(now + 60_000)
    expect(familyRateLimitAllowed(state, 'catalog', now)).toBe(false)
    expect(familyRateLimitAllowed(state, 'body', now)).toBe(false)

    const restoredAgain = restoreFamilyRateLimitSnapshot({ rateLimits: state, cooldownUntil: now + 999_999 }, now)
    expect(restoredAgain.legacyGlobalUntil).toBe(now + 60_000)
  })

  test('catalog 无 Retry-After 按 5/10/20/30/60 分钟阶梯退避', () => {
    const state = restoreFamilyRateLimitSnapshot({}, 0)
    let now = 1_000
    for (let index = 0; index < CATALOG_BACKOFF_MS.length; index += 1) {
      const current = recordFamily429(state, 'catalog', { now })
      expect(current.stage).toBe(index)
      expect(current.backoffUntil).toBe(now + CATALOG_BACKOFF_MS[index]!)
      now = current.backoffUntil + 1
    }

    const capped = recordFamily429(state, 'catalog', { now })
    expect(capped.stage).toBe(CATALOG_BACKOFF_MS.length - 1)
    expect(capped.backoffUntil).toBe(now + CATALOG_BACKOFF_MS.at(-1)!)
  })

  test('同一 catalog backoff 窗口内 native 重复 429 不升级也不滑动续杯', () => {
    const state = restoreFamilyRateLimitSnapshot({}, 0)
    const first = recordFamily429(state, 'catalog', { now: 10_000 })
    const originalUntil = first.backoffUntil
    const repeated = recordFamily429(state, 'catalog', { now: 20_000 })
    expect(repeated.stage).toBe(0)
    expect(repeated.backoffUntil).toBe(originalUntil)
  })

  test('已有 backoff 期间更长的 Retry-After 仍可向后延长', () => {
    const state = restoreFamilyRateLimitSnapshot({}, 0)
    const first = recordFamily429(state, 'body', {
      now: 1000,
      requestedDeadline: 31_000,
      retryAfter: '7',
    })
    expect(first.backoffUntil).toBe(31_000)
    const extended = recordFamily429(state, 'body', {
      now: 2000,
      requestedDeadline: 60_000,
      retryAfter: '53',
    })
    expect(extended.backoffUntil).toBe(60_000)
  })

  test('catalog 到期进入三次 probation，连续成功后恢复 HEALTHY', () => {
    const state = restoreFamilyRateLimitSnapshot({}, 0)
    const first = recordFamily429(state, 'catalog', { now: 1000 })
    const probeAt = first.backoffUntil + 1
    expect(familyProbationRemaining(state, 'catalog', probeAt)).toBe(3)
    expect(recordFamilySuccess(state, 'catalog', probeAt).probationRemaining).toBe(2)
    expect(recordFamilySuccess(state, 'catalog', probeAt + 30_000).probationRemaining).toBe(1)
    const healthy = recordFamilySuccess(state, 'catalog', probeAt + 60_000)
    expect(healthy.probationRemaining).toBe(0)
    expect(healthy.stage).toBe(-1)
    expect(familyRateLimitAllowed(state, 'catalog', probeAt + 60_000)).toBe(true)
  })

  test('catalog probation 再次 429 会升一级而不是回到 5 分钟', () => {
    const state = restoreFamilyRateLimitSnapshot({}, 0)
    const first = recordFamily429(state, 'catalog', { now: 1000 })
    const probeAt = first.backoffUntil + 1
    expect(familyProbationRemaining(state, 'catalog', probeAt)).toBe(3)
    const failed = recordFamily429(state, 'catalog', { now: probeAt })
    expect(failed.stage).toBe(1)
    expect(failed.backoffUntil).toBe(probeAt + CATALOG_BACKOFF_MS[1])
  })

  test('body Retry-After 只冻结 body，不影响 catalog/actor', () => {
    const state = restoreFamilyRateLimitSnapshot({}, 0)
    recordFamily429(state, 'body', {
      now: 1000,
      retryAfter: '7',
      requestedDeadline: 31_000,
    })
    expect(familyRateLimitAllowed(state, 'body', 2000)).toBe(false)
    expect(familyRateLimitAllowed(state, 'catalog', 2000)).toBe(true)
    expect(familyRateLimitAllowed(state, 'actor', 2000)).toBe(true)
    expect(familyBackoffUntil(state, 'body', 2000)).toBe(31_000)
  })

  test('Guardian URL block 也按 family 拆开', () => {
    const state = restoreFamilyRateLimitSnapshot({}, 0)
    recordFamily429(state, 'catalog', { now: 1000 })
    expect(guardianBlockedUrlPatterns(state, 2000)).toEqual([
      'https://chatgpt.com/backend-api/conversations?*',
    ])

    recordFamily429(state, 'body', { now: 2000, fallbackMs: 60_000 })
    expect(guardianBlockedUrlPatterns(state, 3000)).toEqual([
      'https://chatgpt.com/backend-api/conversations?*',
      'https://chatgpt.com/backend-api/conversations/*',
    ])
  })
})

