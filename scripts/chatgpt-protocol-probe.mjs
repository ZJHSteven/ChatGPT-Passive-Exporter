import fs from 'node:fs/promises'
import path from 'node:path'

const CDP_HTTP = 'http://127.0.0.1:9222'
const PROJECT_ROOT = path.resolve(import.meta.dirname, '..')
const DEFAULT_OUT_DIR = path.join(PROJECT_ROOT, 'data', 'protocol-probes')
const DEFAULT_CONVERSATION_ID = '6ab7cabd-dd70-83e9-bc4e-d3d6cbf55b00'

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
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP connect timeout')), 5000)
      this.ws.addEventListener('open', () => {
        clearTimeout(timer)
        resolve()
      }, { once: true })
      this.ws.addEventListener('error', () => {
        clearTimeout(timer)
        reject(new Error('CDP websocket error'))
      }, { once: true })
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
      for (const listener of this.listeners.get(message.method) || []) {
        try { listener(message.params || {}) } catch {}
      }
    })
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) || []
    listeners.push(listener)
    this.listeners.set(method, listeners)
  }

  async send(method, params = {}, timeoutMs = 30000) {
    if (!this.ws) throw new Error('CDP not connected')
    const id = this.nextId++
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('CDP ' + method + ' timeout'))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  close() {
    try { this.ws?.close() } catch {}
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

function query(params) {
  const result = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue
    result.set(key, String(value))
  }
  return result.toString()
}

function headerEntries(headers) {
  return Object.entries(headers || {}).map(([name, value]) => ({ name, value: String(value) }))
}

function summarizeJson(body) {
  if (!body || typeof body !== 'object') return null
  const items = Array.isArray(body.items) ? body.items : null
  const messages = Array.isArray(body.messages) ? body.messages : null
  const mapping = body.mapping && typeof body.mapping === 'object' ? body.mapping : null
  return {
    topLevelKeys: Object.keys(body).sort(),
    itemCount: items?.length ?? null,
    total: body.total ?? null,
    limit: body.limit ?? null,
    offset: body.offset ?? null,
    itemIds: items ? items.map(item => item?.id ?? item?.conversation_id).filter(Boolean) : null,
    itemKeyUnion: items
      ? [...new Set(items.flatMap(item => item && typeof item === 'object' ? Object.keys(item) : []))].sort()
      : null,
    itemOrigins: items
      ? [...new Set(items.map(item => item?.conversation_origin).filter(value => value !== undefined && value !== null))]
      : null,
    itemArchivedValues: items
      ? [...new Set(items.map(item => item?.is_archived).filter(value => value !== undefined))]
      : null,
    itemStarredValues: items
      ? [...new Set(items.map(item => item?.is_starred).filter(value => value !== undefined))]
      : null,
    messageCount: messages?.length ?? null,
    messageIds: messages ? messages.map(message => message?.id).filter(Boolean) : null,
    hasVersionMessageCount: messages
      ? messages.filter(message => message?.metadata?.has_versions === true).length
      : null,
    pageInfo: body.page_info ?? null,
    currentNode: body.current_node ?? null,
    conversationId: body.conversation_id ?? body.id ?? null,
    mappingNodeCount: mapping ? Object.keys(mapping).length : null,
    streamStatus: body.status ?? body.stream_status ?? null,
  }
}

