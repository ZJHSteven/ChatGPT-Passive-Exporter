import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  buildProtocolRequestShape,
  buildProtocolResponseShape,
  classifyProtocolReplayCandidate,
  ProtocolDriftLedger,
} from '../src/local/protocol-drift.ts'

describe('protocol drift fingerprinting', () => {
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
})
