import fs from 'node:fs/promises'
import path from 'node:path'
// Node 24 直接执行本项目 `.ts` 源文件时不会像 Vite/Vitest 一样自动补扩展名；
// 这是运行时 import（不是 type-only），因此必须显式写 `.ts`。
import { ActiveTurnRecorder, buildActorSubmitTrace } from './active-turn-recorder.ts'
import { ActorDomDriftLedger, type ActorDomObservation } from './dom-drift.ts'

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
}

export type ActorTargetMode = 'guardian' | 'dedicated'

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
  sendReady: boolean
  stopVisible: boolean
  waitingForFinal: boolean
  messageNodes: number
}

interface ActorSendOptions {
  cdpHttp: string
  statePath: string
  daemonStatePath?: string | null
  domLedgerPath?: string | null
  tracePath: string
  prompt: string
  conversationId?: string | null
  mode?: ActorSendMode
  targetMode?: ActorTargetMode
  timeoutMs?: number
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
  await writeActorState(statePath, {
    targetId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    source: 'dedicated',
  })
  return created
}

/**
 * cooldown 是账号级主动请求预算，不是 Guardian 私有状态。
 * Actor 无论借 Guardian 还是独立 tab 都必须尊重同一个 cooldown，避免用另一个页面绕过熔断。
 */
async function assertActorCooldownClear(daemonStatePath?: string | null): Promise<void> {
  const daemonState = await readJsonFile(daemonStatePath)
  const cooldownUntil = Number(daemonState?.cooldownUntil || 0)
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
  const match = /^https:\/\/chatgpt\.com\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/iu.exec(url)
  return match?.[1] ?? null
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
      for (let node = element; node; node = node.parentElement) {
        if (!(node instanceof HTMLElement)) continue
        if (node.hidden || node.hasAttribute('inert')) return false
        const style = window.getComputedStyle(node)
        if (style.display === 'none') return false
        if (style.visibility === 'hidden' || style.visibility === 'collapse') return false
        if (Number.parseFloat(style.opacity || '1') <= 0.01) return false
        if (style.pointerEvents === 'none') return false
        if (node === document.documentElement) break
      }
      return true
    }

    const input = [
      ...document.querySelectorAll('#prompt-textarea'),
      ...document.querySelectorAll('[contenteditable="true"][role="textbox"]'),
      ...document.querySelectorAll('textarea'),
    ].find(usable) || null
    const form = input?.closest('form') || null
    const buttons = form ? [...form.querySelectorAll('button')].filter(usable) : []
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
    const match = new RegExp('^/c/([0-9a-f-]{36})(?:/|$)', 'iu').exec(pathname)

    return {
      href,
      conversationId: match?.[1] || null,
      composerPresent: Boolean(input && usable(input)),
      composerHydrated: Boolean(input && usable(input) && (!form || form.hasAttribute('data-chatgpt-composer'))),
      composerHasText: Boolean(input && String(input.innerText ?? input.value ?? '').trim()),
      sendReady: Boolean(sendButton && !sendButton.disabled),
      stopVisible: Boolean(stopButton && !stopButton.disabled),
      waitingForFinal: /连接已中断|等待完整答复|connection interrupted|waiting for (?:the )?full (?:answer|response)/iu.test(bodyText),
      messageNodes: document.querySelectorAll('[data-message-author-role]').length,
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
      for (let node = element; node; node = node.parentElement) {
        if (!(node instanceof HTMLElement)) continue
        if (node.hidden || node.hasAttribute('inert')) return false
        const style = window.getComputedStyle(node)
        if (style.display === 'none') return false
        if (style.visibility === 'hidden' || style.visibility === 'collapse') return false
        if (Number.parseFloat(style.opacity || '1') <= 0.01) return false
        if (style.pointerEvents === 'none') return false
        if (node === document.documentElement) break
      }
      return true
    }

    // 这段源码还要经过外层 template literal 再交给浏览器执行。直接在这里写
    // 斜杠转义类正则会经历两次源码解析，很容易把转义吃掉。
    // 改用 RegExp(string)，让浏览器实际接收到的表达式没有双重转义歧义。
    const canonicalConversationPath = new RegExp('^/c/[0-9a-f-]{20,}(?:/|$)', 'iu')
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

