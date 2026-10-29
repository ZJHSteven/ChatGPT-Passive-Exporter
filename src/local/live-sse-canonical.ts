import type { RawChatMessage } from '../core/types.ts'

type JsonRecord = Record<string, unknown>

export interface LiveSseCanonicalSnapshot {
  protocolVersion: string | null
  conversationId: string | null
  turnExchangeId: string | null
  requestId: string | null
  title: string | null
  messages: RawChatMessage[]
  currentNode: string | null
  messageStreamComplete: boolean
  doneSeen: boolean
  decodeErrors: string[]
  /** 服务端通过 SSE 返回的终止错误，不是前端 DOM 推测。 */
  serverError: LiveSseServerError | null
  complete: boolean
}

export interface LiveSseServerError {
  conversationId: string
  code: string
  reason: string | null
  message: string
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function pointerTokens(pointer: string): string[] {
  if (pointer === '') return []
  if (!pointer.startsWith('/')) throw new Error(`invalid JSON pointer: ${pointer}`)
  return pointer.slice(1).split('/').map(token => token.replace(/~1/gu, '/').replace(/~0/gu, '~'))
}

function arrayIndex(token: string, length: number, allowAppend = false): number {
  if (allowAppend && token === '-') return length
  if (!/^(?:0|[1-9]\d*)$/u.test(token)) throw new Error(`invalid array index: ${token}`)
  const index = Number(token)
  if (!Number.isSafeInteger(index) || index < 0) throw new Error(`invalid array index: ${token}`)
  return index
}

/**
 * 应用当前 ChatGPT Web v1 SSE 已实证使用的 JSON-pointer 增量操作。
 *
 * 这里只支持 2026-10-16 真机 canary 已观察到的四类语义：
 * - add / replace：写入指定路径；
 * - append：字符串拼接、数组追加、对象浅合并；
 * - patch：外层批量操作，由调用方逐条展开。
 *
 * 对任何未知操作或不存在的中间路径都直接抛错。SSE 解码器随后会把整条流标记为
 * incomplete，让 daemon 保留 raw journal 并回退 canonical body，而不是“猜着修”。
 */
function applyPointerOperation(root: unknown, operation: JsonRecord): unknown {
  const op = typeof operation.o === 'string' ? operation.o : ''
  const pointer = typeof operation.p === 'string' ? operation.p : ''
  const value = cloneJson(operation.v)
  if (!['add', 'replace', 'append'].includes(op)) throw new Error(`unsupported SSE delta operation: ${op || 'missing'}`)

  const tokens = pointerTokens(pointer)
  if (tokens.length === 0) {
    if (op === 'add' || op === 'replace') return value
    if (op === 'append' && typeof root === 'string' && typeof value === 'string') return root + value
    if (op === 'append' && Array.isArray(root)) return [...root, ...(Array.isArray(value) ? value : [value])]
    if (op === 'append' && isRecord(root) && isRecord(value)) return { ...root, ...value }
    throw new Error(`unsupported root append: ${typeof root} + ${typeof value}`)
  }

  if (!isRecord(root) && !Array.isArray(root)) throw new Error('SSE delta root is not addressable')
  let parent: unknown = root
  for (const token of tokens.slice(0, -1)) {
    if (Array.isArray(parent)) {
      const index = arrayIndex(token, parent.length)
      if (index >= parent.length) throw new Error(`SSE delta path missing array item: ${pointer}`)
      parent = parent[index]
    }
    else if (isRecord(parent)) {
      if (!(token in parent)) throw new Error(`SSE delta path missing object key: ${pointer}`)
      parent = parent[token]
    }
    else throw new Error(`SSE delta path crosses scalar: ${pointer}`)
  }

  const key = tokens.at(-1)!
  if (Array.isArray(parent)) {
    const index = arrayIndex(key, parent.length, op === 'add')
    if (op === 'add') {
      if (index > parent.length) throw new Error(`SSE delta add index out of bounds: ${pointer}`)
      parent.splice(index, 0, value)
      return root
    }
    if (index >= parent.length) throw new Error(`SSE delta array index missing: ${pointer}`)
    if (op === 'replace') parent[index] = value
    else if (typeof parent[index] === 'string' && typeof value === 'string') parent[index] += value
    else if (Array.isArray(parent[index])) parent[index] = [...parent[index], ...(Array.isArray(value) ? value : [value])]
    else if (isRecord(parent[index]) && isRecord(value)) parent[index] = { ...parent[index], ...value }
    else throw new Error(`unsupported SSE delta append target: ${pointer}`)
    return root
  }

  if (!isRecord(parent)) throw new Error(`SSE delta parent is not an object: ${pointer}`)
  if (op === 'replace' && !(key in parent)) throw new Error(`SSE delta replace target missing: ${pointer}`)
  if (op === 'add' || op === 'replace') parent[key] = value
  else {
    const current = parent[key]
    if (typeof current === 'string' && typeof value === 'string') parent[key] = current + value
    else if (Array.isArray(current)) parent[key] = [...current, ...(Array.isArray(value) ? value : [value])]
    else if (isRecord(current) && isRecord(value)) parent[key] = { ...current, ...value }
    else throw new Error(`unsupported SSE delta append target: ${pointer}`)
  }
  return root
}

/**
 * 把网页 `/f/conversation` v1 SSE 重建成“可证明完整”的 message snapshot。
 *
 * 当前真机协议的关键形态：
 * 1. 第一条 `data: "v1"` 声明 delta encoding 版本；
 * 2. 新 message 用 `{v:{message,conversation_id,...}, c:n}` 给完整 snapshot；
 * 3. 同一 message 后续用 `{o,p,v}` 或 `{o:"patch",v:[...]}` 做 JSON-pointer patch；
 * 4. 最后出现 `message_stream_complete` 与 `[DONE]`。
 *
 * 这不是宽松“尽量解析”器，而是 canonical promotion gate：只要任何一步不认识，就记 decodeErrors。
 * raw journal 仍然完整保留，daemon 继续走 body fallback，因此未知协议不会污染 SQLite。
 */
export class LiveSseCanonicalAccumulator {
  private buffer = ''
  private protocolVersion: string | null = null
  private currentRoot: unknown = null
  private conversationId: string | null = null
  private turnExchangeId: string | null = null
  private requestId: string | null = null
  private title: string | null = null
  private messageStreamComplete = false
  private doneSeen = false
  private decodeErrors: string[] = []
  private serverError: LiveSseServerError | null = null
  private messages = new Map<string, RawChatMessage>()

