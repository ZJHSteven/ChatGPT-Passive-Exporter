/**
 * ChatGPT 私有 API 的“按 family 限流状态机”。
 *
 * 背景：
 * - 旧 daemon 只有一个全局 cooldownUntil；任一 catalog/body/mapping 429 都会把所有主动能力一起冻结。
 * - 真实日志已经证明 catalog 与 body 经常独立触发 429，而且 body/mapping 通常会返回 Retry-After，
 *   catalog 则通常没有。因此“一个全局桶 + 一个固定 60 分钟 fallback”会造成明显的误伤。
 *
 * 这个文件只负责**纯状态计算**，不发网络请求、不写磁盘、不碰 CDP。这样 daemon 可以把
 * 同一套规则复用于主动请求、native 页面 429、重启恢复和单元测试。
 */

export const RATE_LIMIT_FAMILIES = ['catalog', 'body', 'mapping', 'actor'] as const

export type RateLimitFamily = typeof RATE_LIMIT_FAMILIES[number]

export interface FamilyRateLimitState {
  /** 当前 family。保存在 state 中便于人工排障。 */
  family: RateLimitFamily
  /** 绝对 epoch 毫秒；0 表示当前没有 hard backoff。 */
  backoffUntil: number
  /**
   * catalog 的退避阶梯下标；-1 表示完全健康。
   * 其它 family 目前不使用指数阶梯，但保留同一字段以保持状态结构一致。
   */
  stage: number
  /** cooldown 到期后的 slow-start 还剩多少次主动成功请求。 */
  probationRemaining: number
  /** 最近一次 429 / 成功的时间，只用于遥测与后续建模。 */
  last429At: number | null
  lastSuccessAt: number | null
  /** 最近一次服务端 Retry-After 原文；catalog 通常为 null。 */
  lastRetryAfter: string | null
}

export interface FamilyRateLimitSnapshot {
  version: 1
  /**
   * 只用于从旧版 daemon 的单一 cooldownUntil 平滑迁移。
   * 新版 family 429 永远不会写这里；它到期以后自然归零。
   */
  legacyGlobalUntil: number
  families: Record<RateLimitFamily, FamilyRateLimitState>
}

export const CATALOG_BACKOFF_MS = [
  5 * 60_000,
  10 * 60_000,
  20 * 60_000,
  30 * 60_000,
  60 * 60_000,
] as const

function finiteFuture(value: unknown, now: number): number {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) && parsed > now ? parsed : 0
}

