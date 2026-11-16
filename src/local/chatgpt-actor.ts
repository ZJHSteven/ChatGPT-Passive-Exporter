import fs from 'node:fs/promises'
import path from 'node:path'
// Node 24 直接执行本项目 `.ts` 源文件时不会像 Vite/Vitest 一样自动补扩展名；
// 这是运行时 import（不是 type-only），因此必须显式写 `.ts`。
import { ActiveTurnRecorder, buildActorSubmitTrace } from './active-turn-recorder.ts'
import { inputActorPromptWithFeedback } from './actor-composer-integrity.ts'
import { ACTOR_VISIBLE_COMPOSER_EXPRESSION } from './actor-composer-target.ts'
import {
  ActorDomDriftLedger,
  type ActorDomObservation,
  type ActorDomObserveResult,
} from './dom-drift.ts'

const DEFAULT_CDP_TIMEOUT_MS = 10_000
const CHATGPT_HOME = 'https://chatgpt.com/'

interface CdpTarget {
  id?: string
  targetId?: string
  type?: string
  url?: string
  title?: string
  webSocketDebuggerUrl?: string
}

interface ActorState {
  targetId: string
  createdAt: number
  updatedAt: number
  /** `guardian` 表示借用 daemon 的常驻页；`dedicated` 才是 Actor 自己创建、可由 reset 关闭的页。 */
  source?: 'guardian' | 'dedicated'
  /** 最近一次真正观察到正式 Actor POST 的时间，用于所有入口共享的 5 秒提交节拍。 */
  lastSubmittedAt?: number | null
}

interface ActorLease {
  path: string
  token: string
  acquiredAt: number
  waitMs: number
}

export type ActorTargetMode = 'guardian' | 'dedicated'

/** 默认主动发送最小间隔，沿用已经稳定运行过的 batch 5 秒保护窗。 */
export const DEFAULT_ACTOR_MIN_SUBMIT_GAP_MS = 5_000

/** 纯函数计算距离下一次允许主动提交还要等待多久。 */
export function actorSubmitGapDelayMs(
  lastSubmittedAt: number | null | undefined,
  now = Date.now(),
  minGapMs = DEFAULT_ACTOR_MIN_SUBMIT_GAP_MS,
): number {
  const last = Number(lastSubmittedAt || 0)
  if (!Number.isFinite(last) || last <= 0 || minGapMs <= 0) return 0
  return Math.max(0, last + minGapMs - now)
}

/**
 * ChatGPT Web 的“普通新 turn”和“active follow-up steer”不是同一种响应协议：
 * - `/f/conversation`：当前第一方页面返回 `text/event-stream`，这是新建/续接 turn 的原始 SSE；
 * - `/f/steer_turn`：2026-10-07 production E2E 实测成功响应为 `application/json`，随后现有 active
 *   generation 继续在页面/既有 transport 上收口。
 *
 * 因此不能再把“所有发送都必须 event-stream”写死；但仍然按 mode 严格白名单，而不是接受任意 MIME。
 */
export function actorResponseMimeAccepted(mode: ActorSendMode, mimeType: string | null): boolean {
  if (!mimeType) return true
  const normalized = mimeType.toLowerCase()
  if (mode === 'steer') return normalized.includes('application/json')
  return normalized.includes('text/event-stream')
}

/**
 * Guardian 只在“发送 transport 已经不再依赖当前 conversation UI route”时回到 neutral new-chat。
 * new/continue 必须至少看到一段真实 SSE data；只看到 200 + event-stream header 还不足以证明
 * React 切 route 后不会把一个尚未真正开始读取的 response 提前 abort。steer 则复用发送前已验证的
 * live conversation transport，因此 2xx 后即可归位。
 */
export function shouldNeutralizeGuardianAfterSubmit(input: {
  mode: ActorSendMode
  targetMode: ActorTargetMode
  firstDataAt: number | null
}): boolean {
  if (input.targetMode !== 'guardian') return false
  return input.mode === 'steer' || input.firstDataAt !== null
}

/**
 * Phase 4 的发送语义必须显式区分三类第一方行为：
 *
 * - `new`：从新聊天页创建 conversation，正式请求是 `/f/conversation`；
 * - `continue`：进入一个已经存在、当前不处于 live generation 的 conversation 后继续发送，
 *   正式请求同样是 `/f/conversation`；
 * - `steer`：当前 conversation 仍在生成且本页已经 live attached 时发送 follow-up，
 *   第一方 Web 实测会走 `/f/steer_turn`。
 *
 * `auto` 只负责在这些已验证语义之间选择，绝不能把“页面还没加载完 / resume 失败”
 * 猜成 steer。上下文不完整时应明确失败，避免把裁剪过的 UI 上下文发回模型。
 */
export type ActorSendMode = 'auto' | 'new' | 'continue' | 'steer'

type ActorResolvedMode = Exclude<ActorSendMode, 'auto'>

interface ActorPageSnapshot {
  href: string
  conversationId: string | null
  composerPresent: boolean
  composerHydrated: boolean
  composerHasText: boolean
  /** ChatGPT 自身显示「无法加载此对话」，不是可用的会话页面。 */
  conversationLoadFailed: boolean
  sendReady: boolean
  stopVisible: boolean
  waitingForFinal: boolean
  messageNodes: number
}

export function actorDocumentFailureKind(
  href: string,
  conversationLoadFailed = false,
): 'wrong-document' | 'conversation-load-error' | null {
  const raw = String(href || '').trim()
  if (!raw) return 'wrong-document'
  try {
    // 域名正确只能说明浏览器打开了 ChatGPT，不能证明当前页面可交互。
    // 登录态刷新或临时网络故障可能让同源 conversation 页面停在「再试一次」错误壳。
    if (new URL(raw).origin !== 'https://chatgpt.com') return 'wrong-document'
    return conversationLoadFailed ? 'conversation-load-error' : null
  }
  catch {
    return 'wrong-document'
  }
}

async function waitForHealthyActorShell(
  client: ActorCdpClient,
  timeoutMs: number,
  targetMode: ActorTargetMode,
): Promise<ActorPageSnapshot> {
  const deadline = Date.now() + Math.max(1_000, timeoutMs)
  let recoveredUnhealthyDocument = false
  let lastSnapshot: ActorPageSnapshot | null = null
  while (Date.now() < deadline) {
    lastSnapshot = await readActorPageSnapshot(client)
    const documentFailure = actorDocumentFailureKind(lastSnapshot.href, lastSnapshot.conversationLoadFailed)
    if (!documentFailure && (
      lastSnapshot.composerHydrated
      || lastSnapshot.stopVisible
      || lastSnapshot.waitingForFinal
    )) return lastSnapshot
    if (documentFailure && !recoveredUnhealthyDocument) {
      // 一次性退回健康首页：不重发、不改写 prompt，不在同一个失败会话里无限刷新。
      recoveredUnhealthyDocument = true
      const recoveryUrl = targetMode === 'guardian'
        ? 'https://chatgpt.com/?chatgpt-archive-guardian=1'
        : 'https://chatgpt.com/'
      await client.send('Page.navigate', { url: recoveryUrl })
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(
    'ChatGPT actor page did not reach a healthy ChatGPT shell before timeout: href='
      + (lastSnapshot?.href || 'unknown'),
  )
}

interface ActorSendOptions {
  cdpHttp: string
  statePath: string
  daemonStatePath?: string | null
  domLedgerPath?: string | null
  tracePath: string
  prompt: string
  conversationId?: string | null
  /**
   * 仅用于 `new`：点击 ChatGPT 侧栏里“在 <project> 中开启新聊天”的第一方入口，
   * 再复用现有 composer/send/SSE 链。这里只选择已有 Project，不实现 Project CRUD。
   */
  projectName?: string | null
  mode?: ActorSendMode
  targetMode?: ActorTargetMode
  timeoutMs?: number
  /** 一次 CDP Input.insertText 写入多少个 Unicode 字符；默认 512，减少长 ASR 导致的 renderer ACK 超时。 */
  inputChunkChars?: number
  /**
   * daemon/Bridge 可注入一个旁路通知回调：DOM 安全骨架发生未知漂移时，在真正抛错阻断发送之前
   * 把完整结构证据交给宿主。CLI 直调用不需要提供；回调失败也不能放行 Actor。
   */
  onDomDrift?: ((input: {
    phase: string
    result: ActorDomObserveResult
    details: string[]
  }) => void | Promise<void>) | null
  /**
   * 正式 turn POST 自己命中 429 时，daemon 可以在这里立即建立账号级 cooldown。
   * 返回未来的绝对截止时间后，Actor 会把错误规范化为带 until 的 cooldown 错误，
   * 方便持久化 submission queue 精确休眠，而不是继续拿后续任务试探 429。
   */
  onRateLimit?: ((input: {
    mode: ActorResolvedMode
    requestUrl: string
    requestId: string
    status: number
    retryAfter: string | null
  }) => number | null | void | Promise<number | null | void>) | null
}

function actorLeasePath(options: Pick<ActorSendOptions, 'statePath' | 'daemonStatePath' | 'targetMode'>): string {
  const targetMode = options.targetMode ?? 'guardian'
  if (targetMode === 'guardian' && options.daemonStatePath) {
    return `${options.daemonStatePath}.actor.lock`
  }
  return `${options.statePath}.lock`
}

function processAppearsAlive(pid: unknown): boolean {
  const numericPid = Number(pid)
  if (!Number.isInteger(numericPid) || numericPid <= 0) return false
  try {
    process.kill(numericPid, 0)
    return true
  }
  catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

async function readActorLeaseOwner(lockPath: string): Promise<{
  pid: number | null
  acquiredAt: number | null
  token: string | null
  ageMs: number | null
} | null> {
  try {
    const stat = await fs.stat(lockPath)
    let parsed: any = null
    try { parsed = JSON.parse(await fs.readFile(lockPath, 'utf8')) }
    catch { parsed = null }
    const acquiredAt = Number(parsed?.acquiredAt || 0) || null
    return {
      pid: Number.isInteger(Number(parsed?.pid)) ? Number(parsed.pid) : null,
      acquiredAt,
      token: typeof parsed?.token === 'string' ? parsed.token : null,
      ageMs: Math.max(0, Date.now() - (acquiredAt ?? stat.mtimeMs)),
    }
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null
    throw error
  }
}

/**
 * 单 Guardian 合并后必须跨进程串行化“会改变页面”的 Actor 操作。
 *
 * 这不是为了限制 ChatGPT 本身的同-tab 并发能力，而是防止两个独立 CLI/Agent 同时导航/输入
 * 同一张隐藏 Guardian 页，把彼此的闭环状态机破坏掉。锁只覆盖“提交动作到 Network 证据闭环”这段，
 * 后台 SSE 生成不持锁，因此 A 发出后仍可由后续 Actor SPA 切去 B 并启动另一条 conversation。
 */
async function acquireActorLease(options: ActorSendOptions, timeoutMs: number): Promise<ActorLease> {
  const lockPath = actorLeasePath(options)
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(16).slice(2)}`
  const startedAt = Date.now()
  const malformedStaleMs = Math.max(120_000, timeoutMs * 3)
  await fs.mkdir(path.dirname(lockPath), { recursive: true })

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const handle = await fs.open(lockPath, 'wx')
      const acquiredAt = Date.now()
      try {
        await handle.writeFile(JSON.stringify({
          version: 1,
          pid: process.pid,
          acquiredAt,
          token,
          targetMode: options.targetMode ?? 'guardian',
        }))
      }
      finally {
        await handle.close()
      }
      return { path: lockPath, token, acquiredAt, waitMs: acquiredAt - startedAt }
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error
    }

    const owner = await readActorLeaseOwner(lockPath)
    if (!owner) continue
    const ownerAlive = processAppearsAlive(owner.pid)
    const malformedAndOld = owner.pid === null && Number(owner.ageMs || 0) >= malformedStaleMs
    if (!ownerAlive && (owner.pid !== null || malformedAndOld)) {
      try { await fs.rm(lockPath, { force: true }) }
      catch { /* 下一轮重新观察；不能因为 stale cleanup 竞争失败而绕过锁。 */ }
      continue
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }

  const owner = await readActorLeaseOwner(lockPath)
  throw new Error(
    `ChatGPT actor lease timeout after ${timeoutMs}ms; ownerPid=${owner?.pid ?? 'unknown'} ageMs=${owner?.ageMs ?? 'unknown'}`,
  )
}

async function releaseActorLease(lease: ActorLease): Promise<void> {
  try {
    const owner = await readActorLeaseOwner(lease.path)
    if (!owner || owner.token !== lease.token) return
    await fs.rm(lease.path, { force: true })
  }
  catch {
    // 发送结果已经由 Network 闭环确认时，清理失败不应把一次成功发送改写成业务失败。
    // 下次 acquire 会根据 owner pid/stale 语义安全恢复。
  }
}

/**
 * Actor 控制器自己的极小 CDP client。
 *
 * 这里暂时不重构 daemon / probe / companion-control 中已有的 client：Phase 3 还在验证发送协议，
 * 先把行为收稳，再统一抽公共 transport，避免一次实验同时改动四条生产链。
 */
class ActorCdpClient {
  private readonly url: string
  private ws: WebSocket | null = null
  private nextId = 1
  private readonly pending = new Map<number, {
    resolve: (value: any) => void
    reject: (reason?: unknown) => void
    timer: ReturnType<typeof setTimeout>
  }>()
  private readonly listeners = new Map<string, Set<(params: any) => void>>()

  constructor(url: string) {
    this.url = url
  }

  async connect(): Promise<void> {
    this.ws = new WebSocket(this.url)
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data))
      if (typeof message.id === 'number') {
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        clearTimeout(pending.timer)
        if (message.error) pending.reject(new Error(message.error.message || 'CDP error'))
        else pending.resolve(message.result || {})
        return
      }
      if (typeof message.method !== 'string') return
      for (const handler of this.listeners.get(message.method) ?? []) handler(message.params || {})
    })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP connect timeout: ${this.url}`)), DEFAULT_CDP_TIMEOUT_MS)
      this.ws!.addEventListener('open', () => {
        clearTimeout(timer)
        resolve()
      }, { once: true })
      this.ws!.addEventListener('error', () => {
        clearTimeout(timer)
        reject(new Error(`CDP connect failed: ${this.url}`))
      }, { once: true })
    })
  }

  send(method: string, params: Record<string, unknown> = {}, timeoutMs = DEFAULT_CDP_TIMEOUT_MS): Promise<any> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('CDP client is not connected'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP ${method} timeout after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.ws!.send(JSON.stringify({ id, method, params }))
    })
  }

  on(method: string, handler: (params: any) => void): () => void {
    const set = this.listeners.get(method) ?? new Set<(params: any) => void>()
    set.add(handler)
    this.listeners.set(method, set)
    return () => {
      set.delete(handler)
      if (set.size === 0) this.listeners.delete(method)
    }
  }

  close(): void {
    this.ws?.close()
  }
}

