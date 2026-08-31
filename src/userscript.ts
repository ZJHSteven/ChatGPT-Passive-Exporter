import html2canvas from 'html2canvas'
import { strToU8, zipSync } from 'fflate'
import { adaptConversation } from './core/adapter'
import { buildPortableArchive } from './core/archive'
import { downloadBlob, downloadText, safeFilename } from './core/download'
import { conversationToHtml, conversationToPlainText } from './core/export-formats'
import { conversationToMarkdown } from './core/markdown'
import { buildRichManifest } from './core/manifest'
import { installPassiveCapture } from './core/passive-capture'
import type { CanonicalConversation, PassiveCaptureEnvelope, RawConversationPayload } from './core/types'
import { installRunWatch, type RunWatchSnapshot } from './browser/run-watch'
import { installFleetWatch, type FleetWatchSnapshot } from './browser/fleet-watch'
import { installFleetLeadership, type FleetLeaderRole } from './browser/fleet-leader'
import { notifyFleetAlert, requestDesktopNotificationPermission } from './browser/notifications'
import { loadCompanionSettings, saveCompanionSettings, type CompanionSettings } from './browser/companion-settings'
import { mountSidebarExporter, updateSidebarRunWatchBadge } from './ui/sidebar'

const BUILD_VERSION = '0.3.9'

// 只暴露无敏感信息的调试标记，便于 CDP/用户确认 Tampermonkey 当前实际运行版本。
// 这能避免脚本管理器缓存旧 .user.js 时误把旧代码当成新构建测试。
Object.defineProperty(window, '__chatgptPassiveExporter', {
  configurable: true,
  value: { version: BUILD_VERSION, loadedAt: Date.now() },
})

let latest: PassiveCaptureEnvelope | null = null
let latestWatchSnapshot: RunWatchSnapshot | null = null
let latestFleetSnapshot: FleetWatchSnapshot | null = null
let fleetLeaderRole: FleetLeaderRole = location.pathname === '/' ? 'waiting' : 'unsupported'

function renderCombinedBadge(): void {
  const page = latestWatchSnapshot
  const fleet = latestFleetSnapshot
  if (!page) return

  const abnormalCount = fleet?.tracked.filter(item => item.state === 'abnormal').length ?? 0
  const suspectedCount = fleet?.alerts.filter(item => item.kind === 'suspected-stall').length ?? 0
  const activeCount = fleet?.tracked.filter(item => item.state === 'server-streaming').length ?? 0
  const iframeCount = page.iframe.oaiSandbox || page.iframe.total

  const severity = abnormalCount > 0
    ? 'critical'
    : suspectedCount > 0 && page.severity === 'ok'
      ? 'warning'
      : page.severity

  const text = abnormalCount > 0
    ? `!${abnormalCount}`
    : page.severity !== 'ok'
      ? `${page.severity === 'warning' ? '⚠' : '!'}${iframeCount}`
      : suspectedCount > 0
        ? `?${suspectedCount}`
        : activeCount > 0
          ? `▶${activeCount}`
          : '•'

  const titleParts = [
    `当前页：${page.severity}；iframe ${page.iframe.total}，OAI sandbox ${page.iframe.oaiSandbox}`,
  ]
  if (fleet) {
    titleParts.push(`全局：${activeCount} 条服务端确认进行中，${abnormalCount} 条明确异常，${suspectedCount} 条疑似僵尸`)
    if (fleet.lastError) titleParts.push(`Fleet：${fleet.lastError}`)
  }

  updateSidebarRunWatchBadge({ severity, text, title: titleParts.join('\n') })
}

function updateWatchBadge(snapshot: RunWatchSnapshot): void {
  latestWatchSnapshot = snapshot
  renderCombinedBadge()
}

function updateFleetBadge(snapshot: FleetWatchSnapshot): void {
  latestFleetSnapshot = snapshot
  renderCombinedBadge()
}

/**
 * Run Watch 先包一层 fetch，负责“无正文”的生命周期/性能取证；随后 Passive Exporter 再包一层，
 * 负责 conversation body 副本。两层职责严格分开：Run Watch 的持久化日志永远不含认证值或工具正文。
 */
const runWatch = installRunWatch({ onUpdate: updateWatchBadge })

/**
 * 全局 Fleet Watch 只在“轻量 ChatGPT 首页”启动。
 * 普通 conversation tab 仍保留本页性能取证，但不会各自再发一套全局轮询，避免监控器本身
 * 放大网络/内存成本。用户如果主要从手机启动任务，只需在桌面保留一张首页监控站。
 */
