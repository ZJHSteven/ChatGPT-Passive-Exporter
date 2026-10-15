import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  buildGlobalCatalogPath,
  captureGlobalCatalogQueryTemplate,
} from '../src/core/first-party-request-context.ts'
import {
  buildProtocolRequestShape,
  buildProtocolResponseShape,
  classifyProtocolReplayCandidate,
  isArchiveProtocolRoute,
  protocolContractFamily,
  ProtocolDriftLedger,
} from '../src/local/protocol-drift.ts'

describe('protocol drift fingerprinting', () => {
  test('global catalog 只自动继承已确认可重放的 query，未知 proof/nonce 不盲拷', () => {
    const template = captureGlobalCatalogQueryTemplate(
      'https://chatgpt.com/backend-api/conversations?offset=0&limit=28&order=updated&expand=false&hide_snorlax=false&pow=one-shot&nonce=abc',
    )
    expect(template).toEqual([
      ['order', 'updated'],
      ['expand', 'false'],
      ['hide_snorlax', 'false'],
    ])
    expect(buildGlobalCatalogPath(28, 28, template)).toBe(
      '/backend-api/conversations?offset=28&limit=28&order=updated&expand=false&hide_snorlax=false',
    )
  })

  test('conversation ids/cursors/signatures are normalized but semantic query values are preserved', () => {
    const shape = buildProtocolRequestShape({
      url: 'https://chatgpt.com/backend-api/conversations/6ab7cabd-dd70-83e9-bc4e-d3d6cbf55b00/messages?before=abc123&num_turns=10&include_has_versions=true',
      method: 'GET',
      headers: { Authorization: 'secret', 'X-OpenAI-Target-Path': '/x' },
    })
    expect(shape).toMatchObject({
      route: '/backend-api/conversations/{conversation_id}/messages',
      method: 'GET',
      query: {
        before: '<cursor>',
        include_has_versions: 'true',
        num_turns: '10',
      },
    })
    expect(shape?.headerNames).toContain('authorization')
    expect(shape?.protocolHeaderNames).toContain('authorization')
    expect(shape?.protocolHeaderNames).toContain('x-openai-target-path')
  })

 test('browser transport headers are recorded but do not split the protocol signature', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'protocol-header-'))
    const file = path.join(dir, 'ledger.json')
    const ledger = await ProtocolDriftLedger.open(file, { now: 1000, baselineWindowMs: 60_000 })
    const first = ledger.observeRequest({
      url: 'https://chatgpt.com/backend-api/conversations?limit=20&order=updated&offset=0',
      method: 'GET',
      headers: { Authorization: 'a', Priority: 'u=1', 'Sec-CH-UA': 'old' },
      observedAt: 2000,
    })!
    const second = ledger.observeRequest({
      url: 'https://chatgpt.com/backend-api/conversations?limit=20&order=updated&offset=0',
      method: 'GET',
      headers: { Authorization: 'b', Priority: 'u=0', 'Sec-CH-UA': 'new' },
      observedAt: 3000,
    })!
    expect(first.signature).toBe(second.signature)
    expect(Object.keys(ledger.state.variants)).toHaveLength(1)
 })

  test('daemon drift scope excludes unrelated account/settings APIs and normalizes gizmo ids', () => {
    expect(isArchiveProtocolRoute('/backend-api/settings/user')).toBe(false)
    expect(isArchiveProtocolRoute('/backend-api/conversations')).toBe(true)
    expect(isArchiveProtocolRoute('/backend-api/gizmos/{gizmo_id}/conversations')).toBe(true)
    expect(buildProtocolRequestShape({
      url: 'https://chatgpt.com/backend-api/gizmos/g-p-123/conversations?limit=5',
    })?.route).toBe('/backend-api/gizmos/{gizmo_id}/conversations')
  })

  test('filtered TPP catalog is not a global replay candidate', () => {
    const filtered = buildProtocolRequestShape({
      url: 'https://chatgpt.com/backend-api/conversations?conversation_origin=tpp&limit=20&order=updated&offset=0',
      method: 'GET',
    })!
    const global = buildProtocolRequestShape({
      url: 'https://chatgpt.com/backend-api/conversations?expand=false&hide_snorlax=false&is_archived=false&is_starred=false&limit=20&order=updated&offset=0',
      method: 'GET',
    })!
    const response = buildProtocolResponseShape({
      status: 200,
      contentType: 'application/json',
      body: { items: [], total: 0, limit: 20, offset: 0 },
    })
    expect(classifyProtocolReplayCandidate(filtered, response).eligible).toBe(false)
    expect(classifyProtocolReplayCandidate(global, response)).toMatchObject({
      eligible: true,
      family: 'catalog-global',
    })
    expect(protocolContractFamily(filtered)).toBe('catalog-tpp')
    expect(protocolContractFamily(global)).toBe('catalog-global')
  })

  test('global catalog 不再拿 TPP sidebar baseline 做 query 漂移比较', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'protocol-catalog-family-'))
    const ledger = await ProtocolDriftLedger.open(path.join(dir, 'ledger.json'), {
      now: 1_000,
      baselineWindowMs: 60_000,
    })
    ledger.observeRequest({
      url: 'https://chatgpt.com/backend-api/conversations?conversation_origin=tpp&expand=false&hide_snorlax=false&is_archived=false&is_starred=false&limit=20&order=updated&offset=0',
      method: 'GET',
      observedAt: 2_000,
    })
    ledger.refreshBaselineLock(70_000)
    const global = ledger.observeRequest({
      url: 'https://chatgpt.com/backend-api/conversations?offset=0&limit=28&order=updated&is_archived=false&is_starred=false',
      method: 'GET',
      observedAt: 71_000,
    })!
    expect(global.assessment).toMatchObject({
      severity: 'info',
      notify: false,
      category: 'observation',
      family: 'catalog-global',
    })
    expect(global.assessment?.details).toContain('baseline 中没有同家族请求')
  })

  test('learning window seeds baseline; later unseen request/response shapes become pending drift', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'protocol-ledger-'))
    const file = path.join(dir, 'ledger.json')
    const ledger = await ProtocolDriftLedger.open(file, { now: 1000, baselineWindowMs: 60_000 })
    const initial = ledger.observeRequest({
      url: 'https://chatgpt.com/backend-api/conversations?limit=20&order=updated&offset=0',
      method: 'GET',
      observedAt: 2000,
      sourceKind: 'guardian',
    })!
    expect(initial.baseline).toBe(true)
    expect(ledger.observeResponse(initial.signature, {
      status: 200,
      body: { items: [], total: 0, limit: 20, offset: 0 },
      observedAt: 3000,
    })?.pending).toBe(false)

    ledger.refreshBaselineLock(70_000)
    const drift = ledger.observeRequest({
      url: 'https://chatgpt.com/backend-api/conversations?limit=20&order=updated&offset=0&new_flag=1',
      method: 'GET',
      observedAt: 71_000,
      sourceKind: 'guardian',
    })!
    expect(drift.pending).toBe(true)
    expect(ledger.pendingChanges()).toHaveLength(1)
  })

  test('message metadata 多态只记 info，不再制造协议 Bark', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'protocol-metadata-noise-'))
    const ledger = await ProtocolDriftLedger.open(path.join(dir, 'ledger.json'), {
      now: 1_000,
      baselineWindowMs: 60_000,
    })
    const request = ledger.observeRequest({
      url: 'https://chatgpt.com/backend-api/conversations/example?include_has_versions=true&num_turns=10',
      method: 'GET',
      headers: { Authorization: 'a', 'OAI-DID': 'device' },
      observedAt: 2_000,
    })!
    ledger.observeResponse(request.signature, {
      status: 200,
      contentType: 'application/json',
      body: {
        messages: [{ id: 'm1', author: {}, content: {}, metadata: { model_slug: 'x' } }],
        page_info: { has_next_page: false, has_previous_page: false, start_cursor: null, end_cursor: null },
      },
      observedAt: 3_000,
    })
    ledger.refreshBaselineLock(70_000)

    const drift = ledger.observeResponse(request.signature, {
      status: 200,
      contentType: 'application/json',
      body: {
        messages: [{
          id: 'm2',
          author: {},
          content: {},
          metadata: { model_slug: 'x', dictation: true, attachments: [], writing_blocks: [] },
        }],
        page_info: { has_next_page: false, has_previous_page: false, start_cursor: null, end_cursor: null },
      },
      observedAt: 71_000,
    })!
    expect(drift.pending).toBe(true) // exact forensic shape 仍完整保留。
    expect(drift.assessment).toMatchObject({
      severity: 'info',
      notify: false,
      category: 'optional-shape',
    })
    expect(drift.assessment?.details.join(' ')).toContain('message metadata')
  })

  test('真正未覆盖的新协议 header 重复出现时升级 warning', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'protocol-header-drift-'))
    const ledger = await ProtocolDriftLedger.open(path.join(dir, 'ledger.json'), {
      now: 1_000,
      baselineWindowMs: 60_000,
    })
    ledger.observeRequest({
      url: 'https://chatgpt.com/backend-api/conversation/example',
      method: 'GET',
      headers: { Authorization: 'a', 'OAI-DID': 'device' },
      observedAt: 2_000,
    })
    ledger.refreshBaselineLock(70_000)

    const first = ledger.observeRequest({
      url: 'https://chatgpt.com/backend-api/conversation/example',
      method: 'GET',
      headers: { Authorization: 'a', 'OAI-DID': 'device', 'X-OAI-New-Context': 'v1' },
      observedAt: 71_000,
    })!
    expect(first.assessment).toMatchObject({ severity: 'info', notify: false })

    const second = ledger.observeRequest({
      url: 'https://chatgpt.com/backend-api/conversation/example',
      method: 'GET',
      headers: { Authorization: 'a', 'OAI-DID': 'device', 'X-OAI-New-Context': 'v1' },
      observedAt: 72_000,
    })!
    expect(second.assessment).toMatchObject({
      severity: 'warning',
      notify: true,
      category: 'request-contract',
    })
    expect(second.assessment?.details).toContain('新增协议 header: x-oai-new-context')
  })

  test('白名单已动态继承的新增 header 与 session trace 不再误报人工改协议', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'protocol-auto-inherited-header-'))
    const ledger = await ProtocolDriftLedger.open(path.join(dir, 'ledger.json'), {
      now: 1_000,
      baselineWindowMs: 60_000,
    })
    ledger.observeRequest({
      url: 'https://chatgpt.com/backend-api/conversation/example',
      method: 'GET',
      headers: { Authorization: 'a', 'OAI-DID': 'device' },
      observedAt: 2_000,
    })
    ledger.refreshBaselineLock(70_000)
    const current = ledger.observeRequest({
      url: 'https://chatgpt.com/backend-api/conversation/example',
      method: 'GET',
      headers: {
        Authorization: 'a',
        'OAI-DID': 'device',
        'X-OAI-MCP-Form-Version': '2',
        'X-OAI-Turn-Trace-ID': 'session-uuid',
      },
      observedAt: 71_000,
    })!
    expect(current.assessment).toMatchObject({
      severity: 'info',
      notify: false,
      category: 'optional-shape',
    })
  })

  test('Turn Submit body 漂移由官方页面原生提交自动继承，只保留取证', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'protocol-native-turn-submit-'))
    const ledger = await ProtocolDriftLedger.open(path.join(dir, 'ledger.json'), {
      now: 1_000,
      baselineWindowMs: 60_000,
    })
    ledger.observeRequest({
      url: 'https://chatgpt.com/backend-api/f/conversation',
      method: 'POST',
      headers: { Authorization: 'a', 'Content-Type': 'application/json' },
      postData: JSON.stringify({ action: 'next', messages: [] }),
      observedAt: 2_000,
    })
    ledger.refreshBaselineLock(70_000)
    const current = ledger.observeRequest({
      url: 'https://chatgpt.com/backend-api/f/conversation',
      method: 'POST',
      headers: { Authorization: 'a', 'Content-Type': 'application/json' },
      postData: JSON.stringify({ action: 'next', messages: [], genui_state_snapshots: [] }),
      observedAt: 71_000,
    })!
    expect(current.assessment).toMatchObject({
      severity: 'info',
      notify: false,
      category: 'observation',
      family: 'turn-submit',
    })
    expect(current.assessment?.summary).toContain('Actor 自动继承')
  })

  test('Conversation Body 核心 messages 消失第一次就判 critical', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'protocol-breaking-response-'))
    const ledger = await ProtocolDriftLedger.open(path.join(dir, 'ledger.json'), {
      now: 1_000,
      baselineWindowMs: 60_000,
    })
    const request = ledger.observeRequest({
      url: 'https://chatgpt.com/backend-api/conversations/example?include_has_versions=true&num_turns=10',
      method: 'GET',
      observedAt: 2_000,
    })!
    ledger.observeResponse(request.signature, {
      status: 200,
      contentType: 'application/json',
      body: {
        messages: [{ id: 'm1', author: {}, content: {}, metadata: {} }],
        page_info: { has_next_page: false, has_previous_page: false, start_cursor: null, end_cursor: null },
      },
      observedAt: 3_000,
    })
    ledger.refreshBaselineLock(70_000)

    const broken = ledger.observeResponse(request.signature, {
      status: 200,
      contentType: 'application/json',
      body: {
        page_info: { has_next_page: false, has_previous_page: false, start_cursor: null, end_cursor: null },
      },
      observedAt: 71_000,
    })!
    expect(broken.assessment).toMatchObject({
      severity: 'critical',
      notify: true,
      category: 'response-contract',
    })
    expect(broken.assessment?.details.join(' ')).toContain('messages')
  })

  test('生产 header 覆盖检查不依赖 baseline，可发现安装监控前已经存在的协议字段', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'protocol-production-coverage-'))
    const ledger = await ProtocolDriftLedger.open(path.join(dir, 'ledger.json'), {
      now: 1_000,
      baselineWindowMs: 60_000,
    })
    const first = ledger.observeRequest({
      url: 'https://chatgpt.com/backend-api/conversations/example?include_has_versions=true&num_turns=10',
      method: 'GET',
      headers: { Authorization: 'a', 'X-OAI-New-Context': 'v1' },
      observedAt: 2_000,
    })!
    ledger.observeRequest({
      url: 'https://chatgpt.com/backend-api/conversations/example?include_has_versions=true&num_turns=10',
      method: 'GET',
      headers: { Authorization: 'a', 'X-OAI-New-Context': 'v1' },
      observedAt: 3_000,
    })
    expect(first.baseline).toBe(true)

    const coverage = ledger.assessProductionHeaderCoverage(first.signature, ['authorization'])
    expect(coverage).toMatchObject({
      severity: 'warning',
      notify: true,
      category: 'request-contract',
    })
    expect(coverage?.details).toContain('未覆盖 header: x-oai-new-context')
  })
})
