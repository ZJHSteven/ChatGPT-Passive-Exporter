import fs from 'node:fs/promises'

export const BARK_NOTIFICATION_GROUPS = {
  chatLatency: 'Chat-Latency',
  chatTimeout: 'Chat-Timeout',
  chatDone: 'Chat-Done',
  incident: 'Incident',
  archiveWarning: 'Archive-Warning',
  liveOps: 'LiveOps',
  infra: 'Infra',
} as const

/**
 * ChatGPT Archive 的本地事故通知配置。
 *
 * 设计目标：
 * 1. token 只存在用户本机，不进入 Git；
 * 2. 通知只是 incident ledger 的“传输层”，发送失败绝不能影响归档/同步；
 * 3. 先只实现现有 Bark 基础设施，未来真有多设备/多渠道需求时再抽象 Worker，避免过早设计。
 */
export interface BarkIncidentNotificationConfig {
  provider: 'bark'
  enabled: boolean
  /** Bark 服务根地址；官方服务通常是 https://api.day.app。 */
  baseUrl: string
  /** Bark App 当前设备 token。属于本地 secret，禁止提交。 */
  deviceToken: string
  /** Bark 通知分组，便于 iPhone 通知中心归类。 */
  group?: string
}

export interface IncidentNotification {
  title: string
  body: string
  /** 点击 Bark 通知后打开的地址；通常指向对应 ChatGPT conversation。 */
  url?: string
  /** 单条通知可覆盖默认分组；用于把软 Bug 提醒与 Archive incident 分开。 */
  group?: string
}

export interface IncidentNotificationResult {
  attempted: boolean
  ok: boolean
  status: number | null
  error: string | null
}

export interface IncidentNotificationSendOptions {
  /** 测试可注入 fetch；生产默认使用 Node 全局 fetch。 */
  fetchImpl?: typeof fetch
  /** 单次请求硬超时；通知不能长期阻塞 Archive 主循环。 */
  timeoutMs?: number
  /** 总尝试次数。默认 2：首次 + 一次瞬时故障重试。 */
  maxAttempts?: number
  /** 两次尝试之间的短退避。 */
  retryDelayMs?: number
}

/**
 * 读取本地通知配置。
 *
 * 文件不存在等价于“通知未配置”，不是错误；这样新安装机器不需要 Bark 也能正常运行 Archive Core。
 * 配置存在但字段不完整时抛错，避免用户以为已经启用通知、实际上静默失效。
 */
export async function loadIncidentNotificationConfig(filePath: string): Promise<BarkIncidentNotificationConfig | null> {
  let text: string
  try {
    text = await fs.readFile(filePath, 'utf8')
  }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return null
    throw error
  }

  const raw = JSON.parse(text) as Partial<BarkIncidentNotificationConfig>
  if (raw.enabled === false) return null
  if (raw.provider !== 'bark') throw new Error('incident notification provider currently only supports "bark"')
  if (typeof raw.baseUrl !== 'string' || !raw.baseUrl.trim()) throw new Error('Bark notification config missing baseUrl')
  if (typeof raw.deviceToken !== 'string' || !raw.deviceToken.trim()) throw new Error('Bark notification config missing deviceToken')

  return {
    provider: 'bark',
    enabled: true,
    baseUrl: raw.baseUrl.trim().replace(/\/+$/u, ''),
    deviceToken: raw.deviceToken.trim(),
    group: typeof raw.group === 'string' && raw.group.trim() ? raw.group.trim() : 'ChatGPT Archive',
  }
}

/**
 * 构造 Bark V2 JSON 请求。
 *
 * Bark 仍兼容旧 GET 路径，但 V2 官方推荐标准 REST `POST /push`。
 * 这样 device key、中文正文、长诊断都留在 HTTPS request body，而不是塞进 URL；
 * 同时避免长 incident reason 触碰 URL 长度/代理日志边界。
 */
export function buildBarkIncidentRequest(
  config: BarkIncidentNotificationConfig,
  notification: IncidentNotification,
): { url: URL, init: RequestInit } {
  const url = new URL(`${config.baseUrl.replace(/\/+$/u, '')}/push`)
  const payload: Record<string, unknown> = {
    device_key: config.deviceToken,
    title: notification.title,
    body: notification.body,
  }
  const group = notification.group?.trim() || config.group
  if (group) payload.group = group
  if (notification.url) payload.url = notification.url
  return {
    url,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
    },
  }
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve()
}

/**
 * 发送一次事故通知。
 *
 * 注意：这里永远把网络错误转换成结果对象，而不是向上抛出。daemon 的首要职责是保存聊天；
 * iPhone 暂时没网、Bark token 漂移、推送服务故障都不能反过来让 SQLite 同步失败。
 */
export async function sendIncidentNotification(
  config: BarkIncidentNotificationConfig | null,
  notification: IncidentNotification,
  options: IncidentNotificationSendOptions = {},
): Promise<IncidentNotificationResult> {
  if (!config) return { attempted: false, ok: false, status: null, error: null }
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = Math.max(1000, options.timeoutMs ?? 8000)
  const maxAttempts = Math.max(1, Math.min(3, options.maxAttempts ?? 2))
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 750)
  const request = buildBarkIncidentRequest(config, notification)
  let last: IncidentNotificationResult = { attempted: true, ok: false, status: null, error: 'notification failed' }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(request.url, {
        ...request.init,
        signal: AbortSignal.timeout(timeoutMs),
      })
      last = {
        attempted: true,
        ok: response.ok,
        status: response.status,
        error: response.ok ? null : `HTTP ${response.status}`,
      }
      if (response.ok || !retryableStatus(response.status) || attempt === maxAttempts) return last
    }
    catch (error) {
      last = {
        attempted: true,
        ok: false,
        status: null,
        error: error instanceof Error ? error.message : String(error),
      }
      if (attempt === maxAttempts) return last
    }
    await sleep(retryDelayMs)
  }
  return last
}
