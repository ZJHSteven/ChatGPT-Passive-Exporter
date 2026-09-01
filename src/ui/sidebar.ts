import { createCompanionPanel, resetCompanionPanel } from './companion-panel'

/*
 * ChatGPT 侧栏原生风格入口。
 *
 * 设计目标：
 * 1. 不使用 Shadow DOM；让入口真正处在 ChatGPT sidebar 的普通 DOM 树里。
 * 2. 尽量复用 ChatGPT 自己现有导航项的 class/style，而不是复制一大份易过时 CSS。
 * 3. ChatGPT 是 SPA，侧栏会反复卸载/重建，因此用 MutationObserver 做幂等重挂载。
 * 4. selector 失效时优先寻找几个稳定的 data-testid fallback；完全找不到时静默等待，
 *    不干扰 ChatGPT 正常页面。
 */

export interface CompanionUiSettings {
  includeReasoning: boolean
  includeRichAppendix: boolean
  batchLimit: 5 | 10 | 20 | 28
  screenshotScale: 1 | 1.5 | 2
}

export interface CompanionMonitorItem {
  conversationId: string
  title: string
  detail?: string
}

export interface CompanionMonitorSummary {
  activeCount: number
  abnormalCount: number
  suspectedCount: number
  incidentCount: number
  active: CompanionMonitorItem[]
  abnormal: CompanionMonitorItem[]
  suspected: CompanionMonitorItem[]
  incidents: CompanionMonitorItem[]
  historyAuditRunning: boolean
  historyAuditScanned: number
  historyAuditFound: number
  historyAuditErrors: number
  monitorFresh: boolean
  lastPollAt?: number
  leaderRole: string
  pageSeverity: string
  iframeCount: number
  oaiSandboxCount: number
  usedJsHeapMb?: number
  lastError?: string
}

export interface SidebarExportActions {
  copyText?: () => unknown | Promise<unknown>
  screenshot?: () => unknown | Promise<unknown>
  exportMarkdown?: () => unknown | Promise<unknown>
  exportHtml?: () => unknown | Promise<unknown>
  exportArchive?: () => unknown | Promise<unknown>
  exportRawJson?: () => unknown | Promise<unknown>
  exportManifest?: () => unknown | Promise<unknown>
  batchExport?: (format: 'markdown' | 'html' | 'json', limit: number) => unknown | Promise<unknown>
  getSettings?: () => CompanionUiSettings
  updateSettings?: (settings: Partial<CompanionUiSettings>) => unknown | Promise<unknown>
  getMonitorSummary?: () => CompanionMonitorSummary
  openConversation?: (conversationId: string) => unknown | Promise<unknown>
  auditHistory?: () => unknown | Promise<unknown>
  inspectRun?: () => unknown | Promise<unknown>
  checkServerStatus?: () => unknown | Promise<unknown>
  exportRunDiagnostics?: () => unknown | Promise<unknown>
  inspectFleet?: () => unknown | Promise<unknown>
  pollFleetNow?: () => unknown | Promise<unknown>
  enableNotifications?: () => unknown | Promise<unknown>
  openLatestAbnormal?: () => unknown | Promise<unknown>
  copySafeContinue?: () => unknown | Promise<unknown>
  exportFleetDiagnostics?: () => unknown | Promise<unknown>
}

export interface SidebarRunWatchBadge {
  severity: 'ok' | 'warning' | 'danger' | 'critical'
  text: string
  compactText?: string
  title?: string
}

const ITEM_MARKER = 'data-chatgpt-passive-exporter-item'
const ITEM_WRAPPER_MARKER = 'data-chatgpt-companion-item-wrapper'
const RUN_WATCH_BADGE_MARKER = 'data-chatgpt-run-watch-badge'

