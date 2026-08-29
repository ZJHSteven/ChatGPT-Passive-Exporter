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

export interface SidebarExportActions {
  // UI 只关心动作是否可调用，不消费返回值；扩展工具栏版本会顺带返回 boolean 状态。
  exportMarkdown: () => unknown | Promise<unknown>
  exportArchive: () => unknown | Promise<unknown>
  exportManifest?: () => unknown | Promise<unknown>
  inspectRun?: () => unknown | Promise<unknown>
  checkServerStatus?: () => unknown | Promise<unknown>
  exportRunDiagnostics?: () => unknown | Promise<unknown>
}

export interface SidebarRunWatchBadge {
  severity: 'ok' | 'warning' | 'danger' | 'critical'
  text: string
  title?: string
}

const ITEM_MARKER = 'data-chatgpt-passive-exporter-item'
const MENU_MARKER = 'data-chatgpt-passive-exporter-menu'
const RUN_WATCH_BADGE_MARKER = 'data-chatgpt-run-watch-badge'

/**
 * 找一个当前页面真实存在的“标准 sidebar item”当模板。
 * 这样颜色、圆角、hover、暗色模式、折叠状态都由 ChatGPT 自己的 CSS 控制。
 */
function findNativeSidebarItem(): HTMLElement | null {
  const selectors = [
    '[data-testid="sidebar-item-recall"]',
    '[data-testid="sidebar-item-tasks"]',
    '[data-testid="plugins-button"]',
    '[data-testid="create-new-chat-button"]',
    '[data-sidebar-item="true"].__menu-item',
  ]

  for (const selector of selectors) {
    const element = document.querySelector<HTMLElement>(selector)
    if (element) return element
  }
  return null
}

function findInsertionReference(): Element | null {
  // 优先完全跟随 ChatGPT Exporter 的成熟位置：个人资料按钮之前。
  // 当前 ChatGPT 会把 data-sidebar-item 的 <a> 交给全局路由事件处理；我们若伪装成链接，
  // 点击会触发侧栏自己的关闭/重建逻辑。所以只借样式，不借路由语义。
  const profile = document.querySelector('[data-testid="accounts-profile-button"]')
  if (profile) {
    const wrapper = profile.parentElement
    if (wrapper?.parentElement && wrapper.children.length === 1) return wrapper
    return profile
  }

  return document.querySelector('[data-testid="plugins-button"]')
    ?? document.querySelector('[data-testid="sidebar-item-tasks"]')
    ?? document.querySelector('[data-testid="sidebar-item-recall"]')
}