let fleetWatch: ReturnType<typeof installFleetWatch> | null = null
const fleetLeadership = location.pathname === '/'
  ? installFleetLeadership(
      () => {
        fleetWatch = installFleetWatch(runWatch, {
          onUpdate: updateFleetBadge,
          onAlert: (alert) => {
            notifyFleetAlert(alert)
          },
        })
        latestFleetSnapshot = fleetWatch.snapshot()
        renderCombinedBadge()
        return () => {
          fleetWatch?.dispose()
          fleetWatch = null
          latestFleetSnapshot = null
          renderCombinedBadge()
        }
      },
      {
        onRoleChange: (role) => {
          fleetLeaderRole = role
          renderCombinedBadge()
        },
      },
    )
  : null

// 只暴露“去敏后的只读诊断接口”，方便 CDP/OpenCLI 在页面卡顿时快速取样。
// 注意：Run Watch 闭包中的临时 Authorization 永远不在这个对象上暴露。
Object.defineProperty(window, '__chatgptRunWatch', {
  configurable: true,
  value: {
    version: BUILD_VERSION,
    snapshot: () => runWatch.snapshot(),
    summary: () => runWatch.summaryText(),
    fleetSnapshot: () => fleetWatch?.snapshot() ?? null,
    fleetSummary: () => fleetWatch?.summaryText()
      ?? (location.pathname === '/'
        ? `Fleet Watch 当前为 ${fleetLeaderRole}；同一浏览器 profile 只允许一张首页成为主动监控 leader。`
        : 'Fleet Watch 未在此 tab 启动；请保留一张 ChatGPT 首页作为轻量监控站。'),
    fleetLeaderRole: () => fleetLeaderRole,
  },
})

/**
 * Userscript 使用 @grant none，因此这一段直接包装宿主页面原生 fetch/XHR。
 * 和扩展版一样：不主动请求，只复制页面已收到的 conversation body。
 * 捕获到正文后顺手做一次“最后一轮快照诊断”：只区分明确终止证据与当前尾部形态。
 * `tool-call-open` / `reasoning-open` 本身绝不用于判死，实时存活状态由服务器层确认。
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

let companionSettings: CompanionSettings = loadCompanionSettings()

function getSettings(): CompanionSettings {
  return { ...companionSettings }
}

function updateSettings(partial: Partial<CompanionSettings>): void {
  companionSettings = { ...companionSettings, ...partial }
  saveCompanionSettings(companionSettings)
}

function latestPayloadForCurrentChat(): RawConversationPayload | null {
  if (!latest) return null
  const pageId = currentChatId()
  const captureId = capturedChatId(latest)
  if (pageId && captureId && pageId !== captureId) return null
  return latest.payload as RawConversationPayload
}

function adaptPayload(payload: RawConversationPayload): CanonicalConversation | null {
  try {
    return adaptConversation(payload)
  }
  catch (error) {
    console.error('[ChatGPT Companion] parse failed', error)
    window.alert(`解析失败：${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

/**
 * 日常捕获仍然坚持 passive-first；只有用户明确点击“复制/导出”且当前页没有可用被动快照时，
 * 才用已经存在的页面认证上下文主动补取一次当前 conversation。这样 SSR 首屏也能正常导出，
 * 同时不会把每次页面访问都变成额外正文请求。
 */
async function resolveCurrentPayload(): Promise<RawConversationPayload | null> {
  const passive = latestPayloadForCurrentChat()
  if (passive) return passive

  const id = currentChatId()
  if (!id) {
    window.alert('当前页面还没有聊天内容。')
    return null
  }
  const result = await runWatch.fetchConversation(id, 100)
  if (!result.ok || !result.payload) {
    window.alert(`当前聊天尚未捕获，也无法补取正文：${result.reason ?? `HTTP ${result.httpStatus ?? '?'}`}`)
    return null
  }
  return result.payload
}

async function resolveCurrentConversation(): Promise<CanonicalConversation | null> {
  const payload = await resolveCurrentPayload()
  return payload ? adaptPayload(payload) : null
}

async function copyText(): Promise<void> {
  const conversation = await resolveCurrentConversation()
  if (!conversation) return
  const text = conversationToPlainText(conversation, { includeReasoning: companionSettings.includeReasoning })
  try {
    await navigator.clipboard.writeText(text)
  }
  catch {
    window.prompt('复制聊天文字：', text)
  }
}

