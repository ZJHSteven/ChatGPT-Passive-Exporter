## 2026-09-27 WSS 语义、Zombie 时序、Phase 3/4 继续实现 ExecPlan

- [done] 重新建立 WSS 分层词汇表：已新增 `WSS_PROTOCOL.md`，严格区分 `socket -> topic -> message envelope -> business event/update_type`，并按当前真机/历史/兼容三档标注证据。`conversation-created / conversation-turn-complete / conversation-update / conversation-history-update` 都是业务事件类型，不是 topic；当前稳定生命周期事件来自 `conversations`，`conversation-history-update` 仍只是 `alder-conversations` 候选。
- [done] 修复 catalog late-start watchdog 的跨 turn 计时污染：watchdog body 现在记录 turn identity；若同一 conversation 的诊断已从 turn A 变成 turn B，B 会以“首次确认看到 B”的时刻重新开始完整 watchdog 窗口，不能继承 A 的年龄直接立 `active-zombie`。
- [done] WSS state 已拆分 `explicitSubscribedTopics / observedMessageTopics / observedConversationEventTypes / eventTopicCounts`；短时间没看到 subscribe ACK 不再等价于 topic 退役。2026-09-28 当前 daemon 已再次确认四个显式 topic，实际 conversation business message 目前来自 `conversations`。
- [pending] 捕获当前 `conversation-update` 的真实 2026-09-27 wire shape。现有 WSS control summary 已再次看到 `async-task-update-message / async-task-steering-message`，但正式 `eventCounts` 仍只解析到 `conversation-created / conversation-turn-complete`，说明 update 的当前 envelope 与旧 fixture 可能不同；先脱敏保存结构，再决定是否扩 parser，禁止凭旧测试臆改。
- [done] Phase 3 HTTP LiveTurn observer：普通 ChatGPT 页已经发生的 `/f/conversation` 与 `/resume` SSE 已通过 `Network.streamResourceContent + dataReceived` 被动接入，只保存 conversation/turn id、resume credential 的 hash/长度、`: ping`、handoff、safety review、message-stream-complete、DONE 与网络收口，不保存原 token/正文。2026-09-28 production E2E `PHASE3LIVE928` 已验证 `Actor POST -> resume-token -> turn id -> message-stream-complete -> DONE -> stream-finished -> WSS complete -> canonical final` 同一 turn 闭环。动态 `conversation-turn-*` WSS 合流仍属后续 StreamHub。
- [in_progress] Remote Late-Attach / Native UI Attach A/B：Tab 隔离部分已完成——独立 B renderer 的发送不影响 A SSE；同一 A renderer 的 sidebar SPA 导航也不会 Abort 原 SSE，但 active-generation UI 状态会跨 route，阻止安全的同-tab并发发送。剩余关键问题是“B 导航到正在运行的 A conversation 时，第一方 JS 是否会自动发 `/f/conversation/resume`、resume credential 从哪里取得”，以及跨设备 iPhone/Firefox early discovery。
- [done] Phase 4 Actor 第二阶段：`actor send --conversation <UUID>` 已支持在已有 canonical conversation 发新 turn，并完成真实 `ACTORNEW927 -> ACTORCONTINUE927` E2E。2026-09-28 又修正当前 ProseMirror / `data-chatgpt-composer` UI 漂移并成功发送 `PHASE3LIVE928`。`steer`、project 内新建、move project、archive、delete 仍明确未实现，逐项先抓第一方 native 行为再扩展。
- [pending] Protocol Drift Learning 从“只报警”升级为受控维护流水线：passive 观察新 shape -> 自动生成候选 adapter/template/fixture（quarantine）-> 本地静态/fixture 验证 -> 人工 approve -> 单次 canary -> 才允许生产 replay。永不让未审候选直接自动请求 ChatGPT，404/401/403/429 立即熔断并报警。
- [pending] 增加 Recovery Capsule 设计：每个长 turn 在关键里程碑/临近执行窗口时可落一个小型状态胶囊，保存用户目标摘要、已确认结论、完成动作、关键文件/commit、未决问题、下一步、拟给用户的最终回复要点；不保存隐藏 chain-of-thought。DevSpace audit 继续保存原始工具调用，Capsule 负责补足“为什么做到这里/接下来准备收什么尾”。
- [pending] 用本地真实 `reasoning_recap` + DevSpace audit 统计长 turn 分布，重新决定 checkpoint/watchdog 阈值；25~26 分钟只能作为高风险经验峰，不再写成硬上限。checkpoint 可以早于 watchdog，多级提醒而不宣布故障。

## 2026-09-27 Phase 3 Token / Handoff 与 Watchdog 正确性 ExecPlan

- [done] 用真实 ChatGPT Web A/B 标签完成 transport 取证：`/f/conversation/prepare` 返回 350 字符发送 `conduit_token`，正式 `/f/conversation` 的 `x-conduit-token` 与之逐字相同；SSE 另行下发 419 字符 `resume_conversation_token.token`，与发送 token 不同，并直接暴露 `conversation_id` / `turn_exchange_id`。
- [done] 复现纯 SSE 路径：GPT-5.6 Thinking 工具型长 turn 累计约 329 KB SSE、17 次 `: ping` 后 `[DONE]`，全程没有 `stream_handoff`；证明 handoff 不是所有 turn 的必经路径。
- [done] 复现 late-open 失败路径：第二标签页可通过 conversation detail 看到当时已持久化的中间快照，但官方 `/f/conversation/resume` 在没有 resume conduit credential 时返回 404；随后 12 秒页面正文不再增长且无新请求，证明“看到进行中快照”不能等同于已成功 live attach。
- [done] 交叉核验近期逆向实现：发送 conduit token 来自 `/f/conversation/prepare`；handoff/resume 实现把 SSE `resume_conversation_token.token` 作为 `/f/conversation/resume` 的 `x-conduit-token`。近期真机资料同时存在“纯 SSE 到 DONE”和“SSE handoff 后正文走 conversation-turn-* WSS”两种模式，当前没有可靠证据表明客户端可以强制 handoff。
- [done] 记录 safety review 新证据：近期真实 CDP 项目已观测 `safety_review_update`；review active 时 SSE 可以继续保持 `: ping` 心跳而暂时无正文，因此 review 是独立 transient activity/forensic 维度，不能先验等同于 `complete-no-final` 或 `active-zombie`，也不能把“正文停止增长”直接判死。
- [done] 修正 watchdog：catalog late-start 超时只允许首次进入 diagnostic/立案；同一长期 `active-zombie` 在没有新证据时不再每 30 分钟主动抓 body。只有新的 lifecycle 事件或 catalog `update_time` 真正推进后才重新武装，并从最后进展再等满一个 watchdog 窗口。
- [done] 修正 WSS complete → body settle 竞态：`conversation-turn-complete` / catalog async-complete 到达后，如果首次 body 仍没有明确 final/interrupted，不立即创建/通知 `complete-no-final`；先保存事实，再给第一方页面 15 秒被动 settle window，窗口内优先复用自然 body response，仍无新 passive body 才至多补一次主动复核；`:settle` 第二次仍无 final 才立案且不再循环。
- [in_progress] Phase 3 LiveTurn observer：HTTP SSE 控制面已经 production E2E；原始 `/f/conversation` 与 `/resume` 都可接入，resume token 只存 hash/长度，Safety Review/heartbeat/handoff/DONE 都有结构化事件。剩余工作是出现 `conversation-turn-*` WSS 时把 catchup/live encoded SSE 合并进同一 turn trace，并做 Remote Late-Attach。
- [pending] 继续 Remote Late-Attach Probe：重点研究“非发送设备如何取得当前 turn 的 resume credential”。同 profile 不再假定自动共享；`RESUME_TOKEN_STORE_KEY` 只能作为有条件证据，必须以当前 turn 的实际官方请求为准。
- [done] Phase 4 第二轮 controlled smoke：单 Actor、官方 React send handler 已验证 existing-conversation send；2026-09-28 `PHASE3LIVE928` 又完成 `send -> CID bind -> LiveTurn observer -> WSS complete -> body final` 全链路。Guardian 继续保持独立监控，不与 Actor 合并。

## 2026-09-25 Guardian 自愈与 429 风暴修复 ExecPlan

- [done] 复盘 21:23～21:37 Guardian/CDP 故障链，区分“首次 renderer/CDP 卡顿”与“恢复逻辑把一次故障放大成 REST 风暴”。确认旧链路会在每次 Guardian recover 后立即执行多页 catalog reconciliation，并在主循环错误后反复拆/建同一 Guardian。
- [done] Guardian 健康检查改为连续失败阈值：单次 CDP Runtime 探活超时只记录，不立即拆页；连续 3 次失败才重建，成功一次即清零。
- [done] Guardian/WSS gap repair 统一为 deferred/debounced reconciliation：先恢复 WSS；默认稳定 30 秒后才允许一次低频 catalog overlap；多次 recover/reconnect 合并为同一 pending repair，repair 尝试之间至少 10 分钟。
- [done] 429 cooldown 到期后不再自动执行完整 catalog 扫描作为 probe；先恢复被动 WSS，已知 ready conversation 按全局节流逐条 body 同步，periodic 基准从 429 时刻重新计算。
- [done] 增加纯函数/状态机测试，覆盖 Guardian 连续失败阈值、gap repair 去抖/最小间隔、cooldown 门控；定向 14/14、全量 17 files / 103 tests、TypeScript typecheck 全部通过。
- [done] 最新 daemon 已以 --no-reconcile-on-start 部署为 PID 29464；WSS 3 条在线，四个 topic 已订阅，healthFailures=0、rebuilds=0、pendingGapRepair=null，启动后无立即 catalog sweep、无新 429。

