/**
 * Browser Runtime.evaluate 里统一使用的「当前可操作编辑器」表达式。
 *
 * ChatGPT 2026 的项目聊天可能同时保留两个 data-chatgpt-composer 表单：
 * 一个是 0×0 像素、保存旧草稿的离屏编辑器；另一个才是用户真正看到的编辑器。
 * querySelector() 和 find(closest(form)) 会选到前者，导致 CDP 以为已经选中了
 * 正文，实际上焦点无法建立、字符被追加到旧草稿、最终内容出现 513→2049 等异常。
 *
 * 所有「清空、读回、选区、稳定性判断」必须使用同一份可见性筛选逻辑。
 * String.raw 是必要的：浏览器 JavaScript 表达式不能被 TypeScript 模板字符串
 * 把反斜线转义成无效代码。
 */
export const ACTOR_VISIBLE_COMPOSER_EXPRESSION = String.raw`(() => {
  const elements = [
    ...document.querySelectorAll('form[data-chatgpt-composer] #prompt-textarea'),
    ...document.querySelectorAll('form[data-chatgpt-composer] [contenteditable="true"][role="textbox"]'),
    ...document.querySelectorAll('form[data-chatgpt-composer] textarea'),
  ]
  return elements.find(element => {
    if (!element || !element.isConnected) return false
    const box = element.getBoundingClientRect()
    if (box.width < 1 || box.height < 1) return false
    // 只判断编辑器本身是否接受指针事件。某些项目页面在外层容器上设置
    // pointer-events:none，但可见子编辑器重新指定 auto，仍然能够通过键盘使用。
    // 若把祖先的 pointer-events:none 也当作阻断，会误判真实输入框不存在。
    if (window.getComputedStyle(element).pointerEvents === 'none') return false
    for (let node = element; node; node = node.parentElement) {
      if (!(node instanceof HTMLElement)) continue
      if (node.hidden || node.hasAttribute('inert')) return false
      const style = window.getComputedStyle(node)
      if (style.display === 'none'
        || style.visibility === 'hidden'
        || style.visibility === 'collapse'
        || Number.parseFloat(style.opacity || '1') <= 0.01) return false
      if (node === document.documentElement) break
    }
    return Boolean(element.closest('form[data-chatgpt-composer]'))
  }) || null
})()`
