import { describe, expect, test } from 'vitest'
import { buildBarkIncidentRequest, sendIncidentNotification } from '../src/local/incident-notifier.ts'

describe('incident notifier', () => {
  test('Bark V2 使用 POST /push JSON，device key 与正文不进入 URL', () => {
    const request = buildBarkIncidentRequest({
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

    expect(request.url.toString()).toBe('https://api.day.app/push')
    expect(request.init.method).toBe('POST')
    const body = JSON.parse(String(request.init.body))
    expect(body).toEqual({
      device_key: 'device token/with slash',
      title: 'ChatGPT 异常结束',
      body: '工具调用没有 final / 请检查',
      group: 'ChatGPT Archive',
      url: 'https://chatgpt.com/c/conversation-1',
    })
    expect(request.url.toString()).not.toContain('device')
  })

  test('单条通知可以覆盖默认 Bark group，供 DevSpace Bug 独立分组', () => {
    const request = buildBarkIncidentRequest({
      provider: 'bark',
      enabled: true,
      baseUrl: 'https://api.day.app',
      deviceToken: 'device',
      group: 'ChatGPT Archive',
    }, {
      title: 'DevSpace idle',
      body: 'soft warning',
      group: 'DevSpace Bug',
    })
    expect(JSON.parse(String(request.init.body)).group).toBe('DevSpace Bug')
  })

  test('未配置通知时完全不发网络请求', async () => {
    await expect(sendIncidentNotification(null, { title: 'x', body: 'y' })).resolves.toEqual({
      attempted: false,
      ok: false,
      status: null,
      error: null,
    })
  })

  test('瞬时 503 会轻量重试一次，随后成功', async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      return new Response('', { status: calls === 1 ? 503 : 200 })
    }) as typeof fetch
    const result = await sendIncidentNotification({
      provider: 'bark', enabled: true, baseUrl: 'https://api.day.app', deviceToken: 'secret',
    }, { title: 'x', body: 'y' }, { fetchImpl, retryDelayMs: 0 })

    expect(calls).toBe(2)
    expect(result).toMatchObject({ attempted: true, ok: true, status: 200, error: null })
  })
})
