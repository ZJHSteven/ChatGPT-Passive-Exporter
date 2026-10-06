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

## 10. 2026-09-28 Tab / renderer 隔离实验

这组实验专门回答“Guardian / Actor 是否必须分 tab、一个 tab 能否轮转监听多个并发 SSE”。

### 不同 tab：HTTP SSE 彼此独立

Tab A 在 conversation `6ab9ab7e-...` 运行长工具 turn，原始 SSE `33772.1637` 已有 20 个 `dataReceived` / 66KB。随后独立 Tab B（另一个 renderer/target）在另一 conversation 发送短 turn；B 的 submit 时刻为 `1790552999191`。A 在 B 发送之后仍继续收到数据，`lastDataAt` 推进到 `1790553017851`，并增长为 24 个 event / 91KB，最终正常收到 6 个 ping、`message-stream-complete`、DONE，累计约 259KB。

因此**不同 renderer 的 page-local SSE 天然隔离**：B 导航/发送不会取消 A。无需为了同一账户 WSS 的不同 topic 开多个 tab；但不同 tab 对“并发发送/各自 page-local SSE”确实提供真实故障与 UI 状态隔离。

### 同一个 tab：SPA 导航不杀旧 SSE；2026-10-06 已确认还能并发启动新 conversation

第二轮 Tab A2 原始 SSE `33772.2242` 活跃时，在同一个 ChatGPT tab 中真实点击 sidebar 跳到另一 conversation：

- 点击前：7 个 data event / 19.8KB；
- 点击后 4 秒：旧 A2 SSE 仍活着，27 个 event / 58KB；
- 后续继续到至少 276 个 event / 186KB，并最终正常完成。

因此当前 ChatGPT SPA route change **不会自动 Abort 已经在跑的 `/f/conversation`**。

2026-09-28 当时还观察到：切到 B 后 ProseMirror 可输入 `SAMETABB928`，某一瞬间自动化没有看到 send button，于是保守推断“UI active-generation 状态跨路由，可能阻止第二 conversation send”。**2026-10-06 重新做真机实验后，这个推断被否定。**旧样本只能说明当时 DOM/控件观察没有跟上真实状态，不能再作为并发限制证据。

新的受控实验：长 turn A 原始 `/f/conversation` request 为 `61856.1055`。A 尚未出现 `[DONE]` 时：

1. 在 A 自己的 composer 输入 follow-up，当前 Web 发出 `POST /backend-api/f/steer_turn` request `61856.1092`；A 原始 SSE 继续运行。
2. 随后点击页面自己的“新聊天”按钮，SPA route 到 `/`；A 原 SSE 仍继续 heartbeat/data。
3. 在同一个 tab 发出新 conversation B：`POST /backend-api/f/conversation` request `61856.1126`，页面绑定 B CID `6ac4cb9b-...`。
4. B 于 10:21:29 收到 `[DONE]`；A 在 10:22:27 仍持续收到 SSE data/heartbeat。

因此当前真实语义是：

```text
同一个 ChatGPT tab/page target
  A conversation /f/conversation SSE 仍 active
      ├─ 同 A follow-up -> /f/steer_turn
      └─ SPA 切新聊天 B -> 新 /f/conversation SSE

A 与 B transport 可以同时存在
```

这与用户日常网页行为一致：A 正在生成时，输入新文字后 composer 会切出可提交形态；也可以离开 A、新建 B 并发送，A 在服务器/原 SSE 上继续运行。当前前端的 composer 按钮是动态状态机，`停止` 与 `发送` 可随输入、prepare、handler 重挂载切换；一次 Enter 还可能只触发 `/f/conversation/prepare`，随后再进入正式 submit。**因此“某一瞬间没有 `send-button` DOM”不等于不能发送。**

2026-09-28 据旧样本采用的“Guardian/Actor 分 tab 以规避 active-generation UI 锁”理由随之撤销。物理分 tab 不是协议要求，也不是并发 conversation 的要求。

### 2026-10-06 Guardian 直接兼任 Actor：new + continue 均成功

实验把现有 `archive-actor-state.json` 临时指向正式 Guardian target `880194...`，不修改 Actor 源码。Guardian 当时 `healthFailures=0 / rebuilds=0 / cooldown=null`，账户 WSS 为 3 条。

第一轮 new chat：

```text
targetId        = 880194...
conversationId  = 6ac4a8e4-...
/f/conversation = 200 text/event-stream
bindDelay       ~= 3.7s
send attempts   = 1
```

