import { defineConfig } from 'vite'
import monkey from 'vite-plugin-monkey'

/**
 * Userscript 版本故意使用 `@grant none`：脚本直接处于页面环境，才能在 document-start
 * 包装页面自己的 fetch/XHR；同时我们也完全不需要 GM_xmlhttpRequest 等额外网络能力。
 */
export default defineConfig({
  plugins: [
    monkey({
      entry: 'src/userscript.ts',
      userscript: {
        name: 'ChatGPT Passive Exporter',
        namespace: 'https://github.com/ZJHSteven/chatgpt-passive-exporter',
        description: '被动捕获 ChatGPT 页面自身会话响应并导出，不主动调用私有 conversation API。',
        match: ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
        'run-at': 'document-start',
        grant: 'none',
      },
      build: {
        fileName: 'chatgpt-passive-exporter.user.js',
        metaFileName: true,
      },
    }),
  ],
})