/**
 * ChatGPT 2026-08 会同时把“展开 sidebar”和“52px tiny rail”留在 DOM 中，只通过
 * `opacity / pointer-events / inert` 切换哪一套真正可交互。单纯 `querySelector()` 会稳定拿到
 * DOM 顺序更靠前、但完全透明的 tiny rail——这正是 0.3.8 “脚本已运行但用户看不到入口”的根因。
 *
 * 因此所有 sidebar anchor/template 都必须经过祖先链可见性检查，而不能只检查元素自身尺寸。
 */
function isUsableSidebarElement(element: Element): boolean {
  if (!element.isConnected) return false
  const rect = element.getBoundingClientRect()
  if (rect.width < 1 || rect.height < 1) return false

  for (let node: Element | null = element; node; node = node.parentElement) {
    if (!(node instanceof HTMLElement)) continue
    if (node.hidden || node.hasAttribute('inert')) return false

    const style = window.getComputedStyle(node)
    if (style.display === 'none') return false
    if (style.visibility === 'hidden' || style.visibility === 'collapse') return false
    if (Number.parseFloat(style.opacity || '1') <= 0.01) return false
    if (style.pointerEvents === 'none') return false
    if (node === document.documentElement) break
  }

  return true
}

function findVisibleSidebarElement<T extends Element>(selectors: string[]): T | null {
  for (const selector of selectors) {
    for (const element of document.querySelectorAll<T>(selector)) {
      if (isUsableSidebarElement(element)) return element
    }
  }
  return null
}

/**
 * 找一个“当前真正可见”的标准 sidebar item 当模板。
 * 这样颜色、圆角、hover、暗色模式、展开/折叠尺寸都来自用户眼前正在使用的 sidebar，
 * 而不是 DOM 中备用的隐藏副本。
 */
function findNativeSidebarItem(): HTMLElement | null {
  return findVisibleSidebarElement<HTMLElement>([
    '[data-testid="sidebar-item-recall"]',
    '[data-testid="sidebar-item-tasks"]',
    '[data-testid="plugins-button"]',
    '[data-testid="create-new-chat-button"]',
    '[data-sidebar-item="true"].__menu-item',
  ])
}

function findInsertionReference(): Element | null {
  // UX 基线回归 ChatGPT Exporter：Companion 属于“账户/工具”层，而不是“创建内容”层。
  // 因此优先紧贴当前真正可见的个人账户按钮上方；这样用户会自然把它理解成一个全局助手，
  // 而不是把它误认为“新建聊天”的附属动作。展开/折叠两套 sidebar 仍通过可见性检查区分。
  const profile = findVisibleSidebarElement<HTMLElement>(['[data-testid="accounts-profile-button"]'])
  if (profile) {
    const wrapper = profile.parentElement
    if (wrapper?.parentElement && wrapper.children.length === 1) return wrapper
    return profile
  }

  // 极少数页面（登录中/分享页）没有 profile button，再退回当前可见的新聊天入口。
  const newChat = findVisibleSidebarElement<HTMLElement>(['[data-testid="create-new-chat-button"]'])
  if (newChat) {
    const tinyRail = newChat.closest('#stage-sidebar-tiny-bar')
    if (tinyRail) return newChat.parentElement ?? newChat
    return newChat.closest('li') ?? newChat
  }

  return findVisibleSidebarElement<HTMLElement>([
    '[data-testid="plugins-button"]',
    '[data-testid="sidebar-item-tasks"]',
    '[data-testid="sidebar-item-recall"]',
  ])
}

function removeMountedSidebarItem(item: HTMLElement): void {
  const wrapper = item.closest<HTMLElement>(`[${ITEM_WRAPPER_MARKER}]`)
  if (wrapper) wrapper.remove()
  else item.remove()
}

