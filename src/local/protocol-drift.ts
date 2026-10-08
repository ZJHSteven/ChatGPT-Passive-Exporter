import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'

export interface ProtocolRequestInput {
  url: string
  method?: string | null
  headers?: Record<string, unknown> | null
  postData?: string | null
  sourceKind?: string | null
  targetId?: string | null
  observedAt?: number
}

export interface ProtocolResponseInput {
  status?: number | null
  contentType?: string | null
  body?: unknown
  observedAt?: number
}

export interface ProtocolRequestShape {
  route: string
  method: string
  query: Record<string, string>
  queryKeys: string[]
  headerNames: string[]
  protocolHeaderNames: string[]
  postBodyKeys: string[]
}

export interface ProtocolResponseShape {
  statusClass: string
  contentType: string | null
  topLevelKeys: string[]
  itemKeys: string[]
  messageKeys: string[]
  messageMetadataKeys: string[]
  pageInfoKeys: string[]
  mappingNodeKeys: string[]
  mappingMessageKeys: string[]
}

export interface ProtocolReplayCandidate {
  eligible: boolean
  family: 'catalog-global' | 'body-latest' | 'body-cursor' | 'mapping' | null
  reason: string
}

interface ProtocolResponseVariantState {
  signature: string
  shape: ProtocolResponseShape
  firstSeenAt: number
  lastSeenAt: number
  count: number
  baseline: boolean
  lastReportedAt: number | null
}

interface ProtocolRequestVariantState {
  signature: string
  shape: ProtocolRequestShape
  firstSeenAt: number
  lastSeenAt: number
  count: number
  baseline: boolean
  lastReportedAt: number | null
  sourceKinds: string[]
  sampleTargetIds: string[]
  candidate: ProtocolReplayCandidate
  approvedForReplay: boolean
  responses: Record<string, ProtocolResponseVariantState>
}

export interface ProtocolDriftState {
  version: 1
  createdAt: number
  baselineUntil: number
  baselineLockedAt: number | null
  updatedAt: number
  variants: Record<string, ProtocolRequestVariantState>
}

export interface ProtocolObserveRequestResult {
  signature: string
  isNew: boolean
  baseline: boolean
  pending: boolean
  candidate: ProtocolReplayCandidate
  assessment: ProtocolDriftAssessment | null
}

export interface ProtocolPendingChange {
  kind: 'request' | 'response'
  requestSignature: string
  responseSignature?: string
  route: string
  method: string
  firstSeenAt: number
  lastSeenAt: number
  count: number
  query: Record<string, string>
  candidate: ProtocolReplayCandidate
}

export type ProtocolDriftSeverity = 'info' | 'warning' | 'critical'

/**
 * 人类真正需要看的不是“又多了一个 16 位 hash”，而是：
 * 1. 这次差异属于内容多态，还是会影响 Archive/Actor 的协议契约；
 * 2. 具体新增/删除了什么字段；
 * 3. 是否值得立刻 Bark。
 *
 * ledger 仍然保留完整 exact shape，方便取证；assessment 只负责把 exact evidence
 * 归约成一个可读、可去重、可分级的语义事件。
 */
export interface ProtocolDriftAssessment {
  severity: ProtocolDriftSeverity
  notify: boolean
  category: 'request-contract' | 'response-contract' | 'optional-shape' | 'observation'
  summary: string
  details: string[]
  impact: string
  dedupeKey: string
  route: string
  method: string
  family: string
  requestSignature: string
  responseSignature?: string
  count: number
}

const UUIDISH = /^[0-9a-f]{8}-[0-9a-f-]{20,}$/iu

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort()
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']'
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return '{' + Object.keys(record).sort().map(key => JSON.stringify(key) + ':' + stableJson(record[key])).join(',') + '}'
  }
  return JSON.stringify(value)
}

function hashShape(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex').slice(0, 16)
}

function difference(left: string[], right: string[]): string[] {
  const rightSet = new Set(right)
  return left.filter(value => !rightSet.has(value))
}

function unionLists(values: string[][]): string[] {
  return sortedUnique(values.flat())
}

function intersectLists(values: string[][]): string[] {
  if (values.length === 0) return []
  let output = [...values[0]!]
  for (const current of values.slice(1)) output = output.filter(value => current.includes(value))
  return sortedUnique(output)
}

/** offset/limit/before 的“值”会随正常分页变化，不应升级成协议漂移。key 本身仍会参与契约比较。 */
function queryValueIsVolatile(key: string): boolean {
  const normalized = key.toLowerCase()
  return normalized === 'offset'
    || normalized === 'limit'
    || normalized === 'before'
    || normalized.includes('cursor')
    || normalized === 'ts'
    || normalized.includes('timestamp')
    || normalized === 'sig'
    || normalized.includes('signature')
    || normalized === 'id'
}

