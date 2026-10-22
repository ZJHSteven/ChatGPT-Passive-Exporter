#!/usr/bin/env node

/**
 * Archive Bridge production smoke test。
 *
 * 设计目标：
 * 1. Bridge token 只从本机 data/*.local.json 读取，绝不放进命令行参数或打印到 stdout；
 * 2. 默认只做无副作用的 health/auth/list/messages/SSE 检查；
 * 3. 只有显式传入 `--marker NAME` 时，才通过 `/v1/turns` 创建一条隔离测试聊天；
 * 4. 有 marker 时，在 POST 之前先挂 `/v1/events`，因此可以证明 actor-accepted、LiveTurn/WSS、
 *    canonical-update 是否真的通过 Bridge 到达，而不是仅靠事后读取数据库猜测；
 * 5. 最终再经 Bridge messages 轮询确认 assistant canonical 文本含 marker，形成端到端闭环。
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_AUTH_PATH = path.join(PROJECT_ROOT, 'data', 'archive-bridge-auth.local.json')
const DEFAULT_BASE = 'http://127.0.0.1:47832'

function parseArgs(argv) {
  const flags = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const name = token.slice(2)
    const next = argv[index + 1]
    if (next && !next.startsWith('--')) {
      flags.set(name, next)
      index += 1
    }
    else flags.set(name, true)
  }
  return flags
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** 只返回 SSE 中我们自己的脱敏字段；未知字段不会进入 smoke 输出。 */
function parseSseBlock(block) {
  if (!block || block.startsWith(':')) return null
  let eventName = null
  let dataText = null
  for (const line of block.split(/\r?\n/u)) {
    if (line.startsWith('event:')) eventName = line.slice('event:'.length).trim()
    else if (line.startsWith('data:')) dataText = line.slice('data:'.length).trim()
  }
  if (!eventName || !dataText) return null
  let data = null
  try { data = JSON.parse(dataText) }
  catch { return { event: eventName, malformedData: true } }
  return {
    event: eventName,
    conversationId: typeof data?.conversationId === 'string' ? data.conversationId : null,
    detail: typeof data?.event === 'string' ? data.event : null,
    transport: typeof data?.transport === 'string' ? data.transport : null,
    bodyCompletionEvidence: typeof data?.bodyCompletionEvidence === 'string' ? data.bodyCompletionEvidence : null,
    tailShape: typeof data?.tailShape === 'string' ? data.tailShape : null,
  }
}

/**
 * 先建立 SSE，再让调用方发 POST。reader 在后台持续消费，避免 actor-accepted 在 HTTP 202
 * 返回前就被错过。达到同 CID canonical-update 或超时后停止。
 */
async function startEventCapture(base, headers, timeoutMs) {
  const controller = new AbortController()
  const response = await fetch(`${base}/v1/events`, { headers, signal: controller.signal })
  if (!response.ok || !response.body) {
    throw new Error(`Bridge events HTTP ${response.status}`)
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const events = []
  let buffer = ''
  let acceptedConversationId = null
  let timer = null

  const done = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve({ timedOut: true, acceptedConversationId, events })
    }, timeoutMs)

    const consume = async () => {
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          buffer += decoder.decode(chunk.value, { stream: true })
          while (true) {
            const boundary = buffer.indexOf('\n\n')
            if (boundary < 0) break
            const block = buffer.slice(0, boundary)
            buffer = buffer.slice(boundary + 2)
            const parsed = parseSseBlock(block)
            if (!parsed) continue
            events.push(parsed)
            if (parsed.event === 'actor-accepted' && parsed.conversationId) {
              acceptedConversationId = parsed.conversationId
            }
            if (
              parsed.event === 'canonical-update'
              && acceptedConversationId
              && parsed.conversationId === acceptedConversationId
            ) {
              clearTimeout(timer)
              controller.abort()
              resolve({ timedOut: false, acceptedConversationId, events })
              return
            }
          }
        }
        clearTimeout(timer)
        resolve({ timedOut: false, acceptedConversationId, events })
      }
      catch (error) {
        if (error?.name === 'AbortError') return
        clearTimeout(timer)
        reject(error)
      }
    }
    void consume()
  })

  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    done,
    stop: async () => {
      clearTimeout(timer)
      controller.abort()
      await reader.cancel().catch(() => {})
    },
  }
}