function companionIcon(): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('width', '20')
  svg.setAttribute('height', '20')
  svg.setAttribute('viewBox', '0 0 20 20')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('class', 'icon')
  svg.setAttribute('aria-hidden', 'true')

  // 折叠 sidebar 只有 36×36px，原来的“下载箭头”太像 ChatGPT 自带动作，用户很难意识到
  // 这是整套 Companion。这里改成一个带 C 字母的圆形标识：既不冒充 ChatGPT 原生图标，
  // 又能在 tiny rail 中一眼辨认；状态 badge 仍叠在右上角。
  const circle = document.createElementNS(ns, 'circle')
  circle.setAttribute('cx', '10')
  circle.setAttribute('cy', '10')
  circle.setAttribute('r', '7.1')
  circle.setAttribute('stroke', 'currentColor')
  circle.setAttribute('stroke-width', '1.4')

  const text = document.createElementNS(ns, 'text')
  text.setAttribute('x', '10')
  text.setAttribute('y', '13')
  text.setAttribute('text-anchor', 'middle')
  text.setAttribute('font-size', '8.5')
  text.setAttribute('font-weight', '700')
  text.setAttribute('font-family', 'system-ui, sans-serif')
  text.setAttribute('fill', 'currentColor')
  text.textContent = 'C'

  svg.append(circle, text)
  return svg
}

function replaceTemplateContents(item: HTMLElement): void {
  // 复用模板最外层样式，但把 React 生成的 href/id/radix 状态等行为属性清掉。
  item.removeAttribute('href')
  item.removeAttribute('id')
  item.removeAttribute('data-testid')
  item.removeAttribute('data-discover')
  item.removeAttribute('aria-controls')
  item.removeAttribute('aria-haspopup')
  item.removeAttribute('aria-expanded')
  item.setAttribute('role', 'button')
  item.setAttribute('tabindex', '0')
  item.setAttribute('aria-label', 'ChatGPT Companion：归档 / 运行监控')
  item.setAttribute(ITEM_MARKER, 'true')
  item.removeAttribute('data-sidebar-item')

  // 直接重建内部结构，避免把模板自己的链接、快捷键、trailing button 一并克隆过来。
  item.replaceChildren()

  const icon = document.createElement('div')
  icon.setAttribute('aria-hidden', 'true')
  icon.className = 'relative flex items-center justify-center [opacity:var(--menu-item-icon-opacity,1)] icon'
  const iconInner = document.createElement('div')
  iconInner.className = 'absolute inset-0 flex items-center justify-center'
  iconInner.append(companionIcon())
  icon.append(iconInner)

  const grow = document.createElement('div')
  grow.className = 'flex min-w-0 grow items-center gap-2.5'
  const text = document.createElement('div')
  text.className = 'truncate'
  text.textContent = 'ChatGPT Companion'
  grow.append(text)

  item.append(icon, grow)
}

/**
 * ChatGPT 2026-08 的 sidebar 有两种完全不同的容器：
 * - 展开的宽 sidebar；
 * - `#stage-sidebar-tiny-bar`，实际宽度只有约 52px。
 *
 * 旧版直接把 138px 的 menu item 插进 tiny rail，DOM 虽然存在，却会被外层
 * `overflow:hidden` 裁掉，用户视觉上等于“没有 UI”。这里在插入后根据真实容器
 * 做一次布局收缩：tiny rail 只显示 36×36 图标，状态 badge 叠在右上角；宽 sidebar
 * 才显示“归档 / 监控”文字。
 */
function applySidebarLayout(item: HTMLElement, reference: Element): void {
  const tinyRail = reference.closest('#stage-sidebar-tiny-bar')
    ?? reference.closest('nav[aria-label="侧边栏"]')
  const compact = Boolean(tinyRail && tinyRail.getBoundingClientRect().width < 80)

  item.dataset.chatgptPassiveExporterCompact = compact ? 'true' : 'false'
  item.title = compact ? 'ChatGPT Companion：归档 / 运行监控' : ''

  const text = item.querySelector<HTMLElement>('.truncate')
  if (text) {
    text.textContent = compact ? '' : 'ChatGPT Companion'
    text.style.display = compact ? 'none' : ''
  }

  if (compact) {
    item.style.width = '36px'
    item.style.minWidth = '36px'
    item.style.maxWidth = '36px'
    item.style.height = '36px'
    item.style.marginInline = '6px'
    item.style.padding = '0'
    item.style.justifyContent = 'center'
    item.style.position = 'relative'
    item.style.overflow = 'visible'

    const grow = item.children[1] as HTMLElement | undefined
    if (grow) grow.style.display = 'none'
  }
  else {
    item.style.width = ''
    item.style.minWidth = ''
    item.style.maxWidth = ''
    item.style.height = ''
    item.style.marginInline = ''
    item.style.padding = ''
    item.style.justifyContent = ''
    item.style.position = ''
  }
}