/**
 * 这里的 family 是“兼容性契约家族”，与 replay candidate 不完全相同。
 * 例如带 TPP filter 的 sidebar list 不能直接拿来 replay，但它仍属于 catalog 协议；
 * stream_status 不用于普通归档 replay，却是 Watchdog/Phase 3 的关键协议。
 */
function protocolContractFamily(shape: ProtocolRequestShape): string {
  if (shape.route === '/backend-api/conversations') return 'catalog'
  if (shape.route === '/backend-api/conversations/{conversation_id}') return 'body-latest'
  if (shape.route === '/backend-api/conversations/{conversation_id}/messages') return 'body-cursor'
  if (shape.route === '/backend-api/conversation/{conversation_id}/stream_status') return 'stream-status'
  if (shape.route === '/backend-api/conversation/{conversation_id}' && shape.method === 'GET') return 'mapping'
  if (shape.route === '/backend-api/conversation/{conversation_id}' && shape.method !== 'GET') return 'conversation-action'
  if (shape.route === '/backend-api/conversation/init') return 'conversation-init'
  if (shape.route.startsWith('/backend-api/sentinel/chat-requirements/')) return 'sentinel'
  if (shape.route === '/backend-api/f/conversation' || shape.route === '/backend-api/f/conversation/{id}') return 'turn-submit'
  if (shape.route === '/backend-api/estuary/content') return 'asset'
  if (shape.route === '/backend-api/celsius/ws/user') return 'realtime-bootstrap'
  if (shape.route.includes('/gizmos/')) return 'gizmo'
  return 'other'
}

function familyIsOperationallyImportant(family: string): boolean {
  return [
    'catalog',
    'body-latest',
    'body-cursor',
    'mapping',
    'stream-status',
    'conversation-action',
    'conversation-init',
    'sentinel',
    'turn-submit',
  ].includes(family)
}

function familyLabel(family: string): string {
  const labels: Record<string, string> = {
    catalog: 'Conversation List',
    'body-latest': 'Conversation Body',
    'body-cursor': 'Conversation Body 分页',
    mapping: 'Conversation Mapping',
    'stream-status': 'Stream Status',
    'conversation-action': 'Conversation Action',
    'conversation-init': 'Conversation Init',
    sentinel: 'Sentinel',
    'turn-submit': 'Turn Submit',
    asset: '附件/图片资源',
    'realtime-bootstrap': 'Realtime Bootstrap',
    gizmo: 'Gizmo',
    other: '其它 Backend API',
  }
  return labels[family] || family
}

function assessmentDedupeKey(payload: unknown): string {
  return hashShape(payload)
}

function protocolHeaderName(name: string): boolean {
  const normalized = name.toLowerCase()
  return normalized === 'accept'
    || normalized === 'content-type'
    || normalized === 'authorization'
    || normalized.startsWith('oai-')
    || normalized.startsWith('x-oai-')
    || normalized.startsWith('x-openai-')
}

function requestSignaturePayload(shape: ProtocolRequestShape) {
  return {
    route: shape.route,
    method: shape.method,
    query: shape.query,
    queryKeys: shape.queryKeys,
    protocolHeaderNames: shape.protocolHeaderNames,
    postBodyKeys: shape.postBodyKeys,
  }
}

function normalizePathname(pathname: string): string {
  if (pathname === '/backend-api/conversations/batch') return pathname
  if (pathname === '/backend-api/conversation/init') return pathname
  if (/^\/backend-api\/gizmos\/[^/]+\/conversations$/u.test(pathname)) {
    return '/backend-api/gizmos/{gizmo_id}/conversations'
  }
  if (pathname.startsWith('/backend-api/f/conversation')) {
    return pathname.replace(/\/[0-9a-f-]{20,}$/iu, '/{id}')
  }
  if (pathname === '/backend-api/estuary/content') return pathname
  if (/^\/backend-api\/conversations\/[^/]+\/messages$/u.test(pathname)) {
    return '/backend-api/conversations/{conversation_id}/messages'
  }
  if (/^\/backend-api\/conversations\/[^/]+$/u.test(pathname)) {
    return '/backend-api/conversations/{conversation_id}'
  }
  if (/^\/backend-api\/conversation\/[^/]+\/stream_status$/u.test(pathname)) {
    return '/backend-api/conversation/{conversation_id}/stream_status'
  }
  if (/^\/backend-api\/conversation\/[^/]+$/u.test(pathname)) {
    return '/backend-api/conversation/{conversation_id}'
  }
  return pathname
}

