import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Actor 的 DOM 漂移监控只关心“页面骨架还能不能安全自动化”，绝不保存聊天正文。
 *
 * 浏览器侧会先把真实 DOM 归约成这个观察对象：
 * - URL 只保留 route 类别，不保留 conversation/project id；
 * - aria/title 的具体文字不落盘，只保留“该属性是否存在”；
 * - composer 控件只保留 send/stop/attachment/voice 这几个语义类别和结构属性；
 * - sidebar 只保留 canonical conversation/project 链接模式是否存在。
 */
export interface ActorDomObservation {
  routeKind: 'home' | 'conversation' | 'project' | 'other'
  composer: null | {
    tag: string | null
    id: string | null
    role: string | null
    contentEditable: string | null
    formMarker: boolean
  }
  newChat: null | {
    tag: string | null
    testId: string | null
  }
  sidebar: {
    canonicalConversationLink: boolean
    projectLink: boolean
    accountButton: boolean
  }
  controls: Array<{
    semantic: 'send' | 'stop' | 'attachment' | 'voice'
    tag: string | null
    type: string | null
    testId: string | null
    ariaPresent: boolean
    titlePresent: boolean
  }>
}

/**
 * 持久化指纹使用的“稳定形态”与浏览器原始观察故意不是同一个类型。
 *
 * `send / stop / voice` 在当前 ChatGPT composer 里是同一个右侧主动作槽位的三种运行态：
 * 空输入时常见 voice，有文本时变 send，生成中又变 stop。它们会在一次正常发送的几十秒内
 * 反复切换，不能作为“DOM 结构发生未知漂移”的证据。因此指纹层把三者归一成
 * `primary-action`；attachment 仍单独保留，因为附件入口是真正相对稳定的结构控件。
 */
export interface ActorDomShape extends Omit<ActorDomObservation, 'controls'> {
  controls: Array<{
    semantic: 'attachment' | 'primary-action'
    tag: string | null
    type: string | null
    testId: string | null
    ariaPresent: boolean
    titlePresent: boolean
  }>
}

interface ActorDomVariantState {
  signature: string
  shape: ActorDomShape
  firstSeenAt: number
  lastSeenAt: number
  count: number
  baseline: boolean
  lastReportedAt: number | null
}

export interface ActorDomDriftState {
  version: 2
  createdAt: number
  baselineUntil: number
  baselineLockedAt: number | null
  updatedAt: number
  variants: Record<string, ActorDomVariantState>
}

export interface ActorDomObserveResult {
  signature: string
  isNew: boolean
  baseline: boolean
  pending: boolean
  shape: ActorDomShape
}

export interface ActorDomPendingChange {
  kind: 'dom'
  signature: string
  routeKind: ActorDomShape['routeKind']
  firstSeenAt: number
  lastSeenAt: number
  count: number
  shape: ActorDomShape
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']'
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return '{' + Object.keys(record).sort().map(key => JSON.stringify(key) + ':' + stableJson(record[key])).join(',') + '}'
  }
  return JSON.stringify(value)
}

function hashShape(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex').slice(0, 16)
}

/**
 * sidebar 里“当前有没有可见 conversation/project/account 入口”属于易变页面状态，而不是
 * Actor 真正依赖的发送安全骨架：侧栏可能折叠、虚拟化、分页，目标 conversation 不在当前
 * DOM 时 Actor 本来就会退回 full navigation。这里仅在 **其余所有结构字段完全一致** 时，
 * 允许一个已批准 baseline 为新的 sidebar presence 变体背书。
 *
 * 注意这不是把 sidebar 从 forensic shape 里删除：完整布尔值仍落 ledger，便于事后看页面形态；
 * 只是它单独变化不再阻断发送。composer/form/new-chat/attachment/primary-action 等任何变化仍 pending。
 */
function sameStableAutomationSkeleton(left: ActorDomShape, right: ActorDomShape): boolean {
  const { sidebar: _leftSidebar, ...leftStable } = left
  const { sidebar: _rightSidebar, ...rightStable } = right
  return stableJson(leftStable) === stableJson(rightStable)
}