随后 Guardian 的 `conversations` topic 收到该轮 `conversation-turn-complete` 与 `conversation-created`。第二轮直接对 `6ac4a8e4-...` continuation：

```text
targetId        = 同一个 880194...
/f/conversation = 已发出
mode            = continue
bindDelay       ~= 49ms（URL 本来已经绑定该 CID）
```

几秒后同一 Guardian 再次收到 `conversation-turn-complete`。整个实验 Guardian targetId 未变化，daemon health 仍为 0 failure / 0 rebuild。因此：

```text
idle/finished Guardian
  -> new chat send       可行
  -> finished convo send 可行

same tab already has another active generation
  -> follow-up same conversation 可走 /f/steer_turn
  -> SPA route 到新 conversation 后仍可再发 /f/conversation
```

因此 `SAMETABB928` 不再定义任何“并发 active turn 限制”。

### 当前实现为什么仍不应立刻删掉独立 Actor

现 `sendActorPrompt()` 无条件先 `Page.navigate(targetUrl)`。在 Guardian 上跑两轮后，账户 WSS 发生：

```text
初始：3 sockets
new send 后：6 sockets overlap
continue 后：9 sockets overlap

conversation carrier:
59412.1672
  -> 59412.1990
  -> 59412.2303
```

每次 carrier 换代都会被 Archive 正确识别为 `conversation-transport-rotation` 并排队 gap-repair。也就是说“能发”已经证明，但当前 Actor 的整页导航会对 Guardian 的守护职责制造不必要 transport churn。

还有三个纯工程缺口：

1. **Guardian identity**：`ensureGuardian()` 当前重启时主要靠 URL query `chatgpt-archive-guardian=1` 找回 target；Actor 导航到 `/c/<id>` 会把 marker 丢掉。本次实验后用 `history.replaceState` 无刷新补回 marker，证明身份恢复不需要重新导航，但生产方案应持久化 target identity，而不是依赖临时手工修补。
2. **LiveTurn**：`refreshPassivePageObservers()` 明确排除 `guardian.targetId`；因此 Guardian 自己发出的 `/f/conversation` SSE 虽然成功，当前 Phase 3 tracker 不会记录它。本次两轮 daemon `liveTransport.active=0` 正好暴露这个缺口。
3. **429 cooldown**：Guardian cooldown 会通过 `Network.setBlockedURLs` 屏蔽 `/backend-api/conversations*` 与 `/backend-api/conversation/*`。新 chat submit 本身是 `/f/conversation` 不受影响，但 continuation 导航若需要 conversation body，合并模式下可能被本地 block 误伤，必须为显式 actor 操作定义门控。

因此当前更准确的架构含义是：

- **Guardian + Actor 可以合并为一个 page target**；没有协议层必须分 tab 的证据。
- **同一个 page target 也可以并发承载多个 conversation 的 active SSE**；不再因为“并发 active generation”自动引入 Actor pool。若未来保留多个 Actor，只能基于吞吐、故障隔离或资源策略，而不能再基于已被推翻的 UI 锁假设。
- **合并前必须先做 Guardian-aware actor**：避免不必要 full navigation、把 Guardian SSE 接入 LiveTurn、稳定 Guardian target identity，并处理 cooldown REST block。
- **账户 WSS topic 本来就应由一个 Guardian 多路复用**；不需要按 topic 或按 conversation 拆 tab。

## 11. 2026-09-28 same-profile resume credential 来源：IndexedDB persisted atom

此前 A/B late-attach 已反复证明：Tab A 原始 `/f/conversation` SSE 收到 `resume_conversation_token.token` 后，Tab B 打开同一正在运行的 conversation 可以自动发 `/f/conversation/resume`，且 B 请求使用的 resume credential 与 A 原 SSE token 完全相同。但 token 从哪里到达 B 一直没有闭环。

2026-09-28 经过逐层排除与哈希比对，same-profile 路径现已确认：

```text
Tab A original SSE
  -> resume_conversation_token.token
  -> first-party frontend persists resume capability
  -> IndexedDB: codex-browser-host
       object store: records
       key: codex.browser.persistedAtomState
       field: chatgpt-conversation-resume-tokens-v1
       index: [user/account identity, conversation_id]
       value.token: <419-char resume token>

Tab B (same Chrome profile)
  -> opens running conversation
  -> reads shared persisted atom
  -> x-conduit-token
  -> POST /backend-api/f/conversation/resume
  -> replay + live SSE
```

