import { browser } from 'wxt/browser'
import { defineContentScript } from 'wxt/utils/define-content-script'
import { injectScript } from 'wxt/utils/inject-script'
import { adaptConversation } from '../src/core/adapter'
import { buildPortableArchive } from '../src/core/archive'
import { downloadText, safeFilename } from '../src/core/download'
import { conversationToMarkdown } from '../src/core/markdown'
import { buildRichManifest } from '../src/core/manifest'
import type { CanonicalConversation, PassiveCaptureEnvelope } from '../src/core/types'
import { mountSidebarExporter } from '../src/ui/sidebar'

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

    const getCurrentConversation = (): CanonicalConversation | null => {
      if (!latest) {
        window.alert('还没有被动捕获到当前会话。请刷新当前 ChatGPT 对话，或切换到另一条聊天再切回来，然后重新点导出。')
        return null
      }

      // 防止 SPA 切换聊天后，latest 还是上一条聊天的响应。
      const pageChatId = currentChatId()
      const payloadChatId = capturedChatId(latest)
      if (pageChatId && payloadChatId && pageChatId !== payloadChatId) {
        window.alert('当前页已经切换到另一条聊天，但新聊天还没产生可捕获响应。请刷新/重新进入当前聊天后再导出。')
        return null
      }

      try {
        return adaptConversation(latest.payload)
      }
      catch (error) {
        console.error('[ChatGPT Passive Exporter] parse failed', error)
        window.alert(`解析失败：${error instanceof Error ? error.message : String(error)}`)
        return null
      }
    }

    const exportMarkdown = () => {
      const conversation = getCurrentConversation()
      if (!conversation) return false
      const base = safeFilename(conversation.title)
      downloadText(`${base}.md`, conversationToMarkdown(conversation), 'text/markdown;charset=utf-8')
      return true
    }

    const exportArchive = () => {
      const conversation = getCurrentConversation()
      if (!conversation) return false
      const base = safeFilename(conversation.title)
      downloadText(
        `${base}.archive.json`,
        JSON.stringify(buildPortableArchive(conversation), null, 2),
        'application/json;charset=utf-8',
      )
      return true
    }

    const exportManifest = () => {
      const conversation = getCurrentConversation()
      if (!conversation) return false
      const base = safeFilename(conversation.title)
      downloadText(
        `${base}.manifest.json`,
        JSON.stringify(buildRichManifest(conversation), null, 2),
        'application/json;charset=utf-8',
      )
      return true
    }

    // 除工具栏 action 外，扩展版也直接嵌入 ChatGPT sidebar；两端共用同一 UI 模块。
    mountSidebarExporter({ exportMarkdown, exportArchive, exportManifest })

    browser.runtime.onMessage.addListener((message: unknown) => {
      const request = message as Partial<ExportRequest>
      if (request.type !== 'chatgpt-passive-exporter/export-current') return undefined

      const conversation = getCurrentConversation()
      if (!conversation) return { ok: false, reason: 'not-captured-or-stale' }

      const base = safeFilename(conversation.title)
      downloadText(`${base}.md`, conversationToMarkdown(conversation), 'text/markdown;charset=utf-8')
      downloadText(
        `${base}.archive.json`,
        JSON.stringify(buildPortableArchive(conversation), null, 2),
        'application/json;charset=utf-8',
      )
      return { ok: true, title: conversation.title, messageCount: conversation.messages.length }
    })
  },
})