export function isArchiveProtocolRoute(route: string): boolean {
  return route === '/backend-api/conversations'
    || route === '/backend-api/conversations/batch'
    || route === '/backend-api/conversations/{conversation_id}'
    || route === '/backend-api/conversations/{conversation_id}/messages'
    || route === '/backend-api/conversation/init'
    || route === '/backend-api/conversation/{conversation_id}'
    || route === '/backend-api/conversation/{conversation_id}/stream_status'
    || route === '/backend-api/f/conversation'
    || route === '/backend-api/f/conversation/{id}'
    || route === '/backend-api/estuary/content'
    || route === '/backend-api/gizmos/snorlax/sidebar'
    || route === '/backend-api/gizmos/{gizmo_id}/conversations'
    || route === '/backend-api/celsius/ws/user'
    || route.startsWith('/backend-api/sentinel/chat-requirements/')
}

function normalizeQueryValue(key: string, value: string): string {
  const normalizedKey = key.toLowerCase()
  if (normalizedKey === 'before' || normalizedKey.includes('cursor')) return '<cursor>'
  if (normalizedKey === 'sig' || normalizedKey.includes('signature')) return '<signature>'
  if (normalizedKey === 'ts' || normalizedKey.includes('timestamp')) return '<timestamp>'
  if (normalizedKey === 'id' && /^file_/u.test(value)) return '<file_id>'
  if (normalizedKey.includes('token')) return '<token>'
  if (UUIDISH.test(value)) return '<id>'
  if (value.length > 120) return '<opaque>'
  return value
}

function collectJsonKeyPaths(value: unknown, prefix = '', depth = 0, output: string[] = []): string[] {
  if (depth > 2 || !value || typeof value !== 'object' || Array.isArray(value)) return output
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const path = prefix ? prefix + '.' + key : key
    output.push(path)
    collectJsonKeyPaths((value as Record<string, unknown>)[key], path, depth + 1, output)
  }
  return output
}

export function buildProtocolRequestShape(input: ProtocolRequestInput): ProtocolRequestShape | null {
  let url: URL
  try { url = new URL(input.url, 'https://chatgpt.com') }
  catch { return null }
  if (!url.pathname.startsWith('/backend-api/')) return null

  const query: Record<string, string> = {}
  const entries = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b))
  for (const [key, value] of entries) query[key] = normalizeQueryValue(key, value)

  const headerNames = sortedUnique(Object.keys(input.headers || {}).map(key => key.toLowerCase()))
  const protocolHeaderNames = headerNames.filter(protocolHeaderName)
  let postBodyKeys: string[] = []
  if (typeof input.postData === 'string' && input.postData.trim()) {
    try { postBodyKeys = sortedUnique(collectJsonKeyPaths(JSON.parse(input.postData))) }
    catch { postBodyKeys = ['<non-json-body>'] }
  }

  return {
    route: normalizePathname(url.pathname),
    method: String(input.method || 'GET').toUpperCase(),
    query,
    queryKeys: Object.keys(query).sort(),
    headerNames,
    protocolHeaderNames,
    postBodyKeys,
  }
}

function unionObjectKeys(values: unknown[]): string[] {
  return sortedUnique(values.flatMap(value => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value as Record<string, unknown>)
    : []))
}

export function buildProtocolResponseShape(input: ProtocolResponseInput): ProtocolResponseShape {
  const body = input.body
  const record = body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : null
  const items = Array.isArray(record?.items) ? record?.items as unknown[] : []
  const messages = Array.isArray(record?.messages) ? record?.messages as unknown[] : []
  const metadata = messages
    .map(message => message && typeof message === 'object' ? (message as Record<string, unknown>).metadata : null)
    .filter(Boolean)
  const pageInfo = record?.page_info && typeof record.page_info === 'object' && !Array.isArray(record.page_info)
    ? record.page_info as Record<string, unknown>
    : null
  const mapping = record?.mapping && typeof record.mapping === 'object' && !Array.isArray(record.mapping)
    ? record.mapping as Record<string, unknown>
    : null
  const mappingNodes = mapping ? Object.values(mapping) : []
  const mappingMessages = mappingNodes
    .map(node => node && typeof node === 'object' ? (node as Record<string, unknown>).message : null)
    .filter(Boolean)
  const status = Number(input.status)
  const statusClass = Number.isFinite(status) && status > 0
    ? String(Math.trunc(status / 100)) + 'xx'
    : 'unknown'
  const contentType = typeof input.contentType === 'string' && input.contentType
    ? input.contentType.split(';')[0]?.trim().toLowerCase() || null
    : null

  return {
    statusClass,
    contentType,
    topLevelKeys: record ? Object.keys(record).sort() : [],
    itemKeys: unionObjectKeys(items),
    messageKeys: unionObjectKeys(messages),
    messageMetadataKeys: unionObjectKeys(metadata),
    pageInfoKeys: pageInfo ? Object.keys(pageInfo).sort() : [],
    mappingNodeKeys: unionObjectKeys(mappingNodes),
    mappingMessageKeys: unionObjectKeys(mappingMessages),
  }
}

