import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'
import { test, expect } from 'vitest'

test('CDP composer read expression stays valid JavaScript after template literal interpolation', () => {
  // Actor source contains a JavaScript expression string evaluated inside Chromium.
  // A plain TypeScript typecheck cannot catch accidentally unescaped \r / \n inside
  // that template string: it parses in Node but is invalid once sent over CDP.
  // Windows checkout 采用 CRLF；先标准化换行后提取模板源码，避免测试本身误报。
  const source = readFileSync(new URL('../src/local/chatgpt-actor.ts', import.meta.url), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\r\n/g, '\n')
  const marker = 'const editorExpression = `'
  const start = source.indexOf(marker)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = source.indexOf('`\n  const position', start)
  expect(end).toBeGreaterThan(start)
  const content = source.slice(start + marker.length, end)
  const expression = new Function(`return \`${content}\``)() as string
  expect(() => new Script(expression)).not.toThrow()
})
