import { describe, expect, test } from 'vitest'
import { inputActorPromptWithFeedback, type ActorComposerController } from '../src/local/actor-composer-integrity.ts'

/**
 * 内存里的简化 ProseMirror：模拟旧草稿、选区、焦点丢失和 CDP 命令 ACK 超时。
 * 每个场景都不连接真正的 ChatGPT，也不会点击发送按钮。
 */
function composerHarness(options: {
  oldDraft?: string
  timeoutAfterInsert?: boolean
  corruptOnPass?: number
  alwaysCorrupt?: boolean
} = {}) {
  let text = options.oldDraft ?? ''
  let selectAll = false
  let focused = false
  let pass = 0
  let inserts = 0
  let recoveries = 0
  const actions: ActorComposerController = {
    async selectAll() {
      pass++
      selectAll = true
      focused = true
      return true
    },
    async focusAtEnd() {
      focused = true
      selectAll = false
      return true
    },
    async insertText(value) {
      inserts++
      if (!focused) throw new Error('lost-focus')
      text = selectAll ? value : text + value
      selectAll = false
      // 指令返回成功不等于文本完整；模拟 React 重挂载导致本块没有进入编辑器。
      if ((options.alwaysCorrupt || options.corruptOnPass === pass) && inserts % 2 === 1) {
        text = text.slice(0, Math.max(0, text.length - 3))
      }
      focused = false // 隐藏标签页在下一轮可能丢失焦点
      if (options.timeoutAfterInsert) throw new Error('CDP Input.insertText timeout after 10000ms')
    },
    async readText() { return text },
    async settle() {},
    async recoverBeforeRewrite() { recoveries++ },
  }
  return { actions, info: () => ({ text, pass, inserts, recoveries }) }
}

describe('Actor composer 逐块闭环', () => {
  test('长中文、换行与 emoji 必须分块写入且最终原样一致', async () => {
    const text = `${'呼吸系统病例：血氧、肺泡、炎症🩺。'.repeat(99)}\n\n${'第二节课堂记录。'.repeat(77)}`
    const fake = composerHarness({ oldDraft: '另一个课堂残留的 3109 字节草稿' })
    const result = await inputActorPromptWithFeedback(text, 128, fake.actions)
    expect(result.inputChunks).toBeGreaterThan(10)
    expect(result.rewritePasses).toBe(1)
    expect(fake.info().text).toBe(text)
    expect(fake.info().recoveries).toBe(0)
  })

  test('CDP 超时但文字实际已到达时不能盲目重发造成重复', async () => {
    const text = '医学统计学\n'.repeat(133)
    const fake = composerHarness({ timeoutAfterInsert: true })
    const result = await inputActorPromptWithFeedback(text, 128, fake.actions)
    expect(result.rewritePasses).toBe(1)
    expect(result.acknowledgedTimeouts).toBe(result.inputChunks)
    expect(fake.info().inserts).toBe(result.inputChunks)
    expect(fake.info().text).toBe(text)
  })

  test('首遍写入出现损坏，应全选覆盖重建一次并逐块重新校验', async () => {
    const text = '流行病学的实验设计与研究偏倚。'.repeat(100)
    const fake = composerHarness({ oldDraft: '摘要旧草稿', corruptOnPass: 1 })
    const result = await inputActorPromptWithFeedback(text, 128, fake.actions)
    expect(result.rewritePasses).toBe(2)
    expect(fake.info().recoveries).toBe(1)
    expect(fake.info().text).toBe(text)
  })

  test('两次重建都不一致必须在正式 POST 之前终止', async () => {
    const fake = composerHarness({ alwaysCorrupt: true })
    await expect(inputActorPromptWithFeedback('临床诊断学。'.repeat(120), 128, fake.actions))
      .rejects.toThrow(/before POST after two bounded rewrite passes/)
    expect(fake.info().recoveries).toBe(1)
    expect(fake.info().pass).toBe(2)
  })

  test('输入块大小和回车规范化不允许造成静默截断', async () => {
    const fake = composerHarness()
    await expect(inputActorPromptWithFeedback('a', 63, fake.actions)).rejects.toThrow(/64 and 2048/)
    const result = await inputActorPromptWithFeedback('第一行\r\n第二行\r第三行', 64, fake.actions)
    expect(result.inputCharacters).toBe(11)
    expect(fake.info().text).toBe('第一行\n第二行\n第三行')
  })
})
