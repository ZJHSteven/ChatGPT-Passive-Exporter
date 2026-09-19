import { describe, expect, test } from 'vitest'
import { clusterCompletionBursts, parseTurnTraceLines } from '../src/local/turn-trace-reader.ts'

describe('Turn trace reader', () => {
  test('JSONL 最后一行损坏时仍保留前面的完整记录', () => {
    const records = parseTurnTraceLines([
      JSON.stringify({ version: 1, at: 1, kind: 'wss-lifecycle', conversationId: 'a', completesTurn: true }),
      '{broken',
    ].join('\n'))
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ conversationId: 'a', at: 1 })
  })

  test('三个 16 秒内 complete 会聚成一个 burst，并吸附后续 body 诊断', () => {
    const records = parseTurnTraceLines([
      JSON.stringify({ version: 1, at: 1000, kind: 'wss-lifecycle', conversationId: 'a', completesTurn: true, activeBefore: 3 }),
      JSON.stringify({ version: 1, at: 9000, kind: 'wss-lifecycle', conversationId: 'b', completesTurn: true, activeBefore: 2 }),
      JSON.stringify({ version: 1, at: 17000, kind: 'wss-lifecycle', conversationId: 'c', completesTurn: true, activeBefore: 1 }),
      JSON.stringify({ version: 1, at: 1200, kind: 'body-snapshot', conversationId: 'a', requestId: 'r-a', turnExchangeId: 't-a', terminalEvidence: 'none', tailShape: 'reasoning-ended-no-final' }),
      JSON.stringify({ version: 1, at: 200000, kind: 'wss-lifecycle', conversationId: 'd', completesTurn: true, activeBefore: 0 }),
    ].join('\n'))

    expect(clusterCompletionBursts(records, 30_000)).toEqual([
      {
        startAt: 1000,
        endAt: 17000,
        durationMs: 16000,
        count: 3,
        conversations: ['a', 'b', 'c'],
        maxObservedActiveBefore: 3,
        items: [
          {
            conversationId: 'a',
            completeAt: 1000,
            activeBefore: 3,
            requestId: 'r-a',
            turnExchangeId: 't-a',
            terminalEvidence: 'none',
            tailShape: 'reasoning-ended-no-final',
          },
          {
            conversationId: 'b', completeAt: 9000, activeBefore: 2,
            requestId: null, turnExchangeId: null, terminalEvidence: null, tailShape: null,
          },
          {
            conversationId: 'c', completeAt: 17000, activeBefore: 1,
            requestId: null, turnExchangeId: null, terminalEvidence: null, tailShape: null,
          },
        ],
      },
    ])
  })
})