function createMenu(actions: SidebarExportActions): HTMLDivElement {
  const unavailable = () => window.alert('当前构建暂未提供这个功能。')
  const defaultSettings: CompanionUiSettings = {
    includeReasoning: false,
    includeRichAppendix: false,
    batchLimit: 10,
    screenshotScale: 1.5,
  }
  const defaultMonitor: CompanionMonitorSummary = {
    activeCount: 0,
    abnormalCount: 0,
    suspectedCount: 0,
    incidentCount: 0,
    active: [],
    abnormal: [],
    suspected: [],
    incidents: [],
    historyAuditRunning: false,
    historyAuditScanned: 0,
    historyAuditFound: 0,
    historyAuditErrors: 0,
    monitorFresh: false,
    leaderRole: '此构建未启用 Fleet Watch',
    pageSeverity: 'unknown',
    iframeCount: 0,
    oaiSandboxCount: 0,
  }

  return createCompanionPanel({
    copyText: actions.copyText ?? unavailable,
    screenshot: actions.screenshot ?? unavailable,
    exportMarkdown: actions.exportMarkdown ?? unavailable,
    exportHtml: actions.exportHtml ?? unavailable,
    exportArchive: actions.exportArchive ?? unavailable,
    exportRawJson: actions.exportRawJson ?? unavailable,
    exportManifest: actions.exportManifest ?? unavailable,
    batchExport: actions.batchExport ?? ((_format, _limit) => unavailable()),
    getSettings: actions.getSettings ?? (() => ({ ...defaultSettings })),
    updateSettings: actions.updateSettings ?? (() => unavailable()),
    getMonitorSummary: actions.getMonitorSummary ?? (() => ({ ...defaultMonitor })),
    openConversation: actions.openConversation ?? (() => unavailable()),
    auditHistory: actions.auditHistory ?? (() => unavailable()),
    inspectRun: actions.inspectRun ?? unavailable,
    checkServerStatus: actions.checkServerStatus ?? unavailable,
    exportRunDiagnostics: actions.exportRunDiagnostics ?? unavailable,
    inspectFleet: actions.inspectFleet ?? unavailable,
    pollFleetNow: actions.pollFleetNow ?? unavailable,
    enableNotifications: actions.enableNotifications ?? unavailable,
    openLatestAbnormal: actions.openLatestAbnormal ?? unavailable,
    copySafeContinue: actions.copySafeContinue ?? unavailable,
    exportFleetDiagnostics: actions.exportFleetDiagnostics ?? unavailable,
  })
}

function positionMenu(item: HTMLElement, menu: HTMLElement): void {
  const rect = item.getBoundingClientRect()
  const menuRect = menu.getBoundingClientRect()
  const mobile = window.innerWidth < 768

  if (mobile) {
    const left = Math.max(8, Math.min(window.innerWidth - menuRect.width - 8, rect.left))
    const top = Math.max(8, rect.top - menuRect.height - 8)
    menu.style.left = `${left}px`
    menu.style.top = `${top}px`
  }
  else {
    const left = Math.min(window.innerWidth - menuRect.width - 8, rect.right + 8)
    const top = Math.max(8, Math.min(window.innerHeight - menuRect.height - 8, rect.top))
    menu.style.left = `${left}px`
    menu.style.top = `${top}px`
  }
}

/**
 * 挂载 sidebar 入口并持续守护 SPA 重渲染。
 * 返回清理函数，便于扩展 hot reload / 测试卸载。
 */
