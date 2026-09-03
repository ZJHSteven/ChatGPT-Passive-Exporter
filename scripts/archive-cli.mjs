#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { ChatArchiveDb } from '../src/local/archive-db.ts'
import { importOfficialExportZips } from '../src/local/official-export.ts'

function usage() {
  console.log(`ChatGPT local archive prototype

Usage:
  node scripts/archive-cli.mjs import <json-file...> [--db <path>]
  node scripts/archive-cli.mjs import-official <chatgpt-export.zip...> [--db <path>]
  node scripts/archive-cli.mjs list [--limit N] [--db <path>]
  node scripts/archive-cli.mjs search <fts-query> [--limit N] [--db <path>]
  node scripts/archive-cli.mjs show <conversation-id> [--format md|json|resources] [--db <path>]
  node scripts/archive-cli.mjs stats [--db <path>]
  node scripts/archive-cli.mjs sources [--db <path>]
  node scripts/archive-cli.mjs schema [--source ID] [--db <path>]
  node scripts/archive-cli.mjs reindex [--all] [--db <path>]

Default DB: data/chatgpt-archive.sqlite

Import accepts either:
- one conversation object (messages[] or legacy mapping)
- an array of conversation objects, e.g. a ChatGPT official conversations.json-style dump
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
  return path.resolve(String(flags.get('db') || 'data/chatgpt-archive.sqlite'))
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

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  if (!command || command === '-h' || command === '--help' || command === 'help') {
    usage()
    return
  }

  const { positionals, flags } = parseArgs(rest)
  const archive = new ChatArchiveDb(dbPath(flags))
  try {
    if (command === 'import') {
      if (positionals.length === 0) throw new Error('import requires at least one JSON file')
      const results = []
      for (const file of positionals) results.push(...await importFile(archive, file))
      console.log(JSON.stringify({ database: archive.filePath, imported: results }, null, 2))
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
      archive.rebuildSearchIndexes({ includeAuditText: flags.has('all') })
      console.log(JSON.stringify({ database: archive.filePath, includeAuditText: flags.has('all'), stats: archive.stats() }, null, 2))
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
