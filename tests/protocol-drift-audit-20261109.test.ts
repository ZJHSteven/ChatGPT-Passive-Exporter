/**
 * 2026-11-09 全量协议漂移复核回归。
 *
 * 这里验证的不是“哈希有没有变化”，而是变更是否足以破坏 Archive 的主动回放。
 * 所有测试都使用虚构的会话 ID / Header 值，不接触生产账号和外部网络。
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  FIRST_PARTY_REPLAY_HEADER_ALLOWLIST,
  sanitizeFirstPartyReplayHeaders,
} from '../src/core/first-party-request-context.ts'
import { ProtocolDriftLedger } from '../src/local/protocol-drift.ts'

async function createLedger(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  return ProtocolDriftLedger.open(path.join(dir, 'ledger.json'), {
    now: 1_000,
    baselineWindowMs: 60_000,
  })
}

describe('2026-11-09 已核对的协议变化', () => {
  test('rejoin-pro-cta 继承第一方当前值，不硬编码为 1 或跨会话复用旧常量', async () => {
    const ledger = await createLedger('rejoin-header-')
    const url = 'https://chatgpt.com/backend-api/conversations/example?include_has_versions=true&num_turns=10'
    ledger.observeRequest({ url, headers: { Authorization: 'token' }, observedAt: 2_000 })
    ledger.refreshBaselineLock(70_000)
    const observed = ledger.observeRequest({
      url,
      headers: { Authorization: 'token', 'X-OpenAI-Rejoin-Pro-CTA': '1' },
      observedAt: 71_000,
    })!
    expect(observed.assessment).toMatchObject({ severity: 'info', notify: false })
    expect(ledger.assessProductionHeaderCoverage(observed.signature, FIRST_PARTY_REPLAY_HEADER_ALLOWLIST))
      .toBeNull()

    // sanitize 只接收“已经观测到”的 header：0 被原样继承，缺失则不凭空补一个 1。
    expect(sanitizeFirstPartyReplayHeaders({ 'x-openai-rejoin-pro-cta': '1' }))
      .toEqual({ 'x-openai-rejoin-pro-cta': '1' })
    expect(sanitizeFirstPartyReplayHeaders({ 'X-OpenAI-Rejoin-Pro-CTA': '0' }))
      .toEqual({ 'x-openai-rejoin-pro-cta': '0' })
    expect(sanitizeFirstPartyReplayHeaders({ Authorization: 'only' }))
      .not.toHaveProperty('x-openai-rejoin-pro-cta')
  })

  test('已识别的 Project cursor 和 Body num_turns=1000 是分页参数，不是协议损坏', async () => {
    const ledger = await createLedger('pagination-noise-')
    ledger.observeRequest({
      url: 'https://chatgpt.com/backend-api/gizmos/g-p-one/conversations?limit=5&owned_only=false',
      observedAt: 2_000,
    })
    ledger.observeRequest({
      url: 'https://chatgpt.com/backend-api/conversations/example?include_has_versions=true&num_turns=10',
      observedAt: 3_000,
    })
    ledger.refreshBaselineLock(70_000)
    const cursor = ledger.observeRequest({
      url: 'https://chatgpt.com/backend-api/gizmos/g-p-one/conversations?cursor=opaque&limit=5&owned_only=false',
      observedAt: 71_000,
    })!
    const largerPage = ledger.observeRequest({
      url: 'https://chatgpt.com/backend-api/conversations/example?include_has_versions=true&num_turns=1000',
      observedAt: 72_000,
    })!
    expect(cursor.assessment).toMatchObject({ severity: 'info', notify: false })
    expect(largerPage.assessment).toMatchObject({ severity: 'info', notify: false })
    // Exact ledger 保留两个差异，未来仍可做历史取证。
    expect(ledger.pendingChanges().filter(change => change.kind === 'request')).toHaveLength(2)
  })

  test('Project 空列表和历史未采集的嵌套键名不能触发 Critical，真实缺 ID 仍须报警', async () => {
    const ledger = await createLedger('project-legacy-')
    const request = ledger.observeRequest({
      url: 'https://chatgpt.com/backend-api/gizmos/snorlax/sidebar?conversations_per_gizmo=5&limit=20&owned_only=false',
      observedAt: 2_000,
    })!
    ledger.observeResponse(request.signature, {
      status: 200,
      contentType: 'application/json',
      body: {
        cursor: null,
        items: [{
          gizmo: { gizmo: { id: 'g-p-one' } },
          conversations: { items: [{ id: 'cid-1', update_time: '2026-10-18' }] },
        }],
      },
      observedAt: 3_000,
    })
    ledger.refreshBaselineLock(70_000)
    const empty = ledger.observeResponse(request.signature, {
      status: 200,
      contentType: 'application/json',
      body: { cursor: null, items: [] },
      observedAt: 71_000,
    })!
    expect(empty.assessment).toMatchObject({ severity: 'info', notify: false })

    const broken = ledger.observeResponse(request.signature, {
      status: 200,
      contentType: 'application/json',
      body: {
        cursor: null,
        items: [{
          gizmo: { gizmo: { display: { name: 'Without ID' } } },
          conversations: { items: [{ title: 'Without CID' }] },
        }],
      },
      observedAt: 72_000,
    })!
    expect(broken.assessment).toMatchObject({ severity: 'critical', notify: true })

    // 旧协议账本当时尚未提取这两个字段数组；模拟其 undefined 状态。
    const legacyShape = ledger.state.variants[request.signature]!.responses[broken.signature]!.shape
    delete legacyShape.projectGizmoKeys
    delete legacyShape.projectConversationKeys
    expect(ledger.assessResponseVariant(request.signature, broken.signature))
      .toMatchObject({ severity: 'info', notify: false })
  })
})
