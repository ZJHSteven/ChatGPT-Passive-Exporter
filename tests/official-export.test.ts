import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import { afterEach, describe, expect, test } from 'vitest'
import { ChatArchiveDb } from '../src/local/archive-db.ts'
import { importOfficialExportZips } from '../src/local/official-export.ts'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-official-export-test-'))
  tempDirs.push(dir)
  return dir
}

function conversation(id: string, text: string, extraNodes: Record<string, unknown> = {}) {
  return {
    id,
    conversation_id: id,
    title: `标题-${id}`,
    create_time: 100,
    update_time: 200,
    current_node: 'a1',
    is_archived: false,
    memory_scope: 'global_enabled',
    mapping: {
      root: { id: 'root', parent: null, message: null },
      u1: {
        id: 'u1',
        parent: 'root',
        message: {
          id: `m-${id}-u1`,
          author: { role: 'user', name: null },
          create_time: 101,
          content: { content_type: 'text', parts: [text, { asset_pointer: 'file-x' }] },
          metadata: { request_id: `req-${id}` },
          recipient: 'all',
        },
      },
      a1: {
        id: 'a1',
        parent: 'u1',
        message: {
          id: `m-${id}-a1`,
          author: { role: 'assistant' },
          create_time: 102,
          content: { content_type: 'text', parts: [`回答-${text}`] },
          metadata: { model_slug: 'gpt-test', finish_details: { type: 'stop', reason: 'end_turn' } },
          recipient: 'all',
          end_turn: true,
        },
      },
      ...extraNodes,
    },
  }
}

function writeExport(zipPath: string, conversations: unknown[], assets: Record<string, string> = {}): void {
  fs.writeFileSync(zipPath, zipSync({
    'conversations-000.json': strToU8(JSON.stringify(conversations)),
    'conversation_asset_file_names.json': strToU8(JSON.stringify(assets)),
    'user.json': strToU8(JSON.stringify({ email: 'local@example.invalid' })),
    'file_asset.dat': strToU8('binary-placeholder'),
  }))
}

describe('official Data Export importer', () => {
  test('多份快照做 union，较新快照缺失旧 conversation 时只标 missing 不删除', async () => {
    const dir = makeTempDir()
    const db = new ChatArchiveDb(path.join(dir, 'archive.sqlite'))
    const oldZip = path.join(dir, 'ChatGPT-export-2026-07-02.zip')
    const newZip = path.join(dir, 'ChatGPT-export-2026-09-01-11-07-52.zip')
    writeExport(oldZip, [conversation('keep', '旧正文'), conversation('old-only', '只能在旧包看到')], { old_asset: 'old.txt' })
    writeExport(newZip, [conversation('keep', '旧正文', {
      branch: {
        id: 'branch',
        parent: 'u1',
        message: {
          id: 'm-keep-branch',
          author: { role: 'assistant' },
          content: { content_type: 'text', parts: ['新增分支'] },
          metadata: {},
          recipient: 'all',
        },
      },
    }), conversation('new-only', '新聊天')], { new_asset: 'new.txt' })

    try {
      const results = await importOfficialExportZips(db, [newZip, oldZip])
      expect(results).toHaveLength(2)
      expect(results[0]?.observedAt).toBeLessThan(results[1]?.observedAt ?? 0)
      expect(db.stats()).toMatchObject({
        conversationCount: 3,
        sourceCount: 2,
        snapshotCount: 4,
        sourceMissingConversationCount: 1,
        assetCount: 2,
        sourceMissingAssetCount: 1,
      })

      const oldOnly = db.db.prepare('SELECT source_missing AS missing FROM conversations WHERE id = ?').get('old-only') as { missing: number }
      expect(oldOnly.missing).toBe(1)
      const branch = db.db.prepare('SELECT count(*) AS n FROM mapping_nodes WHERE conversation_id = ?').get('keep') as { n: number }
      expect(Number(branch.n)).toBe(4)
      expect(db.search('旧正文').some(hit => hit.conversationId === 'keep')).toBe(true)
    }
    finally {
      db.close()
    }
  })

  test('复杂 part、raw snapshot 与 schema 字段统计同时保留', async () => {
    const dir = makeTempDir()
    const db = new ChatArchiveDb(path.join(dir, 'archive.sqlite'))
    const zip = path.join(dir, 'ChatGPT-export-2026-09-01.zip')
    writeExport(zip, [conversation('c1', '三峡游轮')])

    try {
      const [result] = await importOfficialExportZips(db, [zip])
      expect(result?.conversationCount).toBe(1)
      const partKinds = db.db.prepare(`
        SELECT part_kind AS kind FROM message_parts
        WHERE conversation_id = 'c1' AND message_id = 'm-c1-u1'
        ORDER BY part_index
      `).all() as Array<{ kind: string }>
      expect(partKinds.map(item => item.kind)).toEqual(['string', 'object'])
      const snapshot = db.db.prepare('SELECT length(raw_json_gzip) AS n FROM conversation_snapshots').get() as { n: number }
      expect(Number(snapshot.n)).toBeGreaterThan(20)
      expect(db.schemaFields().some(item => item.entityKind === 'metadata' && item.fieldName === 'request_id')).toBe(true)
      expect(db.stats().allIndexedMessageCount).toBeGreaterThanOrEqual(2)
    }
    finally {
      db.close()
    }
  })
})

