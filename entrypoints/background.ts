import { browser } from 'wxt/browser'
import { defineBackground } from 'wxt/utils/define-background'

/**
 * 工具栏按钮只是“触发器”；所有捕获和文件生成都发生在当前 ChatGPT 页的 content script。
 * 因此 background 不需要 host permission，也不会自己访问 chatgpt.com。
 */
export default defineBackground(() => {
  browser.action.onClicked.addListener(async (tab) => {
    if (tab.id == null) return

    try {
      await browser.tabs.sendMessage(tab.id, {
        type: 'chatgpt-passive-exporter/export-current',
      })
    }
    catch (error) {
      console.warn('[ChatGPT Passive Exporter] current tab has no exporter content script', error)
    }
  })
})
