import type { RawChatMessage, RawConversationPayload } from './types'

/**
 * 从 conversation payload 估算 Apps SDK / DevSpace Widget 的“理论渲染压力”。
 *
 * 这个分析和实时 DOM iframe 数互补：
 * - raw payload 告诉我们“聊天历史里有多少条消息声明了 chatgpt_sdk widget”；
 * - Run Watch 告诉我们“浏览器此刻真的维持了多少 iframe”。
 *
 * 若两者都很高，优先怀疑“设计性累积”；若 raw widget 很少但实时 iframe 数远高，
 * 才更像 remount/重复 iframe 泄漏。
 */
export interface WidgetPressureReport {
  sdkNodeCount: number
  devspaceSdkNodeCount: number
  assistantSdkNodes: number
  toolSdkNodes: number
  turnCount: number
  maxSdkNodesInOneTurn: number
  maxTurnExchangeId?: string
  topAssetPointers: Array<{ value: string, count: number }>
  topResources: Array<{ value: string, count: number }>
  interpretation: 'none' | 'low' | 'high' | 'extreme'
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null
}

function orderedMessages(payload: RawConversationPayload): RawChatMessage[] {
  if (Array.isArray(payload.messages)) return payload.messages

  const mapping = asRecord((payload as Record<string, unknown>).mapping)
  const currentNode = typeof payload.current_node === 'string' ? payload.current_node : undefined
  if (!mapping || !currentNode) return []

  const reversed: RawChatMessage[] = []
  const seen = new Set<string>()
  let nodeId: string | undefined = currentNode
  while (nodeId && !seen.has(nodeId)) {
    seen.add(nodeId)
    const node = asRecord(mapping[nodeId])
    if (!node) break
    const message = asRecord(node.message) as RawChatMessage | null
    if (message) reversed.push(message)
    nodeId = typeof node.parent === 'string' && node.parent ? node.parent : undefined
  }
  return reversed.reverse()
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1)
}

function top(map: Map<string, number>, limit: number): Array<{ value: string, count: number }> {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }))
}

export function analyzeWidgetPressure(payload: RawConversationPayload): WidgetPressureReport {
  const messages = orderedMessages(payload)
  const pointers = new Map<string, number>()
  const resources = new Map<string, number>()
  const perTurn = new Map<string, number>()
  let sdkNodeCount = 0
  let devspaceSdkNodeCount = 0
  let assistantSdkNodes = 0
  let toolSdkNodes = 0

  for (const message of messages) {
    const metadata = asRecord(message.metadata)
    const sdk = asRecord(metadata?.chatgpt_sdk)
    if (!sdk) continue

    sdkNodeCount += 1
    const role = message.author?.role
    if (role === 'assistant') assistantSdkNodes += 1
    if (role === 'tool') toolSdkNodes += 1

    const pointer = typeof sdk.html_asset_pointer === 'string' && sdk.html_asset_pointer
      ? sdk.html_asset_pointer
      : '<none>'
    const resource = typeof sdk.resource_name === 'string' && sdk.resource_name
      ? sdk.resource_name
      : '<none>'
    increment(pointers, pointer)
    increment(resources, resource)

    if (pointer.includes('devspace/workspace-app.html') || resource.startsWith('devspace_')) {
      devspaceSdkNodeCount += 1
    }

    const turnExchangeId = typeof metadata?.turn_exchange_id === 'string' && metadata.turn_exchange_id
      ? metadata.turn_exchange_id
      : '<unknown>'
    increment(perTurn, turnExchangeId)
  }

  const maxTurn = [...perTurn.entries()].sort((a, b) => b[1] - a[1])[0]
  const maxSdkNodesInOneTurn = maxTurn?.[1] ?? 0

  let interpretation: WidgetPressureReport['interpretation'] = 'none'
  if (sdkNodeCount > 0) interpretation = 'low'
  if (sdkNodeCount >= 100 || maxSdkNodesInOneTurn >= 50) interpretation = 'high'
  if (sdkNodeCount >= 500 || maxSdkNodesInOneTurn >= 150) interpretation = 'extreme'

  return {
    sdkNodeCount,
    devspaceSdkNodeCount,
    assistantSdkNodes,
    toolSdkNodes,
    turnCount: perTurn.size,
    maxSdkNodesInOneTurn,
    maxTurnExchangeId: maxTurn?.[0] === '<unknown>' ? undefined : maxTurn?.[0],
    topAssetPointers: top(pointers, 8),
    topResources: top(resources, 12),
    interpretation,
  }
}
