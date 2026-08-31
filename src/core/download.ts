/** 浏览器端下载工具；扩展 content script 与 userscript 共用。 */

// Blob URL 在下载真正交给浏览器前不应被主动 revoke。之前 30 秒定时 revoke 虽然看似
// “清理得更干净”，但对慢磁盘/下载拦截器/浏览器安全检查没有任何收益，反而多一个竞态。
// 这里沿用成熟 ChatGPT Exporter 的做法：下载期间保持 URL 有效，只在页面卸载时统一清理。
const liveObjectUrls = new Set<string>()
let cleanupInstalled = false

function keepObjectUrlUntilUnload(url: string): void {
  liveObjectUrls.add(url)
  if (cleanupInstalled) return
  cleanupInstalled = true
  window.addEventListener('pagehide', () => {
    for (const item of liveObjectUrls) URL.revokeObjectURL(item)
    liveObjectUrls.clear()
  }, { once: true })
}

export function safeFilename(input: string): string {
  const cleaned = input
    .replace(/[<>:"/\\|?*\u0000-\u001F]/gu, '_')
    .replace(/[. ]+$/u, '')
    .trim()
  return cleaned || 'ChatGPT Conversation'
}

export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  keepObjectUrlUntilUnload(url)

  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = safeFilename(filename)
  anchor.style.display = 'none'

  // 与 ChatGPT Exporter 2.34.1 的长期稳定路径保持一致：挂到 body 再 click。
  // body 在真实页面交互阶段已经存在；若极早调用，才退回 documentElement。
  const host = document.body ?? document.documentElement
  host.append(anchor)
  anchor.click()
  anchor.remove()
}

export function downloadText(filename: string, text: string, mime = 'text/plain;charset=utf-8'): void {
  downloadBlob(filename, new Blob([text], { type: mime }))
}
