#!/usr/bin/env node
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { evaluateRecoveryEligibility } from '../src/local/recovery-policy.ts'

/**
 * ChatGPT Companion 的本地控制面。
 *
 * 浏览器 Userscript 负责“发现事实”：Fleet Watch 低频监控服务端状态，并把事故写入
 * chatgpt.com 同源 localStorage。这个脚本负责“消费事实”：CLI 查询、历史审计触发、
 * Luna 只读审批，以及用户明确开启后的无人值守恢复。
 *
 * 安全边界：
 * 1. 不读取/打印 ChatGPT Authorization；这里只通过 CDP 读取 Companion 自己的 localStorage。
 * 2. 历史审计与 legacy incident 永远不能自动恢复。
 * 3. 未回执 tool-call-open 永远不能自动恢复，因为工具可能已经产生副作用。
 * 4. Luna 使用 --no-tools --no-session，只能返回审批 JSON，不能操作本机。
 * 5. 真正发送续跑前再次执行硬安全门，并通过本地 recovery ledger 防重。
 */

const FLEET_STORAGE_KEY = 'chatgpt-passive-exporter/fleet-watch/state/v2'
const HISTORY_AUDIT_REQUEST_KEY = 'chatgpt-companion/history-audit-request/v1'
const DEFAULT_CDP = 'http://127.0.0.1:9222'
const DEFAULT_LEDGER = path.resolve('data/recovery-ledger.json')

function usage() {
  console.log(`ChatGPT Companion local control

Usage:
  node scripts/companion-control.mjs status [--cdp URL]
  node scripts/companion-control.mjs incidents [--cdp URL]
  node scripts/companion-control.mjs audit [--max 200] [--cdp URL]
  node scripts/companion-control.mjs review [incident-id] [--cdp URL]
  node scripts/companion-control.mjs recover [incident-id] --execute [--cdp URL]
  node scripts/companion-control.mjs watch [--auto] [--interval 30] [--cdp URL]

Notes:
  - watch without --auto never sends ChatGPT messages.
  - only realtime + open + hard-gate-safe incidents can enter Luna review.
  - tool-call-open incidents remain manual until real side effects are verified.
`)
}

function parseArgs(argv) {
  const positionals = []
  const flags = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (!value.startsWith('--')) {
      positionals.push(value)
      continue
    }
    const name = value.slice(2)
    const next = argv[index + 1]
    if (next && !next.startsWith('--')) {
      flags.set(name, next)
      index += 1
    }
    else flags.set(name, true)
  }
  return { positionals, flags }
}

function jsonOutput(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

class CdpClient {
  constructor(url) {
    this.url = url
    this.ws = null
    this.nextId = 1
    this.pending = new Map()
  }

  async connect() {
    this.ws = new WebSocket(this.url)
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data))
      if (typeof message.id !== 'number') return
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message || 'CDP error'))
      else pending.resolve(message.result || {})
    })
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true })
      this.ws.addEventListener('error', () => reject(new Error('CDP websocket error')), { once: true })
    })
  }

  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  close() {
    this.ws?.close()
  }
}

function isLightChatgptPage(tab) {
  if (tab?.type !== 'page') return false
  try {
    const url = new URL(tab.url || '')
    return url.origin === 'https://chatgpt.com' && url.pathname === '/'
  }
  catch {
    return false
  }
}

/**
 * 只为读取同源 localStorage 获取一个轻量 ChatGPT target。
 * 优先已有 homepage；没有就创建 `?companion-control=1`。绝不导航/刷新 `/c/<id>` 工作页。
 */
async function acquireStorageTarget(cdpHttp) {
  const tabs = await fetch(`${cdpHttp}/json/list`).then(response => response.json())
  const light = tabs
    .filter(isLightChatgptPage)
    .sort((a, b) => {
      const score = tab => /companion-(?:monitor|control|cli)=1/u.test(tab.url || '') ? 1 : 0
      return score(b) - score(a)
    })[0]
  if (light) return { tab: light, created: false }

  const helperUrl = 'https://chatgpt.com/?companion-control=1'
  const response = await fetch(`${cdpHttp}/json/new?${encodeURIComponent(helperUrl)}`, { method: 'PUT' })
  if (!response.ok) throw new Error(`无法创建 Companion helper tab：HTTP ${response.status}`)
  const tab = await response.json()
  if (!tab?.webSocketDebuggerUrl || !tab?.id) throw new Error('CDP helper target 缺少 websocket 信息')
  // 给 ChatGPT document/localStorage origin 一点初始化时间；不等待复杂 UI hydration。
  await new Promise(resolve => setTimeout(resolve, 1_200))
  return { tab, created: true }
}

