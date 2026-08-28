#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { gzipSync } from 'node:zlib'
import { ChatArchiveDb } from '../src/local/archive-db.ts'

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
      if (message.method) {
        for (const handler of this.listeners.get(message.method) || []) handler(message.params || {})
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
  const positionals = []
  const flags = new Map()
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i]
    if (value.startsWith('--')) {
      const name = value.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) {
        flags.set(name, next)
        i += 1
      }
      else flags.set(name, true)
    }
    else positionals.push(value)
  }
  return { positionals, flags }
}

function sanitizeCapturedHeaders(headers) {
  const allowed = new Set([
    'authorization',
    'oai-client-build-number',
    'oai-client-version',
    'oai-device-id',
    'oai-language',
    'oai-session-id',
    'X-OAI-IS-Client-Observation',
  ])
  return Object.fromEntries(Object.entries(headers || {}).filter(([key]) => allowed.has(key)))
}

async function selectChatgptTab(cdpHttp) {
  const tabs = await fetch(`${cdpHttp}/json/list`).then(response => response.json())
  const candidates = tabs.filter(tab => tab.type === 'page' && /^https:\/\/chatgpt\.com\//u.test(tab.url || ''))
  if (candidates.length === 0) throw new Error(`No logged-in ChatGPT page found at ${cdpHttp}`)
  return candidates.find(tab => /\/c\//u.test(tab.url)) || candidates[0]
}

async function captureBackendHeaders(client, timeoutMs = 12_000) {
  await client.send('Network.enable')
  await client.send('Page.enable')
  await client.send('Runtime.enable')

  let captured = null
  const off = client.on('Network.requestWillBeSent', (params) => {
    const request = params.request || {}
    if (captured || !String(request.url || '').includes('/backend-api/')) return
    const headers = sanitizeCapturedHeaders(request.headers)
    if (typeof headers.authorization === 'string' && headers.authorization.length > 20) captured = headers
  })

  // Explicit sync is allowed to refresh one already-open ChatGPT tab once. This generates a genuine
  // ChatGPT backend request whose in-memory auth context we can reuse. No token is printed or persisted.
  await client.send('Page.reload', { ignoreCache: false })
  const started = Date.now()
  while (!captured && Date.now() - started < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  off()
  if (!captured) throw new Error('Could not capture an authenticated ChatGPT backend request after reload')
  return captured
}

async function pageFetchText(client, { url, targetPath, targetRoute, headers }) {
  const expression = `(${async function fetchWithHeaders(url, targetPath, targetRoute, baseHeaders) {
    const response = await fetch(url, {
      credentials: 'include',
      headers: {
        ...baseHeaders,
        'X-OpenAI-Target-Path': targetPath,
        'X-OpenAI-Target-Route': targetRoute,
      },
    })
    return { status: response.status, ok: response.ok, text: await response.text() }
  }.toString()})(${JSON.stringify(url)}, ${JSON.stringify(targetPath)}, ${JSON.stringify(targetRoute)}, ${JSON.stringify(headers)})`

  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  const value = result?.result?.value
  if (!value || typeof value.status !== 'number') throw new Error(`No fetch result for ${url}`)
  if (!value.ok) throw new Error(`ChatGPT backend ${value.status} for ${url}: ${String(value.text || '').slice(0, 300)}`)
  return String(value.text || '')
}

async function fetchConversation(client, id, headers, numTurns) {
  const pluralPath = `/backend-api/conversations/${encodeURIComponent(id)}`
  const pluralUrl = `${pluralPath}?include_has_versions=true&num_turns=${encodeURIComponent(numTurns)}`
  try {
    const text = await pageFetchText(client, {
      url: pluralUrl,
      targetPath: pluralPath,
      targetRoute: '/backend-api/conversations/{conversation_id}',
      headers,
    })
    const payload = JSON.parse(text)
    if (!Array.isArray(payload.messages)) throw new Error('plural response has no messages[]')
    return { transport: 'plural-messages', text, payload }
  }
  catch (pluralError) {
    const singularPath = `/backend-api/conversation/${encodeURIComponent(id)}`
    try {
      const text = await pageFetchText(client, {
        url: singularPath,
        targetPath: singularPath,
        targetRoute: '/backend-api/conversation/{conversation_id}',
        headers,
      })
      const payload = JSON.parse(text)
      if (!payload.mapping || typeof payload.mapping !== 'object') throw new Error('singular response has no mapping')
      return { transport: 'singular-mapping-fallback', text, payload }
    }
    catch (singularError) {
      throw new Error(`Both ChatGPT conversation transports failed. plural=${pluralError.message}; singular=${singularError.message}`)
    }
  }
}

async function saveRawSnapshot(rawDir, id, transport, text) {
  await fs.mkdir(rawDir, { recursive: true })
  const file = path.join(rawDir, `${id}.${transport}.json.gz`)
  await fs.writeFile(file, gzipSync(Buffer.from(text, 'utf8'), { level: 6 }))
  return file
}

async function syncOne(id, flags) {
  const cdpHttp = String(flags.get('cdp') || 'http://127.0.0.1:9222').replace(/\/$/u, '')
  const numTurns = Number(flags.get('num-turns') || 100)
  if (!Number.isInteger(numTurns) || numTurns <= 0 || numTurns > 1000) throw new Error('--num-turns must be 1..1000')
  const dbPath = path.resolve(String(flags.get('db') || 'data/chatgpt-archive.sqlite'))
  const rawDir = path.resolve(String(flags.get('raw-dir') || 'data/raw'))

  const tab = await selectChatgptTab(cdpHttp)
  const client = new CdpClient(tab.webSocketDebuggerUrl)
  await client.connect()
  try {
    const headers = await captureBackendHeaders(client)
    const fetched = await fetchConversation(client, id, headers, numTurns)
    const rawFile = await saveRawSnapshot(rawDir, id, fetched.transport, fetched.text)
    const archive = new ChatArchiveDb(dbPath)
    try {
      const imported = archive.importRaw(fetched.payload, Date.now())
      return {
        conversationId: id,
        title: imported.title,
        transport: fetched.transport,
        rawBytes: Buffer.byteLength(fetched.text, 'utf8'),
        rawFile,
        database: dbPath,
        messageCount: imported.messageCount,
        visibleMessageCount: imported.visibleMessageCount,
        resourceCount: imported.resourceCount,
      }
    }
    finally {
      archive.close()
    }
  }
  finally {
    client.close()
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  const { positionals, flags } = parseArgs(rest)
  if (command !== 'one') {
    console.error('Usage: node scripts/sync-chatgpt.mjs one <conversation-id> [--cdp http://127.0.0.1:9222] [--num-turns 100] [--db path] [--raw-dir path]')
    process.exitCode = 2
    return
  }
  const id = positionals[0]
  if (!id) throw new Error('sync one requires a conversation ID')
  const result = await syncOne(id, flags)
  console.log(JSON.stringify(result, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
