#!/usr/bin/env node

/**
 * iPhone -> PC 跨设备 ChatGPT 续流 flight recorder。
 *
 * 设计目标：一次手操实验尽量把“手机发起 -> PC 尚未打开 -> PC 打开运行中会话”全过程的
 * transport/lifecycle 证据收全，同时严格不落 prompt/assistant 正文、Cookie、Authorization 或
 * raw resume token。
 *
 * 捕获：
 * - Browser-level CDP 自动附着现有/后续 ChatGPT page/worker/service-worker；
 * - 官方账户 WSS topic/event 控制面；
 * - /f/conversation、/resume、/steer_turn、stream_status、conversation body/list/init；
 * - SSE 控制事件、conversation/turn/request identity、resume token SHA-256+长度；
 * - same-profile IndexedDB resume-token store 的 conversation id + token SHA-256+长度变化。
 *
 * 不做：
 * - 不主动请求 ChatGPT 私有 API；
 * - 不创建业务 WebSocket、不主动 subscribe turn topic；
 * - 不保存任何聊天正文或原始凭据。
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { createHash } from 'node:crypto'

const DEFAULT_CDP = 'http://127.0.0.1:9222'
const DEFAULT_DURATION_SECONDS = 30 * 60
const DEFAULT_IDB_SAMPLE_MS = 2000
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu

function parseArgs(argv) {
  const out = new Map()
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const name = arg.slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      out.set(name, next)
      i += 1
    }
    else out.set(name, true)
  }
  return out
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

function safeStamp() {
  return nowIso().replaceAll(':', '-').replaceAll('.', '-')
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex')
}

class BrowserCdp {
  constructor(url) {
    this.url = url
    this.ws = null
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Map()
  }

  async connect() {
    this.ws = new WebSocket(this.url)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('browser CDP connect timeout')), 5000)
      this.ws.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      this.ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('browser CDP websocket error')) }, { once: true })
    })
    this.ws.addEventListener('message', event => {
      let message
      try { message = JSON.parse(String(event.data)) }
      catch { return }
      if (typeof message.id === 'number' && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id)
        this.pending.delete(message.id)
        clearTimeout(pending.timer)
        if (message.error) pending.reject(new Error(message.error.message || 'CDP error'))
        else pending.resolve(message.result || {})
        return
      }
      if (typeof message.method !== 'string') return
      for (const handler of this.listeners.get(message.method) || []) {
        try { handler(message.params || {}, message.sessionId || null) }
        catch {}
      }
    })
  }

  on(method, handler) {
    const list = this.listeners.get(method) || []
    list.push(handler)
    this.listeners.set(method, list)
  }

  async send(method, params = {}, sessionId = null, timeoutMs = 30000) {
    if (!this.ws) throw new Error('browser CDP not connected')
    const id = this.nextId++
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP ${method} timeout`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }

  close() {
    try { this.ws?.close() } catch {}
  }
}

function isInterestingTarget(info) {
  return ['page', 'iframe', 'worker', 'service_worker', 'shared_worker'].includes(String(info?.type || ''))
}

function safeUrl(raw) {
  try {
    const u = new URL(raw)
    const safeQuery = new URLSearchParams()
    for (const [key, value] of u.searchParams.entries()) {
      if (/^(?:offset|limit|order|num_turns|include_has_versions|expand|is_archived|is_starred|hide_snorlax)$/u.test(key)) {
        safeQuery.set(key, value)
      }
      else safeQuery.set(key, '<redacted>')
    }
    const query = safeQuery.toString()
    return `${u.origin}${u.pathname}${query ? `?${query}` : ''}`
  }
  catch {
    return String(raw || '').slice(0, 500)
  }
}

function endpointKind(raw) {
  let u
  try { u = new URL(raw) }
  catch { return null }
  if (!u.hostname.endsWith('chatgpt.com')) return null
  const p = u.pathname
  if (p === '/backend-api/f/conversation') return 'conversation-send'
  if (p === '/backend-api/f/conversation/resume') return 'conversation-resume'
  if (p === '/backend-api/f/steer_turn') return 'steer-turn'
  if (/^\/backend-api\/conversation\/[^/]+\/stream_status$/u.test(p)) return 'stream-status'
  if (/^\/backend-api\/conversations\/[^/]+(?:\/messages)?$/u.test(p)) return 'conversation-body'
  if (p === '/backend-api/conversations') return 'conversation-list'
  if (p === '/backend-api/conversation/init') return 'conversation-init'
  if (p === '/backend-api/celsius/ws/user') return 'wss-bootstrap'
  if (p === '/ces/statsc/flush') return 'telemetry-flush'
  return null
}

function headerShape(headers) {
  const source = headers && typeof headers === 'object' ? headers : {}
  const lower = Object.fromEntries(Object.entries(source).map(([k, v]) => [k.toLowerCase(), v]))
  return {
    names: Object.keys(lower).sort(),
    hasAuthorization: 'authorization' in lower,
    hasCookie: 'cookie' in lower,
    hasConduitToken: 'x-conduit-token' in lower,
    conduitTokenLength: typeof lower['x-conduit-token'] === 'string' ? String(lower['x-conduit-token']).length : null,
    hasTurnTraceId: 'x-oai-turn-trace-id' in lower,
    hasSentinelRequirements: 'openai-sentinel-chat-requirements-token' in lower,
    hasSentinelProof: 'openai-sentinel-proof-token' in lower,
    hasTurnstile: 'openai-sentinel-turnstile-token' in lower,
  }
}

function requestBodySummary(text) {
  if (typeof text !== 'string' || !text) return null
  let body
  try { body = JSON.parse(text) }
  catch { return { json: false, bytes: Buffer.byteLength(text, 'utf8') } }
  const messages = Array.isArray(body.messages) ? body.messages : []
  return {
    json: true,
    keys: Object.keys(body).sort(),
    conversationId: typeof body.conversation_id === 'string' ? body.conversation_id : null,
    parentMessageId: typeof body.parent_message_id === 'string' ? body.parent_message_id : null,
    model: typeof body.model === 'string' ? body.model : null,
    messageCount: messages.length,
    messageIds: messages.map(m => m?.id).filter(v => typeof v === 'string'),
    messageRoles: messages.map(m => m?.author?.role).filter(v => typeof v === 'string'),
    messageContentTypes: messages.map(m => m?.content?.content_type).filter(v => typeof v === 'string'),
  }
}

function findAllStrings(value, keys, depth = 0, out = null) {
  const result = out || Object.fromEntries(keys.map(key => [key, new Set()]))
  if (!value || depth > 8) return result
  if (Array.isArray(value)) {
    for (const child of value.slice(0, 256)) findAllStrings(child, keys, depth + 1, result)
    return result
  }
  if (typeof value !== 'object') return result
  for (const [key, child] of Object.entries(value)) {
    if (keys.includes(key) && typeof child === 'string' && child) result[key].add(child)
    if (child && typeof child === 'object') findAllStrings(child, keys, depth + 1, result)
  }
  return result
}

function summarizeJsonResponse(kind, body) {
  if (!body || typeof body !== 'object') return null
  if (kind === 'stream-status') return { status: body.status ?? body.stream_status ?? null, keys: Object.keys(body).sort() }
  if (kind === 'conversation-list') {
    const items = Array.isArray(body.items) ? body.items : []
    return {
      itemCount: items.length,
      total: body.total ?? null,
      items: items.slice(0, 80).map(item => ({
        id: item?.id ?? item?.conversation_id ?? null,
        updateTime: item?.update_time ?? null,
        asyncStatus: item?.async_status ?? null,
      })),
    }
  }
  if (kind === 'conversation-body') {
    const messages = Array.isArray(body.messages) ? body.messages : []
    const ids = findAllStrings(messages, ['turn_exchange_id', 'working_turn_id', 'request_id'])
    return {
      conversationId: body.conversation_id ?? body.id ?? null,
      currentNode: body.current_node ?? null,
      updateTime: body.update_time ?? null,
      asyncStatus: body.async_status ?? null,
      messageCount: messages.length,
      pageInfo: body.page_info ?? null,
      turnExchangeIds: [...ids.turn_exchange_id].slice(-24),
      workingTurnIds: [...ids.working_turn_id].slice(-24),
      requestIds: [...ids.request_id].slice(-24),
      tail: messages.slice(-12).map(message => ({
        id: message?.id ?? null,
        role: message?.author?.role ?? null,
        channel: message?.channel ?? message?.metadata?.channel ?? null,
        status: message?.status ?? null,
        endTurn: message?.end_turn ?? null,
        contentType: message?.content?.content_type ?? null,
        turnExchangeId: message?.metadata?.turn_exchange_id ?? null,
        workingTurnId: message?.metadata?.working_turn_id ?? null,
        requestId: message?.metadata?.request_id ?? null,
      })),
    }
  }
  return { keys: Object.keys(body).sort() }
}

function summarizeWssFrame(payloadData) {
  const text = typeof payloadData === 'string' ? payloadData : ''
  const safe = { bytes: Buffer.byteLength(text, 'utf8') }
  if (!text || text.length > 5_000_000) return safe
  let parsed
  try { parsed = JSON.parse(text) }
  catch { return safe }
  const frames = Array.isArray(parsed) ? parsed : [parsed]
  safe.frames = []
  for (const frame of frames.slice(0, 128)) {
    if (!frame || typeof frame !== 'object') continue
    const row = {
      type: typeof frame.type === 'string' ? frame.type : null,
      topic: typeof frame.topic_id === 'string'
        ? frame.topic_id
        : typeof frame.command?.topic_id === 'string'
          ? frame.command.topic_id
          : typeof frame.reply?.topic_id === 'string' ? frame.reply.topic_id : null,
    }
    if (frame.command && typeof frame.command === 'object') {
      row.commandType = frame.command.type ?? null
      row.offset = frame.command.offset ?? null
    }
    if (frame.reply && typeof frame.reply === 'object') {
      row.replyType = frame.reply.type ?? null
      row.recovered = typeof frame.reply.recovered === 'boolean' ? frame.reply.recovered : null
      row.catchupCount = Array.isArray(frame.reply.catchups) ? frame.reply.catchups.length : null
      row.lastOffsetPresent = frame.reply.last_offset != null
    }
    if (frame.payload && typeof frame.payload === 'object') {
      row.payloadType = frame.payload.type ?? null
      row.conversationId = typeof frame.payload.conversation_id === 'string' ? frame.payload.conversation_id : null
      row.updateType = frame.payload.update_type ?? frame.payload.payload?.update_type ?? null
      const nested = frame.payload.payload
      if (nested && typeof nested === 'object') {
        row.innerType = nested.type ?? null
        row.hasEncodedItem = typeof nested.encoded_item === 'string'
        row.encodedBytes = typeof nested.encoded_item === 'string' ? Buffer.byteLength(nested.encoded_item, 'utf8') : 0
      }
    }
    safe.frames.push(row)
  }
  return safe
}

class SseTracker {
  constructor(meta, emit) {
    this.meta = meta
    this.emit = emit
    this.buffer = ''
    this.bytes = 0
    this.pings = 0
    this.eventCount = 0
  }

  ingestBase64(data, at = Date.now()) {
    if (typeof data !== 'string' || !data) return
    this.ingestText(Buffer.from(data, 'base64').toString('utf8'), at)
  }

  ingestText(text, at = Date.now()) {
    if (!text) return
    this.bytes += Buffer.byteLength(text, 'utf8')
    this.buffer += text
    while (true) {
      const match = /\r?\n\r?\n/u.exec(this.buffer)
      if (!match || match.index === undefined) break
      const block = this.buffer.slice(0, match.index)
      this.buffer = this.buffer.slice(match.index + match[0].length)
      this.consumeBlock(block, at)
    }
  }

  consumeBlock(block, at) {
    const trimmed = block.trim()
    if (!trimmed) return
    if (trimmed.startsWith(':')) {
      if (/^:\s*ping\b/iu.test(trimmed)) {
        this.pings += 1
        this.emit({ kind: 'sse-heartbeat', at, ...this.meta, bytesObserved: this.bytes, pingCount: this.pings })
      }
      return
    }
    const eventLine = block.split(/\r?\n/u).find(line => line.startsWith('event:'))
    const eventName = eventLine ? eventLine.slice(6).trim() : null
    const dataLines = block.split(/\r?\n/u).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart())
    if (dataLines.length === 0) return
    for (const data of dataLines) {
      if (data.trim() === '[DONE]') {
        this.eventCount += 1
        this.emit({ kind: 'sse-control', at, ...this.meta, eventName, eventType: '[DONE]', bytesObserved: this.bytes, pingCount: this.pings })
        continue
      }
      let parsed
      try { parsed = JSON.parse(data) }
      catch { continue }
      const ids = findAllStrings(parsed, ['conversation_id', 'turn_exchange_id', 'working_turn_id', 'request_id', 'type'])
      const topType = typeof parsed?.type === 'string' ? parsed.type : null
      const record = {
        kind: 'sse-control',
        at,
        ...this.meta,
        eventName,
        eventType: topType,
        conversationIds: [...ids.conversation_id].slice(0, 16),
        turnExchangeIds: [...ids.turn_exchange_id].slice(0, 16),
        workingTurnIds: [...ids.working_turn_id].slice(0, 16),
        requestIds: [...ids.request_id].slice(0, 16),
        nestedTypes: [...ids.type].slice(0, 32),
        bytesObserved: this.bytes,
        pingCount: this.pings,
      }
      if (topType === 'resume_conversation_token' && typeof parsed.token === 'string') {
        record.resumeTokenSeen = true
        record.resumeTokenLength = parsed.token.length
        record.resumeTokenSha256 = sha256(parsed.token)
      }
      if (topType === 'stream_handoff') {
        record.handoffOptions = Array.isArray(parsed.options)
          ? parsed.options.map(option => ({ type: option?.type ?? null, topicId: option?.topic_id ?? null }))
          : []
      }
      if (topType === 'safety_review_update') {
        record.safetyReviewActive = typeof parsed.active === 'boolean' ? parsed.active : null
        record.protectionType = typeof parsed.protection_type === 'string' ? parsed.protection_type : null
      }
      this.eventCount += 1
      this.emit(record)
    }
  }

  finish(at = Date.now(), failedReason = null) {
    if (this.buffer.trim()) this.consumeBlock(this.buffer, at)
    this.buffer = ''
    this.emit({
      kind: failedReason ? 'sse-failed' : 'sse-finished',
      at,
      ...this.meta,
      bytesObserved: this.bytes,
      pingCount: this.pings,
      eventCount: this.eventCount,
      failedReason,
    })
  }
}

async function main() {
  const flags = parseArgs(process.argv.slice(2))
  const cdpHttp = String(flags.get('cdp') || DEFAULT_CDP).replace(/\/$/u, '')
  const durationSeconds = numberFlag(flags, 'duration', DEFAULT_DURATION_SECONDS)
  const idbSampleMs = Math.max(1000, numberFlag(flags, 'idb-sample-ms', DEFAULT_IDB_SAMPLE_MS))
  const logPath = path.resolve(String(flags.get('log') || path.join('data', `cross-device-flight-${safeStamp()}.jsonl`)))
  await fsp.mkdir(path.dirname(logPath), { recursive: true })
  const stream = fs.createWriteStream(logPath, { flags: 'a', encoding: 'utf8' })
  const write = record => stream.write(`${JSON.stringify({ ts: nowIso(), ...record })}\n`)

  const version = await fetch(`${cdpHttp}/json/version`).then(response => response.json())
  if (!version.webSocketDebuggerUrl) throw new Error('Chrome /json/version missing webSocketDebuggerUrl')
  const cdp = new BrowserCdp(version.webSocketDebuggerUrl)
  await cdp.connect()

  const sessions = new Map()
  const targetSessions = new Map()
  const requests = new Map()
  const sseTrackers = new Map()
  const sockets = new Map()
  let lastIdbSignature = null
  let stopping = false

  const requestKey = (sessionId, requestId) => `${sessionId || 'browser'}:${requestId}`
  const sessionMeta = sessionId => sessions.get(sessionId) || { targetId: null, type: null, url: null, title: null }

  const setupSession = async (sessionId, info) => {
    if (!sessionId || sessions.has(sessionId)) return
    sessions.set(sessionId, {
      targetId: info?.targetId ?? null,
      type: info?.type ?? null,
      url: info?.url ?? null,
      title: info?.title ?? null,
    })
    if (info?.targetId) targetSessions.set(info.targetId, sessionId)
    write({ kind: 'target-attached', sessionId, targetId: info?.targetId ?? null, targetType: info?.type ?? null, url: safeUrl(info?.url ?? '') })
    await Promise.allSettled([
      cdp.send('Network.enable', { maxTotalBufferSize: 100_000_000, maxResourceBufferSize: 10_000_000, maxPostDataSize: 2_000_000 }, sessionId),
      cdp.send('Runtime.enable', {}, sessionId),
      info?.type === 'page' ? cdp.send('Page.enable', {}, sessionId) : Promise.resolve(),
    ])
    await cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {})
  }

  cdp.on('Target.attachedToTarget', (params) => {
    if (!isInterestingTarget(params.targetInfo)) return
    void setupSession(params.sessionId, params.targetInfo)
  })
  cdp.on('Target.detachedFromTarget', params => {
    const meta = sessions.get(params.sessionId)
    write({ kind: 'target-detached', sessionId: params.sessionId, targetId: meta?.targetId ?? params.targetId ?? null })
    sessions.delete(params.sessionId)
  })
  cdp.on('Target.targetInfoChanged', params => {
    const info = params.targetInfo
    const sessionId = targetSessions.get(info?.targetId)
    if (!sessionId) return
    const previous = sessions.get(sessionId) || {}
    sessions.set(sessionId, { ...previous, url: info.url ?? previous.url, title: info.title ?? previous.title, type: info.type ?? previous.type })
    if (String(info.url || '').includes('chatgpt.com')) write({ kind: 'target-info', sessionId, targetId: info.targetId, targetType: info.type, url: safeUrl(info.url) })
  })

  cdp.on('Network.requestWillBeSent', (params, sessionId) => {
    const kind = endpointKind(params.request?.url)
    if (!kind) return
    const meta = sessionMeta(sessionId)
    const key = requestKey(sessionId, params.requestId)
    const record = {
      sessionId,
      targetId: meta.targetId,
      targetType: meta.type,
      requestId: params.requestId,
      kind,
      url: safeUrl(params.request.url),
      method: params.request.method,
      startedAt: Date.now(),
      requestBody: requestBodySummary(params.request.postData),
    }
    requests.set(key, record)
    write({
      kind: 'http-request',
      at: Date.now(),
      sessionId,
      targetId: meta.targetId,
      targetType: meta.type,
      requestId: params.requestId,
      endpoint: kind,
      method: params.request.method,
      url: record.url,
      headers: headerShape(params.request.headers),
      requestBody: record.requestBody,
      initiatorType: params.initiator?.type ?? null,
    })
  })

  cdp.on('Network.responseReceived', (params, sessionId) => {
    const key = requestKey(sessionId, params.requestId)
    const record = requests.get(key)
    if (!record) return
    record.status = params.response?.status ?? null
    record.mimeType = params.response?.mimeType ?? null
    write({
      kind: 'http-response', at: Date.now(), sessionId, targetId: record.targetId, requestId: params.requestId,
      endpoint: record.kind, status: record.status, mimeType: record.mimeType,
    })
    if (['conversation-send', 'conversation-resume', 'steer-turn'].includes(record.kind)
      && String(record.mimeType || '').includes('event-stream')) {
      const tracker = new SseTracker({
        sessionId,
        targetId: record.targetId,
        requestId: params.requestId,
        transport: record.kind,
      }, write)
      sseTrackers.set(key, tracker)
      void cdp.send('Network.streamResourceContent', { requestId: params.requestId }, sessionId).then(result => {
        if (typeof result.bufferedData === 'string' && result.bufferedData) tracker.ingestBase64(result.bufferedData)
      }).catch(error => {
        write({ kind: 'sse-stream-resource-error', at: Date.now(), sessionId, targetId: record.targetId, requestId: params.requestId, error: String(error) })
      })
    }
  })

  cdp.on('Network.dataReceived', (params, sessionId) => {
    const tracker = sseTrackers.get(requestKey(sessionId, params.requestId))
    if (tracker && typeof params.data === 'string' && params.data) tracker.ingestBase64(params.data)
  })

  cdp.on('Network.loadingFinished', (params, sessionId) => {
    const key = requestKey(sessionId, params.requestId)
    const record = requests.get(key)
    const tracker = sseTrackers.get(key)
    if (tracker) {
      tracker.finish(Date.now())
      sseTrackers.delete(key)
    }
    if (!record) return
    if (['stream-status', 'conversation-body', 'conversation-list', 'conversation-init'].includes(record.kind)) {
      void cdp.send('Network.getResponseBody', { requestId: params.requestId }, sessionId).then(result => {
        let text = String(result.body || '')
        if (result.base64Encoded) text = Buffer.from(text, 'base64').toString('utf8')
        let body = null
        try { body = text ? JSON.parse(text) : null } catch {}
        write({
          kind: 'http-body-summary', at: Date.now(), sessionId, targetId: record.targetId, requestId: params.requestId,
          endpoint: record.kind, summary: summarizeJsonResponse(record.kind, body), bodyBytes: Buffer.byteLength(text, 'utf8'),
        })
      }).catch(error => {
        write({ kind: 'http-body-unavailable', at: Date.now(), sessionId, targetId: record.targetId, requestId: params.requestId, endpoint: record.kind, error: String(error) })
      })
    }
  })

  cdp.on('Network.loadingFailed', (params, sessionId) => {
    const key = requestKey(sessionId, params.requestId)
    const record = requests.get(key)
    const tracker = sseTrackers.get(key)
    if (tracker) {
      tracker.finish(Date.now(), params.errorText || 'loadingFailed')
      sseTrackers.delete(key)
    }
    if (record) write({ kind: 'http-failed', at: Date.now(), sessionId, targetId: record.targetId, requestId: params.requestId, endpoint: record.kind, errorText: params.errorText ?? null, canceled: params.canceled ?? null })
  })

  cdp.on('Network.webSocketCreated', (params, sessionId) => {
    let u
    try { u = new URL(params.url) } catch { return }
    if (!u.hostname.endsWith('chatgpt.com')) return
    const key = requestKey(sessionId, params.requestId)
    const meta = sessionMeta(sessionId)
    sockets.set(key, { sessionId, targetId: meta.targetId, requestId: params.requestId, url: `${u.protocol}//${u.host}${u.pathname}` })
    write({ kind: 'wss-created', at: Date.now(), sessionId, targetId: meta.targetId, requestId: params.requestId, url: `${u.protocol}//${u.host}${u.pathname}` })
  })
  cdp.on('Network.webSocketClosed', (params, sessionId) => {
    const socket = sockets.get(requestKey(sessionId, params.requestId))
    if (!socket) return
    write({ kind: 'wss-closed', at: Date.now(), sessionId, targetId: socket.targetId, requestId: params.requestId })
  })
  for (const direction of ['Sent', 'Received']) {
    cdp.on(`Network.webSocketFrame${direction}`, (params, sessionId) => {
      const socket = sockets.get(requestKey(sessionId, params.requestId))
      if (!socket) return
      write({
        kind: 'wss-frame', at: Date.now(), direction: direction.toLowerCase(), sessionId, targetId: socket.targetId,
        requestId: params.requestId, opcode: params.response?.opcode ?? null,
        summary: summarizeWssFrame(params.response?.payloadData),
      })
    })
  }

  await cdp.send('Target.setDiscoverTargets', { discover: true })
  await cdp.send('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
    filter: [
      { type: 'page', exclude: false },
      { type: 'iframe', exclude: false },
      { type: 'worker', exclude: false },
      { type: 'service_worker', exclude: false },
      { type: 'shared_worker', exclude: false },
      { exclude: true },
    ],
  })

  const targets = await cdp.send('Target.getTargets')
  for (const info of targets.targetInfos || []) {
    if (!isInterestingTarget(info) || targetSessions.has(info.targetId)) continue
    try {
      const attached = await cdp.send('Target.attachToTarget', { targetId: info.targetId, flatten: true })
      await setupSession(attached.sessionId, info)
    }
    catch {}
  }

  const sampleIdb = async () => {
    const pageEntry = [...sessions.entries()].find(([, meta]) => meta.type === 'page' && String(meta.url || '').startsWith('https://chatgpt.com'))
    if (!pageEntry) return
    const [sessionId, meta] = pageEntry
    const expression = `(async()=>{
      try {
        const db=await new Promise((resolve,reject)=>{const req=indexedDB.open('codex-browser-host');req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)});
        if(!db.objectStoreNames.contains('records')){db.close();return {ok:false,reason:'no-records-store'}}
        const tx=db.transaction('records','readonly');const store=tx.objectStore('records');
        const record=await new Promise((resolve,reject)=>{const req=store.get('codex.browser.persistedAtomState');req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)});
        db.close();
        const bucket=record&&record['chatgpt-conversation-resume-tokens-v1'];
        if(!bucket||typeof bucket!=='object')return {ok:true,entries:[]};
        const entries=[];
        for(const [key,value] of Object.entries(bucket)){
          const match=String(key).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
          const token=value&&typeof value==='object'&&typeof value.token==='string'?value.token:null;
          let digest=null;
          if(token){const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token)));digest=Array.from(bytes).map(x=>x.toString(16).padStart(2,'0')).join('');}
          entries.push({conversationId:match?match[0]:null,tokenLength:token?token.length:null,tokenSha256:digest,fields:value&&typeof value==='object'?Object.keys(value).sort():[]});
        }
        entries.sort((a,b)=>String(a.conversationId).localeCompare(String(b.conversationId)));
        return {ok:true,entries};
      } catch(error) { return {ok:false,reason:String(error)}; }
    })()`
    try {
      const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId, 10000)
      const value = result.result?.value
      if (!value) return
      const signature = JSON.stringify(value)
      if (signature === lastIdbSignature) return
      lastIdbSignature = signature
      write({ kind: 'resume-store-snapshot', at: Date.now(), sessionId, targetId: meta.targetId, ...value })
    }
    catch {}
  }

  const idbTimer = setInterval(() => { void sampleIdb() }, idbSampleMs)
  await sampleIdb()

  write({ kind: 'recorder-ready', at: Date.now(), pid: process.pid, durationSeconds, idbSampleMs, initialSessions: sessions.size })
  console.log(`[cross-device-recorder] READY pid=${process.pid}`)
  console.log(`[cross-device-recorder] log=${logPath}`)
  console.log('[cross-device-recorder] 现在可以在手机发起长 turn；PC 打开该 conversation 时无需重启 recorder。')

  const stop = async reason => {
    if (stopping) return
    stopping = true
    clearInterval(idbTimer)
    write({ kind: 'recorder-stop', at: Date.now(), reason, sessions: sessions.size, trackedRequests: requests.size, trackedSockets: sockets.size })
    await new Promise(resolve => stream.end(resolve))
    cdp.close()
  }

  process.on('SIGINT', () => { void stop('SIGINT').then(() => process.exit(0)) })
  process.on('SIGTERM', () => { void stop('SIGTERM').then(() => process.exit(0)) })

  if (durationSeconds > 0) {
    await new Promise(resolve => setTimeout(resolve, durationSeconds * 1000))
    await stop('duration-complete')
  }
  else await new Promise(() => {})
}

main().catch(error => {
  console.error('[cross-device-recorder] fatal:', error)
  process.exitCode = 1
})