## 2026-09-25 Active Zombie / Watchdog 兜底 ExecPlan

- [done] 现场确认 FrameForge 新会话 `6ab63c6c-02f4-83ea-a535-d849e3962d8f` 属于“页面/目录可见、正文 API 可返回、旧执行 resume=404、catalog 长期 active、可靠 start/complete 缺失”的 zombie 样本；已人工结束旧僵尸 turn，并仅发送“异常终止了，请继续。”启动新 turn。
- [done] 把 `active-zombie / persistent-active-stall` 从仅文档化表型提升为正式 lifecycle class；仍与 `complete-no-final`、`explicit-interrupted`、`ghost-execution / persistence-stall` 分层，不把 tail subtype 当根因。
- [done] 放宽 watchdog 的 discovery 起点：当 reconciliation 首次看到某 conversation `async_status=3/5`，且没有更可靠的 start 记录时，以“首次观察到 active 的时刻”作为保守的 late-start 下界登记 watchdog。它必然晚于真实 POST，因此只会让超时报警更晚，不会让 30 分钟阈值提前误报。
- [done] catalog-late-start watchdog 超时后立即抓一次 conversation body；若 body 已明确 final/interrupted，则清理 active，不建 zombie incident；若仍无 final 则建立 `active-zombie` incident 并通知。
- [done] 审计近两周异常研究聊天与当前 incident schema，已新增 `INCIDENT_TAXONOMY.md`，分清“正式 lifecycle / tail/head 结构维度 / execution-persistence forensic / UI-only / discovery blind spot”，并记录 6 组真实样本。
- [pending] DevSpace `openai/session` metadata 继续作为更快的 supplementary discovery 候选：后续只在能稳定绑定 metadata -> conversation UUID 后接入，不为本次保底 watchdog 强行修改 DevSpace 服务端。

## 2026-09-25 Phase 3 / Phase 4 收口 ExecPlan

- [done] 用 ChatGPT Archive 回溯并合并《分析异常终止原因》《分析会话ID关系》《并发异常研究》《Shadowrocket抓包事件通知》四条历史主线。最终不再寻找“唯一 start 信号”，而是把本机精确 start、跨设备 early discovery、MCP metadata 辅助发现和 gap recovery 分层。
- [done] Phase 4 定案为 browser-native Actor：Guardian 永远只做稳定监控；Actor 使用真实 ChatGPT 页面与官方 React send handler，Sentinel、prepare、fresh challenge、PoW、Turnstile 和请求头全交给官方前端处理，Archive 只驱动并观察。默认复用 1 个 Actor；真正并发发送时再扩为 2～3 个小型 Actor pool，不自己实现 PoW solver。
- [done] DevSpace openai/session 定位为 supplementary discovery plane：它是 MCP 侧同 conversation 的稳定匿名键，可通过本地 binding 关联 canonical conversation UUID；但它天然晚于最初 /f/conversation 建链，且无工具 turn 不会出现，因此可作为工具型长任务的 watchdog/dirty 触发证据，不能冒充所有 turn 的精确 start，也不能直接加入手机已经存在的 HTTP SSE。
- [done] MITM / Shadowrocket 降级为可选手机传感器，不做主架构依赖。若真机可解密并拿到 endpoint/CID，可提供很早的 generation-intent；若受 pinning/QUIC 等限制，只能提供较弱的网络行为候选信号。
- [in_progress] Phase 3 主线定为 Live Turn Capture + StreamHub：本机 Actor/Chrome 从真实 POST /backend-api/f/conversation 获得精确 start；跨设备优先寻找账户 WSS early event，然后读取最新 body 得到 turn_exchange_id，晚接 conversation-turn-<turn_exchange_id> 的 catchup/live 通道。监控必须由一条账户级 StreamHub 多路复用，不允许“一条 turn 一个 ChatGPT tab”。
- [done] 修复第一处 discovery 观测盲区：Guardian 虽已订阅 alder-conversations，旧 parser 却只接受 conversations。解析器现同时接受两者，并在 daemon state 新增 eventTopicCounts，可直接区分 conversation-history-update 等事件来自哪个 topic；事件证据等级保持不变，history-update 在真机验证前仍不会启动 watchdog。
- [pending] 做 Remote Late-Attach Probe：由 iPhone / Firefox / 独立 profile 启动 3～5 分钟工具 turn，Guardian 同时观察 conversations + alder-conversations；捕获首个 early event 后读取最新 body 的 turn_exchange_id，尝试订阅 conversation-turn-*，验证 ACK、catchups 起点、live delta 与 complete。
- [pending] 为本机 Actor 增加持久 LiveTurn transport observer。优先使用 CDP Network.streamResourceContent(requestId) + Network.dataReceived 读取页面已经收到的 /f/conversation 流，不改写 fetch/Response；只把脱敏后的 transport 元数据、handoff/topic/turn id 与生命周期写入 transient trace，不把认证头或完整用户/工具正文写入控制面日志。
- [pending] Remote Late-Attach 证实后实现单例 StreamHub：复用 Guardian/account WSS 动态订阅多个 conversation-turn-* topic，保存 offset/catchup/live 顺序并与 Active Turn Recorder / incident watchdog 统一；DevSpace metadata binding 作为工具型跨设备 turn 的补充唤醒源接入同一状态机。

## 2026-09-24 图片生成归档 / ImageGen incident ExecPlan

- [done] 用《漫画分镜设计》真实会话还原 ImageGen 持久化协议：确认 `role=tool + channel=final + content_type=multimodal_text`、`image_asset_pointer`、`sediment://file_*`、`generation.gen_id`、`notification_channel_id=image_gen` 与 turn lifecycle 的关系，并区分普通 tool/reasoning 尾型。
- [done] 确认 ChatGPT Web 会把稳定 `sediment://file_*` 解析为 `/backend-api/estuary/content?id=file_*&...&sig=...` 的短期签名 URL；真实页面 fetch 已验证可取得与 body `size_bytes` 一致的 PNG。长期归档不保存 `sig/ts`。
- [done] 完成 live image asset 持久化：SQLite 只保存结构化元数据/本地相对路径/hash，不把大二进制塞进主库；图片独立落到 `data/assets/chatgpt/`，支持一轮多图、稳定 pointer 去重、SHA-256 与失败重试。
- [done] 扩展 rich manifest：结构化 `image_asset_pointer` 现在保存为 `generated-image` / `image-asset`，保留 pointer、file id、MIME、尺寸、字节数、generation/gen_id 等非敏感元数据，`archive show --format resources` 可审计多图。
- [done] 增加 ImageGen-aware terminal classification：完成的 image tool node 复用 `terminalEvidence=final`，同时以 `tailShape=image-generation-final` 独立标记，不再误建普通 `complete-no-final` error；手机另发“图片节点”提示并按 message 去重。
- [in_progress] 修复真实环境图片本体仍 pending 的最后缺口：当前 DOM hydration 依赖历史图片仍存在于虚拟化 DOM，真实漫画会话 14 个 generated-image 均未自动落盘。改为主路径被动监听已打开 ChatGPT conversation 页自然发生的 `/estuary/content` 响应，直接通过 CDP 读取响应体并匹配 SQLite 的稳定 file id；不滚动、不导航、不重放请求。DOM signed-URL fetch 仅保留 daemon 冷启动后“页面已经加载过图片”的受控 fallback。
- [done] 追加严格受控的 active resolver fallback。2026-09-27 当前 ChatGPT Web bundle 已确认标准图片解析逻辑：稳定 `sediment://file_*` 去 scheme 后调用 `Request.safeGet('/files/download/{file_id}')`；返回 `status` 若存在必须为 `success`，同时要求 `download_url`。普通页面 `fetch(...credentials)` 因缺应用层 Authorization 实测返回 403。daemon 复用已经存在、只驻留内存的 first-party authHeaders，并通过 Guardian 请求 `/backend-api/files/download/{file_id}`；返回 URL 必须再次校验为 ChatGPT `/backend-api/estuary/content` 且 `id` 与 stable file id 完全一致。被动响应/DOM signed URL 始终优先，主动 resolver 每个 hydration 周期最多补 1 张并继续服从统一请求间隔与 429 cooldown。
- [done] resolver payload 校验、file-id pending 查询、CDP binary response 解码等回归已补齐；定向 41/41、全量 109/109、typecheck 与全 build 均通过。
- [pending] 真实 active-resolver E2E：本次启动后 Guardian 原生 sidebar/TPP 请求先触发 HTTP 429，daemon 正确进入 cooldown，`activeResolverAttempts=0`，未人为绕过限流。待正常 request window 恢复后确认 pending 图片落盘、`pendingGenerated` 下降及 SHA-256/字节数一致。

## 2026-09-22 Incident 手机推送收口 ExecPlan

