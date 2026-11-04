import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Archive Actor 的持久化提交队列。
 *
 * 上层（例如 ClassFlow）只负责提交一个带 idempotencyKey 的业务意图；真正何时进入
 * ChatGPT、429 要等多久、Guardian/CDP 暂时不可用时如何恢复，都由这一层负责。
 *
 * 这里故意只保存 Bridge 已经净化后的结果，不保存 Cookie、Authorization、SSE token、
 * CDP request body 等任何 ChatGPT 私有凭据。
 */

export interface ActorSubmissionInput {
  text: string
  conversationId: string | null
  projectName: string | null
  mode: 'auto' | 'new' | 'continue' | 'steer'
  targetMode: 'guardian' | 'dedicated'
}

export type ActorSubmissionStatus =
  | 'queued'
  | 'processing'
  | 'retry_waiting'
  | 'accepted'
  | 'failed'

/**
 * 提交接管状态（status）与模型最终产出（completion）彼此独立：
 * accepted 仅表示 POST 已被 ChatGPT 接收，消费者必须等待 completion=completed。
 */
export interface ActorSubmissionCompletion {
  status: 'pending' | 'completed' | 'failed'
  completedAt?: number
  conversationId?: string
  turnExchangeId?: string
  messageId?: string | null
  modelSlug?: string | null
  text?: string
  error?: string
  errorCode?: string
  errorReason?: string | null
}

/** 通过 ChatGPT 原始 SSE 确认的错误；没有原始正文、cookie 或流恢复凭据。 */
export interface ActorSubmissionServerError {
  conversationId: string
  turnExchangeId: string | null
  code: string
  reason: string | null
  message: string
  at: number
}

export interface ActorSubmissionRecord {
  id: string
  idempotencyKey: string
  requestHash: string
  input: ActorSubmissionInput
  status: ActorSubmissionStatus
  attemptCount: number
  createdAt: number
  updatedAt: number
  nextAttemptAt: number | null
  lastError: string | null
  result: Record<string, unknown> | null
  completion?: ActorSubmissionCompletion
}

interface ActorSubmissionQueueState {
  version: 1
  globalNotBefore: number | null
  records: ActorSubmissionRecord[]
  /** SSE 错误可能早于 accepted 回调，因此先持久化，随后与任务精确配对。 */
  serverErrors?: ActorSubmissionServerError[]
}

export class ActorSubmissionConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ActorSubmissionConflictError'
  }
}

export interface ActorSubmissionQueueOptions {
  filePath: string
  submitTurn: (input: ActorSubmissionInput) => Promise<Record<string, unknown>>
  /** Disable automatic retry and restart-time resurrection of failed submissions. */
  autoRetry?: boolean
  /** 包括第一次执行，超过后永久失败，不允许变成无限重试。 */
  maxAttempts?: number
  /** 同一任务的最长故障恢复时间（毫秒）。 */
  maxRetryAgeMs?: number
  confirmTurn?: (input: ActorSubmissionInput) => Promise<Record<string, unknown> | null>
  /** 生产者本地读取 canonical 数据；外部调用方无法触碰原始消息结构。 */
  resolveCompletion?: (record: ActorSubmissionRecord) => ActorSubmissionCompletion | null
  matchServerError?: (record: ActorSubmissionRecord, error: ActorSubmissionServerError) => boolean
  pollIntervalMs?: number
  retryBaseMs?: number
  retryMaxMs?: number
  log?: (message: string, extra?: Record<string, unknown>) => void | Promise<void>
  onAccepted?: (record: ActorSubmissionRecord) => void | Promise<void>
  /**
   * 每次真实提交尝试失败、并且新状态已经可靠写盘后触发。
   *
   * 这个回调只负责“可观测性”，绝不能反过来决定队列状态；因此 drain() 会把回调异常
   * 吃掉并尽量写日志。上层可以据此做 Bark/监控，但通知服务挂掉不能拖死 Actor 队列。
   */
  onAttemptError?: (record: ActorSubmissionRecord) => void | Promise<void>
}

