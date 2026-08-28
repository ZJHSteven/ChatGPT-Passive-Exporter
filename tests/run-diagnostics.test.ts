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

describe('最后一轮运行诊断', () => {
  test('识别正常 final', () => {
    const result = diagnoseLatestRun(payload([
      message({ id: 'u1', author: { role: 'user' }, content: { content_type: 'text', parts: ['go'] } }),
      message({ id: 'a1', channel: 'final', metadata: { finish_details: { type: 'stop', stop_tokens: [200002] } } }),
    ]))

    expect(result.outcome).toBe('complete')
    expect(result.hasFinal).toBe(true)
  })

  test('client_stopped 优先于其它未完成信号', () => {
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

    expect(result.outcome).toBe('client-stopped')
    expect(result.interruptedReason).toBe('client_stopped')
    expect(result.turnExchangeId).toBe('turn-1')
    expect(result.requestId).toBe('request-1')
  })

  test('识别最后 tool call 没有对应 result', () => {
    const result = diagnoseLatestRun(payload([
      message({ id: 'u1', author: { role: 'user' } }),
      message({ id: 'thought', content: { content_type: 'thoughts' }, metadata: { reasoning_status: 'is_reasoning' } }),
      message({ id: 'call1', recipient: 'api_tool.call_tool', content: { content_type: 'code', text: '{}' } }),
    ]))

    expect(result.outcome).toBe('tool-result-missing')
    expect(result.assistantToolCalls).toBe(1)
    expect(result.toolResults).toBe(0)
  })

  test('tool result 已回来但 reasoning 没收尾时识别为 reasoning-incomplete', () => {
    const result = diagnoseLatestRun(payload([
      message({ id: 'u1', author: { role: 'user' } }),
      message({ id: 'thought', content: { content_type: 'thoughts' }, metadata: { reasoning_status: 'is_reasoning' } }),
      message({ id: 'call1', recipient: 'api_tool.call_tool', content: { content_type: 'code', text: '{}' } }),
      message({ id: 'tool1', author: { role: 'tool' }, content: { content_type: 'code', text: '{"ok":true}' } }),
    ]))

    expect(result.outcome).toBe('reasoning-incomplete')
    expect(result.assistantToolCalls).toBe(1)
    expect(result.toolResults).toBe(1)
  })
})