export function classifyProtocolReplayCandidate(
  request: ProtocolRequestShape,
  response?: ProtocolResponseShape | null,
): ProtocolReplayCandidate {
  if (request.method !== 'GET') {
    return { eligible: false, family: null, reason: 'only read-only GET templates are eligible' }
  }
  const hasResponseKeys = (...keys: string[]) => response
    ? keys.every(key => response.topLevelKeys.includes(key))
    : true

  if (request.route === '/backend-api/conversations') {
    const originFiltered = 'conversation_origin' in request.query || 'exclude_conversation_origin' in request.query
    const snorlaxFiltered = request.query.hide_snorlax === 'true'
    const archived = request.query.is_archived === 'true'
    const starred = request.query.is_starred === 'true'
    if (!originFiltered && !snorlaxFiltered && !archived && !starred && hasResponseKeys('items', 'total', 'limit', 'offset')) {
      return { eligible: true, family: 'catalog-global', reason: 'unfiltered catalog shape with list schema' }
    }
    return { eligible: false, family: null, reason: 'catalog request has semantic filters' }
  }

  if (request.route === '/backend-api/conversations/{conversation_id}'
    && hasResponseKeys('messages', 'page_info')) {
    return { eligible: true, family: 'body-latest', reason: 'latest plural body shape' }
  }
  if (request.route === '/backend-api/conversations/{conversation_id}/messages'
    && 'before' in request.query
    && hasResponseKeys('messages', 'page_info')) {
    return { eligible: true, family: 'body-cursor', reason: 'cursor body shape' }
  }
  if (request.route === '/backend-api/conversation/{conversation_id}'
    && hasResponseKeys('mapping')) {
    return { eligible: true, family: 'mapping', reason: 'singular mapping shape' }
  }
  return { eligible: false, family: null, reason: 'route is observation-only' }
}

function newState(now: number, baselineWindowMs: number): ProtocolDriftState {
  return {
    version: 1,
    createdAt: now,
    baselineUntil: now + baselineWindowMs,
    baselineLockedAt: null,
    updatedAt: now,
    variants: {},
  }
}

export class ProtocolDriftLedger {
  readonly filePath: string
  readonly baselineWindowMs: number
  state: ProtocolDriftState

  private constructor(filePath: string, state: ProtocolDriftState, baselineWindowMs: number) {
    this.filePath = filePath
    this.state = state
    this.baselineWindowMs = baselineWindowMs
  }

  static async open(filePath: string, options: { baselineWindowMs?: number, now?: number } = {}): Promise<ProtocolDriftLedger> {
    const now = options.now ?? Date.now()
    const baselineWindowMs = Math.max(60_000, options.baselineWindowMs ?? 24 * 3600_000)
    let state: ProtocolDriftState
    try {
      state = JSON.parse(await fs.readFile(filePath, 'utf8')) as ProtocolDriftState
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      state = newState(now, baselineWindowMs)
    }
    const ledger = new ProtocolDriftLedger(filePath, state, baselineWindowMs)
    ledger.refreshBaselineLock(now)
    return ledger
  }

  refreshBaselineLock(now = Date.now()): boolean {
   if (this.state.baselineLockedAt === null && now >= this.state.baselineUntil) {
     this.state.baselineLockedAt = now
     this.state.updatedAt = now
      return true
   }
    return false
 }

  observeRequest(input: ProtocolRequestInput): ProtocolObserveRequestResult | null {
    const shape = buildProtocolRequestShape(input)
    if (!shape) return null
    if (!isArchiveProtocolRoute(shape.route)) return null
    const now = input.observedAt ?? Date.now()
    this.refreshBaselineLock(now)
    const signature = hashShape(requestSignaturePayload(shape))
    let variant = this.state.variants[signature]
    const isNew = !variant
    const baseline = this.state.baselineLockedAt === null
    if (!variant) {
      variant = {
        signature,
        shape,
        firstSeenAt: now,
        lastSeenAt: now,
        count: 0,
        baseline,
        lastReportedAt: null,
        sourceKinds: [],
        sampleTargetIds: [],
        candidate: classifyProtocolReplayCandidate(shape),
        approvedForReplay: false,
        responses: {},
      }
      this.state.variants[signature] = variant
    }
    variant.lastSeenAt = now
    variant.count += 1
    if (input.sourceKind) variant.sourceKinds = sortedUnique([...variant.sourceKinds, input.sourceKind])
    if (input.targetId && variant.sampleTargetIds.length < 8) {
      variant.sampleTargetIds = sortedUnique([...variant.sampleTargetIds, input.targetId]).slice(0, 8)
    }
    this.state.updatedAt = now
    const assessment = variant.baseline ? null : this.assessRequestVariant(signature)
    return {
      signature,
      isNew,
      baseline: variant.baseline,
      pending: isNew && !variant.baseline,
      candidate: variant.candidate,
      assessment,
    }
  }

