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
  | 'server-streaming'
  | 'complete'
  | 'abnormal'
  | 'complete-indeterminate'
  | 'status-unknown'
  | 'status-error'

export interface FleetConversationEntry {
  id: string
  title: string
  updateTime?: string | number
  updateEpoch?: number
  /** 原样保存列表中的 async_status；只把已实测到的 3/null 当交叉证据。 */
  asyncStatus?: number | string | null
  state: FleetConversationState
  rawServerStatus?: string
  lastStatusAt?: number
  lastChangedAt: number
  diagnostic?: RunDiagnostic
  abnormalReason?: string
}

export interface FleetAlert {
  /** abnormal 才允许进入恢复候选；suspected-stall 只能提醒，绝不自动续跑。 */
  kind: 'abnormal' | 'suspected-stall'
  conversationId: string
  title: string
  reason: string
  diagnostic?: RunDiagnostic
  at: number
  acknowledged?: boolean
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
  /** 服务端仍声称 streaming，但 conversation update_time 长时间不变时仅发“疑似僵尸”提醒。 */
  suspectedStallMs?: number
  onUpdate?: (snapshot: FleetWatchSnapshot) => void
  onAlert?: (alert: FleetAlert) => void
}

export interface FleetWatchController {
  pollNow: () => Promise<FleetWatchSnapshot>
  snapshot: () => FleetWatchSnapshot
  summaryText: () => string
  dispose: () => void
}

// v2 起采用“双服务端信号 + COMPLETE 二次确认”判据；不继承 v1 时代可能误报的历史告警。
const STORAGE_KEY = 'chatgpt-passive-exporter/fleet-watch/state/v2'

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

export type ServerEvidence = 'confirmed-streaming' | 'confirmed-complete' | 'conflict' | 'unknown'

/**
 * 把两个彼此独立的服务端视图合并成一个“证据等级”。
 * 当前 2026-08-30 实测：文本/Agent 轮次可见 3→4 对应 IS_STREAMING→COMPLETE；
 * 普通已完成历史常为 null。近期独立逆向还观察到 async 流程 3/5→4。
 * 因此 3/5 仅作为“进行态佐证”，4/null 仅作为“完成态佐证”；其它值保守处理。
 */
