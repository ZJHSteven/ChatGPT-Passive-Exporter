/** 浏览器端最小下载工具；扩展 content script 与 userscript 共用。 */

export function safeFilename(input: string): string {
  const cleaned = input
    .replace(/[<>:"/\\|?*\u0000-\u001F]/gu, '_')
    .replace(/[. ]+$/u, '')
    .trim()
  return cleaned || 'ChatGPT Conversation'
}

export function downloadText(filename: string, text: string, mime = 'text/plain;charset=utf-8'): void {
  const blob = new Blob([text], { type: mime })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = safeFilename(filename)
  anchor.style.display = 'none'
  document.documentElement.append(anchor)
  anchor.click()
  anchor.remove()

  // 撤销太早会让 Firefox 偶发拿不到 Blob；延后到当前事件循环结束之后。
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
}
