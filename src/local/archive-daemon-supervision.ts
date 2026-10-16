import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Archive daemon 的“人为维护”状态。
 *
 * 没有 maintenance 文件表示允许 Task Scheduler 在意外退出后自动拉起；
 * 有 maintenance 文件表示这是人为停机/部署窗口，周期 trigger 必须保持安静。
 */
export interface ArchiveDaemonMaintenanceState {
  active: boolean
  path: string
  reason: string | null
  enteredAt: number | null
}

/** 文件不存在不是异常，而是“自动自愈已 armed”。 */
export async function readArchiveDaemonMaintenance(filePath: string): Promise<ArchiveDaemonMaintenanceState> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as {
      reason?: unknown
      enteredAt?: unknown
    }
    return {
      active: true,
      path: filePath,
      reason: typeof parsed.reason === 'string' ? parsed.reason : null,
      enteredAt: Number.isFinite(Number(parsed.enteredAt)) ? Number(parsed.enteredAt) : null,
    }
  }
  catch (error: any) {
    if (error?.code === 'ENOENT') {
      return { active: false, path: filePath, reason: null, enteredAt: null }
    }
    throw error
  }
}

/** 原子进入维护态，避免 launcher 恰好读取到半写 JSON。 */
export async function enterArchiveDaemonMaintenance(
  filePath: string,
  reason: string,
  now = Date.now(),
): Promise<ArchiveDaemonMaintenanceState> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const temporary = filePath + '.tmp-' + process.pid
  await fs.writeFile(temporary, JSON.stringify({ reason, enteredAt: now }, null, 2))
  await fs.rename(temporary, filePath)
  return { active: true, path: filePath, reason, enteredAt: now }
}

/** 解除维护态，也就是重新允许未来的意外退出被 Task Scheduler 自动拉起。 */
export async function leaveArchiveDaemonMaintenance(filePath: string): Promise<void> {
  await fs.rm(filePath, { force: true })
}

/**
 * 创建“一次性启动许可证”。
 *
 * maintenance 期间普通周期 trigger 会被 launcher 挡住；resume 写 permit 后只放行一次，
 * launcher 在真正启动 Node 前先删除 permit，因此坏版本退出后不会被下一分钟继续循环拉起。
 */
export async function grantArchiveDaemonStartOnce(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, '')
}

/** 清理未被 launcher 消费掉的 one-shot permit；重复清理也是安全的。 */
export async function clearArchiveDaemonStartOnce(filePath: string): Promise<void> {
  await fs.rm(filePath, { force: true })
}

/**
 * 判断部署探针是否达到“可以 arm 自动自愈”的基础健康状态。
 *
 * 不等待业务 turn，只检查 daemon 的基础设施闭环：PID、Bridge、DevSpace 门铃、
 * Guardian 和顶层 lastError。
 */
export function archiveDaemonSupervisorReady(current: {
  alive?: boolean
  state?: any
}): boolean {
  const state = current?.state
  return Boolean(
    current?.alive
    && state?.bridge?.listening === true
    && state?.devspace?.wake?.listening === true
    && state?.guardian
    && Number(state.guardian.healthFailures || 0) < 3
    && !state?.lastError,
  )
}
