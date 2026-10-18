import { randomBytes, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import path from 'node:path'
import {
  ActorSubmissionConflictError,
  ActorSubmissionQueue,
  type ActorSubmissionRecord,
} from './actor-submission-queue.ts'

/**
 * Phase 5 本地 Bridge 只暴露 Archive 自己的、安全收缩后的数据面。
 *
 * 这里刻意不复用 ChatGPT Cookie / Authorization，也绝不把原始 `/f/conversation` SSE
 * 直接透传给客户端。原因是原始流里可能出现 resume credential、handoff topic 等内部能力；
 * 手机端真正需要的是 canonical history + Actor 控制 + 脱敏生命周期，而不是 ChatGPT 私有凭据。
 */

export interface ArchiveBridgeConversationRow {
  id: string
  title: string
  sourceFormat: string
  currentNode: string | null
  capturedAt: number
  importedAt: number
  messageCount: number
  resourceCount: number
  terminalState?: string | null
  incidentState?: string | null
  lastFinishType?: string | null
  lastFinishReason?: string | null
  lastReasoningStatus?: string | null
  provisional?: boolean
  metadataId?: string | null
  provisionalState?: 'running' | 'idle'
}

export interface ArchiveBridgeDataSource {
  list(limit?: number): ArchiveBridgeConversationRow[]
  listDevSpaceRecoveryVirtualConversations?(limit?: number): ArchiveBridgeConversationRow[]
  getMessages(conversationId: string): Array<Record<string, unknown>>
  getMessagesPage?(conversationId: string, options?: {
    limit?: number
    beforeOrdinal?: number | null
  }): {
    messages: Array<Record<string, unknown>>
    canonicalCount: number
    visibleCount: number
    eligibleVisibleCount: number
    hasMore: boolean
    nextBeforeOrdinal: number | null
  }
  getDevSpaceRecoveryMessages?(conversationId: string): Array<Record<string, unknown>>
  getResources?(conversationId: string): Array<Record<string, unknown>>
  searchConversations?(query: string, options?: { limit?: number, snippetsPerConversation?: number, sort?: 'relevance' | 'recent' | 'frequency' }): Array<Record<string, unknown>>
  searchMessages?(query: string, limit?: number): Array<Record<string, unknown>>
  listIncidents?(options?: { status?: 'open' | 'resolved', limit?: number }): Array<Record<string, unknown>>
  listActiveWatchdogs?(limit?: number): Array<Record<string, unknown>>
}

export type ArchiveBridgeActorMode = 'auto' | 'new' | 'continue' | 'steer'
export type ArchiveBridgeActorTarget = 'guardian' | 'dedicated'

export interface ArchiveBridgeTurnInput {
  text: string
  conversationId: string | null
  projectName: string | null
  mode: ArchiveBridgeActorMode
  targetMode: ArchiveBridgeActorTarget
  idempotencyKey?: string | null
}

/**
 * 在 canonical Archive 中精确确认一条 user prompt 是否已经真实出现。
 *
 * 这是“正式 POST 已发出但本地没拿到 HTTP 闭环”时的恢复证据：
 * - continue/steer：只检查指定 conversation，避免串会话；
 * - new：只扫最近的 canonical conversations，并要求 user message 文本全量精确相等。
 *
 * 不做模糊搜索，也不靠标题猜测，因此不会把相似课堂/标题请求误认成同一次提交。
 */
export function confirmCanonicalExactPrompt(
  archive: ArchiveBridgeDataSource,
  input: ArchiveBridgeTurnInput,
  recentConversationLimit = 100,
): Record<string, unknown> | null {
  const conversationIds = input.conversationId
    ? [input.conversationId]
    : archive.list(Math.max(1, recentConversationLimit)).map(row => row.id)

  for (const conversationId of conversationIds) {
    const messages = archive.getMessages(conversationId)
    const matched = messages.some(message => (
      String(message.role || '') === 'user'
      && typeof message.text === 'string'
      && message.text === input.text
    ))
    if (!matched) continue
    return {
      conversationId,
      confirmedBy: 'canonical-exact-prompt',
    }
  }
  return null
}

export interface ArchiveBridgeEvent {
  version: 1
  at: number
  kind: 'bridge-ready' | 'actor-accepted' | 'live-transport' | 'wss-lifecycle' | 'canonical-update'
  conversationId?: string | null
  turnExchangeId?: string | null
  requestId?: string | null
  event?: string | null
  transport?: string | null
  terminalEvidence?: string | null
  tailShape?: string | null
}

export interface ArchiveBridgeOptions {
  archive: ArchiveBridgeDataSource
  authToken: string
  submitTurn: (input: ArchiveBridgeTurnInput) => Promise<Record<string, unknown>>
  host?: string
  port?: number
  maxBodyBytes?: number
  submissionQueuePath?: string | null
  submissionQueuePollIntervalMs?: number
  /** 把持久化 submission queue 的状态日志汇入 daemon 主日志。 */
  submissionQueueLog?: (message: string, extra?: Record<string, unknown>) => void | Promise<void>
  /** submission 每次尝试失败后的只读通知钩子；不得改变队列状态。 */
  onSubmissionAttemptError?: (record: ActorSubmissionRecord) => void | Promise<void>
}

export interface ArchiveBridgeAuthState {
  version: 1
  token: string
  createdAt: number
}

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 47_832
const DEFAULT_MAX_BODY_BYTES = 256 * 1024

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(encoded),
  })
  res.end(encoded)
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

