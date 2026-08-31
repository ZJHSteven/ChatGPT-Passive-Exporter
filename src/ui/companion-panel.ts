export interface CompanionPanelSettings {
  includeReasoning: boolean
  includeRichAppendix: boolean
  batchLimit: 5 | 10 | 20 | 28
  screenshotScale: 1 | 1.5 | 2
}

export interface CompanionPanelMonitorSummary {
  activeCount: number
  abnormalCount: number
  suspectedCount: number
  leaderRole: string
  pageSeverity: string
  iframeCount: number
  oaiSandboxCount: number
  usedJsHeapMb?: number
  lastError?: string
  latestAlertTitle?: string
}

export interface CompanionPanelActions {
  copyText: () => unknown | Promise<unknown>
  screenshot: () => unknown | Promise<unknown>
  exportMarkdown: () => unknown | Promise<unknown>
  exportHtml: () => unknown | Promise<unknown>
  exportArchive: () => unknown | Promise<unknown>
  exportRawJson: () => unknown | Promise<unknown>
  exportManifest: () => unknown | Promise<unknown>
  batchExport: (format: 'markdown' | 'html' | 'json', limit: number) => unknown | Promise<unknown>
  getSettings: () => CompanionPanelSettings
  updateSettings: (settings: Partial<CompanionPanelSettings>) => unknown | Promise<unknown>
  getMonitorSummary: () => CompanionPanelMonitorSummary
  inspectRun: () => unknown | Promise<unknown>
  checkServerStatus: () => unknown | Promise<unknown>
  exportRunDiagnostics: () => unknown | Promise<unknown>
  inspectFleet: () => unknown | Promise<unknown>
  pollFleetNow: () => unknown | Promise<unknown>
  enableNotifications: () => unknown | Promise<unknown>
  openLatestAbnormal: () => unknown | Promise<unknown>
  copySafeContinue: () => unknown | Promise<unknown>
  exportFleetDiagnostics: () => unknown | Promise<unknown>
}

type PanelView = 'home' | 'json' | 'batch' | 'settings' | 'monitor' | 'advanced'

const MENU_MARKER = 'data-chatgpt-passive-exporter-menu'

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  return node
}

function applyHover(button: HTMLButtonElement): void {
  button.addEventListener('mouseenter', () => {
    button.style.background = 'var(--surface-hover,var(--token-surface-hover,rgba(127,127,127,.10)))'
  })
  button.addEventListener('mouseleave', () => {
    button.style.background = button.dataset.baseBackground ?? 'transparent'
  })
}

function sectionTitle(text: string): HTMLElement {
  const title = el('div')
  title.textContent = text
  title.style.cssText = [
    'padding:2px 4px 7px',
    'font-size:11px',
    'font-weight:600',
    'opacity:.58',
    'letter-spacing:.02em',
  ].join(';')
  return title
}

function divider(): HTMLElement {
  const node = el('div')
  node.style.cssText = 'height:1px;background:var(--border-light,rgba(127,127,127,.16));margin:8px 0'
  return node
}

function statusSentence(summary: CompanionPanelMonitorSummary): string {
  if (summary.abnormalCount > 0) return `${summary.abnormalCount} 条异常 · ${summary.activeCount} 条运行中`
  if (summary.suspectedCount > 0) return `${summary.suspectedCount} 条疑似卡住 · ${summary.activeCount} 条运行中`
  if (summary.activeCount > 0) return `${summary.activeCount} 条任务正在运行`
  return '当前没有已确认运行中的任务'
}

function metric(label: string, value: string, emphasis = false): HTMLElement {
  const box = el('div')
  box.style.cssText = [
    'min-width:0',
    'padding:9px 8px',
    'border-radius:11px',
    'background:var(--surface-secondary,rgba(127,127,127,.08))',
    'text-align:center',
  ].join(';')
  const number = el('div')
  number.textContent = value
  number.style.cssText = `font-size:17px;font-weight:${emphasis ? '700' : '600'};line-height:1.2`
  const caption = el('div')
  caption.textContent = label
  caption.style.cssText = 'font-size:10px;opacity:.58;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis'
  box.append(number, caption)
  return box
}

