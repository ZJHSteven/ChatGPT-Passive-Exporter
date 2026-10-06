import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, test } from 'vitest'
import {
  DevSpaceAuditBridge,
  groupDevSpaceActivity,
  matchDevSpaceCandidateForTurn,
  parseDevSpaceBodyToolCall,
  type DevSpaceAuditEvent,
} from '../src/local/devspace-audit-bridge.ts'

const audit = (
  id: string,
  metadataId: string,
  startedAtMs: number,
  args: Record<string, unknown> = { cmd: 'echo ok' },
): DevSpaceAuditEvent => ({
  id,
  metadataId,
  tool: 'exec_command',
  argsJson: JSON.stringify(args),
  startedAt: new Date(startedAtMs).toISOString(),
  startedAtMs,
  finishedAt: null,
  requestMetaJson: null,
})

describe('DevSpace audit bridge', () => {
  test('并发 metadata 通过 exact tool+args 区分，不再依赖时间唯一性', () => {
    const activities = groupDevSpaceActivity([
      audit('a1', 'meta-a', 10_000, { cwd: 'A', cmd: 'git status --short' }),
      audit('a2', 'meta-a', 20_000, { cwd: 'A', cmd: 'chatgpt-archive daemon status' }),
      audit('b1', 'meta-b', 11_000, { cwd: 'B', cmd: 'git status --short' }),
    ])
    const bodyCalls = [
      parseDevSpaceBodyToolCall(JSON.stringify({
        path: '/devspace/link_x/exec_command',
        args: { cmd: 'git status --short', cwd: 'A' },
      }), 10_100),
      parseDevSpaceBodyToolCall(JSON.stringify({
        path: '/devspace/link_x/exec_command',
        args: { cmd: 'chatgpt-archive daemon status', cwd: 'A' },
      }), 20_100),
    ].filter((value): value is NonNullable<typeof value> => Boolean(value))

    expect(matchDevSpaceCandidateForTurn({
      activities,
      bodyCalls,
    })?.activity.metadataId).toBe('meta-a')

    // 两边 args 完全相同且各只有一条时保持 fail-closed，不做时间猜测。
    expect(matchDevSpaceCandidateForTurn({
      activities: groupDevSpaceActivity([
        audit('a1', 'meta-a', 10_000, { cmd: 'echo same' }),
        audit('b1', 'meta-b', 11_000, { cmd: 'echo same' }),
      ]),
      bodyCalls: [
        parseDevSpaceBodyToolCall(JSON.stringify({
          path: '/devspace/link_x/exec_command',
          args: { cmd: 'echo same' },
        }), 10_500)!,
      ],
    })).toBeNull()

    // 已绑定 metadata 不能被排除出 fingerprint owner 统计。
    // meta-old 虽然不再是候选，但它仍然证明 echo shared 并非 meta-new 独有证据。
    expect(matchDevSpaceCandidateForTurn({
      activities: groupDevSpaceActivity([
        audit('old-1', 'meta-old', 10_000, { cmd: 'echo shared' }),
        audit('new-1', 'meta-new', 10_100, { cmd: 'echo shared' }),
      ]),
      bodyCalls: [
        parseDevSpaceBodyToolCall(JSON.stringify({
          path: '/devspace/link_x/exec_command',
          args: { cmd: 'echo shared' },
        }), 10_200)!,
      ],
      alreadyBoundMetadataIds: ['meta-old'],
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
        args_json TEXT NOT NULL,
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
        (id, metadata_id, request_meta_json, tool, args_json, started_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      'audit-1',
      'meta-1',
      '{"keys":[]}',
      'exec_command',
      '{"cmd":"echo ok"}',
      '2026-10-03T06:00:00.000Z',
      null,
    )
    db.prepare(`
      INSERT INTO tool_audit
        (id, metadata_id, request_meta_json, tool, args_json, started_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      'audit-2',
      'meta-1',
      '{"keys":[]}',
      'read',
      '{"path":"note.txt"}',
      '2026-10-03T06:02:00.000Z',
      '2026-10-03T06:02:01.000Z',
    )
    db.close()

    const bridge = new DevSpaceAuditBridge(dbPath)
    try {
      const events = bridge.pollSince(Date.parse('2026-10-03T05:59:00.000Z'))
      expect(events).toHaveLength(2)
      expect(events[0]).toMatchObject({
        id: 'audit-1',
        metadataId: 'meta-1',
        argsJson: '{"cmd":"echo ok"}',
        requestMetaJson: '{"keys":[]}',
      })
      expect(events[1]).toMatchObject({
        id: 'audit-2',
        metadataId: 'meta-1',
        tool: 'read',
        argsJson: '{"path":"note.txt"}',
      })
      expect(bridge.metadataSummaries()).toEqual([{
        metadataId: 'meta-1',
        firstAt: Date.parse('2026-10-03T06:00:00.000Z'),
        lastAt: Date.parse('2026-10-03T06:02:00.000Z'),
        auditCount: 2,
      }])
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
