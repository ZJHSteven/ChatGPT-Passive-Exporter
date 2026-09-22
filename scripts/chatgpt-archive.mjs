#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ChatArchiveDb } from '../src/local/archive-db.ts'
import { importOfficialExportZips } from '../src/local/official-export.ts'
import { clusterCompletionBursts, readTurnTraceTail } from '../src/local/turn-trace-reader.ts'
import { actorStatus, resetActor, sendActorPrompt } from '../src/local/chatgpt-actor.ts'

/**
 * 全局 `chatgpt-archive` 通过 npm link/全局 shim 可以从任意工作目录启动。
 * 因此默认数据库、daemon 脚本和运行状态绝不能再用 `process.cwd()` 推导；
 * 否则 AI 在另一个项目目录调用 CLI 时会悄悄创建一份新的空 `data/chatgpt-archive.sqlite`。
 *
 * `import.meta.url` 始终指向真正的脚本文件，所以以 scripts/ 的父目录作为项目根最稳定。
 */
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_DB_PATH = path.join(PROJECT_ROOT, 'data', 'chatgpt-archive.sqlite')
const DEFAULT_DAEMON_STATE_PATH = path.join(PROJECT_ROOT, 'data', 'archive-daemon-state.json')
const DEFAULT_DAEMON_LOG_PATH = path.join(PROJECT_ROOT, 'data', 'archive-daemon.log')
const DEFAULT_TURN_TRACE_PATH = path.join(PROJECT_ROOT, 'data', 'active-turn-trace.jsonl')
const DEFAULT_ACTOR_STATE_PATH = path.join(PROJECT_ROOT, 'data', 'archive-actor-state.json')
const WINDOWS_STARTUP_HELPER = path.join(PROJECT_ROOT, 'scripts', 'windows-archive-startup.ps1')
const WINDOWS_STARTUP_LAUNCHER = path.join(PROJECT_ROOT, 'scripts', 'windows-archive-daemon-launcher.vbs')
const WINDOWS_STARTUP_TASK = 'ChatGPT Archive Daemon'

function usage() {
  console.log(`ChatGPT Archive CLI

Usage:
  chatgpt-archive import <json-file...> [--db <path>]
  chatgpt-archive recover <recovery-json-file...> [--db <path>]
  chatgpt-archive import-official <chatgpt-export.zip...> [--db <path>]
  chatgpt-archive list [--limit N] [--db <path>]
  chatgpt-archive search <fts-query> [--limit N] [--db <path>]
  chatgpt-archive show <conversation-id> [--format md|json|resources] [--db <path>]
  chatgpt-archive stats [--db <path>]
  chatgpt-archive sources [--db <path>]
  chatgpt-archive schema [--source ID] [--db <path>]
  chatgpt-archive reindex [--all] [--db <path>]
  chatgpt-archive incidents [--status open|resolved] [--limit N] [--db <path>]
  chatgpt-archive turn-trace [--limit N] [--trace <path>] [--cluster-ms N]
  chatgpt-archive actor send --prompt-file <path> [--cdp URL] [--trace <path>] [--state <path>]
  chatgpt-archive actor status [--cdp URL] [--state <path>]
  chatgpt-archive actor reset [--cdp URL] [--state <path>]
  chatgpt-archive daemon start [--cdp URL] [--reconcile-hours N] [--db <path>]
  chatgpt-archive daemon status [--state <path>]
  chatgpt-archive daemon stop [--state <path>]
  chatgpt-archive daemon install-startup
  chatgpt-archive daemon startup-status
  chatgpt-archive daemon uninstall-startup

Default DB: <ChatGPT Archive project>/data/chatgpt-archive.sqlite

Development fallback:
  node scripts/chatgpt-archive.mjs <command> ...
  npm run chatgpt-archive -- <command> ...

Import accepts either:
- one conversation object (messages[] or legacy mapping)
- an array of conversation objects, e.g. a ChatGPT official conversations.json-style dump

Recovery accepts only payloads explicitly marked:
- recovery.kind = "browser-memory-recovery"
- messages[] are union/upserted non-destructively
- canonical current_node and incident state are never changed by recovery evidence
`)
}