  observeResponse(requestSignature: string, input: ProtocolResponseInput): {
    signature: string
    isNew: boolean
    pending: boolean
    assessment: ProtocolDriftAssessment | null
  } | null {
    const request = this.state.variants[requestSignature]
    if (!request) return null
    const now = input.observedAt ?? Date.now()
    this.refreshBaselineLock(now)
    const shape = buildProtocolResponseShape(input)
    const signature = hashShape(shape)
    let response = request.responses[signature]
    const isNew = !response
    const baseline = this.state.baselineLockedAt === null
    if (!response) {
      response = {
        signature,
        shape,
        firstSeenAt: now,
        lastSeenAt: now,
        count: 0,
        baseline,
        lastReportedAt: null,
      }
      request.responses[signature] = response
    }
    response.lastSeenAt = now
    response.count += 1
    request.candidate = classifyProtocolReplayCandidate(request.shape, shape)
    this.state.updatedAt = now
    const assessment = response.baseline ? null : this.assessResponseVariant(requestSignature, signature)
    return { signature, isNew, pending: isNew && !response.baseline, assessment }
  }

  /**
   * 选“安装 monitor 时学到的 baseline”作为兼容性参照，而不是拿任意最近 variant 互相比。
   * 这样一次真正的 header/query 漂移不会因为后来又出现了 20/40/60 三个 offset 变体而被自我洗白。
   */
  private baselineRequestsFor(shape: ProtocolRequestShape): ProtocolRequestVariantState[] {
    const family = protocolContractFamily(shape)
    return Object.values(this.state.variants).filter(variant => (
      variant.baseline
      && variant.shape.method === shape.method
      && protocolContractFamily(variant.shape) === family
    ))
  }

  private baselineResponsesFor(request: ProtocolRequestVariantState): ProtocolResponseVariantState[] {
    const family = protocolContractFamily(request.shape)
    return Object.values(this.state.variants)
      .filter(variant => variant.baseline
        && variant.shape.method === request.shape.method
        && protocolContractFamily(variant.shape) === family)
      .flatMap(variant => Object.values(variant.responses).filter(response => response.baseline))
  }

