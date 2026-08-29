import type { FleetAlert } from './fleet-watch'

/**
 * 第一阶段只做浏览器/桌面通知。
 *
 * 这是有意的：Userscript 运行在网页上下文里，若直接向任意第三方 push 服务发送消息，
 * 会引入新的凭据、CORS、隐私与可靠性问题。手机推送应放到后续 Companion daemon / Webhook
 * 层，统一从本地事件日志转发；这里先把“发现异常后真的提醒用户”闭环做起来。
 */

export interface DesktopNotificationState {
  supported: boolean
  permission: NotificationPermission | 'unsupported'
}

export function desktopNotificationState(): DesktopNotificationState {
  if (!('Notification' in window)) return { supported: false, permission: 'unsupported' }
  return { supported: true, permission: Notification.permission }
}

/** 必须由用户点击菜单触发，否则浏览器通常会拒绝权限请求。 */
export async function requestDesktopNotificationPermission(): Promise<DesktopNotificationState> {
  if (!('Notification' in window)) return { supported: false, permission: 'unsupported' }
  const permission = await Notification.requestPermission()
  return { supported: true, permission }
}

export function notifyFleetAlert(alert: FleetAlert): boolean {
  if (!('Notification' in window) || Notification.permission !== 'granted') return false

  const notification = new Notification(`ChatGPT 任务异常：${alert.title}`, {
    body: alert.reason,
    tag: `chatgpt-run-watch:${alert.conversationId}`,
    requireInteraction: true,
  })
  notification.onclick = () => {
    window.focus()
    window.open(`https://chatgpt.com/c/${encodeURIComponent(alert.conversationId)}`, '_blank', 'noopener,noreferrer')
    notification.close()
  }
  return true
}
