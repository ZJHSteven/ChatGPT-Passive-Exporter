import { describe, expect, test } from 'vitest'
import { LiveTurnTransportTracker } from '../src/local/live-turn-transport.ts'

describe('LiveTurn transport control-plane recorder', () => {
  test('记录可持久化 resume token、安全审核、handoff 与完成信号', () => {
    const events: any[] = []
    const tracker = new LiveTurnTransportTracker({
      cdpRequestId: '1.2', transport: 'conversation', requestStartedAt: 1000, emit: event => events.push(event),
    })
    tracker.ingestText(': ping - 2026-09-27T00:00:00Z\n\n', 1100)
    tracker.ingestText('data: {"type":"resume_conversation_token","conversation_id":"c1","turn_exchange_id":"t1","token":"super-secret-token"}\n\n', 1200)
    tracker.ingestText('data: {"type":"safety_review_update","conversation_id":"c1","active":true,"protection_type":"cyber","message":"do not persist me"}\n\n', 1300)
    tracker.ingestText('data: {"type":"stream_handoff","conversation_id":"c1","turn_exchange_id":"t1","options":[{"type":"resume_sse_endpoint","topic_id":"conversation-turn-t1"}]}\n\n', 1400)
    tracker.ingestText('data: {"type":"message_stream_complete","conversation_id":"c1"}\n\n', 1500)
    tracker.ingestText('data: [DONE]\n\n', 1600)
    tracker.finish(1700)

    expect(events.map(event => event.event)).toEqual([
      'stream-bound', 'resume-token', 'safety-review', 'stream-handoff', 'message-stream-complete', 'done', 'stream-finished',
    ])
    const resume = events.find(event => event.event === 'resume-token')
    expect(resume).toMatchObject({
      conversationId: 'c1', turnExchangeId: 't1', resumeTokenSeen: true,
      resumeToken: 'super-secret-token', resumeOffset: null, resumeTokenLength: 18, pingCount: 1,
    })
    expect(resume.resumeTokenSha256).toMatch(/^[0-9a-f]{64}$/u)
    expect(JSON.stringify(events)).not.toContain('do not persist me')
    expect(events.find(event => event.event === 'safety-review')).toMatchObject({
      safetyReviewActive: true, protectionType: 'cyber',
    })
    expect(events.find(event => event.event === 'stream-handoff')).toMatchObject({
      handoffTopics: ['conversation-turn-t1'],
    })
  })

  test('支持 CDP binary/base64 chunk，并对重复 review/token 去重', () => {
    const events: any[] = []
    const tracker = new LiveTurnTransportTracker({
      cdpRequestId: '2.3', transport: 'resume', requestStartedAt: 2000, emit: event => events.push(event),
    })
    const text = [
      'data: {"type":"resume_conversation_token","conversation_id":"c2","token":"same"}\n\n',
      'data: {"type":"resume_conversation_token","conversation_id":"c2","token":"same"}\n\n',
      'data: {"type":"safety_review_update","conversation_id":"c2","active":true}\n\n',
      'data: {"type":"safety_review_update","conversation_id":"c2","active":true}\n\n',
      'data: {"type":"safety_review_update","conversation_id":"c2","active":false}\n\n',
    ].join('')
    tracker.ingestBase64(Buffer.from(text).toString('base64'), 2100)
    expect(events.filter(event => event.event === 'resume-token')).toHaveLength(1)
    expect(events.filter(event => event.event === 'safety-review').map(event => event.safetyReviewActive)).toEqual([true, false])
  })

  test('已经看到 DONE 后的 Chrome loadingFailed 视为正常流收口', () => {
    const events: any[] = []
    const tracker = new LiveTurnTransportTracker({
      cdpRequestId: '3.4', transport: 'conversation', requestStartedAt: 3000, emit: event => events.push(event),
    })
    tracker.ingestText('data: {"conversation_id":"c3"}\n\ndata: [DONE]\n\n', 3100)
    tracker.fail('net::ERR_ABORTED', 3200)
    expect(events.map(event => event.event)).toEqual(['stream-bound', 'done', 'stream-finished'])
    expect(events.some(event => event.event === 'stream-failed')).toBe(false)
  })
})
