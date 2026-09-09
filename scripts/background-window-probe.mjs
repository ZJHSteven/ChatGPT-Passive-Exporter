#!/usr/bin/env node

/**
 * ChatGPT Archive 专用后台窗口原型。
 *
 * 目的不是实现正式 daemon，而是回答一个关键架构问题：
 * “能否在用户当前 CDP Chrome 的同一 browser process / 同一 profile 中，创建一张
 * 与日常标签生命周期隔离的独立 ChatGPT 窗口，并在窗口最小化后仍维持官方 WSS？”
 *
 * 安全边界：
 * - 不打开第二个 Chrome profile；
 * - 不触碰/刷新用户现有 ChatGPT conversation tab；
 * - 不主动请求 conversation list/body/stream_status；
 * - 只观察官方页面自己建立的 WSS 和页面生命周期；
 * - 默认实验结束后关闭专用窗口，可用 --keep 保留。
 */

const DEFAULT_CDP = 'http://127.0.0.1:9222'
const MARKER = 'chatgpt-archive-guardian-probe'

class CdpClient {
  constructor(url) {
    this.url = url
    this.ws = null
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Map()
  }

  async connect() {
    this.ws = new WebSocket(this.url)
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data))
      if (typeof message.id === 'number') {
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        if (message.error) pending.reject(new Error(message.error.message || 'CDP error'))
        else pending.resolve(message.result || {})
        return
      }
      if (typeof message.method === 'string') {
        for (const handler of this.listeners.get(message.method) || []) handler(message.params || {})
      }
    })
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true })
      this.ws.addEventListener('error', () => reject(new Error(`CDP connect failed: ${this.url}`)), { once: true })
    })
  }

  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  on(method, handler) {
    const set = this.listeners.get(method) || new Set()
    set.add(handler)
    this.listeners.set(method, set)
  }

  close() {
    this.ws?.close()
  }
}

function parseArgs(argv) {
  const flags = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (!value.startsWith('--')) continue
    const name = value.slice(2)
    const next = argv[index + 1]
    if (next && !next.startsWith('--')) {
      flags.set(name, next)
      index += 1
    }
    else flags.set(name, true)
  }
  return flags
}

async function waitForTarget(cdpHttp, targetId, timeoutMs = 5000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const targets = await fetch(`${cdpHttp}/json/list`).then(response => response.json())
    const target = targets.find(item => item.id === targetId)
    if (target?.webSocketDebuggerUrl) return target
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`Target ${targetId} did not appear in /json/list`)
}

async function main() {
  const flags = parseArgs(process.argv.slice(2))
  const cdpHttp = String(flags.get('cdp') || DEFAULT_CDP).replace(/\/$/u, '')
  const durationSeconds = Math.max(5, Number(flags.get('duration') || 90))
  const keep = flags.has('keep')

  const version = await fetch(`${cdpHttp}/json/version`).then(response => response.json())
  const browser = new CdpClient(version.webSocketDebuggerUrl)
  await browser.connect()

  let targetId = null
  let page = null
  let windowId = null
  try {
    const created = await browser.send('Target.createTarget', {
      url: 'about:blank',
      newWindow: true,
      background: true,
    })
    targetId = created.targetId
    const target = await waitForTarget(cdpHttp, targetId)
    page = new CdpClient(target.webSocketDebuggerUrl)
    await page.connect()

    await page.send('Network.enable')
    await page.send('Page.enable')
    await page.send('Runtime.enable')
    await page.send('Performance.enable')

    const sockets = new Map()
    let receivedFrames = 0
    let sentFrames = 0
    let createdSockets = 0
    let closedSockets = 0
    let lifecycleEvents = []

    page.on('Network.webSocketCreated', ({ requestId, url }) => {
      if (!String(url || '').startsWith('wss://')) return
      createdSockets += 1
      sockets.set(requestId, { url, createdAt: Date.now(), closedAt: null })
    })
    page.on('Network.webSocketClosed', ({ requestId }) => {
      const socket = sockets.get(requestId)
      if (socket) socket.closedAt = Date.now()
      closedSockets += 1
    })
    page.on('Network.webSocketFrameReceived', ({ requestId }) => {
      if (sockets.has(requestId)) receivedFrames += 1
    })
    page.on('Network.webSocketFrameSent', ({ requestId }) => {
      if (sockets.has(requestId)) sentFrames += 1
    })
    page.on('Page.lifecycleEvent', ({ name }) => {
      lifecycleEvents.push({ at: Date.now(), name })
      lifecycleEvents = lifecycleEvents.slice(-64)
    })
    await page.send('Page.setLifecycleEventsEnabled', { enabled: true })

    await page.send('Page.navigate', { url: `https://chatgpt.com/?${MARKER}=1` })

    const window = await browser.send('Browser.getWindowForTarget', { targetId })
    windowId = window.windowId
    // 专用窗口完全独立于用户工作窗口；立即最小化，避免抢前台。
    await browser.send('Browser.setWindowBounds', {
      windowId,
      bounds: { windowState: 'minimized' },
    })

    const started = Date.now()
    const samples = []
    while (Date.now() - started < durationSeconds * 1000) {
      await new Promise(resolve => setTimeout(resolve, 5000))
      const runtime = await page.send('Runtime.evaluate', {
        expression: `({
          href: location.href,
          title: document.title,
          visibilityState: document.visibilityState,
          hidden: document.hidden,
          wasDiscarded: document.wasDiscarded === true,
          readyState: document.readyState,
          heap: performance.memory ? {
            usedJSHeapSize: performance.memory.usedJSHeapSize,
            totalJSHeapSize: performance.memory.totalJSHeapSize,
            jsHeapSizeLimit: performance.memory.jsHeapSizeLimit,
          } : null,
        })`,
        returnByValue: true,
      })
      const metrics = await page.send('Performance.getMetrics')
      const metricMap = Object.fromEntries((metrics.metrics || []).map(item => [item.name, item.value]))
      samples.push({
        at: new Date().toISOString(),
        runtime: runtime.result?.value ?? null,
        jsHeapUsed: metricMap.JSHeapUsedSize ?? null,
        jsHeapTotal: metricMap.JSHeapTotalSize ?? null,
        documents: metricMap.Documents ?? null,
        nodes: metricMap.Nodes ?? null,
        createdSockets,
        closedSockets,
        receivedFrames,
        sentFrames,
      })
    }

    const bounds = await browser.send('Browser.getWindowBounds', { windowId })
    const openSockets = [...sockets.values()].filter(item => item.closedAt === null).length
    console.log(JSON.stringify({
      browser: version.Browser,
      targetId,
      windowId,
      windowBounds: bounds.bounds,
      durationSeconds,
      socketSummary: { createdSockets, closedSockets, openSockets, receivedFrames, sentFrames },
      lifecycleEvents,
      samples,
    }, null, 2))
  }
  finally {
    page?.close()
    if (!keep && targetId) {
      try { await browser.send('Target.closeTarget', { targetId }) }
      catch { /* probe cleanup is best-effort */ }
    }
    browser.close()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})

