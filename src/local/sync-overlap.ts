/**
 * ChatGPT 增量同步的“什么时候可以停”判定。
 *
 * 这个文件只处理纯数据，不发网络请求，也不读写 SQLite。这样做有两个好处：
 * 1. 完整性规则可以被单元测试独立验证；
 * 2. 将来 transport 从 CDP helper tab 换成浏览器扩展/daemon/OpenCLI 时，不会复制一套停止逻辑。
 *
 * 核心原则是“宁可多跨一页，也不要在边界上提前停”：
 * - conversation list 必须在最后一个变化之后继续看到稳定 overlap；
 * - conversation body 必须拿到一整页全部已知的 message，才认为已经跨过新增边界。
 */

export interface CatalogConversationLike {
  id: string
  title?: string | null
  updateTime?: string | number | null
}

export interface LocalCatalogConversation {
  id: string
  title: string | null
  updateTime: number | null
}

export type CatalogDifferenceReason = 'new' | 'updated' | 'metadata-changed' | 'server-older-or-ambiguous'

export interface CatalogDifference {
  id: string
  reason: CatalogDifferenceReason
  remoteUpdateTime: number | null
  localUpdateTime: number | null
}

export interface CatalogOverlapState {
  /** 自最后一个 dirty/ambiguous 条目之后，连续出现了多少个完全一致的已知条目。 */
  stableTailItems: number
  /** 累计扫描条目数，仅用于诊断与 CLI 输出。 */
  scannedItems: number
  /** 累计扫描页数，仅用于诊断与 CLI 输出。 */
  scannedPages: number
}

export interface CatalogPageDecision {
  nextState: CatalogOverlapState
  differences: CatalogDifference[]
  stableItemsInPage: number
  shouldStop: boolean
  stopReason: 'stable-overlap' | 'end-of-catalog' | null
}

export interface BodyPageLike {
  /** 当前 body page 中所有有稳定身份的 message ID。 */
  messageIds: string[]
  /** ChatGPT plural body 的 page_info.has_previous_page。 */
  hasPreviousPage: boolean | null
}

export interface BodyPageDecision {
  unknownMessageIds: string[]
  knownMessageCount: number
  shouldStop: boolean
  stopReason: 'full-known-page' | 'end-of-history' | 'empty-page' | null
}

/** 新一次 catalog scan 的初始状态。 */
export function initialCatalogOverlapState(): CatalogOverlapState {
  return { stableTailItems: 0, scannedItems: 0, scannedPages: 0 }
}

/**
 * ChatGPT list 的 update_time 在不同代码路径里可能表现为 number、数字字符串或 ISO 时间。
 * 数据库内部统一按“秒”保存；因此 ISO 时间先从毫秒换成秒。
 */
export function normalizeChatgptTime(value: string | number | null | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string' || value.trim() === '') return null

  const numeric = Number(value)
  if (Number.isFinite(numeric)) return numeric

  const milliseconds = Date.parse(value)
  return Number.isFinite(milliseconds) ? milliseconds / 1000 : null
}

/** 浮点秒可能有极小序列化差异，1ms 以内视为同一服务器时间。 */
function sameServerTime(left: number | null, right: number | null): boolean {
  if (left === null || right === null) return left === right
  return Math.abs(left - right) <= 0.001
}

/**
 * 判断一页 conversation list 是否已经进入“可靠 overlap”。
 *
 * 默认要求 56 个连续稳定条目，约等于当前 ChatGPT sidebar 的两页（28×2）。
 * 这样即使新增 conversation 导致 offset 整体平移，也不会因为偶然撞到几个旧 ID 就过早停止。
 */