async function exportMarkdown(): Promise<void> {
  const conversation = await resolveCurrentConversation()
  if (!conversation) return
  const base = safeFilename(conversation.title)
  downloadText(
    `${base}.md`,
    conversationToMarkdown(conversation, {
      includeReasoning: companionSettings.includeReasoning,
      includeRichAppendix: companionSettings.includeRichAppendix,
    }),
    'text/markdown;charset=utf-8',
  )
}

async function exportHtml(): Promise<void> {
  const conversation = await resolveCurrentConversation()
  if (!conversation) return
  const base = safeFilename(conversation.title)
  downloadText(
    `${base}.html`,
    conversationToHtml(conversation, { includeReasoning: companionSettings.includeReasoning }),
    'text/html;charset=utf-8',
  )
}

async function exportArchive(): Promise<void> {
  const conversation = await resolveCurrentConversation()
  if (!conversation) return
  const base = safeFilename(conversation.title)
  downloadText(
    `${base}.archive.json`,
    JSON.stringify(buildPortableArchive(conversation), null, 2),
    'application/json;charset=utf-8',
  )
}

async function exportRawJson(): Promise<void> {
  const payload = await resolveCurrentPayload()
  if (!payload) return
  const conversation = adaptPayload(payload)
  const base = safeFilename(conversation?.title ?? currentChatId() ?? 'ChatGPT Conversation')
  downloadText(`${base}.raw.json`, JSON.stringify(payload, null, 2), 'application/json;charset=utf-8')
}

async function exportManifest(): Promise<void> {
  const conversation = await resolveCurrentConversation()
  if (!conversation) return
  const base = safeFilename(conversation.title)
  downloadText(
    `${base}.manifest.json`,
    JSON.stringify(buildRichManifest(conversation), null, 2),
    'application/json;charset=utf-8',
  )
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('浏览器没有生成 PNG Blob。')), 'image/png')
  })
}

async function screenshot(): Promise<void> {
  const conversation = await resolveCurrentConversation()
  if (!conversation) return

  const thread = document.querySelector<HTMLElement>('#thread div:has(> [data-testid^="conversation-turn-"])')
    ?? document.querySelector<HTMLElement>('#thread')
    ?? document.querySelector<HTMLElement>('main')
  if (!thread || thread.scrollHeight < 50) {
    window.alert('没有找到可截图的聊天区域。')
    return
  }

  const canvas = await html2canvas(thread, {
    scale: companionSettings.screenshotScale,
    useCORS: true,
    scrollX: -window.scrollX,
    scrollY: -window.scrollY,
    windowWidth: Math.max(thread.scrollWidth, window.innerWidth),
    windowHeight: Math.max(thread.scrollHeight, window.innerHeight),
    ignoreElements: element => element.hasAttribute('data-chatgpt-passive-exporter-menu') || Boolean((element as HTMLElement).shadowRoot),
  })
  const blob = await canvasToBlob(canvas)
  downloadBlob(`${safeFilename(conversation.title)}.png`, blob)
}

function uniqueBatchFilename(existing: Set<string>, base: string, extension: string): string {
  const root = safeFilename(base)
  let filename = `${root}.${extension}`
  let index = 2
  while (existing.has(filename)) filename = `${root} (${index++}).${extension}`
  existing.add(filename)
  return filename
}

