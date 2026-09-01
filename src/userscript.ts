import html2canvas from 'html2canvas'
import { strToU8, zipSync } from 'fflate'
import { adaptConversation } from './core/adapter'
import { buildPortableArchive } from './core/archive'
import { downloadBlob, downloadText, safeFilename } from './core/download'
import { conversationToHtml, conversationToPlainText } from './core/export-formats'
import { conversationToMarkdown } from './core/markdown'
import { buildRichManifest } from './core/manifest'
import { assessPassiveEnvelope, preferPassiveSnapshot } from './core/conversation-snapshot'
import { installPassiveCapture } from './core/passive-capture'
import type { CanonicalConversation, PassiveCaptureEnvelope, RawConversationPayload } from './core/types'
import { installRunWatch, type RunWatchSnapshot } from './browser/run-watch'
import { installFleetWatch, readPersistedFleetState, type FleetWatchSnapshot } from './browser/fleet-watch'
import { installFleetLeadership, type FleetLeaderRole } from './browser/fleet-leader'
import { notifyFleetAlert, requestDesktopNotificationPermission } from './browser/notifications'
import { loadCompanionSettings, saveCompanionSettings, type CompanionSettings } from './browser/companion-settings'
import { mountSidebarExporter, updateSidebarRunWatchBadge } from './ui/sidebar'

const BUILD_VERSION = '0.4.2'

// 只暴露无敏感信息的调试标记，便于 CDP/用户确认 Tampermonkey 当前实际运行版本。
// 这能避免脚本管理器缓存旧 .user.js 时误把旧代码当成新构建测试。
Object.defineProperty(window, '__chatgptPassiveExporter', {
  configurable: true,
  value: { version: BUILD_VERSION, loadedAt: Date.now() },
})

/**
 * 每条 conversation 保存一份“当前最值得信任的被动 snapshot”。
 *
 * 过去这里只有一个 `latest`：ChatGPT 先返回完整正文、随后再请求最近 2 turns 时，
 * tail 会无条件覆盖完整 snapshot，最终 Markdown/JSON 就只剩最后两轮。现在完整性优先，
 * partial/unknown 只能在没有更好 snapshot 时暂存，绝不能覆盖已证明完整的数据。
 */
const passiveSnapshots = new Map<string, PassiveCaptureEnvelope>()
let latestWatchSnapshot: RunWatchSnapshot | null = null
let latestFleetSnapshot: FleetWatchSnapshot | null = null
let fleetLeaderRole: FleetLeaderRole = location.pathname === '/' ? 'waiting' : 'unsupported'

function renderCombinedBadge(): void {
  const page = latestWatchSnapshot
  if (!page) return

  const fleet = latestFleetSnapshot
  const persisted = fleet ? null : readPersistedFleetState()
  const tracked = fleet?.tracked ?? persisted?.tracked ?? []
  const alerts = fleet?.alerts ?? persisted?.alerts ?? []
  const abnormalCount = tracked.filter(item => item.state === 'abnormal').length
  const suspectedCount = alerts.filter(item => item.kind === 'suspected-stall').length
  const activeCount = tracked.filter(item => item.state === 'server-streaming').length
  // Sidebar 只表达“任务监控”状态。当前页 250 个 iframe / 2GB heap 之类的性能数据
  // 只放高级诊断，避免把“高负载”和“某条会话异常结束”混成同一种告警。
  const severity = abnormalCount > 0
    ? 'critical'
    : suspectedCount > 0
      ? 'warning'
      : 'ok'

  const text = abnormalCount > 0
    ? `${abnormalCount} 异常`
    : suspectedCount > 0
      ? `${suspectedCount} 疑似`
      : activeCount > 0
        ? `${activeCount} 运行`
        : '正常'

  const compactText = abnormalCount > 0
    ? `!${abnormalCount}`
    : suspectedCount > 0
      ? `?${suspectedCount}`
      : activeCount > 0
        ? `▶${activeCount}`
        : '•'

  const titleParts = [
    `当前页：${page.severity}；iframe ${page.iframe.total}，OAI sandbox ${page.iframe.oaiSandbox}`,
    `全局：${activeCount} 条服务端确认进行中，${abnormalCount} 条明确异常，${suspectedCount} 条疑似卡住`,
  ]
  if (fleet?.lastError) titleParts.push(`Fleet：${fleet.lastError}`)

  updateSidebarRunWatchBadge({ severity, text, compactText, title: titleParts.join('\n') })
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
  const assessment = assessPassiveEnvelope(envelope)
  if (assessment.conversationId) {
    passiveSnapshots.set(
      assessment.conversationId,
      preferPassiveSnapshot(passiveSnapshots.get(assessment.conversationId), envelope),
    )
  }
  runWatch.noteConversationPayload(envelope.payload as RawConversationPayload)
})

