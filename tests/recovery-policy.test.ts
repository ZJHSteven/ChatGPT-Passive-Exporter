import { describe, expect, it } from 'vitest'
import { evaluateRecoveryEligibility } from '../src/local/recovery-policy'
import type { FleetIncident } from '../src/browser/fleet-watch'
import type { RunDiagnostic } from '../src/core/run-diagnostics'

function diagnostic(overrides: Partial<RunDiagnostic> = {}): RunDiagnostic {
  return {
    terminalEvidence: 'client-stopped',
    interruptedReason: 'client_stopped',
    hasFinal: false,
    hasReasoningEnded: false,
    tailShape: 'other',
    assistantToolCalls: 0,
    toolResults: 0,
    nodeCount: 3,
    summary: '',
    ...overrides,
  }
}

function incident(overrides: Partial<FleetIncident> = {}): FleetIncident {
  return {
    id: 'incident-1',
    conversationId: 'conversation-1',
    title: 'test',
    reason: 'client_stopped',
    diagnostic: diagnostic(),
    detectedAt: 1_000_000,
    updateKey: 'u1',
    source: 'realtime',
    status: 'open',
    ...overrides,
  }
}

describe('recovery hard gate', () => {
  it('只允许 realtime open incident', () => {
    expect(evaluateRecoveryEligibility(incident({ source: 'history-audit' }), { now: 1_000_100 }).eligible).toBe(false)
    expect(evaluateRecoveryEligibility(incident({ status: 'resumed' }), { now: 1_000_100 }).eligible).toBe(false)
  })

  it('未回执 tool call 无论是否 client_stopped 都禁止自动恢复', () => {
    const result = evaluateRecoveryEligibility(incident({
      diagnostic: diagnostic({ tailShape: 'tool-call-open', assistantToolCalls: 1 }),
    }), { now: 1_000_100 })
    expect(result.eligible).toBe(false)
    expect(result.reason).toContain('副作用')
  })

  it('reasoning-open 可进入 Luna 二次审批', () => {
    expect(evaluateRecoveryEligibility(incident({
      diagnostic: diagnostic({ terminalEvidence: 'none', tailShape: 'reasoning-open' }),
    }), { now: 1_000_100 }).eligible).toBe(true)
  })

  it('明确中断且没有 open tool tail 可进入 Luna 审批', () => {
    expect(evaluateRecoveryEligibility(incident(), { now: 1_000_100 }).eligible).toBe(true)
  })

  it('超过时间窗口的旧事故禁止自动恢复', () => {
    expect(evaluateRecoveryEligibility(incident(), { now: 10_000_000, maxAgeMs: 60_000 }).eligible).toBe(false)
  })
})