function nullableFinite(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function emptyFamilyState(family: RateLimitFamily): FamilyRateLimitState {
  return {
    family,
    backoffUntil: 0,
    stage: -1,
    probationRemaining: 0,
    last429At: null,
    lastSuccessAt: null,
    lastRetryAfter: null,
  }
}

function normalizeFamilyState(
  family: RateLimitFamily,
  raw: Partial<FamilyRateLimitState> | null | undefined,
  now: number,
): FamilyRateLimitState {
  const base = emptyFamilyState(family)
  if (!raw || typeof raw !== 'object') return base
  const stage = Number(raw.stage)
  const probationRemaining = Number(raw.probationRemaining)
  return {
    family,
    backoffUntil: finiteFuture(raw.backoffUntil, now),
    stage: Number.isFinite(stage)
      ? Math.max(-1, Math.min(CATALOG_BACKOFF_MS.length - 1, Math.trunc(stage)))
      : -1,
    probationRemaining: Number.isFinite(probationRemaining)
      ? Math.max(0, Math.trunc(probationRemaining))
      : 0,
    last429At: nullableFinite(raw.last429At),
    lastSuccessAt: nullableFinite(raw.lastSuccessAt),
    lastRetryAfter: typeof raw.lastRetryAfter === 'string' && raw.lastRetryAfter.trim()
      ? raw.lastRetryAfter.trim()
      : null,
  }
}

/**
 * 从 daemon state 恢复分级限流状态。
 *
 * 兼容策略：
 * - 如果已经存在 version=1 的 family state，直接恢复它；
 * - 如果是旧版 state，只把旧 cooldownUntil 放进 legacyGlobalUntil，一次性保守继承，
 *   防止“升级/重启 daemon”变成绕过正在生效的真实 429。
 */
export function restoreFamilyRateLimitSnapshot(
  previousState: any,
  now = Date.now(),
): FamilyRateLimitSnapshot {
  const rawRateLimits = previousState?.rateLimits
  const hasFamilyState = Number(rawRateLimits?.version) === 1 && rawRateLimits?.families
  const legacyGlobalUntil = hasFamilyState
    ? finiteFuture(rawRateLimits?.legacyGlobalUntil, now)
    : finiteFuture(previousState?.cooldownUntil, now)

  const families = Object.fromEntries(
    RATE_LIMIT_FAMILIES.map(family => [
      family,
      normalizeFamilyState(family, rawRateLimits?.families?.[family], now),
    ]),
  ) as Record<RateLimitFamily, FamilyRateLimitState>

  return {
    version: 1,
    legacyGlobalUntil,
    families,
  }
}

/** 返回某 family 当前是否允许发起主动请求。probation 不是禁止，只会把请求间隔拉长。 */
export function familyRateLimitAllowed(
  snapshot: FamilyRateLimitSnapshot,
  family: RateLimitFamily,
  now = Date.now(),
): boolean {
  if (Number(snapshot.legacyGlobalUntil || 0) > now) return false
  return Number(snapshot.families[family]?.backoffUntil || 0) <= now
}

/** 返回当前请求真正需要等待到的最晚 deadline，便于 checkpoint/queue 精确安排下一次尝试。 */
export function familyBackoffUntil(
  snapshot: FamilyRateLimitSnapshot,
  family: RateLimitFamily,
  now = Date.now(),
): number {
  const legacy = Number(snapshot.legacyGlobalUntil || 0) > now
    ? Number(snapshot.legacyGlobalUntil)
    : 0
  const familyUntil = Number(snapshot.families[family]?.backoffUntil || 0) > now
    ? Number(snapshot.families[family].backoffUntil)
    : 0
  return Math.max(legacy, familyUntil)
}

/**
 * cooldown 已经过期时，把 family 切进 probation。
 * 这里不自动“算成功”；真正一次 2xx 主动请求完成后再调用 recordFamilySuccess()。
 */
export function prepareFamilyProbation(
  snapshot: FamilyRateLimitSnapshot,
  family: RateLimitFamily,
  successesRequired = 3,
  now = Date.now(),
): FamilyRateLimitState {
  const current = snapshot.families[family]
  if (!current) throw new Error(`unknown rate-limit family: ${family}`)
  if (snapshot.legacyGlobalUntil > 0 && snapshot.legacyGlobalUntil <= now) {
    snapshot.legacyGlobalUntil = 0
  }
  if (current.backoffUntil > 0 && current.backoffUntil <= now) {
    current.backoffUntil = 0
    if (current.probationRemaining <= 0) {
      current.probationRemaining = Math.max(1, Math.trunc(Number(successesRequired) || 3))
    }
  }
  return current
}

/**
 * 记录某 family 的 429。
 *
 * catalog 没有 Retry-After 时使用 5→10→20→30→60 分钟阶梯。
 * 同一个 backoff 窗口内页面自己重复撞 429 时**不升级阶梯、不续杯**，否则 sidebar 每分钟
 * 自己重试几次就会瞬间被放大到 60 分钟，重演旧版“滑动一小时”问题。
 *
 * caller 如果拿到了 Retry-After，应提前算好 requestedDeadline 传入；这时所有 family 都以
 * 服务端 deadline 为主要真相源，只向后延长、不缩短已有窗口。
 */
export function recordFamily429(
  snapshot: FamilyRateLimitSnapshot,
  family: RateLimitFamily,
  options: {
    now?: number
    retryAfter?: string | null
    requestedDeadline?: number | null
    fallbackMs?: number
  } = {},
): FamilyRateLimitState {
  const now = Number(options.now ?? Date.now())
  const current = snapshot.families[family]
  if (!current) throw new Error(`unknown rate-limit family: ${family}`)
  current.last429At = now
  current.lastRetryAfter = typeof options.retryAfter === 'string' && options.retryAfter.trim()
    ? options.retryAfter.trim()
    : null

  const requestedDeadline = Number(options.requestedDeadline ?? 0)
  // 已处于 hard backoff 时，catalog/native 这种“没有 Retry-After 的重复 429”不升级、不续杯；
  // 但服务端如果明确给出一个更晚的 Retry-After deadline，仍然必须尊重并向后延长。
  if (current.backoffUntil > now) {
    if (Number.isFinite(requestedDeadline) && requestedDeadline > current.backoffUntil) {
      current.backoffUntil = requestedDeadline
    }
    return current
  }

  if (Number.isFinite(requestedDeadline) && requestedDeadline > now) {
    current.backoffUntil = requestedDeadline
    current.probationRemaining = 0
    // 非 catalog family 不使用阶梯；catalog 如果服务端未来开始给 Retry-After，
    // 仍保留既有 stage，probation 失败时可以继续从原阶梯升一级。
    return current
  }

  if (family === 'catalog') {
    const nextStage = Math.min(
      current.stage < 0 ? 0 : current.stage + 1,
      CATALOG_BACKOFF_MS.length - 1,
    )
    current.stage = nextStage
    current.backoffUntil = now + CATALOG_BACKOFF_MS[nextStage]!
    current.probationRemaining = 0
    return current
  }

  const fallbackMs = Math.max(1_000, Number(options.fallbackMs) || 60 * 60_000)
  current.backoffUntil = now + fallbackMs
  current.probationRemaining = 0
  return current
}

/**
 * 记录一次主动 2xx。
 * probation 中连续成功次数归零后 family 恢复 HEALTHY，并把 catalog stage 重置为 -1；
 * 普通健康期成功只更新时间，不改变任何 backoff。
 */
export function recordFamilySuccess(
  snapshot: FamilyRateLimitSnapshot,
  family: RateLimitFamily,
  now = Date.now(),
): FamilyRateLimitState {
  const current = prepareFamilyProbation(snapshot, family, 3, now)
  current.lastSuccessAt = Number(now)
  if (current.probationRemaining > 0) {
    current.probationRemaining -= 1
    if (current.probationRemaining === 0) {
      current.stage = -1
      current.backoffUntil = 0
      current.lastRetryAfter = null
    }
  }
  return current
}

/** 只有进入 probation 的 family 才需要复用 daemon 现有的 30 秒 slow-start 请求间隔。 */
export function familyProbationRemaining(
  snapshot: FamilyRateLimitSnapshot,
  family: RateLimitFamily,
  now = Date.now(),
  successesRequired = 3,
): number {
  return prepareFamilyProbation(snapshot, family, successesRequired, now).probationRemaining
}

/**
 * 根据当前 family hard backoff 生成 Guardian 的 CDP URL block。
 *
 * 注意 URL pattern 必须保持分级：
 * - catalog 只匹配 /backend-api/conversations?...，不能挡 /conversations/{cid}
 * - body 只匹配 plural body 路径；
 * - mapping 匹配 singular conversation 路径；
 * - actor POST /f/conversation 不在这些 pattern 中。
 *
 * legacy global 仅用于旧 state 迁移，保留旧版两条宽 pattern。
 */
export function guardianBlockedUrlPatterns(
  snapshot: FamilyRateLimitSnapshot,
  now = Date.now(),
): string[] {
  if (snapshot.legacyGlobalUntil > now) {
    return [
      'https://chatgpt.com/backend-api/conversations*',
      'https://chatgpt.com/backend-api/conversation/*',
    ]
  }

  const patterns: string[] = []
  if (snapshot.families.catalog.backoffUntil > now) {
    patterns.push('https://chatgpt.com/backend-api/conversations?*')
  }
  if (snapshot.families.body.backoffUntil > now) {
    patterns.push('https://chatgpt.com/backend-api/conversations/*')
  }
  // singular /conversation/{cid} 与 /conversation/{cid}/stream_status 共用同一前缀；
  // CDP blocked URL 无法安全表达“只挡 exact mapping、不挡 stream_status”，因此 mapping family
  // 只在 daemon request gate 中限流，不在浏览器层做宽泛 block，避免误伤 body/checkpoint。
  return patterns
}

