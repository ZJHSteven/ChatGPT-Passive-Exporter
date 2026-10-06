import { createSocket, type Socket } from 'node:dgram'

/** 必须与 DevSpace 的默认值一致；环境变量可同时覆盖两端。 */
export const DEFAULT_DEVSPACE_AUDIT_SIGNAL_PORT = 47_831

export interface DevSpaceAuditWakeSignal {
  version: 1
  auditId: string
  metadataId: string
  startedAt: string
  tool: string
}

export interface DevSpaceAuditWakeStats {
  port: number
  listening: boolean
  received: number
  invalid: number
  lastReceivedAt: number | null
  lastSignalStartedAt: number | null
  lastLatencyMs: number | null
  lastError: string | null
}

/**
 * DevSpace tool_audit 的本机事件监听器。
 *
 * UDP 不是事实存储，只是一个“门铃”：DevSpace 已经先把 audit INSERT 到 SQLite，
 * 再发 datagram；Archive 收到以后立即读取 SQLite。即使 datagram 丢失，后续事件
 * 或低频 fallback scan 仍会把缺失行补回来，因此无需 ACK/重试协议。
 */
export class DevSpaceAuditWakeListener {
  private socket: Socket | null = null
  private readonly port: number
  private readonly host: string
  private received = 0
  private invalid = 0
  private lastReceivedAt: number | null = null
  private lastSignalStartedAt: number | null = null
  private lastLatencyMs: number | null = null
  private lastError: string | null = null

  constructor(options: { port?: number, host?: string } = {}) {
    const envPort = Number(process.env.DEVSPACE_ARCHIVE_SIGNAL_PORT)
    this.port = Number.isInteger(options.port)
      ? Number(options.port)
      : Number.isInteger(envPort) && envPort > 0 && envPort <= 65_535
        ? envPort
        : DEFAULT_DEVSPACE_AUDIT_SIGNAL_PORT
    this.host = options.host ?? '127.0.0.1'
  }

  async start(onWake: (signal: DevSpaceAuditWakeSignal) => void): Promise<boolean> {
    if (this.socket) return true
    const socket = createSocket('udp4')
    this.socket = socket

    socket.on('message', payload => {
      const signal = parseDevSpaceAuditWakeSignal(payload)
      if (!signal) {
        this.invalid += 1
        return
      }
      this.received += 1
      const receivedAt = Date.now()
      const startedAt = Date.parse(signal.startedAt)
      this.lastReceivedAt = receivedAt
      this.lastSignalStartedAt = startedAt
      this.lastLatencyMs = Math.max(0, receivedAt - startedAt)
      onWake(signal)
    })
    socket.on('error', error => {
      this.lastError = error.message
    })

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          socket.off('listening', onListening)
          reject(error)
        }
        const onListening = () => {
          socket.off('error', onError)
          resolve()
        }
        socket.once('error', onError)
        socket.once('listening', onListening)
        socket.bind(this.port, this.host)
      })
      this.lastError = null
      return true
    }
    catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      try {
        socket.close()
      } catch {
        // bind 失败时 socket 可能已经自动关闭。
      }
      if (this.socket === socket) this.socket = null
      return false
    }
  }

  stats(): DevSpaceAuditWakeStats {
    return {
      port: this.port,
      listening: Boolean(this.socket),
      received: this.received,
      invalid: this.invalid,
      lastReceivedAt: this.lastReceivedAt,
      lastSignalStartedAt: this.lastSignalStartedAt,
      lastLatencyMs: this.lastLatencyMs,
      lastError: this.lastError,
    }
  }

  close(): void {
    try {
      this.socket?.close()
    } catch {
      // shutdown 时重复 close 不应成为 daemon 错误。
    }
    this.socket = null
  }
}

export function parseDevSpaceAuditWakeSignal(payload: Buffer): DevSpaceAuditWakeSignal | null {
  try {
    const value = JSON.parse(payload.toString('utf8')) as Partial<DevSpaceAuditWakeSignal>
    if (value.version !== 1) return null
    if (typeof value.auditId !== 'string' || !value.auditId) return null
    if (typeof value.metadataId !== 'string' || !value.metadataId) return null
    if (typeof value.startedAt !== 'string' || !Number.isFinite(Date.parse(value.startedAt))) return null
    if (typeof value.tool !== 'string' || !value.tool) return null
    return value as DevSpaceAuditWakeSignal
  }
  catch {
    return null
  }
}
