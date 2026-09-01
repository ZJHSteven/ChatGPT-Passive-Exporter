import { describe, expect, it } from 'vitest'
import {
  assessConversationPayload,
  preferPassiveSnapshot,
} from '../src/core/conversation-snapshot'
import type { PassiveCaptureEnvelope, RawConversationPayload } from '../src/core/types'

function plural(id: string, count: number, hasPreviousPage?: boolean): RawConversationPayload {
  return {
    conversation_id: id,
    messages: Array.from({ length: count }, (_, index) => ({
      id: `${id}-${index}`,
      author: { role: index % 2 === 0 ? 'user' : 'assistant' },
      content: { content_type: 'text', parts: [`m${index}`] },
    })),
    page_info: hasPreviousPage === undefined ? {} : { has_previous_page: hasPreviousPage },
  }
}

function envelope(payload: RawConversationPayload, capturedAt: number): PassiveCaptureEnvelope {
  return {
    protocol: 'chatgpt-passive-exporter/v1',
    capturedAt,
    url: `https://chatgpt.com/backend-api/conversations/${payload.conversation_id}`,
    transport: 'fetch',
    payload,
  }
}

describe('conversation snapshot completeness', () => {
  it('把 has_previous_page=true 判为 partial', () => {
    expect(assessConversationPayload(plural('c1', 2, true)).completeness).toBe('partial')
  })

  it('把 has_previous_page=false 判为 complete', () => {
    expect(assessConversationPayload(plural('c1', 40, false)).completeness).toBe('complete')
  })

  it('缺分页证据时保持 unknown，不把 JSON 误当完整聊天', () => {
    expect(assessConversationPayload(plural('c1', 20)).completeness).toBe('unknown')
  })

  it('新的两轮 partial 不能覆盖旧的完整 snapshot', () => {
    const complete = envelope(plural('c1', 40, false), 100)
    const newerTail = envelope(plural('c1', 2, true), 200)
    expect(preferPassiveSnapshot(complete, newerTail)).toBe(complete)
  })

  it('同等级时保留消息更多的 snapshot', () => {
    const small = envelope(plural('c1', 10), 200)
    const large = envelope(plural('c1', 30), 100)
    expect(preferPassiveSnapshot(small, large)).toBe(large)
  })
})