/**
 * Actor 真正依赖的 CDP domain 只有 Network：正式 `/f/conversation` POST、HTTP 状态、
 * MIME 与首包 SSE 都必须由 Network 事件闭环确认。`Page.enable` / `Runtime.enable` 只是早期
 * “习惯性初始化”，当前 Actor 既不监听 Page 事件，Runtime.evaluate 也无需先 enable。
 *
 * Chrome 后台/冻结 target 偶尔会出现“命令其实已经排进 renderer，但 ACK 超时”的短抖动。
 * `Network.enable` 是幂等命令，因此这里允许有限重试；三次仍失败就 fail-closed，绝不能在
 * 无法观察正式 POST/response 的情况下继续点击发送。
 */
export async function enableActorNetworkDomain(
  send: (method: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<any>,
  options: { attempts?: number; commandTimeoutMs?: number; retryDelayMs?: number } = {},
): Promise<{ attempts: number }> {
  const attempts = Math.max(1, Math.trunc(options.attempts ?? 3))
  const commandTimeoutMs = Math.max(250, Math.trunc(options.commandTimeoutMs ?? 5_000))
  const retryDelayMs = Math.max(0, Math.trunc(options.retryDelayMs ?? 150))
  let lastError: unknown = null

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await send('Network.enable', {}, commandTimeoutMs)
      return { attempts: attempt }
    }
    catch (error) {
      lastError = error
      if (attempt >= attempts) break
      await new Promise(resolve => setTimeout(resolve, retryDelayMs * attempt))
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError ?? 'unknown error')
  throw new Error(`ChatGPT actor could not enable CDP Network after ${attempts} attempts: ${message}`)
}

function normalizeCdpHttp(value: string): string {
  return value.replace(/\/$/u, '')
}

async function listTargets(cdpHttp: string): Promise<CdpTarget[]> {
  const response = await fetch(`${normalizeCdpHttp(cdpHttp)}/json/list`, { signal: AbortSignal.timeout(5000) })
  if (!response.ok) throw new Error(`CDP /json/list HTTP ${response.status}`)
  return await response.json() as CdpTarget[]
}

async function readActorState(statePath: string): Promise<ActorState | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(statePath, 'utf8')) as ActorState
    return typeof parsed?.targetId === 'string' && parsed.targetId ? parsed : null
  }
  catch {
    return null
  }
}

async function readJsonFile(filePath: string | null | undefined): Promise<any | null> {
  if (!filePath) return null
  try { return JSON.parse(await fs.readFile(filePath, 'utf8')) }
  catch { return null }
}

async function writeActorState(statePath: string, state: ActorState): Promise<void> {
  await fs.mkdir(path.dirname(statePath), { recursive: true })
  await fs.writeFile(statePath, JSON.stringify(state, null, 2))
}

/**
 * 在拿到跨进程 lease 后等待共享提交间隔。这里只睡本机时钟，不访问 ChatGPT；
 * 真正的 429 熔断继续由 daemon `cooldownUntil` 负责。
 */
async function waitForActorSubmitGap(statePath: string): Promise<number> {
  const before = Date.now()
  const state = await readActorState(statePath)
  const delayMs = actorSubmitGapDelayMs(state?.lastSubmittedAt, before)
  if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs))
  return Date.now() - before
}

async function waitForTarget(cdpHttp: string, targetId: string, timeoutMs: number): Promise<CdpTarget> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const target = (await listTargets(cdpHttp)).find(item => (item.id ?? item.targetId) === targetId)
    if (target?.webSocketDebuggerUrl) return target
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`actor target ${targetId} did not become available`)
}

async function createActorTarget(cdpHttp: string, timeoutMs: number): Promise<CdpTarget> {
  const versionResponse = await fetch(`${normalizeCdpHttp(cdpHttp)}/json/version`, { signal: AbortSignal.timeout(5000) })
  if (!versionResponse.ok) throw new Error(`CDP /json/version HTTP ${versionResponse.status}`)
  const version = await versionResponse.json() as { webSocketDebuggerUrl?: string }
  if (!version.webSocketDebuggerUrl) throw new Error('CDP browser has no webSocketDebuggerUrl')

  const browser = new ActorCdpClient(version.webSocketDebuggerUrl)
  await browser.connect()
  try {
    // actor 独占一个 window，避免和隐藏 Guardian 共用同一 tab strip；窗口是否被系统判 hidden
    // 不影响 actor，因为发送走页面自己的 React handler，而不是模拟可见鼠标坐标。
    const created = await browser.send('Target.createTarget', {
      url: CHATGPT_HOME,
      newWindow: true,
      background: true,
    })
    if (typeof created?.targetId !== 'string') throw new Error('Target.createTarget did not return targetId')
    return await waitForTarget(cdpHttp, created.targetId, timeoutMs)
  }
  finally {
    browser.close()
  }
}

async function acquireActorTarget(
  cdpHttp: string,
  statePath: string,
  timeoutMs: number,
  targetMode: ActorTargetMode,
  daemonStatePath?: string | null,
): Promise<CdpTarget> {
  if (targetMode === 'guardian') {
    const daemonState = await readJsonFile(daemonStatePath)
    const guardianTargetId = typeof daemonState?.guardian?.targetId === 'string'
      ? daemonState.guardian.targetId
      : null
    if (!guardianTargetId) throw new Error('ChatGPT Guardian target is unavailable; start the archive daemon or use --target dedicated')
    const target = (await listTargets(cdpHttp)).find(item => (
      (item.id ?? item.targetId) === guardianTargetId
      && item.type === 'page'
      && typeof item.url === 'string'
      && item.url.startsWith('https://chatgpt.com/')
      && item.webSocketDebuggerUrl
    ))
    if (!target) throw new Error('ChatGPT Guardian target is not reachable through CDP')
    const prior = await readActorState(statePath)
    await writeActorState(statePath, {
      targetId: guardianTargetId,
      createdAt: prior && prior.targetId === guardianTargetId ? prior.createdAt : Date.now(),
      updatedAt: Date.now(),
      source: 'guardian',
      lastSubmittedAt: prior?.lastSubmittedAt ?? null,
    })
    return target
  }

  const state = await readActorState(statePath)
  if (state && state.source !== 'guardian') {
    const existing = (await listTargets(cdpHttp)).find(item => (
      (item.id ?? item.targetId) === state.targetId
      && item.type === 'page'
      && typeof item.url === 'string'
      && item.url.startsWith('https://chatgpt.com/')
      && item.webSocketDebuggerUrl
    ))
    if (existing) return existing
  }

  const created = await createActorTarget(cdpHttp, timeoutMs)
  const targetId = String(created.id ?? created.targetId)
  const prior = await readActorState(statePath)
  await writeActorState(statePath, {
    targetId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    source: 'dedicated',
    lastSubmittedAt: prior?.lastSubmittedAt ?? null,
  })
  return created
}

/**
 * cooldown 是账号级主动请求预算，不是 Guardian 私有状态。
 * Actor 无论借 Guardian 还是独立 tab 都必须尊重同一个 cooldown，避免用另一个页面绕过熔断。
 */
export function actorCooldownDeadline(daemonState: any): number {
  return Math.max(
    Number(daemonState?.cooldownUntil || 0),
    // 任一 REST family 观测到的服务端 Retry-After 都是共享闸门；
    // Actor 虽使用独立 CDP target，也绝不允许绕过该服务器等待期限。
    Number(daemonState?.rateLimits?.sharedRetryAfterUntil || 0),
    Number(daemonState?.rateLimits?.legacyGlobalUntil || 0),
    Number(daemonState?.rateLimits?.families?.actor?.backoffUntil || 0),
  )
}

async function assertActorCooldownClear(daemonStatePath?: string | null): Promise<void> {
  const daemonState = await readJsonFile(daemonStatePath)
  const cooldownUntil = actorCooldownDeadline(daemonState)
  if (Number.isFinite(cooldownUntil) && cooldownUntil > Date.now()) {
    const until = new Date(cooldownUntil).toISOString()
    throw new Error(`ChatGPT actor blocked by active API cooldown until ${until}`)
  }
}

async function evaluateValue(client: ActorCdpClient, expression: string): Promise<any> {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (result?.exceptionDetails) {
    // `exceptionDetails.text` 在浏览器语法异常时经常只有 "Uncaught"；真正的
    // SyntaxError / TypeError 通常位于 exception.description。优先保留后者，
    // 让生产 E2E 的错误可以直接定位，而不必再手工复现一次 CDP 调用。
    const description = result.exceptionDetails.exception?.description
    throw new Error(description || result.exceptionDetails.text || 'Runtime.evaluate exception')
  }
  return result?.result?.value
}

async function waitForComposer(client: ActorCdpClient, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const snapshot = await readActorPageSnapshot(client)
    if (snapshot.composerPresent && snapshot.composerHydrated) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('ChatGPT actor composer did not finish hydration before timeout')
}

