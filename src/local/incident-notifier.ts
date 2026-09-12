import fs from 'node:fs/promises'

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
}

export interface IncidentNotificationResult {
  attempted: boolean
  ok: boolean
  status: number | null
  error: string | null
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
 * 构造 Bark GET API URL。
 *
 * 单独暴露为纯函数是为了测试 URL 编码，同时确保日志/状态只需要记录 HTTP status，
 * 不需要打印包含 deviceToken 的完整 URL。
 */
export function buildBarkIncidentUrl(
  config: BarkIncidentNotificationConfig,
  notification: IncidentNotification,
): URL {
  const base = config.baseUrl.replace(/\/+$/u, '')
  const url = new URL(
    `${base}/${encodeURIComponent(config.deviceToken)}/${encodeURIComponent(notification.title)}/${encodeURIComponent(notification.body)}`,
  )
  if (config.group) url.searchParams.set('group', config.group)
  if (notification.url) url.searchParams.set('url', notification.url)
  return url
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
): Promise<IncidentNotificationResult> {
  if (!config) return { attempted: false, ok: false, status: null, error: null }
  try {
    const response = await fetch(buildBarkIncidentUrl(config, notification), {
      method: 'GET',
      signal: AbortSignal.timeout(8000),
    })
    return {
      attempted: true,
      ok: response.ok,
      status: response.status,
      error: response.ok ? null : `HTTP ${response.status}`,
    }
  }
  catch (error) {
    return {
      attempted: true,
      ok: false,
      status: null,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
