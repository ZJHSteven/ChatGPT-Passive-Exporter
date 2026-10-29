/**
 * RQCI 公共任务的“最终结果”判定器。
 *
 * 上层消费者不应接触 Archive 的消息序号、流式 channel 或完成标志。
 * 此模块只在生产者内部读取 canonical SQLite 投影，并将最终回答转换成
 * 持久化的任务结果。尤其注意：channel=final 只表示输出通道，并非结束事件。
 */
import type { ActorSubmissionRecord, ActorSubmissionCompletion, ActorSubmissionServerError } from './actor-submission-queue.ts'

export interface CanonicalCompletionSource {
  getMessages(conversationId: string): Array<Record<string, unknown>>
}

/**
 * 与同一个 Conversation 中其他 turn 严格隔离：
 * 只接受已经获得 POST 绑定、且在本次 POST 时窗内存在完整相同 user prompt 的失败事件。
 * 当 SSE 能给出 turnExchangeId 时还必须严格匹配，以免将后来一轮错误错误归因。
 */
export function matchesSubmissionServerError(
  archive: CanonicalCompletionSource,
  record: ActorSubmissionRecord,
  error: ActorSubmissionServerError,
): boolean {
  if (record.status !== 'accepted') return false
  const cid = record.result?.conversationId ?? record.input.conversationId
  if (cid !== error.conversationId) return false
  const submittedAt = Number(record.result?.submittedAt)
  if (!Number.isFinite(submittedAt) || submittedAt <= 0) return false
  if (error.at < submittedAt - 15_000 || error.at > submittedAt + 30 * 60_000) return false
  return archive.getMessages(error.conversationId).some(message =>
    message.role === 'user'
    && message.text === record.input.text
    && Number(message.createTime || 0) * 1000 >= submittedAt - 15_000
    && (!error.turnExchangeId || message.turnExchangeId === error.turnExchangeId),
  )
}

/**
 * 精确匹配队列持久化的用户 prompt 与同一 turn 的 Assistant 结果。
 * 生成途中返回 null；只有最终状态与 endTurn 双重证据俱全才给出 completed。
 * 时间下限防止同一 Conversation 中历史上相同的 prompt 被误认为本次任务。
 */
export function resolveSubmissionCompletion(
  archive: CanonicalCompletionSource,
  record: ActorSubmissionRecord,
): ActorSubmissionCompletion | null {
  const conversationId = typeof record.result?.conversationId === 'string'
    ? record.result.conversationId
    : record.input.conversationId
  if (!conversationId || record.status !== 'accepted') return null

  const messages = archive.getMessages(conversationId)
  const submittedAt = Number(record.result?.submittedAt || record.createdAt)
  const floorSeconds = (submittedAt - 10_000) / 1000
  const users = messages.filter(message =>
    message.role === 'user'
    && message.text === record.input.text
    && Number(message.createTime || 0) >= floorSeconds,
  )
  const user = users.at(-1)
  if (!user) return null

  // 不通过“最后一条 Assistant”定位，防止跨 turn 或并发 steering 串答。
  const turnId = typeof user.turnExchangeId === 'string' ? user.turnExchangeId : null
  if (!turnId) return null
  const finals = messages.filter(message =>
    message.role === 'assistant'
    && message.channel === 'final'
    && message.turnExchangeId === turnId
    && Number(message.hidden || 0) === 0,
  )
  const final = finals.at(-1)
  if (!final) return null

  // 模型可能先把消息标成 final，再经过十几秒才真正 end_turn=true。
  // status 与 endTurn 任一缺失，都只能保持 pending，不能落盘或向外发送。
  // SQLite INTEGER boolean 读取后是 1；测试假数据/Bridge 映射也可能是 true。
  const endTurn = final.endTurn === true || final.endTurn === 1
  if (final.status !== 'finished_successfully' || !endTurn) return null
  const finishType = typeof final.finishType === 'string' ? final.finishType : null
  if (finishType && finishType !== 'stop') {
    return { status: 'failed', error: `assistant_finished_with_${finishType}`, completedAt: Date.now() }
  }
  if (typeof final.text !== 'string' || !final.text.trim()) {
    return { status: 'failed', error: 'assistant_final_empty', completedAt: Date.now() }
  }
  return {
    status: 'completed',
    completedAt: Date.now(),
    conversationId,
    turnExchangeId: turnId,
    messageId: typeof final.messageId === 'string' ? final.messageId : null,
    modelSlug: typeof final.resolvedModelSlug === 'string' ? final.resolvedModelSlug
      : typeof final.modelSlug === 'string' ? final.modelSlug : null,
    text: final.text,
  }
}
