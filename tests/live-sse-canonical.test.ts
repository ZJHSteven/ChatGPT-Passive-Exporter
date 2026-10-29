import { describe, expect, test } from 'vitest'
import { LiveSseCanonicalAccumulator } from '../src/local/live-sse-canonical.ts'

function event(value: unknown): string {
  return `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`
}

function syntheticCompleteStream(): string {
  return [
    event(JSON.stringify('v1')),
    event({
      o: 'add',
      p: '',
      c: 0,
      v: {
        conversation_id: 'cid-1',
        message: {
          id: 'user-1',
          author: { role: 'user', name: null, metadata: {} },
          content: { content_type: 'text', parts: ['hello'] },
          status: 'finished_successfully',
          end_turn: null,
          weight: 1,
          metadata: { request_id: 'req-1', turn_exchange_id: 'turn-1' },
          recipient: 'all',
          channel: null,
        },
      },
    }),
    event({
      c: 1,
      v: {
        conversation_id: 'cid-1',
        message: {
          id: 'assistant-1',
          author: { role: 'assistant', name: null, metadata: {} },
          content: { content_type: 'text', parts: [''] },
          status: 'in_progress',
          end_turn: null,
          weight: 1,
          metadata: { request_id: 'req-1', turn_exchange_id: 'turn-1' },
          recipient: 'all',
          channel: 'final',
        },
      },
    }),
    event({
      o: 'patch',
      v: [
        { p: '/message/content/parts/0', o: 'append', v: 'CANARY_OK' },
        { p: '/message/status', o: 'replace', v: 'finished_successfully' },
        { p: '/message/end_turn', o: 'replace', v: true },
        { p: '/message/metadata', o: 'append', v: { is_complete: true } },
      ],
    }),
    event({ p: '/message/metadata/conversation_followup_suggestions_eligible', o: 'add', v: true }),
    event({ type: 'title_generation', conversation_id: 'cid-1', title: 'Canary' }),
    event({ type: 'message_stream_complete', conversation_id: 'cid-1' }),
    'data: [DONE]\n\n',
  ].join('')
}

