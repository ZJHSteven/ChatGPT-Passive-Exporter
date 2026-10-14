/**
 * 轻量逐请求事件账本。
 *
 * 目的不是保存网络内容，而是从现在开始补齐 429 建模真正缺失的“成功请求时间序列”：
 * timestamp/source/target/family/status/retryAfter/latency/backoffStage。
 *
 * 安全边界：
 * - 不写 request/response body；
 * - 不写 Cookie、Authorization、signed URL、token；
 * - routeClass 只能是调用方已经归一化后的稳定类别，禁止直接塞完整 URL/query。
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import type { RateLimitFamily } from './rate-limit-state.ts'

export type RequestEventSource = 'archive-active' | 'native-page' | 'actor'

export interface RequestEvent {
  timestamp: number
  source: RequestEventSource
  targetId: string | null
  family: RateLimitFamily
  routeClass: string
  status: number | null
  retryAfter: string | null
  latencyMs: number | null
  backoffStage: number
}

export class RequestEventLedger {
  private readonly filePath: string
  private pending: Promise<void> = Promise.resolve()
  private initialized = false

  constructor(filePath: string) {
    this.filePath = filePath
  }

  private async ensureDirectory(): Promise<void> {
    if (this.initialized) return
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    this.initialized = true
  }

  /**
   * 串行 append，避免多个 CDP session 同时 responseReceived 时 JSONL 行交叉。
   * 失败会被调用方捕获；账本永远不能阻塞 Archive 主链。
   */
  append(event: RequestEvent): Promise<void> {
    const normalized: RequestEvent = {
      timestamp: Number(event.timestamp),
      source: event.source,
      targetId: typeof event.targetId === 'string' && event.targetId ? event.targetId : null,
      family: event.family,
      routeClass: String(event.routeClass || 'unknown').slice(0, 120),
      status: Number.isFinite(Number(event.status)) ? Number(event.status) : null,
      retryAfter: typeof event.retryAfter === 'string' && event.retryAfter.trim()
        ? event.retryAfter.trim().slice(0, 120)
        : null,
      latencyMs: Number.isFinite(Number(event.latencyMs)) ? Math.max(0, Number(event.latencyMs)) : null,
      backoffStage: Number.isFinite(Number(event.backoffStage))
        ? Math.trunc(Number(event.backoffStage))
        : -1,
    }

    this.pending = this.pending
      .catch(() => {})
      .then(async () => {
        await this.ensureDirectory()
        await fs.appendFile(this.filePath, `${JSON.stringify(normalized)}\n`, 'utf8')
      })
    return this.pending
  }

  async close(): Promise<void> {
    await this.pending.catch(() => {})
  }
}

