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
      requestedDeadline: 120_000,
      retryAfter: '53',
    })
    expect(extended.backoffUntil).toBe(120_000)
    expect(extended.stage).toBe(-1)
    expect(state.sharedRetryAfterUntil).toBe(120_000)
  })

  test('Body 多次 429 严格遵循 Retry-After，不叠加本地指数退避，跨重启保留共享期限', () => {
    const state = restoreFamilyRateLimitSnapshot({}, 0)
    let now = 10_000
    for (let index = 0; index < 7; index += 1) {
      const current = recordFamily429(state, 'body', {
        now, retryAfter: '20', requestedDeadline: now + 20_000,
      })
      expect(current.stage).toBe(-1)
      expect(current.backoffUntil).toBe(now + 20_000)
      expect(state.sharedRetryAfterUntil).toBe(now + 20_000)
      const duplicate = recordFamily429(state, 'body', {
        now: now + 1000, retryAfter: '10', requestedDeadline: now + 11_000,
      })
      expect(duplicate.stage).toBe(-1)
      expect(duplicate.backoffUntil).toBe(current.backoffUntil)
      const restored = restoreFamilyRateLimitSnapshot({ rateLimits: state }, now + 2000)
      expect(restored.families.body.stage).toBe(-1)
      expect(restored.sharedRetryAfterUntil).toBe(now + 20_000)
      now = current.backoffUntil + 1
    }
    const probe = recordFamilySuccess(state, 'body', now)
    expect(probe.probationRemaining).toBe(2)
    expect(recordFamilySuccess(state, 'body', now + 1000).probationRemaining).toBe(1)
    expect(recordFamilySuccess(state, 'body', now + 2000).stage).toBe(-1)
  })

  test('Mapping 连续 429 不额外延长，且每次 Retry-After 都暂停所有主动 family', () => {
    const state = restoreFamilyRateLimitSnapshot({}, 0)
    const first = recordFamily429(state, 'mapping', {
      now: 1000, retryAfter: '300', requestedDeadline: 301_000,
    })
    expect(first.backoffUntil).toBe(301_000)
    expect(first.stage).toBe(-1)
    expect(familyRateLimitAllowed(state, 'actor', 300_000)).toBe(false)
    const next = recordFamily429(state, 'mapping', {
      now: 301_001, retryAfter: '5', requestedDeadline: 306_001,
    })
    expect(next.backoffUntil).toBe(306_001)
    expect(state.sharedRetryAfterUntil).toBe(306_001)
    expect(familyRateLimitAllowed(state, 'body', 306_000)).toBe(false)
    expect(familyRateLimitAllowed(state, 'body', 306_001)).toBe(true)
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

  test('任意 Body Retry-After 是所有 Archive 主动读取的共享门限，但不改写其它 family 的本地退避', () => {
    const state = restoreFamilyRateLimitSnapshot({}, 0)
    recordFamily429(state, 'body', {
      now: 1000,
      retryAfter: '7',
      requestedDeadline: 31_000,
    })
    expect(familyRateLimitAllowed(state, 'body', 2000)).toBe(false)
    expect(familyRateLimitAllowed(state, 'catalog', 2000)).toBe(false)
    expect(familyRateLimitAllowed(state, 'project-catalog', 2000)).toBe(false)
    expect(familyRateLimitAllowed(state, 'actor', 2000)).toBe(false)
    expect(familyBackoffUntil(state, 'body', 2000)).toBe(31_000)
    expect(familyBackoffUntil(state, 'catalog', 2000)).toBe(31_000)
    expect(familyRateLimitAllowed(state, 'catalog', 31_000)).toBe(true)
    expect(state.families.catalog.backoffUntil).toBe(0)
  })

  test('共享 Retry-After 期间 Guardian 的可精确识别读取路由统一拦截，登入路由不被通配阻断', () => {
    const state = restoreFamilyRateLimitSnapshot({}, 0)
    recordFamily429(state, 'body', { now: 1000, retryAfter: '40', requestedDeadline: 41_000 })
    expect(guardianBlockedUrlPatterns(state, 2000)).toEqual([
      'https://chatgpt.com/backend-api/conversations?*',
      'https://chatgpt.com/backend-api/conversations/*',
      'https://chatgpt.com/backend-api/gizmos/snorlax/sidebar*',
      'https://chatgpt.com/backend-api/gizmos/*/conversations*',
    ])
    expect(guardianBlockedUrlPatterns(state, 41_001)).toEqual([])
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

