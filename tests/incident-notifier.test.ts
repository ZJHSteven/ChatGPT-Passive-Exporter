import { describe, expect, test } from 'vitest'
import { buildBarkIncidentUrl, sendIncidentNotification } from '../src/local/incident-notifier.ts'

describe('incident notifier', () => {
  test('Bark URL 对标题、正文、分组和点击地址做安全编码', () => {
    const url = buildBarkIncidentUrl({
      provider: 'bark',
      enabled: true,
      baseUrl: 'https://api.day.app/',
      deviceToken: 'device token/with slash',
      group: 'ChatGPT Archive',
    }, {
      title: 'ChatGPT 异常结束',
      body: '工具调用没有 final / 请检查',
      url: 'https://chatgpt.com/c/conversation-1',
    })

    expect(url.origin).toBe('https://api.day.app')
    expect(decodeURIComponent(url.pathname)).toBe('/device token/with slash/ChatGPT 异常结束/工具调用没有 final / 请检查')
    expect(url.searchParams.get('group')).toBe('ChatGPT Archive')
    expect(url.searchParams.get('url')).toBe('https://chatgpt.com/c/conversation-1')
  })

  test('未配置通知时完全不发网络请求', async () => {
    await expect(sendIncidentNotification(null, { title: 'x', body: 'y' })).resolves.toEqual({
      attempted: false,
      ok: false,
      status: null,
      error: null,
    })
  })
})
