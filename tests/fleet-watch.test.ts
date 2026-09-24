import { describe, expect, test } from 'vitest'
import { classifyCompletedRun, classifyServerEvidence } from '../src/browser/fleet-watch'
import type { ServerStatusResult } from '../src/browser/run-watch'
import type { RunDiagnostic } from '../src/core/run-diagnostics'

function diagnostic(overrides: Partial<RunDiagnostic>): RunDiagnostic {
  return {
    terminalEvidence: 'none',
    hasFinal: false,
    hasImageGenerationFinal: false,
    imageGenerationCount: 0,
    hasReasoningEnded: false,
    tailShape: 'other',
    headState: 'unknown',
    offHeadSameTurnMessageCount: 0,
    offHeadSameTurnMessageIds: [],
    assistantToolCalls: 0,
    toolResults: 0,
    nodeCount: 1,
    summary: '',
    ...overrides,
  }
}

function server(status?: string, ok = true): ServerStatusResult {
  return { ok, status, checkedAt: Date.now(), httpStatus: ok ? 200 : 503 }
}

describe('Fleet Watch 服务端双信号', () => {
  test('async_status=3/5 + IS_STREAMING 是已确认 streaming', () => {
    expect(classifyServerEvidence(3, server('IS_STREAMING'))).toBe('confirmed-streaming')
    expect(classifyServerEvidence(5, server('IS_STREAMING'))).toBe('confirmed-streaming')
    expect(classifyServerEvidence(null, server('IS_STREAMING'))).toBe('conflict')
    expect(classifyServerEvidence(4, server('IS_STREAMING'))).toBe('conflict')
  })

  test('async_status=4/null + COMPLETE 是已确认 complete', () => {
    expect(classifyServerEvidence(null, server('COMPLETE'))).toBe('confirmed-complete')
    expect(classifyServerEvidence(4, server('COMPLETE'))).toBe('confirmed-complete')
    expect(classifyServerEvidence(3, server('COMPLETE'))).toBe('conflict')
    expect(classifyServerEvidence(5, server('COMPLETE'))).toBe('conflict')
  })

  test('网络错误、缺字段和未知枚举都保持 unknown', () => {
    expect(classifyServerEvidence(3, server(undefined, false))).toBe('unknown')
    expect(classifyServerEvidence(undefined, server('COMPLETE'))).toBe('conflict')
    expect(classifyServerEvidence(5, server('SOMETHING_NEW'))).toBe('unknown')
  })
})

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