async function closeTarget(cdpHttp, targetId) {
  if (!targetId) return
  try {
    await fetch(`${cdpHttp}/json/close/${encodeURIComponent(targetId)}`)
  }
  catch {
    // 临时 helper 清理失败不改变控制命令本身的结论。
  }
}

async function evaluateOnChatgpt(cdpHttp, expression, { keepHelper = false } = {}) {
  const acquired = await acquireStorageTarget(cdpHttp)
  const client = new CdpClient(acquired.tab.webSocketDebuggerUrl)
  await client.connect()
  try {
    await client.send('Runtime.enable')
    const result = await client.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result?.exceptionDetails) throw new Error('ChatGPT helper Runtime.evaluate 失败')
    return { value: result?.result?.value, targetId: acquired.tab.id, created: acquired.created }
  }
  finally {
    client.close()
    if (acquired.created && !keepHelper) await closeTarget(cdpHttp, acquired.tab.id)
  }
}

async function readFleetState(cdpHttp) {
  const expression = `(() => {
    const raw = localStorage.getItem(${JSON.stringify(FLEET_STORAGE_KEY)});
    if (!raw) return { tracked: [], alerts: [], incidents: [], lastPollAt: null };
    try { return JSON.parse(raw); }
    catch { return { parseError: true, tracked: [], alerts: [], incidents: [], lastPollAt: null }; }
  })()`
  const result = await evaluateOnChatgpt(cdpHttp, expression)
  return result.value && typeof result.value === 'object'
    ? result.value
    : { tracked: [], alerts: [], incidents: [], lastPollAt: null }
}

async function requestHistoryAudit(cdpHttp, maxConversations) {
  const request = { at: Date.now(), maxConversations }
  const expression = `(() => {
    localStorage.setItem(${JSON.stringify(HISTORY_AUDIT_REQUEST_KEY)}, ${JSON.stringify(JSON.stringify(request))});
    return true;
  })()`
  await evaluateOnChatgpt(cdpHttp, expression)

  // 如果当前没有轻量 homepage leader，显式打开一张 monitor 页。若已有 leader，它会收到 storage event。
  const tabs = await fetch(`${cdpHttp}/json/list`).then(response => response.json())
  if (!tabs.some(isLightChatgptPage)) {
    await fetch(`${cdpHttp}/json/new?${encodeURIComponent('https://chatgpt.com/?companion-monitor=1')}`, { method: 'PUT' })
  }
  return request
}

async function readLedger(filePath = DEFAULT_LEDGER) {
  try {
    const parsed = JSON.parse(await fsp.readFile(filePath, 'utf8'))
    return {
      version: 1,
      attempts: Array.isArray(parsed.attempts) ? parsed.attempts : [],
    }
  }
  catch {
    return { version: 1, attempts: [] }
  }
}