  /**
   * 请求层只把“baseline 从未出现过的新协议字段 / baseline 一直都有但现在缺失的稳定字段”
   * 当作兼容性候选。正常分页的 offset/limit 值变化、同一 route 的一次性稀疏 header 变体
   * 仍保留在 forensic ledger，但不会第一眼就 Bark。
   */
  assessRequestVariant(signature: string): ProtocolDriftAssessment | null {
    const variant = this.state.variants[signature]
    if (!variant || variant.baseline) return null
    const shape = variant.shape
    const family = protocolContractFamily(shape)
    const label = familyLabel(family)
    const important = familyIsOperationallyImportant(family)
    const refs = this.baselineRequestsFor(shape)
    const details: string[] = []

    if (refs.length === 0) {
      details.push('baseline 中没有同家族请求')
      const repeated = variant.count >= 2
      const severity: ProtocolDriftSeverity = important && repeated ? 'warning' : 'info'
      return {
        severity,
        notify: severity !== 'info',
        category: important ? 'request-contract' : 'observation',
        summary: `${label} 出现新的请求家族`,
        details,
        impact: important
          ? (repeated ? '该请求已重复出现，可能代表第一方协议新增/迁移；需要核对生产 replay。' : '目前只见 1 次，先作为候选证据，重复后再通知。')
          : '该 route 不参与 Archive/Actor 的关键 replay，仅保留取证。',
        dedupeKey: assessmentDedupeKey({ kind: 'request-new-family', family, method: shape.method, route: shape.route }),
        route: shape.route,
        method: shape.method,
        family,
        requestSignature: signature,
        count: variant.count,
      }
    }

    const knownHeaders = unionLists(refs.map(ref => ref.shape.protocolHeaderNames))
    const stableHeaders = intersectLists(refs.map(ref => ref.shape.protocolHeaderNames))
    const addedHeaders = difference(shape.protocolHeaderNames, knownHeaders)
    const missingStableHeaders = difference(stableHeaders, shape.protocolHeaderNames)
    if (addedHeaders.length > 0) details.push(`新增协议 header: ${addedHeaders.join(', ')}`)
    if (missingStableHeaders.length > 0) details.push(`缺少 baseline 稳定 header: ${missingStableHeaders.join(', ')}`)

    const knownQueryKeys = unionLists(refs.map(ref => ref.shape.queryKeys))
    const stableQueryKeys = intersectLists(refs.map(ref => ref.shape.queryKeys))
    const addedQueryKeys = difference(shape.queryKeys, knownQueryKeys)
    const missingStableQueryKeys = difference(stableQueryKeys, shape.queryKeys)
    if (addedQueryKeys.length > 0) details.push(`新增 query key: ${addedQueryKeys.join(', ')}`)
    if (missingStableQueryKeys.length > 0) details.push(`缺少 baseline 稳定 query key: ${missingStableQueryKeys.join(', ')}`)

    const changedQueryValues = shape.queryKeys.filter(key => {
      if (queryValueIsVolatile(key)) return false
      const value = shape.query[key]
      return refs.some(ref => key in ref.shape.query)
        && !refs.some(ref => ref.shape.query[key] === value)
    })
    if (changedQueryValues.length > 0) {
      details.push(`query 语义值变化: ${changedQueryValues.map(key => `${key}=${shape.query[key]}`).join(', ')}`)
    }

    const knownPostKeys = unionLists(refs.map(ref => ref.shape.postBodyKeys))
    const stablePostKeys = intersectLists(refs.map(ref => ref.shape.postBodyKeys))
    const addedPostKeys = difference(shape.postBodyKeys, knownPostKeys)
    const missingStablePostKeys = difference(stablePostKeys, shape.postBodyKeys)
    if (addedPostKeys.length > 0) details.push(`新增 POST 字段: ${addedPostKeys.join(', ')}`)
    if (missingStablePostKeys.length > 0) details.push(`缺少 baseline 稳定 POST 字段: ${missingStablePostKeys.join(', ')}`)

    const hasContractDifference = addedHeaders.length > 0
      || missingStableHeaders.length > 0
      || addedQueryKeys.length > 0
      || missingStableQueryKeys.length > 0
      || changedQueryValues.length > 0
      || addedPostKeys.length > 0
      || missingStablePostKeys.length > 0

    if (!hasContractDifference) {
      return {
        severity: 'info',
        notify: false,
        category: 'optional-shape',
        summary: `${label} 仅出现正常参数/传输变体`,
        details: ['route/method/query 契约与 baseline 一致；差异仅来自分页值或非协议 header'],
        impact: '不影响 Archive/Actor 兼容性，不发送 Bark。',
        dedupeKey: assessmentDedupeKey({ kind: 'request-noise', family }),
        route: shape.route,
        method: shape.method,
        family,
        requestSignature: signature,
        count: variant.count,
      }
    }

    // 单次稀疏请求很容易来自某个特殊页面状态；至少重复两次再把 request contract 升成 warning。
    const repeated = variant.count >= 2
    const severity: ProtocolDriftSeverity = important && repeated ? 'warning' : 'info'
    return {
      severity,
      notify: severity !== 'info',
      category: 'request-contract',
      summary: `${label} 请求契约发生变化`,
      details,
      impact: important
        ? (repeated
          ? '第一方已重复使用该新契约；生产 replay/header/query 模板需要复核。'
          : '目前只见 1 次，先记录证据；重复出现后再 Bark，避免 A/B/偶发页面状态误报。')
        : '该 route 不属于关键 replay，暂不通知。',
      dedupeKey: assessmentDedupeKey({
        kind: 'request-contract',
        family,
        addedHeaders,
        missingStableHeaders,
        addedQueryKeys,
        missingStableQueryKeys,
        changedQueryValues: changedQueryValues.map(key => [key, shape.query[key]]),
        addedPostKeys,
        missingStablePostKeys,
      }),
      route: shape.route,
      method: shape.method,
      family,
      requestSignature: signature,
      count: variant.count,
    }
  }

