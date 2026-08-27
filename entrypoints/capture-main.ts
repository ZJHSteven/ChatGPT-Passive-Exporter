import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script'
import { installPassiveCapture } from '../src/core/passive-capture'

/**
 * 真正运行在 ChatGPT 页面 MAIN world 的极薄 hook。
 *
 * 它唯一做的事是：监听页面本来就会发生的 fetch/XHR，把 conversation response 的副本
 * 通过“当前注入 script 元素上的 CustomEvent”交给 isolated content script。
 * 这里不能调用任何 extension API，也不需要知道浏览器是 Chrome/Firefox/Edge。
 */
export default defineUnlistedScript(() => {
  const script = document.currentScript as HTMLScriptElement | null
  const eventName = script?.dataset.passiveExporterEvent
  if (!script || !eventName) return

  installPassiveCapture((envelope) => {
    script.dispatchEvent(new CustomEvent(eventName, { detail: envelope }))
  })
})