async function writeLedger(ledger, filePath = DEFAULT_LEDGER) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.tmp`
  await fsp.writeFile(temporary, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8')
  await fsp.rename(temporary, filePath)
}

function findGlobalNodeCli(packageRelativePath) {
  const candidates = []
  const pathParts = String(process.env.PATH || '').split(path.delimiter).filter(Boolean)
  for (const directory of pathParts) candidates.push(path.join(directory, 'node_modules', packageRelativePath))
  // 用户当前 npm-global 的实际目录；作为 PATH 推断失败时的兼容 fallback。
  candidates.push(path.join('D:\\App\\npm-global\\node_modules', packageRelativePath))
  return candidates.find(candidate => fs.existsSync(candidate))
}

function parseJsonObject(text, label) {
  const trimmed = String(text || '').trim()
  try {
    return JSON.parse(trimmed)
  }
  catch {
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1))
      }
      catch {
        // 下面统一抛出更清楚的错误。
      }
    }
    throw new Error(`${label} 没有返回可解析 JSON：${trimmed.slice(0, 500)}`)
  }
}

function runLunaReview(incident, eligibility) {
  const piCli = findGlobalNodeCli(path.join('@earendil-works', 'pi-coding-agent', 'dist', 'cli.js'))
  if (!piCli) throw new Error('找不到 PI CLI 的 Node 入口；请确认 pi 已安装。')

  const systemPrompt = [
    '你是 ChatGPT Companion 的无人值守恢复审批器。',
    '你没有工具，也不得假设未提供的事实。你的唯一任务是判断：现在向这条已终止异常 conversation 发送一条“安全继续”消息是否合理。',
    '必须极度保守：如果最后工具可能已经执行但回执丢失、存在重复写入/删除/安装/上传/git 等副作用风险，approve=false。',
    '输出只能是一个 JSON 对象，不要 Markdown，不要解释性前后缀。',
  ].join('\n')

  const prompt = JSON.stringify({
    task: 'review_chatgpt_incident_for_safe_resume',
    hardGate: eligibility,
    incident: {
      id: incident.id,
      conversationId: incident.conversationId,
      title: incident.title,
      reason: incident.reason,
      source: incident.source,
      status: incident.status,
      detectedAt: incident.detectedAt,
      diagnostic: incident.diagnostic ?? null,
    },
    requiredOutput: {
      approve: 'boolean',
      risk: 'low | medium | high',
      requiresVerification: 'boolean',
      reason: 'short Chinese string',
      continuePrompt: 'Chinese prompt to send to the original ChatGPT conversation if approved',
    },
    continuePromptRequirement: '如果 approve=true，必须要求原 ChatGPT 先核对上一轮真实状态，再从已确认状态继续；不得无条件重放上一工具。',
  })

  const result = spawnSync(process.execPath, [
    piCli,
    '--model', 'openai-codex/gpt-5.6-luna',
    '--thinking', 'low',
    '--no-tools',
    '--no-session',
    '--system-prompt', systemPrompt,
    '-p',
    prompt,
  ], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  })

  if (result.status !== 0) {
    throw new Error(`Luna 审批失败：${String(result.stderr || result.stdout || '').trim().slice(0, 800)}`)
  }
  const decision = parseJsonObject(result.stdout, 'Luna')
  if (typeof decision.approve !== 'boolean') throw new Error('Luna JSON 缺少 boolean approve')
  if (decision.approve && (typeof decision.continuePrompt !== 'string' || !decision.continuePrompt.trim())) {
    throw new Error('Luna approve=true 但没有提供 continuePrompt')
  }
  return decision
}

function runOpenCliContinue(incident, prompt) {
  const opencliCli = findGlobalNodeCli(path.join('@jackwener', 'opencli', 'dist', 'src', 'main.js'))
  if (!opencliCli) throw new Error('找不到 OpenCLI Node 入口；请确认 @jackwener/opencli 已安装。')

  const result = spawnSync(process.execPath, [
    opencliCli,
    'chatgpt', 'send',
    prompt,
    '--conversation', incident.conversationId,
    '-f', 'json',
  ], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  })

  if (result.status !== 0) {
    throw new Error(`OpenCLI 续跑失败：${String(result.stderr || result.stdout || '').trim().slice(0, 1200)}`)
  }
  return String(result.stdout || '').trim()
}

function incidentByIdOrLatest(state, id) {
  const incidents = Array.isArray(state.incidents) ? state.incidents : []
  if (id) return incidents.find(incident => incident.id === id) ?? null
  return incidents
    .filter(incident => incident.source === 'realtime' && incident.status === 'open')
    .sort((a, b) => Number(b.detectedAt || 0) - Number(a.detectedAt || 0))[0] ?? null
}

async function reviewOne(state, incidentId, ledger, { execute = false } = {}) {
  const incident = incidentByIdOrLatest(state, incidentId)
  if (!incident) throw new Error(incidentId ? `找不到 incident：${incidentId}` : '没有待处理 realtime open incident')

  const prior = ledger.attempts.find(attempt => attempt.incidentId === incident.id && attempt.final === true)
  if (prior) {
    return { incident, skipped: true, reason: 'recovery ledger 已有终态记录', prior }
  }

  const eligibility = evaluateRecoveryEligibility(incident)
  if (!eligibility.eligible) {
    const attempt = {
      incidentId: incident.id,
      conversationId: incident.conversationId,
      reviewedAt: Date.now(),
      hardGate: eligibility,
      outcome: 'blocked',
      final: true,
    }
    ledger.attempts.push(attempt)
    await writeLedger(ledger)
    return { incident, eligibility, decision: null, executed: false, attempt }
  }

  const decision = runLunaReview(incident, eligibility)
  const attempt = {
    incidentId: incident.id,
    conversationId: incident.conversationId,
    reviewedAt: Date.now(),
    hardGate: eligibility,
    luna: decision,
    outcome: decision.approve ? (execute ? 'approved-pending-send' : 'approved-dry-run') : 'denied',
    final: !decision.approve || !execute,
  }

  if (!decision.approve || !execute) {
    ledger.attempts.push(attempt)
    await writeLedger(ledger)
    return { incident, eligibility, decision, executed: false, attempt }
  }

  // 发送前再次执行硬门，防止 Luna 调用期间事故已经在浏览器里被继续/解决。
  const freshState = await readFleetState(DEFAULT_CDP)
  const freshIncident = (freshState.incidents ?? []).find(item => item.id === incident.id)
  const freshEligibility = freshIncident ? evaluateRecoveryEligibility(freshIncident) : { eligible: false, reason: '事故已从当前 ledger 消失' }
  if (!freshEligibility.eligible) {
    attempt.outcome = 'blocked-before-send'
    attempt.final = true
    attempt.beforeSendGate = freshEligibility
    ledger.attempts.push(attempt)
    await writeLedger(ledger)
    return { incident, eligibility, decision, executed: false, attempt }
  }

  const response = runOpenCliContinue(freshIncident, decision.continuePrompt.trim())
  attempt.outcome = 'sent'
  attempt.executedAt = Date.now()
  attempt.opencliOutput = response.slice(0, 4000)
  attempt.final = true
  ledger.attempts.push(attempt)
  await writeLedger(ledger)
  return { incident: freshIncident, eligibility, decision, executed: true, attempt }
}

async function commandStatus(cdpHttp) {
  const state = await readFleetState(cdpHttp)
  const ledger = await readLedger()
  return {
    lastPollAt: state.lastPollAt ?? null,
    tracked: state.tracked ?? [],
    incidents: state.incidents ?? [],
    alerts: state.alerts ?? [],
    recoveryAttempts: ledger.attempts,
  }
}

async function watchLoop(cdpHttp, auto, intervalSeconds) {
  const startedAt = Date.now()
  console.error(`[Companion] watch started; auto=${auto}; interval=${intervalSeconds}s`)
  while (true) {
    try {
      const state = await readFleetState(cdpHttp)
      const ledger = await readLedger()
      const incidents = (state.incidents ?? [])
        .filter(incident => incident.source === 'realtime' && incident.status === 'open')
        .sort((a, b) => Number(a.detectedAt || 0) - Number(b.detectedAt || 0))

      for (const incident of incidents) {
        if (ledger.attempts.some(attempt => attempt.incidentId === incident.id && attempt.final === true)) continue
        if (!auto) {
          console.error(`[Companion] pending incident: ${incident.title} (${incident.id})`)
          continue
        }
        const result = await reviewOne(state, incident.id, ledger, { execute: true })
        console.error(`[Companion] recovery ${incident.id}: ${result.executed ? 'sent' : result.attempt?.outcome ?? 'skipped'}`)
      }
    }
    catch (error) {
      console.error(`[Companion] watch error: ${error instanceof Error ? error.message : String(error)}`)
    }
    const elapsed = Date.now() - startedAt
    // 偶尔输出心跳，便于计划任务/守护进程判断脚本仍活着；不打印任何认证信息。
    if (elapsed % (10 * 60_000) < intervalSeconds * 1000) console.error('[Companion] watch heartbeat')
    await new Promise(resolve => setTimeout(resolve, intervalSeconds * 1000))
  }
}

async function main() {
  const [command = 'status', ...rest] = process.argv.slice(2)
  if (command === '-h' || command === '--help' || command === 'help') {
    usage()
    return
  }

  const { positionals, flags } = parseArgs(rest)
  const cdpHttp = String(flags.get('cdp') || DEFAULT_CDP).replace(/\/$/u, '')

  if (command === 'status') {
    jsonOutput(await commandStatus(cdpHttp))
    return
  }

  if (command === 'incidents') {
    const state = await readFleetState(cdpHttp)
    jsonOutput(Array.isArray(state.incidents) ? state.incidents : [])
    return
  }

  if (command === 'audit') {
    const max = Number(flags.get('max') || 200)
    if (!Number.isInteger(max) || max <= 0 || max > 1000) throw new Error('--max 必须是 1..1000 的整数')
    jsonOutput({ requested: true, ...(await requestHistoryAudit(cdpHttp, max)) })
    return
  }

  if (command === 'review' || command === 'recover') {
    const state = await readFleetState(cdpHttp)
    const ledger = await readLedger()
    const execute = command === 'recover' && flags.get('execute') === true
    jsonOutput(await reviewOne(state, positionals[0], ledger, { execute }))
    return
  }

  if (command === 'watch') {
    const interval = Number(flags.get('interval') || 30)
    if (!Number.isFinite(interval) || interval < 10) throw new Error('--interval 最低 10 秒')
    await watchLoop(cdpHttp, flags.get('auto') === true, interval)
    return
  }

  usage()
  process.exitCode = 2
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})