function normalizedNullable(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

/**
 * 控件排序后再哈希，避免 React 仅改变 DOM 顺序就制造假漂移。
 * testid 本身属于自动化结构契约，因此保留；aria/title 的具体文字不保留，避免 locale/正文泄漏。
 */
export function buildActorDomShape(input: ActorDomObservation): ActorDomShape {
  const normalizedControls = (Array.isArray(input.controls) ? input.controls : [])
    .filter(control => ['send', 'stop', 'attachment', 'voice'].includes(String(control?.semantic)))
    .map(control => {
      const dynamicPrimary = ['send', 'stop', 'voice'].includes(control.semantic)
      return {
        // send / stop / voice 是同一动态槽位，不能因为业务状态切换就制造 DOM drift。
        semantic: dynamicPrimary ? 'primary-action' as const : 'attachment' as const,
        tag: normalizedNullable(control.tag)?.toUpperCase() ?? null,
        // 主动作的 type/testId 也随 voice/send/stop 形态改变，因此只在稳定 attachment 上保留。
        // 若主动作连 BUTTON 这一层或 aria/title 结构都变化，signature 仍会改变并触发人工复核。
        type: dynamicPrimary ? null : normalizedNullable(control.type)?.toLowerCase() ?? null,
        testId: dynamicPrimary ? null : normalizedNullable(control.testId),
        ariaPresent: Boolean(control.ariaPresent),
        titlePresent: Boolean(control.titlePresent),
      }
    })
    .sort((a, b) => stableJson(a).localeCompare(stableJson(b)))

  // 某些 React 过渡帧会短暂同时挂着两个语义不同但结构相同的 primary 控件。
  // 指纹关心“槽位结构是否存在”，不关心过渡帧里有几个等价副本，因此按稳定 JSON 去重。
  const controls = normalizedControls.filter((control, index, all) => (
    index === 0 || stableJson(control) !== stableJson(all[index - 1])
  ))

  return {
    routeKind: ['home', 'conversation', 'project', 'other'].includes(input.routeKind)
      ? input.routeKind
      : 'other',
    composer: input.composer ? {
      tag: normalizedNullable(input.composer.tag)?.toUpperCase() ?? null,
      id: normalizedNullable(input.composer.id),
      role: normalizedNullable(input.composer.role)?.toLowerCase() ?? null,
      contentEditable: normalizedNullable(input.composer.contentEditable)?.toLowerCase() ?? null,
      formMarker: Boolean(input.composer.formMarker),
    } : null,
    newChat: input.newChat ? {
      tag: normalizedNullable(input.newChat.tag)?.toUpperCase() ?? null,
      testId: normalizedNullable(input.newChat.testId),
    } : null,
    sidebar: {
      canonicalConversationLink: Boolean(input.sidebar?.canonicalConversationLink),
      projectLink: Boolean(input.sidebar?.projectLink),
      accountButton: Boolean(input.sidebar?.accountButton),
    },
    controls,
  }
}

export function actorDomSignature(shape: ActorDomShape): string {
  return hashShape(shape)
}

function newState(now: number, baselineWindowMs: number): ActorDomDriftState {
  return {
    version: 2,
    createdAt: now,
    baselineUntil: now + baselineWindowMs,
    baselineLockedAt: null,
    updatedAt: now,
    variants: {},
  }
}

/**
 * DOM ledger 与 HTTP protocol ledger 分开持久化，但报告层会合并展示/通知。
 *
 * 默认给 6 小时学习窗口：足够经历 home / conversation / active steer 等几个正常 UI 状态，
 * 又不会像 24 小时那样让明显结构变更长期处于“学习中”。用户也可以显式 lock 提前冻结基线。
 */
export class ActorDomDriftLedger {
  readonly filePath: string
  readonly baselineWindowMs: number
  state: ActorDomDriftState

  private constructor(filePath: string, state: ActorDomDriftState, baselineWindowMs: number) {
    this.filePath = filePath
    this.state = state
    this.baselineWindowMs = baselineWindowMs
  }

  static async open(
    filePath: string,
    options: { baselineWindowMs?: number, now?: number } = {},
  ): Promise<ActorDomDriftLedger> {
    const now = options.now ?? Date.now()
    const baselineWindowMs = Math.max(60_000, options.baselineWindowMs ?? 6 * 3600_000)
    let state: ActorDomDriftState
    try {
      const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as ActorDomDriftState | (Omit<ActorDomDriftState, 'version'> & { version: 1 })
      if (![1, 2].includes(Number(parsed?.version)) || !parsed.variants || typeof parsed.variants !== 'object') {
        throw new Error('unsupported Actor DOM drift ledger format')
      }
      state = parsed.version === 1
        ? migrateVersion1State(parsed, now)
        : parsed
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      state = newState(now, baselineWindowMs)
    }
    const ledger = new ActorDomDriftLedger(filePath, state, baselineWindowMs)
    ledger.refreshBaselineLock(now)
    return ledger
  }

  refreshBaselineLock(now = Date.now()): boolean {
    if (this.state.baselineLockedAt === null && now >= this.state.baselineUntil) {
      this.state.baselineLockedAt = now
      this.state.updatedAt = now
      return true
    }
    return false
  }

  /** 用户确认当前正常结构已经覆盖充分时，可提前锁住学习窗口。 */
  lockBaseline(now = Date.now()): void {
    if (this.state.baselineLockedAt === null) this.state.baselineLockedAt = now
    this.state.baselineUntil = Math.min(this.state.baselineUntil, now)
    this.state.updatedAt = now
  }

  observe(input: ActorDomObservation, observedAt = Date.now()): ActorDomObserveResult {
    this.refreshBaselineLock(observedAt)
    const shape = buildActorDomShape(input)
    const signature = actorDomSignature(shape)
    let variant = this.state.variants[signature]
    const isNew = !variant
    const trustedSidebarVariant = this.state.baselineLockedAt !== null
      && Object.values(this.state.variants).some(candidate => (
        candidate.baseline && sameStableAutomationSkeleton(candidate.shape, shape)
      ))
    const baseline = this.state.baselineLockedAt === null || trustedSidebarVariant
    if (!variant) {
      variant = {
        signature,
        shape,
        firstSeenAt: observedAt,
        lastSeenAt: observedAt,
        count: 0,
        baseline,
        lastReportedAt: null,
      }
      this.state.variants[signature] = variant
    }
    else if (!variant.baseline && trustedSidebarVariant) {
      // 旧版本可能已经把这个 sidebar-only 变体记录成 pending；升级后首次再观察时原地纠正，
      // 不要求用户为纯折叠/虚拟化状态手工 approve。
      variant.baseline = true
      variant.lastReportedAt = observedAt
    }
    variant.lastSeenAt = observedAt
    variant.count += 1
    this.state.updatedAt = observedAt
    return {
      signature,
      isNew,
      baseline: variant.baseline,
      // 未批准结构不能因为“已经见过一次”就在第二次重试时自动放行；只有 approve()、
      // 学习期 baseline 或上面的严格 sidebar-only 等价规则能解除 pending。
      pending: !variant.baseline,
      shape,
    }
  }

  pendingChanges(options: { unreportedOnly?: boolean } = {}): ActorDomPendingChange[] {
    const unreportedOnly = options.unreportedOnly ?? true
    return Object.values(this.state.variants)
      .filter(variant => {
        if (variant.baseline || (unreportedOnly && variant.lastReportedAt !== null)) return false
        // v2 之前已经落盘的一次性 sidebar 折叠/虚拟化变体，可能再也不会被 observe() 触发从而
        // 原地升级 baseline。报告阶段同样应用严格的“安全骨架完全一致”规则，避免这种旧噪声
        // 永久挂在 pending 并被日报反复当成 DOM 漂移。
        const trustedSidebarOnly = Object.values(this.state.variants).some(candidate => (
          candidate.baseline && sameStableAutomationSkeleton(candidate.shape, variant.shape)
        ))
        return !trustedSidebarOnly
      })
      .map(variant => ({
        kind: 'dom' as const,
        signature: variant.signature,
        routeKind: variant.shape.routeKind,
        firstSeenAt: variant.firstSeenAt,
        lastSeenAt: variant.lastSeenAt,
        count: variant.count,
        shape: variant.shape,
      }))
      .sort((a, b) => a.firstSeenAt - b.firstSeenAt)
  }

  markReported(changes: ActorDomPendingChange[], now = Date.now()): void {
    for (const change of changes) {
      const variant = this.state.variants[change.signature]
      if (variant) variant.lastReportedAt = now
    }
    this.state.updatedAt = now
  }

  /** 人工确认某个 pending 结构是新版正常 DOM 后，将它提升为基线。 */
  approve(signature: string, now = Date.now()): boolean {
    const variant = this.state.variants[signature]
    if (!variant) return false
    variant.baseline = true
    variant.lastReportedAt = now
    this.state.updatedAt = now
    return true
  }

  summary(now = Date.now()) {
    this.refreshBaselineLock(now)
    const variants = Object.values(this.state.variants)
    return {
      filePath: this.filePath,
      baselineMode: this.state.baselineLockedAt === null ? 'learning' : 'locked',
      baselineUntil: this.state.baselineUntil,
      baselineLockedAt: this.state.baselineLockedAt,
      variants: variants.length,
      pendingUnreported: this.pendingChanges({ unreportedOnly: true }).length,
      baselineVariants: variants.filter(variant => variant.baseline).length,
    }
  }

  async flush(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const temporary = this.filePath + '.tmp-' + process.pid
    await fs.writeFile(temporary, JSON.stringify(this.state, null, 2))
    await fs.rename(temporary, this.filePath)
  }
}

/**
 * v1 指纹把 voice/send/stop 当成三种不同 DOM 结构，导致正常 composer 状态切换在 baseline
 * 锁定后被误报为漂移。v2 打开旧 ledger 时原地归一并合并等价 variant：
 * - 任一旧 variant 已是 baseline，则合并后的 variant 仍是 baseline；
 * - count 累加，first/last seen 取包络；
 * - lastReportedAt 取最新值；
 * - 不凭迁移自动批准真正不同的 composer/sidebar/attachment 结构。
 */
function migrateVersion1State(
  legacy: Omit<ActorDomDriftState, 'version'> & { version: 1 },
  now: number,
): ActorDomDriftState {
  const variants: Record<string, ActorDomVariantState> = {}
  for (const oldVariant of Object.values(legacy.variants)) {
    const shape = buildActorDomShape(oldVariant.shape as unknown as ActorDomObservation)
    const signature = actorDomSignature(shape)
    const existing = variants[signature]
    if (!existing) {
      variants[signature] = {
        signature,
        shape,
        firstSeenAt: Number(oldVariant.firstSeenAt) || now,
        lastSeenAt: Number(oldVariant.lastSeenAt) || now,
        count: Math.max(0, Number(oldVariant.count) || 0),
        baseline: Boolean(oldVariant.baseline),
        lastReportedAt: oldVariant.lastReportedAt === null ? null : Number(oldVariant.lastReportedAt) || null,
      }
      continue
    }
    existing.firstSeenAt = Math.min(existing.firstSeenAt, Number(oldVariant.firstSeenAt) || existing.firstSeenAt)
    existing.lastSeenAt = Math.max(existing.lastSeenAt, Number(oldVariant.lastSeenAt) || existing.lastSeenAt)
    existing.count += Math.max(0, Number(oldVariant.count) || 0)
    existing.baseline = existing.baseline || Boolean(oldVariant.baseline)
    const reportedAt = oldVariant.lastReportedAt === null ? null : Number(oldVariant.lastReportedAt) || null
    if (reportedAt !== null) existing.lastReportedAt = Math.max(existing.lastReportedAt ?? 0, reportedAt)
  }

  return {
    version: 2,
    createdAt: Number(legacy.createdAt) || now,
    baselineUntil: Number(legacy.baselineUntil) || now,
    baselineLockedAt: legacy.baselineLockedAt === null ? null : Number(legacy.baselineLockedAt) || now,
    updatedAt: now,
    variants,
  }
}