- [pending] 补齐 `no-complete / no-final` 实时发现盲区。2026-09-24《漫画分镜设计》真实样本证明：turn 可在没有 `conversation-turn-complete`、也没有可靠 turn-start 的情况下停止生成；此时 `activeTurns` 不会登记，watchdog 无法启动，只有后续新 user turn / gap reconciliation 才能历史补账。手机通知层本身无故障，根因是 incident discovery 不完整。后续需优先研究可被动捕获的 turn-start / stream / alder-conversations 信号；历史补账通知仅作为兜底，不能冒充实时检测。
- [pending] 重新评估 catalog fallback 的证据等级与调度假设：WSS “约 30 分钟轮换”只能作为历史观测，不能当可靠定时器；正式 daemon 已观察到单 socket 跨数小时不 reconnect。Conversation List `async_status` 也会滞后（已出现 body 明确 final 后数分钟仍为 `3/active`），所以 standalone `3/4/5` 不能直接等价于当前 turn 状态。后续应研究 `update_time + 本地 last turn identity + async_status` 的组合证据，或把固定低频 reconciliation 与 WSS reconnect 解耦，而不是假定 reconnect 自带半小时保底。
- [in_progress] 重新收紧 incident 分层语义：`lifecycleClass` 只回答“为什么这一轮算事故”，`tailShape` 只回答“最后持久化到哪一层”，`reason` 仅作为两者的可读摘要；同时审计历史遗留的笼统 `abnormal-terminal` 桶，避免把 tail subtype 再次误当主类。
- [done] 将 Bark 通知从 Archive `syncInFlight` 主链彻底旁路化：conversation/body/incident 先完成 SQLite 落盘并释放同步锁，通知只做 fire-and-forget 分支；通知超时/重试不得阻塞下一条 conversation sync。TypeScript 与 Vitest 17 files / 95 tests 全过。
- [done] 修复已确认 incident 被普通 reconcile 刷新后人类可读 reason 退化的问题：`complete-no-final` 继续保留“已确认 turn 完成但没有 final”的 lifecycle 语义；`explicit-interrupted` 不允许被后续缺失终止证据的快照降级。
- [done] 手机通知触发从“只看 incident id 是否新建”升级为“看 material lifecycle transition”：新 turn incident 必推；同一 turn 从 watchdog timeout 升级为 confirmed abnormal / explicit interrupted 也会再次提醒；单纯 tail/body 细节刷新不重复轰炸。
- [done] Bark transport 从兼容 GET URL 切换到官方 V2 `POST /push` JSON；Archive Core 与通知失败继续隔离，并对瞬时网络错误/429/5xx 做一次轻量重试。
- [done] 本机 `data/archive-notification.local.json` 已写入并由 Git ignore；历史 ChatGPT Archive 找回正确 Bark device key 后，真实 Bark E2E 返回 HTTP 200。正式 Guardian daemon 已重启，state 显示 notification enabled/provider=bark，WSS 已恢复 conversations 订阅。
- [done] 回归完成：TypeScript 通过；Vitest 17 files / 95 tests 全过；真实 Bark E2E 通过。剩余非阻塞可靠性债务：若 Bark/网络连续两次都失败，目前 incident 仍安全保存在 SQLite，但手机通知没有持久 outbox 做跨进程重试。

## 2026-09-22 浏览器内存尾段恢复 / conversation persistence gap ExecPlan

- [pending] 扩展 UI observer，识别 `ui-virtualizer-blank-view`：同时采样可见 target 的 `visibilityState`、thread scroll container 几何、标准 message DOM 数量、可见文本节点与 canonical `current_node/final`。2026-09-24《漫画分镜设计》已出现 canonical 正常 final、DOM `innerText` 仍有完整消息，但 `[data-message-id]=0` 且内容树整体位于巨大负坐标的真实样本；这应作为 UI-only renderer 故障记录，不得建立新的 server lifecycle incident。
- [done] 对三个风险会话先做无刷新 CDP 抢救：保存 DOM HTML、纯文本、DOMSnapshot，以及可见 user/assistant 的真实 `data-message-id`；同时在停 daemon 前复制 SQLite/WAL/SHM/turn trace。
- [done] 解锁 SQLite 后与浏览器现场逐项对账，确认三例都存在“执行/前端现场比 canonical conversation archive 更靠后”的 persistence gap：迁移与异常分析缺整轮执行尾段，Sidebery 至少缺长度上限终止节点，工具过程另存在于 DOM/audit。
- [done] 当前接续聊天自身再次中断后形成第四个对照样本：canonical body 已有 491 节点且 `current_node` 指向真实 tool result，但 DOM 只显示 user + 合成 timeout error；将其单独命名为 `ui-hidden-canonical-tail`，明确它不是 persistence gap，也不是 confirmed head rollback。
- [pending] Phase 3/UI observer 后续要把“当前 DOM 可见 message-id 集合”与 canonical body/current_node 同时采样；只有这样才能自动识别 `ui-hidden-canonical-tail`。现阶段只保存 DOM/DOMSnapshot/raw audit，不把 UI-only timeout placeholder 写进 canonical messages。
- [done] 增加只增量、不删除历史的 `chatgpt-archive recover` 入口：复用 `mergeLiveMessagesPage()`，强制 provenance=`browser-memory-recovery`、`updateCurrentState=false`、`updateIncidents=false`、`insertUnknownOnly=true`。assistant DOM 节点还要求真实 model slug，并排除 timeout/length-cap UI 合成错误卡片；这些 UI-only 证据只进入 raw observation，不污染 canonical messages。
- [done] 已生成三份 recovery bundle 并对主库执行恢复。后续 hidden-node 对照证明 DOM 的 assistant error card 也可能带 `data-message-id` 却完全不存在于 server body，因此最终 canonical 恢复只保留能证明的消息：迁移聊天缺失 user `bcfba6d2…` 留在 union；三个 timeout/length-cap UI assistant 占位均从 canonical 删除但继续保留在 raw recovery observation。异常分析 user `9ef20fbc…` 已从 recovery 前的 first-party raw body observation 恢复完整 metadata。
- [done] 已将 conversation length-cap、send-timeout、persistence gap 与 `ui-hidden-canonical-tail` 分层写入 PROGRESS；真实主库完成局部 FTS/Markdown/resource 重建和 message/head 核对。最新 recovery 代码定向数据库测试 20/20、TypeScript 通过，全量 Vitest 17 files / 93 tests 全过。

## 2026-09-21 Complete-no-final / head divergence / overlap 收敛 ExecPlan

- [done] 将异常记录改成多维模型：生命周期主类（`complete-no-final` / watchdog 等）与 `tailShape`、`head/messages divergence`、head rollback 证据并列保存，避免把 tool/reasoning/context 尾型误当成根因。
- [done] 在 terminal body 诊断中记录 current_node 对应 message 的 status/end_turn，并识别同一 turn 中“比 current head 更新、但未被 current_node 选中”的 off-head messages；只在真实 head history A→B→A 时标记 rollback。
- [done] 审计 archive 导出路径并补回归：live plural archive 是 union/upsert，current_node 回退或新 body 变短不会删除已落库 messages；Markdown 保留 forensic union，current_node 单独保存最新 canonical head。
- [done] 把短 WSS gap 的 catalog reconciliation 改成动态 overlap：`wss-reconnect` 在完整一页稳定旧记录后停止；startup/periodic/guardian-recover 继续使用深 overlap。body cursor 维持“整页全部已知即停”的现有规则。
- [pending] 回溯历史 ChatGPT 讨论和 incident，寻找“节点突然缩回/刷新后消失/前端显示比刷新后更多”的旧样本，用新 `head/messages divergence` 假说重新标注，但不在没有 A→B→A 证据时声称 rollback。
- [done] 已回溯 9/13《chatgpt同步持久化》：旧记录明确存在“状态回吃 / UI current_node 切 branch 后步骤消失但服务器未必删除”的现象与分支实证；但该 conversation 的 head history 只有 1 条，无法追溯证明 A→B→A，故只记历史一致性，不升级为 confirmed rollback。
- [done] 补齐单元/数据库/daemon 回放测试，typecheck、92/92 tests、四套 build 全部通过；PROGRESS 已持续更新并逐步提交。

# ChatGPT Passive Exporter ExecPlan

## 当前权威阶段地图（2026-09-13）

> 下方较早的“Phase 1～14”章节保留历史演进记录，但**当前执行与沟通统一使用本节编号**；若旧阶段编号与本节冲突，以本节和 `ARCHITECTURE.md` 为准。

- **Phase 0 — Ground Truth：已完成。** 两份官方 Data Export ZIP diff、旧数据消失语义、fixture/来源基线。
- **Phase 1 — Genesis Archive：已完成。** 多快照 union → canonical SQLite、raw snapshot、FTS、资源目录、6155 个历史 conversation。
- **Phase 2 — Live Incremental Archive：当前收尾。** 单一隐藏 Guardian + 本地 daemon；WSS-first realtime；dirty/ready；catalog overlap recovery；body cursor overlap；SQLite live merge；incident ledger；Windows/Chrome 生命周期；限速与 429 breaker。2026-09-13 已修复真实 WSS 双层 payload parser，并实测两次 `WSS complete → body → SQLite` 全链且未使用 list fallback。
- **Phase 2.5 — Branch / Version Semantics：Phase 2 完成后立即做。** 针对 Edit old user prompt、Regenerate assistant、1/3/2/3/3/3 version 切换、branch-in-new-chat，逐案 diff `include_has_versions=true` 返回，明确 transient/live event 应挂到哪一个 node/branch。
- **Phase 3 — Live Turn Capture：下一大阶段。** 不再叫“纯 SSE mirror”。当前真实 turn 仍先走 `/backend-api/f/conversation` 的 `text/event-stream`；同时近期协议迹象表明某些流可能通过 `stream_handoff` 切到 turn-specific WSS/catch-up。目标是把 SSE + handoff 后实时通道统一成一个 lossless transient event log，并向轻量移动 PWA 提供只读实时观看。
- **Phase 4 — Send / Control Plane：Live Turn 稳定后。** 从 CLI/PWA 对最新 canonical branch 发送新消息/继续；优先复刻第一方发送协议，DOM 点击只作为保守 fallback；必须解决 stale client/旧 branch 发送造成的进度丢失与副作用重复风险。
- **Phase 5 — Guardian / Runtime Footprint：最后再优化。** 在不破坏 WSS/session/风控行为的前提下研究减少 Guardian React/资源/渲染负担，以及把多个 Windows daemon 的 supervisor/通知做统一治理；当前空首页 Guardian 已足够轻，不抢占 Phase 2/3 主线。

