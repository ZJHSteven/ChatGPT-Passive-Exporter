#!/usr/bin/env node

/**
 * ChatGPT 官方 WSS 长时稳定性采集器。
 *
 * 目标：回答“官方页面自己的 WebSocket 到底稳不稳、自然断线后多久被发现、
 * 是否自动重连、是否重新订阅、有没有长时间半开静默”的工程问题。
 *
 * 设计边界：
 * 1. 只通过 Chrome DevTools Protocol 观察 ChatGPT 官方页面自己的网络事件；
 * 2. 不额外建立业务 WebSocket；
 * 3. 不调用 conversation/list/stream_status 等 ChatGPT 私有 API；
 * 4. 不记录 Authorization、Cookie，也不把业务消息正文写入日志；
 * 5. 默认新建一个专用轻量 ChatGPT helper tab，避免干扰用户正在工作的聊天。
 *
 * 常用示例：
 *   node scripts/wss-stability-probe.mjs --duration 3600
 *
 * 做一次“网络层离线 45 秒再恢复”的受控实验：
 *   node scripts/wss-stability-probe.mjs --duration 150 --fault-after 30 --offline-seconds 45
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const DEFAULT_CDP = 'http://127.0.0.1:9222'
const DEFAULT_DURATION_SECONDS = 3600
const DEFAULT_SAMPLE_SECONDS = 10
const DEFAULT_SILENCE_MARK_SECONDS = 60

/**
 * 极简 CDP 客户端。
 *
 * 这里只需要一张 page target 的 Network/Page/Runtime 域，因此没有引入第三方库。
 * Node 24 已提供全局 WebSocket，实现足够完成 CDP request/response 与事件分发。
 */
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

      // 带 id 的是对我们主动 CDP 命令的响应。
      if (typeof message.id === 'number') {
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        if (message.error) pending.reject(new Error(message.error.message || 'CDP error'))
        else pending.resolve(message.result || {})
        return
      }

      // 不带 id、带 method 的是 Chrome 主动推送的 CDP event。
      if (typeof message.method === 'string') {
        for (const handler of this.listeners.get(message.method) || []) {
          try {
            handler(message.params || {})
          }
          catch (error) {
            // 单个日志处理器异常不能让整个一小时采集器退出。
            console.error('[wss-probe] event handler error:', error)
          }
        }
      }
    })

    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true })
      this.ws.addEventListener('error', () => reject(new Error('CDP websocket error')), { once: true })
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
    return () => {
      set.delete(handler)
      if (set.size === 0) this.listeners.delete(method)
    }
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

function numberFlag(flags, name, fallback) {
  const raw = flags.get(name)
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) throw new Error(`--${name} 必须是非负数字`)
  return value
}

function nowIso() {
  return new Date().toISOString()
}

function safeFileTimestamp() {
  return nowIso().replaceAll(':', '-').replaceAll('.', '-')
}

/**
 * 只从 WSS 文本帧里提取“协议控制信息”。
 *
 * 不能把 payloadData 原样落盘，因为 conversations topic 可能包含真实聊天更新。
 * 因此这里仅抽取少量白名单键和值；无法识别的业务帧只记录字节数和 opcode。
 */
export function summarizeFrame(payloadData) {
  const text = typeof payloadData === 'string' ? payloadData : ''
  const bytes = Buffer.byteLength(text, 'utf8')
  const safe = { bytes }

  if (!text || text.length > 16_384) return safe

  try {
    const parsed = JSON.parse(text)
    const allowedKeys = new Set([
      'type',
      'action',
      'event',
      'topic',
      'topic_id',
      'channel',
      'status',
      'recovered',
      'update_type',
    ])
    const fields = {}

    // 只看浅层和常见的 payload/data 包装层，避免递归碰到业务正文。
    for (const candidate of [parsed, parsed?.payload, parsed?.data]) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
      for (const [key, value] of Object.entries(candidate)) {
        if (!allowedKeys.has(key)) continue
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) {
          fields[key] = value
        }
      }
    }

    if (Object.keys(fields).length > 0) safe.control = fields
    return safe
  }
  catch {
    // 极少数控制帧可能不是 JSON。只有命中明确控制词时才保存一个很短的片段。
    if (/\b(connect|subscribe|unsubscribe|ping|pong|heartbeat)\b/iu.test(text)) {
      safe.controlText = text.slice(0, 240)
    }
    return safe
  }
}

