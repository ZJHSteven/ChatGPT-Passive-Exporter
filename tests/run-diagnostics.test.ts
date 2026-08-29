import { describe, expect, test } from 'vitest'
import { diagnoseLatestRun } from '../src/core/run-diagnostics'
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
    expect(result.tailShape).toBe('reasoning-open')
    expect(result.summary).toContain('不能据此判死')
    expect(result.assistantToolCalls).toBe(1)
    expect(result.toolResults).toBe(1)
  })
})
