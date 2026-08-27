import { isConversationPayload } from './adapter'
import type { PassiveCaptureEnvelope } from './types'

export type CaptureEmitter = (envelope: PassiveCaptureEnvelope) => void

/**
 * 只允许捕获“单个 conversation 正文”路由。
 *
 * deliberately 不匹配 `/backend-api/conversations?offset=...` 这类会话列表，也不匹配
 * session/account/auth 接口。这样即使页面上还有其他 fetch，也不会把账户资料、token、
 * feature flag 等内容送进导出器。
 */
export function isAllowedConversationUrl(input: string, base = location.href): boolean {
  try {
    const url = new URL(input, base)
    if (url.origin !== location.origin) return false

    return /^\/backend-api\/conversation\/[^/]+\/?$/u.test(url.pathname)
      || /^\/backend-api\/conversations\/[^/]+\/?$/u.test(url.pathname)
  }
  catch {
    return false
  }
}

async function inspectFetchResponse(response: Response, url: string, emit: CaptureEmitter): Promise<void> {
  if (!response.ok || !isAllowedConversationUrl(url)) return

  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().includes('json')) return

  try {
    // clone() 保证我们消费的是副本，不改变 ChatGPT 页面随后读取原 Response 的行为。
    const payload: unknown = await response.clone().json()
    if (!isConversationPayload(payload)) return
    emit({
      protocol: 'chatgpt-passive-exporter/v1',
      capturedAt: Date.now(),
      url,
      transport: 'fetch',
      payload,
    })
  }
  catch {
    // 捕获器属于“旁路观察者”：解析失败只能丢失一次导出机会，绝不能让正常网页请求失败。
  }
}

/**
 * 安装被动捕获器，并返回 restore 函数用于测试/HMR/卸载。
 *
 * 重要安全边界：
 * - 不读取 Request.headers / cookies / Authorization；
 * - 不发出新的网络请求；
 * - 不修改响应；
 * - 只观察同源 conversation JSON。
 */
export function installPassiveCapture(emit: CaptureEmitter): () => void {
  const nativeFetch = window.fetch
  const nativeXhrOpen = XMLHttpRequest.prototype.open
  const nativeXhrSend = XMLHttpRequest.prototype.send
  const xhrUrls = new WeakMap<XMLHttpRequest, string>()

  window.fetch = function passiveExporterFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const requestUrl = input instanceof Request ? input.url : String(input)
    const promise = nativeFetch.call(this, input, init)

    // 不 await：网页拿到 response 的时间不依赖我们的 JSON 解析速度。
    void promise.then(response => inspectFetchResponse(response, requestUrl, emit))
    return promise
  }

  XMLHttpRequest.prototype.open = function passiveExporterOpen(
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null,
  ): void {
    xhrUrls.set(this, String(url))
    nativeXhrOpen.call(this, method, url, async ?? true, username ?? null, password ?? null)
  }

  XMLHttpRequest.prototype.send = function passiveExporterSend(body?: Document | XMLHttpRequestBodyInit | null): void {
    const xhr = this
    const url = xhrUrls.get(xhr)

    if (url && isAllowedConversationUrl(url)) {
      const onLoadEnd = (): void => {
        xhr.removeEventListener('loadend', onLoadEnd)
        if (xhr.status < 200 || xhr.status >= 300) return

        try {
          // `responseType=json` 可直接读 response；默认文本模式再 JSON.parse。
          const payload: unknown = xhr.responseType === 'json'
            ? xhr.response
            : JSON.parse(xhr.responseText)
          if (!isConversationPayload(payload)) return

          emit({
            protocol: 'chatgpt-passive-exporter/v1',
            capturedAt: Date.now(),
            url,
            transport: 'xhr',
            payload,
          })
        }
        catch {
          // 与 fetch 相同，任何旁路失败都静默放弃，不污染页面。
        }
      }
      xhr.addEventListener('loadend', onLoadEnd)
    }

    nativeXhrSend.call(xhr, body)
  }

  return () => {
    window.fetch = nativeFetch
    XMLHttpRequest.prototype.open = nativeXhrOpen
    XMLHttpRequest.prototype.send = nativeXhrSend
  }
}
