/**
 * Phase 3：跨设备/丢失 live transport 时的 canonical checkpoint 追踪状态机。
 *
 * 背景：2026-10-06 真机已经确认，当另一台设备发起的 turn 在本机没有 resume token 时，
 * ChatGPT Web 会先查询 `stream_status`。若仍为 `IS_STREAMING` 且 `/resume` 不可用，页面不会
 * 无限等待；而是大约每 7~10 秒重新读取 `stream_status + conversation body`，从服务端已经
 * 持久化的 canonical message/checkpoint 中取得新的 reasoning/tool/message 节点。
 *
 * 这个文件只负责**纯状态计算**，不直接发 HTTP，也不读 Cookie/Token。这样：
 * 1. daemon 的网络层仍统一走现有 request gate / 429 cooldown；
 * 2. 状态机可以单元测试，不需要真的访问 ChatGPT；
 * 3. 以后上游 cadence 或 status 字段漂移时，只需修改一个小模块并补 fixture。
 */

/** 第一方 `stream_status` 当前已经实测到的高层状态。 */
export type CheckpointStreamState = 'streaming' | 'complete' | 'unknown'

/**
 * 一个 conversation 的 checkpoint watcher 运行态。
 *
 * 注意：`startedAt` 表示“Archive 开始追踪”的时间，不是假装成真实 turn start。
 * 真正的 turn identity 要等 conversation body 中的 `turn_exchange_id/request_id`。
 */
export interface CheckpointWatchState {
  conversationId: string
  source: string
  startedAt: number
  lastObservedAt: number
  nextProbeAt: number
  probes: number
  bodyRefreshes: number
  consecutiveErrors: number
  lastStatus: CheckpointStreamState
  lastStatusRaw: string | null
  lastCurrentNode: string | null
  lastUpdateTime: string | number | null
  /** 最近一次 canonical head 发生真实变化的时间；用于无进展自动止损。 */
  lastProgressAt: number
  /** canonical head 真实前进的次数；首份 body 也记作一次已知进展。 */
  progressEvents: number
  turnExchangeId: string | null
  requestId: string | null
  lastError: string | null
}

export type CheckpointSafetyStopReason =
  | 'watch-age-limit'
  | 'request-budget-limit'
  | 'no-progress-limit'

/**
 * 把第一方 status payload 压成 Archive 只需要的三态。
 *
 * 当前真机值：
 * - `IS_STREAMING`：服务端仍认为该 conversation 有运行中的工作；
 * - `COMPLETE`：服务端认为流式工作已结束；
 * - 其它值：保守记为 unknown，不猜测终态。
 */
export function normalizeCheckpointStreamStatus(value: unknown): CheckpointStreamState {
  const normalized = String(value ?? '').trim().toUpperCase()
  if (normalized === 'IS_STREAMING' || normalized === 'STREAMING') return 'streaming'
  if (normalized === 'COMPLETE' || normalized === 'COMPLETED') return 'complete'
  return 'unknown'
}

/**
 * 第一方页面实测 cadence 不是硬编码 7 秒，而是在约 7~10 秒之间波动。
 * daemon 复刻“量级和节奏”，而不是制造一个精确周期的机器人指纹。
 *
 * `random01` 显式注入，便于测试边界；生产传 `Math.random()` 即可。
 */
export function checkpointProbeDelayMs(
  minMs = 7_000,
  maxMs = 10_000,
  random01 = Math.random(),
): number {
  const safeMin = Math.max(1_000, Math.floor(Number(minMs) || 7_000))
  const safeMax = Math.max(safeMin, Math.floor(Number(maxMs) || 10_000))
  const r = Math.min(1, Math.max(0, Number(random01) || 0))
  return safeMin + Math.floor((safeMax - safeMin) * r)
}

/** 创建一个新的 watcher；默认很快做第一次确认，不假装已经知道远端 turn identity。 */
export function createCheckpointWatch(args: {
  conversationId: string
  source: string
  now: number
  firstProbeDelayMs?: number
}): CheckpointWatchState {
  const firstProbeDelayMs = Math.max(0, Number(args.firstProbeDelayMs ?? 1_000) || 0)
  return {
    conversationId: args.conversationId,
    source: args.source,
    startedAt: args.now,
    lastObservedAt: args.now,
    nextProbeAt: args.now + firstProbeDelayMs,
    probes: 0,
    bodyRefreshes: 0,
    consecutiveErrors: 0,
    lastStatus: 'unknown',
    lastStatusRaw: null,
    lastCurrentNode: null,
    lastUpdateTime: null,
    lastProgressAt: args.now,
    progressEvents: 0,
    turnExchangeId: null,
    requestId: null,
    lastError: null,
  }
}