function bearerToken(req: IncomingMessage): string | null {
  const header = typeof req.headers.authorization === 'string' ? req.headers.authorization.trim() : ''
  const match = /^Bearer\s+(.+)$/iu.exec(header)
  return match?.[1]?.trim() || null
}

function isAuthorized(req: IncomingMessage, expected: string): boolean {
  const supplied = bearerToken(req)
  return Boolean(supplied && safeEqual(supplied, expected))
}

function parseLimit(value: string | null, fallback = 50): number {
  if (value === null || value.trim() === '') return fallback
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.max(1, Math.min(200, Math.trunc(numeric)))
}

/**
 * Reader 使用 ordinal 做稳定游标，而不是 offset。
 * Archive 的 ordinal 在单个 conversation 内单调递增；用 before_ordinal 翻历史页时，
 * 即使后台继续追加新消息，已经浏览过的页面也不会整体错位。
 */
function parseBeforeOrdinal(value: string | null): number | null {
  if (value === null || value.trim() === '') return null
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return null
  return Math.trunc(numeric)
}

function paginateOrdinalRows<T extends Record<string, unknown>>(
  rows: T[],
  limit: number,
  beforeOrdinal: number | null,
): { rows: T[]; total: number; hasMore: boolean; nextBeforeOrdinal: number | null } {
  const eligible = beforeOrdinal === null
    ? rows
    : rows.filter((row) => Number.isFinite(Number(row.ordinal)) && Number(row.ordinal) < beforeOrdinal)
  const page = eligible.slice(-limit)
  const firstOrdinal = page.length > 0 && Number.isFinite(Number(page[0]!.ordinal))
    ? Number(page[0]!.ordinal)
    : null
  return {
    rows: page,
    total: rows.length,
    hasMore: eligible.length > page.length,
    nextBeforeOrdinal: firstOrdinal,
  }
}

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > maxBytes) throw new Error('request body too large')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }
  catch {
    throw new Error('request body must be valid JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('request body must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

function sanitizeMessages(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return rows
    .filter(row => Number(row.hidden ?? 0) === 0)
    .map(row => {
      const channel = typeof row.channel === 'string' ? row.channel : null
      const contentType = typeof row.contentType === 'string' ? row.contentType : null
      const role = typeof row.role === 'string' ? row.role : 'unknown'
      const recipient = typeof row.recipient === 'string' ? row.recipient : null
      // Reader 保留完整 canonical 节点序列：tool call/result、API、system/developer
      // 等节点都不能因为性能优化而消失。唯一继续收缩的是模型内部 reasoning 正文；
      // reasoning 节点本身仍返回，便于还原 turn 生命周期与节点顺序。
      const reasoningRedacted = channel === 'analysis' || Boolean(contentType && /reasoning/iu.test(contentType))
      const contentRedacted = reasoningRedacted
      return {
        messageId: typeof row.messageId === 'string' ? row.messageId : null,
        ordinal: Number.isFinite(Number(row.ordinal)) ? Number(row.ordinal) : null,
        role,
        authorName: typeof row.authorName === 'string' ? row.authorName : null,
        recipient,
        channel,
        contentType,
        text: contentRedacted ? '' : typeof row.text === 'string' ? row.text : '',
        reasoningRedacted,
        contentRedacted,
        createTime: typeof row.createTime === 'number' ? row.createTime : null,
        status: typeof row.status === 'string' ? row.status : null,
        endTurn: row.endTurn === 1 || row.endTurn === true,
        requestId: typeof row.requestId === 'string' ? row.requestId : null,
        turnExchangeId: typeof row.turnExchangeId === 'string' ? row.turnExchangeId : null,
        finishType: typeof row.finishType === 'string' ? row.finishType : null,
        finishReason: typeof row.finishReason === 'string' ? row.finishReason : null,
        reasoningStatus: typeof row.reasoningStatus === 'string' ? row.reasoningStatus : null,
        modelSlug: typeof row.resolvedModelSlug === 'string'
          ? row.resolvedModelSlug
          : typeof row.modelSlug === 'string'
            ? row.modelSlug
            : null,
        provisional: row.provisional === true,
        recoverySource: typeof row.recoverySource === 'string' ? row.recoverySource : null,
        recoveryKind: typeof row.recoveryKind === 'string' ? row.recoveryKind : null,
        auditId: typeof row.auditId === 'string' ? row.auditId : null,
        metadataId: typeof row.metadataId === 'string' ? row.metadataId : null,
        tool: typeof row.tool === 'string' ? row.tool : null,
        superseded: row.superseded === true,
      }
    })
}

function conversationLifecycle(
  conversationId: string,
  archive: ArchiveBridgeDataSource,
  turnExchangeId?: string | null,
): {
  state: 'running' | 'aborted' | 'completed' | 'idle'
  active: Record<string, unknown> | null
  incident: Record<string, unknown> | null
} {
  const active = archive.listActiveWatchdogs?.(1000)
    .find(row => row.conversationId === conversationId) ?? null
  const incident = archive.listIncidents?.({ status: 'open', limit: 1000 })
    .find(row =>
      row.conversationId === conversationId &&
      (!turnExchangeId || row.turnExchangeId === turnExchangeId),
    ) ?? null
  if (incident) return { state: 'aborted', active, incident }
  if (active) return { state: 'running', active, incident }
  const conversation = archive.list(1000).find(row => row.id === conversationId)
  if (conversation?.terminalState || conversation?.lastFinishType) {
    return { state: 'completed', active, incident }
  }
  return { state: 'idle', active, incident }
}

function isoFromArchiveTime(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return new Date().toISOString()
  const milliseconds = value < 10_000_000_000 ? value * 1000 : value
  return new Date(milliseconds).toISOString()
}

/**
 * 把 Archive canonical 数据收缩成 LifeOps 可以安全持久化的一份 Worksite。
 *
 * 这里**刻意不读取 messages**。Worksite 对 LifeOps 的职责只是“引用这条 Conversation，并告诉
 * Inbox 这一个 Turn 当前是什么生命周期状态”，不是替 Work Item 生成摘要。过去为了 summary 扫整段
 * conversation，会让一个几千条消息的大聊天在核心同步链上产生完全没必要的成本；V0.5 把摘要职责
 * 交回 Work Item 自己的 currentState，历史正文只在用户显式打开 Archive Reader 时分页读取。
 *
 * 这是 Bridge `/v1/worksites/resolve` 与 daemon 主动推送 LifeOps 共用的唯一元数据构造器。
 */
export function buildArchiveBridgeWorksite(
  archive: ArchiveBridgeDataSource,
  conversationId: string,
  turnExchangeId?: string | null,
): Record<string, unknown> | null {
  const conversation = archive.list(1000).find(row => row.id === conversationId)
  if (!conversation) return null

  const lifecycle = conversationLifecycle(conversationId, archive, turnExchangeId)
  const runState = lifecycle.state === 'aborted'
    ? 'aborted'
    : lifecycle.state === 'running'
      ? 'running'
      : 'completed'

  return {
    sourceEventId: `turn:${conversationId}:${turnExchangeId || conversation.currentNode || conversation.capturedAt}`,
    conversationId,
    turnExchangeId: turnExchangeId ?? null,
    title: conversation.title || `ChatGPT · ${conversationId}`,
    runState,
    reviewState: 'unread',
    inboxKind: lifecycle.state === 'aborted' ? 'incident' : 'turn',
    inboxHealth: lifecycle.state === 'aborted' ? 'incident' : 'healthy',
    finalState: conversation.lastFinishType ?? conversation.terminalState ?? null,
    incidentType: lifecycle.incident && typeof lifecycle.incident.lifecycleClass === 'string'
      ? lifecycle.incident.lifecycleClass
      : null,
    incidentState: lifecycle.state === 'aborted' ? 'open' : null,
    url: `https://chatgpt.com/c/${conversationId}`,
    updatedAt: isoFromArchiveTime(conversation.capturedAt || conversation.importedAt),
    metadata: {
      sourceFormat: conversation.sourceFormat,
      currentNode: conversation.currentNode,
      messageCount: conversation.messageCount,
      resourceCount: conversation.resourceCount,
      terminalState: conversation.terminalState ?? null,
      incidentState: conversation.incidentState ?? null,
      lastFinishType: conversation.lastFinishType ?? null,
      lastFinishReason: conversation.lastFinishReason ?? null,
      lifecycleState: lifecycle.state,
      openIncident: lifecycle.incident,
    },
  }
}

function validateTurnInput(body: Record<string, unknown>): ArchiveBridgeTurnInput {
  const text = typeof body.text === 'string' ? body.text.trim() : ''
  if (!text) throw new Error('text must not be empty')

  const conversationId = body.conversationId === null || body.conversationId === undefined
    ? null
    : typeof body.conversationId === 'string' && body.conversationId.trim()
      ? body.conversationId.trim()
      : null
  const mode = typeof body.mode === 'string' ? body.mode : 'auto'
  if (!['auto', 'new', 'continue', 'steer'].includes(mode)) {
    throw new Error('mode must be auto|new|continue|steer')
  }
  const targetMode = typeof body.targetMode === 'string' ? body.targetMode : 'guardian'
  if (!['guardian', 'dedicated'].includes(targetMode)) {
    throw new Error('targetMode must be guardian|dedicated')
  }
  if (mode === 'new' && conversationId) throw new Error('mode=new cannot include conversationId')
  if ((mode === 'continue' || mode === 'steer') && !conversationId) {
    throw new Error(`mode=${mode} requires conversationId`)
  }
  const projectName = body.projectName === null || body.projectName === undefined
    ? null
    : typeof body.projectName === 'string' && body.projectName.trim()
      ? body.projectName.trim()
      : null
  if (body.projectName !== null && body.projectName !== undefined && !projectName) {
    throw new Error('projectName must be a non-empty string')
  }
  if (projectName && conversationId) throw new Error('projectName must not include conversationId')
  if (projectName && mode !== 'new' && mode !== 'auto') {
    throw new Error('projectName requires mode=new|auto')
  }
  const idempotencyKey = body.idempotencyKey === null || body.idempotencyKey === undefined
    ? null
    : typeof body.idempotencyKey === 'string' && body.idempotencyKey.trim()
      ? body.idempotencyKey.trim()
      : null
  if (body.idempotencyKey !== null && body.idempotencyKey !== undefined && !idempotencyKey) {
    throw new Error('idempotencyKey must be a non-empty string')
  }
  return {
    text,
    conversationId,
    projectName,
    mode: mode as ArchiveBridgeActorMode,
    targetMode: targetMode as ArchiveBridgeActorTarget,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  }
}

function actorErrorStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error)
  if (/cooldown|HTTP 429/iu.test(message)) return 429
  if (/DOM drift|lease timeout|waiting for full answer|still live|not live-attached/iu.test(message)) return 409
  if (/unavailable|CDP connect|target.*closed/iu.test(message)) return 503
  if (/invalid|requires|must|empty/iu.test(message)) return 400
  return 500
}

