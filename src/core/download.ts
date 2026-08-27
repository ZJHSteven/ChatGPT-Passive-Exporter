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

  // 下载并不一定在 anchor.click() 返回后立刻完成。ChatGPT/CDP 测试里 72KB Blob
  // 在 1 秒时 revoke 会出现“已收满字节但最终 canceled”的竞态；保守留 30 秒。
  // 这是一次性对象 URL，几十秒的额外生命周期对内存影响可以忽略。
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
}
