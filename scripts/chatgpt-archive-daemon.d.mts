/**
 * `chatgpt-archive-daemon.mjs` 保持为可直接由 Node 执行的 ESM daemon。
 * 测试只导入其纯函数 WSS parser，因此用旁路声明维持严格 TypeScript 检查，
 * 不把整份长期进程脚本强行迁成 TS，也不使用 @ts-ignore。
 */
export interface ArchiveWssEvent {
  conversationId: string
  type: string
}

/** 从 ChatGPT conversations topic 的 WSS frame 中抽取最小事件身份。 */
export function extractConversationEvents(payloadData: unknown): ArchiveWssEvent[]

