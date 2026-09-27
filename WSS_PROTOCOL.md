# ChatGPT WSS / Live Transport 观测地图

> 最近核验：2026-09-27（ChatGPT Web / Chrome 153）。本文只记录本项目实际抓包、已安装客户端代码证据和明确标注的兼容假设。**topic、message envelope、business event、SSE event 是四层不同概念。**

## 1. 先把四层术语拆开

```text
WebSocket connection
  └─ protocol command / envelope
       ├─ connect / presence / subscribe / reply
       └─ message(topic_id = "...")
            └─ business payload
                 ├─ conversation-created
                 ├─ conversation-turn-complete
                 ├─ conversation-update
                 └─ conversation-history-update
```

因此：

- `conversations`、`alder-conversations` 是 **topic**；
- `conversation-created`、`conversation-turn-complete`、`conversation-update`、`conversation-history-update` 是 **business event type**；
- `async-task-update-message` / `async-task-steering-message` 是 `conversation-update` 里的 **update_type**；
- `safety_review_update`、`resume_conversation_token`、`stream_handoff`、`message_stream_complete` 是 `/backend-api/f/conversation` **HTTP SSE** 里的 typed event，不属于下面四个账户级 WSS topic。

当前账户 WSS URL 形状为 `wss://ws.chatgpt.com/.../ws/user/<redacted>?verify=<ephemeral>`；同一页面可能同时有多条 socket，不能把“一条 socket 没看到某 subscribe”理解成整个账户没有该 topic。

## 2. 2026-09-27 当前明确订阅的账户级 topic

| Topic | 当前 Web 是否显式订阅 | 已确认用途/事件 | 当前证据等级 | Archive 当前处理 |
| --- | --- | --- | --- | --- |
| `conversations` | **是** | `conversation-turn-complete`、`conversation-created`；历史还抓到过 `conversation-update` | **当前真机强证据** | 生命周期主路径；complete 触发 body sync |
| `alder-conversations` | **是** | 近期桌面 App 代码会用 `conversation-history-update` 刷新历史源；本机 Web 尚未抓到新鲜 history-update | **订阅强证据；事件归属待真机** | parser 接受，但 history-update 不启动 watchdog |
| `resource-updates` | **是** | 当前未建立与普通 conversation 生命周期的一一语义 | **当前订阅强证据，业务语义未定** | 只做控制面遥测，不当 conversation lifecycle |
| `app_notifications` | **是** | 账户/应用通知类通道；当前没有证据应拿它判普通 turn 生命周期 | **当前订阅强证据，业务语义未定** | 不当 conversation lifecycle |

### 历史 topic：`calpico-chatgpt`

2026-09-20～09-23 的本机 Guardian 日志曾明确看到页面订阅 `calpico-chatgpt`。2026-09-25～09-27 当前 Web 则稳定出现 `alder-conversations / resource-updates`。因此目前只把 `calpico-chatgpt` 记为**历史真实 topic**，不能宣称永久删除，也不能再把它写成 2026-09-27 当前依赖。

## 3. `conversations` topic 的当前真实线格式

2026-09-13、09-27 都抓到过这种双层 envelope：

```json
[
  {
    "type": "message",
    "topic_id": "conversations",
    "payload": {
      "type": "conversation-turn-complete",
      "payload": {
        "conversation_id": "<uuid>",
        "current_message_id": "<uuid>"
      }
    }
  }
]
```

新 conversation 还会出现：

```text
message(topic_id=conversations)
  -> payload.type = conversation-created
  -> payload.payload.conversation_id = <uuid>
```

真实顺序不保证是 `created -> complete`。2026-09-27 的新聊天样本曾观察到 `turn-complete` 后紧接 `conversation-created`，所以 Archive 不能拿事件到达顺序推断业务因果顺序。

## 4. 已知 business event 清单与“现在还能不能指望它”

| Event | 它是什么 | 最近证据 | 2026-09-27 能否依赖 |
| --- | --- | --- | --- |
| `conversation-turn-complete` | 某 conversation 的 turn 已收口通知 | **09-27 当前真机，反复出现** | **能。当前 Phase 2 实时主触发器。** |
| `conversation-created` | 新 conversation 被创建 | **09-27 当前真机** | **能观察；但只覆盖新聊天，不是普通 turn start。** |
| `conversation-update` | async/background conversation 的富更新事件 | 09-03 原始抓包；09-27 WSS safe summary 又看到 `async-task-update-message` / `async-task-steering-message` | **仍存在，但不能当通用 turn start。当前 envelope 需重新取证。** |
| `conversation-history-update` | 历史源需要 refresh 的事件 | 09-06 桌面 App 已安装代码有明确处理；09-13 两次本机普通 Web turn 都没出现 | **候选 early signal；本机 Web 尚不能依赖。** |
| `conversation-title-generated` | 标题变化兼容事件 | 代码兼容分支/fixture | **没有近期真机证据，不作为主逻辑。** |
| `conversation-turn-start` | 字面 turn-start 事件 | **至今没有真实本机抓包** | **不能依赖；只保留向前兼容。** |

### `conversation-update` 的两个已知 `update_type`

