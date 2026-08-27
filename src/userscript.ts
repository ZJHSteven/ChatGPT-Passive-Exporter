import { adaptConversation } from './core/adapter'
import { buildPortableArchive } from './core/archive'
import { downloadText, safeFilename } from './core/download'
import { conversationToMarkdown } from './core/markdown'
import { installPassiveCapture } from './core/passive-capture'
import type { PassiveCaptureEnvelope } from './core/types'

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

function exportCurrent(): void {
  if (!latest) {
    window.alert('还没有被动捕获到当前会话。请刷新聊天，或切换聊天后再试。')
    return
  }

  const pageId = currentChatId()
  const captureId = capturedChatId(latest)
  if (pageId && captureId && pageId !== captureId) {
    window.alert('当前聊天尚未捕获；最近一次数据属于另一条聊天。请刷新/重新进入当前聊天。')
    return
  }

  try {
    const conversation = adaptConversation(latest.payload)
    const base = safeFilename(conversation.title)
    downloadText(`${base}.md`, conversationToMarkdown(conversation), 'text/markdown;charset=utf-8')
    downloadText(
      `${base}.archive.json`,
      JSON.stringify(buildPortableArchive(conversation), null, 2),
      'application/json;charset=utf-8',
    )
  }
  catch (error) {
    console.error('[ChatGPT Passive Exporter] export failed', error)
    window.alert(`导出失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * 不挂靠 ChatGPT 的任何 React 节点/类名，只往 documentElement 加自己的 Shadow DOM。
 * 因此侧边栏、消息卡片、React 路由即使改版，这个入口也基本不受影响。
 */
function mountButton(): void {
  if (document.querySelector('[data-chatgpt-passive-exporter-host]')) return

  const host = document.createElement('div')
  host.dataset.chatgptPassiveExporterHost = 'true'
  const shadow = host.attachShadow({ mode: 'closed' })
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = '⇩'
  button.title = 'ChatGPT Passive Exporter：导出当前聊天'
  button.setAttribute('aria-label', '导出当前 ChatGPT 聊天')
  button.style.cssText = [
    'position:fixed',
    'right:18px',
    'bottom:18px',
    'z-index:2147483647',
    'width:38px',
    'height:38px',
    'border:1px solid rgba(127,127,127,.35)',
    'border-radius:12px',
    'background:rgba(32,32,32,.88)',
    'color:white',
    'font:700 20px/1 system-ui,sans-serif',
    'box-shadow:0 4px 18px rgba(0,0,0,.18)',
    'cursor:pointer',
  ].join(';')
  button.addEventListener('click', exportCurrent)
  shadow.append(button)
  document.documentElement.append(host)
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mountButton, { once: true })
}
else {
  mountButton()
}
