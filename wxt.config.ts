import { defineConfig } from 'wxt'

/**
 * WXT 同一份源码分别构建 Chrome / Edge / Firefox。
 *
 * 权限刻意保持最小：不申请 debugger、webRequest、cookies、storage。
 * conversation body 是由 ChatGPT 页面自己拿到后，经 MAIN-world hook 被动复制给 content script。
 */
export default defineConfig({
  manifest: {
    name: 'ChatGPT Passive Exporter',
    description: '被动捕获 ChatGPT 页面自身会话响应，导出 Markdown 与安全 JSON 归档。',
    permissions: [],
    action: {
      default_title: '导出当前 ChatGPT 对话',
    },
    web_accessible_resources: [
      {
        resources: ['capture-main.js'],
        matches: ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
      },
    ],
  },
})
