import { randomBytes, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import path from 'node:path'

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
}

export interface ArchiveBridgeDataSource {
  list(limit?: number): ArchiveBridgeConversationRow[]
  getMessages(conversationId: string): Array<Record<string, unknown>>
}

export type ArchiveBridgeActorMode = 'auto' | 'new' | 'continue' | 'steer'
export type ArchiveBridgeActorTarget = 'guardian' | 'dedicated'

export interface ArchiveBridgeTurnInput {
  text: string
  conversationId: string | null
  mode: ArchiveBridgeActorMode
  targetMode: ArchiveBridgeActorTarget
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
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.max(1, Math.min(200, Math.trunc(numeric)))
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
    .map(row => ({
      messageId: typeof row.messageId === 'string' ? row.messageId : null,
      ordinal: Number.isFinite(Number(row.ordinal)) ? Number(row.ordinal) : null,
      role: typeof row.role === 'string' ? row.role : 'unknown',
      authorName: typeof row.authorName === 'string' ? row.authorName : null,
      recipient: typeof row.recipient === 'string' ? row.recipient : null,
      channel: typeof row.channel === 'string' ? row.channel : null,
      contentType: typeof row.contentType === 'string' ? row.contentType : null,
      text: typeof row.text === 'string' ? row.text : '',
      createTime: typeof row.createTime === 'number' ? row.createTime : null,
    }))
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
  return {
    text,
    conversationId,
    mode: mode as ArchiveBridgeActorMode,
    targetMode: targetMode as ArchiveBridgeActorTarget,
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
      jsonResponse(res, 200, {
        conversations: this.options.archive.list(parseLimit(url.searchParams.get('limit'))),
      })
      return
    }

    const messagesMatch = /^\/v1\/conversations\/([^/]+)\/messages$/u.exec(url.pathname)
    if (messagesMatch && method === 'GET') {
      const conversationId = decodeURIComponent(messagesMatch[1]!)
      const messages = sanitizeMessages(this.options.archive.getMessages(conversationId))
      jsonResponse(res, 200, { conversationId, messages })
      return
    }

    if (url.pathname === '/v1/turns' && method === 'POST') {
      try {
        const input = validateTurnInput(await readJsonBody(req, this.options.maxBodyBytes))
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
}

