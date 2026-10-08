import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Archive → LifeOps 的旁路同步配置。
 *
 * 这份配置只保存在本机 data/*.local.json：
 * - Access Service Token 负责穿过 Cloudflare Access；
 * - ingestToken 是 LifeOps Worker 自己的第二层应用鉴权；
 * - 两层 secret 都不会写入 Archive 日志、daemon state 或 Git。
 */
export interface LifeOpsSyncConfig {
  enabled: boolean
  baseUrl: string
  accessClientId: string
  accessClientSecret: string
  ingestToken: string
}

/**
 * Archive → LifeOps 的最小事件/引用 payload。
 *
 * - 正常 canonical Turn：通常同时带 conversationId + turnExchangeId + title；
 * - Watchdog/cooldown 等早期 Incident：允许一开始只有稳定 sourceEventId + metadataId，
 *   后续同 sourceEventId 再次 enqueue 时原地覆盖 outbox payload，由 LifeOps reconciler 补齐身份；
 * - Worksite 粒度在 LifeOps 侧按 Conversation 合并，而 Turn 粒度由 InboxEvent 保留。
 */
export interface LifeOpsWorksitePayload {
  /** Archive 自己生成的稳定事件身份；有值时优先作为 outbox 去重键。 */
  sourceEventId?: string
  conversationId?: string | null
  turnExchangeId?: string | null
  metadataId?: string | null
  title?: string | null
  summary?: string | null
  runState?: 'running' | 'completed' | 'aborted' | 'superseded' | 'archived'
  reviewState?: 'unread' | 'partial' | 'reviewed' | 'needs_followup'
  url?: string | null
  updatedAt?: string
  inboxKind?: 'turn' | 'incident' | 'manual' | 'email' | 'wechat' | 'other'
  inboxHealth?: 'healthy' | 'incident' | 'unknown'
  finalState?: string | null
  incidentType?: string | null
  incidentState?: string | null
  metadata?: Record<string, unknown>
}

interface PendingJob {
  key: string
  payload: LifeOpsWorksitePayload
  attempts: number
  nextAttemptAt: number
  lastError: string | null
}

interface PendingFile {
  version: 1
  jobs: PendingJob[]
}

export interface LifeOpsSyncClientOptions {
  fetchImpl?: typeof fetch
  pendingPath: string
  log?: (message: string, extra?: Record<string, unknown>) => void | Promise<void>
  now?: () => number
}

/** 文件不存在表示“尚未配置”，不会影响 Archive 核心启动。 */
export async function loadLifeOpsSyncConfig(filePath: string): Promise<LifeOpsSyncConfig | null> {
  let text: string
  try {
    text = await fs.readFile(filePath, 'utf8')
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }

  const raw = JSON.parse(text) as Partial<LifeOpsSyncConfig>
  if (raw.enabled === false) return null
  for (const key of ['baseUrl', 'accessClientId', 'accessClientSecret', 'ingestToken'] as const) {
    if (typeof raw[key] !== 'string' || !raw[key]!.trim()) {
      throw new Error(`LifeOps sync config missing ${key}`)
    }
  }
  return {
    enabled: true,
    baseUrl: raw.baseUrl!.trim().replace(/\/+$/u, ''),
    accessClientId: raw.accessClientId!.trim(),
    accessClientSecret: raw.accessClientSecret!.trim(),
    ingestToken: raw.ingestToken!.trim(),
  }
}

/**
 * 一个极小的持久 outbox。
 *
 * Archive 主链只调用 enqueue()，绝不 await 网络请求。客户端自己顺序 POST、失败指数退避，
 * 并把待发送 payload 写入 data/ 下的 ignored JSON 文件；因此 daemon 崩溃/重启后仍会继续补送。
 */
export class LifeOpsSyncClient {
  private readonly config: LifeOpsSyncConfig
  private readonly options: LifeOpsSyncClientOptions
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly jobs = new Map<string, PendingJob>()
  private timer: NodeJS.Timeout | null = null
  private pumping = false
  private stopped = false
  private persistChain: Promise<void> = Promise.resolve()

  constructor(config: LifeOpsSyncConfig, options: LifeOpsSyncClientOptions) {
    // Archive daemon 直接由 Node 24 运行 .ts 源码，依赖的是原生 strip-only TypeScript loader。
    // 因此这里不能使用需要转译语义的 parameter property；字段显式声明后只剩可擦除类型语法。
    this.config = config
    this.options = options
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? Date.now
  }