describe('LiveSseCanonicalAccumulator', () => {
  test('HTTP 200 的 SSE 服务端拒绝必须保留结构化错误，不能视为生成成功', () => {
    const accumulator = new LiveSseCanonicalAccumulator()
    accumulator.ingestText(event('v1'))
    accumulator.ingestText(event({
      conversation_id: 'cid-rejected',
      error_code: 'input_too_large',
      error_reason: 'last_user_message',
      error: '你提交的消息过长，请编辑后重新发送。',
    }))
    const snapshot = accumulator.snapshot()
    expect(snapshot.serverError).toEqual({
      conversationId: 'cid-rejected',
      code: 'input_too_large',
      reason: 'last_user_message',
      message: '你提交的消息过长，请编辑后重新发送。',
    })
    expect(snapshot.complete).toBe(false)
    expect(snapshot.decodeErrors).toContain('server SSE error: input_too_large')
  })

  test('重建 v1 snapshot + patch，并只在 complete + DONE 后允许 canonical promotion', () => {
    const accumulator = new LiveSseCanonicalAccumulator()
    const stream = syntheticCompleteStream()
    // 故意拆成不规则 chunk，覆盖 SSE block 横跨 dataReceived 边界的情况。
    for (let offset = 0; offset < stream.length; offset += 37) accumulator.ingestText(stream.slice(offset, offset + 37))
    accumulator.finish()

    const snapshot = accumulator.snapshot()
    expect(snapshot).toMatchObject({
      protocolVersion: 'v1',
      conversationId: 'cid-1',
      turnExchangeId: 'turn-1',
      requestId: 'req-1',
      title: 'Canary',
      currentNode: 'assistant-1',
      messageStreamComplete: true,
      doneSeen: true,
      decodeErrors: [],
      complete: true,
    })
    const assistant = snapshot.messages.find(message => message.id === 'assistant-1')
    expect(assistant?.content?.parts).toEqual(['CANARY_OK'])
    expect(assistant?.status).toBe('finished_successfully')
    expect(assistant?.end_turn).toBe(true)
    expect(assistant?.metadata).toMatchObject({ is_complete: true, conversation_followup_suggestions_eligible: true })

    expect(accumulator.canonicalPayload()).toMatchObject({
      conversation_id: 'cid-1',
      title: 'Canary',
      current_node: 'assistant-1',
    })
  })

  test('缺少 DONE 时保留已解码消息，但禁止晋升 canonical', () => {
    const accumulator = new LiveSseCanonicalAccumulator()
    accumulator.ingestText(syntheticCompleteStream().replace('data: [DONE]\n\n', ''))
    accumulator.finish()
    const snapshot = accumulator.snapshot()
    expect(snapshot.messages.some(message => message.id === 'assistant-1')).toBe(true)
    expect(snapshot.messageStreamComplete).toBe(true)
    expect(snapshot.doneSeen).toBe(false)
    expect(snapshot.complete).toBe(false)
    expect(accumulator.canonicalPayload()).toBeNull()
    expect(accumulator.evidencePayload()).toMatchObject({
      conversation_id: 'cid-1',
      title: 'Canary',
      messages: expect.arrayContaining([
        expect.objectContaining({ id: 'assistant-1' }),
      ]),
    })
    expect(accumulator.evidencePayload()).not.toHaveProperty('current_node')
  })

  test('未知 delta operation fail-closed，不把猜测结果写 canonical', () => {
    const accumulator = new LiveSseCanonicalAccumulator()
    const stream = syntheticCompleteStream().replace(
      JSON.stringify({ p: '/message/metadata/conversation_followup_suggestions_eligible', o: 'add', v: true }),
      JSON.stringify({ p: '/message/content/parts/0', o: 'mystery', v: 'X' }),
    )
    accumulator.ingestText(stream)
    accumulator.finish()
    const snapshot = accumulator.snapshot()
    expect(snapshot.decodeErrors.some(error => /unsupported SSE delta operation/u.test(error))).toBe(true)
    expect(snapshot.complete).toBe(false)
    expect(accumulator.canonicalPayload()).toBeNull()
    expect(accumulator.evidencePayload()).not.toBeNull()
  })

  test('delta 解码出错后不继续在失真的 root 上套 patch，但保留此前可信消息', () => {
    const accumulator = new LiveSseCanonicalAccumulator()
    accumulator.ingestText([
      event(JSON.stringify('v1')),
      event({
        v: {
          conversation_id: 'cid-partial',
          message: {
            id: 'assistant-partial',
            author: { role: 'assistant' },
            content: { content_type: 'text', parts: ['safe-prefix'] },
            status: 'in_progress',
            end_turn: null,
            metadata: { turn_exchange_id: 'turn-partial' },
            recipient: 'all',
          },
        },
      }),
      event({ p: '/message/content/parts/0', o: 'mystery', v: 'X' }),
      event({ p: '/message/content/parts/0', o: 'append', v: '-SHOULD-NOT-APPLY' }),
    ].join(''))
    accumulator.finish()

    const evidence = accumulator.evidencePayload() as Record<string, unknown>
    const messages = evidence.messages as Array<{ id: string; content?: { parts?: unknown[] } }>
    expect(messages.find(message => message.id === 'assistant-partial')?.content?.parts).toEqual(['safe-prefix'])
    expect(accumulator.snapshot().decodeErrors.length).toBeGreaterThanOrEqual(2)
  })

  test('base64 入口与 text 入口语义一致', () => {
    const accumulator = new LiveSseCanonicalAccumulator()
    const stream = syntheticCompleteStream()
    accumulator.ingestBase64(Buffer.from(stream).toString('base64'))
    accumulator.finish()
    expect(accumulator.snapshot().complete).toBe(true)
  })
})

