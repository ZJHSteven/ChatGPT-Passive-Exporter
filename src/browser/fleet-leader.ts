/*
 * Fleet Watch 跨标签页 leader election。
 *
 * ChatGPT 首页可以同时开多张；如果每张首页都各自轮询 conversation list / stream_status，
 * 会制造重复流量。Chrome/Edge/Firefox 现代版本支持 Web Locks API，它天然适合做
 * “同一 origin 只允许一个 Fleet leader”。
 *
 * 设计：
 * - 所有首页都排队申请同一个 exclusive lock；
 * - 只有拿到锁的 tab 启动 Fleet 网络轮询；
 * - leader 页面关闭/pagehide 后自动释放锁，下一张首页接棒；
 * - 不用定时抢锁，不增加任何 ChatGPT 网络请求。
 */

export type FleetLeaderRole = 'leader' | 'waiting' | 'unsupported'

export interface FleetLeadershipController {
  role: () => FleetLeaderRole
  dispose: () => void
}

export interface FleetLeadershipOptions {
  onRoleChange?: (role: FleetLeaderRole) => void
}

const LOCK_NAME = 'chatgpt-companion/fleet-watch/v1'

export function installFleetLeadership(
  onAcquire: () => void | (() => void),
  options: FleetLeadershipOptions = {},
): FleetLeadershipController {
  let currentRole: FleetLeaderRole = 'waiting'
  let disposed = false
  let releaseLeader!: () => void
  const holdLeadership = new Promise<void>((resolve) => {
    releaseLeader = resolve
  })
  const abortController = new AbortController()

  const setRole = (next: FleetLeaderRole) => {
    if (currentRole === next) return
    currentRole = next
    options.onRoleChange?.(next)
  }

  const locks = navigator.locks
  if (!locks?.request) {
    // 旧浏览器不冒险启动多份主动 Fleet；宁可退化成“无全局监控”，也不要重复轮询。
    currentRole = 'unsupported'
    options.onRoleChange?.('unsupported')
    return {
      role: () => currentRole,
      dispose: () => {
        disposed = true
      },
    }
  }

  // 不使用 ifAvailable：follower 会在浏览器内部等待锁，不会轮询抢锁。
  // leader 关闭后下一张首页自然接棒。
  void locks.request(
    LOCK_NAME,
    { mode: 'exclusive', signal: abortController.signal },
    async () => {
      if (disposed) return
      setRole('leader')
      const cleanup = onAcquire()
      try {
        await holdLeadership
      }
      finally {
        cleanup?.()
        if (!disposed) setRole('waiting')
      }
    },
  ).catch(() => {
    // 页面卸载时 abort pending lock 是正常路径，不向用户制造错误。
  })

  const dispose = () => {
    if (disposed) return
    disposed = true
    releaseLeader()
    abortController.abort()
  }

  window.addEventListener('pagehide', dispose, { once: true })

  return {
    role: () => currentRole,
    dispose,
  }
}