/**
 * Run Watch 用同一个 sidebar item 展示极轻量状态，不额外创建 iframe/widget。
 * `ok` 时默认只显示一个小圆点；iframe 暴涨或最后一轮明确中断时显示数量/警告。
 */
export function updateSidebarRunWatchBadge(input: SidebarRunWatchBadge): void {
  const item = document.querySelector<HTMLElement>(`[${ITEM_MARKER}]`)
  if (!item) return

  let badge = item.querySelector<HTMLElement>(`[${RUN_WATCH_BADGE_MARKER}]`)
  if (!badge) {
    badge = document.createElement('span')
    badge.setAttribute(RUN_WATCH_BADGE_MARKER, 'true')
    badge.style.cssText = [
      'margin-left:auto',
      'padding:1px 6px',
      'border-radius:999px',
      'font-size:11px',
      'line-height:18px',
      'white-space:nowrap',
      'font-variant-numeric:tabular-nums',
      'pointer-events:none',
    ].join(';')
    item.append(badge)
  }

  badge.textContent = item.dataset.chatgptPassiveExporterCompact === 'true'
    ? (input.compactText ?? input.text)
    : input.text
  badge.title = input.title ?? ''
  badge.dataset.severity = input.severity

  // 不硬编码主题色；使用 ChatGPT 现有 CSS 变量，并仅通过透明度/outline 表达级别。
  badge.style.background = input.severity === 'ok'
    ? 'var(--surface-tertiary,rgba(127,127,127,.10))'
    : 'var(--surface-secondary,rgba(127,127,127,.18))'
  badge.style.outline = input.severity === 'critical'
    ? '2px solid currentColor'
    : input.severity === 'danger'
      ? '1px solid currentColor'
      : 'none'
  badge.style.opacity = input.severity === 'ok' ? '0.65' : '1'

  if (item.dataset.chatgptPassiveExporterCompact === 'true') {
    badge.style.position = 'absolute'
    badge.style.right = '-3px'
    badge.style.top = '-5px'
    badge.style.marginLeft = '0'
    badge.style.minWidth = '14px'
    badge.style.height = '14px'
    badge.style.lineHeight = '14px'
    badge.style.padding = '0 3px'
    badge.style.fontSize = '9px'
    badge.style.textAlign = 'center'
  }
  else {
    badge.style.position = ''
    badge.style.right = ''
    badge.style.top = ''
    badge.style.marginLeft = 'auto'
    badge.style.minWidth = ''
    badge.style.height = ''
    badge.style.lineHeight = '18px'
    badge.style.padding = '1px 6px'
    badge.style.fontSize = '11px'
    badge.style.textAlign = ''
  }
}

