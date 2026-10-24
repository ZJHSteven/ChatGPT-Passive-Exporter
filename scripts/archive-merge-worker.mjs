import { parentPort, workerData } from 'node:worker_threads'
import { ChatArchiveDb } from '../src/local/archive-db.ts'

if (!parentPort) throw new Error('archive merge worker requires parentPort')
if (!workerData?.dbPath) throw new Error('archive merge worker requires dbPath')

const archive = new ChatArchiveDb(String(workerData.dbPath))

parentPort.on('message', (message) => {
  if (message?.kind === 'close') {
    archive.close()
    parentPort.postMessage({ id: Number(message?.id || 0), ok: true })
    parentPort.close()
    return
  }

  const id = Number(message?.id || 0)
  const startedAt = performance.now()
  try {
    let result
    if (message.kind === 'recovery-audit') {
      archive.upsertDevSpaceRecoveryAudit({ ...(message.input || {}) })
      result = null
    }
    else if (message.kind === 'tool-turn-evidence') {
      result = archive.readDevSpaceTurnToolCallRows(
        String(message.conversationId || ''),
        String(message.turnExchangeId || ''),
      )
    }
    else {
      const payload = JSON.parse(String(message.rawPayload || 'null'))
      const options = { ...(message.options || {}) }
      if (message.preparedObservation) {
        options.preparedObservation = {
          rawText: String(message.preparedObservation.rawText || ''),
          sha256: String(message.preparedObservation.sha256 || ''),
          rawBytes: Number(message.preparedObservation.rawBytes || 0),
          compressed: Buffer.from(message.preparedObservation.compressed || []),
        }
      }
      result = message.kind === 'messages'
        ? archive.mergeLiveMessagesPage(payload, options)
        : message.kind === 'mapping'
          ? archive.mergeLiveMappingSnapshot(payload, options)
          : (() => { throw new Error(`unknown archive merge worker kind: ${String(message.kind)}`) })()
    }
    parentPort.postMessage({
      id,
      ok: true,
      result,
      workerMs: performance.now() - startedAt,
    })
  }
  catch (error) {
    parentPort.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack ?? null : null,
      workerMs: performance.now() - startedAt,
    })
  }
})
