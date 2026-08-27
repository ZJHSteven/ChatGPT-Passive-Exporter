#!/usr/bin/env node
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(scriptDir, '..')
const sourceDir = path.join(projectRoot, 'opencli', 'chatgpt')
const targetDir = path.join(os.homedir(), '.opencli', 'clis', 'chatgpt')
const siteDir = path.join(os.homedir(), '.opencli', 'sites', 'chatgpt')
const dbPath = path.resolve(process.env.CHATGPT_ARCHIVE_DB || path.join(projectRoot, 'data', 'chatgpt-archive.sqlite'))

const files = (await fs.readdir(sourceDir)).filter(name => name.endsWith('.js')).sort()
await fs.mkdir(targetDir, { recursive: true })
for (const name of files) {
  await fs.copyFile(path.join(sourceDir, name), path.join(targetDir, name))
}

await fs.mkdir(siteDir, { recursive: true })
const configPath = path.join(siteDir, 'archive-local.json')
await fs.writeFile(configPath, `${JSON.stringify({
  projectRoot,
  dbPath,
  installedAt: new Date().toISOString(),
}, null, 2)}\n`, 'utf8')

console.log(JSON.stringify({
  projectRoot,
  dbPath,
  installedFiles: files.map(name => path.join(targetDir, name)),
  configPath,
}, null, 2))
