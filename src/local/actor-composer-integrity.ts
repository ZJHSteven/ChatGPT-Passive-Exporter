/**
 * ChatGPT ProseMirror 文本输入闭环。
 *
 * CDP 的 Input.insertText 成功 ACK 只能证明浏览器收到命令，不能证明 React 编辑器
 * 最终保留了字符。反过来，命令超时也不能证明没有输入成功；直接重发该块会造成重复。
 * 因此本控制器每写入一个 Unicode 字符块，就读取真实编辑器并验证到目前为止的全文。
 *
 * 在第一次发生失焦、丢字、重复或恢复旧草稿时，仅允许一次从头覆盖式重建。
 * 任何一次重建都先「全选」现有编辑器，而非在旧内容后追加；第二次仍不一致则
 * 在真正的 POST 之前停止。它不会发起网络提交，也不调用后端重试队列。
 */
export interface ActorComposerController {
  selectAll(): Promise<boolean>
  focusAtEnd(): Promise<boolean>
  insertText(text: string): Promise<void>
  readText(): Promise<string | null>
  settle(afterFirstChunk: boolean): Promise<void>
  recoverBeforeRewrite(): Promise<void>
}

export interface ActorComposerResult {
  inputChunks: number
  inputCharacters: number
  inputElapsedMs: number
  rewritePasses: number
  acknowledgedTimeouts: number
}

export async function inputActorPromptWithFeedback(
  prompt: string,
  chunkSize: number,
  controller: ActorComposerController,
): Promise<ActorComposerResult> {
  if (!Number.isInteger(chunkSize) || chunkSize < 64 || chunkSize > 2048) {
    throw new Error('actor inputChunkChars must be between 64 and 2048 Unicode characters')
  }
  const normalized = prompt.replace(/\r\n?/gu, '\n')
  const characters = Array.from(normalized)
  const chunks = Math.ceil(characters.length / chunkSize)
  const started = Date.now()
  let acknowledgedTimeouts = 0
  let lastMismatch = ''

  for (let pass = 1; pass <= 2; pass++) {
    if (pass > 1) await controller.recoverBeforeRewrite()
    if (!(await controller.selectAll())) {
      throw new Error('CDP actor could not select all composer content before replacing input')
    }
    let failed = false
    for (let offset = 0; offset < characters.length; offset += chunkSize) {
      if (offset > 0 && !(await controller.focusAtEnd())) {
        lastMismatch = `composer caret positioning failed at Unicode offset ${offset}`
        failed = true
        break
      }

      const chunk = characters.slice(offset, offset + chunkSize).join('')
      // ACK 超时与 DOM 实际内容应分别判断：只有观察到正确前缀，才认为本块成功。
      let commandError: string | null = null
      try { await controller.insertText(chunk) }
      catch (error) { commandError = error instanceof Error ? error.message : String(error) }
      await controller.settle(offset === 0)

      const expected = characters.slice(0, offset + chunkSize).join('')
      let actual = await controller.readText()
      if (actual !== expected) {
        // React 的后台事件处理可能比 CDP ACK 晚：再观察一次，不能马上重发原块。
        await controller.settle(false)
        actual = await controller.readText()
      }
      if (actual !== expected) {
        const observed = actual ?? ''
        let firstMismatch = 0
        while (firstMismatch < expected.length && firstMismatch < observed.length
          && expected[firstMismatch] === observed[firstMismatch]) firstMismatch++
        lastMismatch = `chunk ${Math.floor(offset / chunkSize) + 1}/${chunks}, `
          + `expectedChars=${expected.length}, actualChars=${observed.length}, `
          + `firstMismatch=${firstMismatch}${commandError ? `, CDP=${commandError}` : ''}`
        failed = true
        break
      }
      if (commandError) acknowledgedTimeouts++
    }

    // 每块验证通过后，再核对最终真实全文；异步恢复旧草稿也会被挡在 POST 前。
    if (!failed) {
      await controller.settle(false)
      const final = await controller.readText()
      if (final === normalized) {
        return {
          inputChunks: chunks,
          inputCharacters: characters.length,
          inputElapsedMs: Date.now() - started,
          rewritePasses: pass,
          acknowledgedTimeouts,
        }
      }
      lastMismatch = `final composer changed after all chunks; expectedChars=${normalized.length}, actualChars=${final?.length ?? 0}`
    }
  }

  throw new Error(`CDP input verification failed before POST after two bounded rewrite passes: ${lastMismatch}`)
}