async function observeActorDomShape(
  client: ActorCdpClient,
  ledger: ActorDomDriftLedger | null,
  phase: string,
): Promise<string | null> {
  if (!ledger) return null
  const observation = await readActorDomObservation(client)
  const result = ledger.observe(observation)
  await ledger.flush()
  if (result.pending) {
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
      for (let node = element; node; node = node.parentElement) {
        if (!(node instanceof HTMLElement)) continue
        if (node.hidden || node.hasAttribute('inert')) return false
        const style = window.getComputedStyle(node)
        if (style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none') return false
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
      const identity = [element.getAttribute('aria-label') || '', element.innerText || ''].join(' ')
      return /新聊天|new chat/iu.test(identity)
    })
    if (!target) return false
    target.click()
    return true
  })()`) === true
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
      for (let node = element; node; node = node.parentElement) {
        if (!(node instanceof HTMLElement)) continue
        if (node.hidden || node.hasAttribute('inert')) return false
        const style = window.getComputedStyle(node)
        if (style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none') return false
        if (Number.parseFloat(style.opacity || '1') <= 0.01) return false
        if (node === document.documentElement) break
      }
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
  while (Date.now() < deadline) {
    const snapshot = await readActorPageSnapshot(client)
    const routeMatches = conversationId
      ? snapshot.conversationId === conversationId
      : snapshot.conversationId === null && new URL(snapshot.href).pathname === '/'
    if (routeMatches && snapshot.composerHydrated) return snapshot
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`ChatGPT actor route did not become ready before timeout: ${conversationId ?? 'new-chat'}`)
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
): Promise<{ snapshot: ActorPageSnapshot; navigationMode: 'already-there' | 'spa-new' | 'spa-conversation' | 'full-fallback' }> {
  const before = await readActorPageSnapshot(client)
  const hadGuardianMarker = (() => {
    try { return new URL(before.href).searchParams.get('chatgpt-archive-guardian') === '1' }
    catch { return false }
  })()
  const alreadyThere = conversationId
    ? before.conversationId === conversationId
    : before.conversationId === null && new URL(before.href).pathname === '/'

  if (alreadyThere && before.composerHydrated) {
    return { snapshot: before, navigationMode: 'already-there' }
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

async function clearAndTypePrompt(client: ActorCdpClient, prompt: string): Promise<void> {
  const focused = await evaluateValue(client, `(() => {
    const usable = (element) => {
      if (!element || !element.isConnected) return false
      const rect = element.getBoundingClientRect()
      if (rect.width < 1 || rect.height < 1) return false
      for (let node = element; node; node = node.parentElement) {
        if (!(node instanceof HTMLElement)) continue
        if (node.hidden || node.hasAttribute('inert')) return false
        const style = window.getComputedStyle(node)
        if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false
        if (Number.parseFloat(style.opacity || '1') <= 0.01) return false
        if (style.pointerEvents === 'none') return false
        if (node === document.documentElement) break
      }
      return true
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

  // 用真实键盘清空 React composer，再走 CDP insertText；不直接篡改 textarea.value，避免绕过状态层。
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2,
  })
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2,
  })
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8,
  })
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8,
  })
  await client.send('Input.insertText', { text: prompt })
}