关键因果证据不是“B resume 后能找到 token”，而是一个全新的 turn `6ab9c001-...`：A 的 original SSE 在 `33772.6554` 首先记录 419 字符 resume token（只保存 SHA-256）。**B 此时仍停留在旧 conversation、从未导航进该新 CID**；在这个 pre-navigation 时刻扫描 B 所共享的 `codex-browser-host / records / codex.browser.persistedAtomState`，已经找到：

```text
$.chatgpt-conversation-resume-tokens-v1.[<user/account>, "6ab9c001-..."] .token
```

该字段长度 419，SHA-256 与 A 原始 SSE token 精确一致。因此 token 是 A 获得 SSE credential 后就进入 profile 共享 persisted state，不是 B 导航后从 conversation detail 临时生成。

同时已经排除本次 same-profile 样本中的几个简单来源：

- `RESUME_TOKEN_STORE_KEY` localStorage：导航前/成功 resume 后均为空容器，无 CID/token hash；
- Cookie（含 HttpOnly）：无 value hash 匹配；
- `BroadcastChannel` / `window.postMessage` / 可见 Service Worker message：fresh B 从 `about:blank` 注入监听，首页等待与导航期间均无 token 消息；
- 账户 WSS：fresh B 从首页建立三条 WSS 到导航进入 active conversation，只观察到 connect/presence/subscribe/reply，本次没有 frame 含 resume token hash；
- `stream_status`：protocol ledger 与实时 probe 均确认 JSON 只有 `status`，响应头也无 token；
- conversation detail：一组时间线中 B `/resume` 已在页面启动约 4.36 秒发出，而 `/conversations/{cid}?num_turns=...` 到约 8.74 秒才开始，故 detail body 不可能是该次 credential 来源。

### 重要边界：same-profile A/B 不再能证明跨设备 reacquisition

这个发现改变 Remote Late-Attach 实验解释：两个 Chrome tab 虽然在 UI 体验上与手机/电脑相似（sidebar 不一定实时刷新），但它们共享 `codex-browser-host` IndexedDB，因此**协议层并不独立**。same-profile A/B 可以证明 `/resume`、replay/live 语义和多流并存，但不能回答“iPhone/Firefox/另一个 profile 如何得到正在运行 turn 的 resume credential”。

下一步真正的 Remote Late-Attach 必须使用独立 storage context（独立 Chrome profile、Firefox 或手机）重新取证；如果独立客户端仍能 `/resume`，再寻找服务端账户级 credential reacquisition 路径。

## 12. 2026-10-03 Tokenless Late-Attach：当前 Web 不会自动重新领取 resume credential

为把“same-profile IndexedDB 共享”与“账户级服务端 reacquisition”彻底拆开，使用专用长 turn 做了受控实验。决定性样本 conversation 为 `6ac09cb3-...`：任务仍在运行时，A 页已经获得并持久化 resume capability；随后依次执行：

1. 关闭 A 页，避免它继续把内存 capability 回写 profile storage；
2. 只删除 `chatgpt-conversation-resume-tokens-v1` 中该测试 CID 的一项；
3. 复查 IndexedDB，确认该 CID 条目稳定不存在；
4. fresh B 页从 `about:blank` 开始挂 Network，再导航到同一个仍在运行的 conversation。

B 页第一轮真实请求顺序：

```text
GET  /backend-api/conversation/init                         -> 200
GET  /backend-api/conversation/<cid>/stream_status         -> 200 {"status":"IS_STREAMING"}
POST /backend-api/f/conversation/resume                    -> 404 application/json
GET  /backend-api/conversation/<cid>/stream_status         -> 200 {"status":"IS_STREAMING"}
```

同时再次读取 `codex-browser-host`：该 CID 的 resume token 条目仍不存在，没有出现“服务器重新下发 token 后回写 IndexedDB”的行为。

页面进入用户可见状态：

```text
连接已中断，正在等待完整答复
```

之后 B 没有新的成功 `/resume`，而是约每 5～6 秒轮询一次 `stream_status`。本次完整状态序列为：

```text
IS_STREAMING
IS_STREAMING
IS_STREAMING
IS_STREAMING
IS_STREAMING
IS_STREAMING
IS_STREAMING
IS_STREAMING
COMPLETE
```

状态切到 `COMPLETE` 后，页面一次性显示完整 final，并出现“回答已完成”。