export function evaluateCatalogPage(
  remotePage: CatalogConversationLike[],
  localById: ReadonlyMap<string, LocalCatalogConversation>,
  previousState: CatalogOverlapState,
  options: { requiredStableItems?: number, pageSize?: number } = {},
): CatalogPageDecision {
  const requiredStableItems = Math.max(1, Math.trunc(options.requiredStableItems ?? 56))
  const pageSize = Math.max(1, Math.trunc(options.pageSize ?? 28))
  let stableTailItems = previousState.stableTailItems
  let stableItemsInPage = 0
  const differences: CatalogDifference[] = []

  for (const remote of remotePage) {
    const local = localById.get(remote.id)
    const remoteTime = normalizeChatgptTime(remote.updateTime)

    if (!local) {
      differences.push({ id: remote.id, reason: 'new', remoteUpdateTime: remoteTime, localUpdateTime: null })
      stableTailItems = 0
      continue
    }

    const sameTime = sameServerTime(remoteTime, local.updateTime)
    const sameTitle = remote.title == null || remote.title === local.title

    if (sameTime && sameTitle) {
      stableTailItems += 1
      stableItemsInPage += 1
      continue
    }

    // 正常增量是 server update_time 大于本地；标题变化也必须同步，即使时间碰巧没动。
    if (remoteTime !== null && local.updateTime !== null && remoteTime > local.updateTime + 0.001) {
      differences.push({ id: remote.id, reason: 'updated', remoteUpdateTime: remoteTime, localUpdateTime: local.updateTime })
    }
    else if (sameTime && !sameTitle) {
      differences.push({ id: remote.id, reason: 'metadata-changed', remoteUpdateTime: remoteTime, localUpdateTime: local.updateTime })
    }
    else {
      // server 比本地旧、某侧时间为空或时间形状异常时，不覆盖本地，也不能把它算进可靠 overlap。
      differences.push({ id: remote.id, reason: 'server-older-or-ambiguous', remoteUpdateTime: remoteTime, localUpdateTime: local.updateTime })
    }
    stableTailItems = 0
  }

  const nextState: CatalogOverlapState = {
    stableTailItems,
    scannedItems: previousState.scannedItems + remotePage.length,
    scannedPages: previousState.scannedPages + 1,
  }

  // 最后一页不足 pageSize，说明服务端 catalog 已经自然到底；没有必要再造一个空请求。
  const reachedEnd = remotePage.length < pageSize
  const reachedStableOverlap = stableTailItems >= requiredStableItems

  return {
    nextState,
    differences,
    stableItemsInPage,
    shouldStop: reachedEnd || reachedStableOverlap,
    stopReason: reachedEnd ? 'end-of-catalog' : reachedStableOverlap ? 'stable-overlap' : null,
  }
}

/**
 * 判断某一页 conversation body 是否已经跨过增量边界。
 *
 * 最保守的规则：只要本页存在一个本地未知 message，就继续向旧历史翻；只有“整页全部已知”
 * 才停。这样即使新增内容刚好占满第一页，也会再多请求一页确认 overlap，不会漏掉页边界上的节点。
 */
export function evaluateBodyPage(
  page: BodyPageLike,
  knownMessageIds: ReadonlySet<string>,
): BodyPageDecision {
  const uniqueIds = [...new Set(page.messageIds.filter(Boolean))]
  if (uniqueIds.length === 0) {
    return {
      unknownMessageIds: [],
      knownMessageCount: 0,
      shouldStop: true,
      stopReason: 'empty-page',
    }
  }

  const unknownMessageIds = uniqueIds.filter(id => !knownMessageIds.has(id))
  const knownMessageCount = uniqueIds.length - unknownMessageIds.length

  if (unknownMessageIds.length === 0) {
    return {
      unknownMessageIds,
      knownMessageCount,
      shouldStop: true,
      stopReason: 'full-known-page',
    }
  }

  if (page.hasPreviousPage === false) {
    return {
      unknownMessageIds,
      knownMessageCount,
      shouldStop: true,
      stopReason: 'end-of-history',
    }
  }

  return {
    unknownMessageIds,
    knownMessageCount,
    shouldStop: false,
    stopReason: null,
  }
}