  /**
   * Response 不再把 message.metadata 的“字段并集”当协议契约。
   * 真正会让 Archive 读不懂数据的，是 messages/page_info/mapping/items 等核心 transport 字段消失，
   * 或 JSON/status 契约改变；attachments/writing_blocks/dictation 等内容型 metadata 只记 info。
   */
  assessResponseVariant(requestSignature: string, responseSignature: string): ProtocolDriftAssessment | null {
    const request = this.state.variants[requestSignature]
    const response = request?.responses[responseSignature]
    if (!request || !response || response.baseline) return null
    const family = protocolContractFamily(request.shape)
    const label = familyLabel(family)
    const important = familyIsOperationallyImportant(family)
    const refs = this.baselineResponsesFor(request)
    const shape = response.shape
    const details: string[] = []

    if (refs.length === 0) {
      return {
        severity: 'info',
        notify: false,
        category: 'observation',
        summary: `${label} 首次记录新的 response 家族`,
        details: ['没有 baseline response 可做可靠 schema diff'],
        impact: '先保留证据；request 层若属于关键新协议会单独分级。',
        dedupeKey: assessmentDedupeKey({ kind: 'response-no-baseline', family }),
        route: request.shape.route,
        method: request.shape.method,
        family,
        requestSignature,
        responseSignature,
        count: response.count,
      }
    }

    const baselineStatus = unionLists(refs.map(ref => [ref.shape.statusClass]))
    const baselineContentTypes = sortedUnique(refs
      .map(ref => ref.shape.contentType)
      .filter((value): value is string => Boolean(value)))
    const statusChanged = !baselineStatus.includes(shape.statusClass)
    const contentTypeChanged = shape.contentType !== null
      && baselineContentTypes.length > 0
      && !baselineContentTypes.includes(shape.contentType)
    if (statusChanged) details.push(`状态类别变为 ${shape.statusClass}（baseline: ${baselineStatus.join('/') || 'unknown'}）`)
    if (contentTypeChanged) details.push(`Content-Type 变为 ${shape.contentType}（baseline: ${baselineContentTypes.join('/') || 'unknown'}）`)

    const requiredTop: Record<string, string[]> = {
      catalog: ['items'],
      'body-latest': ['messages', 'page_info'],
      'body-cursor': ['messages', 'page_info'],
      mapping: ['mapping'],
      'stream-status': ['status'],
    }
    const operationalTop: Record<string, string[]> = {
      catalog: ['items', 'total', 'limit', 'offset'],
      'body-latest': ['messages', 'page_info'],
      'body-cursor': ['messages', 'page_info'],
      mapping: ['mapping'],
      'stream-status': ['status'],
    }
    const requiredMessage = ['id', 'author', 'content', 'metadata']
    const operationalPageInfo = ['has_next_page', 'has_previous_page', 'start_cursor', 'end_cursor']

    const missingRequiredTop = (requiredTop[family] || []).filter(key => !shape.topLevelKeys.includes(key))
    const missingOperationalTop = (operationalTop[family] || [])
      .filter(key => !shape.topLevelKeys.includes(key) && !missingRequiredTop.includes(key))
    const missingMessage = ['body-latest', 'body-cursor'].includes(family)
      ? requiredMessage.filter(key => !shape.messageKeys.includes(key))
      : []
    const missingPageInfo = ['body-latest', 'body-cursor'].includes(family) && shape.topLevelKeys.includes('page_info')
      ? operationalPageInfo.filter(key => !shape.pageInfoKeys.includes(key))
      : []

    if (missingRequiredTop.length > 0) details.push(`缺少核心 response 字段: ${missingRequiredTop.join(', ')}`)
    if (missingOperationalTop.length > 0) details.push(`缺少常用 response 字段: ${missingOperationalTop.join(', ')}`)
    if (missingMessage.length > 0) details.push(`messages 缺少核心字段: ${missingMessage.join(', ')}`)
    if (missingPageInfo.length > 0) details.push(`page_info 缺少字段: ${missingPageInfo.join(', ')}`)

    const critical = important && (missingRequiredTop.length > 0 || missingMessage.length > 0)
    const warning = important && !critical && (
      statusChanged
      || contentTypeChanged
      || missingOperationalTop.length > 0
      || missingPageInfo.length > 0
    ) && response.count >= 2

    if (critical || warning) {
      const severity: ProtocolDriftSeverity = critical ? 'critical' : 'warning'
      return {
        severity,
        notify: true,
        category: 'response-contract',
        summary: `${label} 响应契约${critical ? '出现破坏性变化' : '发生变化'}`,
        details,
        impact: critical
          ? 'Archive/Actor 依赖的核心 transport 字段缺失，可能直接导致同步/诊断失败。'
          : '第一方 response 的稳定读取契约发生变化，需要复核解析器。',
        dedupeKey: assessmentDedupeKey({
          kind: 'response-contract', family, statusChanged, contentTypeChanged,
          missingRequiredTop, missingOperationalTop, missingMessage, missingPageInfo,
        }),
        route: request.shape.route,
        method: request.shape.method,
        family,
        requestSignature,
        responseSignature,
        count: response.count,
      }
    }

    const knownTop = unionLists(refs.map(ref => ref.shape.topLevelKeys))
    const addedTop = difference(shape.topLevelKeys, knownTop)
    const knownMetadata = unionLists(refs.map(ref => ref.shape.messageMetadataKeys))
    const addedMetadata = difference(shape.messageMetadataKeys, knownMetadata)
    const optionalDetails: string[] = []
    if (addedTop.length > 0) optionalDetails.push(`新增可选 top-level 字段: ${addedTop.join(', ')}`)
    if (addedMetadata.length > 0) optionalDetails.push(`新增 message metadata: ${addedMetadata.join(', ')}`)
    if (optionalDetails.length === 0) optionalDetails.push('核心 transport schema 与 baseline 一致；差异来自可选内容字段组合')
    return {
      severity: 'info',
      notify: false,
      category: 'optional-shape',
      summary: `${label} 仅出现内容/可选字段多态`,
      details: optionalDetails,
      impact: '不影响解析器核心契约，不发送 Bark。',
      dedupeKey: assessmentDedupeKey({ kind: 'response-optional', family }),
      route: request.shape.route,
      method: request.shape.method,
      family,
      requestSignature,
      responseSignature,
      count: response.count,
    }
  }