/**
 * Actor 的完整返回值属于本机取证面，其中包含 targetId、CDP requestId、DOM signature、
 * navigationMode 等实现细节。Family-AI 只需要知道“哪条 conversation、以什么发送语义、
 * 何时提交/绑定、是否确认进入 running”。因此 Bridge 对外再收缩一层，避免把内部调试面
 * 无意固化成远端产品 API。
 */
export function sanitizeArchiveBridgeTurnResult(
  input: ArchiveBridgeTurnInput,
  result: Record<string, unknown>,
): Record<string, unknown> {
  const conversationId = typeof result.conversationId === 'string' && result.conversationId
    ? result.conversationId
    : input.conversationId
  const resultMode = typeof result.mode === 'string' && ['new', 'continue', 'steer'].includes(result.mode)
    ? result.mode
    : input.mode
  const submittedAt = Number(result.submittedAt)
  const boundAt = Number(result.boundAt)
  return {
    conversationId,
    mode: resultMode,
    submittedAt: Number.isFinite(submittedAt) && submittedAt > 0 ? submittedAt : null,
    boundAt: Number.isFinite(boundAt) && boundAt > 0 ? boundAt : null,
    runningConfirmed: result.runningConfirmed === true,
  }
}

/**
 * submission queue 的内部记录包含 requestHash 和完整 prompt，用于幂等校验与重启恢复。
 * 这些内容没有必要在 Bridge 响应里来回传输；ClassFlow 只需要状态与最终净化结果。
 */