因此当前 Web 的可证实 fallback 是：

```text
有 resume credential
  -> /f/conversation/resume
  -> replay + live SSE

无 resume credential
  -> stream_status
  -> /resume 404
  -> status polling
  -> COMPLETE
  -> 最终 canonical body/final
```

这直接解释过去的 UI 体感：另一个 tab/设备“能打开正在运行的 conversation、看到已经持久化的中间内容”，并不自动证明它已经加入 live stream。缺 credential 时，Web 可以展示已有快照，但会进入“等待完整答复”模式，而不是继续收到新的 token/delta。

证据边界：本实验是在同一 Chrome profile 中人为删除该 CID 的 persisted capability，而不是物理 iPhone/Firefox；但它已经排除了“只凭 account + conversation_id，当前 Web 会自动从服务端重新领取 resume token”这一简单模型。真正跨设备若存在更强 capability 同步，必须来自另一个客户端实现/同步层，不能从当前 Web 行为直接推出。

Phase 3 架构含义：Remote Late-Attach 不应再把 `/resume` 当作 universal 跨设备入口。对没有 resume credential 的 turn，若要获得实时 delta，下一条值得验证的主路线是动态 `conversation-turn-*` WSS 的 catchup/live；否则只能接受 `stream_status + final body` 的非实时降级路径。

## 13. `conversation-turn-*` WSS：已知 wire shape 与当前证据边界

2026-10-03 对多套近期独立实现做交叉核对，turn-topic 的订阅与返回 shape 高度一致：

```json
[
  {
    "id": 5,
    "command": {
      "type": "subscribe",
      "topic_id": "conversation-turn-<turn-id>",
      "offset": "0"
    }
  }
]
```

订阅回复：

```text
reply.type = subscribe
reply.topic_id = conversation-turn-...
reply.recovered = true/false
reply.last_offset = <opaque, optional>
reply.catchups[] = historical turn-stream messages
```

实时/历史 message：

```text
type = message
topic_id = conversation-turn-...
offset = <opaque>
payload.type = conversation-turn-stream
payload.payload.type = stream-item | heartbeat | done
stream-item.encoded_item = <SSE-framed text>
```

其中 `encoded_item` 已是 `event:/data:` 形式的 SSE 文本，不应再自行猜测 base64/压缩编码。近期实现也显示 `resume_conversation_token` JWT 可携带 `turn_topic_id`；正常 handoff 应优先相信服务端下发的 topic，而不是永久假设它一定等于字符串拼接结果。

当前本账户证据边界必须单独注明：`active-turn-trace.jsonl` 截至 2026-10-03 的 `stream-handoff` 计数仍为 0，正式 daemon 也没有历史 `conversation-turn-*` subscribe/ACK fixture。因此上述 wire shape 是近期独立实现/公开浏览器审计的强交叉证据，但还不是本账户 first-party 捕获。

项目已增加纯被动 recorder：不自行创建认证 WSS、不主动 subscribe。只要第一方页面自然 handoff，CDP 会记录 subscribe/ACK/catchup/live 的脱敏控制面，并将仅内存中的 `encoded_item` 送入现有 LiveTurn parser。这样下一次自然样本出现后即可把本节从“交叉实现证据”升级为“本账户真机证据”。

另一个 2026-10-03 新鲜变化：Guardian fresh reload 同时观察到新的账户 topic `calpico-chatgpt-messaging`，与 `resource-updates` 共用一条 socket；`conversations / alder-conversations / app_notifications / resource-updates` 仍存在。它目前只记为新订阅面，不赋予未验证的 conversation lifecycle 语义。

## 14. 2026-10-06 两个真实 iPhone -> PC late-open：所谓“续流”可以只是 checkpoint polling

2026-10-06 不再使用人工构造测试，而是直接抓两个正在运行、由 iPhone 发起的真实长 turn：

- `6aa63b4d-...`，标题“分析异常终止原因”；
- `6ab9aad3-...`，标题“分析 Watchdog 延迟”。

PC 在这两个 conversation 的当前 turn 已经运行后，才 fresh-open 新 ChatGPT tab。两次第一方 Web 行为高度一致。

### 14.1 late-open 的 transport 序列

核心序列：

```text
POST /backend-api/conversation/init
GET  /backend-api/conversation/<cid>/stream_status
  -> {"status":"IS_STREAMING"}
POST /backend-api/f/conversation/resume
  -> 无 x-conduit-token
  -> 404
GET  /backend-api/conversations/<cid>?num_turns=10&include_has_versions=true
```

