import { browser } from 'wxt/browser'
import { defineContentScript } from 'wxt/utils/define-content-script'
import { injectScript } from 'wxt/utils/inject-script'
import { adaptConversation } from '../src/core/adapter'
import { buildPortableArchive } from '../src/core/archive'
import { downloadText, safeFilename } from '../src/core/download'
import { conversationToMarkdown } from '../src/core/markdown'
import type { PassiveCaptureEnvelope } from '../src/core/types'

interface ExportRequest {
  type: 'chatgpt-passive-exporter/export-current'
}

function isCaptureEnvelope(value: unknown): value is PassiveCaptureEnvelope {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return record.protocol === 'chatgpt-passive-exporter/v1'
    && typeof record.url === 'string'
    && 'payload' in record
}

function currentChatId(): string | null {
  return location.pathname.match(/^\/c\/([^/?#]+)/u)?.[1] ?? null
}

function capturedChatId(envelope: PassiveCaptureEnvelope): string | null {
  try {
    const url = new URL(envelope.url, location.href)
    return url.pathname.match(/^\/backend-api\/conversations?\/([^/?#]+)/u)?.[1] ?? null
  }
  catch {
    return null
  }
}

/**
 * Isolated-world content script：负责注入 MAIN-world hook、保存最近一次捕获，并响应工具栏导出。
 * 不直接访问 ChatGPT 私有 API，也不依赖页面 React/DOM 类名。
 */
export default defineContentScript({
  matches: ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
  runAt: 'document_start',
  async main(ctx) {
    let latest: PassiveCaptureEnvelope | null = null
    const eventName = `chatgpt-passive-exporter:${crypto.randomUUID()}`

    // 按 WXT 官方推荐：isolated content script 注入 unlisted script 到 MAIN world。
    // 监听器在脚本真正执行前挂上，避免首个很快的响应丢失。
    await injectScript('/capture-main.js', {
      keepInDom: true,
      modifyScript(script) {
        script.dataset.passiveExporterEvent = eventName
        ctx.addEventListener(script, eventName, (event) => {
          if (!(event instanceof CustomEvent) || !isCaptureEnvelope(event.detail)) return
          latest = event.detail
        })
      },
    })

    browser.runtime.onMessage.addListener((message: unknown) => {
      const request = message as Partial<ExportRequest>
      if (request.type !== 'chatgpt-passive-exporter/export-current') return undefined

      if (!latest) {
        window.alert('还没有被动捕获到当前会话。请刷新当前 ChatGPT 对话，或切换到另一条聊天再切回来，然后重新点导出。')
        return { ok: false, reason: 'not-captured' }
      }

      // 防止 SPA 切换聊天后，latest 还是上一条聊天的响应。
      const pageChatId = currentChatId()
      const payloadChatId = capturedChatId(latest)
      if (pageChatId && payloadChatId && pageChatId !== payloadChatId) {
        window.alert('当前页已经切换到另一条聊天，但新聊天还没产生可捕获响应。请刷新/重新进入当前聊天后再导出。')
        return { ok: false, reason: 'stale-capture' }
      }

      try {
        const conversation = adaptConversation(latest.payload)
        const base = safeFilename(conversation.title)
        const markdown = conversationToMarkdown(conversation)
        const archive = JSON.stringify(buildPortableArchive(conversation), null, 2)

        downloadText(`${base}.md`, markdown, 'text/markdown;charset=utf-8')
        downloadText(`${base}.archive.json`, archive, 'application/json;charset=utf-8')
        return { ok: true, title: conversation.title, messageCount: conversation.messages.length }
      }
      catch (error) {
        console.error('[ChatGPT Passive Exporter] export failed', error)
        window.alert(`导出失败：${error instanceof Error ? error.message : String(error)}`)
        return { ok: false, reason: 'export-failed' }
      }
    })
  },
})
