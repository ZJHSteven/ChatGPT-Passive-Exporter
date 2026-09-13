/**
 * `chatgpt-archive-daemon.mjs` 保持为可直接由 Node 执行的 ESM daemon。
 * 测试只导入其纯函数 WSS parser，因此用旁路声明维持严格 TypeScript 检查，
 * 不把整份长期进程脚本强行迁成 TS，也不使用 @ts-ignore。
 */
export interface ArchiveWssEvent {
  conversationId: string
  type: string
  updateType: string | null
}

export interface ArchiveWssEventBehavior {
  dirty: true
  syncReady: boolean
  startsTurn: boolean
  completesTurn: boolean
  asyncProgress: boolean
}

/** 从 ChatGPT conversations topic 的 WSS frame 中抽取最小事件身份。 */
export function extractConversationEvents(payloadData: unknown): ArchiveWssEvent[]

/** 将 WSS event 分类为 dirty / active / sync-ready 行为，不触碰网络。 */
export function classifyConversationEvent(type: unknown, updateType?: unknown): ArchiveWssEventBehavior

/** 判断某种同步 trigger 是否允许把异常尾部升级成 realtime incident。 */
export function shouldClassifyTerminalForTrigger(trigger: unknown): boolean

/** 把 conversation list async_status 分类为 active / complete / unknown。 */
export function classifyCatalogAsyncStatus(value: unknown): 'active' | 'complete' | 'unknown'