export function classifyServerEvidence(
  asyncStatus: number | string | null | undefined,
  streamStatus: ServerStatusResult,
): ServerEvidence {
  if (!streamStatus.ok || !streamStatus.status) return 'unknown'
  if (streamStatus.status === 'IS_STREAMING') {
    return asyncStatus === 3 || asyncStatus === 5 ? 'confirmed-streaming' : 'conflict'
  }
  if (streamStatus.status === 'COMPLETE') {
    return asyncStatus === null || asyncStatus === 4 ? 'confirmed-complete' : 'conflict'
  }
  return 'unknown'
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms))
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
  const suspectedStallMs = Math.max(30 * 60_000, options.suspectedStallMs ?? 40 * 60_000)
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

  const restore = () => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return
      const stored = JSON.parse(raw) as {
        seenUpdate?: Array<[string, string]>
        tracked?: FleetConversationEntry[]
        alerts?: FleetAlert[]
      }
      for (const [id, update] of stored.seenUpdate ?? []) seenUpdate.set(id, update)
      for (const entry of stored.tracked ?? []) {
        // 只恢复真正需要跨 reload 延续的状态；普通 complete 历史不占长期内存。
        if (entry.state === 'server-streaming' || entry.state === 'abnormal' || entry.state === 'complete-indeterminate') {
          entries.set(entry.id, entry)
        }
      }
      for (const alert of stored.alerts ?? []) {
        alerts.push(alert)
        alreadyAlerted.add(`${alert.kind}:${alert.conversationId}:${keyForUpdate(entries.get(alert.conversationId)?.updateTime)}`)
      }
    }
    catch {
      // 本地状态损坏时从空基线重建，不影响 ChatGPT 页面。
    }
  }

  const persist = () => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        seenUpdate: [...seenUpdate.entries()].slice(0, 100),
        tracked: [...entries.values()].filter(entry => (
          entry.state === 'server-streaming'
          || entry.state === 'abnormal'
          || entry.state === 'complete-indeterminate'
        )),
        alerts: alerts.slice(-maxAlerts),
      }))
    }
    catch {
      // localStorage 不可用时保留当前内存状态即可。
    }
  }

  restore()

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

  const emitAlert = (entry: FleetConversationEntry, reason: string, kind: FleetAlert['kind'] = 'abnormal') => {
    // 同一 conversation 同一 update_time 下，同类告警只发一次；分钟数变化不会造成通知风暴。
    const fingerprint = `${kind}:${entry.id}:${keyForUpdate(entry.updateTime)}`
    if (alreadyAlerted.has(fingerprint)) return
    alreadyAlerted.add(fingerprint)
    const alert: FleetAlert = {
      kind,
      conversationId: entry.id,
      title: entry.title,
      reason,
      diagnostic: entry.diagnostic,
      at: now(),
    }
    alerts.push(alert)
    if (alerts.length > maxAlerts) alerts.splice(0, alerts.length - maxAlerts)
    persist()
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
    if (classified.state === 'abnormal' && classified.reason) emitAlert(entry, classified.reason, 'abnormal')
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
        entry.asyncStatus = item.asyncStatus
        if (changed) {
          entry.lastChangedAt = currentTime
          entry.state = 'tracking'
          entry.diagnostic = undefined
          entry.abnormalReason = undefined
        }
        entries.set(item.id, entry)

        // 首次启动不把 20~50 条历史记录全打 status；只检查最近窗口内的前几条。
        // 后续任何 update_time 变化都会进入 candidate；已经 server-active 的条目持续跟踪到结束。
        if (
          entry.state === 'server-streaming'
          || entry.state === 'status-error'
          || entry.state === 'status-unknown'
          || changed
          || (newlySeen && recentlyUpdated)
          || item.asyncStatus === 3
          || item.asyncStatus === 5
        ) {
          candidates.push({
            entry,
            // 首次启动只建立服务器状态基线，不读取 COMPLETE 历史会话尾部、更不报警。
            // 只有已观察到运行态，或 update_time 在基线之后发生变化，结束时才做后验归因。
            inspectOnComplete: entry.state === 'server-streaming' || changed,
          })
        }
      }

      candidates.sort((a, b) => (b.entry.updateEpoch ?? b.entry.lastChangedAt) - (a.entry.updateEpoch ?? a.entry.lastChangedAt))

      for (const candidate of candidates.slice(0, maxStatusChecksPerPoll)) {
        const { entry, inspectOnComplete } = candidate
        const previousState = entry.state
        const status = await runWatch.checkConversationServerStatus(entry.id)
        entry.lastStatusAt = now()
        if (status.status) entry.rawServerStatus = status.status

        const evidence = classifyServerEvidence(entry.asyncStatus, status)
        if (evidence === 'unknown') {
          // 网络失败、401/403/429、解析失败、未来未知枚举都只是 UNKNOWN。
          // 绝不能把上一轮 streaming 直接升级成“异常结束”，而且下一轮必须继续重试。
          entry.state = status.ok ? 'status-unknown' : 'status-error'
          entry.abnormalReason = status.ok
            ? `未识别/不完整的服务端状态：${status.status ?? 'missing status'}`
            : status.reason ?? `stream_status HTTP ${status.httpStatus ?? '?'}`
          continue
        }

        if (evidence === 'conflict') {
          entry.state = 'status-unknown'
          entry.abnormalReason = `两套服务端信号不一致：stream_status=${status.status ?? 'missing'}，async_status=${String(entry.asyncStatus)}`
          continue
        }

        if (evidence === 'confirmed-streaming') {
          entry.state = 'server-streaming'
          entry.abnormalReason = undefined
          const persistedIdleMs = entry.updateEpoch === undefined ? 0 : now() - entry.updateEpoch
          if (persistedIdleMs >= suspectedStallMs) {
            emitAlert(
              entry,
              `服务器仍报告 IS_STREAMING / async_status=${String(entry.asyncStatus)}，但 conversation update_time 已 ${Math.round(persistedIdleMs / 60_000)} 分钟没有变化。仅判为疑似僵尸，不自动续跑。`,
              'suspected-stall',
            )
          }
          continue
        }

        // 到这里才是 async_status=null + stream_status=COMPLETE。
        // 为自动恢复预留更严格的终止证据：短暂等待后再次读取 stream_status；
        // 若第二次不再 COMPLETE 或请求失败，退回 UNKNOWN，绝不做后验异常判断。
        await sleep(3_000)
        const confirm = await runWatch.checkConversationServerStatus(entry.id)
        entry.lastStatusAt = now()
        if (!confirm.ok || confirm.status !== 'COMPLETE') {
          entry.state = confirm.ok ? 'status-unknown' : 'status-error'
          entry.abnormalReason = confirm.ok
            ? `COMPLETE 二次确认失败：${confirm.status ?? 'missing status'}`
            : confirm.reason ?? `二次确认 HTTP ${confirm.httpStatus ?? '?'}`
          continue
        }

        // 首次 baseline 中的 COMPLETE 只记完成；不读正文、不通知历史故障。
        if (inspectOnComplete || previousState === 'server-streaming') await inspectCompleted(entry)
        else entry.state = 'complete'
      }

      lastPollAt = now()
      persist()
      return buildSnapshot()
    }
    catch (error) {
      lastError = String(error).slice(0, 300)
      persist()
      return buildSnapshot()
    }
    finally {
      polling = false
      lastPollAt = now()
      persist()
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
      const active = snap.tracked.filter(item => item.state === 'server-streaming')
      const abnormal = snap.tracked.filter(item => item.state === 'abnormal')
      const suspected = snap.alerts.filter(item => item.kind === 'suspected-stall')
      const lines = [
        `Fleet Watch: ${snap.authReady ? 'auth-ready' : 'waiting-auth'} / ${snap.polling ? 'polling' : 'idle'}`,
        `Recent list: ${snap.recentListCount}`,
        `Active conversations: ${active.length}`,
        `Abnormal conversations: ${abnormal.length}`,
        `Suspected stalled: ${suspected.length}`,
      ]
      if (snap.lastPollAt) lines.push(`Last poll: ${new Date(snap.lastPollAt).toLocaleTimeString()}`)
      if (snap.lastError) lines.push(`Last error: ${snap.lastError}`)
      for (const item of active.slice(0, 8)) lines.push(`STREAMING ${item.title} — ${item.rawServerStatus ?? 'IS_STREAMING'}`)
      for (const item of abnormal.slice(0, 8)) lines.push(`ERROR ${item.title} — ${item.abnormalReason ?? 'abnormal completion'}`)
      for (const alert of suspected.slice(-8)) lines.push(`SUSPECT ${alert.title} — ${alert.reason}`)
      return lines.join('\n')
    },
    dispose: () => {
      disposed = true
      persist()
      window.clearInterval(timer)
      window.clearTimeout(initialTimer)
    },
  }
}