  async start(): Promise<void> {
    await this.loadPending()
    this.schedule(0)
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    await this.persist()
  }

  enqueue(payload: LifeOpsWorksitePayload): void {
    const sourceEventId = payload.sourceEventId?.trim()
    const conversationId = payload.conversationId?.trim()
    // 正常历史配置没有 sourceEventId，所以保留 conversation+turn 的兼容派生键；
    // metadata-only incident 则必须由调用方提供 sourceEventId，不能凭易变标题猜身份。
    const key = sourceEventId
      || (conversationId ? `${conversationId}:${payload.turnExchangeId || 'conversation'}` : '')
    if (!key) return
    const previous = this.jobs.get(key)
    this.jobs.set(key, {
      key,
      payload,
      attempts: previous?.attempts ?? 0,
      nextAttemptAt: this.now(),
      lastError: previous?.lastError ?? null,
    })
    void this.persist()
    this.schedule(0)
  }

  get pendingCount(): number {
    return this.jobs.size
  }

  private async log(message: string, extra: Record<string, unknown> = {}): Promise<void> {
    await this.options.log?.(message, extra)
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.pump()
    }, Math.max(0, delayMs))
    this.timer.unref?.()
  }

  private async pump(): Promise<void> {
    if (this.stopped || this.pumping) return
    this.pumping = true
    try {
      while (!this.stopped) {
        const now = this.now()
        const next = [...this.jobs.values()].sort((a, b) => a.nextAttemptAt - b.nextAttemptAt)[0]
        if (!next) break
        if (next.nextAttemptAt > now) {
          this.schedule(next.nextAttemptAt - now)
          break
        }

        const result = await this.send(next.payload)
        if (result.ok) {
          this.jobs.delete(next.key)
          await this.persist()
          await this.log('LifeOps sync delivered', {
            sourceEventId: next.payload.sourceEventId ?? null,
            conversationId: next.payload.conversationId ?? null,
            turnExchangeId: next.payload.turnExchangeId ?? null,
            attempts: next.attempts + 1,
          })
          continue
        }

        next.attempts += 1
        next.lastError = result.error
        // 5s → 15s → 45s → 135s，之后最多每 15 分钟再试一次。
        const backoff = Math.min(15 * 60_000, 5_000 * (3 ** Math.min(next.attempts - 1, 6)))
        next.nextAttemptAt = now + backoff
        this.jobs.set(next.key, next)
        await this.persist()
        await this.log('LifeOps sync deferred', {
          sourceEventId: next.payload.sourceEventId ?? null,
          conversationId: next.payload.conversationId ?? null,
          turnExchangeId: next.payload.turnExchangeId ?? null,
          attempts: next.attempts,
          retryInMs: backoff,
          error: result.error,
        })
        this.schedule(backoff)
        break
      }
    }
    finally {
      this.pumping = false
    }
  }

  private async send(payload: LifeOpsWorksitePayload): Promise<{ ok: boolean, error: string | null }> {
    try {
      const response = await this.fetchImpl(`${this.config.baseUrl}/api/archive/ingest`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cf-access-client-id': this.config.accessClientId,
          'cf-access-client-secret': this.config.accessClientSecret,
          'x-lifeops-ingest-token': this.config.ingestToken,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      })
      if (response.ok) return { ok: true, error: null }
      return { ok: false, error: `HTTP ${response.status}` }
    }
    catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private async loadPending(): Promise<void> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.options.pendingPath, 'utf8')) as Partial<PendingFile>
      if (parsed.version !== 1 || !Array.isArray(parsed.jobs)) return
      for (const job of parsed.jobs) {
        if (!job?.key || !job.payload) continue
        if (!job.payload.sourceEventId && !job.payload.conversationId) continue
        this.jobs.set(job.key, job)
      }
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        await this.log('LifeOps pending queue unreadable; starting empty', {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  private persist(): Promise<void> {
    this.persistChain = this.persistChain.then(async () => {
      await this.persistNow()
    })
    return this.persistChain
  }

  private async persistNow(): Promise<void> {
    const body: PendingFile = { version: 1, jobs: [...this.jobs.values()] }
    try {
      await fs.mkdir(path.dirname(this.options.pendingPath), { recursive: true })
      const temp = `${this.options.pendingPath}.tmp`
      await fs.writeFile(temp, `${JSON.stringify(body, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      await fs.rename(temp, this.options.pendingPath)
    }
    catch (error) {
      await this.log('LifeOps pending queue persist failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

