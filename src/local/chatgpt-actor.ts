import fs from 'node:fs/promises'
import path from 'node:path'
import { ActiveTurnRecorder, buildActorSubmitTrace } from './active-turn-recorder'

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
}

interface ActorSendOptions {
  cdpHttp: string
  statePath: string
  tracePath: string
  prompt: string
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

async function acquireActorTarget(cdpHttp: string, statePath: string, timeoutMs: number): Promise<CdpTarget> {
  const state = await readActorState(statePath)
  if (state) {
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
  })
  return created
}

async function evaluateValue(client: ActorCdpClient, expression: string): Promise<any> {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (result?.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Runtime.evaluate exception')
  return result?.result?.value
}

async function waitForComposer(client: ActorCdpClient, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ready = await evaluateValue(client, `Boolean(
      document.querySelector('textarea[aria-label="与 ChatGPT 聊天"]')
      || document.querySelector('#prompt-textarea')
    )`)
    if (ready === true) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('ChatGPT actor composer did not become ready')
}

/** 只接受真正服务端 UUID；Branch 临时的 `WEB:` id 不算绑定完成。 */
export function conversationIdFromUrl(url: string): string | null {
  const match = /^https:\/\/chatgpt\.com\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/iu.exec(url)
  return match?.[1] ?? null
}

async function clearAndTypePrompt(client: ActorCdpClient, prompt: string): Promise<void> {
  const focused = await evaluateValue(client, `(() => {
    const input = document.querySelector('textarea[aria-label="与 ChatGPT 聊天"]')
      || document.querySelector('textarea')
      || document.querySelector('#prompt-textarea')
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
    const button = document.querySelector('button[data-testid="send-button"]')
    if (!button || button.disabled) return false
    button.click()
    return true
  })()`)
  if (result !== true) throw new Error('ChatGPT actor send button unavailable or disabled')
}

export async function sendActorPrompt(options: ActorSendOptions): Promise<Record<string, unknown>> {
  const timeoutMs = options.timeoutMs ?? 20_000
  if (!options.prompt.trim()) throw new Error('actor prompt is empty')
  const target = await acquireActorTarget(options.cdpHttp, options.statePath, timeoutMs)
  const targetId = String(target.id ?? target.targetId)
  if (!target.webSocketDebuggerUrl) throw new Error('actor target has no webSocketDebuggerUrl')

  const client = new ActorCdpClient(target.webSocketDebuggerUrl)
  await client.connect()
  try {
    await client.send('Page.enable')
    await client.send('Runtime.enable')
    await client.send('Network.enable')

    // 每次 send 默认从全新聊天开始，但始终复用同一个 renderer/target。
    await client.send('Page.navigate', { url: CHATGPT_HOME })
    await waitForComposer(client, timeoutMs)
    await clearAndTypePrompt(client, options.prompt)

    const pageUrlBefore = String(await evaluateValue(client, 'location.href') || CHATGPT_HOME)
    let submitEvent: { at: number; requestId: string } | null = null
    let responseStatus: number | null = null
    let responseMimeType: string | null = null
    const formalRequestUrl = 'https://chatgpt.com/backend-api/f/conversation'
    const offRequest = client.on('Network.requestWillBeSent', (event) => {
      if (submitEvent) return
      if (event?.request?.method !== 'POST' || event?.request?.url !== formalRequestUrl) return
      submitEvent = { at: Date.now(), requestId: String(event.requestId) }
    })
    const offResponse = client.on('Network.responseReceived', (event) => {
      if (!submitEvent || String(event?.requestId) !== submitEvent.requestId) return
      responseStatus = Number(event?.response?.status ?? 0) || null
      responseMimeType = typeof event?.response?.mimeType === 'string' ? event.response.mimeType : null
    })

    try {
      await clickSendHandler(client)
      const deadline = Date.now() + timeoutMs
      let conversationId: string | null = null
      let boundAt = 0
      while (Date.now() < deadline) {
        const href = String(await evaluateValue(client, 'location.href') || '')
        conversationId = conversationIdFromUrl(href)
        if (submitEvent && conversationId) {
          boundAt = Date.now()
          // response 通常早于 URL bind，但给它一个很短的观察窗口，不因缺 response 阻塞发送控制面。
          if (responseStatus === null) await new Promise(resolve => setTimeout(resolve, 150))
          const recorder = new ActiveTurnRecorder(options.tracePath)
          await recorder.append(buildActorSubmitTrace({
            submittedAt: submitEvent.at,
            boundAt,
            conversationId,
            actorTargetId: targetId,
            cdpRequestId: submitEvent.requestId,
            responseStatus,
            responseMimeType,
            pageUrlBefore,
          }))
          const prior = await readActorState(options.statePath)
          await writeActorState(options.statePath, {
            targetId,
            createdAt: prior?.createdAt ?? Date.now(),
            updatedAt: Date.now(),
          })
          return {
            targetId,
            conversationId,
            submittedAt: submitEvent.at,
            boundAt,
            bindDelayMs: boundAt - submitEvent.at,
            cdpRequestId: submitEvent.requestId,
            responseStatus,
            responseMimeType,
            pageUrlBefore,
          }
        }
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      if (!submitEvent) throw new Error('ChatGPT actor did not emit POST /backend-api/f/conversation')
      throw new Error('ChatGPT actor request started but conversation UUID was not bound before timeout')
    }
    finally {
      offRequest()
      offResponse()
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
  if (state?.targetId) {
    try {
      const response = await fetch(`${normalizeCdpHttp(cdpHttp)}/json/close/${encodeURIComponent(state.targetId)}`)
      closed = response.ok
    }
    catch {
      closed = false
    }
  }
  await fs.rm(statePath, { force: true })
  return { reset: true, closed, targetId: state?.targetId ?? null, statePath }
}

