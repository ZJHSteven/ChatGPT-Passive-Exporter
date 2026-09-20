import { describe, expect, test } from 'vitest'
import { diagnoseLatestRun, diagnoseRuns } from '../src/core/run-diagnostics'
import type { MessagesConversationPayload, RawChatMessage } from '../src/core/types'

function message(input: Partial<RawChatMessage> & Pick<RawChatMessage, 'id'>): RawChatMessage {
  return {
    author: { role: 'assistant' },
    recipient: 'all',
    content: { content_type: 'text', parts: [''] },
    metadata: {},
    ...input,
  }
}

function payload(messages: RawChatMessage[]): MessagesConversationPayload {
  return {
    conversation_id: 'fixture-run-watch',
    current_node: messages.at(-1)?.id,
    messages,
  }
}

describe('最后一轮快照诊断', () => {
  test('final 是明确终止证据', () => {
    const result = diagnoseLatestRun(payload([
      message({ id: 'u1', author: { role: 'user' }, content: { content_type: 'text', parts: ['go'] } }),
      message({ id: 'a1', channel: 'final', metadata: { finish_details: { type: 'stop', stop_tokens: [200002] } } }),
    ]))

    expect(result.terminalEvidence).toBe('final')
    expect(result.tailShape).toBe('final')
    expect(result.hasFinal).toBe(true)
  })

  test('client_stopped 是明确终止证据', () => {
    const result = diagnoseLatestRun(payload([
      message({ id: 'u1', author: { role: 'user' } }),
      message({
        id: 'call1',
        recipient: 'api_tool.call_tool',
        content: { content_type: 'code', text: '{"tool":"bash"}' },
        metadata: {
          turn_exchange_id: 'turn-1',
          request_id: 'request-1',
          reasoning_status: 'is_reasoning',
          finish_details: { type: 'interrupted', reason: 'client_stopped' },
        },
      }),
    ]))

    expect(result.terminalEvidence).toBe('client-stopped')
    expect(result.interruptedReason).toBe('client_stopped')
    expect(result.turnExchangeId).toBe('turn-1')
    expect(result.requestId).toBe('request-1')
  })

  test('最后 tool call 无 result 只描述快照尾部，不证明已死', () => {
    const result = diagnoseLatestRun(payload([
      message({ id: 'u1', author: { role: 'user' } }),
      message({ id: 'thought', content: { content_type: 'thoughts' }, metadata: { reasoning_status: 'is_reasoning' } }),
      message({ id: 'call1', recipient: 'api_tool.call_tool', content: { content_type: 'code', text: '{}' } }),
    ]))

    expect(result.terminalEvidence).toBe('none')
    expect(result.tailShape).toBe('tool-call-open')
    expect(result.summary).toContain('不能据此判死')
    expect(result.assistantToolCalls).toBe(1)
    expect(result.toolResults).toBe(0)
  })

  test('reasoning open 只描述快照尾部，不证明已死', () => {
    const result = diagnoseLatestRun(payload([
      message({ id: 'u1', author: { role: 'user' } }),
      message({ id: 'thought', content: { content_type: 'thoughts' }, metadata: { reasoning_status: 'is_reasoning' } }),
      message({ id: 'call1', recipient: 'api_tool.call_tool', content: { content_type: 'code', text: '{}' } }),
      message({ id: 'tool1', author: { role: 'tool' }, content: { content_type: 'code', text: '{"ok":true}' } }),
    ]))

    expect(result.terminalEvidence).toBe('none')
    expect(result.tailShape).toBe('tool-result-returned')
    expect(result.summary).toContain('不能据此判死')
    expect(result.assistantToolCalls).toBe(1)
    expect(result.toolResults).toBe(1)
  })

  test('reasoning after a tool result is the real tail', () => {
    const result = diagnoseLatestRun(payload([
      message({ id: 'u1', author: { role: 'user' } }),
      message({ id: 'call1', recipient: 'api_tool.call_tool', content: { content_type: 'code', text: '{}' } }),
      message({ id: 'tool1', author: { role: 'tool' }, content: { content_type: 'code', text: '{"ok":true}' } }),
      message({ id: 'thought2', content: { content_type: 'thoughts' }, metadata: { reasoning_status: 'is_reasoning' } }),
    ]))

    expect(result.terminalEvidence).toBe('none')
    expect(result.tailShape).toBe('reasoning-open')
  })

  test('一个 page 内多个 user turn 会被逐 turn 诊断，而不是只看整页最后一轮', () => {
    const results = diagnoseRuns(payload([
      message({ id: 'u1', author: { role: 'user' }, metadata: { turn_exchange_id: 'turn-1' } }),
      message({ id: 'call1', recipient: 'api_tool.call_tool', content: { content_type: 'code', text: '{}' }, metadata: { turn_exchange_id: 'turn-1' } }),
      message({ id: 'tool1', author: { role: 'tool' }, content: { content_type: 'code', text: '{"ok":true}' }, metadata: { turn_exchange_id: 'turn-1' } }),
      message({ id: 'u2', author: { role: 'user' }, metadata: { turn_exchange_id: 'turn-2' } }),
      message({ id: 'a2', channel: 'final', metadata: { turn_exchange_id: 'turn-2', finish_details: { type: 'stop', stop_tokens: [200002] } } }),
    ]))

    expect(results).toHaveLength(2)
    expect(results[0]).toMatchObject({ turnExchangeId: 'turn-1', tailShape: 'tool-result-returned', terminalEvidence: 'none' })
    expect(results[1]).toMatchObject({ turnExchangeId: 'turn-2', tailShape: 'final', terminalEvidence: 'final' })
  })

  test('same turn_exchange_id user steering stays inside one logical turn', () => {
    const results = diagnoseRuns(payload([
      message({ id: 'u1', author: { role: 'user' }, metadata: { turn_exchange_id: 'turn-1', request_id: 'request-1' } }),
      message({ id: 'thought1', content: { content_type: 'thoughts' }, metadata: { turn_exchange_id: 'turn-1', request_id: 'request-1', reasoning_status: 'is_reasoning' } }),
      message({ id: 'call1', recipient: 'api_tool.call_tool', content: { content_type: 'code', text: '{}' }, metadata: { turn_exchange_id: 'turn-1', request_id: 'request-1' } }),
      message({ id: 'tool1', author: { role: 'tool' }, content: { content_type: 'code', text: '{"ok":true}' }, metadata: { turn_exchange_id: 'turn-1', request_id: 'request-1' } }),
      message({ id: 'u-steer', author: { role: 'user' }, metadata: { turn_exchange_id: 'turn-1', request_id: 'request-1' } }),
      message({ id: 'recap1', content: { content_type: 'reasoning_recap', parts: ['steered'] }, metadata: { turn_exchange_id: 'turn-1', request_id: 'request-1', reasoning_status: 'reasoning_ended' } }),
      message({ id: 'u2', author: { role: 'user' }, metadata: { turn_exchange_id: 'turn-2', request_id: 'request-2' } }),
      message({ id: 'a2', channel: 'final', metadata: { turn_exchange_id: 'turn-2', request_id: 'request-2', finish_details: { type: 'stop', stop_tokens: [200002] } } }),
    ]))

    expect(results).toHaveLength(2)
    expect(results[0]).toMatchObject({
      turnExchangeId: 'turn-1',
      requestId: 'request-1',
      tailShape: 'reasoning-ended-no-final',
      nodeCount: 6,
      userMessageCount: 2,
      hasInTurnSteering: true,
    })
    expect(results[1]).toMatchObject({ turnExchangeId: 'turn-2', requestId: 'request-2', tailShape: 'final' })

    const latest = diagnoseLatestRun(payload([
      message({ id: 'u1', author: { role: 'user' }, metadata: { turn_exchange_id: 'turn-1', request_id: 'request-1' } }),
      message({ id: 'call1', recipient: 'api_tool.call_tool', content: { content_type: 'code', text: '{}' }, metadata: { turn_exchange_id: 'turn-1', request_id: 'request-1' } }),
      message({ id: 'tool1', author: { role: 'tool' }, metadata: { turn_exchange_id: 'turn-1', request_id: 'request-1' } }),
      message({ id: 'u-steer', author: { role: 'user' }, metadata: { turn_exchange_id: 'turn-1', request_id: 'request-1' } }),
      message({ id: 'recap1', content: { content_type: 'reasoning_recap', parts: ['steered'] }, metadata: { turn_exchange_id: 'turn-1', request_id: 'request-1', reasoning_status: 'reasoning_ended' } }),
    ]))
    expect(latest.nodeCount).toBe(5)
    expect(latest.turnExchangeId).toBe('turn-1')
  })

  test('reasoning 已结束但 final 缺失会单独标成 reasoning-ended-no-final', () => {
    const result = diagnoseLatestRun(payload([
      message({ id: 'u1', author: { role: 'user' }, metadata: { turn_exchange_id: 'turn-1' } }),
      message({ id: 'thought', content: { content_type: 'thoughts' }, metadata: { turn_exchange_id: 'turn-1', reasoning_status: 'is_reasoning' } }),
      message({ id: 'recap', content: { content_type: 'reasoning_recap', parts: ['完成推理'] }, metadata: { turn_exchange_id: 'turn-1', reasoning_status: 'reasoning_ended' } }),
    ]))

    expect(result.terminalEvidence).toBe('none')
    expect(result.tailShape).toBe('reasoning-ended-no-final')
    expect(result.summary).toContain('final')
  })
})