function downloadIcon(): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('width', '20')
  svg.setAttribute('height', '20')
  svg.setAttribute('viewBox', '0 0 20 20')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('class', 'icon')
  svg.setAttribute('aria-hidden', 'true')

  const path = document.createElementNS(ns, 'path')
  path.setAttribute('d', 'M10 2.75v9m0 0 3.25-3.25M10 11.75 6.75 8.5M4 14.25v1.5A1.25 1.25 0 0 0 5.25 17h9.5A1.25 1.25 0 0 0 16 15.75v-1.5')
  path.setAttribute('stroke', 'currentColor')
  path.setAttribute('stroke-width', '1.5')
  path.setAttribute('stroke-linecap', 'round')
  path.setAttribute('stroke-linejoin', 'round')
  svg.append(path)
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
  item.setAttribute('aria-label', '导出 / 归档当前聊天')
  item.setAttribute(ITEM_MARKER, 'true')
  item.removeAttribute('data-sidebar-item')

  // 直接重建内部结构，避免把模板自己的链接、快捷键、trailing button 一并克隆过来。
  item.replaceChildren()

  const icon = document.createElement('div')
  icon.setAttribute('aria-hidden', 'true')
  icon.className = 'relative flex items-center justify-center [opacity:var(--menu-item-icon-opacity,1)] icon'
  const iconInner = document.createElement('div')
  iconInner.className = 'absolute inset-0 flex items-center justify-center'
  iconInner.append(downloadIcon())
  icon.append(iconInner)

  const grow = document.createElement('div')
  grow.className = 'flex min-w-0 grow items-center gap-2.5'
  const text = document.createElement('div')
  text.className = 'truncate'
  text.textContent = '归档 / 导出'
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
  item.title = compact ? 'ChatGPT 归档 / 运行监控' : ''

  const text = item.querySelector<HTMLElement>('.truncate')
  if (text) {
    text.textContent = compact ? '' : '归档 / 监控'
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
  const menu = document.createElement('div')
  menu.setAttribute(MENU_MARKER, 'true')
  menu.hidden = true
  menu.style.cssText = [
    'position:fixed',
    'z-index:2147483000',
    'min-width:220px',
    'padding:6px',
    'border:1px solid var(--border-default,rgba(127,127,127,.22))',
    'border-radius:14px',
    'background:var(--main-surface-primary,var(--token-main-surface-primary,#fff))',
    'color:var(--text-primary,var(--token-text-primary,#111))',
    'box-shadow:0 12px 36px rgba(0,0,0,.18)',
  ].join(';')

  const entries: Array<[string, () => unknown | Promise<unknown>]> = [
    ['导出 Markdown', actions.exportMarkdown],
    ['导出安全归档 JSON', actions.exportArchive],
  ]
  if (actions.exportManifest) entries.push(['导出富媒体清单', actions.exportManifest])
  if (actions.inspectRun) entries.push(['查看运行诊断', actions.inspectRun])
  if (actions.checkServerStatus) entries.push(['检查服务器运行状态', actions.checkServerStatus])
  if (actions.exportRunDiagnostics) entries.push(['导出运行诊断 JSON', actions.exportRunDiagnostics])

  for (const [label, action] of entries) {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = label
    button.style.cssText = [
      'display:block',
      'width:100%',
      'border:0',
      'border-radius:10px',
      'padding:9px 10px',
      'background:transparent',
      'color:inherit',
      'text-align:left',
      'font:inherit',
      'cursor:pointer',
    ].join(';')
    button.addEventListener('mouseenter', () => {
      button.style.background = 'var(--surface-hover,var(--token-surface-hover,rgba(127,127,127,.12)))'
    })
    button.addEventListener('mouseleave', () => {
      button.style.background = 'transparent'
    })
    button.addEventListener('click', async (event) => {
      event.preventDefault()
      event.stopPropagation()
      menu.hidden = true
      await action()
    })
    menu.append(button)
  }

  // ChatGPT 的 React 根偶尔会重建/清理 body 直属的未知节点；挂到 documentElement
  // 可以避免菜单在 sidebar 状态变化后被页面顺手移除。它是 position:fixed，不参与布局。
  document.documentElement.append(menu)
  return menu
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

  badge.textContent = input.text
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
    if (stopped || document.querySelector(`[${ITEM_MARKER}]`)) return

    const template = findNativeSidebarItem()
    const reference = findInsertionReference()
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
      menu.hidden = !menu.hidden
      if (!menu.hidden) positionMenu(clone, menu)
    }

    clone.addEventListener('click', toggle)
    clone.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') toggle(event)
    })

    // 优先插在个人资料按钮之前；fallback 才放到其它一级入口之前。
    reference.before(clone)
  }

  const observer = new MutationObserver(mount)
  observer.observe(document.documentElement, { childList: true, subtree: true })
  window.addEventListener('resize', () => {
    const item = document.querySelector<HTMLElement>(`[${ITEM_MARKER}]`)
    if (item && menu && !menu.hidden) positionMenu(item, menu)
  })
  document.addEventListener('pointerdown', closeMenu, true)

  mount()

  return () => {
    stopped = true
    observer.disconnect()
    document.removeEventListener('pointerdown', closeMenu, true)
    document.querySelector(`[${ITEM_MARKER}]`)?.remove()
    menu?.remove()
    menu = null
  }
}