function currentChatId(): string | null {
  return location.pathname.match(/^\/c\/([^/?#]+)/u)?.[1] ?? null
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
  const pageId = currentChatId()
  if (!pageId) return null
  const snapshot = passiveSnapshots.get(pageId)
  if (!snapshot) return null

  // “被动抓到了 JSON”不代表“抓到了完整聊天”。只有完整性已证明时才直接导出；
  // partial/unknown 会在用户点击导出后走 fetchCompleteConversation() 补全。
  const assessment = assessPassiveEnvelope(snapshot)
  return assessment.completeness === 'complete'
    ? snapshot.payload as RawConversationPayload
    : null
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
  const result = await runWatch.fetchCompleteConversation(id)
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
    const result = await runWatch.fetchCompleteConversation(summary.id)
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
  const title = snapshot.conversationId ?? 'chatgpt'
  downloadText(
    `${safeFilename(title)}.run-watch.json`,
    JSON.stringify(snapshot, null, 2),
    'application/json;charset=utf-8',
  )
}

function inspectFleet(): void {
  if (fleetWatch) {
    window.alert(fleetWatch.summaryText())
    return
  }
  const persisted = readPersistedFleetState()
  const active = persisted.tracked.filter(item => item.state === 'server-streaming').length
  const abnormal = persisted.tracked.filter(item => item.state === 'abnormal').length
  const suspected = persisted.alerts.filter(item => item.kind === 'suspected-stall').length
  window.alert([
    '全局监控共享状态',
    `运行中：${active}`,
    `异常：${abnormal}`,
    `疑似卡住：${suspected}`,
    '',
    '主动轮询只由一张 ChatGPT 首页监控站执行；当前聊天页只读取共享状态，不额外发请求。',
  ].join('\n'))
}

async function pollFleetNow(): Promise<void> {
  if (!fleetWatch) {
    window.open('https://chatgpt.com/?companion-monitor=1', '_blank', 'noopener,noreferrer')
    return
  }
  await fleetWatch.pollNow()
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
  const alerts = fleetWatch?.snapshot().alerts ?? readPersistedFleetState().alerts
  const alert = alerts.at(-1)
  if (!alert) {
    window.alert('当前没有记录到告警会话。')
    return
  }
  window.open(`https://chatgpt.com/c/${encodeURIComponent(alert.conversationId)}`, '_blank', 'noopener,noreferrer')
}

async function copySafeContinue(): Promise<void> {
  const alerts = fleetWatch?.snapshot().alerts ?? readPersistedFleetState().alerts
  const alert = [...alerts].reverse().find(item => item.kind === 'abnormal')
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
  const snapshot = fleetWatch?.snapshot()
  if (!snapshot) {
    const persisted = readPersistedFleetState()
    downloadText(
      'chatgpt-fleet-watch.json',
      JSON.stringify({ persisted: true, ...persisted }, null, 2),
      'application/json;charset=utf-8',
    )
    return
  }
  downloadText(
    'chatgpt-fleet-watch.json',
    JSON.stringify(snapshot, null, 2),
    'application/json;charset=utf-8',
  )
}

function getMonitorSummary() {
  const page = latestWatchSnapshot ?? runWatch.snapshot()
  const liveFleet = latestFleetSnapshot ?? fleetWatch?.snapshot() ?? null
  const persisted = liveFleet ? null : readPersistedFleetState()
  const tracked = liveFleet?.tracked ?? persisted?.tracked ?? []
  const alerts = liveFleet?.alerts ?? persisted?.alerts ?? []
  const incidents = liveFleet?.incidents ?? persisted?.incidents ?? []
  const lastPollAt = liveFleet?.lastPollAt ?? persisted?.lastPollAt
  const monitorFresh = typeof lastPollAt === 'number' && Date.now() - lastPollAt <= 150_000

  const timeLabel = (value?: number | string) => {
    if (value == null) return ''
    const epoch = typeof value === 'number'
      ? (value < 10_000_000_000 ? value * 1000 : value)
      : Date.parse(value)
    if (!Number.isFinite(epoch)) return ''
    return new Date(epoch).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }

  const activeEntries = tracked.filter(item => item.state === 'server-streaming')
  const abnormalEntries = tracked.filter(item => item.state === 'abnormal')
  const latestSuspectedByConversation = new Map<string, (typeof alerts)[number]>()
  for (const alert of alerts) {
    if (alert.kind !== 'suspected-stall') continue
    const previous = latestSuspectedByConversation.get(alert.conversationId)
    if (!previous || alert.at >= previous.at) latestSuspectedByConversation.set(alert.conversationId, alert)
  }
  const suspectedAlerts = [...latestSuspectedByConversation.values()].sort((a, b) => b.at - a.at)

  return {
    activeCount: activeEntries.length,
    abnormalCount: abnormalEntries.length,
    suspectedCount: suspectedAlerts.length,
    incidentCount: incidents.length,
    active: activeEntries.map(item => ({
      conversationId: item.id,
      title: item.title,
      detail: [
        item.rawServerStatus ?? 'IS_STREAMING',
        item.asyncStatus == null ? '' : `async=${String(item.asyncStatus)}`,
        timeLabel(item.updateTime) ? `更新 ${timeLabel(item.updateTime)}` : '',
      ].filter(Boolean).join(' · '),
    })),
    abnormal: abnormalEntries.map(item => ({
      conversationId: item.id,
      title: item.title,
      detail: [item.abnormalReason ?? '服务器已结束但异常收尾', timeLabel(item.lastStatusAt)].filter(Boolean).join(' · '),
    })),
    suspected: suspectedAlerts.map(alert => ({
      conversationId: alert.conversationId,
      title: alert.title,
      detail: alert.reason,
    })),
    incidents: incidents.slice(0, 30).map(incident => ({
      conversationId: incident.conversationId,
      title: incident.title,
      detail: [
        incident.status === 'open'
          ? '未恢复'
          : incident.status === 'resumed'
            ? '已继续，等待正常完成'
            : '后续已正常完成',
        new Date(incident.detectedAt).toLocaleString(),
        incident.reason,
      ].filter(Boolean).join(' · '),
    })),
    monitorFresh,
    lastPollAt,
    leaderRole: location.pathname === '/'
      ? fleetLeaderRole
      : '由 ChatGPT 首页监控站负责；本页只读取共享状态',
    pageSeverity: page.severity,
    iframeCount: page.iframe.total,
    oaiSandboxCount: page.iframe.oaiSandbox,
    usedJsHeapMb: page.performance.usedJsHeapMb,
    lastError: liveFleet?.lastError,
  }
}

function openConversation(conversationId: string): void {
  window.open(`https://chatgpt.com/c/${encodeURIComponent(conversationId)}`, '_blank', 'noopener,noreferrer')
}

/**
 * 直接挂进 ChatGPT 普通 DOM sidebar；不使用 Shadow DOM。
 * sidebar 本身会被 React 重建，所以 mountSidebarExporter 内部负责自动重挂载。
 */
function mountUi(): void {
  mountSidebarExporter({
    copyText,
    screenshot,
    exportMarkdown,
    exportHtml,
    exportArchive,
    exportRawJson,
    exportManifest,
    batchExport,
    getSettings,
    updateSettings,
    getMonitorSummary,
    openConversation,
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