async function clickSendHandler(client: ActorCdpClient): Promise<void> {
  const result = await evaluateValue(client, `(() => {
    const usable = (element) => {
      if (!element || !element.isConnected) return false
      const rect = element.getBoundingClientRect()
      if (rect.width < 1 || rect.height < 1) return false
      for (let node = element; node; node = node.parentElement) {
        if (!(node instanceof HTMLElement)) continue
        if (node.hidden || node.hasAttribute('inert')) return false
        const style = window.getComputedStyle(node)
        if (style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none') return false
        if (Number.parseFloat(style.opacity || '1') <= 0.01) return false
        if (node === document.documentElement) break
      }
      return true
    }
    const input = [
      ...document.querySelectorAll('#prompt-textarea'),
      ...document.querySelectorAll('[contenteditable="true"][role="textbox"]'),
      ...document.querySelectorAll('textarea'),
    ].find(usable) || null
    const form = input?.closest('form') || null
    if (!form || !form.hasAttribute('data-chatgpt-composer')) return false
    const identity = (button) => [
      button.getAttribute('data-testid') || '',
      button.getAttribute('aria-label') || '',
      button.getAttribute('title') || '',
      (button.innerText || '').trim(),
    ].join(' ')
    const button = [...form.querySelectorAll('button')]
      .filter(usable)
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

export async function sendActorPrompt(options: ActorSendOptions): Promise<Record<string, unknown>> {
  const timeoutMs = options.timeoutMs ?? 20_000
  if (!options.prompt.trim()) throw new Error('actor prompt is empty')
  const requestedMode = options.mode ?? 'auto'
  const targetMode = options.targetMode ?? 'guardian'
  const expectedConversationId = options.conversationId ? String(options.conversationId).trim() : null
  if (expectedConversationId) actorConversationUrl(expectedConversationId)
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
  try {
    await client.send('Page.enable')
    await client.send('Runtime.enable')
    await client.send('Network.enable')
    const domLedger = options.domLedgerPath
      ? await ActorDomDriftLedger.open(options.domLedgerPath)
      : null

    // 任何导航/输入/点击之前先采一份当前页骨架。baseline 锁定后若这里已经漂移，
    // Actor 必须在真正改变页面之前停止，不能“先点了再告诉用户 DOM 变了”。
    const domSignatureBefore = await observeActorDomShape(client, domLedger, 'navigation')

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
    const responseState: { status: number | null; mimeType: string | null } = {
      status: null,
      mimeType: null,
    }
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
    })
    const offData = client.on('Network.dataReceived', (event) => {
      const submitEvent = submitState.event
      if (!submitEvent || String(event?.requestId) !== submitEvent.requestId || firstDataAt !== null) return
      if (Number(event?.dataLength ?? event?.encodedDataLength ?? 0) > 0) firstDataAt = Date.now()
    })

    try {
      const route = await ensureActorRoute(client, expectedConversationId, timeoutMs)
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
      }

      const mode = resolveActorSendMode({
        requestedMode,
        requestedConversationId: expectedConversationId,
        currentConversationId: routeSnapshot.conversationId,
        stopVisible: routeSnapshot.stopVisible,
        waitingForFinal: routeSnapshot.waitingForFinal,
      })
      formalRequestUrl = mode === 'steer' ? steerRequestUrl : conversationRequestUrl

      // 目标 route/context 已经真正 ready 后再采第二份结构指纹。第一份保护“怎么导航”，
      // 第二份保护“怎么发送”；两者都通过以后才允许把 prompt 写入页面。
      const domSignatureReady = await observeActorDomShape(client, domLedger, 'prompt input')

      await clearAndTypePrompt(client, options.prompt)
      // hidden/background target 可能因为 React 后台调度延迟挂载 submit 控件；这里等“状态变成可提交”，
      // 但最终成功仍以 Network 正式 POST + 2xx 为准，而不是按钮本身。
      await waitForSendButtonReady(client, timeoutMs)
      const pageUrlBefore = String(await evaluateValue(client, 'location.href') || actorConversationUrl(expectedConversationId))

      let sendHandlerAttempts = 1
      let retriedAfterPrepare = false
      sendArmedAt = Date.now()
      await clickSendHandler(client)
      const deadline = Date.now() + timeoutMs
      let conversationId: string | null = null
      let boundAt = 0
      while (Date.now() < deadline) {
        const href = String(await evaluateValue(client, 'location.href') || '')
        conversationId = expectedConversationId || conversationIdFromUrl(href)
        const submitEvent = submitState.event
        if (submitEvent && responseState.status !== null && responseState.status >= 400) {
          throw new Error(`ChatGPT actor ${mode} request failed with HTTP ${responseState.status}`)
        }
        if (submitEvent && conversationId && responseState.status !== null && responseState.status >= 200 && responseState.status < 300) {
          if (responseState.mimeType && !responseState.mimeType.includes('event-stream')) {
            throw new Error(`ChatGPT actor ${mode} response drifted from event-stream: ${responseState.mimeType}`)
          }
          boundAt = Date.now()
          const runningConfirmed = Boolean(
            firstDataAt
            || responseState.mimeType?.includes('event-stream')
            || (await readActorPageSnapshot(client)).stopVisible,
          )
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
          }))
          const prior = await readActorState(options.statePath)
          await writeActorState(options.statePath, {
            targetId,
            createdAt: prior?.createdAt ?? Date.now(),
            updatedAt: Date.now(),
            source: prior?.source ?? targetMode,
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
            navigationMode: route.navigationMode,
            contextReadyAt,
            contextBodyResponseAt,
            contextBodyStatus,
            firstDataAt,
            runningConfirmed,
            targetMode,
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
      if (responseState.status === null) throw new Error(`ChatGPT actor ${requestedMode} request started but no HTTP response arrived before timeout`)
      throw new Error('ChatGPT actor request was accepted but conversation UUID was not bound before timeout')
    }
    finally {
      offRequest()
      offResponse()
      offData()
    }
  }
  finally {
    client.close()
  }
}

export async function actorStatus(cdpHttp: string, statePath: string): Promise<Record<string, unknown>> {
  const state = await readActorState(statePath)
  if (!state) return { available: false, statePath, reason: 'no actor state' }
  const target = (await listTargets(cdpHttp)).find(item => (item.id ?? item.targetId) === state.targetId)
  return {
    available: Boolean(target?.webSocketDebuggerUrl),
    statePath,
    state,
    target: target ? {
      id: target.id ?? target.targetId,
      title: target.title ?? null,
      url: target.url ?? null,
    } : null,
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