async function main() {
  if (!process.argv.includes('--allow-active-probe')) {
    throw new Error('Refusing active private-API probe without --allow-active-probe')
  }
  const skipListBasics = process.argv.includes('--skip-list-basics')
  const conversationId = argValue('--conversation-id', DEFAULT_CONVERSATION_ID)
  const gapMs = Number(argValue('--gap-ms', '6000'))
  const targets = await fetch(CDP_HTTP + '/json/list').then(response => response.json())
  const guardian = targets.find(target => {
    try {
      const url = new URL(target.url || '')
      return target.type === 'page'
        && url.origin === 'https://chatgpt.com'
        && url.searchParams.get('chatgpt-archive-guardian') === '1'
    }
    catch { return false }
  })
  if (!guardian?.webSocketDebuggerUrl) throw new Error('Guardian page not found')

  const page = new CdpClient(guardian.webSocketDebuggerUrl)
  await page.connect()
  await page.send('Runtime.enable')

  let nativeHeaderTemplate = null
  let nativeTemplateShape = null
  let pendingProbe = null

  page.on('Fetch.requestPaused', event => {
    void (async () => {
      const request = event.request || {}
      const requestUrl = String(request.url || '')
      let pathname = ''
      try { pathname = new URL(requestUrl).pathname } catch {}

      if (!nativeHeaderTemplate
        && request.method === 'GET'
        && pathname === '/backend-api/conversations') {
        // Opaque in-memory template only. Header values are never serialized or logged.
        nativeHeaderTemplate = { ...(request.headers || {}) }
        nativeTemplateShape = {
          method: request.method,
          url: requestUrl,
          headerNames: Object.keys(request.headers || {}).map(name => name.toLowerCase()).sort(),
        }
      }

      if (pendingProbe) {
        let relative = null
        try {
          const parsed = new URL(requestUrl)
          relative = parsed.pathname + parsed.search
        }
        catch {}
        if (relative === pendingProbe.requestPath && nativeHeaderTemplate) {
          const mergedHeaders = {
            ...(request.headers || {}),
            ...nativeHeaderTemplate,
          }
          if (pendingProbe.targetPath) mergedHeaders['x-openai-target-path'] = pendingProbe.targetPath
          if (pendingProbe.targetRoute) mergedHeaders['x-openai-target-route'] = pendingProbe.targetRoute
          await page.send('Fetch.continueRequest', {
            requestId: event.requestId,
            headers: headerEntries(mergedHeaders),
          })
          return
        }
      }

      await page.send('Fetch.continueRequest', { requestId: event.requestId })
    })().catch(() => {})
  })

  await page.send('Fetch.enable', {
    patterns: [{ urlPattern: 'https://chatgpt.com/backend-api/*', requestStage: 'Request' }],
  })
  await page.send('Page.reload', { ignoreCache: false })

  const templateDeadline = Date.now() + 20000
  while (!nativeHeaderTemplate && Date.now() < templateDeadline) await sleep(100)
  if (!nativeHeaderTemplate) throw new Error('No native conversation request template captured')
  await sleep(1000)

  const results = []
  let stopFor429 = false

  const probe = async (name, requestPath, targetPath, targetRoute) => {
    if (stopFor429) return null
    if (results.length > 0) await sleep(gapMs)
    pendingProbe = { requestPath, targetPath, targetRoute }
    const expression = '(' + (async function request(path) {
      const response = await fetch(path, { credentials: 'include' })
      const text = await response.text()
      let body = null
      try { body = text ? JSON.parse(text) : null } catch {}
      return {
        status: response.status,
        ok: response.ok,
        contentType: response.headers.get('content-type'),
        text,
        body,
      }
    }).toString() + ')(' + JSON.stringify(requestPath) + ')'
    const evaluated = await page.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    }, 60000)
    pendingProbe = null
    const response = evaluated.result?.value
    if (!response || typeof response.status !== 'number') throw new Error('No fetch result for ' + name)
    const record = {
      name,
      requestPath,
      status: response.status,
      ok: response.ok,
      contentType: response.contentType,
      summary: summarizeJson(response.body),
      body: response.body,
      textPreview: response.body ? null : String(response.text || '').slice(0, 500),
    }
    results.push(record)
    console.log(JSON.stringify({ name, status: record.status, summary: record.summary }))
    if (response.status === 429) stopFor429 = true
    return record
  }

  const listTarget = '/backend-api/conversations'
  const baseFilters = {
    expand: false,
    hide_snorlax: false,
    is_archived: false,
    is_starred: false,
    limit: 20,
    order: 'updated',
    offset: 0,
  }
  const listPath = params => listTarget + '?' + query(params)

  if (!skipListBasics) {
    await probe('list-unfiltered-current', listPath(baseFilters), listTarget, listTarget)
    await probe('list-origin-tpp', listPath({ ...baseFilters, conversation_origin: 'tpp' }), listTarget, listTarget)
    await probe('list-exclude-origin-tpp', listPath({ ...baseFilters, exclude_conversation_origin: 'tpp' }), listTarget, listTarget)
  }
  {
    const { expand, ...rest } = baseFilters
    await probe('list-expand-omitted', listPath(rest), listTarget, listTarget)
  }
  await probe('list-expand-true', listPath({ ...baseFilters, expand: true }), listTarget, listTarget)
  await probe('list-hide-snorlax-true', listPath({ ...baseFilters, hide_snorlax: true }), listTarget, listTarget)
  {
    const { hide_snorlax, ...rest } = baseFilters
    await probe('list-hide-snorlax-omitted', listPath(rest), listTarget, listTarget)
  }
  {
    const { is_archived, is_starred, ...rest } = baseFilters
    await probe('list-archive-star-omitted', listPath(rest), listTarget, listTarget)
  }
  await probe('list-archived-only', listPath({ ...baseFilters, is_archived: true }), listTarget, listTarget)
  await probe('list-starred-only', listPath({ ...baseFilters, is_starred: true }), listTarget, listTarget)
  await probe('list-limit-28', listPath({ ...baseFilters, limit: 28 }), listTarget, listTarget)
  await probe('list-offset-20', listPath({ ...baseFilters, offset: 20 }), listTarget, listTarget)
  await probe('list-order-created', listPath({ ...baseFilters, order: 'created' }), listTarget, listTarget)

  const pluralTarget = '/backend-api/conversations/' + encodeURIComponent(conversationId)
  const latest10 = await probe(
    'body-latest-10-versions',
    pluralTarget + '?' + query({ num_turns: 10, include_has_versions: true }),
    pluralTarget,
    '/backend-api/conversations/{conversation_id}',
  )
  await probe(
    'body-latest-10-no-version-param',
    pluralTarget + '?' + query({ num_turns: 10 }),
    pluralTarget,
    '/backend-api/conversations/{conversation_id}',
  )
  await probe(
    'body-latest-10-versions-false',
    pluralTarget + '?' + query({ num_turns: 10, include_has_versions: false }),
    pluralTarget,
    '/backend-api/conversations/{conversation_id}',
  )
  await probe(
    'body-latest-2',
    pluralTarget + '?' + query({ num_turns: 2, include_has_versions: true }),
    pluralTarget,
    '/backend-api/conversations/{conversation_id}',
  )
  await probe(
    'body-latest-1',
    pluralTarget + '?' + query({ num_turns: 1, include_has_versions: true }),
    pluralTarget,
    '/backend-api/conversations/{conversation_id}',
  )
  await probe(
    'body-latest-no-query',
    pluralTarget,
    pluralTarget,
    '/backend-api/conversations/{conversation_id}',
  )

  const cursor = latest10?.body?.page_info?.start_cursor
  if (!stopFor429 && typeof cursor === 'string' && cursor) {
    const cursorTarget = pluralTarget + '/messages'
    await probe(
      'body-cursor-10-versions',
      cursorTarget + '?' + query({ before: cursor, include_has_versions: true, num_turns: 10 }),
      cursorTarget,
      '/backend-api/conversations/{conversation_id}/messages',
    )
    await probe(
      'body-cursor-10-no-version-param',
      cursorTarget + '?' + query({ before: cursor, num_turns: 10 }),
      cursorTarget,
      '/backend-api/conversations/{conversation_id}/messages',
    )
    await probe(
      'body-cursor-2',
      cursorTarget + '?' + query({ before: cursor, include_has_versions: true, num_turns: 2 }),
      cursorTarget,
      '/backend-api/conversations/{conversation_id}/messages',
    )
  }

  const singularTarget = '/backend-api/conversation/' + encodeURIComponent(conversationId)
  await probe(
    'body-singular-mapping',
    singularTarget,
    singularTarget,
    '/backend-api/conversation/{conversation_id}',
  )
  const streamTarget = singularTarget + '/stream_status'
  await probe(
    'stream-status',
    streamTarget,
    streamTarget,
    '/backend-api/conversation/{conversation_id}/stream_status',
  )

  const report = {
    capturedAt: new Date().toISOString(),
    guardianTargetId: guardian.id,
    conversationId,
    nativeTemplateShape,
    gapMs,
    stoppedFor429: stopFor429,
    results,
  }
  await fs.mkdir(DEFAULT_OUT_DIR, { recursive: true })
  const safeStamp = report.capturedAt.replace(/[:.]/gu, '-')
  const outputPath = path.join(DEFAULT_OUT_DIR, safeStamp + '.json')
  await fs.writeFile(outputPath, JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ outputPath, requestCount: results.length, stoppedFor429 }))
  await page.send('Fetch.disable').catch(() => {})
  page.close()
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})