页面初始会出现：

```text
连接已中断，正在等待完整答复
```

之后没有观察到成功 resume SSE，也没有任何 `conversation-turn-*` subscribe/ACK/catchup/live。新 tab 只订阅普通账户 topics：

```text
conversations
alder-conversations
resource-updates
calpico-chatgpt-messaging
app_notifications
```

### 14.2 `/resume` 失败后不是完全静止，而是持续拉 canonical checkpoint

两个 tab 都进入大致 7~10 秒一次的循环：

```text
GET stream_status
GET conversation body
```

状态长期保持 `IS_STREAMING / async_status=3`，但 conversation body 的 canonical tail 会间歇推进。

当前会话样本：

```text
current_node 863b...  update_time=1791264756.912
        -> 1772...    update_time=1791264823.646
        -> a021...    update_time=1791264846.313
```

对应当前 turn identity 始终保持：

```text
turn_exchange_id = d7e693fc-...
request_id       = ba988fb4-...
```

Watchdog 会话样本：

```text
current_node 1531...  update_time=1791264868.881
        -> 36a5...    update_time=1791264933.695
        -> 4ab6...    update_time=1791264998.464
```

对应 turn identity 始终保持：

```text
turn_exchange_id = b231f002-...
request_id       = e131191b-...
```

因此需要把过去口语里统称的“跨设备续流”至少拆成三类：

```text
1. live transport
   SSE / resume SSE / conversation-turn-* WSS
   -> token/delta 级实时数据

2. canonical checkpoint refresh
   stream_status + repeated conversation body
   -> 节点/工具结果/持久化快照按数秒~数十秒粒度更新

3. final-only fallback
   只等 COMPLETE 后一次性拿 final body
```

2026-10-06 这两个真实 iPhone -> PC 样本属于第 2 类，而不是第 1 类。对长工具 turn，第 2 类在视觉上可能很像“电脑后来加入后还在继续长”，因为 reasoning/tool/message 节点会随着服务器 checkpoint 被周期 body 请求带回来；但它不是原始 token stream。

### 14.3 PC 从哪里得到 turn_exchange_id

两个样本的 `conversation/init` 响应均只有：

```text
atlas_mode_enabled
banner_info
blocked_features
default_model_slug
intended_default_model_slug
limits_progress
model_limits
type
```

没有 `turn_exchange_id / working_turn_id / request_id / topic_id`。Flight recorder 捕获到的其它非 conversation-body JSON 响应也没有 turn 级 identity。

PC 第一次明确拿到当前 turn identity 的地方，是 conversation body 本身。由此目前可证实的 late-open identity 链是：

```text
conversation_id
  -> GET conversation body
  -> metadata.turn_exchange_id / working_turn_id / request_id
```

这说明 turn ID 很有价值，但当前样本里它不是账户级 WSS 的早期 start 通知；它是在 body checkpoint 路径中被发现的。

### 14.4 对 start detector 的意义与证据边界

当前常驻 daemon 在 2026-10-06 当前 turn 开始前后，没有记录到携带该 CID 的 WSS start event；active-turn trace 也没有在 PC late-open 之前形成该 conversation 的可靠 WSS start。与此同时，fresh helper 的第一方 native conversation list 能看到：

```text
conversation id = 6aa63b4d-...
async_status = 3
update_time = 2026-10-06T05:31:20.509299Z
```

因此目前工程上最现实的 fallback 仍然是：

```text
passive/native catalog 发现 active CID
  -> body 获取 turn identity
  -> watchdog / Phase 3 关联
```

但必须保留限制：本次专用 flight recorder 是 turn 已开始约 1 分钟后才启动，虽然长期 daemon 当时在线，也不能仅凭“没有抓到”绝对证明服务端在 turn 最初几百毫秒内从不存在某个 transient start event。结论应写成“现有账户 WSS 没有提供我们可依赖的稳定 start/turn identity”，而不是“协议层绝无 start 事件”。

### 14.5 仍未推翻 handoff 分支

本实验进一步证明“跨设备看到进度”不需要 turn-WSS；但它也没有证明 `stream_handoff -> conversation-turn-*` 分支不存在。项目的自然 handoff first-party 计数仍为 0，纯被动 recorder 继续保留。今后若某个 turn 真出现 handoff，应单独归入第 1 类 live transport，而不能与这里的 checkpoint polling 混为一谈。