## 2026-09-13 Phase 2 事故状态 / WSS 发现链修正 ExecPlan

> 这轮计划来自三个真实断流样本（reasoning-open ×2、tool-result-returned ×1）。目标不是增加更多轮询，而是先把“事实分页”“当前 turn 状态”“每 turn incident”“实时发现信号”四层彻底拆开，再决定 Phase 3 如何接实时流。

1. **分页与当前状态解耦。** Modern `/backend-api/conversations/{id}` / `messages?before=...` 的 cursor 分页只负责补历史事实；只有“最新 body 第一页”有资格更新 conversation 当前 turn 的 `terminal_state / incident_state`。历史 cursor 页即使包含旧 final，也绝不能覆盖当前 turn 状态。
2. **incident 按 turn 建模。** `incidents` 的稳定身份改为 `conversation + turnKey`；优先用 `turn_exchange_id`，缺失时依次回退 user message / last message / current node。一个 turn 的诊断演进更新同一条 incident；后续新 turn 只把旧异常标记 resumed/resolved，永不删除历史，也不允许不同 turn 互相覆盖诊断内容。
3. **当前状态与历史事故分层。** `conversations.terminal_state` 仅表示最新已观测 turn；`conversations.incident_state` 仅表示当前/latest turn 是否仍有 open incident。历史 resolved/open 事实全部以 `incidents` 为准，不能再用“该 conversation 是否存在任意 open incident”推导当前红牌。
4. **请求 transport 审计。** 逐条核实 daemon 的 catalog/body/cursor/singular 请求都来自当前第一方网页已经存在的 endpoint/query 形状；Authorization/OAI session/device/build 等只从 Guardian 当前 `/backend-api/` 自然请求中临时捕获允许列表，cookie/UA/referrer/sec-ch 继续由浏览器同源 `fetch(credentials=include)` 生成；禁止把 token/header 固化到磁盘长期复用。对 401/403 必须丢弃内存 auth context 等待自然刷新。
5. **WSS 生命周期取证与恢复语义。** 区分“Chrome/CDP 明确收到 `webSocketClosed`”与“长期静默猜断线”。生产 daemon 在 close 后给官方页面一个自然重连 grace，不应下一轮主循环立即 reload Guardian；记录 close→new socket 延迟、generation、subscribe ack/recovered，只有超过 grace 仍无 socket 才重建 Guardian。用现有纯被动 `wss-stability-probe` 和历史日志判断约 30–35 分钟周期到底是第一方正常 socket 生命周期还是页面/daemon 故障。
6. **重新确认账户级事件语义。** 不再假定旧 `conversation-update + async-task-update-message` 是普通 turn start。直接检查当前 ChatGPT Web bundle / 真机 WSS，重点验证 `conversation-history-update`、`conversation-created`、`conversation-turn-complete` 的触发时机；旧 `conversation-update` 若仍存在，则只按其已证实的 async/background 语义使用。
7. **Phase 3 不依赖单一“start event”。** 本机网页发起的 turn 可直接从 `/backend-api/f/conversation` SSE 请求本身发现；若收到 `stream_handoff`，转接 turn-specific WSS/catch-up。跨设备 turn 则优先用账户级 WSS 的 early history/progress 事件发现；若当前协议确实只在 complete 通知，必须明确记录“跨设备从第一 token 实时镜像尚未解决”，不得用高频 conversation list 冒充实时 discovery。
8. **回归样本固化。** 增加“最新 reasoning-open + 历史 cursor final”“最新 tool-result-returned + 历史 cursor final”“同 conversation 两个异常 turn”“异常 turn 后新 turn 正常恢复”测试；任何历史页再次把 current state 改成 final 都必须立即测试失败。
9. **watchdog 恢复为“超时调查器”，不要偷换成终态分类器。** watchdog 的触发条件就是“我们已经认为这一轮运行得异常久、而且迟迟没有 complete”；一旦超时就应该创建/更新该 turn 的 timeout incident，并主动抓一次最新 body 做诊断。若 body 明确 `client_stopped/interrupted`，则把同一 turn 的 incident 升级为 confirmed abnormal；若仍是 reasoning/tool open，只说明“超时且尚未正常收尾”，incident 继续 open，不能因为缺少 COMPLETE 就把 watchdog 变成无意义的只读检查。后续正常 final 或用户开启新 turn 时，只 resolve 这条 turn incident，不删除历史。
10. **WSS close 必须先给官方页面自己的重连机制 grace。** 当前代码错误地把“Guardian 已启动超过 20 秒”当成“socket close 后已等待 20 秒”，导致任何运行期 `activeSockets=0` 都可能在下一轮 5 秒主循环被强制 reload。修为：首次启动仍使用 readiness grace；运行期 close 则从 `lastWssClosedAt` 单独计时，并在 grace 内观察官方页面是否自然 `webSocketCreated`/重新 subscribe。只有超过 grace 仍无 socket 才重建 Guardian。这样才能区分官方约 30–35 分钟的自然 socket 生命周期与我们自己的恢复行为。
11. **start/discovery 不以 1 小时 catalog 轮询作为最终方案。** `async_status` catalog 扫描只保留为 gap/recovery 兜底，不能成为 watchdog 的主要起点。继续寻找账户级 WSS/其它第一方事件对普通 turn 的早期信号；Phase 3 对当前网页自己发起的 turn 直接从 `/backend-api/f/conversation` SSE 捕获开始，`stream_handoff` 后接 turn-specific WSS。跨设备普通 turn 若确实没有任何 early account event，应明确记录为协议能力缺口，而不是悄悄把 1 小时 list 轮询包装成“实时监控”。
12. **历史 cursor 也必须逐 turn 诊断，而不是只补正文。** Cursor/page 只是传输容器，不是状态单位。每一页里的每个 turn 都应按自己的 user/turn_exchange_id/tool/reasoning/final 证据更新对应 `conversation + turn_key` incident；历史页仍可补 messages、tool call/result、metadata、mapping/raw observation。唯一禁止的是历史 turn 去覆盖 `conversations.current_node / terminal_state / incident_state` 这类“当前/latest”汇总字段。若某个旧 turn 后面已经存在更新的 user turn，则“后续 turn 已开始”本身可作为该旧 turn 已结束的证据：旧 turn 无 final 时允许记为历史 abnormal incident，并直接标为 resolved/resumed，而不是把它误当成仍在运行。
13. **watchdog 只接受可靠的 active 起点。** `conversation list.async_status=3/5` 只能进入独立的 `catalogActive`/recovery 状态，不能写入 watchdog `activeTurns`，因为“第一次扫到 running”不是 turn start，且服务端 zombie 可能保持数天。`activeTurns.startedAt` 只允许来自本机 `/backend-api/f/conversation` 发送观测、明确 WSS turn-start（若协议再次出现）或已验证的 async progress 事件。跨设备普通 turn 若没有 early account event，就明确标注 watchdog coverage 缺失，不用 catalog 伪造起点。

## 2026-09-19 Active Turn Recorder ExecPlan

> 2026-09-20 steering 校正：真实样本证明，运行中用户追加 follow-up 时，新 `role=user` message 可以继续沿用同一个 `turn_exchange_id + request_id`；只有真正开启下一轮时这两个 ID 才变化。运行诊断因此必须优先按 `turn_exchange_id`（次选 `request_id`）划分 turn，只在协议 ID 缺失时回退到 user 边界。`async-task-steering-message` 属于同一 async task 的 steering/progress 证据，不能因为中途出现新 user message 就制造 historical abnormal incident。

> 目标：下一次出现“多个 conversation 在十几秒内一起 `conversation-turn-complete`，但没有 final answer”的批量异常时，不再依赖事后手工拼日志，而是由 Guardian/daemon 自动留下可回放的逐 turn 时间线。

