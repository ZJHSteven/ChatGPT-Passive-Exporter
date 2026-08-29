import { diagnoseLatestRun, type RunDiagnostic } from '../core/run-diagnostics'
import type { RunWatchController, ServerStatusResult } from './run-watch'

/**
 * Fleet Watch：用“一张轻量 ChatGPT 页面”监控多条 conversation 的服务器状态。
 *
 * 它解决的是手机端/多会话场景：用户可以在 iPhone 上同时启动多条长任务，桌面端
 * 不需要为每条 conversation 打开一个巨型标签页。只要保留一张轻量 ChatGPT 首页，
 * Fleet Watch 就低频读取最近更新列表，并只对“最近有变化 / 已经确认在运行”的少量
 * conversation 查询 stream_status。
 *
 * 关键安全/准确性原则：
 * - 静默时长、Stop 按钮、tool call 无 result、reasoning open 都不能单独判死；
 * - `stream_status` 非 COMPLETE 时只记原始状态，不猜具体语义；
 * - 只有服务器明确 COMPLETE 后，才读取最后 2 turns 做后验归因；
 * - COMPLETE + final = 正常完成；
 * - COMPLETE + client_stopped/interrupted = 明确异常终止；
 * - COMPLETE + tool-call-open/reasoning-open = “服务器已结束但 payload 收尾不完整”，
 *   这时才可把快照尾部形态升级成异常证据。
 */

export type FleetConversationState =
  | 'tracking'
  | 'server-active'
  | 'complete'
  | 'abnormal'
  | 'complete-indeterminate'
  | 'status-error'

export interface FleetConversationEntry {
  id: string
  title: string
  updateTime?: string | number
  updateEpoch?: number
  state: FleetConversationState
  rawServerStatus?: string
  lastStatusAt?: number
  lastChangedAt: number
  diagnostic?: RunDiagnostic
  abnormalReason?: string
}

export interface FleetAlert {
  kind: 'abnormal'
  conversationId: string
  title: string
  reason: string
  diagnostic?: RunDiagnostic
  at: number
}

export interface FleetWatchSnapshot {
  protocol: 'chatgpt-passive-exporter/fleet-watch/v1'
  startedAt: number
  lastPollAt?: number
  authReady: boolean
  polling: boolean
  recentListCount: number
  tracked: FleetConversationEntry[]
  alerts: FleetAlert[]
  lastError?: string
}

export interface FleetWatchOptions {
  pollIntervalMs?: number
  recentLimit?: number
  recentWindowMs?: number
  maxStatusChecksPerPoll?: number
  maxAlerts?: number
  onUpdate?: (snapshot: FleetWatchSnapshot) => void
  onAlert?: (alert: FleetAlert) => void
}

export interface FleetWatchController {
  pollNow: () => Promise<FleetWatchSnapshot>
  snapshot: () => FleetWatchSnapshot
  summaryText: () => string
  dispose: () => void
}

function now(): number {
  return Date.now()
}

