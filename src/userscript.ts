import { adaptConversation } from './core/adapter'
import { buildPortableArchive } from './core/archive'
import { downloadText, safeFilename } from './core/download'
import { conversationToMarkdown } from './core/markdown'
import { buildRichManifest } from './core/manifest'
import { installPassiveCapture } from './core/passive-capture'
import type { CanonicalConversation, PassiveCaptureEnvelope } from './core/types'
import { mountSidebarExporter } from './ui/sidebar'

const BUILD_VERSION = '0.1.3'

// 只暴露无敏感信息的调试标记，便于 CDP/用户确认 Tampermonkey 当前实际运行版本。
// 这能避免脚本管理器缓存旧 .user.js 时误把旧代码当成新构建测试。
Object.defineProperty(window, '__chatgptPassiveExporter', {
  configurable: true,
  value: { version: BUILD_VERSION, loadedAt: Date.now() },
})

let latest: PassiveCaptureEnvelope | null = null

/**
 * Userscript 使用 @grant none，因此这一段直接包装宿主页面原生 fetch/XHR。
 * 和扩展版一样：不主动请求，不读取 headers/cookies，只复制页面已收到的 conversation body。
 */
installPassiveCapture((envelope) => {
  latest = envelope
})

function currentChatId(): string | null {
  return location.pathname.match(/^\/c\/([^/?#]+)/u)?.[1] ?? null
}

function capturedChatId(envelope: PassiveCaptureEnvelope): string | null {
  try {
    return new URL(envelope.url, location.href).pathname.match(/^\/backend-api\/conversations?\/([^/?#]+)/u)?.[1] ?? null
  }
  catch {
    return null
  }
}

function currentConversation(): CanonicalConversation | null {
  if (!latest) {
    window.alert('还没有被动捕获到当前会话。请刷新聊天，或切换聊天后再试。')
    return null
  }

  const pageId = currentChatId()
  const captureId = capturedChatId(latest)
  if (pageId && captureId && pageId !== captureId) {
    window.alert('当前聊天尚未捕获；最近一次数据属于另一条聊天。请刷新/重新进入当前聊天。')
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

function exportMarkdown(): void {
  const conversation = currentConversation()
  if (!conversation) return
  const base = safeFilename(conversation.title)
  downloadText(`${base}.md`, conversationToMarkdown(conversation), 'text/markdown;charset=utf-8')
}

function exportArchive(): void {
  const conversation = currentConversation()
  if (!conversation) return
  const base = safeFilename(conversation.title)
  downloadText(
    `${base}.archive.json`,
    JSON.stringify(buildPortableArchive(conversation), null, 2),
    'application/json;charset=utf-8',
  )
}

function exportManifest(): void {
  const conversation = currentConversation()
  if (!conversation) return
  const base = safeFilename(conversation.title)
  downloadText(
    `${base}.manifest.json`,
    JSON.stringify(buildRichManifest(conversation), null, 2),
    'application/json;charset=utf-8',
  )
}

/**
 * 直接挂进 ChatGPT 普通 DOM sidebar；不使用 Shadow DOM。
 * sidebar 本身会被 React 重建，所以 mountSidebarExporter 内部负责自动重挂载。
 */
function mountUi(): void {
  mountSidebarExporter({
    exportMarkdown,
    exportArchive,
    exportManifest,
  })
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mountUi, { once: true })
}
else {
  mountUi()
}
