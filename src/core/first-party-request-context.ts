/**
 * ChatGPT 第一方 Web 请求上下文中可以安全继承的部分。
 *
 * 设计原则：
 * 1. 能从第一方真实请求直接取得的稳定账户/客户端 header，不写死值，而是动态继承；
 * 2. turn/session scoped 字段绝不能塞进账户级全局缓存；
 * 3. Conversation List 主动 replay 尽量复用最近一次第一方 global catalog query，
 *    只覆盖分页所必需的 offset / limit。
 *
 * 本模块不依赖 Node API，浏览器 run-watch、Node daemon 和 CLI sync 都可以复用。
 */

export const FIRST_PARTY_REPLAY_HEADER_ALLOWLIST = [
  'authorization',
  'chatgpt-account-id',
  'oai-did',
  'oai-client-build-number',
  'oai-client-version',
  'oai-device-id',
  'oai-language',
  'oai-session-id',
  'originator',
  'x-oai-is-client-observation',
  'x-oai-mcp-form-version',
  'x-openai-codex-window-type',
  'x-openai-web-frontend',
] as const

/**
 * 这些 header 的值不是账户级常量，而是某个 turn / polling session 的关联身份。
 * 只能在同一 session 内显式向下传递，不能从任意页面抓一个旧值后全局复用。
 */
export const FIRST_PARTY_SESSION_SCOPED_PROTOCOL_HEADERS = [
  'x-oai-turn-trace-id',
] as const

export type GlobalCatalogQueryTemplate = Array<[string, string]>

/**
 * 只自动复刻已经确认可重放的 global catalog query。
 * 新出现的未知 key（尤其 nonce/proof/pow/签名/时间戳一类）必须先让 Protocol Drift 报警并人工审计，
 * 不能因为“第一方出现过”就盲目把一次性值缓存后重放。
 */
export const FIRST_PARTY_GLOBAL_CATALOG_QUERY_ALLOWLIST = new Set([
  'order',
  'is_archived',
  'is_starred',
  'expand',
  'hide_snorlax',
])

export function sanitizeFirstPartyReplayHeaders(
  headers: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const allowed = new Set<string>(FIRST_PARTY_REPLAY_HEADER_ALLOWLIST)
  const sanitized: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(headers || {})) {
    const normalized = String(key).toLowerCase()
    if (allowed.has(normalized)) sanitized[normalized] = value
  }
  return sanitized
}

/**
 * 只学习“没有语义过滤”的 global conversation list。
 *
 * hide_snorlax=true、archived/starred=true、TPP include/exclude 都会改变结果集合，
 * 不能拿来当 Archive 全量 catalog 的模板。false 或省略则都表示“不启用该过滤”。
 */
export function captureGlobalCatalogQueryTemplate(
  input: string,
  base = 'https://chatgpt.com',
): GlobalCatalogQueryTemplate | null {
  let url: URL
  try { url = new URL(input, base) }
  catch { return null }
  if (url.pathname !== '/backend-api/conversations') return null
  if (url.searchParams.has('conversation_origin') || url.searchParams.has('exclude_conversation_origin')) return null
  if (url.searchParams.get('hide_snorlax') === 'true') return null
  if (url.searchParams.get('is_archived') === 'true') return null
  if (url.searchParams.get('is_starred') === 'true') return null
  const order = url.searchParams.get('order')
  if (order !== null && order !== 'updated') return null

  return [...url.searchParams.entries()]
    .filter(([key]) => key !== 'offset' && key !== 'limit')
    .filter(([key]) => FIRST_PARTY_GLOBAL_CATALOG_QUERY_ALLOWLIST.has(key))
}

/**
 * 用最近捕获的一方 global query 作为模板，只替换分页参数。
 *
 * 尚未观察到第一方 global list 时，回退到 2026-10-15 已实际观测到的一方形状。
 */
export function buildGlobalCatalogPath(
  offset: number,
  limit: number,
  template: GlobalCatalogQueryTemplate | null = null,
): string {
  const params = new URLSearchParams()
  params.set('offset', String(Math.max(0, Math.trunc(offset))))
  params.set('limit', String(Math.max(1, Math.trunc(limit))))
  const effectiveTemplate: GlobalCatalogQueryTemplate = template ?? [
    ['order', 'updated'],
    ['is_archived', 'false'],
    ['is_starred', 'false'],
  ]
  for (const [key, value] of effectiveTemplate) {
    if (key === 'offset' || key === 'limit') continue
    params.append(key, value)
  }
  return `/backend-api/conversations?${params.toString()}`
}