function parseArgs(argv) {
  const positionals = []
  const flags = new Map()
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i]
    if (value.startsWith('--')) {
      const name = value.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) {
        flags.set(name, next)
        i += 1
      }
      else {
        flags.set(name, true)
      }
    }
    else positionals.push(value)
  }
  return { positionals, flags }
}

function dbPath(flags) {
  const explicit = flags.get('db') ?? process.env.CHATGPT_ARCHIVE_DB
  return explicit === undefined ? DEFAULT_DB_PATH : path.resolve(String(explicit))
}

function daemonStatePath(flags) {
  const explicit = flags.get('state')
  return explicit === undefined ? DEFAULT_DAEMON_STATE_PATH : path.resolve(String(explicit))
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  }
  catch {
    return false
  }
}

async function readDaemonState(flags) {
  const statePath = daemonStatePath(flags)
  try {
    const state = JSON.parse(await fs.readFile(statePath, 'utf8'))
    return { statePath, state, alive: isPidAlive(Number(state?.pid)) }
  }
  catch {
    return { statePath, state: null, alive: false }
  }
}

async function daemonCommand(positionals, flags) {
  const action = positionals[0]
  if (!action) throw new Error('daemon requires start|status|stop|install-startup|startup-status|uninstall-startup')

  if (['install-startup', 'startup-status', 'uninstall-startup'].includes(action)) {
    if (process.platform !== 'win32') throw new Error(`${action} is currently Windows-only`)
    const helperAction = action === 'install-startup'
      ? 'Install'
      : action === 'uninstall-startup' ? 'Uninstall' : 'Status'
    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', WINDOWS_STARTUP_HELPER,
      '-Action', helperAction,
      '-TaskName', WINDOWS_STARTUP_TASK,
    ]
    if (helperAction === 'Install') {
      args.push(
        '-NodeExe', process.execPath,
        '-DaemonScript', path.join(PROJECT_ROOT, 'scripts', 'chatgpt-archive-daemon.mjs'),
        '-LauncherScript', WINDOWS_STARTUP_LAUNCHER,
        '-ProjectRoot', PROJECT_ROOT,
        '-DbPath', dbPath(flags),
      )
    }
    // Windows PowerShell 5.1 会按系统代码页误读无 BOM 的 UTF-8 中文脚本；本机已有
    // PowerShell 7，统一用 pwsh 解析 startup helper，避免同一脚本在 PS7 正常、PS5.1 语法损坏。
    const child = spawn('pwsh.exe', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    const exitCode = await new Promise((resolve, reject) => {
      child.on('error', reject)
      child.on('close', resolve)
    })
    if (exitCode !== 0) throw new Error(`Windows startup task failed (${exitCode}): ${stderr.trim() || stdout.trim()}`)
    console.log(stdout.trim() || JSON.stringify({ action, ok: true }))
    return
  }

  if (action === 'status') {
    const current = await readDaemonState(flags)
    console.log(JSON.stringify(current, null, 2))
    return
  }

  if (action === 'stop') {
    const current = await readDaemonState(flags)
    const pid = Number(current.state?.pid)
    if (!current.alive || !Number.isInteger(pid)) {
      console.log(JSON.stringify({ stopped: false, reason: 'daemon not running', ...current }, null, 2))
      return
    }
    process.kill(pid, 'SIGTERM')
    const started = Date.now()
    while (isPidAlive(pid) && Date.now() - started < 5000) {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    if (isPidAlive(pid)) process.kill(pid, 'SIGKILL')
    console.log(JSON.stringify({ stopped: !isPidAlive(pid), pid, statePath: current.statePath }, null, 2))
    return
  }

  if (action === 'start') {
    const current = await readDaemonState(flags)
    if (current.alive) {
      console.log(JSON.stringify({ started: false, reason: 'already running', ...current }, null, 2))
      return
    }

    const daemonScript = path.join(PROJECT_ROOT, 'scripts', 'chatgpt-archive-daemon.mjs')
    const statePath = daemonStatePath(flags)
    const logPath = flags.has('log')
      ? path.resolve(String(flags.get('log')))
      : DEFAULT_DAEMON_LOG_PATH
    const childArgs = [daemonScript, '--state', statePath, '--log', logPath, '--db', dbPath(flags)]
    const passFlags = [
      'cdp',
      'sync-delay-ms',
      'reconcile-delay-ms',
      'request-jitter-ms',
      'overlap',
      'reconcile-hours',
      'cooldown-minutes',
      'max-sync-conversations',
      'watchdog-minutes',
      'chrome-shortcut',
      'chrome-start-timeout-ms',
      'notification-config',
      'turn-trace',
    ]
    for (const name of passFlags) {
      if (flags.has(name)) childArgs.push(`--${name}`, String(flags.get(name)))
    }
    if (flags.has('no-reconcile-on-start')) childArgs.push('--no-reconcile-on-start')
    if (flags.has('no-auto-launch-chrome')) childArgs.push('--no-auto-launch-chrome')

    const child = spawn(process.execPath, childArgs, {
      detached: true,
      windowsHide: true,
      // daemon 自己负责写结构化日志；这里若再把 stderr/stdout 重定向到同一文件，
      // 每条 log() 会被“fs.appendFile + console.error”写两遍。
      stdio: 'ignore',
      cwd: PROJECT_ROOT,
    })
    child.unref()

    const started = Date.now()
    let observed = null
    while (Date.now() - started < 15_000) {
      await new Promise(resolve => setTimeout(resolve, 100))
      observed = await readDaemonState(flags)
      if (observed.alive && observed.state?.guardian) break
    }
    console.log(JSON.stringify({ started: Boolean(observed?.alive), pid: child.pid, ...(observed || {}) }, null, 2))
    return
  }

  throw new Error(`Unknown daemon action: ${action}`)
}

function limit(flags, fallback) {
  const parsed = Number(flags.get('limit') || fallback)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error('--limit must be a positive integer')
  return parsed
}

async function importFile(db, filePath) {
  const absolute = path.resolve(filePath)
  const stat = await fs.stat(absolute)
  if (!stat.isFile()) throw new Error(`Not a file: ${absolute}`)
  const parsed = JSON.parse(await fs.readFile(absolute, 'utf8'))
  const payloads = Array.isArray(parsed) ? parsed : [parsed]
  const results = []
  for (const payload of payloads) {
    try {
      results.push({ file: absolute, ...db.importRaw(payload, stat.mtimeMs || Date.now()) })
    }
    catch (error) {
      results.push({ file: absolute, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return results
}

/**
 * Non-destructive offline recovery for evidence that survived in browser memory
 * while the canonical conversation body stopped persisting.
 *
 * Unlike importRaw(), this path must never replace an existing conversation.
 * It reuses the live union merge and stores the full recovery bundle in
 * live_observations for later forensic reinterpretation.
 */
async function recoverFile(db, filePath) {
  const absolute = path.resolve(filePath)
  const stat = await fs.stat(absolute)
  if (!stat.isFile()) throw new Error('Not a file: ' + absolute)
  const parsed = JSON.parse(await fs.readFile(absolute, 'utf8'))
  const payloads = Array.isArray(parsed) ? parsed : [parsed]
  const results = []

  for (const payload of payloads) {
    try {
      const recovery = payload && typeof payload === 'object' ? payload.recovery : null
      if (!recovery || recovery.kind !== 'browser-memory-recovery') {
        throw new Error('recovery payload must set recovery.kind="browser-memory-recovery"')
      }
      if (!Array.isArray(payload.messages)) {
        throw new Error('recovery payload requires messages[]')
      }

      const canonicalMessages = payload.messages.filter((message) => {
        if (!message || typeof message !== 'object') return false
        const role = message.author && typeof message.author === 'object'
          ? message.author.role
          : null
        if (role === 'user') return true
        if (role !== 'assistant') return false

        // ChatGPT 的“消息发送超时 / 已达到长度上限”等错误卡片同样会带 data-message-id，
        // 但真实样本证明这些 ID 可以完全不存在于 server body。DOM message-id 本身因此不够。
        // 当前只允许带真实模型标识的 assistant DOM 节点进入 canonical union；其余 UI-only
        // 节点仍完整保存在 recovery.uiMessages/raw observation 中，供 forensic 对账。
        const metadata = message.metadata && typeof message.metadata === 'object'
          ? message.metadata
          : {}
        const modelSlug = metadata.recovery_model_slug
        const content = message.content && typeof message.content === 'object'
          ? message.content
          : {}
        const text = Array.isArray(content.parts) ? content.parts.filter(part => typeof part === 'string').join('\n') : ''
        if (typeof modelSlug !== 'string' || modelSlug.trim().length === 0) return false
        if (/消息发送超时|已达到此对话的长度上限|达到此对话的长度上限/u.test(text)) return false
        return true
      })

      const mergePayload = { ...payload, messages: canonicalMessages }
      const capturedAt = Number(recovery.capturedAt)
      const observedAt = Number.isFinite(capturedAt) && capturedAt > 0
        ? capturedAt
        : (stat.mtimeMs || Date.now())

      results.push({
        file: absolute,
        ...db.mergeLiveMessagesPage(mergePayload, {
          observedAt,
          endpoint: 'offline://browser-memory-recovery',
          observationKind: 'browser-memory-recovery',
          updateCurrentState: false,
          classifyTerminal: false,
          allowIncompleteTailIncident: false,
          updateIncidents: false,
          insertUnknownOnly: true,
        }),
        uiMessageCount: payload.messages.length,
        canonicalCandidateCount: canonicalMessages.length,
      })
    }
    catch (error) {
      results.push({
        file: absolute,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return results
}

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  if (!command || command === '-h' || command === '--help' || command === 'help') {
    usage()
    return
  }

  const { positionals, flags } = parseArgs(rest)

  if (command === 'daemon') {
    await daemonCommand(positionals, flags)
    return
  }

  if (command === 'turn-trace') {
    const tracePath = flags.has('trace')
      ? path.resolve(String(flags.get('trace')))
      : DEFAULT_TURN_TRACE_PATH
    const clusterMs = Number(flags.get('cluster-ms') ?? 30_000)
    if (!Number.isFinite(clusterMs) || clusterMs < 0) throw new Error('--cluster-ms must be >= 0')
    let records = []
    try {
      records = await readTurnTraceTail(tracePath)
    }
    catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    const recent = records.slice(-limit(flags, 100))
    console.log(JSON.stringify({
      tracePath,
      recordCountInTail: records.length,
      records: recent,
      completionBursts: clusterCompletionBursts(records, clusterMs),
    }, null, 2))
    return
  }

  if (command === 'actor') {
    const action = positionals[0]
    const cdpHttp = String(flags.get('cdp') || 'http://127.0.0.1:9222').replace(/\/$/u, '')
    const actorStatePath = flags.has('state')
      ? path.resolve(String(flags.get('state')))
      : DEFAULT_ACTOR_STATE_PATH
    if (action === 'status') {
      console.log(JSON.stringify(await actorStatus(cdpHttp, actorStatePath), null, 2))
      return
    }
    if (action === 'reset') {
      console.log(JSON.stringify(await resetActor(cdpHttp, actorStatePath), null, 2))
      return
    }
    if (action === 'send') {
      const promptFile = flags.get('prompt-file')
      if (typeof promptFile !== 'string' || !promptFile) throw new Error('actor send requires --prompt-file <path>')
      const prompt = await fs.readFile(path.resolve(promptFile), 'utf8')
      const tracePath = flags.has('trace')
        ? path.resolve(String(flags.get('trace')))
        : DEFAULT_TURN_TRACE_PATH
      const timeoutMs = Number(flags.get('timeout-ms') ?? 20_000)
      if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) throw new Error('--timeout-ms must be >= 1000')
      console.log(JSON.stringify(await sendActorPrompt({
        cdpHttp,
        statePath: actorStatePath,
        tracePath,
        prompt,
        timeoutMs,
      }), null, 2))
      return
    }
    throw new Error('actor requires send|status|reset')
  }

  const archive = new ChatArchiveDb(dbPath(flags))
  try {
    if (command === 'import') {
      if (positionals.length === 0) throw new Error('import requires at least one JSON file')
      const results = []
      for (const file of positionals) results.push(...await importFile(archive, file))
      console.log(JSON.stringify({ database: archive.filePath, imported: results }, null, 2))
      return
    }

    if (command === 'recover') {
      if (positionals.length === 0) throw new Error('recover requires at least one recovery JSON file')
      const results = []
      for (const file of positionals) results.push(...await recoverFile(archive, file))
      console.log(JSON.stringify({ database: archive.filePath, recovered: results }, null, 2))
      return
    }

    if (command === 'import-official') {
      if (positionals.length === 0) throw new Error('import-official requires at least one ChatGPT export ZIP')
      const results = await importOfficialExportZips(archive, positionals)
      console.log(JSON.stringify({ database: archive.filePath, sources: results, stats: archive.stats() }, null, 2))
      return
    }

    if (command === 'list') {
      console.log(JSON.stringify(archive.list(limit(flags, 50)), null, 2))
      return
    }

    if (command === 'search') {
      if (positionals.length === 0) throw new Error('search requires an FTS query')
      const query = positionals.join(' ')
      console.log(JSON.stringify(archive.search(query, limit(flags, 20)), null, 2))
      return
    }

    if (command === 'show') {
      const id = positionals[0]
      if (!id) throw new Error('show requires a conversation ID')
      const format = String(flags.get('format') || 'md')
      if (format === 'md') {
        const markdown = archive.getMarkdown(id)
        if (markdown === null) throw new Error(`Conversation not found: ${id}`)
        process.stdout.write(markdown)
        return
      }
      if (format === 'json') {
        console.log(JSON.stringify(archive.getMessages(id), null, 2))
        return
      }
      if (format === 'resources') {
        console.log(JSON.stringify(archive.getResources(id), null, 2))
        return
      }
      throw new Error(`Unknown --format ${format}; use md|json|resources`)
    }

    if (command === 'stats') {
      console.log(JSON.stringify(archive.stats(), null, 2))
      return
    }

    if (command === 'sources') {
      console.log(JSON.stringify(archive.listSources(), null, 2))
      return
    }

    if (command === 'schema') {
      const sourceFlag = flags.get('source')
      const sourceId = sourceFlag === undefined ? undefined : Number(sourceFlag)
      if (sourceId !== undefined && (!Number.isInteger(sourceId) || sourceId <= 0)) throw new Error('--source must be a positive integer')
      console.log(JSON.stringify(archive.schemaFields(sourceId), null, 2))
      return
    }

    if (command === 'reindex') {
      const resourceCount = archive.rebuildDerivedResources()
      archive.rebuildSearchIndexes({ includeAuditText: flags.has('all') })
      console.log(JSON.stringify({
        database: archive.filePath,
        includeAuditText: flags.has('all'),
        rebuiltResources: resourceCount,
        stats: archive.stats(),
      }, null, 2))
      return
    }

    if (command === 'incidents') {
      const statusFlag = flags.get('status')
      const status = statusFlag === undefined ? undefined : String(statusFlag)
      if (status !== undefined && status !== 'open' && status !== 'resolved') {
        throw new Error('--status must be open|resolved')
      }
      console.log(JSON.stringify(archive.listIncidents({
        status,
        limit: limit(flags, 100),
      }), null, 2))
      return
    }

    throw new Error(`Unknown command: ${command}`)
  }
  finally {
    archive.close()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
