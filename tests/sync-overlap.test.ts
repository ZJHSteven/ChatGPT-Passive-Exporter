import { describe, expect, test } from 'vitest'
import {
  evaluateBodyPage,
  evaluateCatalogPage,
  initialCatalogOverlapState,
  normalizeChatgptTime,
  type LocalCatalogConversation,
} from '../src/local/sync-overlap.ts'

function local(rows: Array<[string, number, string?]>): Map<string, LocalCatalogConversation> {
  return new Map(rows.map(([id, updateTime, title]) => [id, { id, updateTime, title: title ?? id }]))
}

describe('conversation list overlap', () => {
  test('第一页整页都是新 conversation 时绝不能停止，必须继续到最后变化后的连续稳定 overlap', () => {
    const knownRows: Array<[string, number]> = []
    for (let index = 0; index < 28; index += 1) knownRows.push([`old-${index}`, 1000 - index])
    const known = local(knownRows)
    let state = initialCatalogOverlapState()

    const firstPage = Array.from({ length: 28 }, (_, index) => ({
      id: `new-${index}`,
      title: `new-${index}`,
      updateTime: 2000 - index,
    }))
    const first = evaluateCatalogPage(firstPage, known, state, { requiredStableItems: 28, pageSize: 28 })
    expect(first.shouldStop).toBe(false)
    expect(first.nextState.stableTailItems).toBe(0)
    expect(first.differences).toHaveLength(28)
    state = first.nextState

    const secondPage = knownRows.map(([id, updateTime]) => ({ id, title: id, updateTime }))
    const second = evaluateCatalogPage(secondPage, known, state, { requiredStableItems: 28, pageSize: 28 })
    expect(second.shouldStop).toBe(true)
    expect(second.stopReason).toBe('stable-overlap')
    expect(second.nextState.stableTailItems).toBe(28)
  })

  test('新增/更新会重置 overlap，直到后面连续稳定条目达到阈值才停止', () => {
    const known = local([
      ['old-a', 100], ['old-b', 90], ['old-c', 80], ['old-d', 70],
      ['old-e', 60], ['old-f', 50],
    ])
    let state = initialCatalogOverlapState()

    const first = evaluateCatalogPage([
      { id: 'brand-new', title: '新聊天', updateTime: 130 },
      { id: 'old-a', title: 'old-a', updateTime: 120 },
      { id: 'old-b', title: 'old-b', updateTime: 90 },
      { id: 'old-c', title: 'old-c', updateTime: 80 },
    ], known, state, { requiredStableItems: 4, pageSize: 4 })

    expect(first.differences.map(item => [item.id, item.reason])).toEqual([
      ['brand-new', 'new'],
      ['old-a', 'updated'],
    ])
    expect(first.shouldStop).toBe(false)
    expect(first.nextState.stableTailItems).toBe(2)
    state = first.nextState

    const second = evaluateCatalogPage([
      { id: 'old-d', title: 'old-d', updateTime: 70 },
      { id: 'old-e', title: 'old-e', updateTime: 60 },
      { id: 'old-f', title: 'old-f', updateTime: 50 },
      { id: 'old-b', title: 'old-b', updateTime: 90 },
    ], known, state, { requiredStableItems: 4, pageSize: 4 })

    expect(second.differences).toHaveLength(0)
    expect(second.shouldStop).toBe(true)
    expect(second.stopReason).toBe('stable-overlap')
  })

  test('标题变化即使 update_time 相同也属于需要同步的 metadata 变化', () => {
    const known = local([['a', 100, '旧标题']])
    const result = evaluateCatalogPage(
      [{ id: 'a', title: '新标题', updateTime: 100 }],
      known,
      initialCatalogOverlapState(),
      { pageSize: 28 },
    )
    expect(result.differences[0]?.reason).toBe('metadata-changed')
    expect(result.stopReason).toBe('end-of-catalog')
  })

  test('服务端时间倒退/缺失不能算稳定 overlap，也不能覆盖本地新状态', () => {
    const known = local([['a', 100]])
    const result = evaluateCatalogPage(
      [{ id: 'a', title: 'a', updateTime: 90 }],
      known,
      initialCatalogOverlapState(),
      { requiredStableItems: 1, pageSize: 1 },
    )
    expect(result.differences[0]?.reason).toBe('server-older-or-ambiguous')
    expect(result.shouldStop).toBe(false)
  })

  test('ISO 时间和数字字符串都能归一化为秒', () => {
    expect(normalizeChatgptTime('123.5')).toBe(123.5)
    expect(normalizeChatgptTime('1970-01-01T00:02:03.500Z')).toBe(123.5)
  })
})

describe('conversation body overlap', () => {
  const known = new Set(['m1', 'm2', 'm3', 'm4'])

  test('一页里只要有未知 message，就继续向前翻', () => {
    const result = evaluateBodyPage({ messageIds: ['m3', 'm4', 'm5'], hasPreviousPage: true }, known)
    expect(result.unknownMessageIds).toEqual(['m5'])
    expect(result.shouldStop).toBe(false)
  })

  test('拿到一整页全部已知 message 后才确认跨过 overlap 边界', () => {
    const result = evaluateBodyPage({ messageIds: ['m1', 'm2', 'm3'], hasPreviousPage: true }, known)
    expect(result.unknownMessageIds).toHaveLength(0)
    expect(result.shouldStop).toBe(true)
    expect(result.stopReason).toBe('full-known-page')
  })

  test('即使最后一页仍全是未知，也因 has_previous_page=false 自然到底', () => {
    const result = evaluateBodyPage({ messageIds: ['historic-new-id'], hasPreviousPage: false }, known)
    expect(result.shouldStop).toBe(true)
    expect(result.stopReason).toBe('end-of-history')
  })
})