function timeToEpoch(value: string | number | undefined): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 10_000_000_000 ? value * 1000 : value
  }
  if (typeof value === 'string' && value) {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/**
 * 只有 server COMPLETE 才调用这个函数。
 * 这正是“tool-call-open/reasoning-open 为什么此时才有意义”的证据边界。
 */
export function classifyCompletedRun(diagnostic: RunDiagnostic): {
  state: 'complete' | 'abnormal' | 'complete-indeterminate'
  reason?: string
} {
  if (diagnostic.terminalEvidence === 'final') return { state: 'complete' }

  if (diagnostic.terminalEvidence === 'client-stopped') {
    return { state: 'abnormal', reason: '服务器已结束，payload 明确记录 client_stopped。' }
  }
  if (diagnostic.terminalEvidence === 'interrupted') {
    return {
      state: 'abnormal',
      reason: diagnostic.interruptedReason
        ? `服务器已结束，payload 明确记录 interrupted：${diagnostic.interruptedReason}。`
        : '服务器已结束，payload 明确记录 interrupted。',
    }
  }

  if (diagnostic.tailShape === 'tool-call-open') {
    return {
      state: 'abnormal',
      reason: '服务器已 COMPLETE，但最后持久化节点仍停在 tool call 且没有后续 tool result。',
    }
  }
  if (diagnostic.tailShape === 'reasoning-open') {
    return {
      state: 'abnormal',
      reason: '服务器已 COMPLETE，但最后 payload 仍停在 open reasoning 且没有 final/reasoning_ended。',
    }
  }

  return {
    state: 'complete-indeterminate',
    reason: '服务器已 COMPLETE，但尾部 payload 没有足够信息确认是正常 final 还是异常收尾。',
  }
}

function serverLooksComplete(status: ServerStatusResult): boolean {
  return status.ok && status.status === 'COMPLETE'
}

export function installFleetWatch(
  runWatch: RunWatchController,
  options: FleetWatchOptions = {},
): FleetWatchController {
  const pollIntervalMs = Math.max(30_000, options.pollIntervalMs ?? 60_000)
  const recentLimit = Math.max(5, Math.min(50, options.recentLimit ?? 20))
  const recentWindowMs = Math.max(10 * 60_000, options.recentWindowMs ?? 2 * 60 * 60_000)
  const maxStatusChecksPerPoll = Math.max(1, Math.min(12, options.maxStatusChecksPerPoll ?? 8))
  const maxAlerts = Math.max(10, options.maxAlerts ?? 100)
  const startedAt = now()
  const entries = new Map<string, FleetConversationEntry>()
  const seenUpdate = new Map<string, string>()
  const alerts: FleetAlert[] = []
  const alreadyAlerted = new Set<string>()
  let polling = false
  let lastPollAt: number | undefined
  let recentListCount = 0
  let lastError: string | undefined
  let disposed = false

  const keyForUpdate = (value: string | number | undefined) => String(value ?? '')

  const buildSnapshot = (): FleetWatchSnapshot => ({
    protocol: 'chatgpt-passive-exporter/fleet-watch/v1',
    startedAt,
    lastPollAt,
    authReady: runWatch.hasEphemeralAuth(),
    polling,
    recentListCount,
    tracked: [...entries.values()]
      .sort((a, b) => (b.updateEpoch ?? b.lastChangedAt) - (a.updateEpoch ?? a.lastChangedAt)),
    alerts: [...alerts],
    lastError,
  })

  const notifyUpdate = () => options.onUpdate?.(buildSnapshot())

  const emitAlert = (entry: FleetConversationEntry, reason: string) => {
    const fingerprint = `${entry.id}:${keyForUpdate(entry.updateTime)}:${reason}`
    if (alreadyAlerted.has(fingerprint)) return
    alreadyAlerted.add(fingerprint)
    const alert: FleetAlert = {
      kind: 'abnormal',
      conversationId: entry.id,
      title: entry.title,
      reason,
      diagnostic: entry.diagnostic,
      at: now(),
    }
    alerts.push(alert)
    if (alerts.length > maxAlerts) alerts.splice(0, alerts.length - maxAlerts)
    options.onAlert?.(alert)
  }

  const inspectCompleted = async (entry: FleetConversationEntry) => {
    const tail = await runWatch.fetchConversationTail(entry.id, 2)
    if (!tail.ok || !tail.payload) {
      entry.state = 'complete-indeterminate'
      entry.abnormalReason = tail.reason ?? `尾部读取失败 HTTP ${tail.httpStatus ?? '?'}`
      return
    }

    const diagnostic = diagnoseLatestRun(tail.payload)
    entry.diagnostic = diagnostic
    const classified = classifyCompletedRun(diagnostic)
    entry.state = classified.state
    entry.abnormalReason = classified.reason
    if (classified.state === 'abnormal' && classified.reason) emitAlert(entry, classified.reason)
  }

  const pollNow = async (): Promise<FleetWatchSnapshot> => {
    if (disposed || polling) return buildSnapshot()
    polling = true
    lastError = undefined
    notifyUpdate()

    try {
      if (!runWatch.hasEphemeralAuth()) {
        lastError = '尚未捕获 ChatGPT 临时认证上下文；保留一张已登录 ChatGPT 首页并刷新一次。'
        return buildSnapshot()
      }

      const recent = await runWatch.listRecentConversations(recentLimit)
      recentListCount = recent.length
      const currentTime = now()
      const candidates: Array<{ entry: FleetConversationEntry, inspectOnComplete: boolean }> = []

      for (const item of recent) {
        const updateEpoch = timeToEpoch(item.updateTime)
        const updateKey = keyForUpdate(item.updateTime)
        const previousUpdate = seenUpdate.get(item.id)
        const existing = entries.get(item.id)
        const changed = previousUpdate !== undefined && previousUpdate !== updateKey
        const newlySeen = previousUpdate === undefined
        const recentlyUpdated = updateEpoch !== undefined && currentTime - updateEpoch <= recentWindowMs

        seenUpdate.set(item.id, updateKey)

        const entry: FleetConversationEntry = existing ?? {
          id: item.id,
          title: item.title,
          updateTime: item.updateTime,
          updateEpoch,
          state: 'tracking',
          lastChangedAt: currentTime,
        }
        entry.title = item.title
        entry.updateTime = item.updateTime
        entry.updateEpoch = updateEpoch
        if (changed) {
          entry.lastChangedAt = currentTime
          entry.state = 'tracking'
          entry.diagnostic = undefined
          entry.abnormalReason = undefined
        }
        entries.set(item.id, entry)

        // 首次启动不把 20~50 条历史记录全打 status；只检查最近窗口内的前几条。
        // 后续任何 update_time 变化都会进入 candidate；已经 server-active 的条目持续跟踪到结束。
        if (entry.state === 'server-active' || changed || (newlySeen && recentlyUpdated)) {
          candidates.push({
            entry,
            // 首次启动只建立服务器状态基线，不读取 COMPLETE 历史会话尾部、更不报警。
            // 只有已观察到运行态，或 update_time 在基线之后发生变化，结束时才做后验归因。
            inspectOnComplete: entry.state === 'server-active' || changed,
          })
        }
      }

      candidates.sort((a, b) => (b.entry.updateEpoch ?? b.entry.lastChangedAt) - (a.entry.updateEpoch ?? a.entry.lastChangedAt))

      for (const candidate of candidates.slice(0, maxStatusChecksPerPoll)) {
        const { entry, inspectOnComplete } = candidate
        const previousState = entry.state
        const status = await runWatch.checkConversationServerStatus(entry.id)
        entry.lastStatusAt = now()
        entry.rawServerStatus = status.status

        if (!status.ok || !status.status) {
          entry.state = 'status-error'
          entry.abnormalReason = status.reason ?? `stream_status HTTP ${status.httpStatus ?? '?'}`
          continue
        }

        if (serverLooksComplete(status)) {
          // 首次 baseline 中的 COMPLETE 只记完成；不读正文、不通知历史故障。
          if (inspectOnComplete || previousState === 'server-active') await inspectCompleted(entry)
          else entry.state = 'complete'
        }
        else {
          // 对所有非 COMPLETE 值保留原始 status，不擅自解释具体枚举含义。
          entry.state = 'server-active'
          entry.abnormalReason = undefined
        }
      }

      lastPollAt = now()
      return buildSnapshot()
    }
    catch (error) {
      lastError = String(error).slice(0, 300)
      return buildSnapshot()
    }
    finally {
      polling = false
      lastPollAt = now()
      notifyUpdate()
    }
  }

  const timer = window.setInterval(() => {
    void pollNow()
  }, pollIntervalMs)

  // 不在脚本装载瞬间猛打 API：延迟一小段时间，让 ChatGPT 自己先完成侧栏/账户请求，
  // Run Watch 才有机会从正常网页流量中获得临时认证上下文。
  const initialTimer = window.setTimeout(() => {
    void pollNow()
  }, 15_000)

  return {
    pollNow,
    snapshot: buildSnapshot,
    summaryText: () => {
      const snap = buildSnapshot()
      const active = snap.tracked.filter(item => item.state === 'server-active')
      const abnormal = snap.tracked.filter(item => item.state === 'abnormal')
      const lines = [
        `Fleet Watch: ${snap.authReady ? 'auth-ready' : 'waiting-auth'} / ${snap.polling ? 'polling' : 'idle'}`,
        `Recent list: ${snap.recentListCount}`,
        `Active conversations: ${active.length}`,
        `Abnormal conversations: ${abnormal.length}`,
      ]
      if (snap.lastPollAt) lines.push(`Last poll: ${new Date(snap.lastPollAt).toLocaleTimeString()}`)
      if (snap.lastError) lines.push(`Last error: ${snap.lastError}`)
      for (const item of active.slice(0, 8)) lines.push(`RUNNING? ${item.title} — ${item.rawServerStatus ?? 'non-COMPLETE'}`)
      for (const item of abnormal.slice(0, 8)) lines.push(`ERROR ${item.title} — ${item.abnormalReason ?? 'abnormal completion'}`)
      return lines.join('\n')
    },
    dispose: () => {
      disposed = true
      window.clearInterval(timer)
      window.clearTimeout(initialTimer)
    },
  }
}