/**
 * Companion 的产品面板。
 *
 * 设计原则：
 * - 首屏只暴露用户任务：导出当前聊天、看运行状态。
 * - 诊断 JSON / server status 等工程动作全部放进“高级诊断”。
 * - JSON、批量导出、设置使用二级视图，不把一次性复杂度堆在主菜单。
 */
export function createCompanionPanel(actions: CompanionPanelActions): HTMLDivElement {
  const panel = el('div')
  panel.setAttribute(MENU_MARKER, 'true')
  panel.hidden = true
  panel.style.cssText = [
    'position:fixed',
    'z-index:2147483000',
    'width:320px',
    'max-width:calc(100vw - 16px)',
    'max-height:min(610px,calc(100vh - 16px))',
    'overflow:auto',
    'padding:10px',
    'border:1px solid var(--border-default,rgba(127,127,127,.22))',
    'border-radius:16px',
    'background:var(--main-surface-primary,var(--token-main-surface-primary,#fff))',
    'color:var(--text-primary,var(--token-text-primary,#111))',
    'box-shadow:0 16px 42px rgba(0,0,0,.20)',
    'font:inherit',
  ].join(';')

  let view: PanelView = 'home'

  const runAction = async (
    action: () => unknown | Promise<unknown>,
    options: { close?: boolean, rerender?: boolean } = {},
  ) => {
    try {
      await action()
      if (options.close) panel.hidden = true
      if (options.rerender) render()
    }
    catch (error) {
      console.error('[ChatGPT Companion] action failed', error)
      window.alert(`操作失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const makeButton = (
    label: string,
    options: {
      code?: string
      subtitle?: string
      full?: boolean
      primary?: boolean
      onClick: () => void | Promise<void>
    },
  ): HTMLButtonElement => {
    const button = el('button')
    button.type = 'button'
    button.style.cssText = [
      'border:0',
      'border-radius:11px',
      'padding:10px',
      'min-height:48px',
      `background:${options.primary ? 'var(--surface-secondary,rgba(127,127,127,.12))' : 'transparent'}`,
      'color:inherit',
      'font:inherit',
      'text-align:left',
      'cursor:pointer',
      options.full ? 'grid-column:1/-1' : '',
    ].filter(Boolean).join(';')
    button.dataset.baseBackground = options.primary ? 'var(--surface-secondary,rgba(127,127,127,.12))' : 'transparent'
    applyHover(button)

    const row = el('div')
    row.style.cssText = 'display:flex;align-items:center;gap:9px;min-width:0'
    if (options.code) {
      const code = el('span')
      code.textContent = options.code
      code.style.cssText = [
        'display:grid',
        'place-items:center',
        'min-width:30px',
        'height:26px',
        'padding:0 5px',
        'border-radius:8px',
        'background:var(--surface-tertiary,rgba(127,127,127,.12))',
        'font:600 10px ui-monospace,SFMono-Regular,Consolas,monospace',
      ].join(';')
      row.append(code)
    }
    const textWrap = el('span')
    textWrap.style.cssText = 'display:block;min-width:0'
    const main = el('span')
    main.textContent = label
    main.style.cssText = 'display:block;font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis'
    textWrap.append(main)
    if (options.subtitle) {
      const sub = el('span')
      sub.textContent = options.subtitle
      sub.style.cssText = 'display:block;font-size:10px;opacity:.55;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis'
      textWrap.append(sub)
    }
    row.append(textWrap)
    button.append(row)
    button.addEventListener('click', async (event) => {
      event.preventDefault()
      event.stopPropagation()
      await options.onClick()
    })
    return button
  }

  const makeGrid = (): HTMLElement => {
    const grid = el('div')
    grid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:4px'
    return grid
  }

  const makeBackHeader = (title: string, subtitle?: string): HTMLElement => {
    const header = el('div')
    header.style.cssText = 'display:flex;align-items:flex-start;gap:8px;padding:2px 2px 8px'
    const back = el('button')
    back.type = 'button'
    back.textContent = '←'
    back.setAttribute('aria-label', '返回')
    back.style.cssText = 'border:0;background:transparent;color:inherit;font:inherit;font-size:18px;line-height:28px;width:28px;height:28px;border-radius:8px;cursor:pointer'
    applyHover(back)
    back.addEventListener('click', () => {
      view = 'home'
      render()
    })
    const text = el('div')
    const h = el('div')
    h.textContent = title
    h.style.cssText = 'font-size:14px;font-weight:650;line-height:20px'
    text.append(h)
    if (subtitle) {
      const sub = el('div')
      sub.textContent = subtitle
      sub.style.cssText = 'font-size:10px;opacity:.55;line-height:15px;margin-top:1px'
      text.append(sub)
    }
    header.append(back, text)
    return header
  }

  const renderHome = () => {
    const summary = actions.getMonitorSummary()
    const header = el('div')
    header.style.cssText = 'padding:3px 4px 10px'
    const title = el('div')
    title.textContent = 'ChatGPT Companion'
    title.style.cssText = 'font-size:15px;font-weight:700'
    const state = el('div')
    state.textContent = statusSentence(summary)
    state.style.cssText = `font-size:11px;margin-top:3px;opacity:${summary.abnormalCount || summary.suspectedCount ? '1' : '.58'}`
    header.append(title, state)
    panel.append(header)

    panel.append(sectionTitle('导出当前聊天'))
    const exportGrid = makeGrid()
    exportGrid.append(
      makeButton('复制文字', { code: 'TXT', onClick: () => runAction(actions.copyText, { close: true }) }),
      makeButton('截屏', { code: 'PNG', onClick: () => runAction(actions.screenshot, { close: true }) }),
      makeButton('Markdown', { code: 'MD', onClick: () => runAction(actions.exportMarkdown, { close: true }) }),
      makeButton('HTML', { code: 'HTML', onClick: () => runAction(actions.exportHtml, { close: true }) }),
      makeButton('JSON', { code: '{}', onClick: () => { view = 'json'; render() } }),
      makeButton('批量导出', { code: 'ZIP', onClick: () => { view = 'batch'; render() } }),
    )
    panel.append(exportGrid)

    const settings = makeButton('导出设置', {
      code: '⚙',
      full: true,
      subtitle: '推理过程、富媒体附录、批量数量、截图清晰度',
      onClick: () => { view = 'settings'; render() },
    })
    settings.style.marginTop = '4px'
    panel.append(settings, divider(), sectionTitle('运行监控'))

    const monitorCard = el('button')
    monitorCard.type = 'button'
    monitorCard.style.cssText = [
      'width:100%',
      'border:0',
      'border-radius:12px',
      'padding:10px',
      'background:var(--surface-secondary,rgba(127,127,127,.08))',
      'color:inherit',
      'font:inherit',
      'cursor:pointer',
      'text-align:left',
    ].join(';')
    monitorCard.dataset.baseBackground = 'var(--surface-secondary,rgba(127,127,127,.08))'
    applyHover(monitorCard)
    const metrics = el('div')
    metrics.style.cssText = 'display:grid;grid-template-columns:repeat(3,1fr);gap:6px'
    metrics.append(
      metric('运行中', String(summary.activeCount)),
      metric('异常', String(summary.abnormalCount), summary.abnormalCount > 0),
      metric('疑似', String(summary.suspectedCount), summary.suspectedCount > 0),
    )
    const detail = el('div')
    detail.textContent = summary.lastError
      ? `监控暂时不可用：${summary.lastError}`
      : `当前页 ${summary.oaiSandboxCount || summary.iframeCount} 个工具/iframe · 点击查看详情`
    detail.style.cssText = 'font-size:10px;opacity:.58;margin-top:8px;padding:0 2px'
    monitorCard.append(metrics, detail)
    monitorCard.addEventListener('click', () => {
      view = 'monitor'
      render()
    })
    panel.append(monitorCard)
  }

  const renderJson = () => {
    panel.append(makeBackHeader('JSON 导出', '普通归档优先使用“安全归档 JSON”'))
    const grid = makeGrid()
    grid.append(
      makeButton('安全归档 JSON', { code: 'JSON', full: true, primary: true, subtitle: 'Canonical + 富媒体结构；默认不复制敏感工具正文', onClick: () => runAction(actions.exportArchive, { close: true }) }),
      makeButton('原始捕获 JSON', { code: 'RAW', full: true, subtitle: '保留 ChatGPT 原始 conversation payload；体积可能很大', onClick: () => runAction(actions.exportRawJson, { close: true }) }),
      makeButton('富媒体清单', { code: 'META', full: true, subtitle: 'Web Search、App、图片、Widget、文件等结构摘要', onClick: () => runAction(actions.exportManifest, { close: true }) }),
    )
    panel.append(grid)
  }

  const renderBatch = () => {
    const settings = actions.getSettings()
    panel.append(makeBackHeader('批量导出', `最近 ${settings.batchLimit} 条聊天；用户主动读取并打包 ZIP`))
    const note = el('div')
    note.textContent = '批量导出不是被动捕获：只有你点击下面按钮时才会读取最近会话正文，并按顺序打包。'
    note.style.cssText = 'margin:0 4px 8px;padding:9px 10px;border-radius:10px;background:var(--surface-secondary,rgba(127,127,127,.08));font-size:10px;line-height:1.45;opacity:.75'
    panel.append(note)
    const grid = makeGrid()
    grid.append(
      makeButton('Markdown ZIP', { code: 'MD', full: true, primary: true, onClick: () => runAction(() => actions.batchExport('markdown', settings.batchLimit), { close: true }) }),
      makeButton('HTML ZIP', { code: 'HTML', full: true, onClick: () => runAction(() => actions.batchExport('html', settings.batchLimit), { close: true }) }),
      makeButton('JSON ZIP', { code: 'JSON', full: true, onClick: () => runAction(() => actions.batchExport('json', settings.batchLimit), { close: true }) }),
    )
    panel.append(grid)
  }

  const renderSettings = () => {
    const settings = actions.getSettings()
    panel.append(makeBackHeader('导出设置'))

    const toggle = (label: string, description: string, checked: boolean, onChange: (checked: boolean) => void) => {
      const row = el('label')
      row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:9px 6px;cursor:pointer'
      const input = document.createElement('input')
      input.type = 'checkbox'
      input.checked = checked
      input.addEventListener('change', () => onChange(input.checked))
      const text = el('span')
      const main = el('span')
      main.textContent = label
      main.style.cssText = 'display:block;font-size:12px;font-weight:500'
      const sub = el('span')
      sub.textContent = description
      sub.style.cssText = 'display:block;font-size:10px;opacity:.55;margin-top:2px;line-height:1.35'
      text.append(main, sub)
      row.append(input, text)
      return row
    }

    panel.append(
      toggle('包含推理过程', '默认关闭；开启后 Markdown / HTML / 复制文字会包含 reasoning 节点。', settings.includeReasoning, checked => void runAction(() => actions.updateSettings({ includeReasoning: checked }), { rerender: true })),
      toggle('Markdown 富媒体附录', '在 Markdown 末尾加入 Web Search / App / Widget / 文件等结构摘要。', settings.includeRichAppendix, checked => void runAction(() => actions.updateSettings({ includeRichAppendix: checked }), { rerender: true })),
      divider(),
    )

    const selectRow = <T extends string | number>(label: string, value: T, values: Array<{ value: T, label: string }>, onChange: (value: T) => void) => {
      const row = el('label')
      row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 6px;font-size:12px'
      const caption = el('span')
      caption.textContent = label
      const select = document.createElement('select')
      select.style.cssText = 'border:1px solid var(--border-default,rgba(127,127,127,.22));border-radius:8px;background:transparent;color:inherit;padding:5px 7px;font:inherit'
      for (const option of values) {
        const node = document.createElement('option')
        node.value = String(option.value)
        node.textContent = option.label
        node.selected = option.value === value
        select.append(node)
      }
      select.addEventListener('change', () => {
        const found = values.find(item => String(item.value) === select.value)
        if (found) onChange(found.value)
      })
      row.append(caption, select)
      return row
    }

    panel.append(
      selectRow('批量导出数量', settings.batchLimit, [5, 10, 20, 28].map(value => ({ value: value as 5 | 10 | 20 | 28, label: `最近 ${value} 条` })), value => void runAction(() => actions.updateSettings({ batchLimit: value }), { rerender: true })),
      selectRow('截图清晰度', settings.screenshotScale, [1, 1.5, 2].map(value => ({ value: value as 1 | 1.5 | 2, label: `${value}×` })), value => void runAction(() => actions.updateSettings({ screenshotScale: value }), { rerender: true })),
    )
  }

  const renderMonitor = () => {
    const summary = actions.getMonitorSummary()
    panel.append(makeBackHeader('运行监控', statusSentence(summary)))
    const metrics = el('div')
    metrics.style.cssText = 'display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin:2px 2px 10px'
    metrics.append(
      metric('运行中', String(summary.activeCount)),
      metric('异常', String(summary.abnormalCount), summary.abnormalCount > 0),
      metric('疑似', String(summary.suspectedCount), summary.suspectedCount > 0),
    )
    panel.append(metrics)

    const facts = el('div')
    facts.style.cssText = 'padding:9px 10px;border-radius:11px;background:var(--surface-secondary,rgba(127,127,127,.08));font-size:10px;line-height:1.55;margin-bottom:6px'
    facts.textContent = [
      `Fleet：${summary.leaderRole}`,
      `当前页：${summary.pageSeverity} · iframe ${summary.iframeCount} · OAI sandbox ${summary.oaiSandboxCount}`,
      summary.usedJsHeapMb == null ? '' : `JS heap：${summary.usedJsHeapMb} MB`,
      summary.latestAlertTitle ? `最近告警：${summary.latestAlertTitle}` : '',
      summary.lastError ? `错误：${summary.lastError}` : '',
    ].filter(Boolean).join('\n')
    facts.style.whiteSpace = 'pre-line'
    panel.append(facts)

    const grid = makeGrid()
    grid.append(
      makeButton('立即刷新', { code: '↻', onClick: () => runAction(actions.pollFleetNow, { rerender: true }) }),
      makeButton('打开最近告警', { code: '!', onClick: () => runAction(actions.openLatestAbnormal) }),
      makeButton('桌面通知', { code: '🔔', onClick: () => runAction(actions.enableNotifications) }),
      makeButton('高级诊断', { code: '…', onClick: () => { view = 'advanced'; render() } }),
    )
    panel.append(grid)
  }

  const renderAdvanced = () => {
    panel.append(makeBackHeader('高级诊断', '普通使用通常不需要进入这里'))
    const grid = makeGrid()
    grid.append(
      makeButton('检查服务器状态', { code: 'NET', full: true, onClick: () => runAction(actions.checkServerStatus) }),
      makeButton('当前页性能诊断', { code: 'PERF', full: true, onClick: () => runAction(actions.inspectRun) }),
      makeButton('复制安全续跑提示', { code: 'CONT', full: true, onClick: () => runAction(actions.copySafeContinue) }),
      makeButton('导出当前页诊断 JSON', { code: 'RUN', full: true, onClick: () => runAction(actions.exportRunDiagnostics, { close: true }) }),
      makeButton('导出全局监控 JSON', { code: 'FLEET', full: true, onClick: () => runAction(actions.exportFleetDiagnostics, { close: true }) }),
      makeButton('查看原始 Fleet 摘要', { code: 'RAW', full: true, onClick: () => runAction(actions.inspectFleet) }),
    )
    panel.append(grid)
  }

  function render(): void {
    panel.replaceChildren()
    if (view === 'home') renderHome()
    else if (view === 'json') renderJson()
    else if (view === 'batch') renderBatch()
    else if (view === 'settings') renderSettings()
    else if (view === 'monitor') renderMonitor()
    else renderAdvanced()
  }

  // sidebar 切换或 React 重建时 panel 自身仍挂在 documentElement；每次重新打开时主视图刷新状态。
  Object.defineProperty(panel, '__companionRenderHome', {
    configurable: true,
    value: () => {
      view = 'home'
      render()
    },
  })

  render()
  document.documentElement.append(panel)
  return panel
}

export function resetCompanionPanel(panel: HTMLElement): void {
  const reset = (panel as HTMLElement & { __companionRenderHome?: () => void }).__companionRenderHome
  reset?.()
}
