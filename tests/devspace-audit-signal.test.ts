import { createSocket } from 'node:dgram'
import { describe, expect, test } from 'vitest'
import {
  DevSpaceAuditWakeListener,
  parseDevSpaceAuditWakeSignal,
} from '../src/local/devspace-audit-signal.ts'

describe('DevSpace audit wake listener', () => {
  test('解析有效 payload，并拒绝损坏消息', () => {
    const valid = Buffer.from(JSON.stringify({
      version: 1,
      auditId: 'audit-1',
      metadataId: 'meta-1',
      startedAt: '2026-10-06T06:00:00.000Z',
      tool: 'exec_command',
      phase: 'finish',
    }))
    expect(parseDevSpaceAuditWakeSignal(valid)).toMatchObject({
      auditId: 'audit-1',
      metadataId: 'meta-1',
      phase: 'finish',
    })
    expect(parseDevSpaceAuditWakeSignal(Buffer.from('{bad json'))).toBeNull()
  })

  test('localhost datagram 可立即唤醒 listener', async () => {
    // 先让内核分配一个空闲端口，再关闭探针 socket；测试 listener 随后占用该端口。
    const probe = createSocket('udp4')
    await new Promise<void>((resolve, reject) => {
      probe.once('error', reject)
      probe.bind(0, '127.0.0.1', () => resolve())
    })
    const address = probe.address()
    if (typeof address === 'string') throw new Error('expected udp4 address')
    const port = address.port
    probe.close()

    const listener = new DevSpaceAuditWakeListener({ port })
    const received = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('wake timeout')), 2_000)
      void listener.start(signal => {
        clearTimeout(timer)
        resolve(signal as unknown as Record<string, unknown>)
      })
    })

    // 等 start() 完成 bind，避免测试自身制造启动竞态。
    for (let i = 0; i < 50 && !listener.stats().listening; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }

    const sender = createSocket('udp4')
    try {
      sender.send(
        Buffer.from(JSON.stringify({
          version: 1,
          auditId: 'audit-live',
          metadataId: 'meta-live',
          startedAt: '2026-10-06T06:00:00.000Z',
          tool: 'read',
          phase: 'start',
        })),
        port,
        '127.0.0.1',
      )
      expect(await received).toMatchObject({
        auditId: 'audit-live',
        metadataId: 'meta-live',
        tool: 'read',
        phase: 'start',
      })
      expect(listener.stats()).toMatchObject({
        listening: true,
        received: 1,
        invalid: 0,
      })
    }
    finally {
      sender.close()
      listener.close()
    }
  })
})