export function mountSidebarExporter(actions: SidebarExportActions): () => void {
  let menu: HTMLDivElement | null = null
  let stopped = false

  const closeMenu = (event: Event) => {
    const target = event.target
    if (!(target instanceof Node)) return
    if (menu?.contains(target)) return
    if (document.querySelector(`[${ITEM_MARKER}]`)?.contains(target)) return
    if (menu) menu.hidden = true
  }

  const mount = () => {
    if (stopped) return

    // ChatGPT 会同时保留展开/折叠两套 sidebar。若 Companion 当前所在那套已经变成隐藏备用 rail，
    // 不能因为“DOM 里已经有 item”就提前 return；必须删除旧挂载并迁到当前可见 sidebar。
    const existing = document.querySelector<HTMLElement>(`[${ITEM_MARKER}]`)
    const reference = findInsertionReference()
    if (existing) {
      if (reference && isUsableSidebarElement(existing)) return
      removeMountedSidebarItem(existing)
      if (menu) menu.hidden = true
    }

    const template = findNativeSidebarItem()
    if (!template || !reference?.parentElement) return

    // 不 clone <a> 标签本身：只复制 ChatGPT 当前 menu-item 的 class/style 到自己的 div。
    // 这正是原版 ChatGPT Exporter 避开 React Router 事件委托的关键。
    const clone = document.createElement('div')
    clone.className = template.className
    clone.style.cssText = template.style.cssText
    replaceTemplateContents(clone)
    applySidebarLayout(clone, reference)

    // 页面重建 body 时，旧 menu 引用可能仍在变量里但节点已经断开。
    // 此时必须重新创建，而不能因为 `menu !== null` 就误以为它还活着。
    if (!menu?.isConnected) menu = createMenu(actions)

    const toggle = (event: Event) => {
      event.preventDefault()
      event.stopPropagation()
      if (!menu) return
      const opening = menu.hidden
      if (opening) resetCompanionPanel(menu)
      menu.hidden = !menu.hidden
      if (!menu.hidden) positionMenu(clone, menu)
    }

    clone.addEventListener('click', toggle)
    clone.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') toggle(event)
    })

    // 新聊天在展开 sidebar 中位于 <li> 内。为了不向 <ul> 塞一个裸 <div>，这里补一个最薄的
    // list wrapper；tiny rail 本来就是普通 <div> 布局，继续直接插入即可。
    const referencesNewChat = reference.matches('[data-testid="create-new-chat-button"]')
      || Boolean(reference.querySelector('[data-testid="create-new-chat-button"]'))
    if (referencesNewChat && reference instanceof HTMLLIElement && reference.parentElement?.tagName === 'UL') {
      const wrapper = document.createElement('li')
      wrapper.className = 'list-none'
      wrapper.setAttribute(ITEM_WRAPPER_MARKER, 'true')
      wrapper.append(clone)
      reference.after(wrapper)
    }
    else if (referencesNewChat) reference.after(clone)
    else reference.before(clone)
  }

  // 0.4.0 之前为了防 SPA 重建，监听了 document.documentElement 的整个 childList subtree。
  // ChatGPT 在恢复一个包含数百 DevSpace widget 的长会话时会产生海量 DOM 插入；每一批 mutation
  // 都会触发 mount()，而 mount() 为了找“当前可见 sidebar”需要做 layout/style 读取。CPU profile
  // 已实测这条路径能吃掉约 5% 的 hydration 主线程时间，因此这里彻底取消全树 observer。
  //
  // sidebar 本身不是高频交互区域：1.5 秒一次的自检已经足以应对 React SPA 重建；展开/折叠
  // 则继续只观察 tiny rail 自身 3 个属性，保持即时迁移。这样聊天正文产生多少节点都不会唤醒 UI 挂载器。
  let observedTinyRail: Element | null = null
  const modeObserver = new MutationObserver(() => mount())
  const bindModeObserver = () => {
    const tinyRail = document.querySelector('#stage-sidebar-tiny-bar')
    if (tinyRail === observedTinyRail) return
    modeObserver.disconnect()
    observedTinyRail = tinyRail
    if (tinyRail) {
      modeObserver.observe(tinyRail, {
        attributes: true,
        attributeFilter: ['class', 'style', 'inert'],
      })
    }
  }

  const maintain = () => {
    if (stopped) return
    bindModeObserver()
    mount()
  }
  const maintenanceTimer = window.setInterval(maintain, 1_500)

  const onResize = () => {
    const item = document.querySelector<HTMLElement>(`[${ITEM_MARKER}]`)
    if (item && menu && !menu.hidden) positionMenu(item, menu)
  }
  window.addEventListener('resize', onResize)
  document.addEventListener('pointerdown', closeMenu, true)

  maintain()

  return () => {
    stopped = true
    window.clearInterval(maintenanceTimer)
    modeObserver.disconnect()
    window.removeEventListener('resize', onResize)
    document.removeEventListener('pointerdown', closeMenu, true)
    for (const item of document.querySelectorAll<HTMLElement>(`[${ITEM_MARKER}]`)) removeMountedSidebarItem(item)
    menu?.remove()
    menu = null
  }
}
