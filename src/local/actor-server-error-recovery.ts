import fs from 'node:fs/promises'
import path from 'node:path'
import { LiveSseCanonicalAccumulator } from './live-sse-canonical.ts'
import type { ActorSubmissionServerError } from './actor-submission-queue.ts'

/**
 * 从近期已经落盘的原始 SSE 证据恢复明确的 ChatGPT 服务端拒绝。
 *
 * 场景：POST 2xx/Job accepted 后 daemon 重启，或旧版本尚未提取 error_code。
 * - 只解析本机日志中最近的、有大小上限的 SSE 文件，不请求 ChatGPT、也不重发消息；
 * - 原始 SSE 可能含鉴权/恢复凭据，只在内存中读取，永远不原样记录或返回；
 * - 真正归属哪个 Job 由队列中的 CID+turn+完整用户输入校验完成；
 * - 采用文件数/尺寸/总字节三重上限，防止启动恢复阻塞 Archive 控制平面。
 */
export async function recoverRecentActorSseErrors(
  rootDir: string,
  report: (error: ActorSubmissionServerError) => Promise<void>,
  options: { now?: number; maxAgeMs?: number; maxFiles?: number; maxFileBytes?: number; maxTotalBytes?: number } = {},
): Promise<{ checked: number; recovered: number }> {
  const now = options.now ?? Date.now()
  const maxAgeMs = options.maxAgeMs ?? 48 * 60 * 60_000
  const maxFiles = options.maxFiles ?? 100
  const maxFileBytes = options.maxFileBytes ?? 4 * 1024 * 1024
  const maxTotalBytes = options.maxTotalBytes ?? 20 * 1024 * 1024
  const candidates: Array<{ file: string; mtimeMs: number; size: number }> = []
  let days: string[]
  try { days = await fs.readdir(rootDir) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { checked: 0, recovered: 0 }
    throw error
  }
  for (const day of days.slice(-4)) {
    const folder = path.join(rootDir, day)
    const entries = await fs.readdir(folder, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.meta.jsonl')) continue
      const file = path.join(folder, entry.name.replace(/\.meta\.jsonl$/u, '.sse'))
      const stat = await fs.stat(file).catch(() => null)
      if (!stat || stat.size > maxFileBytes || stat.size === 0) continue
      if (stat.mtimeMs < now - maxAgeMs || stat.mtimeMs > now + 60_000) continue
      candidates.push({ file, mtimeMs: stat.mtimeMs, size: stat.size })
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
  let checked = 0
  let recovered = 0
  let bytesRead = 0
  for (const candidate of candidates.slice(0, maxFiles)) {
    if (bytesRead + candidate.size > maxTotalBytes) break
    bytesRead += candidate.size
    checked++
    const text = await fs.readFile(candidate.file, 'utf8')
    if (!text.includes('error_code')) continue
    const decoder = new LiveSseCanonicalAccumulator()
    decoder.ingestText(text)
    decoder.finish()
    const snapshot = decoder.snapshot()
    if (!snapshot.serverError) continue
    await report({
      conversationId: snapshot.serverError.conversationId,
      turnExchangeId: snapshot.turnExchangeId,
      code: snapshot.serverError.code,
      reason: snapshot.serverError.reason,
      message: snapshot.serverError.message,
      at: candidate.mtimeMs,
    })
    recovered++
  }
  return { checked, recovered }
}
