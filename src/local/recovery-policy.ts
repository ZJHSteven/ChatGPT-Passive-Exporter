import type { FleetIncident } from '../browser/fleet-watch.ts'

/**
 * 无人值守恢复的“硬安全门”。
 *
 * Luna 只负责语义判断，但模型输出不能成为唯一安全边界。这个模块只看已经持久化、
 * 可机械验证的事故元数据；任何不满足条件的 incident，即使 Luna 误给 approve=true，
 * 也不能自动向 ChatGPT 发送“继续”。
 */
export interface RecoveryEligibility {
  eligible: boolean
  reason: string
}

export interface RecoveryPolicyOptions {
  now?: number
  /** 太旧的事故不应在 daemon 重启后突然自动续跑。默认 2 小时。 */
  maxAgeMs?: number
}

export function evaluateRecoveryEligibility(
  incident: FleetIncident,
  options: RecoveryPolicyOptions = {},
): RecoveryEligibility {
  const currentTime = options.now ?? Date.now()
  const maxAgeMs = options.maxAgeMs ?? 2 * 60 * 60_000

  if (incident.source !== 'realtime') {
    return { eligible: false, reason: `事故来源为 ${incident.source}，历史补扫/迁移记录只允许取证。` }
  }

  if (incident.status !== 'open') {
    return { eligible: false, reason: `事故当前状态为 ${incident.status}，不是待恢复的 open incident。` }
  }

  if (!Number.isFinite(incident.detectedAt) || currentTime - incident.detectedAt > maxAgeMs) {
    return { eligible: false, reason: '事故超过自动恢复时间窗口，避免 daemon 重启后续跑陈旧任务。' }
  }

  const diagnostic = incident.diagnostic
  if (!diagnostic) {
    return { eligible: false, reason: '事故缺少 RunDiagnostic，无法判断最后一轮停在哪里。' }
  }

  // 最危险的情况：工具已经被 dispatch，但 ChatGPT 没收到/没持久化 result。
  // 我们已经真实遇到过 adb install 实际成功、tool result 却丢失的事故。
  // 在不知道工具副作用真实状态前，绝不能无人值守重放。
  if (diagnostic.tailShape === 'tool-call-open') {
    return {
      eligible: false,
      reason: '最后停在未回执 tool call；工具可能已经产生副作用，必须先核验真实状态。',
    }
  }

  // reasoning-open 是服务器已 COMPLETE 后才会被 classifyCompletedRun 升级成事故，
  // 此时没有“上一工具可能已执行但回执丢失”的重复副作用风险。
  if (diagnostic.tailShape === 'reasoning-open') {
    return { eligible: true, reason: '服务器已终止且仅 reasoning 尾部未收口，可交给 Luna 再做语义审批。' }
  }

  if (diagnostic.terminalEvidence === 'client-stopped' || diagnostic.terminalEvidence === 'interrupted') {
    return { eligible: true, reason: 'payload 有明确中断证据，且尾部不是未回执 tool call。' }
  }

  return {
    eligible: false,
    reason: `事故缺少允许自动恢复的明确形态：terminal=${diagnostic.terminalEvidence}, tail=${diagnostic.tailShape}。`,
  }
}