> 2026-09-21 新样本校正：`迁移刷机方案` 连续出现两种 **WSS 已 `conversation-turn-complete`、但没有 final** 的不同尾型。前一轮明确停在 `assistant -> functions.exec` 且缺对应 tool result；用户随后发送“又中断了继续”后，新 turn 则只持久化了 user + `model_editable_context` 两个节点，之后多次 reconnect body 仍没有 reasoning/tool/final。诊断器必须把后一种从笼统 `other` 拆成纯结构性 `context-only-no-output`，但该 tail 本身仍不得作为死亡证据；只有外层 WSS/catalog/stream_status 已确认收口后，才能形成 abnormal-terminal incident。与此同时，`async_status=3/5` 长期 active 且没有 complete 的 `active-zombie/watchdog-timeout` 继续作为独立生命状态问题，绝不能和 complete-no-final 合并。
> 同一 turn 已经由可靠终止信号建立 incident 后，后续 startup/reconnect/body reconcile 即使本身没有“允许新建 incident”的资格，也应刷新这条**既有** incident 的 tail/diagnostic/last_observed_at；这样分类器升级或后续更完整 body 可以自愈旧账。该刷新不得把普通 reconcile 当成新的终止来源，也不得覆盖 incident 最初的 WSS/catalog/watchdog `source`，更不得据此给一个从未立案的 turn 新建事故。
> 生命周期证据保持三路独立：① 账户级 WSS `conversation-turn-complete`；② conversation list 的 `async_status`；③ `/backend-api/conversation/{id}/stream_status` 的 `IS_STREAMING/COMPLETE`。正常情况下它们高度相关，但没有公开契约保证严格同步；任何时候都不得由其中一路反推另外两路。WSS reconnect `recovered=false` 还意味着“未看到某个 complete”只能记为“未观测到”，不能提升成“服务器未发送”。
> `message.status` 另作 node-local 证据，不并入上述三路 lifecycle。后续 abnormal recorder 应额外记录 `current_node` 的 message.status/end_turn，以及 plural `messages[]` 中是否存在 create_time 更新、同 turn_exchange_id、但不在 canonical head 的后续 node；这可直接识别 `head/messages divergence`。只有真实 head history 出现 A→B→A 才命名为 rollback。
> reconnect gap repair 与 startup/full reconciliation 拆阈值：普通 `wss-reconnect`/短 `guardian-recover` 优先采用“一整页稳定即停”的动态 overlap；startup、长时间 Guardian 丢失和 periodic 保留 56+ stable item 的深 overlap。先用现有日志回放验证不会漏掉已知 changed item，再改默认值。

1. **新增独立 turn trace JSONL。** 每条记录都只保存生命周期/诊断元数据，不保存用户正文、工具正文、认证头或 cookie。默认路径放在 `data/active-turn-trace.jsonl`，并允许 CLI flag 覆盖。
2. **WSS 生命周期必须带并发快照。** `conversation-created / conversation-update / conversation-turn-complete` 每次都记录 `activeBefore / activeAfter / activeConversationIds`；complete 必须在删除 active turn 之前先记录 pre-complete 并发度，避免以后无法还原“当时同时跑了几个”。
3. **Body sync 负责补 turn 身份。** 完成一次最新 body merge 后，把现有 `RunDiagnostic` 中的 `requestId / turnExchangeId / userMessageId / terminalEvidence / tailShape / assistantToolCalls / toolResults / hasReasoningEnded / hasFinal` 写入 trace，与触发该同步的 WSS/catalog/watchdog 原因绑定。
4. **Catalog 只记录已知状态迁移，不伪造 start。** `async_status=3/5`、`4` 可作为 recovery observation 写 trace，但继续遵守现有原则：第一次扫到 running 不是可靠 startedAt。
5. **Safety Review 预留而不猜。** 2026-09-16 已从当前 ChatGPT bundle 证实 UI 组件名为 `SafetyReviewStatus`，但归档 body 暂未找到稳定 `protectionType` 字段。Recorder 先预留 `safetyReview:null`，后续 Phase 3 页面/stream 捕获拿到真实 signal 后再填，禁止从文案或主题猜 `bio/cyber`。
6. **测试覆盖批量异常取证关键字段。** 单元测试至少覆盖：start/progress/complete 前后并发度、complete 先于 created、body snapshot 绑定 request/turn id、无可靠 start 时仍能记录 complete 但不伪造 startedAt。
7. **上线前清理实验垃圾。** `tmp-branch-*` / `tmp-*safety*` 和实验 JSON 不进入正式提交；正式提交只包含 recorder、测试、文档及此前已确认的 daemon 生命周期日志改动。
8. **单 actor 的可靠 local start。** Phase 3 actor 不直接构造私有 conversation POST；继续调用 ChatGPT 页面自己的 send handler，并只读监听页面自然 `POST /backend-api/f/conversation` 的 `requestWillBeSent`。新聊天从 `/` 到 `/c/<UUID>` 后，把原始 request 时刻与真实 UUID 绑定成 `actor-submit` trace。后续受控 3→8 并发以这条 trace 作为本机任务的精确 start，下游 WSS complete/body snapshot 作为 end/终态证据。


## 目标

构建一个尽量不主动调用 ChatGPT 私有后端 API 的聊天归档工具：监听页面自己已经发出的请求并复制响应，随后将不同年代/不同接口形态的 ChatGPT conversation payload 归一化，再导出可读 Markdown、原始 JSON 和附件/富媒体清单。

## 2026-09-25 Guardian 第一方请求复用与 429 收口

## 2026-09-27 Passive Protocol Drift / Native Template Learning

### 目标
- 不再用主动参数矩阵做日常协议探测；所有持续监控必须来自页面已经自然发出的 Network 请求/响应。
- 保存稳定 request/response schema fingerprint，能发现 path、query、应用协议 header、POST body key、response schema 的上游漂移。
- 将“自动发现候选模板”与“主动 replay 使用模板”彻底隔离：候选可自动，promotion 必须人工批准；首版批准状态也不直接驱动 replay。
- 每日一次本地报告，只在 baseline 锁定后发现未通知 drift 时通过现有 Bark 提醒。

### 当前实现
- [done] 受控实验确认 TPP include/exclude 是真实 origin filter，并因少量 GET 即触发 429 而停止主动扫描。
- [done] request fingerprint：route/method/query stable values/protocol header names/POST JSON key paths。
- [done] response fingerprint：top-level/items/messages/metadata/page_info/mapping schema。
- [done] cursor/signature/timestamp/file-id 等高熵值归一化，浏览器 transport headers 不参与 signature。
- [done] Guardian/native user-page observer 接入；Archive replay 排除，避免自我污染 baseline。
- [done] 24h 初始 learning baseline；baseline 后未知 request/response shape 进入 drift ledger。
- [done] protocol status/report/approve CLI；report/approval 状态与 daemon ledger 分文件，避免并发覆盖。
- [in_progress] Windows 每日只读 report 计划任务安装与部署验证。
- [pending] 观察真实 drift 样本后，再决定 approved candidate 如何安全接入 replay；当前保持不自动消费。

### 背景
- 23:09 以后新版 daemon 自身一度没有主动 catalog/body 请求，但隐藏 Guardian 页仍出现 /backend-api/conversations 429。
- 通过 CDP PerformanceResourceTiming 与 daemon WSS 日志对齐，确认 Guardian 完整 ChatGPT 前端会在收到 conversation-turn-complete 后主动刷新 conversation list；普通 ChatGPT 页还会并发预取多个 conversation body，并在部分请求 429 后很快重发。
- 因此当前 passive/WSS-first 仍存在一个此前未计入的第一方请求源：Guardian 页面自己的前端网络行为。

### 目标
1. 把本轮 list/body 429、WSS→list 对齐、普通页 body 并发预取等实测证据写入 PROGRESS.md，明确区分“页面 native 请求”和 daemon replay。
2. 比较 native conversation-list/body 与 daemon replay 的 URL、headers、触发时点和 payload，回答服务端是否可区分，以及哪些 native 响应可以安全复用。
3. 追查 23:37 普通页三条 body burst 的 conversation 身份和触发来源，确认它们是否由最近 complete、页面导航/预取、侧栏可见项或其它状态驱动。
4. Guardian 尽量恢复真正 passive：
   - 优先监听并复用页面自己已经产生的 list/body 响应；
   - 在 429 cooldown 期间禁止 Guardian 自己的无关 sidebar/list 请求继续绕过 daemon circuit breaker；
   - 保留 WSS 通道，不因 REST 冷静期主动拆页或断 WSS。
5. 只有在 native 响应无法覆盖完整性契约时才保留主动 fallback；主动 fallback 必须低频、单并发、带 slow-start。
6. 核验并测试 catalog overlap：短 gap 的阈值可以是一页（28 条），但停止条件必须是最后一个变化之后连续 28 条稳定记录；若第一页存在新/变更记录，则必须继续翻页直到真正跨入连续 overlap，绝不能固定只抓一页。

### 执行步骤
- [done] 取证并记录 native list/body 行为、请求形状、body burst 对应 conversation。
- [done] 设计 Guardian native response capture 与 cooldown 屏蔽策略。
- [done] 实现可复用的 passive list/body ingestion，避免与 replay 重复请求。
- [done] 增加 cooldown slow-start / native request guard，避免一解封就重新打满。
- [done] 为 overlap、native capture、429 cooldown 增加单元/集成测试。
- [done] 全量测试、typecheck、部署新版 daemon，并观察 WSS/list/body/429 行为。

### 2026-09-26 01:22 部署结果
- 定向测试：archive-daemon + sync-overlap 共 26/26 通过。
- 全量：17 个 Vitest 文件 / 108 tests 全通过；tsc --noEmit 通过。
- 当前 daemon PID 41336，以 --no-reconcile-on-start 启动；启动期间没有主动 catalog/body。
- Guardian healthFailures=0 / rebuilds=0；WSS activeSockets=3。
- 已重新订阅 conversations / alder-conversations / resource-updates / app_notifications 四个 topic。
- 3 个普通 ChatGPT page 已挂 passive CDP observer；启动观察窗口内 native 429=0。
- passive catalog/body cache、cooldown 内纯被动收口、Guardian HTTPS REST block、恢复 slow-start 均已部署。

## 当前执行主线（2026-09-06）

