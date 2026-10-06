import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  ActorDomDriftLedger,
  actorDomSignature,
  buildActorDomShape,
  type ActorDomObservation,
} from '../src/local/dom-drift.ts'

function observation(overrides: Partial<ActorDomObservation> = {}): ActorDomObservation {
  return {
    routeKind: 'conversation',
    composer: {
      tag: 'div',
      id: 'prompt-textarea',
      role: 'textbox',
      contentEditable: 'true',
      formMarker: true,
    },
    newChat: {
      tag: 'a',
      testId: 'create-new-chat-button',
    },
    sidebar: {
      canonicalConversationLink: true,
      projectLink: true,
      accountButton: true,
    },
    controls: [
      {
        semantic: 'attachment',
        tag: 'button',
        type: 'button',
        testId: 'composer-plus-btn',
        ariaPresent: true,
        titlePresent: false,
      },
      {
        semantic: 'send',
        tag: 'button',
        type: 'submit',
        testId: 'send-button',
        ariaPresent: true,
        titlePresent: false,
      },
    ],
    ...overrides,
  }
}

describe('Actor DOM drift fingerprinting', () => {
  test('DOM 控件顺序不影响 signature，且 shape 不保存 aria/title 正文', () => {
    const first = buildActorDomShape(observation())
    const second = buildActorDomShape(observation({ controls: [...observation().controls].reverse() }))
    expect(actorDomSignature(first)).toBe(actorDomSignature(second))
    expect(JSON.stringify(first)).not.toContain('发送')
    expect(JSON.stringify(first)).not.toContain('Send')
    expect(first.controls.every(control => typeof control.ariaPresent === 'boolean')).toBe(true)
  })

  test('学习窗口内新结构进入 baseline；锁定后未见结构变成 pending', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'actor-dom-drift-'))
    const file = path.join(dir, 'ledger.json')
    const ledger = await ActorDomDriftLedger.open(file, { now: 1_000, baselineWindowMs: 60_000 })

    const initial = ledger.observe(observation(), 2_000)
    expect(initial.baseline).toBe(true)
    expect(initial.pending).toBe(false)
    ledger.lockBaseline(3_000)

    const drift = ledger.observe(observation({
      composer: {
        tag: 'div',
        id: 'new-prompt-root',
        role: 'textbox',
        contentEditable: 'true',
        formMarker: true,
      },
    }), 4_000)
    expect(drift.baseline).toBe(false)
    expect(drift.pending).toBe(true)
    expect(ledger.pendingChanges({ unreportedOnly: false })).toHaveLength(1)
  })

  test('人工 approve 后 pending 结构提升为可信基线并可持久化', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'actor-dom-approve-'))
    const file = path.join(dir, 'ledger.json')
    const ledger = await ActorDomDriftLedger.open(file, { now: 1_000, baselineWindowMs: 60_000 })
    ledger.observe(observation(), 2_000)
    ledger.lockBaseline(3_000)

    const drift = ledger.observe(observation({
      newChat: { tag: 'button', testId: 'create-new-chat-v2' },
    }), 4_000)
    expect(ledger.approve(drift.signature, 5_000)).toBe(true)
    expect(ledger.pendingChanges({ unreportedOnly: false })).toEqual([])
    await ledger.flush()

    const reopened = await ActorDomDriftLedger.open(file, { now: 6_000, baselineWindowMs: 60_000 })
    expect(reopened.summary().baselineMode).toBe('locked')
    expect(reopened.summary().baselineVariants).toBe(2)
  })
})