/** 只接受真正服务端 UUID；Branch 临时的 `WEB:` id 不算绑定完成。 */
export function conversationIdFromUrl(url: string): string | null {
  const match = /^https:\/\/chatgpt\.com\/(?:c\/|g\/g-p-[^/?#]+\/c\/)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/iu.exec(url)
  return match?.[1] ?? null
}

/** 统一校验 CLI/Bridge 传入的已有 Project 名称。 */
export function normalizeActorProjectName(value?: string | null): string | null {
  if (value === undefined || value === null) return null
  const normalized = String(value).trim()
  if (!normalized) throw new Error('actor --project must not be empty')
  if (/\r|\n/u.test(normalized)) throw new Error('actor --project must be a single-line project name')
  return normalized
}

/** Actor 只接受 canonical UUID conversation；project/branch 临时 URL 不在这个入口里猜。 */
export function actorConversationUrl(conversationId?: string | null): string {
  if (!conversationId) return CHATGPT_HOME
  const normalized = String(conversationId).trim()
  const url = `https://chatgpt.com/c/${normalized}`
  if (conversationIdFromUrl(url) !== normalized) throw new Error(`invalid ChatGPT conversation UUID: ${conversationId}`)
  return url
}

/**
 * 当前 actor 若复用 Guardian tab，URL 上可能带 `chatgpt-archive-guardian=1` 这个恢复标记。
 * SPA 点击通常不会依赖该 query，但 full-navigation fallback 不能把标记丢掉，否则 daemon 重启后
 * `ensureGuardian()` 可能把同一张 tab 误认为普通页面并重新创建 Guardian。
 */
function actorNavigationUrl(conversationId: string | null | undefined, currentHref: string): string {
  const base = new URL(actorConversationUrl(conversationId))
  try {
    const current = new URL(currentHref)
    if (current.searchParams.get('chatgpt-archive-guardian') === '1') {
      base.searchParams.set('chatgpt-archive-guardian', '1')
    }
  }
  catch {
    // 当前 URL 若不是合法绝对 URL，只是不继承 marker；真正导航仍使用 canonical chatgpt.com URL。
  }
  return base.toString()
}

/**
 * 读取发送相关的最小页面状态。
 *
 * 这里故意不把“某一个 selector 存在”当成业务真值：ChatGPT 2026 Web 会同时保留展开/折叠
 * sidebar 的隐藏副本，composer 也会在 prepare / streaming / follow-up 时反复重挂载按钮。
 * 因此：
 * 1. 元素必须沿祖先链可见且可交互；
 * 2. `sendReady / stopVisible` 从多个语义候选综合判断；
 * 3. `waitingForFinal` 单独标记 tokenless late-attach 的危险状态，禁止在上下文不完整时 steer。
 */
async function readActorPageSnapshot(client: ActorCdpClient): Promise<ActorPageSnapshot> {
  const value = await evaluateValue(client, `(() => {
    const usable = (element) => {
      if (!element || !element.isConnected) return false
      const rect = element.getBoundingClientRect()
      if (rect.width < 1 || rect.height < 1) return false
      const ownStyle = window.getComputedStyle(element)
      if (ownStyle.pointerEvents === 'none') return false
      for (let node = element; node; node = node.parentElement) {
        if (!(node instanceof HTMLElement)) continue
        if (node.hidden || node.hasAttribute('inert')) return false
        const style = window.getComputedStyle(node)
        if (style.display === 'none') return false
        if (style.visibility === 'hidden' || style.visibility === 'collapse') return false
        if (Number.parseFloat(style.opacity || '1') <= 0.01) return false
        if (node === document.documentElement) break
      }
      // ChatGPT 的 contenteditable 在长文本时会产生远大于真实 composer 外壳的几何 rect
      // （真机 32k 字课堂转写达到约 25k px 高），pixel hit-test 会落到页面正文区并产生假阴性。
      // 对 composer 输入更可靠的语义是：真实可见 textbox + 隶属于第一方 data-chatgpt-composer form。
      return Boolean(element.closest('form[data-chatgpt-composer]'))
    }

    const input = [
      ...document.querySelectorAll('#prompt-textarea'),
      ...document.querySelectorAll('[contenteditable="true"][role="textbox"]'),
      ...document.querySelectorAll('textarea'),
    ].find(usable) || null
    const form = input?.closest('form') || null
    const usableComposerButton = (button) => {
      if (!button || !button.isConnected || button.disabled) return false
      const rect = button.getBoundingClientRect()
      if (rect.width < 1 || rect.height < 1) return false
      const ownStyle = window.getComputedStyle(button)
      if (ownStyle.display === 'none' || ownStyle.visibility === 'hidden' || ownStyle.visibility === 'collapse') return false
      if (Number.parseFloat(ownStyle.opacity || '1') <= 0.01 || ownStyle.pointerEvents === 'none') return false
      for (let node = button; node && node !== form; node = node.parentElement) {
        if (!(node instanceof HTMLElement)) continue
        if (node.hidden || node.hasAttribute('inert')) return false
        const style = window.getComputedStyle(node)
        if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false
        if (Number.parseFloat(style.opacity || '1') <= 0.01) return false
      }
      return true
    }
    // input 已经通过严格 hit-test，form 因而是当前可交互 composer。其内部 submit/stop 控件
    // 不再重复做 elementFromPoint 中心点命中测试：当前浮动聊天布局会在按钮上方叠加装饰层，
    // 但第一方 button 自身仍是 enabled + pointer-events:auto，重复 hit-test 会产生假阴性。
    const buttons = form ? [...form.querySelectorAll('button')].filter(usableComposerButton) : []
    const buttonIdentity = (button) => [
      button.getAttribute('data-testid') || '',
      button.getAttribute('aria-label') || '',
      button.getAttribute('title') || '',
      (button.innerText || '').trim(),
    ].join(' ')
    const sendButton = buttons.find((button) => {
      const identity = buttonIdentity(button)
      if (/stop|停止/iu.test(identity)) return false
      return /send-button|(^|\\s)(send|发送)(\\s|$)/iu.test(identity)
        || (button.getAttribute('type') === 'submit' && !button.disabled)
    }) || null
    const stopButton = buttons.find((button) => /stop|停止/iu.test(buttonIdentity(button))) || null
    const bodyText = document.body?.innerText || ''
    const href = String(location.href || '')
    const pathname = (() => {
      try { return new URL(href).pathname }
      catch { return '' }
    })()
    // Project 内部 conversation 的 2026 Web 路径是：
    //   /g/g-p-<project-id>-<slug>/c/<conversation-uuid>
    // 它和普通 /c/<uuid> 是同一个 canonical conversation，只是多了一层 Project 路由。
    // 这里必须与 conversationIdFromUrl() 保持同一语义，否则 Actor 明明已经绑定 CID，
    // inspect / continue 阶段却会再次把当前页误判成“没有 conversation”。
    const match = new RegExp('^/(?:c/|g/g-p-[^/?#]+/c/)([0-9a-f-]{36})(?:/|$)', 'iu').exec(pathname)

    return {
      href,
      conversationId: match?.[1] || null,
      composerPresent: Boolean(input && usable(input)),
      composerHydrated: Boolean(input && usable(input) && (!form || form.hasAttribute('data-chatgpt-composer'))),
      composerHasText: Boolean(input && String(input.innerText ?? input.value ?? '').trim()),
      // 只在编辑器缺失时识别页面末尾的明确错误提示，避免匹配到正文里引用的报错。
      // 注意：这里处于外层 TypeScript 模板字符串内，正则的反斜杠必须双重转义。
      conversationLoadFailed: Boolean(!input && /无法加载(?:此|该|这个)?\\s*(?:ChatGPT\\s*)?对话|unable to load (?:this |the )?(?:ChatGPT )?conversation|failed to load conversation/iu.test(bodyText.slice(-600))),
      sendReady: Boolean(sendButton && !sendButton.disabled),
      stopVisible: Boolean(stopButton && !stopButton.disabled),
      waitingForFinal: /连接已中断|等待完整答复|connection interrupted|waiting for (?:the )?full (?:answer|response)/iu.test(bodyText),
      // ChatGPT Web 的消息 DOM 属性会变化；这里仅用于“上下文已经真正渲染”的闭环门控，
      // 不承担消息解析。2026-10-07 当前 UI 已从 data-message-author-role 切到 selection/search
      // 系列属性，因此保留多代语义锚点，只要求至少命中一个真实消息节点即可。
      messageNodes: document.querySelectorAll([
        '[data-message-author-role]',
        '[data-chatgpt-selection-message-id]',
        '[data-chatgpt-search-message-ids]',
        '[data-user-message-bubble="true"]',
        '[data-content-search-unit-key]',
      ].join(',')).length,
    }
  })()`)
  return value as ActorPageSnapshot
}

/**
 * 把真实页面 DOM 收缩成“可自动化骨架”。浏览器侧可以读取 aria/title 来判断语义，
 * 但返回给 Node 的对象只保留 semantic 类别和结构属性，不把按钮文字或聊天正文写进 ledger。
 */
/**
 * 生成交给浏览器 `Runtime.evaluate` 的 DOM 观察表达式。
 *
 * 单独暴露 builder 的原因不是为了让业务层拼脚本，而是为了让单元测试能在“不启动 Chrome”
 * 的情况下至少做一次 JavaScript 语法编译。这个保护专门防止外层 template literal 把内层
 * 正则转义吃掉——这类错误 TypeScript 无法发现，只有真正送进浏览器后才会变成 SyntaxError。
 */
export function buildActorDomObservationExpression(): string {
  return `(() => {
    const usable = (element) => {
      if (!element || !element.isConnected) return false
      const rect = element.getBoundingClientRect()
      if (rect.width < 1 || rect.height < 1) return false
      const ownStyle = window.getComputedStyle(element)
      if (ownStyle.pointerEvents === 'none') return false
      for (let node = element; node; node = node.parentElement) {
        if (!(node instanceof HTMLElement)) continue
        if (node.hidden || node.hasAttribute('inert')) return false
        const style = window.getComputedStyle(node)
        if (style.display === 'none') return false
        if (style.visibility === 'hidden' || style.visibility === 'collapse') return false
        if (Number.parseFloat(style.opacity || '1') <= 0.01) return false
        if (node === document.documentElement) break
      }
      return Boolean(element.closest('form[data-chatgpt-composer]'))
    }

    // 这段源码还要经过外层 template literal 再交给浏览器执行。直接在这里写
    // 斜杠转义类正则会经历两次源码解析，很容易把转义吃掉。
    // 改用 RegExp(string)，让浏览器实际接收到的表达式没有双重转义歧义。
    const canonicalConversationPath = new RegExp(
      '^/(?:c/|g/g-p-[^/?#]+/c/)[0-9a-f-]{20,}(?:/|$)',
      'iu',
    )
    const projectPath = new RegExp('^/(?:g/g-p-|projects?(?:/|$))', 'iu')
    const pathname = String(location.pathname || '/')
    const routeKind = canonicalConversationPath.test(pathname)
      ? 'conversation'
      : pathname === '/'
        ? 'home'
        : projectPath.test(pathname)
          ? 'project'
          : 'other'

    const input = [
      ...document.querySelectorAll('#prompt-textarea'),
      ...document.querySelectorAll('[contenteditable="true"][role="textbox"]'),
      ...document.querySelectorAll('textarea'),
    ].find(usable) || null
    const form = input?.closest('form') || null
    const identity = (element) => [
      element.getAttribute('data-testid') || '',
      element.getAttribute('aria-label') || '',
      element.getAttribute('title') || '',
      (element.innerText || '').trim(),
    ].join(' ')
    const semanticFor = (button) => {
      const text = identity(button)
      const testId = button.getAttribute('data-testid') || ''
      if (/stop|停止/iu.test(text)) return 'stop'
      // 外层 template literal 会先解析一次反斜杠，因此这里必须双写反斜杠，
      // 浏览器最终收到的正则才仍是空白字符类，而不是普通字母 s。
      if (/send-button|(^|\\s)(send|发送)(\\s|$)/iu.test(text)
        || (button.getAttribute('type') === 'submit' && !button.disabled)) return 'send'
      if (/attach|attachment|file-upload|composer-plus|附件|添加文件|上传/iu.test(testId + ' ' + text)) return 'attachment'
      if (/voice|dictat|microphone|mic-button|语音|麦克风/iu.test(testId + ' ' + text)) return 'voice'
      return null
    }
    const controls = form
      ? [...form.querySelectorAll('button')]
        .filter(usable)
        .map((button) => ({ button, semantic: semanticFor(button) }))
        .filter(item => item.semantic)
        .map(({ button, semantic }) => ({
          semantic,
          tag: button.tagName || null,
          type: button.getAttribute('type'),
          testId: button.getAttribute('data-testid'),
          ariaPresent: button.hasAttribute('aria-label'),
          titlePresent: button.hasAttribute('title'),
        }))
      : []

    const newChatCandidates = [
      ...document.querySelectorAll('[data-testid="create-new-chat-button"]'),
      ...document.querySelectorAll('a,button'),
    ]
    const newChat = newChatCandidates.find((element) => {
      if (!usable(element)) return false
      if (element.getAttribute('data-testid') === 'create-new-chat-button') return true
      return /新聊天|new chat/iu.test(identity(element))
    }) || null

    const anchors = [...document.querySelectorAll('a[href]')].filter(usable)
    const canonicalConversationLink = anchors.some((anchor) => {
      try { return canonicalConversationPath.test(new URL(anchor.href, location.href).pathname) }
      catch { return false }
    })
    const projectLink = anchors.some((anchor) => {
      try { return projectPath.test(new URL(anchor.href, location.href).pathname) }
      catch { return false }
    })
    const accountButton = [...document.querySelectorAll('[data-testid="accounts-profile-button"]')].some(usable)

    return {
      routeKind,
      composer: input ? {
        tag: input.tagName || null,
        id: input.id || null,
        role: input.getAttribute('role'),
        contentEditable: input.getAttribute('contenteditable'),
        formMarker: Boolean(form?.hasAttribute('data-chatgpt-composer')),
      } : null,
      newChat: newChat ? {
        tag: newChat.tagName || null,
        testId: newChat.getAttribute('data-testid'),
      } : null,
      sidebar: {
        canonicalConversationLink,
        projectLink,
        accountButton,
      },
      controls,
    }
  })()`
}

async function readActorDomObservation(client: ActorCdpClient): Promise<ActorDomObservation> {
  const value = await evaluateValue(client, buildActorDomObservationExpression())
  return value as ActorDomObservation
}

/**
 * 判断当前 DOM observation 是否只是 ChatGPT 页面切换/恢复过程中的“空壳快照”。
 *
 * 这类状态没有 composer、new-chat、sidebar anchor，也没有任何 composer control；
 * 它表达的是“renderer 还没把可交互骨架挂出来”，而不是“稳定 DOM 结构发生了漂移”。
 * 因此它不能写入 DOM drift ledger，更不能要求人工批准为 baseline。
 */
export function isTransientActorDomObservation(observation: ActorDomObservation): boolean {
  return observation.composer === null
    && observation.newChat === null
    && observation.controls.length === 0
    && !observation.sidebar.canonicalConversationLink
    && !observation.sidebar.projectLink
    && !observation.sidebar.accountButton
}

async function observeActorDomShape(
  client: ActorCdpClient,
  ledger: ActorDomDriftLedger | null,
  phase: string,
  onDomDrift?: ActorSendOptions['onDomDrift'],
  options: { allowTransient?: boolean } = {},
): Promise<string | null> {
  if (!ledger) return null
  const observation = await readActorDomObservation(client)
  if (options.allowTransient && isTransientActorDomObservation(observation)) {
    return null
  }
  const result = ledger.observe(observation)
  await ledger.flush()
  if (result.pending) {
    await onDomDrift?.({ phase, result, details: ledger.describePending(result.signature) })
    throw new Error(
      `ChatGPT actor DOM drift detected before ${phase}: ${result.signature} route=${result.shape.routeKind}; `
      + 'review/approve the DOM fingerprint before retrying',
    )
  }
  return result.signature
}

/**
 * 只做“语义选择”，不负责导航。
 *
 * `steer` 是最危险的一条：必须确认当前页就是目标 CID、页面没有进入“等待完整答复”降级状态，
 * 且第一方 UI 仍暴露 stop 控件，才认为本页已经 live attached。否则宁可失败，也不在缺上下文时
 * 把 follow-up 发出去。
 */
export function resolveActorSendMode(args: {
  requestedMode?: ActorSendMode
  requestedConversationId?: string | null
  currentConversationId?: string | null
  stopVisible?: boolean
  waitingForFinal?: boolean
}): ActorResolvedMode {
  const requestedMode = args.requestedMode ?? 'auto'
  const requestedConversationId = args.requestedConversationId ? String(args.requestedConversationId).trim() : null
  const currentConversationId = args.currentConversationId ? String(args.currentConversationId).trim() : null
  const stopVisible = Boolean(args.stopVisible)
  const waitingForFinal = Boolean(args.waitingForFinal)

  if (requestedMode === 'new') {
    if (requestedConversationId) throw new Error('actor mode=new cannot be combined with --conversation')
    return 'new'
  }
  if (requestedMode === 'continue') {
    if (!requestedConversationId) throw new Error('actor mode=continue requires --conversation <UUID>')
    if (currentConversationId === requestedConversationId && waitingForFinal) {
      throw new Error('actor continue refused: target conversation is waiting for full answer and current context is incomplete')
    }
    if (currentConversationId === requestedConversationId && stopVisible) {
      throw new Error('actor continue refused: target conversation is still live; use --mode steer or --mode auto')
    }
    return 'continue'
  }
  if (requestedMode === 'steer') {
    if (!requestedConversationId) throw new Error('actor mode=steer requires --conversation <UUID>')
    if (currentConversationId !== requestedConversationId) {
      throw new Error('actor steer requires the target conversation to be the current page')
    }
    if (waitingForFinal || !stopVisible) {
      throw new Error('actor steer refused: target conversation is not live-attached with complete current context')
    }
    return 'steer'
  }

  if (!requestedConversationId) return 'new'
  if (currentConversationId === requestedConversationId && waitingForFinal) {
    throw new Error('actor auto refused: target conversation is waiting for full answer and is not safe to follow up')
  }
  if (currentConversationId === requestedConversationId && stopVisible) return 'steer'
  return 'continue'
}

/** 找当前可见的新聊天入口；优先官方稳定的 data-testid，再退回中英文 aria/text。 */
async function clickNewChatSpa(client: ActorCdpClient): Promise<boolean> {
  return await evaluateValue(client, `(() => {
    const usable = (element) => {
      if (!element || !element.isConnected) return false
      const rect = element.getBoundingClientRect()
      if (rect.width < 1 || rect.height < 1) return false
      const ownStyle = window.getComputedStyle(element)
      if (ownStyle.pointerEvents === 'none') return false
      for (let node = element; node; node = node.parentElement) {
        if (!(node instanceof HTMLElement)) continue
        if (node.hidden || node.hasAttribute('inert')) return false
        const style = window.getComputedStyle(node)
        if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false
        if (Number.parseFloat(style.opacity || '1') <= 0.01) return false
        if (node === document.documentElement) break
      }
      return true
    }
    const candidates = [
      ...document.querySelectorAll('[data-testid="create-new-chat-button"]'),
      ...document.querySelectorAll('a,button'),
    ]
    const target = candidates.find((element) => {
      if (!usable(element)) return false
      if (element.getAttribute('data-testid') === 'create-new-chat-button') return true
      // Project 行也有“在 <Project> 中开启新聊天”按钮；这里必须只认全局 new-chat，
      // 否则从任意 conversation 归位时可能误进侧栏中第一个 Project composer。
      const aria = String(element.getAttribute('aria-label') || '').trim()
      const text = String(element.innerText || '').trim()
      return /^(?:新聊天|new chat)$/iu.test(aria) || /^(?:新聊天|new chat)$/iu.test(text)
    })
    if (!target) return false
    target.click()
    return true
  })()`) === true
}

/**
 * 点击 ChatGPT 自己渲染的 Project 新聊天入口。
 *
 * 2026-10-09 真机 DOM 证据：侧栏按钮 aria-label 形如
 * `在 课堂录音→笔记 中开启新聊天`。这里不读取/伪造 gizmo_id，也不调用猜测的私有 API；
 * Project instructions 注入和提交 payload 全部交给官方 React 页面完成。
 */
async function clickProjectNewChatSpa(client: ActorCdpClient, projectName: string): Promise<boolean> {
  return await evaluateValue(client, `(async () => {
    const projectName = ${JSON.stringify(projectName)}
    const usable = (element) => {
      if (!element || !element.isConnected) return false
      const rect = element.getBoundingClientRect()
      if (rect.width < 1 || rect.height < 1) return false
      const ownStyle = window.getComputedStyle(element)
      if (ownStyle.pointerEvents === 'none') return false
      for (let node = element; node; node = node.parentElement) {
        if (!(node instanceof HTMLElement)) continue
        if (node.hidden || node.hasAttribute('inert')) return false
        const style = window.getComputedStyle(node)
        if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false
        if (Number.parseFloat(style.opacity || '1') <= 0.01) return false
        if (node === document.documentElement) break
      }
      const x = Math.min(window.innerWidth - 1, Math.max(0, rect.left + rect.width / 2))
      const y = Math.min(window.innerHeight - 1, Math.max(0, rect.top + rect.height / 2))
      const hit = document.elementFromPoint(x, y)
      if (hit && !element.contains(hit)) return false
      return true
    }
    // Project 行尾的“开启新聊天”动作在当前 Web DOM 中是 20px 图标按钮；真机观察到它
    // 本身 display/visibility/pointer-events 全部正常，但中心点会被同一 sidebar 行的包装 DIV
    // 命中。因此不能复用普通导航的 elementFromPoint 门，否则精确 aria action 会被误杀。
    // 这里仍严格检查尺寸、祖先 hidden/inert、display/visibility/opacity/pointer-events；并且只
    // 用于下面按**完整 aria-label**命中的 Project action，不放宽普通按钮。
    const usableExactProjectAction = (element) => {
      if (!element || !element.isConnected) return false
      const rect = element.getBoundingClientRect()
      if (rect.width < 1 || rect.height < 1) return false
      // 这是 Actor 自己通过 HTMLElement.click() 触发的一方按钮，不依赖鼠标命中测试。
      // 2026-10-10 当前 Web 会在 sidebar 图标按钮上临时/常驻设置 pointer-events:none，
      // 但元素本身仍是 React 绑定的真实 button，程序化 click 能正常进入 Project composer。
      // 因此这里不能再把 pointer-events 当成“Project 不存在”的判据。当前 Web 还会把
      // Project 行尾 hover action 包在 opacity=0 的 SPAN/DIV 里：元素仍有真实 20x20 rect，
      // React click handler 也仍挂载，只是等待鼠标 hover 才视觉显示。HTMLElement.click() 不受
      // CSS opacity 影响，所以这里同样不能用 opacity 过滤。仍保留尺寸、hidden/inert、
      // display:none 与 visibility:hidden/collapse，避免点击真正不可达的隐藏副本。
      for (let node = element; node; node = node.parentElement) {
        if (!(node instanceof HTMLElement)) continue
        if (node.hidden || node.hasAttribute('inert')) return false
        const style = window.getComputedStyle(node)
        if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false
        if (node === document.documentElement) break
      }
      return true
    }
    const exactZh = '在 ' + projectName + ' 中开启新聊天'
    const findTarget = () => {
      const buttons = [...document.querySelectorAll('button')]
      return buttons.find((button) => (
        button.getAttribute('aria-label') === exactZh && usableExactProjectAction(button)
      ))
        || buttons.filter(usableExactProjectAction).find((button) => {
          const identity = [button.getAttribute('aria-label') || '', button.innerText || ''].join(' ')
          return identity.includes(projectName) && /开启新聊天|new chat/iu.test(identity)
        })
        || null
    }
    const findSectionToggle = () => [...document.querySelectorAll('button')]
      .filter(usableExactProjectAction)
      .find((button) => {
        const identity = [button.getAttribute('aria-label') || '', button.innerText || ''].join(' ')
          .replace(/\s+/gu, ' ')
          .trim()
        return identity === '项目' || /^projects?$/iu.test(identity)
      }) || null

    // 后台 Guardian 中 React sidebar 可能出现短暂的“分组标题已存在，但 Project 子项正在重挂载”窗口。
    // 第一次没找到目标时绝不能立刻点击双向 toggle：如果当前本来就是 expanded=true，这一点击反而会
    // 主动把健康的 Project 区折叠起来。第一层恢复只做无副作用观察，给 React 一个很短的稳定窗口。
    let target = findTarget()
    const transientDeadline = Date.now() + 750
    while (!target && Date.now() < transientDeadline) {
      await new Promise(resolve => setTimeout(resolve, 50))
      target = findTarget()
    }

    if (!target) {
      const projectActionExistsInDom = [...document.querySelectorAll('button')].some((button) => {
        const aria = button.getAttribute('aria-label') || ''
        return aria === exactZh || (aria.includes(projectName) && /项目操作|project|开启新聊天|new chat/iu.test(aria))
      })
      const sectionToggle = findSectionToggle()
      const sectionExpanded = sectionToggle?.getAttribute('aria-expanded')

      // 只有浏览器明确报告 aria-expanded=false 时才允许展开。true 说明分组已经展开，此时 Project
      // 子项缺失应继续按 hydration/rerender 瞬态处理；缺少 aria-expanded 也 fail-closed，不猜状态。
      if (!projectActionExistsInDom && sectionToggle && sectionExpanded === 'false') {
        sectionToggle.click()
      }

      // 无论刚刚是明确从 collapsed 展开，还是分组本来就 expanded 但子项仍在重挂载，
      // 都只继续观察 DOM；这里不发网络请求、不 reload，也不触碰 composer。
      const stableDeadline = Date.now() + 2_000
      while (!target && Date.now() < stableDeadline) {
        await new Promise(resolve => setTimeout(resolve, 100))
        target = findTarget()
      }
    }
    if (!target) return false
    target.click()
    return true
  })()`) === true
}

function isProjectRouteUrl(href: string): boolean {
  try {
    const pathname = new URL(href).pathname
    return /^\/(?:g\/g-p-[^/]+(?:\/project)?|projects?(?:\/|$))/iu.test(pathname)
  }
  catch {
    return false
  }
}

async function waitForProjectRoute(client: ActorCdpClient, timeoutMs: number): Promise<ActorPageSnapshot> {
  const deadline = Date.now() + timeoutMs
  let lastSnapshot: ActorPageSnapshot | null = null
  while (Date.now() < deadline) {
    const snapshot = await readActorPageSnapshot(client)
    lastSnapshot = snapshot
    if (snapshot.conversationId === null && isProjectRouteUrl(snapshot.href) && snapshot.composerHydrated) {
      return snapshot
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`ChatGPT actor project route did not become ready before timeout: lastSnapshot=${JSON.stringify(lastSnapshot)}`)
}

/**
 * 优先点击 sidebar 中已经存在的 canonical conversation 链接，让 ChatGPT 自己的 React Router
 * 完成 same-document/SPA 切换；只有目标不在当前 sidebar DOM 时才允许 full-navigation fallback。
 */
async function clickConversationSpa(client: ActorCdpClient, conversationId: string): Promise<boolean> {
  return await evaluateValue(client, `(() => {
    const wanted = ${JSON.stringify(`/c/${conversationId}`)}
    const usable = (element) => {
      if (!element || !element.isConnected) return false
      const rect = element.getBoundingClientRect()
      if (rect.width < 1 || rect.height < 1) return false
      const ownStyle = window.getComputedStyle(element)
      if (ownStyle.pointerEvents === 'none') return false
      for (let node = element; node; node = node.parentElement) {
        if (!(node instanceof HTMLElement)) continue
        if (node.hidden || node.hasAttribute('inert')) return false
        const style = window.getComputedStyle(node)
        if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false
        if (Number.parseFloat(style.opacity || '1') <= 0.01) return false
        if (node === document.documentElement) break
      }
      const x = Math.min(window.innerWidth - 1, Math.max(0, rect.left + rect.width / 2))
      const y = Math.min(window.innerHeight - 1, Math.max(0, rect.top + rect.height / 2))
      const hit = document.elementFromPoint(x, y)
      if (hit && !element.contains(hit)) return false
      return true
    }
    const target = [...document.querySelectorAll('a[href]')].find((anchor) => {
      if (!usable(anchor)) return false
      try { return new URL(anchor.href, location.href).pathname === wanted }
      catch { return false }
    })
    if (!target) return false
    target.click()
    return true
  })()`) === true
}

async function waitForRoute(
  client: ActorCdpClient,
  conversationId: string | null,
  timeoutMs: number,
): Promise<ActorPageSnapshot> {
  const deadline = Date.now() + timeoutMs
  let lastSnapshot: ActorPageSnapshot | null = null
  while (Date.now() < deadline) {
    const snapshot = await readActorPageSnapshot(client)
    lastSnapshot = snapshot
    const routeMatches = conversationId
      ? snapshot.conversationId === conversationId
      : snapshot.conversationId === null && new URL(snapshot.href).pathname === '/'
    if (routeMatches && snapshot.composerHydrated) return snapshot
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  // snapshot 不含正文，只保留 route/composer/状态布尔值；把它带进错误可以直接区分
  // “路由没到”“CID 识别错”“可见 composer 未 hydration”，避免生产 E2E 只能靠二次 CDP 猜测。
  throw new Error(
    `ChatGPT actor route did not become ready before timeout: ${conversationId ?? 'new-chat'}; `
    + `lastSnapshot=${JSON.stringify(lastSnapshot)}`,
  )
}

async function preserveGuardianMarker(client: ActorCdpClient, hadGuardianMarker: boolean): Promise<void> {
  if (!hadGuardianMarker) return
  await evaluateValue(client, `(() => {
    const url = new URL(location.href)
    if (url.searchParams.get('chatgpt-archive-guardian') === '1') return true
    url.searchParams.set('chatgpt-archive-guardian', '1')
    history.replaceState(history.state, '', url.pathname + url.search + url.hash)
    return true
  })()`)
}

/**
 * 返回实际导航方式，供 trace/drift 诊断使用。
 * `spa-*` 是首选；`full-fallback` 只在 sidebar 没有目标链接时使用，后续可继续用 sidebar 搜索补齐。
 */
async function ensureActorRoute(
  client: ActorCdpClient,
  conversationId: string | null,
  timeoutMs: number,
  projectName: string | null = null,
  targetMode: ActorTargetMode = 'guardian',
): Promise<{ snapshot: ActorPageSnapshot; navigationMode: 'already-there' | 'spa-new' | 'spa-project' | 'spa-conversation' | 'full-fallback' }> {
  const before = await waitForHealthyActorShell(client, timeoutMs, targetMode)
  const hadGuardianMarker = (() => {
    try { return new URL(before.href).searchParams.get('chatgpt-archive-guardian') === '1' }
    catch { return false }
  })()

  if (projectName) {
    if (conversationId) throw new Error('actor project new-chat cannot be combined with --conversation')
    const clickedProject = await clickProjectNewChatSpa(client, projectName)
    if (!clickedProject) throw new Error(`ChatGPT actor project not found or not visible in sidebar: ${projectName}`)
    const snapshot = await waitForProjectRoute(client, timeoutMs)
    await preserveGuardianMarker(client, hadGuardianMarker)
    return { snapshot, navigationMode: 'spa-project' }
  }
  const alreadyThere = conversationId
    ? before.conversationId === conversationId
    : before.conversationId === null && new URL(before.href).pathname === '/'

  if (alreadyThere) {
    // 路由已经正确时绝不能因为 composer 尚未 hydration 就再次 Page.navigate 同一个 URL。
    // ChatGPT 在 SPA 切换/后台 tab 恢复时会短暂出现“URL 已到、DOM 还是空壳”的窗口；
    // 此时 reload 只会重建 Guardian transport，并把本来快完成的 hydration 重新打断。
    if (before.composerHydrated) return { snapshot: before, navigationMode: 'already-there' }
    const snapshot = await waitForRoute(client, conversationId, timeoutMs)
    return { snapshot, navigationMode: 'already-there' }
  }

  const clicked = conversationId
    ? await clickConversationSpa(client, conversationId)
    : await clickNewChatSpa(client)
  if (clicked) {
    const snapshot = await waitForRoute(client, conversationId, timeoutMs)
    await preserveGuardianMarker(client, hadGuardianMarker)
    return { snapshot, navigationMode: conversationId ? 'spa-conversation' : 'spa-new' }
  }

  const targetUrl = actorNavigationUrl(conversationId, before.href)
  await client.send('Page.navigate', { url: targetUrl })
  const snapshot = await waitForRoute(client, conversationId, timeoutMs)
  return { snapshot, navigationMode: 'full-fallback' }
}

async function neutralizeGuardianAfterSubmit(
  client: ActorCdpClient,
  input: {
    mode: ActorSendMode
    targetMode: ActorTargetMode
    firstDataAt: number | null
    timeoutMs: number
  },
): Promise<{ neutralized: boolean; reason: string; href: string | null }> {
  if (input.targetMode !== 'guardian') {
    return { neutralized: false, reason: 'not-guardian', href: null }
  }
  if (!shouldNeutralizeGuardianAfterSubmit(input)) {
    return { neutralized: false, reason: 'sse-first-data-not-observed', href: null }
  }

  let before: ActorPageSnapshot
  try {
    before = await readActorPageSnapshot(client)
  }
  catch (error) {
    return {
      neutralized: false,
      reason: 'snapshot-failed:' + (error instanceof Error ? error.message : String(error)),
      href: null,
    }
  }

  const guardianHome = 'https://chatgpt.com/?chatgpt-archive-guardian=1'
  try {
    const currentUrl = new URL(before.href)
    if (before.conversationId === null && currentUrl.pathname === '/') {
      await preserveGuardianMarker(client, true)
      const href = String(await evaluateValue(client, 'location.href') || before.href || guardianHome)
      return { neutralized: true, reason: 'already-neutral', href }
    }
  }
  catch { /* non-standard URL falls through to active recovery */ }

  const fullNavigateHome = async (reason: string) => {
    await client.send('Page.navigate', { url: guardianHome })
    const snapshot = await waitForRoute(client, null, Math.min(input.timeoutMs, 5_000))
    const href = String(await evaluateValue(client, 'location.href') || snapshot.href || guardianHome)
    return { neutralized: true, reason, href }
  }

  try {
    const clicked = await clickNewChatSpa(client)
    if (!clicked) return await fullNavigateHome('full-new-after-spa-unavailable')
    const snapshot = await waitForRoute(client, null, Math.min(input.timeoutMs, 5_000))
    await preserveGuardianMarker(client, true)
    const href = String(await evaluateValue(client, 'location.href') || snapshot.href || guardianHome)
    return { neutralized: true, reason: 'spa-new-ready', href }
  }
  catch (spaError) {
    try {
      return await fullNavigateHome('full-new-after-spa-failure')
    }
    catch (fullError) {
      return {
        neutralized: false,
        reason: 'guardian-neutralize-failed:'
          + (spaError instanceof Error ? spaError.message : String(spaError))
          + '; full-navigation:'
          + (fullError instanceof Error ? fullError.message : String(fullError)),
        href: before.href,
      }
    }
  }
}

/**
 * 清理 Guardian 专用页面上的旧草稿。导航回首页并不会保证 React/ProseMirror 丢弃草稿，
 * 因而下一个 ClassFlow 任务必须在输入前确认编辑器已清空。
 *
 * 使用浏览器原生编辑命令触发真实的编辑事件；不能直接赋值 innerHTML/textContent，
 * 否则可能造成 DOM 看起来已清空、React 内部状态仍保存旧文本的分裂。
 */
async function clearGuardianComposerDraft(client: ActorCdpClient): Promise<boolean> {
  const before = await readActorPageSnapshot(client)
  if (!before.composerHasText) return true
  const deleted = await evaluateValue(client, `(() => {
    const input = ${ACTOR_VISIBLE_COMPOSER_EXPRESSION}
    if (!input) return false
    input.focus()
    if (document.activeElement !== input) return false
    if (input instanceof HTMLTextAreaElement) {
      input.setSelectionRange(0, input.value.length)
    }
    else {
      const selection = window.getSelection()
      if (!selection) return false
      const range = document.createRange()
      range.selectNodeContents(input)
      selection.removeAllRanges()
      selection.addRange(range)
    }
    return document.execCommand('delete', false, null)
  })()`)
  // 后台标签页可能拒绝 execCommand，即使同样操作在前台 CDP 测试中成功。
  // 返回 false 时让后续 Range 全选 + Input.insertText 接管；绝不因此直接发送。
  if (deleted !== true) return false
  // 后台 React 可能在下一个 render 恢复旧值：连续观察几次，避免刚删完就插入。
  for (let check = 0; check < 3; check++) {
    await new Promise(resolve => setTimeout(resolve, 100))
    if (!(await readActorPageSnapshot(client)).composerHasText) return true
  }
  return false
}

/**
 * 仅在正式 POST 尚未启动时复位失败的 Guardian 页面。
 * 此时不存在可能正在生成的本轮回答，因此可安全退回无 conversation Body 的首页。
 * 已开始正式 POST 的情形绝不能在这里导航，以免中断结果未知的 SSE。
 */
async function resetGuardianAfterPrePostFailure(client: ActorCdpClient): Promise<void> {
  const homeUrl = 'https://chatgpt.com/?chatgpt-archive-guardian=1'
  const href = String(await evaluateValue(client, 'location.href') || '')
  let isHome = false
  try { isHome = new URL(href).pathname === '/' }
  catch { /* 无效文档直接导航首页 */ }
  if (!isHome) await client.send('Page.navigate', { url: homeUrl }, 5_000)
  await waitForRoute(client, null, 3_500)
  await clearGuardianComposerDraft(client)
}

/**
 * ChatGPT 可能先渲染 /c/<CID>，再异步改写为 /g/<Project>/c/<CID>。
 * 在旧路由的 composer 刚出现就开始插入长文本，会被后续 React 重挂载清空、截断。
 * 因此要求 URL 和真实 contenteditable 节点连续稳定一小段时间，才允许输入。
 * 这里只读观察 DOM，不增加任何 Body GET 或额外页面导航。
 */
async function waitForStableActorComposer(client: ActorCdpClient, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + Math.max(3_000, timeoutMs)
  const stableMs = 1_200
  let lastSignature: string | null = null
  let stableSince = 0
  while (Date.now() < deadline) {
    const snapshot = await evaluateValue(client, `(() => {
      const input = ${ACTOR_VISIBLE_COMPOSER_EXPRESSION}
      const bounds = input?.getBoundingClientRect()
      return {
        href: String(location.href),
        ready: Boolean(input && input.isConnected && document.readyState !== 'loading'),
        editorWidth: bounds ? Math.round(bounds.width) : 0,
      }
    })()`)
    const now = Date.now()
    // React 会在同一 URL 和相同尺寸下反复创建新的编辑器 DOM 对象，
    // 因而不能把“节点引用没变”当成稳定前提，否则会无休止地等待。
    // 只校验 URL、就绪状态和可见编辑器几何形态；逐块真实文本反馈负责
    // 处理后续可能发生的重挂载或焦点漂移。
    const signature = snapshot?.ready ? `${snapshot.href}|${snapshot.editorWidth}` : null
    if (!signature || signature !== lastSignature) {
      stableSince = now
      lastSignature = signature
    }
    else if (now - stableSince >= stableMs) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`ChatGPT actor composer or project route did not stabilize before input (lastSignature=${lastSignature ?? 'none'})`)
}

async function clearAndTypePrompt(
  client: ActorCdpClient,
  prompt: string,
  inputChunkChars = 512,
): Promise<{ inputChunks: number; inputCharacters: number; inputElapsedMs: number }> {
  const focused = await evaluateValue(client, `(() => {
    const usable = (element) => {
      if (!element || !element.isConnected) return false
      const rect = element.getBoundingClientRect()
      if (rect.width < 1 || rect.height < 1) return false
      const ownStyle = window.getComputedStyle(element)
      if (ownStyle.pointerEvents === 'none') return false
      for (let node = element; node; node = node.parentElement) {
        if (!(node instanceof HTMLElement)) continue
        if (node.hidden || node.hasAttribute('inert')) return false
        const style = window.getComputedStyle(node)
        if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false
        if (Number.parseFloat(style.opacity || '1') <= 0.01) return false
        if (node === document.documentElement) break
      }
      // 与 readActorPageSnapshot() 使用同一套 composer 语义。
      // 长课堂文本会让 contenteditable 的几何高度膨胀到数万像素；此时取 rect 中心点再做
      // elementFromPoint() 会命中正文/背景层，导致“页面状态说 composer 已就绪，但真正填词时
      // 又说 input not found”的自相矛盾。输入框是否属于第一方 data-chatgpt-composer form
      // 才是这里稳定且已经过真机验证的判据。
      return Boolean(element.closest('form[data-chatgpt-composer]'))
    }
    const input = [
      ...document.querySelectorAll('textarea[aria-label="与 ChatGPT 聊天"]'),
      ...document.querySelectorAll('#prompt-textarea'),
      ...document.querySelectorAll('[contenteditable="true"][role="textbox"]'),
      ...document.querySelectorAll('textarea'),
    ].find(usable) || null
    if (!input) return false
    input.focus()
    return true
  })()`)
  if (focused !== true) throw new Error('ChatGPT actor prompt input not found')

  // 输入前显式抹除上次失败留下的草稿，再通过真实 CDP 按块插入本轮正文。
  // 仅靠 Range 全选 + 首块覆盖，在 React 后台恢复草稿时可能留下旧内容。
  await clearGuardianComposerDraft(client)

  // 用真实键盘清空 React composer，再走 CDP insertText；不直接篡改 textarea.value，避免绕过状态层。
  // 后台 Guardian 里 Ctrl+A/Backspace 的 CDP ACK 并不意味着 ProseMirror 已清空。
  // 使用真实选区 + 输入事件覆盖文档，避免多次重试把提示词重复累加。
  // 每块真实输入后直接从 ProseMirror 读取完整已输入前缀，进行严格逐字比对。
  // 若 CDP 命令超时但实际内容正确，则只记账不重复插入；如果发现丢字、重复或失焦，
  // 仅允许一次从头全选重建。连续两次不一致就 fail-closed，绝不会执行正式 POST。
  const editorExpression = `(() => {
    const input = ${ACTOR_VISIBLE_COMPOSER_EXPRESSION}
    if (!input) return null
    if (input instanceof HTMLTextAreaElement) return input.value.replace(/\\r\\n?/g, '\\n')
    const readInline = node => {
      if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || ''
      if (node.nodeName === 'BR') return node.classList?.contains('ProseMirror-trailingBreak') ? '' : '\\n'
      return [...node.childNodes].map(readInline).join('')
    }
    return [...input.children].map(readInline).join('\\n')
  })()`
  const position = (atEnd: boolean) => `(() => {
    const input = ${ACTOR_VISIBLE_COMPOSER_EXPRESSION}
    if (!input || !input.isConnected) return false
    input.focus()
    if (document.activeElement !== input) return false
    if (input instanceof HTMLTextAreaElement) {
      input.setSelectionRange(${atEnd ? 'input.value.length, input.value.length' : '0, input.value.length'})
      return true
    }
    const selection = window.getSelection()
    if (!selection) return false
    const range = document.createRange()
    range.selectNodeContents(input)
    ${atEnd ? 'range.collapse(false)' : ''}
    selection.removeAllRanges()
    selection.addRange(range)
    return true
  })()`
  return await inputActorPromptWithFeedback(prompt, inputChunkChars, {
    selectAll: async () => (await evaluateValue(client, position(false))) === true,
    focusAtEnd: async () => (await evaluateValue(client, position(true))) === true,
    insertText: async text => { await client.send('Input.insertText', { text }, 15_000) },
    readText: async () => await evaluateValue(client, editorExpression),
    settle: async first => { await new Promise(resolve => setTimeout(resolve, first ? 300 : 100)) },
    recoverBeforeRewrite: async () => {
      await waitForStableActorComposer(client, 6_000)
      // 这个清理动作可能被隐藏页拒绝，因此它不是唯一清理路径：后续全选+覆盖
      // 仍要被每个分块的真实 DOM 前缀验证。若无法恢复，控制器终止而非发送。
      await clearGuardianComposerDraft(client)
    },
  })
}

async function clickSendHandler(client: ActorCdpClient): Promise<void> {
  const result = await evaluateValue(client, `(() => {
    const usable = (element) => {
      if (!element || !element.isConnected) return false
      const rect = element.getBoundingClientRect()
      if (rect.width < 1 || rect.height < 1) return false
      const ownStyle = window.getComputedStyle(element)
      if (ownStyle.pointerEvents === 'none') return false
      for (let node = element; node; node = node.parentElement) {
        if (!(node instanceof HTMLElement)) continue
        if (node.hidden || node.hasAttribute('inert')) return false
        const style = window.getComputedStyle(node)
        if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false
        if (Number.parseFloat(style.opacity || '1') <= 0.01) return false
        if (node === document.documentElement) break
      }
      // 发送阶段必须与 hydration / 填词阶段共享同一 composer 身份判定；否则超长课堂
      // 转写虽然已经成功填入，也可能因为 contenteditable 的超大 rect 再次被 pixel hit-test
      // 误判成“send button unavailable”。
      return Boolean(element.closest('form[data-chatgpt-composer]'))
    }
    const input = [
      ...document.querySelectorAll('#prompt-textarea'),
      ...document.querySelectorAll('[contenteditable="true"][role="textbox"]'),
      ...document.querySelectorAll('textarea'),
    ].find(usable) || null
    const form = input?.closest('form') || null
    if (!form || !form.hasAttribute('data-chatgpt-composer')) return false
    const usableComposerButton = (button) => {
      if (!button || !button.isConnected || button.disabled) return false
      const rect = button.getBoundingClientRect()
      if (rect.width < 1 || rect.height < 1) return false
      const ownStyle = window.getComputedStyle(button)
      if (ownStyle.display === 'none' || ownStyle.visibility === 'hidden' || ownStyle.visibility === 'collapse') return false
      if (Number.parseFloat(ownStyle.opacity || '1') <= 0.01 || ownStyle.pointerEvents === 'none') return false
      for (let node = button; node && node !== form; node = node.parentElement) {
        if (!(node instanceof HTMLElement)) continue
        if (node.hidden || node.hasAttribute('inert')) return false
        const style = window.getComputedStyle(node)
        if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false
        if (Number.parseFloat(style.opacity || '1') <= 0.01) return false
      }
      return true
    }
    const identity = (button) => [
      button.getAttribute('data-testid') || '',
      button.getAttribute('aria-label') || '',
      button.getAttribute('title') || '',
      (button.innerText || '').trim(),
    ].join(' ')
    const button = [...form.querySelectorAll('button')]
      .filter(usableComposerButton)
      .find((candidate) => {
        const text = identity(candidate)
        if (/stop|停止/iu.test(text)) return false
        return /send-button|(^|\\s)(send|发送)(\\s|$)/iu.test(text)
          || (candidate.getAttribute('type') === 'submit' && !candidate.disabled)
      }) || null
    if (!button || button.disabled) return false
    button.click()
    return true
  })()`)
  if (result !== true) throw new Error('ChatGPT actor send button unavailable or disabled')
}

/**
 * prepare 返回以后，当前 ChatGPT Web 会让发送按钮经历一个很短的 disabled/重挂载窗口。
 * 第二阶段 submit 必须等按钮重新可用；否则“prepare 已成功”会被误判成发送失败。
 */
async function isSendButtonReady(client: ActorCdpClient): Promise<boolean> {
  return (await readActorPageSnapshot(client)).sendReady
}

async function waitForSendButtonReady(client: ActorCdpClient, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isSendButtonReady(client)) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('ChatGPT actor send button did not become ready before timeout')
}

async function sendActorPromptUnlocked(options: ActorSendOptions): Promise<Record<string, unknown>> {
  const timeoutMs = options.timeoutMs ?? 20_000
  if (!options.prompt.trim()) throw new Error('actor prompt is empty')
  const requestedMode = options.mode ?? 'auto'
  const targetMode = options.targetMode ?? 'guardian'
  const expectedConversationId = options.conversationId ? String(options.conversationId).trim() : null
  const projectName = normalizeActorProjectName(options.projectName)
  if (expectedConversationId) actorConversationUrl(expectedConversationId)
  if (projectName && expectedConversationId) throw new Error('actor --project cannot be combined with --conversation')
  if (projectName && requestedMode !== 'auto' && requestedMode !== 'new') {
    throw new Error('actor --project is only valid with --mode new|auto')
  }
  await assertActorCooldownClear(options.daemonStatePath)
  const target = await acquireActorTarget(
    options.cdpHttp,
    options.statePath,
    timeoutMs,
    targetMode,
    options.daemonStatePath,
  )
  const targetId = String(target.id ?? target.targetId)
  if (!target.webSocketDebuggerUrl) throw new Error('actor target has no webSocketDebuggerUrl')

  const client = new ActorCdpClient(target.webSocketDebuggerUrl)
  await client.connect()
  let focusEmulationEnabled = false
  try {
    // Guardian 隐藏窗口可能让 document.hasFocus() 长时间为 false。
    // 临时模拟焦点，确保可见 ProseMirror 能被原生光标与选区操作。
    // 这个本地 CDP 命令不发 ChatGPT 后端请求，也不创建新标签页。
    await client.send('Emulation.setFocusEmulationEnabled', { enabled: true }, 5_000)
    focusEmulationEnabled = true
    // `Page.enable` / `Runtime.enable` 都不是当前 Actor 的必要条件。生产 canary 已证实后台
    // Guardian 会偶发只在这些无关 ACK 上超时；把它们当硬门闩会让一次完全没碰 UI 的发送
    // 直接失败。真正必须先建立的是 Network observer，因为后续正式 POST/HTTP/SSE 全靠它验收。
    await enableActorNetworkDomain(
      (method, params, commandTimeoutMs) => client.send(method, params, commandTimeoutMs),
      { commandTimeoutMs: Math.min(5_000, Math.max(1_000, timeoutMs)) },
    )
    const domLedger = options.domLedgerPath
      ? await ActorDomDriftLedger.open(options.domLedgerPath)
      : null

    // 任何导航/输入/点击之前先采一份当前页骨架。baseline 锁定后若这里已经漂移，
    // Actor 必须在真正改变页面之前停止，不能“先点了再告诉用户 DOM 变了”。
    const domSignatureBefore = await observeActorDomShape(
      client,
      domLedger,
      'navigation',
      options.onDomDrift,
      { allowTransient: true },
    )

    // Network listener 必须在 SPA 导航之前挂好：旧 conversation 切换时第一方页面会自己读取
    // conversation body。这个响应是“上下文已经真正到达浏览器”的强闭环证据，不能导航完以后再补监听。
    const contextBodyRequestIds = new Set<string>()
    let contextBodyResponseAt: number | null = null
    let contextBodyStatus: number | null = null
    let sendArmedAt = 0
    let formalRequestUrl: string | null = null
    const submitState: { event: { at: number; requestId: string } | null } = { event: null }
    const prepareState: {
      requestId: string | null
      status: number | null
      respondedAt: number | null
    } = { requestId: null, status: null, respondedAt: null }
    // 和 submitState 一样，用显式 holder 表达“CDP 回调稍后填值”。
    // TypeScript 不会把跨回调赋值错误收窄成永远为 null/never，也更贴近运行时事实。
    const responseState: { status: number | null; mimeType: string | null; retryAfter: string | null } = {
      status: null,
      mimeType: null,
      retryAfter: null,
    }
    // 一旦正式 POST 已拿到 2xx + conversationId，就越过“不可自动重发”的提交点。
    // 后续本地诊断/neutralize/trace 即使失败，也只能降级记录，不能把整个 send 判失败后再次 POST。
    let acceptedConversationId: string | null = null
    let acceptedBoundAt: number | null = null
    let firstDataAt: number | null = null
    const conversationRequestUrl = 'https://chatgpt.com/backend-api/f/conversation'
    const steerRequestUrl = 'https://chatgpt.com/backend-api/f/steer_turn'
    const prepareRequestUrl = `${conversationRequestUrl}/prepare`

    const offRequest = client.on('Network.requestWillBeSent', (event) => {
      const requestUrl = String(event?.request?.url || '')
      const requestMethod = String(event?.request?.method || '')
      if (
        expectedConversationId
        && requestMethod === 'GET'
        && requestUrl.startsWith(`https://chatgpt.com/backend-api/conversations/${expectedConversationId}`)
      ) {
        contextBodyRequestIds.add(String(event.requestId))
      }
      if (!sendArmedAt || Date.now() < sendArmedAt) return
      if (event?.request?.method === 'POST' && event?.request?.url === prepareRequestUrl) {
        // 同一次 actor send 最多关心第一条 prepare；后续若前端自己重试，不让它覆盖初始证据。
        if (!prepareState.requestId) prepareState.requestId = String(event.requestId)
        return
      }
      if (submitState.event) return
      if (event?.request?.method !== 'POST' || event?.request?.url !== formalRequestUrl) return
      submitState.event = { at: Date.now(), requestId: String(event.requestId) }
    })
    const offResponse = client.on('Network.responseReceived', (event) => {
      if (contextBodyRequestIds.has(String(event?.requestId))) {
        contextBodyStatus = Number(event?.response?.status ?? 0) || null
        if (contextBodyStatus !== null && contextBodyStatus >= 200 && contextBodyStatus < 300) {
          contextBodyResponseAt = Date.now()
        }
      }
      if (prepareState.requestId && String(event?.requestId) === prepareState.requestId) {
        prepareState.status = Number(event?.response?.status ?? 0) || null
        prepareState.respondedAt = Date.now()
        return
      }
      const submitEvent = submitState.event
      if (!submitEvent || String(event?.requestId) !== submitEvent.requestId) return
      responseState.status = Number(event?.response?.status ?? 0) || null
      responseState.mimeType = typeof event?.response?.mimeType === 'string' ? event.response.mimeType : null
      const retryAfter = event?.response?.headers?.['retry-after'] ?? event?.response?.headers?.['Retry-After']
      responseState.retryAfter = typeof retryAfter === 'string' && retryAfter.trim() ? retryAfter.trim() : null
    })
    const offData = client.on('Network.dataReceived', (event) => {
      const submitEvent = submitState.event
      if (!submitEvent || String(event?.requestId) !== submitEvent.requestId || firstDataAt !== null) return
      if (Number(event?.dataLength ?? event?.encodedDataLength ?? 0) > 0) firstDataAt = Date.now()
    })

    try {
      const route = await ensureActorRoute(client, expectedConversationId, timeoutMs, projectName, targetMode)
      await waitForComposer(client, timeoutMs)

      // 旧 conversation 只有“路由已到位”还不够。至少要看到真实 message DOM；若本次切换产生了
      // body GET，则同时等待它 2xx。active late-attach 若出现“等待完整答复”横幅，直接拒绝发送，
      // 因为这正是用户实测最容易造成 follow-up 上下文裁剪的状态。
      let routeSnapshot = route.snapshot
      let contextReadyAt = Date.now()
      if (expectedConversationId) {
        const contextDeadline = Date.now() + timeoutMs
        while (Date.now() < contextDeadline) {
          routeSnapshot = await readActorPageSnapshot(client)
          if (routeSnapshot.waitingForFinal) {
            throw new Error('ChatGPT actor refused: conversation is waiting for full answer; current context is incomplete')
          }
          const bodyGateSatisfied = contextBodyRequestIds.size === 0
            || (contextBodyResponseAt !== null && contextBodyStatus !== null && contextBodyStatus >= 200 && contextBodyStatus < 300)
          if (routeSnapshot.composerHydrated && routeSnapshot.messageNodes > 0 && bodyGateSatisfied) {
            contextReadyAt = Date.now()
            break
          }
          await new Promise(resolve => setTimeout(resolve, 100))
        }
        if (!routeSnapshot.composerHydrated || routeSnapshot.messageNodes === 0) {
          throw new Error('ChatGPT actor conversation context did not finish rendering before timeout')
        }
        if (contextBodyRequestIds.size > 0 && contextBodyResponseAt === null) {
          throw new Error(`ChatGPT actor conversation body did not load successfully (status=${contextBodyStatus ?? 'unknown'})`)
        }
        if (contextBodyRequestIds.size > 0 && contextBodyStatus !== null
          && (contextBodyStatus < 200 || contextBodyStatus >= 300)) {
          // UI 在 429 时可能仍显示旧的 composer/消息 DOM，不能据此越过正文加载门。
          throw new Error(`ChatGPT actor conversation body did not load successfully (status=${contextBodyStatus})`)
        }
      }

      const mode = resolveActorSendMode({
        requestedMode,
        requestedConversationId: expectedConversationId,
        currentConversationId: routeSnapshot.conversationId,
        stopVisible: routeSnapshot.stopVisible,
        waitingForFinal: routeSnapshot.waitingForFinal,
      })
      formalRequestUrl = mode === 'steer' ? steerRequestUrl : conversationRequestUrl

      // 等待 /c/<CID> → /g/<Project>/c/<CID> 的前端跳转彻底稳定，
      // 否则第一次 Input.insertText 即使 ACK，也可能被路由重挂载抹掉。
      await waitForStableActorComposer(client, timeoutMs)

      // 目标 route/context 已经真正 ready 后再采第二份结构指纹。第一份保护“怎么导航”，
      // 第二份保护“怎么发送”；两者都通过以后才允许把 prompt 写入页面。
      const domSignatureReady = await observeActorDomShape(client, domLedger, 'prompt input', options.onDomDrift)

      // 短 Summary/Title 默认一次完整插入，避免 513 字符被拆为 512+1，
      // 产生一次毫无必要的焦点切换、并可能吞掉最后一个汉字。
      // 长 ASR 仍保留 512 字符分块；显式 inputChunkChars 配置始终优先。
      const defaultChunk = Array.from(options.prompt.replace(/\r\n?/gu, '\n')).length <= 2048 ? 2048 : 512
      const inputStats = await clearAndTypePrompt(client, options.prompt, options.inputChunkChars ?? defaultChunk)
      // hidden/background target 可能因为 React 后台调度延迟挂载 submit 控件；这里等“状态变成可提交”，
      // 但最终成功仍以 Network 正式 POST + 2xx 为准，而不是按钮本身。
      await waitForSendButtonReady(client, timeoutMs)
      const pageUrlBefore = String(await evaluateValue(client, 'location.href') || actorConversationUrl(expectedConversationId))

      let sendHandlerAttempts = 1
      let retriedAfterPrepare = false
      // 在导航、长文本分块输入期间，其他 Archive 请求可能已收到新的 Retry-After。
      // 正式 POST 前再检查一次，防止仅靠入口检查绕过服务端冷却。
      await assertActorCooldownClear(options.daemonStatePath)
      sendArmedAt = Date.now()
      await clickSendHandler(client)
      const deadline = Date.now() + timeoutMs
      let conversationId: string | null = null
      let boundAt = 0
      while (Date.now() < deadline) {
        const href = String(await evaluateValue(client, 'location.href') || '')
        conversationId = expectedConversationId || conversationIdFromUrl(href)
        const submitEvent = submitState.event
        if (submitEvent && responseState.status === 429 && options.onRateLimit) {
          const cooldownUntil = await options.onRateLimit({
            mode,
            requestUrl: formalRequestUrl,
            requestId: submitEvent.requestId,
            status: responseState.status,
            retryAfter: responseState.retryAfter,
          })
          if (Number.isFinite(Number(cooldownUntil)) && Number(cooldownUntil) > Date.now()) {
            throw new Error(
              'ChatGPT actor blocked by active API cooldown until '
              + new Date(Number(cooldownUntil)).toISOString(),
            )
          }
        }
        if (submitEvent && responseState.status !== null && responseState.status >= 400) {
          throw new Error(`ChatGPT actor ${mode} request failed with HTTP ${responseState.status}`)
        }
        if (submitEvent && conversationId && responseState.status !== null && responseState.status >= 200 && responseState.status < 300) {
          if (!actorResponseMimeAccepted(mode, responseState.mimeType)) {
            const expectedMime = mode === 'steer' ? 'application/json' : 'text/event-stream'
            throw new Error(`ChatGPT actor ${mode} response drifted from ${expectedMime}: ${responseState.mimeType}`)
          }
          boundAt = Date.now()
          acceptedConversationId = conversationId
          acceptedBoundAt = boundAt
          // 对 new/continue，给真实 SSE 首个 data 一个很短的接管窗口。若没看到首包，发送本身仍然
          // 成功，但 Guardian 保留在当前 conversation，避免 cleanup 过早 abort 一个尚未稳定的流。
          if (mode !== 'steer' && firstDataAt === null) {
            const attachDeadline = Math.min(deadline, Date.now() + 2_000)
            while (firstDataAt === null && Date.now() < attachDeadline) {
              await new Promise(resolve => setTimeout(resolve, 25))
            }
          }
          const runningConfirmed = Boolean(
            firstDataAt
            || responseState.mimeType?.includes('event-stream')
            || (await readActorPageSnapshot(client)).stopVisible,
          )
          const postSubmit = await neutralizeGuardianAfterSubmit(client, {
            mode,
            targetMode,
            firstDataAt,
            timeoutMs,
          })
          const recorder = new ActiveTurnRecorder(options.tracePath)
          await recorder.append(buildActorSubmitTrace({
            submittedAt: submitEvent.at,
            boundAt,
            conversationId,
            actorTargetId: targetId,
            mode,
            targetMode,
            navigationMode: route.navigationMode,
            prepareRequestId: prepareState.requestId,
            prepareStatus: prepareState.status,
            sendHandlerAttempts,
            cdpRequestId: submitEvent.requestId,
            responseStatus: responseState.status,
            responseMimeType: responseState.mimeType,
            pageUrlBefore,
            contextReadyAt,
            firstDataAt,
            runningConfirmed,
            postSubmitNeutralized: postSubmit.neutralized,
            postSubmitNeutralizeReason: postSubmit.reason,
            pageUrlAfter: postSubmit.href,
          }))
          const prior = await readActorState(options.statePath)
          await writeActorState(options.statePath, {
            targetId,
            createdAt: prior?.createdAt ?? Date.now(),
            updatedAt: Date.now(),
            source: prior?.source ?? targetMode,
            lastSubmittedAt: submitEvent.at,
          })
          return {
            targetId,
            conversationId,
            submittedAt: submitEvent.at,
            boundAt,
            bindDelayMs: boundAt - submitEvent.at,
            cdpRequestId: submitEvent.requestId,
            prepareRequestId: prepareState.requestId,
            prepareStatus: prepareState.status,
            sendHandlerAttempts,
            responseStatus: responseState.status,
            responseMimeType: responseState.mimeType,
            pageUrlBefore,
            mode,
            projectName,
            navigationMode: route.navigationMode,
            contextReadyAt,
            contextBodyResponseAt,
            contextBodyStatus,
            firstDataAt,
            runningConfirmed,
            postSubmitNeutralized: postSubmit.neutralized,
            postSubmitNeutralizeReason: postSubmit.reason,
            pageUrlAfter: postSubmit.href,
            targetMode,
            ...inputStats,
            domSignatureBefore,
            domSignatureReady,
          }
        }

        // 2026-09-19 当前 Web composer 的真实行为：一个全新/hidden actor 首次调用 send handler
        // 可能只发 `/f/conversation/prepare`。手工 CDP 已复现：prepare=200 后按钮仍可用，第二次
        // 调用同一个页面 handler 才发正式 `/f/conversation` SSE。因此只在“prepare 已明确成功，
        // 且正式 POST 仍不存在”时补一次 handler 调用；绝不按时间盲目连点。
        if (
          !submitState.event
          && !retriedAfterPrepare
          && prepareState.respondedAt !== null
          && prepareState.status !== null
          && prepareState.status >= 200
          && prepareState.status < 300
        ) {
          // prepare response 到达时按钮可能还在 disabled 动画/状态切换里；只有它真正恢复后
          // 才消耗“唯一一次第二阶段重试”额度。
          if (await isSendButtonReady(client)) {
            retriedAfterPrepare = true
            sendHandlerAttempts += 1
            await clickSendHandler(client)
          }
        }
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      if (!submitState.event) throw new Error(`ChatGPT actor did not emit POST ${formalRequestUrl}`)
      if (responseState.status === null) {
        throw new Error(`ChatGPT actor submission outcome unknown after formal POST ${submitState.event.requestId}: no HTTP response arrived before timeout`)
      }
      throw new Error('ChatGPT actor submission outcome unknown: request returned 2xx but conversation UUID was not bound before timeout')
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const submitEvent = submitState.event
      if (targetMode === 'guardian' && sendArmedAt === 0) {
        // 失败发生在点击发送按钮之前，回首页不可能中断本轮正式 POST。
        // 复位失败不覆盖原错误，也不由队列自动再试；保留最初的故障原因供排查。
        try { await resetGuardianAfterPrePostFailure(client) }
        catch { /* 仍保留原始故障；下次任务的健康检查会重新判断页面 */ }
      }
      if (
        submitEvent
        && acceptedConversationId
        && responseState.status !== null
        && responseState.status >= 200
        && responseState.status < 300
      ) {
        // 服务端已经明确 2xx；从这里开始任何本地 CDP/trace/neutralize 失败都不能触发重发。
        return {
          targetId,
          conversationId: acceptedConversationId,
          submittedAt: submitEvent.at,
          boundAt: acceptedBoundAt ?? submitEvent.at,
          bindDelayMs: Math.max(0, Number(acceptedBoundAt ?? submitEvent.at) - submitEvent.at),
          cdpRequestId: submitEvent.requestId,
          responseStatus: responseState.status,
          responseMimeType: responseState.mimeType,
          mode: requestedMode,
          projectName,
          targetMode,
          runningConfirmed: false,
          postSubmitNeutralized: false,
          postSubmitNeutralizeReason: `local finalize degraded after confirmed 2xx: ${message}`,
          degradedAfterAccept: true,
        }
      }
      if (submitEvent && responseState.status === null && !message.includes('submission outcome unknown')) {
        throw new Error(`ChatGPT actor submission outcome unknown after formal POST ${submitEvent.requestId}: ${message}`)
      }
      throw error
    }
    finally {
      offRequest()
      offResponse()
      offData()
    }
  }
  finally {
    if (focusEmulationEnabled) {
      await client.send('Emulation.setFocusEmulationEnabled', { enabled: false }, 1_500).catch(() => {})
    }
    client.close()
  }
}

/**
 * 对外发送入口：所有会改变 Actor/Guardian 页面的操作先拿跨进程 lease。
 * lease 只持有到本次提交已经拿到 Network 闭环结果，不等待模型生成完成；因此不会破坏
 * ChatGPT 本身“同 tab 多个 active conversation/SSE 并行”的能力。
 */
export async function sendActorPrompt(options: ActorSendOptions): Promise<Record<string, unknown>> {
  const timeoutMs = options.timeoutMs ?? 20_000
  const lease = await acquireActorLease(options, timeoutMs)
  try {
    const submitGapWaitMs = await waitForActorSubmitGap(options.statePath)
    const result = await sendActorPromptUnlocked(options)
    return {
      ...result,
      leaseWaitMs: lease.waitMs,
      submitGapWaitMs,
    }
  }
  finally {
    await releaseActorLease(lease)
  }
}

export function resolveActorStatusTarget(
  actorState: { targetId: string, source?: 'guardian' | 'dedicated' },
  daemonState: any,
): {
  targetId: string
  sourceOfTruth: 'actor-state' | 'daemon-guardian'
  staleCachedTargetId: string | null
} {
  if (actorState.source !== 'guardian') {
    return {
      targetId: actorState.targetId,
      sourceOfTruth: 'actor-state',
      staleCachedTargetId: null,
    }
  }
  const guardianTargetId = typeof daemonState?.guardian?.targetId === 'string'
    ? daemonState.guardian.targetId
    : null
  if (!guardianTargetId) {
    return {
      targetId: actorState.targetId,
      sourceOfTruth: 'actor-state',
      staleCachedTargetId: null,
    }
  }
  return {
    targetId: guardianTargetId,
    sourceOfTruth: 'daemon-guardian',
    staleCachedTargetId: guardianTargetId === actorState.targetId ? null : actorState.targetId,
  }
}

export async function actorStatus(
  cdpHttp: string,
  statePath: string,
  daemonStatePath?: string | null,
): Promise<Record<string, unknown>> {
  const state = await readActorState(statePath)
  if (!state) return { available: false, statePath, reason: 'no actor state' }
  const daemonState = await readJsonFile(daemonStatePath)
  const resolved = resolveActorStatusTarget(state, daemonState)
  const target = (await listTargets(cdpHttp)).find(item => (item.id ?? item.targetId) === resolved.targetId)
  return {
    available: Boolean(target?.webSocketDebuggerUrl),
    statePath,
    state: {
      ...state,
      targetId: resolved.targetId,
    },
    sourceOfTruth: resolved.sourceOfTruth,
    staleCachedTargetId: resolved.staleCachedTargetId,
    target: target ? {
      id: target.id ?? target.targetId,
      title: target.title ?? null,
      url: target.url ?? null,
    } : null,
  }
}

/**
 * 只读检查 Actor 当前页面的闭环状态。
 *
 * 这个入口专门用于 DOM/时序漂移排障：它复用 sendActorPrompt() 完全相同的
 * `readActorPageSnapshot()`，但不会导航、输入、点击或发任何 ChatGPT 请求。
 * 因此当页面“肉眼看起来能发、Actor 却判不可发”时，可以直接比较 Actor 自己的判定，
 * 避免再用另一套临时 DOM 查询制造第二套语义。
 */
export async function inspectActorPage(options: {
  cdpHttp: string
  statePath: string
  daemonStatePath?: string | null
  targetMode?: ActorTargetMode
  timeoutMs?: number
}): Promise<Record<string, unknown>> {
  const timeoutMs = options.timeoutMs ?? 20_000
  const targetMode = options.targetMode ?? 'guardian'
  const target = await acquireActorTarget(
    options.cdpHttp,
    options.statePath,
    timeoutMs,
    targetMode,
    options.daemonStatePath,
  )
  const targetId = String(target.id ?? target.targetId)
  if (!target.webSocketDebuggerUrl) throw new Error('actor target has no webSocketDebuggerUrl')

  const client = new ActorCdpClient(target.webSocketDebuggerUrl)
  await client.connect()
  try {
    await client.send('Runtime.enable')
    return {
      targetId,
      targetMode,
      snapshot: await readActorPageSnapshot(client),
    }
  }
  finally {
    client.close()
  }
}

export async function resetActor(cdpHttp: string, statePath: string): Promise<Record<string, unknown>> {
  const state = await readActorState(statePath)
  let closed = false
  const borrowedGuardian = state?.source === 'guardian'
  if (state?.targetId && !borrowedGuardian) {
    try {
      const response = await fetch(`${normalizeCdpHttp(cdpHttp)}/json/close/${encodeURIComponent(state.targetId)}`)
      closed = response.ok
    }
    catch {
      closed = false
    }
  }
  await fs.rm(statePath, { force: true })
  return {
    reset: true,
    closed,
    borrowedGuardian,
    targetId: state?.targetId ?? null,
    statePath,
  }
}