- 用户侧正式 CLI 名称定为 **ChatGPT Archive**，可执行命令为 `chatgpt-archive`。旧 `npm run archive` 仅作为开发兼容别名保留，不再作为产品名称。
- Genesis 已完成，当前进入增量同步阶段。同步必须坚持“从最新向历史追，直到可靠 overlap 才停止”，而不是固定抓一页或固定抓 N 条。
- Catalog 增量：从 conversation list 第一页开始，按 `update_time + conversation_id` 与本地 `conversations` 对比；遇到新 ID 或较新 `update_time` 则标记 dirty，继续翻页直到出现足够可靠的连续 overlap 区间。
- Body 增量：对 dirty conversation 从最新 body page 开始，按 node/message ID 与本地 `mapping_nodes/messages` 比对；只要当前页仍含本地未知节点就继续向历史翻页，直到跨页命中稳定 overlap 后停止。
- 实时路径：WSS 只负责快速产生 dirty/turn-complete 信号；真正数据完整性由 list/body overlap 同步保证。WSS reconnect、offline→online 或 watchdog 触发 reconciliation，而不是相信事件绝不会漏。
- 所有在线同步结果继续写入同一 `data/chatgpt-archive.sqlite`，并保留 raw source observation；云端缺失不得物理删除本地历史。

## 2026-09-12 实时状态机收口

- **把“内容已变化”和“现在适合抓最终正文”拆成两个维度**。任何可信 WSS conversation 事件（例如 conversation-created、turn-start/update、turn-complete）一到，就立刻把该 conversation 记为 `dirty/stale`，表示“本地副本可能落后”；但 `dirty` 本身不等于“马上发 body 请求”。
- `turn-complete` 是正常的 `sync-ready` 触发器：收到后立即安排一次 body overlap 增量同步，同一份 body 同时负责正文归档和 terminal/tail 异常诊断。
- `turn-start` / conversation-created 只登记 active + dirty，首版不为了一个仍在生成的 turn 每几秒抓 body。若 active 超过可配置 watchdog（当前默认 30 分钟）仍无 complete，则安排一次**诊断同步**，从 body 判断当前持久化尾部；只有确有独立信息需求时才考虑 `stream_status`。
- WSS gap/reconnect、daemon 冷启动、online 恢复、低频 catalog reconciliation 发现 `update_time` 变化时，属于恢复路径：这些条目可直接进入 `sync-ready`，因为此时无法依赖之前的 complete 事件仍然存在。
- 后续 Live Stream/SSE mirror 是独立实验层：若能可靠订阅正在生成的 turn，则 `turn-start` 后可以持续保存 transient stream，但这不能反过来改变 Archive Core 的最终 overlap/terminal 同步契约。
- **2026-09-13 WSS 语义校正**：历史真实抓包并没有出现字面事件 `conversation-turn-start`；已确认的实时业务事件至少包括 `conversation-created`、`conversation-turn-complete` 和 `conversation-update`，其中 `conversation-update + update_type=async-task-update-message` 会在其它异步 conversation 运行过程中推新 message。因此 Phase 2 的 active/progress 入口应以该 async update 为主，`conversation-turn-start` 只作为向前兼容；不能再把“未看到 start”误解成 WSS 只有 created/complete。
- 当前上线阻塞项按顺序处理：① Windows 登录自启动真正注册；② Chrome 根恢复改为复用桌面 `Chrome CDP 日常版.lnk`；③ 正式 daemon 常驻；④ 低速 backlog 追平到 overlap；⑤ 实测 WSS event → dirty/active → complete → sync/diagnostic E2E；⑥ 再进入 branch/version 与 Live Stream 实验。

### Phase 2 最终验收口径（2026-09-12 晚）

- **历史缺口**：冷启动只用 conversation list 做一次低频 overlap reconciliation；得到 backlog 后严格单并发、全局限速逐 conversation/body cursor 补到本地 overlap。当前正式参数为 catalog ≥5s/request、body ≥6s/request、额外 0–1.5s jitter；任意 429 立即进入 60 分钟 cooldown。
- **稳态实时发现**：必须证明 Guardian 官方 WSS 实际订阅 `conversations`，并证明真实 `conversation-turn-complete` 能被 daemon 解析、标 dirty/ready、触发 body merge。只看到 `activeSockets=1` 不算验收通过。
- **2026-09-13 真实协议修正**：complete 的当前第一方 frame 为 `message(topic=conversations) → payload.type → payload.payload.conversation_id`。旧 parser 因错误假设同层字段导致业务 frame 收到却未解析，从而产生“daemon 运行期间漏掉、重启 list 才发现 6 dirty”的现象。修复后必须以 `parsedEventFrames↑ / eventCounts↑ / syncedConversations↑ / lastReconcileAt 不变` 作为 realtime E2E 验收证据；该验收现已通过两轮。
- **turn start/active 来源不得臆造**：现有 2026-09-03 WSS probe 真实日志只观察到 `conversation-turn-complete`，尚未观察到 `conversation-turn-start`。代码可保留兼容分支，但 Phase 2 不得声称 WSS 已证明能发现 turn start。若官方 WSS 不提供 start，异常“无 complete”检测要由低频 catalog `async_status/update_time` 或后续 Live Stream/SSE 层补足。
- **在线树结构**：plural body 的 `message.id + metadata.parent_id` 必须同步 upsert `mapping_nodes`；已用 Genesis 103260/103260 个节点验证 `node_id===message_id`，并用冰岛旅行真实会话验证同一 conversation 内 sibling user/assistant branch 确实存在。
- **高可用**：计划任务登录自启动、无控制台窗口、Guardian `SW_HIDE`、Auto Tab Discard 白名单与强制 discard 自愈必须保持已验收状态；Chrome 根恢复只实现非破坏性 no-op/启动路径，不为了测试强杀用户正在工作的整套 Chrome。
- **异常账本**：complete/body 或 watchdog 诊断产生的 abnormal terminal 必须持久化到 SQLite `incidents`；恢复后的新 turn/final 只 resolve incident，不删除历史。手机 Bark 属于通知 transport，可配置但不得用过期 token 阻塞 Archive Core 验收。
- **切换条件**：当前 backlog 完全追平后，正常停止旧 daemon，再由计划任务启动仓库 HEAD；重启后执行一次 WSS 控制面取证 + 真实用户 turn E2E。上述项目全通过后才宣布 Phase 2 完成并进入 Phase 3 Live Stream/SSE mirror。
- **Live update 边界**：`conversation-update + async-task-update-message` 历史上能携带一个完整的 `update_content.message` snapshot，并可能重复送达；2026-09-13 两次普通 turn 实验未观察到该 update，而正文明确仍经 `/f/conversation` SSE。故 Phase 2 只能把 update 当 opportunistic async progress signal，绝不能把它当作所有 turn 的 start/逐 token stream，也不能用它取消 Phase 3。

## 设计原则

1. **被动捕获优先**：不自行构造 `/backend-api/conversation*` 请求，不读取或保存 Authorization/access token；只复制 ChatGPT 页面自己收到的符合白名单的响应。
2. **捕获与解析解耦**：页面 hook 只负责捕获；adapter 负责 `messages[]` / legacy `mapping` 等 schema；renderer 只面对稳定的 canonical model。
3. **正文与审计分层**：默认 Markdown 只保留 User / Assistant 可见正文；工具调用、Web Search、App Connector、图片组、Widget、reasoning 摘要和文件作为可选附录/manifest。
4. **附件独立处理**：聊天正文里的 `sandbox:/mnt/data/...` 先记录为 manifest；只有用户主动要求“同时下载附件”时才跟随页面自身下载行为获取文件。
5. **复用上游维护**：尽量复用 pionxzh/chatgpt-exporter 的 Markdown/citation/multimodal/UI 维护成果；捕获层维持独立，但允许同时实验“被动捕获”和“观察真实请求头后直接读取后端”两种 transport，用实测稳定性、风控面和维护成本决定默认路径。
6. **跨端共享核心**：WXT 构建 Chrome / Edge / Firefox 扩展；vite-plugin-monkey 构建 Tampermonkey/Violentmonkey/Greasemonkey userscript；两者共用同一 capture/parser/export core。
7. **原生侧栏 UI**：不使用 Shadow DOM；复用/跟随 ChatGPT Exporter 的 sidebar 注入思路，在 ChatGPT 侧栏直接插入导出入口，视觉上跟随页面当前导航项。
8. **本地优先检索**：长期目标不是反复在线抓取，而是把云端 conversation 可靠搬到本地 SQLite/文件仓库，AI/用户的搜索与读取优先走本地索引。
9. **本地 Archive 才是长期真相源**：ChatGPT 官方 Data Export 是“某一时刻的账户快照”，不是 append-only 历史账本。实测 2026-07-02 与 2026-09-01 两份官方导出存在旧包独有 conversation/asset，因此本地库不得因为新快照缺失对象就物理删除旧数据；使用 `last_seen_at / source_missing / tombstone` 一类状态表达来源消失。
10. **结构化查询 + 原始无损并存**：conversation / mapping node / message / author / content / metadata / resource 等高价值字段进入结构化表，支持 SQL/FTS/增量合并；同时保留 raw snapshot / raw JSON，未知字段不得因当前 parser 不认识而永久丢失。
11. **增量同步必须有 overlap 停止条件**：conversation list 从最新向旧翻页，直到与本地已知 watermark/ID 区间可靠重合；conversation body 从最新向旧补页，直到 message/node ID 与本地已有历史可靠重合。绝不能以“只取第一页”作为完整同步，也不能因云端当前缺失而删本地旧内容。
12. **OpenCLI 不是主控制面**：项目保留独立 Archive Core 与原生 CLI。OpenCLI adapter 仅作为浏览器生命周期/登录复用能力的候选集成，以及把通用 ChatGPT API 改进贡献上游的派生物；不能成为 SQLite/监控/归档核心的必需依赖。

## 阶段

