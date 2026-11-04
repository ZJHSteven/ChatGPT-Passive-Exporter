import { runInNewContext, Script } from 'node:vm'
import { describe, expect, test } from 'vitest'
import { ACTOR_VISIBLE_COMPOSER_EXPRESSION } from '../src/local/actor-composer-target.ts'

/**
 * 真实 ChatGPT 项目页曾在同一时刻生成两份 contenteditable：
 * 第一份 0×0、隐藏且有 2049 字符旧草稿；第二份 699×1170 才能获得焦点。
 * 本测试专门防止未来有人重新用 querySelector() 选择第一个编辑器。
 */
class MockHTMLElement {
  isConnected = true
  hidden = false
  parentElement: MockHTMLElement | null = null
  constructor(readonly width: number, readonly height: number, readonly pointerEvents = 'auto') {}
  getBoundingClientRect() { return { width: this.width, height: this.height } }
  closest(selector: string) { return selector === 'form[data-chatgpt-composer]' ? this : null }
  hasAttribute() { return false }
}

function select(elements: MockHTMLElement[]) {
  const root = new MockHTMLElement(1000, 1000)
  for (const element of elements) element.parentElement = root
  const context = {
    HTMLElement: MockHTMLElement,
    document: {
      documentElement: root,
      querySelectorAll(selector: string) {
        return selector.includes('[contenteditable=') ? elements : []
      },
    },
    window: {
      getComputedStyle(element: MockHTMLElement) {
        return {
          display: 'block', visibility: 'visible', opacity: '1',
          pointerEvents: element.pointerEvents,
        }
      },
    },
  }
  return runInNewContext(ACTOR_VISIBLE_COMPOSER_EXPRESSION, context)
}

describe('Actor editor target detection', () => {
  test('浏览器内部选择表达式必须能独立编译为合法 JavaScript', () => {
    expect(() => new Script(ACTOR_VISIBLE_COMPOSER_EXPRESSION)).not.toThrow()
  })

  test('跳过隐藏旧草稿的 0×0 编辑器，选择真正可见的第二个编辑器', () => {
    const ghost = new MockHTMLElement(0, 0)
    const visible = new MockHTMLElement(699, 1170)
    expect(select([ghost, visible])).toBe(visible)
  })

  test('不可交互的遮罩候选不允许参与输入；没有可见编辑器时返回空', () => {
    const ghost = new MockHTMLElement(0, 0)
    const blocked = new MockHTMLElement(699, 1170, 'none')
    const visible = new MockHTMLElement(700, 120)
    expect(select([ghost, blocked, visible])).toBe(visible)
    expect(select([ghost, blocked])).toBeNull()
  })
})