async function main() {
  const flags = parseArgs(process.argv.slice(2))
  const base = String(flags.get('base') || DEFAULT_BASE).replace(/\/$/u, '')
  const authPath = flags.has('auth')
    ? path.resolve(String(flags.get('auth')))
    : DEFAULT_AUTH_PATH
  const marker = typeof flags.get('marker') === 'string' ? String(flags.get('marker')).trim() : null
  const timeoutMs = Math.max(5_000, Number(flags.get('timeout-ms') || 30_000))

  const auth = JSON.parse(await fs.readFile(authPath, 'utf8'))
  if (typeof auth?.token !== 'string' || auth.token.length < 32) {
    throw new Error('Bridge auth file does not contain a valid token')
  }
  const headers = { authorization: `Bearer ${auth.token}` }

  const health = await fetch(`${base}/health`)
  const unauthorized = await fetch(`${base}/v1/conversations`)
  const conversationsResponse = await fetch(`${base}/v1/conversations?limit=3`, { headers })
  const conversationsBody = await conversationsResponse.json()
  const firstConversationId = conversationsBody?.conversations?.[0]?.id ?? null
  let messagesStatus = null
  let messageCount = null
  let messageKeys = []
  if (typeof firstConversationId === 'string') {
    const messagesResponse = await fetch(
      `${base}/v1/conversations/${encodeURIComponent(firstConversationId)}/messages`,
      { headers },
    )
    const messagesBody = await messagesResponse.json()
    messagesStatus = messagesResponse.status
    messageCount = Array.isArray(messagesBody?.messages) ? messagesBody.messages.length : null
    messageKeys = messagesBody?.messages?.[0] ? Object.keys(messagesBody.messages[0]).sort() : []
  }

  // 无 marker 时仍验证 SSE 能握手并收到 bridge-ready，但不触发 ChatGPT 发送。
  const capture = await startEventCapture(base, headers, marker ? timeoutMs : 5_000)
  let turn = null
  let canonicalMarkerSeen = null
  if (marker) {
    const turnResponse = await fetch(`${base}/v1/turns`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'new',
        targetMode: 'guardian',
        text: `Reply only ${marker}.`,
      }),
    })
    const turnBody = await turnResponse.json()
    turn = {
      status: turnResponse.status,
      accepted: turnBody?.accepted === true,
      result: turnBody?.result ?? null,
      resultKeys: turnBody?.result ? Object.keys(turnBody.result).sort() : [],
      internalFieldsExposed: Boolean(turnBody?.result && [
        'targetId', 'cdpRequestId', 'domSignatureBefore', 'domSignatureReady', 'navigationMode',
      ].some(key => Object.hasOwn(turnBody.result, key))),
    }

    const conversationId = typeof turnBody?.result?.conversationId === 'string'
      ? turnBody.result.conversationId
      : null
    if (conversationId) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const response = await fetch(
          `${base}/v1/conversations/${encodeURIComponent(conversationId)}/messages`,
          { headers },
        )
        if (response.ok) {
          const body = await response.json()
          const messages = Array.isArray(body?.messages) ? body.messages : []
          if (messages.some(item => item?.role === 'assistant' && String(item?.text || '').includes(marker))) {
            canonicalMarkerSeen = true
            break
          }
        }
        await sleep(500)
      }
      if (canonicalMarkerSeen !== true) canonicalMarkerSeen = false
    }
  }

  // 无副作用模式也等自己的 5 秒有界 capture 完成，这样 bridge-ready 会真实进入 events；
  // 不能用一个更短的 Promise.race 提前返回，否则会把“监听器已收到但 done 尚未 resolve”误报为空。
  const captured = await capture.done
  await capture.stop()

  const serialized = JSON.stringify({
    health: health.status,
    unauthorized: unauthorized.status,
    conversations: conversationsResponse.status,
    conversationCount: Array.isArray(conversationsBody?.conversations) ? conversationsBody.conversations.length : null,
    messagesStatus,
    messageCount,
    messageKeys,
    sseStatus: capture.status,
    sseContentType: capture.contentType,
    bridgeReadySeen: captured.events.some(event => event.event === 'bridge-ready'),
    turn,
    canonicalMarkerSeen,
    events: captured.events,
  })
  // 最后一层自检：输出里绝不能包含实际 token。
  if (serialized.includes(auth.token)) throw new Error('Bridge token leaked into smoke output')
  console.log(serialized)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})
