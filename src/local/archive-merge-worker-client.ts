import { Worker } from 'node:worker_threads'
import type { ChatArchiveDb, LiveMappingMergeResult, LiveMergeResult } from './archive-db.ts'
import type { PreparedArchiveEvidence } from './archive-evidence-store.ts'

type MessageMergeOptions = NonNullable<Parameters<ChatArchiveDb['mergeLiveMessagesPage']>[1]>
type MappingMergeOptions = NonNullable<Parameters<ChatArchiveDb['mergeLiveMappingSnapshot']>[1]>
type MergeKind = 'messages' | 'mapping'

interface PendingJob<T> {
  resolve: (value: T) => void
  reject: (error: Error) => void
  startedAt: number
}

interface WorkerReply<T = unknown> {
  id: number
  ok: boolean
  result?: T
  error?: string
  stack?: string | null
  workerMs?: number
}

export interface ArchiveMergeWorkerStats {
  threadId: number | null
  pending: number
  completed: number
  failed: number
  restarts: number
  lastRoundTripMs: number
  maxRoundTripMs: number
  lastWorkerMs: number
  maxWorkerMs: number
  lastError: string | null
}

/**
 * Canonical SQLite merge executor isolated from the daemon's WSS/Bridge/timer event loop.
 *
 * The worker owns a separate ChatArchiveDb connection and serializes all merge jobs. We never
 * fall back to synchronous main-thread merge: if the worker fails, the caller sees a normal
 * sync error and the daemon's existing retry path can retry later without freezing control plane.
 */
export class ArchiveMergeWorker {
  private worker: Worker | null = null
  private nextId = 1
  private readonly pending = new Map<number, PendingJob<unknown>>()
  private closed = false
  private completed = 0
  private failed = 0
  private restarts = 0
  private lastRoundTripMs = 0
  private maxRoundTripMs = 0
  private lastWorkerMs = 0
  private maxWorkerMs = 0
  private lastError: string | null = null

  constructor(private readonly dbPath: string) {}

  stats(): ArchiveMergeWorkerStats {
    return {
      threadId: this.worker?.threadId ?? null,
      pending: this.pending.size,
      completed: this.completed,
      failed: this.failed,
      restarts: this.restarts,
      lastRoundTripMs: this.lastRoundTripMs,
      maxRoundTripMs: this.maxRoundTripMs,
      lastWorkerMs: this.lastWorkerMs,
      maxWorkerMs: this.maxWorkerMs,
      lastError: this.lastError,
    }
  }

  mergeMessages(payload: unknown, options: MessageMergeOptions = {}): Promise<LiveMergeResult> {
    return this.enqueue<LiveMergeResult>('messages', payload, options)
  }

  mergeMapping(payload: unknown, options: MappingMergeOptions = {}): Promise<LiveMappingMergeResult> {
    return this.enqueue<LiveMappingMergeResult>('mapping', payload, options)
  }

  async close(): Promise<void> {
    this.closed = true
    const worker = this.worker
    this.worker = null
    if (!worker) return
    for (const [, job] of this.pending) job.reject(new Error('Archive merge worker closed'))
    this.pending.clear()
    try {
      worker.postMessage({ kind: 'close' })
      await Promise.race([
        new Promise<void>(resolve => worker.once('exit', () => resolve())),
        new Promise<void>(resolve => setTimeout(resolve, 1000)),
      ])
    }
    finally {
      if (worker.threadId !== -1) await worker.terminate().catch(() => {})
    }
  }

  private ensureWorker(): Worker {
    if (this.closed) throw new Error('Archive merge worker is closed')
    if (this.worker) return this.worker

    const worker = new Worker(new URL('../../scripts/archive-merge-worker.mjs', import.meta.url), {
      workerData: { dbPath: this.dbPath },
    })
    this.worker = worker
    if (this.restarts > 0 || this.completed > 0 || this.failed > 0) this.restarts += 1

    worker.on('message', (reply: WorkerReply) => {
      const job = this.pending.get(reply.id)
      if (!job) return
      this.pending.delete(reply.id)
      const roundTripMs = performance.now() - job.startedAt
      this.lastRoundTripMs = roundTripMs
      this.maxRoundTripMs = Math.max(this.maxRoundTripMs, roundTripMs)
      const workerMs = Number(reply.workerMs || 0)
      this.lastWorkerMs = workerMs
      this.maxWorkerMs = Math.max(this.maxWorkerMs, workerMs)
      if (reply.ok) {
        this.completed += 1
        this.lastError = null
        job.resolve(reply.result)
      }
      else {
        this.failed += 1
        const error = new Error(reply.error || 'Archive merge worker failed')
        if (reply.stack) error.stack = reply.stack
        this.lastError = error.message
        job.reject(error)
      }
    })
    worker.on('error', (error: Error) => {
      this.lastError = error.message
    })
    worker.on('exit', (code) => {
      if (this.worker === worker) this.worker = null
      if (this.closed) return
      const error = new Error(`Archive merge worker exited with code ${code}`)
      this.lastError = error.message
      for (const [, job] of this.pending) job.reject(error)
      this.failed += this.pending.size
      this.pending.clear()
    })
    return worker
  }

  private enqueue<T>(
    kind: MergeKind,
    payload: unknown,
    options: MessageMergeOptions | MappingMergeOptions,
  ): Promise<T> {
    const worker = this.ensureWorker()
    const id = this.nextId++
    const prepared = options.preparedObservation as PreparedArchiveEvidence | undefined
    const rawPayload = prepared?.rawText ?? JSON.stringify(payload)
    const wireOptions = { ...options, preparedObservation: undefined }
    const preparedObservation = prepared
      ? {
          rawText: prepared.rawText,
          sha256: prepared.sha256,
          rawBytes: prepared.rawBytes,
          compressed: new Uint8Array(prepared.compressed),
        }
      : null

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        startedAt: performance.now(),
      })
      try {
        worker.postMessage({ id, kind, rawPayload, options: wireOptions, preparedObservation })
      }
      catch (error) {
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }
}