function sanitizeActorSubmissionRecord(record: ActorSubmissionRecord): Record<string, unknown> {
  return {
    id: record.id,
    idempotencyKey: record.idempotencyKey,
    status: record.status,
    attemptCount: record.attemptCount,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    nextAttemptAt: record.nextAttemptAt,
    lastError: record.lastError,
    result: record.result,
  }
}

/**
 * Bridge token 独立于 ChatGPT 登录态。首次启动自动生成 256-bit 随机 token 并写入 data/*.local.json；
 * 后续 daemon 重启原样复用。调用方只能拿到 token 字符串用于内存校验，daemon state / log 不记录它。
 */
export async function ensureArchiveBridgeAuthToken(filePath: string): Promise<string> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as Partial<ArchiveBridgeAuthState>
    if (parsed.version === 1 && typeof parsed.token === 'string' && parsed.token.length >= 32) return parsed.token
  }
  catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
    if (code !== 'ENOENT') throw error
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const state: ArchiveBridgeAuthState = {
    version: 1,
    token: randomBytes(32).toString('base64url'),
    createdAt: Date.now(),
  }
  await fs.writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  return state.token
}

export class ArchiveBridgeServer {
  readonly host: string
  readonly configuredPort: number

  private readonly options: Required<Pick<ArchiveBridgeOptions, 'archive' | 'authToken' | 'submitTurn' | 'maxBodyBytes'>>
  private readonly sseClients = new Set<ServerResponse>()
  private readonly submissionQueue: ActorSubmissionQueue | null
  private server: Server | null = null
  private heartbeat: NodeJS.Timeout | null = null

