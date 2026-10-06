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

export interface ActorDomShape extends ActorDomObservation {}

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
  version: 1
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
  const controls = (Array.isArray(input.controls) ? input.controls : [])
    .filter(control => ['send', 'stop', 'attachment', 'voice'].includes(String(control?.semantic)))
    .map(control => ({
      semantic: control.semantic,
      tag: normalizedNullable(control.tag)?.toUpperCase() ?? null,
      type: normalizedNullable(control.type)?.toLowerCase() ?? null,
      testId: normalizedNullable(control.testId),
      ariaPresent: Boolean(control.ariaPresent),
      titlePresent: Boolean(control.titlePresent),
    }))
    .sort((a, b) => stableJson(a).localeCompare(stableJson(b)))

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
    version: 1,
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
      state = JSON.parse(await fs.readFile(filePath, 'utf8')) as ActorDomDriftState
      if (state?.version !== 1 || !state.variants || typeof state.variants !== 'object') {
        throw new Error('unsupported Actor DOM drift ledger format')
      }
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
    const baseline = this.state.baselineLockedAt === null
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
    variant.lastSeenAt = observedAt
    variant.count += 1
    this.state.updatedAt = observedAt
    return {
      signature,
      isNew,
      baseline: variant.baseline,
      pending: isNew && !variant.baseline,
      shape,
    }
  }

  pendingChanges(options: { unreportedOnly?: boolean } = {}): ActorDomPendingChange[] {
    const unreportedOnly = options.unreportedOnly ?? true
    return Object.values(this.state.variants)
      .filter(variant => !variant.baseline && (!unreportedOnly || variant.lastReportedAt === null))
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
