import { describe, expect, test } from 'vitest'
import { classifyCompletedRun } from '../src/browser/fleet-watch'
import type { RunDiagnostic } from '../src/core/run-diagnostics'

function diagnostic(overrides: Partial<RunDiagnostic>): RunDiagnostic {
  return {
    terminalEvidence: 'none',
    hasFinal: false,
    hasReasoningEnded: false,
    tailShape: 'other',
    assistantToolCalls: 0,
    toolResults: 0,
    nodeCount: 1,
    summary: '',
    ...overrides,
  }
}

describe('Fleet Watch COMPLETE 后验分类', () => {
  test('COMPLETE + final 是正常完成', () => {
    expect(classifyCompletedRun(diagnostic({
      terminalEvidence: 'final',
      hasFinal: true,
      tailShape: 'final',
    }))).toEqual({ state: 'complete' })
  })

  test('COMPLETE + client_stopped 是明确异常', () => {
    const result = classifyCompletedRun(diagnostic({
      terminalEvidence: 'client-stopped',
      interruptedReason: 'client_stopped',
      tailShape: 'tool-call-open',
    }))
    expect(result.state).toBe('abnormal')
    expect(result.reason).toContain('client_stopped')
  })

  test('只有在服务器 COMPLETE 前提下，open tool tail 才升级为异常', () => {
    const snapshotOnly = diagnostic({ tailShape: 'tool-call-open' })
    expect(snapshotOnly.terminalEvidence).toBe('none')
    expect(snapshotOnly.summary).not.toContain('已死')

    const completed = classifyCompletedRun(snapshotOnly)
    expect(completed.state).toBe('abnormal')
    expect(completed.reason).toContain('服务器已 COMPLETE')
  })

  test('只有在服务器 COMPLETE 前提下，open reasoning tail 才升级为异常', () => {
    const completed = classifyCompletedRun(diagnostic({ tailShape: 'reasoning-open' }))
    expect(completed.state).toBe('abnormal')
    expect(completed.reason).toContain('open reasoning')
  })

  test('COMPLETE 但尾部信息不足时保持 indeterminate', () => {
    const completed = classifyCompletedRun(diagnostic({ tailShape: 'tool-result-returned' }))
    expect(completed.state).toBe('complete-indeterminate')
  })
})