/**
 * 一次成功 status probe 后推进 watcher。
 * COMPLETE 不在这里删除；调用方需要先做最后一次 canonical body merge，再显式停止 watcher。
 */
export function recordCheckpointStatus(args: {
  state: CheckpointWatchState
  rawStatus: unknown
  now: number
  nextDelayMs: number
}): CheckpointWatchState {
  const raw = args.rawStatus == null ? null : String(args.rawStatus)
  return {
    ...args.state,
    probes: args.state.probes + 1,
    lastObservedAt: args.now,
    nextProbeAt: args.now + Math.max(1_000, Math.floor(args.nextDelayMs)),
    consecutiveErrors: 0,
    lastStatus: normalizeCheckpointStreamStatus(raw),
    lastStatusRaw: raw,
    lastError: null,
  }
}

/** conversation body 成功合并后保存 turn identity 和 canonical head。 */
export function recordCheckpointBody(args: {
  state: CheckpointWatchState
  now: number
  currentNode?: unknown
  updateTime?: unknown
  turnExchangeId?: unknown
  requestId?: unknown
}): CheckpointWatchState {
  const asString = (value: unknown): string | null => typeof value === 'string' && value ? value : null
  const currentNode = asString(args.currentNode)
  const updateTime = typeof args.updateTime === 'string' || typeof args.updateTime === 'number'
    ? args.updateTime
    : null
  const firstBody = args.state.bodyRefreshes === 0
  const progressed = firstBody
    || currentNode !== args.state.lastCurrentNode
    || updateTime !== args.state.lastUpdateTime
  return {
    ...args.state,
    bodyRefreshes: args.state.bodyRefreshes + 1,
    lastObservedAt: args.now,
    lastCurrentNode: currentNode,
    lastUpdateTime: updateTime,
    lastProgressAt: progressed ? args.now : args.state.lastProgressAt,
    progressEvents: args.state.progressEvents + (progressed ? 1 : 0),
    turnExchangeId: asString(args.turnExchangeId) ?? args.state.turnExchangeId,
    requestId: asString(args.requestId) ?? args.state.requestId,
    consecutiveErrors: 0,
    lastError: null,
  }
}

/**
 * 主动 checkpoint polling 的纯安全门。
 *
 * 生产实测表明：第一方页面短时 7~10 秒 polling 本身成立，但把它无限复制成后台 watcher
 * 会在几十到上百次私有请求后反复触发 429。因此“cadence 像第一方”不等于“可以无限运行”。
 * 这里把单 watcher 的年龄、请求总量和无进展窗口都做成显式上限；daemon 在每次新 probe 前
 * 先调用本函数，命中任一条件就停止且 suppress 该 CID，绝不再发本轮请求。
 */
export function checkpointSafetyStopReason(args: {
  state: CheckpointWatchState
  now: number
  maxWatchMs: number
  maxRequests: number
  noProgressMs: number
}): CheckpointSafetyStopReason | null {
  const maxWatchMs = Math.max(1_000, Math.floor(Number(args.maxWatchMs) || 0))
  const maxRequests = Math.max(1, Math.floor(Number(args.maxRequests) || 0))
  const noProgressMs = Math.max(1_000, Math.floor(Number(args.noProgressMs) || 0))
  const ageMs = Math.max(0, Number(args.now) - Number(args.state.startedAt || 0))
  if (ageMs >= maxWatchMs) return 'watch-age-limit'

  const requests = Math.max(0, Number(args.state.probes || 0))
    + Math.max(0, Number(args.state.bodyRefreshes || 0))
  if (requests >= maxRequests) return 'request-budget-limit'

  if (args.state.bodyRefreshes > 0) {
    const noProgressForMs = Math.max(0, Number(args.now) - Number(args.state.lastProgressAt || args.state.startedAt || 0))
    if (noProgressForMs >= noProgressMs) return 'no-progress-limit'
  }
  return null
}

/**
 * 网络/shape 错误只推进退避计数，不在纯状态机里决定是否重试。
 * daemon 会把 401/403/429/协议漂移分别接到现有 auth/cooldown/drift 机制。
 */
export function recordCheckpointError(args: {
  state: CheckpointWatchState
  now: number
  error: string
  retryDelayMs: number
}): CheckpointWatchState {
  return {
    ...args.state,
    lastObservedAt: args.now,
    nextProbeAt: args.now + Math.max(1_000, Math.floor(args.retryDelayMs)),
    consecutiveErrors: args.state.consecutiveErrors + 1,
    lastError: args.error,
  }
}