async function batchExport(format: 'markdown' | 'html' | 'json', limit: number): Promise<void> {
  const conversations = await runWatch.listRecentConversations(limit)
  if (conversations.length === 0) {
    window.alert('暂时无法读取最近会话列表。请确认当前 ChatGPT 页面已登录并正常加载。')
    return
  }

  const files: Record<string, Uint8Array> = {}
  const usedNames = new Set<string>()
  const errors: string[] = []
  let exported = 0

  for (const [index, summary] of conversations.entries()) {
    const result = await runWatch.fetchConversation(summary.id, 100)
    if (!result.ok || !result.payload) {
      errors.push(`${summary.title}: ${result.reason ?? `HTTP ${result.httpStatus ?? '?'}`}`)
      continue
    }
    const conversation = adaptPayload(result.payload)
    if (!conversation) {
      errors.push(`${summary.title}: 解析失败`)
      continue
    }

    let extension: 'md' | 'html' | 'json'
    let content: string
    if (format === 'markdown') {
      extension = 'md'
      content = conversationToMarkdown(conversation, {
        includeReasoning: companionSettings.includeReasoning,
        includeRichAppendix: companionSettings.includeRichAppendix,
      })
    }
    else if (format === 'html') {
      extension = 'html'
      content = conversationToHtml(conversation, { includeReasoning: companionSettings.includeReasoning })
    }
    else {
      extension = 'json'
      content = JSON.stringify(buildPortableArchive(conversation), null, 2)
    }

    files[uniqueBatchFilename(usedNames, conversation.title, extension)] = strToU8(content)
    exported += 1

    // 批量导出是显式主动操作，但仍串行并留一点间隔，避免瞬间把最近 N 条 conversation 并发打满。
    if (index < conversations.length - 1) await new Promise(resolve => window.setTimeout(resolve, 350))
  }

  if (errors.length > 0) files['_errors.txt'] = strToU8(errors.join('\n'))
  if (exported === 0) {
    window.alert(`批量导出失败：\n${errors.join('\n')}`)
    return
  }

  const zipped = zipSync(files, { level: 6 })
  const stamp = new Date().toISOString().slice(0, 10)
  downloadBlob(
    `ChatGPT-${format}-${stamp}-${exported}.zip`,
    new Blob([zipped], { type: 'application/zip' }),
  )
  if (errors.length > 0) window.alert(`已导出 ${exported} 条；另有 ${errors.length} 条失败，详情已写入 ZIP 内的 _errors.txt。`)
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

function inspectFleet(): void {
  window.alert(fleetWatch?.summaryText()
    ?? 'Fleet Watch 只在轻量 ChatGPT 首页启动。请保留一张 https://chatgpt.com/ 首页作为监控站；无需为每条长聊天开标签页。')
}

async function pollFleetNow(): Promise<void> {
  if (!fleetWatch) {
    window.alert('当前不是 Fleet Watch 首页监控站。请在一个 ChatGPT 首页 tab 中执行此操作。')
    return
  }
  await fleetWatch.pollNow()
  window.alert(fleetWatch.summaryText())
}

async function enableNotifications(): Promise<void> {
  const state = await requestDesktopNotificationPermission()
  if (!state.supported) {
    window.alert('当前浏览器不支持 Notification API。')
    return
  }
  window.alert(`异常桌面通知权限：${state.permission}`)
}

function openLatestAbnormal(): void {
  if (!fleetWatch) {
    window.alert('Fleet Watch 未在当前 tab 启动。')
    return
  }
  const alert = fleetWatch.snapshot().alerts.at(-1)
  if (!alert) {
    window.alert('当前没有记录到告警会话。')
    return
  }
  window.open(`https://chatgpt.com/c/${encodeURIComponent(alert.conversationId)}`, '_blank', 'noopener,noreferrer')
}

async function copySafeContinue(): Promise<void> {
  if (!fleetWatch) {
    window.alert('Fleet Watch 未在当前 tab 启动。')
    return
  }
  const alert = [...fleetWatch.snapshot().alerts].reverse().find(item => item.kind === 'abnormal')
  if (!alert) {
    window.alert('当前没有“服务器已确认结束”的异常会话；疑似卡住告警不能生成续跑提示。')
    return
  }

  const text = '继续。上一轮已经确认服务器结束且异常收尾。先检查最后一个工具调用是否已经实际执行成功或产生副作用，再从当前真实状态继续；不要无条件重复上一个写入、删除、安装、上传或 git commit 操作。'
  try {
    await navigator.clipboard.writeText(text)
    window.alert(`已复制安全续跑提示。\n\n异常会话：${alert.title}\n原因：${alert.reason}`)
  }
  catch {
    window.prompt('复制下面这段安全续跑提示：', text)
  }
}

function exportFleetDiagnostics(): void {
  if (!fleetWatch) {
    window.alert('Fleet Watch 未在当前 tab 启动。')
    return
  }
  downloadText(
    'chatgpt-fleet-watch.json',
    JSON.stringify(fleetWatch.snapshot(), null, 2),
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
    inspectFleet,
    pollFleetNow,
    enableNotifications,
    openLatestAbnormal,
    copySafeContinue,
    exportFleetDiagnostics,
  })
  if (latestWatchSnapshot) updateWatchBadge(latestWatchSnapshot)
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mountUi, { once: true })
}
else {
  mountUi()
}