- `async-task-update-message`：历史原始样本可携带完整 `update_content.message` snapshot，并可能重复送达；2026-09-27 当前 safe WSS summary 再次看到该名字。
- `async-task-steering-message`：2026-09-27 当前 Guardian safe summary 已看到。

这里的关键边界是：**update 是富 message/progress snapshot，不是逐 token SSE，也不是所有普通 turn 都会出现。** 2026-09-13 两个受控普通 Web turn 只有最终 `conversation-turn-complete`，没有 update。

当前 daemon 的 `eventCounts` 仍只正式解析到 `created/complete`；虽然 control summary 已再次看到 update，但尚未取得 2026-09-27 当前 update 的脱敏完整 envelope，所以暂不把旧 fixture 强套到新 wire shape。

## 5. `alder-conversations` 与 `conversation-history-update`

这两个名字不是同一层：

```text
alder-conversations              <- topic
  └─ message(...)                <- envelope（待本机新样本确认）
       └─ conversation-history-update <- business event
```

为什么目前还监听它：

1. 2026-09-06 的统一 ChatGPT 桌面 App 已安装代码明确同时监听 `conversations` / `alder-conversations`；
2. 该客户端会在 `conversation-created / conversation-history-update / conversation-turn-complete` 时刷新历史源；
3. 当前 2026-09-27 Web Guardian 仍然**显式 subscribe alder-conversations**。

为什么又不能满心欢喜把它当 remote turn-start：

1. 09-13 本机 Web 两次受控普通 turn 都没出现 history-update；
2. 当前正式 Guardian 还没有一条解析成功的 `alder-conversations:conversation-history-update` 真机计数；
3. 所以 Archive 目前只“能观察、能 dirty”，**不把它升级成可靠 startsTurn/watchdog 起点**。

Remote Late-Attach 实验必须用 iPhone / Firefox / 独立 profile 真正从另一端启动长 turn，再看 Guardian 是否收到它，才能升级证据等级。

## 6. 动态 turn topic：`conversation-turn-<turn_exchange_id>`

这与上面四个账户级 catalogue topic 又是另一类东西。

当前 handoff/resume 实现和抓包资料显示，`stream_handoff` 可以给出类似：

```text
conversation-turn-<turn_exchange_id>
```

的动态 topic。其消息可包含 `conversation-turn-stream` / stream item，里面的 `encoded_item` 又能还原成 SSE block，用于 catchup/live continuation。

本项目已经验证：

- **handoff 不是所有 turn 必经路径**；2026-09-27 一条 GPT-5.6 Thinking 长工具 turn 约 329 KB SSE、17 个 `: ping`，直到 `[DONE]` 都没有 `stream_handoff`；
- `/f/conversation` SSE 会独立给出 `resume_conversation_token.token`；
- `/f/conversation/resume` 使用该 resume token 作为 `x-conduit-token`；
- 但“另一设备怎样重新获得正在运行 turn 的 resume credential”仍未解决。

因此 Phase 3 不能只押 WSS，也不能只押 HTTP SSE；正确抽象是一个 LiveTurn transport layer，同时接受 original SSE / resume SSE / turn-topic WSS。

## 7. Safety Review 不属于账户 WSS

`safety_review_update` 是 `/backend-api/f/conversation` SSE 中的事件。已知形状包含：

```json
{
  "type": "safety_review_update",
  "conversation_id": "<uuid>",
  "active": true,
  "protection_type": "cyber"
}
```

2026-09-27 本项目真实 SSE 实验确认：出现 review 后连接仍会继续 `: ping`，并可最终 `[DONE]`；所以 review 可能暂时门控可见输出，但**不能等同于 SSE 被关闭，也不能直接等同于 complete-no-final / active-zombie。**

旧 incident 没有 `safety_review_update` 字段不能证明“旧事故没有审核”：此前 Archive 根本没有持续保存 HTTP SSE 控制事件。只有从 Phase 3 LiveTurn recorder 上线之后，presence/absence 才开始具有取证意义。

## 8. 2026-09-27 后 daemon 的 WSS 状态字段

为了避免把“订阅过”与“真正收到过业务消息”再混在一起：

- `explicitSubscribedTopics`：本 Guardian generation 真实发送过 `subscribe` 的 topic；
- `observedMessageTopics`：真实收到过 `type=message` envelope 的 topic；
- `observedConversationEventTypes`：safe summary 中真实看到过的 `conversation-*` event type；
- `eventTopicCounts`：成功通过正式 business parser 后的 `topic:event` 计数。

其中 `eventTopicCounts` 证据等级最高；`observedConversationEventTypes` 只是说明帧里出现过这个 event 名，不反推它一定属于哪个 topic。

## 9. 当前依赖关系

```text
conversations / turn-complete
  -> realtime dirty + ready
  -> body overlap
  -> SQLite canonical archive

conversation-update
  -> opportunistic progress only
  -> envelope 重新取证中

alder/history-update
  -> passive candidate / dirty only
  -> 尚不启动 watchdog

original/resume SSE (Phase 3)
  -> exact local start + transport liveness
  -> resume token fingerprint / safety review / handoff / DONE

catalog async_status
  -> low-frequency late-start / gap fallback
  -> 不能单独证明模型正在计算
```