  ingestBase64(data: unknown): void {
    if (typeof data !== 'string' || !data) return
    this.ingestText(Buffer.from(data, 'base64').toString('utf8'))
  }

  ingestText(text: string): void {
    if (!text) return
    this.buffer += text
    while (true) {
      const match = /\r?\n\r?\n/u.exec(this.buffer)
      if (!match || match.index === undefined) break
      const block = this.buffer.slice(0, match.index)
      this.buffer = this.buffer.slice(match.index + match[0].length)
      this.ingestBlock(block)
    }
  }

  finish(): void {
    if (this.buffer.trim()) this.ingestBlock(this.buffer)
    this.buffer = ''
  }

  snapshot(): LiveSseCanonicalSnapshot {
    const messages = [...this.messages.values()].map(message => cloneJson(message))
    const finalAssistant = [...messages].reverse().find((message) => {
      const metadata = isRecord(message.metadata) ? message.metadata : {}
      return message.author?.role === 'assistant'
        && message.recipient === 'all'
        && metadata.is_visually_hidden_from_conversation !== true
        && message.status === 'finished_successfully'
        && message.end_turn === true
    })
    const complete = this.protocolVersion === 'v1'
      && this.messageStreamComplete
      && this.doneSeen
      && this.decodeErrors.length === 0
      && Boolean(this.conversationId)
      && Boolean(finalAssistant?.id)
    return {
      protocolVersion: this.protocolVersion,
      conversationId: this.conversationId,
      turnExchangeId: this.turnExchangeId,
      requestId: this.requestId,
      title: this.title,
      messages,
      currentNode: typeof finalAssistant?.id === 'string' ? finalAssistant.id : null,
      messageStreamComplete: this.messageStreamComplete,
      doneSeen: this.doneSeen,
      decodeErrors: [...this.decodeErrors],
      serverError: this.serverError ? { ...this.serverError } : null,
      complete,
    }
  }

  canonicalPayload(fallbackTitle = 'ChatGPT Conversation'): JsonRecord | null {
    const snapshot = this.snapshot()
    if (!snapshot.complete || !snapshot.conversationId || !snapshot.currentNode) return null
    return {
      conversation_id: snapshot.conversationId,
      title: snapshot.title || fallbackTitle,
      current_node: snapshot.currentNode,
      messages: snapshot.messages,
    }
  }

  /**
   * 返回“截至目前已可靠解码出的消息证据”。
   *
   * 与 canonicalPayload() 不同，这里**不要求** message_stream_complete / [DONE] / final assistant，
   * 也故意不携带 current_node。调用方只能把它作为 provisional union 证据合并，
   * 不能据此更新 conversation head、关闭 turn 或抑制 Body fallback。
   */
  evidencePayload(fallbackTitle = 'ChatGPT Conversation'): JsonRecord | null {
    const snapshot = this.snapshot()
    if (
      snapshot.protocolVersion !== 'v1'
      || !snapshot.conversationId
      || snapshot.messages.length === 0
    ) return null
    return {
      conversation_id: snapshot.conversationId,
      title: snapshot.title || fallbackTitle,
      messages: snapshot.messages,
    }
  }