### Phase 1：样本与契约
- 以 `Travel/三峡/archive/raw/chatgpt-tourism-main.json` 为真实复杂样本。
- 建立脱敏的 fixture / schema contract。
- 覆盖：ordered `messages[]`、Web Search、Trip.com App Connector、image_group、map widget、sandbox 文件链接、commentary/final continuation、隐藏 system/reasoning 节点。

### Phase 2：被动捕获核心
- `document_start` 启动。
- 页面 MAIN world hook 原生 `fetch` 与 XHR，只对白名单 ChatGPT conversation 响应执行 `clone().json()` / 复制响应文本。
- 通过随机 session channel + DOM CustomEvent / postMessage 将副本送往 isolated content script。
- 不修改原 Response，不阻塞页面请求，不记录请求 header/cookie/token。

### Phase 3：统一模型与导出
- `messages[]` adapter。
- legacy `mapping` adapter。
- canonical conversation/message/tool/resource model。
- Markdown：默认只导出 User/Assistant；可选工具轨迹、reasoning summary、图片/Widget/App Connector 摘要。
- JSON：保留原始捕获 + canonical JSON。
- Attachment manifest：sandbox/file/sediment/image URLs 与来源消息 ID。

### Phase 4：Userscript / WebExtension 与原生侧栏 UI
- WXT：Chrome / Edge / Firefox。
- vite-plugin-monkey：userscript；Userscript 是首个实际分发目标。
- 不使用 Shadow DOM；复用 ChatGPT Exporter 当前的 `accounts-profile-button`/侧栏重渲染检测思路，并准备 selector fallback。
- 在 ChatGPT sidebar 插入“归档/导出”项，点击后打开与原 Exporter 类似的轻量菜单；默认导出 Markdown，可选安全 archive JSON / rich manifest / 附件。
- 首先在本机 Chrome + Tampermonkey 做完整闭环：安装 userscript → 正常切换聊天 → 被动捕获 → sidebar 导出 → 校验输出。

### Phase 5：上游同步与 CI
- 固定记录 `pionxzh/chatgpt-exporter`、`pavel-voronin/chatgpt-sync` 等 upstream SHA。
- GitHub Actions 本身不能直接订阅无权限外部仓库的 `push`；因此首版使用低频 scheduled poll + `workflow_dispatch`。未来如部署 GitHub App/Cloudflare webhook，则由外部事件发送 `repository_dispatch` 实现真正即时触发。
- 只同步/比对 exporter、citation、multimodal、sidebar DOM、conversation schema 等关注模块；不得自动把 upstream 的认证/主动 fetch 逻辑合入核心。
- CI 跑 Travel fixture 契约测试 + 四端构建；检测到上游变化时产出 diff/report，后续可自动开 PR，但不无审查合并。

### Phase 6：CLI / OpenCLI Adapter
- 优先利用现有 OpenCLI ChatGPT adapter，而不是另造孤立 CLI。
- 目标命令：`history/search/current/export/archive/sync`；AI 可以列聊天、按标题/正文搜索、读取特定 conversation、导出 Markdown/JSON/附件清单。
- 在线读取 transport 与浏览器前端共用 adapter/canonical model；本地库存在时 `search/read` 默认走本地，只有显式 refresh/sync 才访问 ChatGPT。
- 原型阶段验证两路：A. DOM/导航触发 + 被动 response capture；B. 像 chatgpt-sync 一样观察网页真实 headers 后由 page runtime 直接请求后端。比较请求数量、接口稳定性、429/风控行为、资源完整度。

### Phase 7：本地增量归档与官方大包对账
- **Genesis / Archive Core 已完成（2026-09-06）**：SQLite 已建立 conversation/node/message/part/resource/index/snapshot/source-observation 等结构，并保留 gzip raw snapshot/Markdown/assets 定位信息；数据库正式作为长期 source of truth。
- **官方 ZIP Genesis Import 已完成**：支持多份历史 Data Export 按 conversation/node/message/asset identity 做 union + reconcile；较新快照更新 canonical 状态，但不得删除只存在于旧快照的数据。当前默认主库已由两份真实官方 ZIP 合并得到 6155 conversations。
- “小同步”以 **passive/WSS-first** 为主：页面自身首次 conversation list 响应只做 baseline/免费 catalog observation；随后由官方 WSS 的 conversation-created / update / turn-complete 标记 dirty。只有 daemon 冷启动且本地可能落后、WSS reconnect/gap、online 恢复或人工/低频 reconciliation 时，才主动翻 conversation list，并根据 conversation id + update_time/watermark + **overlap** 找新增/更新聊天。conversation list 不是 heartbeat，更不能作为常态高频轮询面。
- dirty conversation 的正文同步可以主动请求，但只按当前第一方 plural endpoint 的 cursor pagination 从最新向旧补到 message/node overlap；WSS 只负责“通知哪个 conversation 变了”，不承担完整正文传输。
- “大同步”：用户手动从 ChatGPT 官方 Data Export 下载 15–20GB 级 ZIP 后，离线解包 `conversations.json`/assets，与本地数据库做 diff/reconcile；官方包作为低频权威基线，不要求自动触发导出。
- 本地全文检索优先 SQLite FTS；后续再决定是否增加 embedding/向量检索。

#### 2026-09-03 Genesis Ground Truth（已实测）
- 旧包：`D:\Archive\ChatGPT-exports\ChatGPT-export-2026-07-02.zip`，5644 conversations / 90082 mapping nodes。
- 新包：`D:\Downloads\ChatGPTExport\...2026-09-01...zip`，6153 conversations / 109409 mapping nodes。
- 两包共同 conversation 5642；新包新增 511；旧包独有 2。共同 conversation 中旧 mapping node/message ID 缺失数均为 0，mapping 缩短数为 0；3 个共同 conversation 后续增长。
- 旧 asset 3313、新 asset 3486；9 个旧 asset 在新包及其 manifest 中均消失，且按 size+CRC 未发现同内容改名副本。
- 共同消息的字符串 text parts 变化数为 0；结构化 `content.parts` / metadata 可以随时间变化，因此 canonical current state 与 raw snapshot history 必须并存。

#### 2026-09-06 Genesis → Live Catalog 人工追平审计
- 通过已登录 ChatGPT tab 的同源 first-party list 形状（`limit=28`）手工向旧扫描，并与正式 SQLite 的 `conversation_id + update_time + title` 比较；只用于一次性追平审计，不作为常态监控方案。
- 扫描前 140 条：**64 个全新 conversation + 8 个已有 conversation 后续更新 = 72 个 dirty**；最后一个变化位于第 72 条。
- 第 73–140 条连续 **68 条完全一致**，超过 56 条保守 overlap 阈值，因此停止继续向旧扫描；证明 2026-09-01 官方 Genesis 到本轮审计时只积累了几十条 dirty conversation，而不是大规模历史缺口。
- 实测 list payload 的 `total` 不能当账号全量 conversation 总数：在分页查询中表现为随 offset/limit 变化的继续分页哨兵语义，因此同步停止条件必须依赖 overlap/页内容，不能依赖 `total`。
- 2026-09-06 正式 Genesis：6155 conversations / 109415 mapping nodes / 103260 messages / 11797 raw snapshots / 3495 assets / 10549 派生 resources；SQLite `quick_check=ok`，foreign key/orphan/duplicate 检查均为 0。
- 默认可读正文 FTS 共 56890 条，`三峡 / DevSpace / WSS` 等真实历史关键词均可检索。全 tool/reasoning trigram 审计索引继续保持显式 opt-in，避免数 GB 内存峰值。
- 官方 Data Export 的 message role 仅观察到 `assistant` / `user`；但 content type 明确包含 `text=46419 / thoughts=44081 / reasoning_recap=9931 / multimodal_text=2829`。当前两份大包没有 `finish_details/reasoning_status`，因此官方 ZIP 是历史正文 Ground Truth，不是事故状态 Ground Truth；终止/异常字段由后续在线 body/WSS 增量同步补齐。
- 当前主线从 Genesis 转入“小同步”：实现 conversation-list overlap discovery、body cursor/node overlap、dirty queue 与 WSS `turn-complete` 触发的增量 merge。

### Phase 8：聊天阅读位置书签
- 桌面端原型：离开 conversation 前记录 `{conversationId, messageId/turnId, scroll anchor, timestamp}`；返回时恢复到最近阅读位置。
- 优先使用稳定的 `messageId`/conversation-turn 元数据定位，像素 scrollTop 只做 fallback。
- 手机端需要单独验证：iOS 原生 ChatGPT App 无法直接安装网页 userscript/WebExtension，因此先验证 ChatGPT Web/PWA 可行性，再研究是否能通过同步服务把书签状态跨端保存；不承诺直接修改 iOS 原生 App。

