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
}

interface ActorSubmissionQueueState {
  version: 1
  globalNotBefore: number | null
  records: ActorSubmissionRecord[]
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
  pollIntervalMs?: number
  retryBaseMs?: number
  retryMaxMs?: number
  log?: (message: string, extra?: Record<string, unknown>) => void | Promise<void>
  onAccepted?: (record: ActorSubmissionRecord) => void | Promise<void>
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
  return /cooldown|HTTP 429|unavailable|CDP|target.*closed|target.*unavailable|lease timeout|timed out|timeout|fetch failed|ECONN|socket|waiting for full answer|still live|DOM drift|prompt input not found|composer.*not found/iu.test(message)
}

export class ActorSubmissionQueue {
  private readonly options: Required<Pick<
    ActorSubmissionQueueOptions,
    'filePath' | 'submitTurn' | 'pollIntervalMs' | 'retryBaseMs' | 'retryMaxMs'
  >> & Pick<ActorSubmissionQueueOptions, 'log' | 'onAccepted'>

  private readonly recordsByKey = new Map<string, ActorSubmissionRecord>()
  private started = false
  private draining = false
  private timer: NodeJS.Timeout | null = null
  private globalNotBefore = 0

  constructor(options: ActorSubmissionQueueOptions) {
    this.options = {
      filePath: options.filePath,
      submitTurn: options.submitTurn,
      pollIntervalMs: Math.max(10, options.pollIntervalMs ?? 1000),
      retryBaseMs: Math.max(100, options.retryBaseMs ?? 5000),
      retryMaxMs: Math.max(1000, options.retryMaxMs ?? 60_000),
      log: options.log,
      onAccepted: options.onAccepted,
    }
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    await this.load()
    let repaired = false
    for (const record of this.recordsByKey.values()) {
      if (record.status === 'processing') {
        record.status = 'queued'
        record.nextAttemptAt = null
        record.updatedAt = Date.now()
        repaired = true
        continue
      }
      // 软件升级后若某类错误从“永久失败”被重新判定为基础设施瞬态错误，
      // 旧 failed 记录也要自动回到重试队列；否则同一 idempotencyKey 会永远卡死。
      if (record.status === 'failed'
        && record.lastError
        && isRetryableInfrastructureError(record.lastError)) {
        record.status = 'retry_waiting'
        record.nextAttemptAt = Date.now()
        record.updatedAt = Date.now()
        repaired = true
      }
    }
    if (repaired) await this.persist()
    this.schedule(0)
  }

  async stop(): Promise<void> {
    this.started = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
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

  private schedule(delayMs: number): void {
    if (!this.started) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.drain()
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
          await this.options.onAccepted?.(cloneRecord(record))
          await this.options.log?.('actor submission accepted', {
            submissionId: record.id,
            idempotencyKey: record.idempotencyKey,
            attemptCount: record.attemptCount,
          })
        }
        catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const retryable = isRetryableInfrastructureError(message)
          record.lastError = message
          record.updatedAt = Date.now()
          if (!retryable) {
            record.status = 'failed'
            record.nextAttemptAt = null
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
    try {
      const parsed = JSON.parse(await fs.readFile(this.options.filePath, 'utf8')) as Partial<ActorSubmissionQueueState>
      const records = Array.isArray(parsed.records) ? parsed.records : []
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

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(this.options.filePath), { recursive: true })
    const state: ActorSubmissionQueueState = {
      version: 1,
      globalNotBefore: this.globalNotBefore > Date.now() ? this.globalNotBefore : null,
      records: [...this.recordsByKey.values()].sort((left, right) => left.createdAt - right.createdAt),
    }
    const tempPath = this.options.filePath + '.tmp-' + process.pid
    await fs.writeFile(tempPath, JSON.stringify(state, null, 2) + '\n', 'utf8')
    await fs.rename(tempPath, this.options.filePath)
  }
}