  constructor(options: ArchiveBridgeOptions) {
    if (!options.authToken || options.authToken.length < 32) {
      throw new Error('Archive Bridge auth token must be at least 32 characters')
    }
    this.host = options.host ?? DEFAULT_HOST
    this.configuredPort = options.port ?? DEFAULT_PORT
    this.options = {
      archive: options.archive,
      authToken: options.authToken,
      submitTurn: options.submitTurn,
      maxBodyBytes: options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    }
    this.submissionQueue = options.submissionQueuePath
      ? new ActorSubmissionQueue({
          filePath: options.submissionQueuePath,
          pollIntervalMs: options.submissionQueuePollIntervalMs,
          submitTurn: async input => sanitizeArchiveBridgeTurnResult(
            input as ArchiveBridgeTurnInput,
            await this.options.submitTurn({
              ...input,
              idempotencyKey: null,
            }),
          ),
          confirmTurn: async input => confirmCanonicalExactPrompt(
            this.options.archive,
            input as ArchiveBridgeTurnInput,
          ),
          log: options.submissionQueueLog,
          onAccepted: async record => this.publishAcceptedSubmission(record),
          onAttemptError: options.onSubmissionAttemptError,
        })
      : null
  }

  get listening(): boolean {
    return Boolean(this.server?.listening)
  }

  get clientCount(): number {
    return this.sseClients.size
  }

  get port(): number | null {
    const address = this.server?.address()
    return address && typeof address === 'object' ? address.port : null
  }

  async start(): Promise<void> {
    if (this.server) return
    await this.submissionQueue?.start()
    const server = createServer((req, res) => {
      void this.handle(req, res).catch((error) => {
        if (res.headersSent) {
          res.destroy(error instanceof Error ? error : new Error(String(error)))
          return
        }
        jsonResponse(res, 500, { error: 'internal_error' })
      })
    })
    this.server = server
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        server.off('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(this.configuredPort, this.host)
    })