### Phase 9：Run Watch / 卡死诊断与 iframe 内存取证
- Userscript/WebExtension 增加轻量环形日志，不保存 Authorization/cookie/tool payload 正文，只记录时间、conversationId、turn/request 标识、网络生命周期、页面生命周期、tool widget/iframe 数量与性能指标。
- **严格分开“生命状态”和“快照尾部形态”**：`final`、`finish_details=interrupted` 是终止证据；`tool-call-open`、`reasoning-open` 只描述当前 payload 停在哪里，绝不能单独判死。
- 实时生命状态以服务器 `stream_status` 为主：当前实测 `IS_STREAMING` 表示仍在生成，`COMPLETE` 表示流已结束；其它未知枚举保持 unknown，不把“非 COMPLETE”偷换成“仍在运行”。
- 只有服务器已经 `COMPLETE` 后，`tool-call-open` / `reasoning-open` 才能升级为“异常收尾”证据；这避免把长工具执行或长 reasoning 误判为卡死。
- Stop/Thinking 按钮、静默时长、最后回答长度只作为 UI/性能取证，不参与“死亡”判定。
- 记录 `visibilitychange / pagehide / pageshow / online / offline / error / unhandledrejection`，用于验证“切聊天、切后台、页面重载是否与 client_stopped/stream 丢失相关”。
- 对 DOM 中 iframe 做增量跟踪：创建/移除时间、`sandbox` 属性、src hostname/路径、是否仍 connected；按 Apps SDK/DevSpace widget 与普通 iframe 分类。严禁周期性全 DOM 深扫造成额外卡顿。
- 采样 Chrome 可提供的 `performance.memory`、iframe 数、长任务（Long Tasks）数量/耗时；达到预警阈值时在 sidebar 显示黄色/红色状态，而不是再给页面增加大型 iframe UI。
- 异常事件进入持久队列，并提供桌面通知、最近异常会话入口、诊断 JSON；手机 Push 由后续 Companion daemon/Webhook 层统一转发，不在页面脚本里硬塞第三方 push token。
- “自动继续”必须建立在可靠诊断之上且默认关闭；待积累足够样本后，仅对明确安全的异常类型提供 opt-in 自动续跑，避免重复执行有副作用的 DevSpace 工具。
- 建立 iframe budget：例如 50/100/200 档预警，并记录增长速率。复现后区分两类根因：A. 同一个 widget remount 后旧 iframe 未销毁（泄漏）；B. 每个历史 tool call 合法保留一个 iframe（设计性累积）。若是 B，后续研究仅卸载离屏 widget iframe/替换为静态占位的可逆实验，绝不先粗暴删除正在运行的 tool iframe。

### Phase 10：Fleet Watch — 一张轻量首页监控所有会话
- 面向“手机端同时启动 4～6 条长任务、桌面不能开 4～6 个巨型 ChatGPT tab”的真实使用方式。
- 桌面只保留一张轻量 `https://chatgpt.com/` 首页作为监控站；默认 discovery 不高于约 5 分钟一次。健康 streaming 不做固定周期 `stream_status` 心跳，只对首次发现、状态变化、疑似长期卡住和终止候选做交叉确认。
- 首次启动只建立基线，不扫描/通知历史故障；只有 `update_time` 新变化或从 `IS_STREAMING`→`COMPLETE` 后才读取最后 1～2 turns 做后验归因。
- 正常 `COMPLETE + final` 静默；明确异常进入持久事件队列并通知。未知 status、429、认证丢失都保持 unknown/error，不猜测。
- **限流是硬安全边界**：任意 Companion 主动私有 API 请求收到 429 后，所有 tab 共享至少 1 小时 circuit breaker；退避期间不允许 Fleet、历史审计、主动补取继续请求。不得采用“清 auth，等网页下一次正常请求后继续重试”的策略。
- Fleet Watch 不能在每个 ChatGPT tab 各跑一份；Userscript 首版只在首页监控站启用。WebExtension/Companion 阶段再升级为单实例 leader/background worker。

### Phase 11：ChatGPT Companion — 最终单运行时整合
- 开发期允许 Exporter / Run Watch / Fleet Watch / Reader 独立演化和测试；稳定后合并为**一个 ChatGPT Companion**，浏览器端只注入一份 runtime，不让多个 userscript 重复 patch fetch、扫描 DOM、占用内存。
- 内部分模块而不是多脚本：`capture`、`archive`、`fleet`、`run-diagnostics`、`widget-pressure`、`reader-bookmark`、`notification`、`sidebar-ui` 共享同一事件总线和持久状态。
- 浏览器页面只承担轻量当前页观察与交互；长期 Fleet、手机 Push、SQLite/FTS、归档同步逐步迁到本地 Companion daemon，减少 ChatGPT 页面常驻负担。
- 最终 sidebar 只有一个 Companion 入口，按需展开“归档 / 监控 / 搜索 / 阅读位置 / 故障”。

### Phase 12：轻量历史 Reader / 手机端友好阅读
- 巨型历史会话默认从本地 archive/SQLite 渲染，不再要求 ChatGPT Web 同时恢复上千个 Apps SDK iframe。
- DevSpace/Web/App tool history 在本地 Reader 里渲染为普通可折叠文本卡，不启动真实 sandbox runtime；只有用户显式要求交互时才加载对应资源。
- Reader 支持全文搜索、conversation/turn 锚点、阅读位置同步、工具轨迹折叠、附件/图片引用；目标是在手机端打开 3000+ message / 2000+ widget 的聊天也不因 iframe 数量崩溃。
- 后续把阅读位置、异常事件、Fleet 状态通过 Companion daemon 同步到手机；iOS 原生 ChatGPT App 本身不做注入。

### Phase 13：收尾闭环 — 完整导出 / CLI / Fleet 事故账 / 自动恢复
- **完整导出优先于 Reader**：被动捕获到 conversation JSON 不等于拿到了完整 conversation。必须区分完整 snapshot 与 `num_turns` / 分页 tail；partial payload 只能参与合并，不能无条件覆盖更完整 snapshot。用户点击 Markdown / HTML / JSON / 复制时，如果当前没有可证明完整的被动 snapshot，必须显式补取完整 conversation 后再导出。
- **完整性契约**：plural `messages[]` 优先依据 `page_info.has_previous_page` 判断是否缺历史；legacy `mapping` 作为完整分支 fallback。显式补取优先使用大 `num_turns` plural，并在仍有 previous page 时 fallback 到 singular mapping；无法证明完整时必须报错而不是静默导出尾部。
- **CLI 控制面**：保留 `archive-import/list/read/search/sync`，并复用 OpenCLI 现有 `chatgpt read/detail/history` 能力。任何后台 sync/auth capture 都不得 reload 正在工作的 `/c/<id>` tab；优先使用 `?companion-monitor=1` / `?companion-cli=1` / 空白 ChatGPT 首页，必要时单独创建轻量 tab。
- **当前状态与历史事故分离**：Fleet `tracked` 只表示“现在是什么状态”；另建不可因后续继续而删除的 incident ledger。一次 `COMPLETE + abnormal tail` 形成独立事故记录，即使同一 conversation 后来继续、成功 final，也只把事故标为 resumed/resolved，不删除历史事实。
- **历史审计**：正常实时 Fleet 仍只看最近/变化会话，避免高流量；另提供用户显式触发的慢速 audit，分页扫描历史 conversation，并对候选 COMPLETE 会话低速读取最后少量 turns，建立过去的 incomplete/abnormal 事故清单。已有本地 raw archive 优先离线审计。在线审计默认最多 50 条、至少约 5 秒/条；任意 429 立即停止，不与用户正常 ChatGPT 使用争抢请求预算。
- **通知与恢复闭环**：明确 abnormal incident → 持久化 → 桌面/手机通知 → 恢复审批。手机通知和长期执行迁到 Companion daemon；页面 Userscript 不保存第三方 push token。
- **Luna 审批门**：无人值守恢复先把事故摘要、最后工具动作、是否可能有副作用、仓库/设备真实状态检查结果交给 PI `openai-codex/gpt-5.6-luna`。只有 Luna 明确判定可安全继续时才发送续跑；写入/删除/安装/上传/git 等副作用状态不明时必须先核验，禁止盲目重复上一工具。
- Reader / iframe lazy load 在上述闭环完成后继续；Reader 仍以“不创建历史 Apps SDK iframe”为目标，但不再抢占当前主线。

### Phase 14：WSS 长时可靠性与半开连接取证
- 增加独立的**纯被动 CDP 采集器**，只观察 ChatGPT 官方页面自己的 `wss://ws.chatgpt.com/...`；不额外创建业务 WSS，不调用 conversation/list/stream_status，不保存认证头或业务正文。
- 每条 socket 记录 `webSocketCreated / frameSent / frameReceived / webSocketClosed / loadingFailed`、close 前后时间、最后一次任意 frame 时间、connect/subscribe 发送与 subscribe ack、`recovered` 值、重连延迟与 socket lifetime。
- 单独标记“CDP 仍未收到 closed，但 socket 长时间无任何 frame”的**半开/静默窗口**；不能把 JS `readyState=OPEN` 当成链路健康证明。
- 提供两类实验：A. 30–60 分钟自然挂机，统计自然断线/重连率与 frame 间隔分布；B. 只对专用轻量 helper tab 注入 CDP offline/online 故障，验证网络层中断被发现的时延、自动重连是否触发、恢复后是否重新订阅。
- 故障恢复后若 `recovered=false`，必须把断线窗口视为不可回放 gap；Fleet/Companion 只能在 gap 结束后做 reconciliation，不能假设 WSS 自动补齐历史事件。
- 采集日志采用 JSONL + 周期摘要，便于后续按 socket/requestId 聚合；脚本可独立运行，不把测试逻辑塞进生产 Userscript。

## 验收

- 浏览正常打开某聊天时，扩展可被动获得页面自身返回的 conversation payload；网络面板中不出现由本插件额外发起的 conversation API 请求。
- Travel 复杂 fixture 的默认 Markdown与现有 ChatGPT Exporter 风格结果语义一致。
- Rich manifest 能识别 Web Search、Trip.com、image_group、map widget 和 7 个生成文件链接。
- Chrome/Edge/Firefox 扩展均可构建；userscript 可构建。
- 单元/fixture 测试全部通过。
