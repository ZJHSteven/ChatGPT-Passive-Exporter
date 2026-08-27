#!/usr/bin/env node
/**
 * 检查我们依赖/参考的 ChatGPT 生态上游是否发生变化。
 *
 * 这个脚本故意不自动搬运上游源码：我们的核心价值之一就是把“捕获 transport”与
 * “解析/render”隔离。如果检测到变化，它只生成结构化报告；`--update-pins` 仅更新
 * 已审核基线 SHA，真正移植代码仍由 PR/Agent review 决定。
 *
 * GitHub Actions 可通过 GITHUB_TOKEN 提高 API 限额；本地运行时也可匿名查询公共仓库。
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const root = process.cwd()
const upstreamDir = path.join(root, 'upstream')
const updatePins = process.argv.includes('--update-pins')
const reportPath = path.join(upstreamDir, 'REPORT.md')

function repoSlug(repository) {
  const match = repository.match(/github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?$/u)
  if (!match) throw new Error(`仅支持 GitHub repository：${repository}`)
  return `${match[1]}/${match[2]}`
}

async function githubJson(apiPath) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'chatgpt-passive-exporter-upstream-watch',
  }
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`

  const response = await fetch(`https://api.github.com${apiPath}`, { headers })
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status}: ${apiPath}\n${await response.text()}`)
  }
  return response.json()
}

function matchesTrackedPath(filename, trackedPaths = []) {
  return trackedPaths.length === 0 || trackedPaths.some((tracked) => {
    const normalized = tracked.replaceAll('\\', '/')
    return normalized.endsWith('/') ? filename.startsWith(normalized) : filename === normalized
  })
}

async function loadConfigs() {
  const names = (await fs.readdir(upstreamDir))
    .filter(name => name.endsWith('.json'))
    .sort()

  return Promise.all(names.map(async (name) => ({
    name,
    filePath: path.join(upstreamDir, name),
    config: JSON.parse(await fs.readFile(path.join(upstreamDir, name), 'utf8')),
  })))
}

async function inspectUpstream(entry) {
  const { config } = entry
  const slug = repoSlug(config.repository)
  const branch = config.branch || 'main'
  const latest = await githubJson(`/repos/${slug}/commits/${encodeURIComponent(branch)}`)
  const latestSha = latest.sha

  if (latestSha === config.pinnedSha) {
    return {
      ...entry,
      slug,
      branch,
      latestSha,
      changed: false,
      relevantFiles: [],
      commitCount: 0,
      compareUrl: null,
    }
  }

  let compare = null
  try {
    compare = await githubJson(`/repos/${slug}/compare/${config.pinnedSha}...${latestSha}`)
  }
  catch (error) {
    // pin 太老、历史被重写或 GitHub compare 暂时失败时，仍把 HEAD 变化报告出来。
    console.warn(`[upstream] compare failed for ${slug}: ${error.message}`)
  }

  const files = Array.isArray(compare?.files) ? compare.files : []
  const relevantFiles = files
    .map(file => file.filename)
    .filter(filename => matchesTrackedPath(filename, config.trackedPaths))

  return {
    ...entry,
    slug,
    branch,
    latestSha,
    changed: true,
    relevantFiles,
    commitCount: Number(compare?.ahead_by ?? compare?.total_commits ?? 0),
    compareUrl: compare?.html_url ?? `https://github.com/${slug}/compare/${config.pinnedSha}...${latestSha}`,
  }
}

function renderReport(results) {
  const now = new Date().toISOString()
  const changed = results.filter(result => result.changed)
  const relevant = changed.filter(result => result.relevantFiles.length > 0)

  const lines = [
    '# Upstream Watch Report',
    '',
    `Generated: ${now}`,
    '',
    `Changed upstreams: **${changed.length}/${results.length}**`,
    `Changes touching tracked paths: **${relevant.length}**`,
    '',
  ]

  for (const result of results) {
    lines.push(`## ${result.slug}`)
    lines.push('')
    lines.push(`- Branch: \`${result.branch}\``)
    lines.push(`- Pinned: \`${result.config.pinnedSha}\``)
    lines.push(`- Latest: \`${result.latestSha}\``)
    lines.push(`- Changed: **${result.changed ? 'yes' : 'no'}**`)
    if (result.changed) {
      lines.push(`- Commits ahead: ${result.commitCount || 'unknown'}`)
      lines.push(`- Compare: ${result.compareUrl}`)
      lines.push(`- Relevant changed files: ${result.relevantFiles.length}`)
      for (const filename of result.relevantFiles.slice(0, 100)) {
        lines.push(`  - \`${filename}\``)
      }
      if (result.relevantFiles.length > 100) lines.push('  - … truncated …')
    }
    lines.push('')
  }

  return {
    markdown: `${lines.join('\n')}\n`,
    changedCount: changed.length,
    relevantCount: relevant.length,
  }
}

async function writeGithubOutputs(report) {
  if (process.env.GITHUB_OUTPUT) {
    await fs.appendFile(
      process.env.GITHUB_OUTPUT,
      `changed=${report.changedCount > 0}\nrelevant=${report.relevantCount > 0}\nchanged_count=${report.changedCount}\nrelevant_count=${report.relevantCount}\n`,
    )
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, report.markdown)
  }
}

async function main() {
  const configs = await loadConfigs()
  const results = []
  for (const entry of configs) {
    console.log(`[upstream] checking ${entry.config.repository}`)
    results.push(await inspectUpstream(entry))
  }

  const report = renderReport(results)
  await fs.writeFile(reportPath, report.markdown, 'utf8')
  await writeGithubOutputs(report)

  if (updatePins) {
    const today = new Date().toISOString().slice(0, 10)
    for (const result of results) {
      if (!result.changed) continue
      const next = {
        ...result.config,
        pinnedSha: result.latestSha,
        observedAt: today,
      }
      await fs.writeFile(result.filePath, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    }
  }

  console.log(JSON.stringify({
    changed: report.changedCount,
    relevant: report.relevantCount,
    report: path.relative(root, reportPath),
  }))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