    this.heartbeat = setInterval(() => {
      for (const client of this.sseClients) {
        if (client.destroyed || client.writableEnded) this.sseClients.delete(client)
        else client.write(`: ping ${Date.now()}\n\n`)
      }
    }, 15_000)
    this.heartbeat.unref?.()
  }

  publish(event: ArchiveBridgeEvent): void {
    const payload = `event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`
    for (const client of this.sseClients) {
      if (client.destroyed || client.writableEnded) this.sseClients.delete(client)
      else client.write(payload)
    }
  }

  async stop(): Promise<void> {
    await this.submissionQueue?.stop()
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    for (const client of this.sseClients) client.end()
    this.sseClients.clear()
    const server = this.server
    this.server = null
    if (!server) return
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
    })
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = String(req.method || 'GET').toUpperCase()
    const url = new URL(req.url || '/', `http://${this.host}`)

    if (url.pathname === '/health' && method === 'GET') {
      jsonResponse(res, 200, {
        ok: true,
        service: 'chatgpt-archive-bridge',
        version: 1,
      })
      return
    }

    if (!isAuthorized(req, this.options.authToken)) {
      res.setHeader('www-authenticate', 'Bearer')
      jsonResponse(res, 401, { error: 'unauthorized' })
      return
    }

    if (url.pathname === '/v1/conversations' && method === 'GET') {
      const limit = parseLimit(url.searchParams.get('limit'))
      const activeIds = new Set(
        (this.options.archive.listActiveWatchdogs?.(1000) ?? [])
          .map(row => typeof row.conversationId === 'string' ? row.conversationId : '')
          .filter(Boolean),
      )
      const openIncidentIds = new Set(
        (this.options.archive.listIncidents?.({ status: 'open', limit: 1000 }) ?? [])
          .map(row => typeof row.conversationId === 'string' ? row.conversationId : '')
          .filter(Boolean),
      )
      const canonical = this.options.archive.list(limit)
      const provisional = this.options.archive.listDevSpaceRecoveryVirtualConversations?.(limit) ?? []
      const combined = [...canonical, ...provisional]
        .sort((a, b) => Number(b.capturedAt || 0) - Number(a.capturedAt || 0) || a.id.localeCompare(b.id))
        .slice(0, limit)
      jsonResponse(res, 200, {
        conversations: combined.map(row => ({
          ...row,
          lifecycleState: row.provisional
            ? row.provisionalState ?? 'idle'
            : openIncidentIds.has(row.id)
            ? 'aborted'
            : activeIds.has(row.id)
              ? 'running'
              : row.terminalState || row.lastFinishType
                ? 'completed'
                : 'idle',
        })),
      })
      return
    }

    if (url.pathname === '/v1/search' && method === 'GET') {
      if (!this.options.archive.searchConversations) {
        jsonResponse(res, 501, { error: 'search_not_supported' })
        return
      }
      const query = (url.searchParams.get('q') ?? '').trim()
      const sortValue = url.searchParams.get('sort')
      const sort = sortValue === 'recent' || sortValue === 'frequency' ? sortValue : 'relevance'
      const conversationLimit = parseLimit(url.searchParams.get('limit'), 20)
      const snippetsPerConversation = Math.max(1, Math.min(10, parseLimit(url.searchParams.get('snippets_per_conversation'), 3)))
      const startedAt = performance.now()
      const searchStartedAt = performance.now()
      const rows = query
        ? this.options.archive.searchConversations(query, {
            limit: conversationLimit,
            snippetsPerConversation,
            sort,
          })
        : []
      const searchFinishedAt = performance.now()

      const activeIds = new Set(
        (this.options.archive.listActiveWatchdogs?.(1000) ?? [])
          .map(row => typeof row.conversationId === 'string' ? row.conversationId : '')
          .filter(Boolean),
      )
      const openIncidentIds = new Set(
        (this.options.archive.listIncidents?.({ status: 'open', limit: 1000 }) ?? [])
          .map(row => typeof row.conversationId === 'string' ? row.conversationId : '')
          .filter(Boolean),
      )
      const conversations = rows.map(row => {
        const conversationId = typeof row.conversationId === 'string' ? row.conversationId : ''
        const terminalState = typeof row.terminalState === 'string' ? row.terminalState : null
        const lastFinishType = typeof row.lastFinishType === 'string' ? row.lastFinishType : null
        const { terminalState: _terminalState, lastFinishType: _lastFinishType, ...publicRow } = row
        return {
          ...publicRow,
          lifecycleState: openIncidentIds.has(conversationId)
            ? 'aborted'
            : activeIds.has(conversationId)
              ? 'running'
              : terminalState || lastFinishType
                ? 'completed'
                : 'idle',
        }
      })
      const enrichFinishedAt = performance.now()
      jsonResponse(res, 200, {
        query,
        sort,
        conversationLimit,
        snippetsPerConversation,
        conversations,
        timing: {
          searchMs: Math.round((searchFinishedAt - searchStartedAt) * 100) / 100,
          enrichMs: Math.round((enrichFinishedAt - searchFinishedAt) * 100) / 100,
          totalMs: Math.round((enrichFinishedAt - startedAt) * 100) / 100,
        },
      })
      return
    }

    if (url.pathname === '/v1/search/messages' && method === 'GET') {
      if (!this.options.archive.searchMessages) {
        jsonResponse(res, 501, { error: 'message_search_not_supported' })
        return
      }
      const query = (url.searchParams.get('q') ?? '').trim()
      const startedAt = performance.now()
      const hits = query ? this.options.archive.searchMessages(query, parseLimit(url.searchParams.get('limit'), 20)) : []
      jsonResponse(res, 200, {
        query,
        hits,
        timing: { totalMs: Math.round((performance.now() - startedAt) * 100) / 100 },
      })
      return
    }

    const messagesMatch = /^\/v1\/conversations\/([^/]+)\/messages$/u.exec(url.pathname)
    if (messagesMatch && method === 'GET') {
      const conversationId = decodeURIComponent(messagesMatch[1]!)
      const limit = parseLimit(url.searchParams.get('limit'), 120)
      const beforeOrdinal = parseBeforeOrdinal(url.searchParams.get('before_ordinal'))
      // canonical first-party messages 永远是主数据；DevSpace recovery 只在 Reader/Bridge 展示层
      // 追加仍未被 canonical body supersede 的 provisional 尾部节点。
      const recoveryMessages = sanitizeMessages(
        this.options.archive.getDevSpaceRecoveryMessages?.(conversationId) ?? [],
      )
      const canonicalPage = this.options.archive.getMessagesPage?.(conversationId, {
        limit,
        beforeOrdinal,
      })

      let messages: Array<Record<string, unknown>>
      let canonicalCount: number
      let total: number
      let hasMore: boolean
      let nextBeforeOrdinal: number | null

      if (canonicalPage) {
        const canonicalMessages = sanitizeMessages(canonicalPage.messages)
        const eligibleRecovery = beforeOrdinal === null
          ? recoveryMessages
          : recoveryMessages.filter(row =>
              Number.isFinite(Number(row.ordinal)) && Number(row.ordinal) < beforeOrdinal,
            )
        messages = [...canonicalMessages, ...eligibleRecovery].slice(-limit)
        canonicalCount = canonicalPage.canonicalCount
        total = canonicalPage.visibleCount + recoveryMessages.length
        hasMore = canonicalPage.eligibleVisibleCount + eligibleRecovery.length > messages.length
        nextBeforeOrdinal = messages.length > 0 && Number.isFinite(Number(messages[0]!.ordinal))
          ? Number(messages[0]!.ordinal)
          : null
      }
      else {
        const canonicalMessages = this.options.archive.getMessages(conversationId)
        const page = paginateOrdinalRows(
          sanitizeMessages([...canonicalMessages, ...recoveryMessages]),
          limit,
          beforeOrdinal,
        )
        messages = page.rows
        canonicalCount = canonicalMessages.length
        total = page.total
        hasMore = page.hasMore
        nextBeforeOrdinal = page.nextBeforeOrdinal
      }
      jsonResponse(res, 200, {
        conversationId,
        messages,
        canonicalCount,
        provisionalCount: recoveryMessages.length,
        total,
        hasMore,
        nextBeforeOrdinal,
      })
      return
    }

    const resourcesMatch = /^\/v1\/conversations\/([^/]+)\/resources$/u.exec(url.pathname)
    if (resourcesMatch && method === 'GET') {
      if (!this.options.archive.getResources) {
        jsonResponse(res, 501, { error: 'resources_not_supported' })
        return
      }
      const conversationId = decodeURIComponent(resourcesMatch[1]!)
      const allResources = this.options.archive.getResources(conversationId).map(row => ({
        messageId: typeof row.messageId === 'string' ? row.messageId : null,
        ordinal: Number.isFinite(Number(row.ordinal)) ? Number(row.ordinal) : null,
        kind: typeof row.kind === 'string' ? row.kind : 'unknown',
        label: typeof row.label === 'string' ? row.label : null,
        data: row.data && typeof row.data === 'object' ? row.data : null,
      }))
      const page = paginateOrdinalRows(
        allResources,
        parseLimit(url.searchParams.get('limit'), 120),
        parseBeforeOrdinal(url.searchParams.get('before_ordinal')),
      )
      jsonResponse(res, 200, {
        conversationId,
        resources: page.rows,
        total: page.total,
        hasMore: page.hasMore,
        nextBeforeOrdinal: page.nextBeforeOrdinal,
      })
      return
    }

    const conversationMatch = /^\/v1\/conversations\/([^/]+)$/u.exec(url.pathname)
    if (conversationMatch && method === 'GET') {
      const conversationId = decodeURIComponent(conversationMatch[1]!)
      const conversation = this.options.archive.list(1000).find(row => row.id === conversationId)
        ?? this.options.archive.listDevSpaceRecoveryVirtualConversations?.(1000)
          .find(row => row.id === conversationId)
      if (!conversation) {
        jsonResponse(res, 404, { error: 'conversation_not_found' })
        return
      }
      const lifecycle = conversation.provisional
        ? { state: conversation.provisionalState ?? 'idle', active: null, incident: null }
        : conversationLifecycle(conversationId, this.options.archive)
      jsonResponse(res, 200, {
        conversation: { ...conversation, lifecycleState: lifecycle.state },
        active: lifecycle.active,
        incidents: (this.options.archive.listIncidents?.({ limit: 1000 }) ?? [])
          .filter(row => row.conversationId === conversationId),
      })
      return
    }

    if (url.pathname === '/v1/worksites/resolve' && method === 'GET') {
      const conversationId = (url.searchParams.get('conversation_id') ?? '').trim()
      const turnExchangeId = (url.searchParams.get('turn_exchange_id') ?? '').trim() || null
      if (!conversationId) {
        jsonResponse(res, 400, { error: 'conversation_id_required' })
        return
      }
      const worksite = buildArchiveBridgeWorksite(this.options.archive, conversationId, turnExchangeId)
      if (!worksite) {
        jsonResponse(res, 404, { error: 'conversation_not_found' })
        return
      }
      jsonResponse(res, 200, { worksite })
      return
    }

    if (url.pathname === '/v1/submissions' && method === 'GET') {
      if (!this.submissionQueue) {
        jsonResponse(res, 404, { error: 'submission_queue_disabled' })
        return
      }
      const idempotencyKey = (url.searchParams.get('key') ?? '').trim()
      if (!idempotencyKey) {
        jsonResponse(res, 400, { error: 'key_required' })
        return
      }
      const submission = this.submissionQueue.get(idempotencyKey)
      if (!submission) {
        jsonResponse(res, 404, { error: 'submission_not_found' })
        return
      }
      jsonResponse(res, 200, {
        submission: sanitizeActorSubmissionRecord(submission),
      })
      return
    }

    if (url.pathname === '/v1/turns' && method === 'POST') {
      try {
        const input = validateTurnInput(await readJsonBody(req, this.options.maxBodyBytes))
        if (input.idempotencyKey && this.submissionQueue) {
          const submission = await this.submissionQueue.enqueue(input.idempotencyKey, {
            text: input.text,
            conversationId: input.conversationId,
            projectName: input.projectName,
            mode: input.mode,
            targetMode: input.targetMode,
          })
          jsonResponse(res, 202, {
            accepted: true,
            submission: sanitizeActorSubmissionRecord(submission),
          })
          return
        }
        const result = await this.options.submitTurn(input)
        const safeResult = sanitizeArchiveBridgeTurnResult(input, result)
        const event: ArchiveBridgeEvent = {
          version: 1,
          at: Date.now(),
          kind: 'actor-accepted',
          conversationId: typeof safeResult.conversationId === 'string' ? safeResult.conversationId : input.conversationId,
          event: typeof safeResult.mode === 'string' ? safeResult.mode : input.mode,
        }
        this.publish(event)
        jsonResponse(res, 202, { accepted: true, result: safeResult })
      }
      catch (error) {
        if (error instanceof ActorSubmissionConflictError) {
          jsonResponse(res, 409, { error: error.message })
          return
        }
        const message = error instanceof Error ? error.message : String(error)
        jsonResponse(res, actorErrorStatus(error), { error: message })
      }
      return
    }

    if (url.pathname === '/v1/events' && method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      res.write(`event: bridge-ready\ndata: ${JSON.stringify({
        version: 1,
        at: Date.now(),
        kind: 'bridge-ready',
      })}\n\n`)
      this.sseClients.add(res)
      const remove = () => this.sseClients.delete(res)
      req.once('close', remove)
      res.once('close', remove)
      return
    }

    jsonResponse(res, 404, { error: 'not_found' })
  }

  private publishAcceptedSubmission(record: ActorSubmissionRecord): void {
    const result = record.result ?? {}
    this.publish({
      version: 1,
      at: Date.now(),
      kind: 'actor-accepted',
      conversationId: typeof result.conversationId === 'string'
        ? result.conversationId
        : record.input.conversationId,
      event: typeof result.mode === 'string' ? result.mode : record.input.mode,
    })
  }
}

