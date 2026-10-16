import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import {
  archiveDaemonSupervisorReady,
  clearArchiveDaemonStartOnce,
  enterArchiveDaemonMaintenance,
  grantArchiveDaemonStartOnce,
  leaveArchiveDaemonMaintenance,
  readArchiveDaemonMaintenance,
} from '../src/local/archive-daemon-supervision.ts'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })))
})

async function tempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-daemon-supervision-'))
  temporaryRoots.push(root)
  return root
}

describe('Archive daemon maintenance gate', () => {
  test('maintenance state can be entered and cleared explicitly', async () => {
    const root = await tempRoot()
    const filePath = path.join(root, 'maintenance.json')

    expect(await readArchiveDaemonMaintenance(filePath)).toMatchObject({ active: false, reason: null })
    expect(await enterArchiveDaemonMaintenance(filePath, 'manual-stop', 1234)).toMatchObject({
      active: true,
      reason: 'manual-stop',
      enteredAt: 1234,
    })
    expect(await readArchiveDaemonMaintenance(filePath)).toMatchObject({
      active: true,
      reason: 'manual-stop',
      enteredAt: 1234,
    })

    await leaveArchiveDaemonMaintenance(filePath)
    expect(await readArchiveDaemonMaintenance(filePath)).toMatchObject({ active: false })
  })

  test('one-shot permit is explicit and idempotently clearable', async () => {
    const root = await tempRoot()
    const permit = path.join(root, 'start-once.flag')
    await grantArchiveDaemonStartOnce(permit)
    expect(await fs.stat(permit)).toBeTruthy()
    await clearArchiveDaemonStartOnce(permit)
    await clearArchiveDaemonStartOnce(permit)
    await expect(fs.stat(permit)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('supervisor readiness requires core listeners and a healthy guardian', () => {
    const healthy = {
      alive: true,
      state: {
        bridge: { listening: true },
        devspace: { wake: { listening: true } },
        guardian: { healthFailures: 0 },
        lastError: null,
      },
    }
    expect(archiveDaemonSupervisorReady(healthy)).toBe(true)
    expect(archiveDaemonSupervisorReady({ ...healthy, alive: false })).toBe(false)
    expect(archiveDaemonSupervisorReady({
      ...healthy,
      state: { ...healthy.state, bridge: { listening: false } },
    })).toBe(false)
    expect(archiveDaemonSupervisorReady({
      ...healthy,
      state: { ...healthy.state, guardian: { healthFailures: 3 } },
    })).toBe(false)
  })

  test.skipIf(process.platform !== 'win32')('VBS launcher blocks maintenance and consumes exactly one permit', async () => {
    const root = await tempRoot()
    const maintenance = path.join(root, 'maintenance.json')
    const permit = path.join(root, 'start-once.flag')
    const output = path.join(root, 'child-ran.txt')
    const child = path.join(root, 'child.mjs')
    const launcher = fileURLToPath(new URL('../scripts/windows-archive-daemon-launcher.vbs', import.meta.url))

    await fs.writeFile(child, [
      "import fs from 'node:fs'",
      "fs.writeFileSync(process.argv[2], 'ran')",
    ].join('\n'))
    await enterArchiveDaemonMaintenance(maintenance, 'test')

    execFileSync('cscript.exe', ['//nologo', launcher, maintenance, permit, process.execPath, child, output])
    await expect(fs.stat(output)).rejects.toMatchObject({ code: 'ENOENT' })

    await grantArchiveDaemonStartOnce(permit)
    execFileSync('cscript.exe', ['//nologo', launcher, maintenance, permit, process.execPath, child, output])
    expect(await fs.readFile(output, 'utf8')).toBe('ran')
    await expect(fs.stat(permit)).rejects.toMatchObject({ code: 'ENOENT' })

    await fs.rm(output)
    execFileSync('cscript.exe', ['//nologo', launcher, maintenance, permit, process.execPath, child, output])
    await expect(fs.stat(output)).rejects.toMatchObject({ code: 'ENOENT' })

    await leaveArchiveDaemonMaintenance(maintenance)
    execFileSync('cscript.exe', ['//nologo', launcher, maintenance, permit, process.execPath, child, output])
    expect(await fs.readFile(output, 'utf8')).toBe('ran')
  })

  test.skipIf(process.platform !== 'win32')('VBS launcher keeps the legacy node + daemon argument shape working', async () => {
    const root = await tempRoot()
    const output = path.join(root, 'legacy-child-ran.txt')
    const child = path.join(root, 'legacy-child.mjs')
    const launcher = fileURLToPath(new URL('../scripts/windows-archive-daemon-launcher.vbs', import.meta.url))

    await fs.writeFile(child, [
      "import fs from 'node:fs'",
      "fs.writeFileSync(process.argv[2], 'legacy-ran')",
    ].join('\n'))

    execFileSync('cscript.exe', ['//nologo', launcher, process.execPath, child, output])
    expect(await fs.readFile(output, 'utf8')).toBe('legacy-ran')
  })
})
