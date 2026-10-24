import fs from 'node:fs'
import { describe, expect, test } from 'vitest'

describe('sync-chatgpt fetch-only canary', () => {
  test('returns before opening ArchiveDb', () => {
    const source = fs.readFileSync(new URL('../scripts/sync-chatgpt.mjs', import.meta.url), 'utf8')
    const fetchOnlyIndex = source.indexOf('if (fetchOnly) {')
    const archiveOpenIndex = source.indexOf('const archive = new ChatArchiveDb(dbPath)')
    expect(fetchOnlyIndex).toBeGreaterThan(0)
    expect(archiveOpenIndex).toBeGreaterThan(fetchOnlyIndex)
    const fetchOnlyBlock = source.slice(fetchOnlyIndex, archiveOpenIndex)
    expect(fetchOnlyBlock).toContain('fetchOnly: true')
    expect(fetchOnlyBlock).not.toContain('new ChatArchiveDb')
  })
})