  private ingestBlock(block: string): void {
    const trimmed = block.trim()
    if (!trimmed || trimmed.startsWith(':')) return
    const dataLines = block.split(/\r?\n/u)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart())
    if (dataLines.length === 0) return
    const joined = dataLines.join('\n').trim()
    if (joined === '[DONE]') {
      this.doneSeen = true
      return
    }

    let parsed: unknown
    try { parsed = JSON.parse(joined) }
    catch {
      this.fail(`invalid SSE JSON block (${joined.length} chars)`)
      return
    }
    if (typeof parsed === 'string') {
      if (parsed === 'v1') this.protocolVersion = parsed
      else this.fail(`unsupported SSE protocol marker: ${parsed}`)
      return
    }
    if (!isRecord(parsed)) {
      this.fail('unsupported SSE data shape')
      return
    }

    // 真实生产样本：HTTP 200 建立 SSE 后返回 input_too_large/last_user_message。
    // 注意这里没有臆测固定长度阈值；错误码由服务器经 SSE 原文返回。
    if (typeof parsed.error_code === 'string' && typeof parsed.conversation_id === 'string') {
      this.serverError = {
        conversationId: parsed.conversation_id,
        code: parsed.error_code.slice(0, 128),
        reason: typeof parsed.error_reason === 'string' ? parsed.error_reason.slice(0, 128) : null,
        message: typeof parsed.error === 'string' ? parsed.error.slice(0, 1000) : 'ChatGPT server rejected the turn',
      }
      this.fail(`server SSE error: ${this.serverError.code}`)
      return
    }

    // 有 type 的是控制/元数据事件，不参与 delta root，但可以补 identity/完成证据。
    if (typeof parsed.type === 'string') {
      this.observeIdentity(parsed)
      if (parsed.type === 'message_stream_complete') this.messageStreamComplete = true
      if (parsed.type === 'title_generation' && typeof parsed.title === 'string' && parsed.title.trim()) {
        this.title = parsed.title.trim()
      }
      return
    }

    try {
      if (parsed.o === 'patch') {
        if (!Array.isArray(parsed.v)) throw new Error('SSE patch event has non-array v')
        if (this.currentRoot === null) throw new Error('SSE patch arrived before any root snapshot')
        for (const item of parsed.v) {
          if (!isRecord(item)) throw new Error('SSE patch item is not an object')
          this.currentRoot = applyPointerOperation(this.currentRoot, item)
        }
        this.captureCurrentRoot()
        return
      }
      if (typeof parsed.o === 'string' || typeof parsed.p === 'string') {
        if (this.currentRoot === null && parsed.p !== '') throw new Error('SSE delta arrived before any root snapshot')
        this.currentRoot = applyPointerOperation(this.currentRoot, parsed)
        this.captureCurrentRoot()
        return
      }
      if ('v' in parsed && isRecord(parsed.v)) {
        this.currentRoot = cloneJson(parsed.v)
        this.captureCurrentRoot()
        return
      }
      this.fail(`unrecognized untyped SSE event keys=${Object.keys(parsed).sort().join(',')}`)
    }
    catch (error) {
      this.fail(error instanceof Error ? error.message : String(error))
      // 当前 root 已无法证明仍与服务器 delta 状态一致。保留此前已经 capture 的 message，
      // 但后续 patch 必须等下一份完整 root snapshot 才能重新建立可信基线。
      this.currentRoot = null
    }
  }

  private observeIdentity(value: JsonRecord): void {
    if (typeof value.conversation_id === 'string' && value.conversation_id) this.conversationId = value.conversation_id
    if (typeof value.turn_exchange_id === 'string' && value.turn_exchange_id) this.turnExchangeId = value.turn_exchange_id
  }

  private captureCurrentRoot(): void {
    if (!isRecord(this.currentRoot)) return
    this.observeIdentity(this.currentRoot)
    const message = this.currentRoot.message
    if (!isRecord(message) || typeof message.id !== 'string' || !message.id) return
    const rawMessage = cloneJson(message) as RawChatMessage
    this.messages.set(message.id, rawMessage)
    const metadata = isRecord(message.metadata) ? message.metadata : {}
    if (typeof metadata.turn_exchange_id === 'string' && metadata.turn_exchange_id) this.turnExchangeId = metadata.turn_exchange_id
    if (typeof metadata.request_id === 'string' && metadata.request_id) this.requestId = metadata.request_id
  }

  private fail(message: string): void {
    if (!this.decodeErrors.includes(message)) this.decodeErrors.push(message)
  }
}

