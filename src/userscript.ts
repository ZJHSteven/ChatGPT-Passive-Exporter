import { adaptConversation } from './core/adapter'
import { buildPortableArchive } from './core/archive'
import { downloadText, safeFilename } from './core/download'
import { conversationToMarkdown } from './core/markdown'
import { buildRichManifest } from './core/manifest'
import { installPassiveCapture } from './core/passive-capture'
import type { CanonicalConversation, PassiveCaptureEnvelope, RawConversationPayload } from './core/types'
import { installRunWatch, type RunWatchSnapshot } from './browser/run-watch'
import { mountSidebarExporter, updateSidebarRunWatchBadge } from './ui/sidebar'

const BUILD_VERSION = '0.2.1'

// 只暴露无敏感信息的调试标记，便于 CDP/用户确认 Tampermonkey 当前实际运行版本。
// 这能避免脚本管理器缓存旧 .user.js 时误把旧代码当成新构建测试。
Object.defineProperty(window, '__chatgptPassiveExporter', {
  configurable: true,
  value: { version: BUILD_VERSION, loadedAt: Date.now() },
})

let latest: PassiveCaptureEnvelope | null = null
let latestWatchSnapshot: RunWatchSnapshot | null = null

function updateWatchBadge(snapshot: RunWatchSnapshot): void {
  latestWatchSnapshot = snapshot
  const iframeCount = snapshot.iframe.oaiSandbox || snapshot.iframe.total
  const text = snapshot.severity === 'ok'
    ? '监控'
    : snapshot.severity === 'warning'
      ? `⚠ ${iframeCount}`
      : snapshot.severity === 'danger'
        ? `⚠ ${iframeCount}`
        : `! ${iframeCount}`

  updateSidebarRunWatchBadge({
    severity: snapshot.severity,
    text,
    title: snapshot.latestDiagnostic?.summary
      ?? `iframe ${snapshot.iframe.total}（OAI sandbox ${snapshot.iframe.oaiSandbox}）`,
  })
}

/**
 * Run Watch 先包一层 fetch，负责“无正文”的生命周期/性能取证；随后 Passive Exporter 再包一层，
 * 负责 conversation body 副本。两层职责严格分开：Run Watch 的持久化日志永远不含认证值或工具正文。
 */
const runWatch = installRunWatch({ onUpdate: updateWatchBadge })

// 只暴露“去敏后的只读诊断接口”，方便 CDP/OpenCLI 在页面卡顿时快速取样。
// 注意：Run Watch 闭包中的临时 Authorization 永远不在这个对象上暴露。
Object.defineProperty(window, '__chatgptRunWatch', {
  configurable: true,
  value: {
    version: BUILD_VERSION,
    snapshot: () => runWatch.snapshot(),
    summary: () => runWatch.summaryText(),
  },
})

/**
 * Userscript 使用 @grant none，因此这一段直接包装宿主页面原生 fetch/XHR。
 * 和扩展版一样：不主动请求，只复制页面已收到的 conversation body。
 * 捕获到正文后顺手做一次“最后一轮离线归因”，用于识别 client_stopped/tool-result-missing。
 */
installPassiveCapture((envelope) => {
  latest = envelope
  runWatch.noteConversationPayload(envelope.payload as RawConversationPayload)
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

function inspectRun(): void {
  window.alert(runWatch.summaryText())
}

async function checkServerStatus(): Promise<void> {
  const result = await runWatch.checkServerStatus()
  const status = result.status ?? 'UNKNOWN'
  const detail = result.ok
    ? `服务器 stream_status：${status}`
    : `无法确认服务器状态：${result.reason ?? `HTTP ${result.httpStatus ?? '?'}`}`
  window.alert(`${detail}\n\n${runWatch.summaryText()}`)
}

function exportRunDiagnostics(): void {
  const snapshot = runWatch.snapshot()
  const title = currentConversation()?.title ?? snapshot.conversationId ?? 'chatgpt'
  downloadText(
    `${safeFilename(title)}.run-watch.json`,
    JSON.stringify(snapshot, null, 2),
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
    inspectRun,
    checkServerStatus,
    exportRunDiagnostics,
  })
  if (latestWatchSnapshot) updateWatchBadge(latestWatchSnapshot)
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mountUi, { once: true })
}
else {
  mountUi()
}
