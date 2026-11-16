import { describe, expect, test } from 'vitest'
import {
  CATALOG_BACKOFF_MS,
  DETAIL_BACKOFF_MS,
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
    expect(first.backoffUntil).toBe(61_000)
    const extended = recordFamily429(state, 'body', {
      now: 2000,
      requestedDeadline: 120_000,
      retryAfter: '53',
    })
    expect(extended.backoffUntil).toBe(120_000)
    expect(extended.stage).toBe(0)
  })

  test('Body 连续 429 会逐级退避到 12 分钟，重启恢复后继续，而不是每分钟探测', () => {
    const state = restoreFamilyRateLimitSnapshot({}, 0)
    let now = 10_000
    for (let index = 0; index < DETAIL_BACKOFF_MS.length + 2; index += 1) {
      const expectedIndex = Math.min(index, DETAIL_BACKOFF_MS.length - 1)
      const current = recordFamily429(state, 'body', {
        now, retryAfter: '20', requestedDeadline: now + 20_000,
      })
      expect(current.stage).toBe(expectedIndex)
      expect(current.backoffUntil).toBe(now + DETAIL_BACKOFF_MS[expectedIndex])
      const duplicate = recordFamily429(state, 'body', {
        now: now + 1000, retryAfter: '10', requestedDeadline: now + 11_000,
      })
      expect(duplicate.stage).toBe(expectedIndex)
      expect(duplicate.backoffUntil).toBe(current.backoffUntil)
      const restored = restoreFamilyRateLimitSnapshot({ rateLimits: state }, now + 2000)
      expect(restored.families.body.stage).toBe(expectedIndex)
      now = current.backoffUntil + 1
    }
    const probe = recordFamilySuccess(state, 'body', now)
    expect(probe.probationRemaining).toBe(2)
    expect(recordFamilySuccess(state, 'body', now + 1000).probationRemaining).toBe(1)
    expect(recordFamilySuccess(state, 'body', now + 2000).stage).toBe(-1)
  })

  test('服务端长 Retry-After 始终优先，Mapping 连续失败也有独立阶梯', () => {
    const state = restoreFamilyRateLimitSnapshot({}, 0)
    const first = recordFamily429(state, 'mapping', {
      now: 1000, retryAfter: '300', requestedDeadline: 301_000,
    })
    expect(first.backoffUntil).toBe(301_000)
    expect(first.stage).toBe(0)
    const next = recordFamily429(state, 'mapping', {
      now: 301_001, retryAfter: '5', requestedDeadline: 306_001,
    })
    expect(next.backoffUntil).toBe(421_001)
    expect(state.families.body.stage).toBe(-1)
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
    expect(familyRateLimitAllowed(state, 'project-catalog', 2000)).toBe(true)
    expect(familyRateLimitAllowed(state, 'actor', 2000)).toBe(true)
    expect(familyBackoffUntil(state, 'body', 2000)).toBe(61_000)
  })

  test('project catalog has an independent catalog-style backoff bucket', () => {
    const state = restoreFamilyRateLimitSnapshot({}, 0)
    const first = recordFamily429(state, 'project-catalog', { now: 1000 })
    expect(first.stage).toBe(0)
    expect(first.backoffUntil).toBe(1000 + CATALOG_BACKOFF_MS[0])
    expect(familyRateLimitAllowed(state, 'project-catalog', 2000)).toBe(false)
    expect(familyRateLimitAllowed(state, 'catalog', 2000)).toBe(true)
    expect(familyRateLimitAllowed(state, 'body', 2000)).toBe(true)
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

    recordFamily429(state, 'project-catalog', { now: 3000 })
    expect(guardianBlockedUrlPatterns(state, 4000)).toEqual([
      'https://chatgpt.com/backend-api/conversations?*',
      'https://chatgpt.com/backend-api/gizmos/snorlax/sidebar*',
      'https://chatgpt.com/backend-api/gizmos/*/conversations*',
      'https://chatgpt.com/backend-api/conversations/*',
    ])
  })
})

