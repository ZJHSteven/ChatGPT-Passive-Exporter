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
        name: 'ChatGPT Companion',
        namespace: 'https://github.com/ZJHSteven/chatgpt-passive-exporter',
        description: '统一的 ChatGPT 本地伴侣：被动归档、Run Watch、Fleet Watch、异常通知与本地同步入口。',
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