  assessChange(change: ProtocolPendingChange): ProtocolDriftAssessment | null {
    return change.kind === 'request'
      ? this.assessRequestVariant(change.requestSignature)
      : change.responseSignature
        ? this.assessResponseVariant(change.requestSignature, change.responseSignature)
        : null
  }

  assessedPendingChanges(options: { unreportedOnly?: boolean, notifyOnly?: boolean } = {}): Array<{
    change: ProtocolPendingChange
    assessment: ProtocolDriftAssessment
  }> {
    const notifyOnly = options.notifyOnly ?? false
    return this.pendingChanges({ unreportedOnly: options.unreportedOnly })
      .map(change => ({ change, assessment: this.assessChange(change) }))
      .filter((item): item is { change: ProtocolPendingChange, assessment: ProtocolDriftAssessment } => (
        Boolean(item.assessment) && (!notifyOnly || item.assessment!.notify)
      ))
  }

  pendingChanges(options: { unreportedOnly?: boolean } = {}): ProtocolPendingChange[] {
    const unreportedOnly = options.unreportedOnly ?? true
    const output: ProtocolPendingChange[] = []
    for (const variant of Object.values(this.state.variants)) {
      if (!variant.baseline && (!unreportedOnly || variant.lastReportedAt === null)) {
        output.push({
          kind: 'request',
          requestSignature: variant.signature,
          route: variant.shape.route,
          method: variant.shape.method,
          firstSeenAt: variant.firstSeenAt,
          lastSeenAt: variant.lastSeenAt,
          count: variant.count,
          query: variant.shape.query,
          candidate: variant.candidate,
        })
      }
      for (const response of Object.values(variant.responses)) {
        if (!response.baseline && (!unreportedOnly || response.lastReportedAt === null)) {
          output.push({
            kind: 'response',
            requestSignature: variant.signature,
            responseSignature: response.signature,
            route: variant.shape.route,
            method: variant.shape.method,
            firstSeenAt: response.firstSeenAt,
            lastSeenAt: response.lastSeenAt,
            count: response.count,
            query: variant.shape.query,
            candidate: variant.candidate,
          })
        }
      }
    }
    return output.sort((a, b) => a.firstSeenAt - b.firstSeenAt)
  }

  markReported(changes: ProtocolPendingChange[], now = Date.now()): void {
    for (const change of changes) {
      const request = this.state.variants[change.requestSignature]
      if (!request) continue
      if (change.kind === 'request') request.lastReportedAt = now
      else if (change.responseSignature) {
        const response = request.responses[change.responseSignature]
        if (response) response.lastReportedAt = now
      }
    }
    this.state.updatedAt = now
  }

  approveForReplay(signature: string, approved = true): boolean {
    const variant = this.state.variants[signature]
    if (!variant || !variant.candidate.eligible) return false
    variant.approvedForReplay = approved
    this.state.updatedAt = Date.now()
    return true
  }

  summary(now = Date.now()) {
    this.refreshBaselineLock(now)
    const variants = Object.values(this.state.variants)
    const responseVariants = variants.reduce((sum, variant) => sum + Object.keys(variant.responses).length, 0)
    return {
      filePath: this.filePath,
      baselineMode: this.state.baselineLockedAt === null ? 'learning' : 'locked',
      baselineUntil: this.state.baselineUntil,
      baselineLockedAt: this.state.baselineLockedAt,
      requestVariants: variants.length,
      responseVariants,
      pendingUnreported: this.pendingChanges({ unreportedOnly: true }).length,
      approvedReplayTemplates: variants.filter(variant => variant.approvedForReplay).length,
      replayCandidates: variants.filter(variant => variant.candidate.eligible).length,
    }
  }

  async flush(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const temporary = this.filePath + '.tmp-' + process.pid
    await fs.writeFile(temporary, JSON.stringify(this.state, null, 2))
    await fs.rename(temporary, this.filePath)
  }
}