function requestHash(input: ActorSubmissionInput): string {
  return createHash('sha256').update(JSON.stringify({
    text: input.text,
    conversationId: input.conversationId,
    projectName: input.projectName,
    mode: input.mode,
    targetMode: input.targetMode,
  })).digest('hex')
}

function cloneRecord(record: ActorSubmissionRecord): ActorSubmissionRecord {
  return JSON.parse(JSON.stringify(record)) as ActorSubmissionRecord
}

function parseCooldownUntil(message: string): number | null {
  const match = /\buntil\s+([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.+-]+Z?)\b/iu.exec(message)
  const value = match?.[1]
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function isCooldownError(message: string): boolean {
  return /cooldown|HTTP 429/iu.test(message)
}

export function isSubmissionOutcomeUnknownError(message: string): boolean {
  return /submission outcome unknown/iu.test(message)
}

export function isRetryableInfrastructureError(message: string): boolean {
  // 正式 POST 已经观察到、但最终 HTTP 结果未知时绝不能盲目重发；
  // 否则一次 CDP timeout 可能把“其实已经送达”的 turn 重复提交。
  if (isSubmissionOutcomeUnknownError(message)) return false
  return /cooldown|HTTP 429|unavailable|CDP|target.*closed|target.*unavailable|lease timeout|timed out|timeout|fetch failed|ECONN|socket|waiting for full answer|still live|DOM drift|prompt input not found|composer.*not found|project not found or not visible in sidebar|conversation body did not load|conversation context did not finish rendering|composer or project route did not stabilize|healthy ChatGPT shell/iu.test(message)
}

export class ActorSubmissionQueue {
  private readonly options: Required<Pick<
    ActorSubmissionQueueOptions,
    'filePath' | 'submitTurn' | 'pollIntervalMs' | 'retryBaseMs' | 'retryMaxMs'
    | 'autoRetry' | 'maxAttempts' | 'maxRetryAgeMs'
  >> & Pick<ActorSubmissionQueueOptions, 'confirmTurn' | 'resolveCompletion' | 'matchServerError' | 'log' | 'onAccepted' | 'onAttemptError'>

  private readonly recordsByKey = new Map<string, ActorSubmissionRecord>()
  private serverErrors: ActorSubmissionServerError[] = []
  private started = false
  private draining = false
  private timer: NodeJS.Timeout | null = null
  private completionTimer: NodeJS.Timeout | null = null
  /** 规范化结果写盘串行化，避免多个 canonical-update 同时争用状态文件。 */
  private completionTail: Promise<void> = Promise.resolve()
  private globalNotBefore = 0
  /**
   * 同一 submission queue 的持久化必须串行。
   * enqueue、drain、启动修复都可能在同一 Node 进程里几乎同时修改状态；即使每次使用
   * 不同临时文件，Windows 仍可能因为两个 rename 同时覆盖同一个正式 JSON 而返回 EPERM。
   */
  private persistTail: Promise<void> = Promise.resolve()

  constructor(options: ActorSubmissionQueueOptions) {
    this.options = {
      filePath: options.filePath,
      submitTurn: options.submitTurn,
      confirmTurn: options.confirmTurn,
      resolveCompletion: options.resolveCompletion,
      matchServerError: options.matchServerError,
      pollIntervalMs: Math.max(10, options.pollIntervalMs ?? 1000),
      retryBaseMs: Math.max(100, options.retryBaseMs ?? 5000),
      retryMaxMs: Math.max(1000, options.retryMaxMs ?? 60_000),
      autoRetry: options.autoRetry ?? true,
      maxAttempts: Math.max(1, Math.trunc(options.maxAttempts ?? 4)),
      maxRetryAgeMs: Math.max(10_000, options.maxRetryAgeMs ?? 60 * 60_000),
      log: options.log,
      onAccepted: options.onAccepted,
      onAttemptError: options.onAttemptError,
    }
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    await this.load()
    let repaired = false
    for (const record of this.recordsByKey.values()) {
      if (record.status === 'processing') {
        // 进程在发送中崩溃，不知道正式 POST 是否到达。不能把它当作普通失败
        // 无条件重放：先只读核对 canonical，查不到则停止并保存证据等待人工复核。
        let confirmed: Record<string, unknown> | null = null
        if (this.options.confirmTurn) {
          try { confirmed = await this.options.confirmTurn(record.input) }
          catch { /* canonical 读取失败也不代表消息未发送 */ }
        }
        record.status = confirmed ? 'accepted' : 'failed'
        record.result = confirmed ?? record.result
        record.nextAttemptAt = null
        record.updatedAt = Date.now()
        if (!confirmed) {
          record.lastError = 'submission outcome unknown after process restart; canonical review required before replay'
          record.completion = { status: 'failed', error: record.lastError, completedAt: Date.now() }
        }
        repaired = true
        continue
      }
      if (record.status === 'retry_waiting' && (
        !this.options.autoRetry
        || record.attemptCount >= this.options.maxAttempts
        || Date.now() - record.createdAt >= this.options.maxRetryAgeMs
      )) {
        record.status = 'failed'
        record.nextAttemptAt = null
        record.updatedAt = Date.now()
        record.lastError = `Actor retry budget exhausted or disabled; previous error: ${record.lastError ?? 'unknown'}`
        record.completion = { status: 'failed', error: record.lastError, completedAt: Date.now() }
        repaired = true
        continue
      }
      // 历史 failed（包括 operator-canceled）始终是终态：即便开启有限自动重试，
      // 重启时也绝不能复活已经取消的旧 ClassFlow 任务。
    }
    if (repaired) await this.persist()
    this.schedule(0)
    // 只查询本机 canonical 投影，绝不发送新的 ChatGPT 请求。
    // 事件驱动为主，定期恢复用于守护进程重启/丢失事件时的补偿。
    this.completionTimer = setInterval(() => {
      void this.refreshCompletions().catch(error =>
        this.options.log?.('task completion reconciliation failed', {
          error: error instanceof Error ? error.message : String(error),
        }),
      )
    }, 15_000)
    this.completionTimer.unref?.()
    await this.refreshCompletions()
  }

  async stop(): Promise<void> {
    this.started = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.completionTimer) clearInterval(this.completionTimer)
    this.completionTimer = null
    // stop 既是测试清理边界，也是 daemon 重启时的 durability 边界。
    // 不能只停 timer 就返回，否则调用方可能在最后一次 drain/persist 仍进行时关闭进程、
    // 删除目录或替换文件，造成“内存已终态、磁盘还没写完”的窗口。
    while (this.draining) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    await this.persistTail
    await this.completionTail
  }

  async enqueue(idempotencyKey: string, input: ActorSubmissionInput): Promise<ActorSubmissionRecord> {
    const key = idempotencyKey.trim()
    if (!key) throw new Error('idempotencyKey must not be empty')
    if (key.length > 240) throw new Error('idempotencyKey must be at most 240 characters')
    const hash = requestHash(input)
    const existing = this.recordsByKey.get(key)
    if (existing) {
      if (existing.requestHash !== hash) {
        throw new ActorSubmissionConflictError('idempotencyKey already exists with different turn input')
      }
      return cloneRecord(existing)
    }

    const now = Date.now()
    const record: ActorSubmissionRecord = {
      id: randomUUID(),
      idempotencyKey: key,
      requestHash: hash,
      input,
      status: 'queued',
      attemptCount: 0,
      createdAt: now,
      updatedAt: now,
      nextAttemptAt: null,
      lastError: null,
      result: null,
      completion: { status: 'pending' },
    }
    this.recordsByKey.set(key, record)
    await this.persist()
    this.schedule(0)
    return cloneRecord(record)
  }

  get(idempotencyKey: string): ActorSubmissionRecord | null {
    const key = idempotencyKey.trim()
    if (!key) return null
    const record = this.recordsByKey.get(key)
    return record ? cloneRecord(record) : null
  }

  /**
   * 服务端 SSE 错误与 Actor accepted 的先后顺序不稳定：
   * 先记录最少量结构化证据，之后才通过精确 prompt + turn 绑定。
   * 禁止仅凭 CID 将同一会话内的其他用户发送误判为本 Job 失败。
   */
  async observeServerError(error: ActorSubmissionServerError): Promise<void> {
    if (!error.conversationId || !error.code || !Number.isFinite(error.at)) return
    const safe: ActorSubmissionServerError = {
      conversationId: error.conversationId.slice(0, 128),
      turnExchangeId: error.turnExchangeId?.slice(0, 128) ?? null,
      code: error.code.slice(0, 128),
      reason: error.reason?.slice(0, 128) ?? null,
      message: error.message.slice(0, 1000),
      at: error.at,
    }
    if (!this.serverErrors.some(item => item.conversationId === safe.conversationId
      && item.turnExchangeId === safe.turnExchangeId && item.code === safe.code && item.at === safe.at)) {
      this.serverErrors.push(safe)
      this.serverErrors = this.serverErrors.slice(-256)
      await this.persist()
    }
    await this.refreshCompletions(safe.conversationId)
  }

  /**
   * Archive 合并 canonical Body 后调用。只处理本系统持久化的 accepted 任务，
   * 将完成回复保存到队列文件，外部 GET 绝不临时查询 Archive 或 ChatGPT。
   * 旧版无 completion 字段的记录维持兼容，不为全部历史作无谓扫描。
   */
  async refreshCompletions(conversationId?: string): Promise<void> {
    if (!this.options.resolveCompletion && !this.options.matchServerError) return
    const work = this.completionTail.then(async () => {
      for (const record of this.recordsByKey.values()) {
        if (record.status !== 'accepted' || record.completion?.status !== 'pending') continue
        const recordCid = record.result?.conversationId ?? record.input.conversationId
        if (conversationId && recordCid !== conversationId) continue
        let completion: ActorSubmissionCompletion | null
        try {
          const serverError = this.options.matchServerError
            ? this.serverErrors.find(error => error.conversationId === recordCid
              && this.options.matchServerError!(cloneRecord(record), error))
            : null
          completion = serverError ? {
            status: 'failed',
            conversationId: serverError.conversationId,
            turnExchangeId: serverError.turnExchangeId ?? undefined,
            error: serverError.message,
            errorCode: serverError.code,
            errorReason: serverError.reason,
            completedAt: serverError.at,
          } : this.options.resolveCompletion?.(cloneRecord(record)) ?? null
        }
        catch (error) {
          await this.options.log?.('canonical completion read failed', {
            idempotencyKey: record.idempotencyKey,
            error: error instanceof Error ? error.message : String(error),
          })
          continue
        }
        if (!completion || completion.status === 'pending') continue
        record.completion = completion
        record.updatedAt = Date.now()
        await this.persist()
        await this.options.log?.('actor final result persisted', {
          idempotencyKey: record.idempotencyKey,
          completionStatus: completion.status,
        })
      }
    })
    this.completionTail = work.catch(() => {})
    await work
  }

  private schedule(delayMs: number): void {
    if (!this.started) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      // 定时回调的异常不能变成无人接收的 Promise rejection；尤其是 Windows
      // 防病毒软件短暂占用状态文件时，不能因此让整个 Archive daemon 崩溃。
      void this.drain().catch(error => {
        void this.options.log?.('actor submission queue drain failed', {
          error: error instanceof Error ? error.message : String(error),
        })
      })
    }, Math.max(0, delayMs))
    this.timer.unref?.()
  }

  private nextRunnable(now: number): ActorSubmissionRecord | null {
    const candidates = [...this.recordsByKey.values()]
      .filter(record => (
        record.status === 'queued'
        || (record.status === 'retry_waiting' && Number(record.nextAttemptAt || 0) <= now)
      ))
      .sort((left, right) => left.createdAt - right.createdAt)
    return candidates[0] ?? null
  }

  private nextWakeDelay(now: number): number {
    const future = [...this.recordsByKey.values()]
      .filter(record => record.status === 'retry_waiting' && Number(record.nextAttemptAt || 0) > now)
      .map(record => Number(record.nextAttemptAt))
    if (this.globalNotBefore > now) future.push(this.globalNotBefore)
    if (future.length === 0) return this.options.pollIntervalMs
    return Math.max(this.options.pollIntervalMs, Math.min(...future) - now)
  }

  private retryDelay(attemptCount: number): number {
    const exponent = Math.max(0, Math.min(8, attemptCount - 1))
    return Math.min(this.options.retryMaxMs, this.options.retryBaseMs * (2 ** exponent))
  }

  private async drain(): Promise<void> {
    if (!this.started || this.draining) return
    this.draining = true
    try {
      while (this.started) {
        const now = Date.now()
        if (this.globalNotBefore > now) {
          this.schedule(this.globalNotBefore - now)
          return
        }
        const record = this.nextRunnable(now)
        if (!record) {
          this.schedule(this.nextWakeDelay(now))
          return
        }

        // 正式 POST 的结果如果处于 unknown，下一次动作不是立刻重发，而是先从
        // Archive canonical history 精确确认同一条 user prompt 是否已经出现。
        // 这一步不消耗 attemptCount；命中即直接 accepted，避免重复 turn。
        if (
          record.status === 'retry_waiting'
          && record.lastError
          && isSubmissionOutcomeUnknownError(record.lastError)
          && this.options.confirmTurn
        ) {
          try {
            const confirmed = await this.options.confirmTurn(record.input)
            if (confirmed) {
              record.status = 'accepted'
              record.result = confirmed
              record.lastError = null
              record.updatedAt = Date.now()
              record.nextAttemptAt = null
              await this.persist()
              void this.refreshCompletions(record.result?.conversationId as string | undefined)
              await this.options.onAccepted?.(cloneRecord(record))
              await this.options.log?.('actor submission confirmed from canonical history', {
                submissionId: record.id,
                idempotencyKey: record.idempotencyKey,
                attemptCount: record.attemptCount,
              })
              continue
            }
          }
          catch (error) {
            await this.options.log?.('actor submission canonical confirmation failed', {
              submissionId: record.id,
              idempotencyKey: record.idempotencyKey,
              error: error instanceof Error ? error.message : String(error),
            })
          }
        }

        record.status = 'processing'
        record.attemptCount += 1
        record.updatedAt = Date.now()
        record.nextAttemptAt = null
        await this.persist()

        try {
          const result = await this.options.submitTurn(record.input)
          record.status = 'accepted'
          record.result = result
          record.lastError = null
          record.updatedAt = Date.now()
          record.nextAttemptAt = null
          await this.persist()
          void this.refreshCompletions(record.result?.conversationId as string | undefined)
          await this.options.onAccepted?.(cloneRecord(record))
          await this.options.log?.('actor submission accepted', {
            submissionId: record.id,
            idempotencyKey: record.idempotencyKey,
            attemptCount: record.attemptCount,
          })
        }
        catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const outcomeUnknown = isSubmissionOutcomeUnknownError(message)
          const retryable = isRetryableInfrastructureError(message)
          record.lastError = message
          record.updatedAt = Date.now()
          // POST 结果未知不具备安全的重发资格；客户端崩溃/网络中断时先封存，
          // 不能仅因下一次查询 canonical 暂时为空就把消息重发一次。
          const exhausted = record.attemptCount >= this.options.maxAttempts
            || Date.now() - record.createdAt >= this.options.maxRetryAgeMs
          if (outcomeUnknown || !this.options.autoRetry || !retryable || exhausted) {
            record.status = 'failed'
            record.nextAttemptAt = null
            record.completion = { status: 'failed', error: message, completedAt: Date.now() }
          }
          else {
            const explicitUntil = parseCooldownUntil(message)
            const fallback = Date.now() + this.retryDelay(record.attemptCount)
            const nextAttemptAt = explicitUntil !== null
              ? Math.max(Date.now() + this.options.pollIntervalMs, explicitUntil)
              : fallback
            record.status = 'retry_waiting'
            record.nextAttemptAt = nextAttemptAt
            if (isCooldownError(message)) {
              this.globalNotBefore = Math.max(
                this.globalNotBefore,
                explicitUntil ?? (Date.now() + 60_000),
              )
            }
          }
          await this.persist()
          await this.options.log?.('actor submission deferred', {
            submissionId: record.id,
            idempotencyKey: record.idempotencyKey,
            status: record.status,
            attemptCount: record.attemptCount,
            nextAttemptAt: record.nextAttemptAt,
            error: message,
          })
          // 可观测性回调一定放在 persist() 之后：通知里看到的状态必须已经能从磁盘复核。
          // 回调本身失败只影响告警，不允许让已经持久化的 submission 被误认为 drain 失败。
          try {
            await this.options.onAttemptError?.(cloneRecord(record))
          }
          catch (callbackError) {
            try {
              await this.options.log?.('actor submission attempt-error callback failed', {
                submissionId: record.id,
                idempotencyKey: record.idempotencyKey,
                error: callbackError instanceof Error ? callbackError.message : String(callbackError),
              })
            }
            catch {
              // 连日志本身都失败时也必须吞掉：队列终态已经持久化，不能让可观测性分支反向破坏 drain。
            }
          }
        }
      }
    }
    finally {
      this.draining = false
      if (this.started && !this.timer) this.schedule(this.nextWakeDelay(Date.now()))
    }
  }

  private async load(): Promise<void> {
    this.recordsByKey.clear()
    this.serverErrors = []
    try {
      const parsed = JSON.parse(await fs.readFile(this.options.filePath, 'utf8')) as Partial<ActorSubmissionQueueState>
      const records = Array.isArray(parsed.records) ? parsed.records : []
      this.serverErrors = Array.isArray(parsed.serverErrors) ? parsed.serverErrors.slice(-256) : []
      for (const record of records) {
        if (!record || typeof record !== 'object') continue
        if (typeof record.idempotencyKey !== 'string' || typeof record.requestHash !== 'string') continue
        this.recordsByKey.set(record.idempotencyKey, record as ActorSubmissionRecord)
      }
      const restoredNotBefore = Number(parsed.globalNotBefore || 0)
      this.globalNotBefore = Number.isFinite(restoredNotBefore) && restoredNotBefore > Date.now()
        ? restoredNotBefore
        : 0
    }
    catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
      if (code !== 'ENOENT') throw error
      this.globalNotBefore = 0
    }
  }

  private async persistNow(): Promise<void> {
    await fs.mkdir(path.dirname(this.options.filePath), { recursive: true })
    const state: ActorSubmissionQueueState = {
      version: 1,
      globalNotBefore: this.globalNotBefore > Date.now() ? this.globalNotBefore : null,
      records: [...this.recordsByKey.values()].sort((left, right) => left.createdAt - right.createdAt),
      serverErrors: this.serverErrors,
    }
    // 同一进程里 enqueue()/drain()/恢复写盘可能短时间重叠；只用 PID 会让多个 persist
    // 抢同一个临时文件，Windows rename 尤其容易出现 ENOENT。每次写盘使用独立临时名，
    // 最终仍通过原子 rename 覆盖正式状态文件。
    const tempPath = this.options.filePath + '.tmp-' + process.pid + '-' + randomUUID()
    await fs.writeFile(tempPath, JSON.stringify(state, null, 2) + '\n', 'utf8')
    try {
      // 在 Windows 上，已有目标文件可能被 Defender/备份软件短暂打开，
      // 同目录 rename 会偶发 EPERM/EACCES。只重试短暂文件占用；
      // 永不在真正的持久化失败时把内存状态假装成写盘成功。
      for (let attempt = 0; attempt < 6; attempt++) {
        try {
          await fs.rename(tempPath, this.options.filePath)
          return
        }
        catch (error) {
          const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
          if (!['EPERM', 'EACCES', 'EBUSY'].includes(code) || attempt === 5) throw error
          await new Promise(resolve => setTimeout(resolve, 20 * (attempt + 1)))
        }
      }
    }
    finally {
      // 成功时路径已被 rename 移走；失败时移除孤立临时文件。
      await fs.rm(tempPath, { force: true }).catch(() => {})
    }
  }

  private async persist(): Promise<void> {
    const write = this.persistTail.then(() => this.persistNow())
    // 单次写盘失败不能让 Promise 链永久 rejected；调用方仍会收到本次 write 的真实错误。
    this.persistTail = write.catch(() => {})
    await write
  }
}