function isChatgptRealtimeUrl(url) {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'wss:' && parsed.hostname.endsWith('chatgpt.com')
  }
  catch {
    return false
  }
}

async function createHelperTab(cdpHttp) {
  // 先建 about:blank，等 Network.enable 后再导航，确保不会漏掉 webSocketCreated。
  const response = await fetch(`${cdpHttp}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })
  if (!response.ok) throw new Error(`创建 CDP helper tab 失败：HTTP ${response.status}`)
  const tab = await response.json()
  if (!tab?.id || !tab?.webSocketDebuggerUrl) throw new Error('helper tab 缺少 target id / websocket debugger url')
  return tab
}

async function closeTarget(cdpHttp, targetId) {
  if (!targetId) return
  try {
    await fetch(`${cdpHttp}/json/close/${encodeURIComponent(targetId)}`)
  }
  catch {
    // 结束时清理失败不应覆盖已经采集到的结果。
  }
}

async function setTargetOffline(client, offline) {
  const params = {
    offline,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  }
  await client.send('Network.emulateNetworkConditions', params)
}

function makeSocketState(requestId, url, timestamp) {
  return {
    requestId,
    url,
    createdAt: timestamp,
    handshakeAt: null,
    closedAt: null,
    lastFrameAt: null,
    lastSentAt: null,
    lastReceivedAt: null,
    sentFrames: 0,
    receivedFrames: 0,
    sentBytes: 0,
    receivedBytes: 0,
    opcodeCounts: {},
    controlFrames: 0,
  }
}

async function main() {
  const flags = parseArgs(process.argv.slice(2))
  const cdpHttp = String(flags.get('cdp') || DEFAULT_CDP).replace(/\/$/u, '')
  const durationSeconds = numberFlag(flags, 'duration', DEFAULT_DURATION_SECONDS)
  const sampleSeconds = Math.max(1, numberFlag(flags, 'sample', DEFAULT_SAMPLE_SECONDS))
  const silenceMarkSeconds = Math.max(1, numberFlag(flags, 'silence-mark', DEFAULT_SILENCE_MARK_SECONDS))
  const faultAfterSeconds = numberFlag(flags, 'fault-after', 0)
  const offlineSeconds = numberFlag(flags, 'offline-seconds', 0)
  const keepTab = flags.has('keep-tab')

  const defaultLog = path.resolve('data', `wss-probe-${safeFileTimestamp()}.jsonl`)
  const logPath = path.resolve(String(flags.get('log') || defaultLog))
  const summaryPath = `${logPath}.summary.json`
  await fsp.mkdir(path.dirname(logPath), { recursive: true })
  const stream = fs.createWriteStream(logPath, { flags: 'a', encoding: 'utf8' })

  const startedAtMs = Date.now()
  const sockets = new Map()
  const trackedRequestUrls = new Map()
  let helper = null
  let client = null
  let sampleTimer = null
  let durationTimer = null
  let faultTimer = null
  let recoveryTimer = null
  let stopping = false
  let lastAnyWsFrameAt = null
  let wsCreatedCount = 0
  let wsClosedCount = 0
  let loadingFailedCount = 0
  let faultInjected = false

  const write = (event, details = {}) => {
    stream.write(`${JSON.stringify({ ts: nowIso(), event, ...details })}\n`)
  }

  const snapshot = () => {
    const now = Date.now()
    return [...sockets.values()].map((socket) => ({
      requestId: socket.requestId,
      url: socket.url,
      createdAt: socket.createdAt,
      handshakeAt: socket.handshakeAt,
      closedAt: socket.closedAt,
      openByCdp: socket.closedAt === null,
      silentForMs: socket.lastFrameAt ? now - socket.lastFrameAt : now - Date.parse(socket.createdAt),
      sentFrames: socket.sentFrames,
      receivedFrames: socket.receivedFrames,
      sentBytes: socket.sentBytes,
      receivedBytes: socket.receivedBytes,
      opcodeCounts: socket.opcodeCounts,
      controlFrames: socket.controlFrames,
    }))
  }

  const finish = async (reason, exitCode = 0) => {
    if (stopping) return
    stopping = true

    clearInterval(sampleTimer)
    clearTimeout(durationTimer)
    clearTimeout(faultTimer)
    clearTimeout(recoveryTimer)

    // 如果进程在受控 offline 阶段被 Ctrl+C，先尽量把 helper target 网络恢复。
    if (faultInjected && client) {
      try {
        await setTargetOffline(client, false)
        write('fault_cleanup_online')
      }
      catch (error) {
        write('fault_cleanup_failed', { error: String(error?.message || error) })
      }
    }

    const summary = {
      startedAt: new Date(startedAtMs).toISOString(),
      endedAt: nowIso(),
      reason,
      durationMs: Date.now() - startedAtMs,
      helperTargetId: helper?.id || null,
      logPath,
      wsCreatedCount,
      wsClosedCount,
      loadingFailedCount,
      lastAnyWsFrameAt: lastAnyWsFrameAt ? new Date(lastAnyWsFrameAt).toISOString() : null,
      sockets: snapshot(),
    }
    write('probe_end', summary)
    await fsp.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')

    client?.close()
    if (helper && !keepTab) await closeTarget(cdpHttp, helper.id)

    await new Promise(resolve => stream.end(resolve))
    console.log(JSON.stringify({ ok: true, logPath, summaryPath, reason, wsCreatedCount, wsClosedCount }, null, 2))
    process.exitCode = exitCode
  }

  process.once('SIGINT', () => void finish('SIGINT', 130))
  process.once('SIGTERM', () => void finish('SIGTERM', 143))

  try {
    helper = await createHelperTab(cdpHttp)
    client = new CdpClient(helper.webSocketDebuggerUrl)
    await client.connect()
    await client.send('Network.enable')
    await client.send('Page.enable')
    await client.send('Runtime.enable')

    client.on('Network.requestWillBeSent', (params) => {
      const url = String(params?.request?.url || '')
      if (url) trackedRequestUrls.set(params.requestId, url)
    })

    client.on('Network.webSocketCreated', (params) => {
      const url = String(params.url || '')
      if (!isChatgptRealtimeUrl(url)) return
      const timestamp = nowIso()
      const state = makeSocketState(params.requestId, url, timestamp)
      sockets.set(params.requestId, state)
      trackedRequestUrls.set(params.requestId, url)
      wsCreatedCount += 1
      write('ws_created', { requestId: params.requestId, url })
    })

    client.on('Network.webSocketHandshakeResponseReceived', (params) => {
      const state = sockets.get(params.requestId)
      if (!state) return
      state.handshakeAt = nowIso()
      write('ws_handshake', {
        requestId: params.requestId,
        status: params.response?.status ?? null,
        statusText: params.response?.statusText ?? null,
      })
    })

    const handleFrame = (direction, params) => {
      const state = sockets.get(params.requestId)
      if (!state) return
      const frame = params.response || {}
      const summary = summarizeFrame(frame.payloadData)
      const timestamp = Date.now()
      const opcode = Number(frame.opcode)
      const opcodeKey = Number.isFinite(opcode) ? String(opcode) : 'unknown'

      state.lastFrameAt = timestamp
      lastAnyWsFrameAt = timestamp
      state.opcodeCounts[opcodeKey] = (state.opcodeCounts[opcodeKey] || 0) + 1
      if (summary.control) state.controlFrames += 1

      if (direction === 'sent') {
        state.lastSentAt = timestamp
        state.sentFrames += 1
        state.sentBytes += summary.bytes
      }
      else {
        state.lastReceivedAt = timestamp
        state.receivedFrames += 1
        state.receivedBytes += summary.bytes
      }

      write('ws_frame', {
        requestId: params.requestId,
        direction,
        opcode: frame.opcode ?? null,
        mask: frame.mask ?? null,
        bytes: summary.bytes,
        control: summary.control || summary.controlText || null,
      })
    }

    client.on('Network.webSocketFrameSent', params => handleFrame('sent', params))
    client.on('Network.webSocketFrameReceived', params => handleFrame('received', params))

    client.on('Network.webSocketClosed', (params) => {
      const state = sockets.get(params.requestId)
      if (!state) return
      state.closedAt = nowIso()
      wsClosedCount += 1
      write('ws_closed', {
        requestId: params.requestId,
        lifetimeMs: Date.now() - Date.parse(state.createdAt),
      })
    })

    client.on('Network.loadingFailed', (params) => {
      const url = trackedRequestUrls.get(params.requestId)
      if (!url || !isChatgptRealtimeUrl(url)) return
      loadingFailedCount += 1
      write('ws_loading_failed', {
        requestId: params.requestId,
        errorText: params.errorText || null,
        canceled: params.canceled ?? null,
        blockedReason: params.blockedReason || null,
      })
    })

    // 现在才导航：Network 域已经启用，因此官方 WSS 的创建、握手和首帧都能完整看到。
    const helperUrl = `https://chatgpt.com/?wss-probe=1&started=${encodeURIComponent(nowIso())}`
    write('probe_start', {
      cdpHttp,
      helperTargetId: helper.id,
      helperUrl,
      durationSeconds,
      sampleSeconds,
      silenceMarkSeconds,
      faultAfterSeconds,
      offlineSeconds,
    })
    await client.send('Page.navigate', { url: helperUrl })

    sampleTimer = setInterval(async () => {
      const active = snapshot()
      const silenceThresholdMs = silenceMarkSeconds * 1000
      write('sample', {
        navigatorOnline: await client.send('Runtime.evaluate', {
          expression: 'navigator.onLine',
          returnByValue: true,
        }).then(result => result?.result?.value ?? null).catch(() => null),
        sockets: active,
      })

      for (const socket of active) {
        if (socket.openByCdp && socket.silentForMs >= silenceThresholdMs) {
          write('silent_open_socket', {
            requestId: socket.requestId,
            silentForMs: socket.silentForMs,
            note: '仅表示 CDP 尚未收到 closed 且长时间无 frame；不是自动判定故障。',
          })
        }
      }
    }, sampleSeconds * 1000)
    sampleTimer.unref?.()

    if (faultAfterSeconds > 0 && offlineSeconds > 0) {
      faultTimer = setTimeout(async () => {
        try {
          await setTargetOffline(client, true)
          faultInjected = true
          write('fault_offline_begin', { offlineSeconds })

          recoveryTimer = setTimeout(async () => {
            try {
              await setTargetOffline(client, false)
              faultInjected = false
              write('fault_offline_end')
            }
            catch (error) {
              write('fault_recovery_failed', { error: String(error?.message || error) })
            }
          }, offlineSeconds * 1000)
        }
        catch (error) {
          write('fault_injection_failed', { error: String(error?.message || error) })
        }
      }, faultAfterSeconds * 1000)
    }

    durationTimer = setTimeout(() => void finish('duration_elapsed'), durationSeconds * 1000)

    // 等待 finish() 通过 duration/SIGINT/SIGTERM 收尾。
    await new Promise(() => {})
  }
  catch (error) {
    write('probe_error', { error: String(error?.stack || error) })
    console.error(error)
    await finish('error', 1)
  }
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll('\\', '/')}`) {
  void main()
}

