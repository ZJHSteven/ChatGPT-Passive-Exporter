import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, test } from 'vitest'
import {
  DevSpaceAuditBridge,
  groupDevSpaceActivity,
  uniqueDevSpaceCandidateForTurn,
  type DevSpaceAuditEvent,
} from '../src/local/devspace-audit-bridge.ts'

const audit = (id: string, metadataId: string, startedAtMs: number): DevSpaceAuditEvent => ({
  id,
  metadataId,
  tool: 'exec_command',
  startedAt: new Date(startedAtMs).toISOString(),
  startedAtMs,
  finishedAt: null,
  requestMetaJson: null,
})

describe('DevSpace audit bridge', () => {
  test('turn binding 只接受时间窗中的唯一 metadata', () => {
    const activities = groupDevSpaceActivity([
      audit('a1', 'meta-a', 10_000),
      audit('a2', 'meta-a', 20_000),
      audit('b1', 'meta-b', 200_000),
    ])
    expect(uniqueDevSpaceCandidateForTurn({
      activities,
      turnStartAt: 5_000,
      turnEndAt: 30_000,
      toolCallCount: 2,
      beforeSlackMs: 0,
      afterSlackMs: 0,
    })?.metadataId).toBe('meta-a')

    expect(uniqueDevSpaceCandidateForTurn({
      activities: groupDevSpaceActivity([
        audit('a1', 'meta-a', 10_000),
        audit('b1', 'meta-b', 11_000),
      ]),
      turnStartAt: 5_000,
      turnEndAt: 30_000,
      toolCallCount: 2,
    })).toBeNull()
  })

  test('本地 SQLite 可增量读取 audit，并在新 schema 存在时镜像 binding', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'archive-devspace-bridge-'))
    const dbPath = path.join(root, 'devspace.sqlite')
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE tool_audit (
        id TEXT PRIMARY KEY,
        metadata_id TEXT,
        request_meta_json TEXT,
        tool TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT
      );
      CREATE TABLE chatgpt_conversation_bindings (
        metadata_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        turn_exchange_id TEXT,
        bound_at TEXT NOT NULL,
        last_verified_at TEXT NOT NULL,
        evidence TEXT NOT NULL,
        confidence TEXT NOT NULL
      );
    `)
    db.prepare(`
      INSERT INTO tool_audit
        (id, metadata_id, request_meta_json, tool, started_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('audit-1', 'meta-1', '{"keys":[]}', 'exec_command', '2026-10-03T06:00:00.000Z', null)
    db.close()

    const bridge = new DevSpaceAuditBridge(dbPath)
    try {
      const events = bridge.pollSince(Date.parse('2026-10-03T05:59:00.000Z'))
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        id: 'audit-1',
        metadataId: 'meta-1',
        requestMetaJson: '{"keys":[]}',
      })
      expect(bridge.mirrorBinding({
        metadataId: 'meta-1',
        conversationId: 'conversation-1',
        turnExchangeId: 'turn-1',
        evidence: 'archive:test',
        confidence: 'high',
        observedAt: Date.parse('2026-10-03T06:01:00.000Z'),
      })).toBe(true)
    }
    finally {
      bridge.close()
    }

    const verify = new DatabaseSync(dbPath, { readOnly: true })
    const row = verify.prepare(`
      SELECT conversation_id AS conversationId, turn_exchange_id AS turnExchangeId
      FROM chatgpt_conversation_bindings WHERE metadata_id='meta-1'
    `).get()
    verify.close()
    rmSync(root, { recursive: true, force: true })
    expect(row).toEqual({ conversationId: 'conversation-1', turnExchangeId: 'turn-1' })
  })
})
