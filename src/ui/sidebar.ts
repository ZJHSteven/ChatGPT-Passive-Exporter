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
  title?: string
}

const ITEM_MARKER = 'data-chatgpt-passive-exporter-item'
const ITEM_WRAPPER_MARKER = 'data-chatgpt-companion-item-wrapper'
const MENU_MARKER = 'data-chatgpt-passive-exporter-menu'
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
  // 优先使用用户当前真正看得见的“新聊天”。展开 sidebar 时返回它的 <li>，折叠 tiny rail
  // 则返回按钮 wrapper；两种模式都能把 Companion 固定在顶部，而不会插进透明备用 rail。
  const newChat = findVisibleSidebarElement<HTMLElement>(['[data-testid="create-new-chat-button"]'])
  if (newChat) {
    const tinyRail = newChat.closest('#stage-sidebar-tiny-bar')
    if (tinyRail) return newChat.parentElement ?? newChat
    return newChat.closest('li') ?? newChat
  }

  // fallback：个人资料按钮之前。这里同样只允许当前可交互的那一份 profile button。
  const profile = findVisibleSidebarElement<HTMLElement>(['[data-testid="accounts-profile-button"]'])
  if (profile) {
    const wrapper = profile.parentElement
    if (wrapper?.parentElement && wrapper.children.length === 1) return wrapper
    return profile
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
  if (actions.inspectRun) entries.push(['查看当前页性能诊断', actions.inspectRun])
  if (actions.checkServerStatus) entries.push(['检查当前会话服务器状态', actions.checkServerStatus])
  if (actions.exportRunDiagnostics) entries.push(['导出当前页诊断 JSON', actions.exportRunDiagnostics])
  if (actions.inspectFleet) entries.push(['查看全局运行监控', actions.inspectFleet])
  if (actions.pollFleetNow) entries.push(['立即扫描最近会话', actions.pollFleetNow])
  if (actions.enableNotifications) entries.push(['启用异常桌面通知', actions.enableNotifications])
  if (actions.openLatestAbnormal) entries.push(['打开最近告警会话', actions.openLatestAbnormal])
  if (actions.copySafeContinue) entries.push(['复制安全续跑提示', actions.copySafeContinue])
  if (actions.exportFleetDiagnostics) entries.push(['导出全局监控 JSON', actions.exportFleetDiagnostics])

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

  // 主 observer 继续只看 childList，避免监听整棵超长聊天 DOM 的 attributes；另外只对 52px tiny rail
  // 建一个极小的 mode observer。展开/折叠切换一定会改变它的 class/inert，因此可以及时迁移 Companion，
  // 又不会为了一个 sidebar 开关去监听几千条 conversation 节点的样式变化。
  let observedTinyRail: Element | null = null
  const modeObserver = new MutationObserver(mount)
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

  const observer = new MutationObserver(() => {
    bindModeObserver()
    mount()
  })
  observer.observe(document.documentElement, { childList: true, subtree: true })
  bindModeObserver()
  window.addEventListener('resize', () => {
    const item = document.querySelector<HTMLElement>(`[${ITEM_MARKER}]`)
    if (item && menu && !menu.hidden) positionMenu(item, menu)
  })
  document.addEventListener('pointerdown', closeMenu, true)

  mount()

  return () => {
    stopped = true
    observer.disconnect()
    modeObserver.disconnect()
    document.removeEventListener('pointerdown', closeMenu, true)
    for (const item of document.querySelectorAll<HTMLElement>(`[${ITEM_MARKER}]`)) removeMountedSidebarItem(item)
    menu?.remove()
    menu = null
  }
}
