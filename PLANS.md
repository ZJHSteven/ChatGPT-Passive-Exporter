# 2026-10-24 catalog/unbound Watchdog 去重与标题稳定性

- [in_progress] 修复 2026-10-23 现场：FPGA 与华北五省两个并发 conversation 均先由 DevSpace metadata 正常启动 unbound Watchdog，5m unbound gap-repair 后 catalog 又各自创建一次 `catalog:async-active:gap-repair` Start，形成每个 conversation 一次重复 New Chat。
- [pending] catalog active 在现场存在 unbound DevSpace generation 时不得立即发 Start；先登记 pending catalog candidate，并继续走原有 markDirty/Body sync，不新增网络请求。Body/exact binding 若把 CID 并入已有 unbound generation则丢 candidate；若 canonical Body 证明是独立 conversation，再按 catalog 首见时间回填 catalog Watchdog。
- [pending] 修复通知标题优先级：已存 canonical 真标题 > DevSpace init title > catalog candidate title > CID/metadata alias；`New Chat/New chat/新聊天` 永远视为 placeholder，不能作为最终 Bark subtitle。
- [pending] 将 5m unbound 诊断文案从“绑定失败”改为“暂未绑定/待绑定”，因为该状态只是 5m 时尚无 canonical binding；FPGA 现场 17:08:31 未绑定、17:10:19 exact 16/16 后成功绑定，证明它不是永久失败。
- [pending] 回归覆盖：两个 unbound metadata + gap-repair 两个 catalog active 不得产生第二组 Start；binding 后 candidate 合并；无 DevSpace 独立 catalog conversation 仍可在 Body 后启动；placeholder title 不得覆盖已有真标题。

## 2026-10-22 Watchdog generation 生命周期收口

### 已确认语义
- 不再恢复或新增 `>=60s` idle-resume identity probe。1m/3m/5m DevSpace idle 是独立链；其中只有现有 5m 路径允许一次 bounded Body diagnosis。
- `Final`、WSS `conversation-turn-complete`、45m Watchdog timeout 都表示“当前 Watchdog generation 已结束”。45m 到点必须先立即通知；随后 Body 只负责异常分类/取证，不再决定 generation 是否结束。
- 后续出现真实 DevSpace activity 时，不凭时间间隔或 metadata 猜新 turn。先保留最早 post-completion audit 时间，再通过事件驱动的异步 Body 校验确认 Body 中当前 user/turn 已发生在上一 completion 之后；确认后新 generation 的 `startedAt` 回填到最早 DevSpace activity，可向前修正，不能等下一条工具才起表。
- catalog stale `async_status=active` 的 anti-resurrection 只能局部作用于同一个 catalog observation generation，不能再用 conversation 级 active Watchdog tombstone 锁死后续真实 turn。
- Body completion evidence（当前代码旧名 `terminalEvidence`）只是 canonical Body 的局部分类 `final/client-stopped/interrupted/none`；它与 Watchdog generation completion、incident lifecycle 三者独立。代码/文档要收缩命名，避免再把三者统称 terminal。

### ExecPlan
1. 增加纯 helper 与回归，固定 reliable timeout 的生命周期：45m 到点后 generation 立即从 active set 退出，pending Body diagnosis 独立持有旧 generation identity；Body 成功后只完成 diagnosis，不得误删随后已建立的新 generation。
2. 新建 durable catalog-observation diagnosis watermark（conversation + catalog update_time），替代 catalog active Watchdog tombstone；同一未变化 catalog observation 不得重建 Watchdog，update_time 真正变化后才允许新 catalog generation。
3. 增加 post-completion DevSpace candidate：主循环仅记录 earliest/latest audit 并排一次 `devspace:post-completion-turn-check`；Body worker 成功后若 body 当前 user turn 的 create_time 晚于上一 completion，才建立新 generation，`startedAt=earliestAuditAt`。
4. late binding 时扫描该 metadata 在 recent completion 之后已经 durable 落盘的 audit，补入同一个 candidate，解决《控制GPU性能释放》23:59:28 已有 activity、00:05:15 才起 Watchdog 的漏回填。
5. 为 ready queue 加 trigger priority/不降级合并：Watchdog/WSS complete 等 lifecycle Body 高于 post-completion check，高于 checkpoint/catalog，后台 `devspace:binding-probe` 最低；低优先级请求不得覆盖或推迟已排队的高优先级请求。
6. 将运行时/诊断层 `terminalEvidence` 重命名为 `bodyCompletionEvidence`（持久化旧 SQLite 列名暂保留兼容映射），并在设计注释中明确“Body completion evidence ≠ generation completion ≠ incident resolution”。
7. 所有昂贵 Body/repair 保持在现有 ready/worker/cooperative maintenance lane；WSS/DevSpace audit 主路径只能做 O(1)/小范围索引查询与排队，禁止同步等待网络或长 SQLite merge。
8. 定向测试覆盖四个生产事故边界后跑 daemon tests、Archive DB tests、全量 `npm run check`；通过后再受控 reload production daemon，并验 Bridge/WSS/DevSpace wake/LifeOps/主循环 lag 与真实 start/timeout 行为。

## 2026-10-19 《整理磁盘容量》Watchdog generation 串轮取证

### 已确认事实
- 用户否决上一轮三层状态机改法；commit `8c269ba` 已精确撤回。恢复原语义：**45min 到点立即发第一阶段 timeout；随后拉 Body，再发第二阶段 watchdog diagnosis**。同时撤销 `>=60s` idle-resume Body probe 和 canonical Body 自动 rollover generation；cooperative binding worker、标题回退、DevSpace wake 等无关修复保持不动。
- CID=`6ab60de8-ccf8-83e9-8848-9d15ee8bf177` 在 22:50:37 确实收到 WSS `conversation-turn-complete`，但紧随其后的第一次 Body 指向更早的重叠 turn `762175a2-...`。22:49:27 新开的 turn `7198391f-...` 实际继续运行到 22:57:52，并有 `end_turn=1 / finish_type=stop` 的正常 final。因此 22:50:37 complete 不能解释成 `719...` 的结束。
- `719...` 的正常 final **没有被 Archive 实时看到**：其 `create_time=22:57:52`，但 `first_seen_at=23:35:54`，直到 45min Watchdog Body diagnosis 才补入数据库。该 CID 在 22:50:37 之后再无任何 WSS `conversation-turn-complete`，所以 `719...` 的 complete 确实丢失。
- `conversations` WSS carrier 在 22:57:52 final 时仍在线，直到 22:58:29 才旋转；activeSockets 始终 >=2，未形成 global gap。因此不能简单归因“final 时 WSS 已断线”。
- 旧 turn 最后一次 DevSpace audit 于 22:57:44 完成；22:59:02 系统确实跨过 1min idle 并发出 `devspace-idle`（Bark HTTP 200）。用户 22:59:11 又发新 turn `a2e77cfd-...`，22:59:32 DevSpace tool 恢复，因此 3min/5min idle 阈值被新活动打断，原有 **5min 才拉一次 bound Body** 的后验兜底没有机会触发。
- DevSpace `tool_audit.request_meta_json` 已保存完整 Host `_meta`，但 `719...` 与 `a2e...` 的 `openai/session`、`openai/subject`、organization、userAgent 全相同；`process_session_id` 只是本地命令会话，也无 turn 语义。新 turn 不会重新调用 `init`。因此现有 audit 数据里确实没有可直接使用的 per-turn / `turn_exchange_id`。
- MCP SDK 的 handler extra 另外暴露 `requestId / taskId / sessionId / requestInfo(headers)`，DevSpace 当前只保留 `_meta`。其中 JSON-RPC requestId 很可能是单 tool 唯一值、stateless transport session 也未必存在；唯一仍值得取证的是 Host HTTP headers 是否携带同 turn 稳定、跨 turn 变化的 correlation 字段，尚未验证，不能先假定存在。
- 通知链是另一条独立故障：该 CID 的 `watchdog-start`（22:49:50、22:51:26）、1min `devspace-idle`（22:59:02）、`watchdog-timeout`（23:35:47）和 `watchdog-diagnosis`（23:36:20）在 ledger 中均为 Bark HTTP 200，但用户未看到。必须单独排查 Bark/APNs/iOS 最终呈现，不可用“Watchdog 没触发”解释。
- 撤回版已完成生产回归与部署：定向 daemon 81/81；全量 `npm run check` 30 files / 286 tests 全绿，TypeScript 与 Chrome/Edge/Firefox/userscript 构建全部通过；受控 resume 后 PID=`38052`，6s 复核 Bridge=true、WSS=3、conversation transport=true、DevSpace wake=true（最近 10ms）、LifeOps pending=0、lastError=null。

### 下一步边界
1. 先保持原两阶段 Watchdog，不增加周期性 Body polling、不把 timeout 后移、不靠 idle 时间差直接重置 generation。
2. 继续取证 MCP handler `requestInfo.headers` / `taskId` 是否存在真正 turn 级本地 correlation；若存在，只增加本地身份观测，不引入 ChatGPT 网络请求。
3. 若确认 Host 完全不暴露 turn identity，则设计“候选 generation 但旧 deadline 不撤销”的多假设状态机：新工具簇可以成为候选新 task，但绝不因此延长/重置旧 45min；后续 WSS/Body/catalog 证据再归并。该方案需先单独评审重复 start/timeout 的人因语义，不能直接上线。
4. 独立排查 Bark 200→手机不可见链路；这和 generation 串轮是两个问题。

## 2026-10-18 LifeOps / Archive Bridge 周期性 5s/12s 超时回归

### 现场结论
- LifeOps `search_conversations` 的 5 秒与 `read_conversation` 的 12 秒都来自 LifeOps Worker `archive-client.ts` 的人为 HTTP 预算，不是 SQLite 内部 timeout。
- 同时段本机 `127.0.0.1:47832/health` 也会 3 秒零字节超时，因此 Cloudflare Tunnel / Access 不是根因；Archive Bridge 与 daemon 同进程，问题在本机 daemon 事件循环。
- 同一生产 SQLite 用独立 CLI 搜索/读取通常仅约 0.7–0.9 秒，FTS/Reader 本身可用。故障时 daemon 会出现分钟级日志空窗和较高单核 CPU，占用期间 Bridge 无法调度。
- 10 月 11 日已修过 live merge 全量派生重建导致的同类 event-loop starvation；当前该路径仍是 touched-message 增量维护，没有回滚。
- 新发现的当前回归点：`pollDevSpaceAudits()` 用 `while (true)` 一次性吃完整个 durable audit backlog；每条 audit 又同步执行 recovery mirror、Binding Queue overlap drain、SQLite fingerprint/matching。并发长任务积压时会重新形成“整批 backlog 饿死主循环”。
- 进一步生产压力验收发现第二个、更直接的同步阻塞源：unbound repair 会在 catalog/project repair 后排一组 `devspace:binding-probe`。这些 probe 只是为了从候选 Conversation 的 canonical tool evidence 绑定 metadata，但旧实现即使最新 body 的全部 message ID 已经存在，仍调用 `mergeLiveMessagesPage()` 重写页面数据。生产日志已抓到 `newMessages=0 / dbMergeMs=17766ms` 与 `newMessages=0 / dbMergeMs=10367ms`，期间本机 Bridge `/health` 连续 3s 超时。该路径必须在“全部 canonical ID 已知”时直接复用存量证据并跳过 merge；只有 probe 真看到新 message ID 时才允许落库。

### ExecPlan
1. 把 DevSpace audit consumer 改为 cooperative scheduling：每个事件循环 tick 只处理一个小批次，若仍有 backlog 用 `setImmediate` 续跑，明确把控制权交回 Node event loop。
2. 防止 wake / fallback / continuation 重入或重复排队；durable cursor 仍保持“单条完整处理成功后才推进”，不改变掉电/异常恢复语义。
3. 在 daemon state 增加轻量批次观测：最近批次处理数/耗时、累计批次数、因满批而主动 yield 次数，后续能直接判断是否又出现消费者长尾。
4. 增加回归测试，明确禁止 `pollDevSpaceAudits` 再出现无界 `while (true)` drain，并验证 continuation 使用事件循环让步而非递归同步继续。
5. 跑 archive-daemon 定向测试 + 全量 `npm run check`。通过后受控 reload production daemon。
6. 生产验收至少覆盖：本机 Bridge `/health` 连续快速响应；LifeOps search/read 多轮不再撞 5s/12s；制造/等待自然 DevSpace audit burst 时 daemon state 的 yielded batch 递增且 Bridge 仍可响应。
7. 不通过简单放大 LifeOps 5s/12s timeout 掩盖根因；只有确认 daemon 长尾消失后才重新评估这些预算是否需要调整。
8. **2026-10-19 语义纠正：Reader 性能优化只能改变“怎么分页”，不能改变“Conversation 包含哪些 canonical 节点”。** 保留 SQLite 内 ordinal/keyset 分页，禁止“全聊天读入 Node 后再 slice”；但 tool call / tool result / API / system / developer 等非 hidden canonical 节点仍必须进入正常 ordinal 与分页并返回正文。reasoning 节点也保留在节点序列中，仅内部 reasoning 正文继续 redacted。此前为缩响应而让内部节点不占分页位置的做法属于错误语义收缩，现已撤回。
9. 对 `devspace:binding-probe` 增加 no-op merge 快路：第一页全部 message ID 已存在时，直接返回 payload 的 diagnostic 并由后续 Matching Queue 从 SQLite 读 canonical evidence；禁止再次触发 messages/FTS/resources/raw observation 写放大。增加 skipped counter/log 与回归测试，并用刚才出现 17.8s no-op merge 的真实生产样本做 smoke。

## 2026-10-19 Archive 控制平面事件循环隔离 ExecPlan

目标：把 Archive daemon 明确分成“必须随时响应的控制平面”和“允许耗时的数据库/归档数据平面”。Bridge `/health`、LifeOps search/read 入口、DevSpace UDP wake、WSS/SSE 生命周期、Bark timer、CDP health/timeout 都不能再被任一同步 SQLite merge/binding/reindex 路径阻塞到秒级，更不能分钟级。

已确认时间线：
1. **长期架构弱点一直存在，但本次分钟级复发是近期新工作量放大。** 2026-10-11 曾有同类事件：live merge 对约 3500-message Conversation 更新 24 条消息时，全量 ordinal/FTS/resources/markdown 重建可同步堵 48–54s；`43febfe` 已修成 touched-message 增量，当前没有回滚。
2. 2026-10-16 `029fff7` 为 durable audit cursor 引入了“同步读完整 backlog”的 `while(true)` 消费方式。此前单条 audit 相对轻时风险不易显现；积压大时仍可饿死 event loop。
3. 2026-10-18 `64dcc1d` centralized Binding Queue 的**方向正确**：多 Body/SSE/passive ingress 统一发布 canonical evidence，只匹配 pending/unbound 工作，避免每个入口各自维护 binding。问题在于实现把 `drainDevSpaceBindingQueueForAudit()` 放进每条 audit 的同步热路径：一条 audit 最多同步扫 256 个 pending evidence，每个 evidence 又会做 stored-turn read、metadata revision、activity/matcher、binding/recovery mirror。因此“数据集合更小”并不等于“延迟更小”，工作被集中到了最敏感的事件循环 callback 内。
4. 同一天 unbound repair 的 `devspace:binding-probe` 又会在 `newMessages=0` 时做完整 canonical merge；真实生产记录有 17.8s / 10.4s 纯 no-op merge。无界 audit backlog × 每 audit 同步 queue drain × 偶发十几秒 merge 叠加，解释了 10/18 Bark/Bridge/CDP 一起出现分钟级迟到。
5. 当前数据库约 11.56GiB 是**放大器而不是搜索根因**：Conversation-first CLI 搜索（包含 Node 冷启动）当前 p50 约 0.5–0.6s；真实 LifeOps `/v1/search` 的 Archive 内部 timing 约 0.13s。大库更显著影响写放大、全量扫描、FTS/resource 重建与维护，不应把它解释成索引读天然需要数秒。

近期止血已落地：
- audit backlog 改为小批次 + `setImmediate` continuation；
- `devspace:binding-probe` 全部 message 已知时在 merge 前 fast-path；
- audit 内 exact-match/rebind 移到 cooperative binding worker，每 tick 最多一条 evidence；
- Reader 恢复完整 canonical 节点语义，同时保留 DB-side pagination / ordinal index 快路。

下一阶段架构门槛：
1. **先量化 event-loop SLO，而不是继续凭日志空窗猜。** daemon state 增加 event-loop lag（recent/max/percentile 或等价 timer drift）以及每个同步阶段的 wall time；任何单次同步 section >100ms 记 slow-path，>1s 记 infrastructure incident。目标控制平面常态 P99 <50–100ms。
2. **`setImmediate` 只是 cooperative 止血，不是最终隔离。** 它只能在两个工作项之间 yield，无法抢占一条 10s 的 `DatabaseSync.run()/all()`。所有可能随数据规模增长到 >100ms 的 merge、FTS/resource rebuild、binding scan/rebind、历史 repair 必须迁离控制平面线程。
3. 优先把重数据库工作迁到独立 Worker Thread/child process（更偏向 child process 做故障域隔离）；主 daemon 只 enqueue 小任务、接收小结果。SQLite 继续 WAL：writer 串行化是数据库约束，但不能等价成 Node HTTP/WSS/UDP/timer 也一起串行等待。
4. Bridge Reader/Search 最终也应具备独立进程入口或专用 read worker。独立 CLI 在 daemon 卡死时仍能 0.5–0.9s 完成搜索已经证明“读服务与采集 writer 解耦”可行；这样即使 writer 出现坏 SQL，LifeOps/Reader 也不会一起关门。
5. 所有 bulk/recovery/reindex 路径都必须有有界 batch、显式 yield/worker 边界和状态可观测；禁止在 UDP/WSS/HTTP callback 内直接循环 drain 未知数量工作。
6. 先完成 event-loop/stage telemetry，再按真实热点逐项迁移；不通过简单放大 LifeOps 5s/12s timeout 掩盖基础设施阻塞。

2026-10-19 05:2x 补充：下一阶段先把 canonical writer 的 630ms 拆成可归因阶段，再决定物理拆库/sidecar 边界。当前生产 SQLite 文件约 12.48GB、4KiB page、约304万页，WAL约96MB；连接仍使用 SQLite 默认 `cache_size=-2000`（约2MiB）且 `mmap_size=0`。官方 SQLite 文档确认 `-2000` 就是约2,048,000 bytes 的默认 page cache，mmap 默认关闭；这对当前热工作集值得单独基准，不应直接凭经验调大。定点 `dbstat` 已确认 `messages` 主表本身约4.90GB/119.6万页（不含其索引和FTS），说明“热message layer约3GB”已低估；44万行但平均行很肥，`text/metadata_json/author_json/content_json/raw_json` 冗余和 overflow page 会放大 merge I/O。后续：
- 不再跑全库 dbstat 扫描；按对象/样本做低扰动审计。
- 给 `mergeLiveMessagesPage()` 增加内部 timing：pre-adapt/json/knownIds、conversation/head、message upsert、parts/mapping、raw observation gzip+insert、derived FTS/resources/count、incident/post-merge；真实 Body 直接输出阶段耗时。
- 用独立只读连接对默认2MiB cache 与候选64/128MiB cache、256MiB mmap做代表性 Reader/Search/binding SQL A/B；只有生产样本显著获益才落 PRAGMA，避免“调参即修复”的错觉。
- 重点验证 `live_observations` 虽然查询冷，但目前与 canonical hot merge 同事务写入 `gzipSync(rawText)` + blob insert；若其CPU/WAL/page-cache成本显著，就把 observation journal 从热事务移出，优先拆到独立冷库/sidecar，而不是让协议取证拖住 message writer。
- writer sidecar 设计必须避免主 daemon 继续持有同步写连接等待 SQLite writer lock；目标不是“换线程执行同一把锁”，而是控制面不再同步等待重写入。

## 2026-10-19 Archive 长期存储与主循环瘦身 ExecPlan

背景：生产 `data/` 已约 14.0GB，主库约 12.0GB；2026-10-18 容量审计已确认 `messages≈4.39GiB`、`live_observations≈3.06GiB`、三套 FTS≈2.15GiB，当时三者已占绝大部分主库。2026-10-19 重新定点审计又确认 `messages` 主表本身已约4.90GB。当前问题不是 SQLite 容量上限，而是长期运行的数据布局与 daemon 故障域仍保持科研原型形态：canonical、runtime、search index、raw evidence、protocol observation、repair/recovery 都混在同一主库/主进程。

### 目标存储边界
1. **Hot Core**：conversation identity、canonical message 的热字段、mapping/head、incident、Watchdog、DevSpace binding/audit cursor、sync debt 等高频状态。日常控制面 SQL 必须只碰窄表/窄 covering index，不允许因为 raw JSON/大正文而回表扫 overflow page。
2. **Search Index**：FTS 是可重建派生物，不再视为 canonical source of truth。最终独立到专用 search SQLite（优先 contentless/external-content 设计），允许独立 rebuild/replace；Hot Core 不因 FTS rebuild 或 bigram/trigram 维护长期持 writer lock。
3. **Cold Evidence**：raw conversation/body、raw message JSON、mapping snapshot、protocol response/body、巨大 DevSpace result 等按内容寻址（SHA-256）压缩落文件/CAS；SQLite 只保存 event/index/ref。相同 payload 只存一次，每一次 observation event 仍永久保留时间、kind、endpoint、header/protocol/status/source 等 provenance。
4. **可重建派生物**：message_parts、resources 中纯派生内容、FTS private content、副本型 snapshot 必须明确标记 rebuildable，不得和 source-of-truth 数据享有同等保留成本。
5. 长期容量目标不是“12GB 压成某个固定值”，而是让**日增长主要由真正新增 canonical message + 新的唯一 evidence bytes 决定**；重复观察同一 body、重复 FTS 内容副本、重复 raw JSON 不再线性增长主库。

### Phase A：先收主循环/故障域（本轮实施）
1. 把 daemon 5s 主循环拆成两条 lane：
   - Critical lane：Guardian 建立/存在性、CDP runtime health、UI health、WSS gap、rate-limit block/cooldown、state heartbeat。
   - Maintenance lane：passive observer attach、DevSpace 60s fallback、periodic reconcile、watchdog diagnosis queue、dirty/checkpoint drain、gap repair、unbound diagnosis、image hydration、protocol maintenance。
2. Maintenance lane 单实例运行（`maintenanceLaneInFlight`），每个大步骤之间 cooperative yield；慢网络等待或普通 maintenance error 不再延迟下一次 Critical tick。
3. **故障域隔离**：Maintenance 捕获自己的错误并记录状态；不得走主循环 catch、不得关闭 Guardian。只有 Guardian/CDP/WSS 核心健康失败才允许触发 Guardian rebuild。
4. 增加 lane telemetry：runs/lastMs/maxMs/lastError/inFlight，写入 daemon state；以后判断“主循环慢”先区分 critical vs maintenance。
5. 回归测试锁定：main loop 不再直接 `await drainDirty/reconcile/gapRepair/hydrate`；maintenance failure 不得调用 `guardian.page.close()`。

### Phase B：停止容量线性放大
1. `live_observations` 先做 event/payload 分离：event 永久保留；payload 按 sha256 去重。2026-10-18 已实测完全重复 gzip payload≈1.447GiB，约占 observation payload 47.5%，这一刀无损且收益最高。
2. raw message JSON 从 `messages` 肥 row 剥离：先做压缩 CAS/冷 blob 引用，再根据 hash 做 message-level raw evidence dedupe；Hot message row 保留搜索/Reader/运行所需字段。
3. FTS 迁到独立 rebuildable search DB，并实测 external-content/contentless；当前三套 `_content` 副本约560MB，可先无损去掉私有内容副本。
4. 迁移必须在线下 maintenance/sidecar 完成，生产 daemon 不允许启动时扫12GB做 schema/data migration。

### Phase C：writer sidecar
1. canonical write / derived index / evidence writer 统一走专用 child process 或 writer service；主 daemon 只 enqueue 小任务，不持有会等待 writer lock 的同步写路径。
2. Cold Evidence 采用“先 durable blob/CAS，后 Hot Core 写引用”的提交顺序；跨多个 WAL SQLite 不假设原子事务。
3. 增加容量日报：Hot Core/Search/Cold Evidence 文件大小、每日新增 canonical bytes、unique evidence bytes、dedupe saved bytes、重复 observation 数、磁盘 runway。

## 2026-10-16 Bark / Watchdog 手机通知第二轮人因化

### 现场问题
- iPhone 通知中心真机截图显示，当前“事件主题 + 会话名”都塞进 title 后，标题经常在首屏截断；正文再重复会话名，实际占用了最宝贵的两三行。
- 生产 `turn_notification_ledger` 最近 24 小时约有 293 条成功 Bark：其中 `devspace-idle` 116、`turn-final` 67、`watchdog-start` 43，是主要高频来源。固定按 `Chat-Latency / Chat-Timeout / Chat-Done` 分类的 Bark group 会把不同会话堆成 10～30+ 条的大组，折叠后只剩数字角标，用户无法一眼知道新消息属于哪个会话。
- 极端正文仍过长：`devspace-checkpoint` 最近 24h 平均约 704 字符、最大 1339；`5 分钟诊断 + canonical-tail-gap` 平均约 338。完整取证应留在 SQLite / DevSpace，不应搬到锁屏。
- 当前 Bark POST 只发送 `title/body/group/url`，没有设置 `level`，也没有任何“persistent banner”字段；横幅是否临时/持续属于 iOS/Bark App 的通知展示设置，不应通过服务端伪造。

### ExecPlan
1. 保留全部现有通知触发频率和持久去重 key；本轮只做人因展示与分组，不擅自静默 1/3/5 分钟、Final、Watchdog start 等事件。
2. Bark payload 新增标准 `subtitle`：title 专门表达“事件 + 结论”，subtitle 专门表达“会话身份”，body 只留一个最重要补充事实。conversation-scoped 通知不再把会话名同时塞进 title 和 body。
3. 高频 conversation 通知的 Bark group 从“全局事件类别”改成“每个 conversation 一条 thread”；同一聊天的工具静默、Watchdog、Final 等折叠在一起，避免全局 `Chat-Latency 36` / `Chat-Timeout 13` 这种不可扫读的大堆。未绑定 metadata 使用稳定短别名 thread；基础设施告警继续使用 `Archive-Warning` 等固定分组。
4. 重点精简：Watchdog start/timeout/diagnosis、1/3/5 分钟 idle、5 分钟诊断、Turn Final、DevSpace checkpoint/conclusion、未绑定 Watchdog。时间只显示 `HH:mm`，完整秒级时间、CID、metadata、taxonomy 留在持久化层。
5. checkpoint/conclusion 的手机正文做 Unicode 安全截断并折叠换行；完整 summary/next/conclusion 不改写、仍保留在 DevSpace SQLite / Archive ledger。
6. 更新 `NOTIFICATION_STYLE.md`，把旧“title=事件+18字会话名、group=事件类别”升级成“title=事件/结论、subtitle=会话、group=conversation thread”的新契约。
7. 更新 notifier/daemon 单测和声明文件，跑定向测试 + `npm run check`。通过后受控重载生产 daemon，并确认 Bark、Bridge、WSS、Guardian 健康；不伪造大量手机 canary。
8. iOS 侧单独说明：若用户说的是屏幕顶部横幅一直挂着，应将“设置→通知→Bark→横幅样式”改为临时；通知中心/锁屏历史本来就会保留，不能靠 Bark payload 设置成自动删除。

## 2026-10-16 Watchdog 启动覆盖与 DevSpace durable replay

### 目标
- 所有 DevSpace metadata 一旦出现首个工具调用，就必须立即进入一个明确的 Watchdog generation；是否已绑定 canonical Conversation 不能决定“有没有 Watchdog”。
- unbound generation 也必须立即发启动收据：优先使用 metadata 注册 Title；绑定后再使用 canonical Conversation title，避免用不可辨识的 metadata ID 作为正常展示。
- Archive daemon 无论离线多久，重启后都必须从 durable 消费游标继续 replay DevSpace tool_audit，不能依赖固定 2 分钟 lookback。
- 对 2026-10-16 已发生的 daemon 离线窗口做一次历史补洞：区分“只漏 Watchdog/审计镜像但 canonical Body 已由 WSS/final 补回”与“Body/terminal/incident 真缺失”，仅补真实缺口。

### ExecPlan
1. 统计 10-16 DevSpace tool_audit 与 Archive devspace_recovery_audits 的差集，按 metadata、时间段、绑定 conversation 聚合；逐个确认对应 canonical turn/body 是否已存在。
2. 梳理所有通知的 title fallback：Conversation title → metadata Title → metadata ID（仅 Title 异常缺失时的故障兜底）；确认历史 metadata ID 通知来自哪些旧/异常路径。
3. 在 Archive DB 增加 durable DevSpace audit cursor/high-water 状态，游标至少包含可稳定排序的 started_at + audit id；poll/replay 分页直到追平，成功消费后才推进游标。
4. daemon startup 不再用 Date.now()-2min 作为唯一 catch-up 边界；首次升级时安全 bootstrap，之后严格从 durable cursor 续读。UDP wake 仍做低延迟门铃，60s poll 仍做兜底。
5. unbound metadata 首次被观察时立即创建 provisional Watchdog start receipt；用 metadata Title 显示，不等待 Conversation ID。绑定后沿用同一 startedAt generation，避免第二条重复开始通知。
6. 增加单元/集成测试：长时间离线 replay、同毫秒多 audit、分页、重启幂等、unbound title、缺 Title 故障兜底、bind 后去重、已有 active_watchdogs 恢复。
7. 对今天历史缺口执行一次受控 replay/repair，验证 canonical Body/terminal/incident 完整性；不能因旧 tool audit 把已完成 turn 错误复活。
8. 全量 typecheck/test/build 后受控重启生产 daemon，做真实新 metadata canary：首个 DevSpace 调用即收到 Title 可辨识的 Watchdog 开始通知；再绑定 Conversation 验证不重复发通知。

# 2026-10-16 Watchdog 无声死亡与自愈加固 ExecPlan

状态：**根因修复已生产上线并验证；监督层代码与全量回归已完成，但生产计划任务重注册再次被管理员 PI 拒绝，尚未部署自动拉起新定义**。

## 2026-10-16 维护态 / 部署态补强

用户确认自动自愈不能干扰正常开发部署。最终监督语义调整为：

1. Task Scheduler 仍是唯一外部监督者：AtLogOn + 1 分钟 repetition + IgnoreNew，不增加第二个 helper/task。
2. `daemon stop` 先进入 maintenance，再停止 Node。maintenance 存在时，计划任务 launcher 即使被周期触发也不得启动 daemon。
3. `daemon start` 是开发期直接启动，保持 maintenance，避免计划任务下一 tick 在旁边再起第二实例。
4. 新增 `daemon resume` 作为生产恢复：maintenance 下发一个 one-shot permit，允许同名计划任务只启动一次；CLI 观察新 daemon 基础健康一小段时间。健康后才清除 maintenance、正式 arm 自动自愈；失败则保留 maintenance 并停掉失败实例，禁止坏版本一分钟一次循环复活。
5. launcher 只读取本地 maintenance / one-shot flag，不常驻、不轮询；健康 daemon 运行时 Task Scheduler 的 IgnoreNew 仍保证周期 tick 不创建 launcher/node 第二实例。
6. 增加回归覆盖 stop/start/resume 语义、launcher flag gate、startup task 参数与 IgnoreNew；全量 check 后再重提管理员安装审批。

## 2026-10-16 生产任务“监督设置原位升级”收口

正式 adminreq 在同一命令 ReviewOnly 可批准、Execute 又因 352 KiB daemon 的整体行为审阅产生不稳定拒绝。为了让管理员授权边界与真实变更一致，不再用“完整安装器”更新已有生产任务：

1. 新增一个仅用于已有生产任务原位升级的小型 PowerShell 脚本；它不是常驻 helper，也不会被计划任务执行。
2. 脚本必须先读取现有 ChatGPT Archive Daemon，fail-closed 校验：当前用户 / Interactive / Limited；action 仍是系统 wscript.exe；working directory 是本仓库；launcher、node、daemon、db 均为 canonical 路径；参数必须是当前旧格式或已经升级后的新格式。
3. 校验通过后，只把同一 payload 的参数升级为 maintenance/start-once 格式，并更新 AtLogOn + 1min repetition、IgnoreNew、battery=false、ExecutionTimeLimit=0；不允许指定其它 TaskName/payload/path。
4. adminreq 只审这个小脚本，因为本次管理员动作确实只是修改既有任务监督设置；daemon 大型业务代码不是本次管理员变更。
5. 更新后再做生产三段验收：健康 IgnoreNew、maintenance stop 不复活、无 maintenance 的意外 kill <=1min 自愈。

状态：**已完成并通过三段生产验收**。

生产结果：
- 任务定义已原位升级成功：固定同名任务、Interactive/Limited、supervised action、AtLogOn + PT1M repetition、IgnoreNew、battery=false、ExecutionTimeLimit=0，旧 RestartOnFailure XML 已完全移除。
- 健康态：12:07:28 周期 tick 产生 Event 322，Node PID 24780 不变、daemon 进程数始终为 1，Bridge/Wake/WSS 正常，证明 IgnoreNew 不启动第二实例、不打断现有实例。
- 人工维护态：12:07:54 `daemon stop` 先写 maintenance 并成功停止 PID 24780；12:08:28 周期 trigger 仍会进入 Task Scheduler，但 launcher 约 53ms 即 exit 0，没有启动 Node；12:08:44 NodeDaemonCount=0，证明开发部署停机不会被误复活。
- 未知崩溃态：恢复到 supervised 后，于 12:10:19.181 直接 `Stop-Process -Force` 杀死 PID 18884，不写 maintenance、不调用任何 Start-ScheduledTask；12:10:28.345 下一个周期 trigger 由 Task Scheduler 自己触发，12:10:29.319 已观察到新 PID 8456，恢复新进程耗时 10.138s。12:10:58 新实例已达到 startupPhase=running、Bridge=true、DevSpace wake=true/handlerErrors=0、Guardian failures=0、WSS=3/gap=null、syncErrors=0、notification/daemon lastError=null、maintenance=false。
- 因此最终责任边界已经闭环：Task Scheduler 是唯一外部监督者；launcher 只是该任务 action 的瞬时 gate，不是常驻 helper；maintenance/one-shot 明确区分主动部署与意外掉线。

### 生产 resume 首次 canary 暴露的启动身份窗口

- 新 Task Definition 已成功上线；第一次 daemon resume 在 15 秒健康窗口内报失败，但实际新 Node PID 25884 随后健康运行，maintenance 正确保持 active。
- 时间线确认：Node 11:59:04 已创建，daemon 因启动期历史 seed 到 11:59:23 才写新 state；resume 11:59:19 超时时仍读到旧 PID，因此失败清理无法定位新实例。
- 修复要求：daemon 在读取旧 state 后、任何重型初始化前立即写 bootstrap state（新 pid/startedAt/startupPhase=initializing）；resume 只接受 pid 已换代且 startedAt 属于本次 probe 的 state，并把基础健康窗口放宽到 45 秒。失败清理必须等待 SIGKILL 真正生效并确认 PID 已退出。

现象：2026-10-16 08:47:32 ChatGPT Archive Daemon 以退出码 1（Task Scheduler 记录为 0x80070001）异常退出；此后新 turn 全部失去 Watchdog。重新核对 DevSpace audit 后确认，10/14、10/15 那些数秒后重新起来的实例都来自当时聊天显式执行的 schtasks /Run / Start-ScheduledTask，并非 RestartOnFailure 自动拉起。进一步用隔离临时任务验证：合法 RestartCount=2、RestartInterval=PT1M、action=cmd /c exit 1，等待 70 秒也没有自动重启；本机 Task Scheduler 不会把“action 已成功启动、子进程随后返回非零 exit code”当成需要 retry 的任务级失败。

目标：让 Archive daemon 即使再次遇到顶层/事件回调 fatal 也能留下明确异常栈；进程级自愈完全由 Task Scheduler 本身承担，不引入外置 helper：AtLogOn 负责首次启动，每 1 分钟 repetition trigger 负责存活兜底，MultipleInstances=IgnoreNew 保证健康 daemon 不会产生第二实例。

1. 生产时间线已锁定：08:47:30.727 另一聊天启动 chatgpt-archive daemon status + 多次 search；08:47:32.484 DevSpace UDP wake 收到 write_stdin audit；08:47:32.785 Task Scheduler 记录 Archive daemon code 1；该 audit 没有进入 recovery 表。
2. 隔离复现已完成：另一个连接持有 Archive 写事务时，旧版 busy_timeout=0 会让 observeDevSpaceMetadata 0ms 直接抛 database is locked；异常经 DevSpaceAuditWakeListener 裸 onWake 从 UDP Socket 回调冒泡，Node 与生产一样 exit code 1。
3. 根因修复：Archive DB busy_timeout=5000；migrate 中两条历史 incidents UPDATE 改为先 SELECT EXISTS、只有确有旧数据时才写；最新 schema 下即使另一个 writer 已持锁，再次构造 ChatArchiveDb 仍可约 3ms 完成，不再为普通 search/read 制造稳态写事务。
4. DevSpace UDP wake handler 增加异常隔离，记录 handlerErrors/lastError；门铃处理失败只等待下一次门铃或 60s durable poll 补账，任何单次 SQLite/解析异常都不得杀 daemon。
5. 顶层 fatal 日志继续保留，覆盖 main reject、uncaughtException、unhandledRejection。监督层不再依赖 RestartOnFailure；改为 Task Scheduler 每 1 分钟重复触发同一任务 + IgnoreNew。AC 息屏/Modern Standby 已明确排除为本次原因。
6. 已完成 busy timeout、writer 持锁下稳态 reopen、wake handler throw-survival 等回归；全量 27/27 test files、245/245 tests、TypeScript 与四套 build 通过。生产 daemon 已重载为 PID 13176；当前真实 DevSpace wake 已消费 44 次，handlerErrors=0、WSS=3、Bridge=true、Guardian failures=0、syncErrors=0、notification/daemon lastError=null，且没有 daemon fatal。
7. startup helper 已纠正为 1 分钟 repetition trigger + battery 条件关闭，并移除误导性的 RestartOnFailure 配置。重注册现有生产计划任务仍需要管理员权限；完成代码/测试后走 adminreq 正常审批，不绕过策略。生产验收必须包含：健康时一分钟 tick 不产生第二实例；受控停止 daemon 后 <=1 分钟由 Task Scheduler 自身重新启动。

# 2026-10-15 第一方协议贴合审计与漂移判级修正 ExecPlan

状态：**已完成并部署**。27/27 test files、240/240 tests、TypeScript 与四套构建通过；真实 ledger semantic actionable=0；生产 daemon 最终由计划任务重载到 PID 16252，并恢复 WSS=3 / Bridge=true / Guardian healthy。

目标：把 ChatGPT Archive 的协议验收标准从“请求还能成功”收紧为“生产主动请求尽可能复刻当前第一方 Web 的同语义请求”。只有强瞬态/强会话态、无法安全生成、或第一方本身多态且没有唯一正确形状的字段才允许不复刻，并必须在代码/测试中留下理由。与此同时，修正协议监控把不同语义的一方请求错误混成同一 baseline 的问题，避免既误报也漏报。

1. 复核 2026-10-07 以来历史协议漂移提交，确认旧 header/query 变化是否真实进入生产实现，而不是仅被“确认不影响”。
2. 为 Conversation List 按语义拆分协议 family：global catalog、TPP include、TPP exclude/其它 filtered 不再互相当 baseline。生产 global replay 只和第一方 global list 比；sidebar filtered 仍单独监控。
3. 保持当前 global catalog query 为第一方最新形状：`offset/limit/order/is_archived/is_starred`。不因为旧 sidebar baseline 带 `expand/hide_snorlax` 就把这两个字段错误加回 global replay。
4. Header 继续采用“捕获第一方真实值并合并”的动态继承：`oai-client-version`、`x-oai-mcp-form-version` 等无需写死；监控需要区分“上游新增但生产已自动覆盖”和“生产白名单真正缺失”。
5. `x-oai-turn-trace-id` 保持 session-scoped，禁止全局复制；但若一次 `syncConversation` 本来就在 checkpoint/turn session 内，则该轮后续 singular mapping 也继承同一个 extraHeaders/trace，和同 session 第一方行为贴齐。
6. Turn Submit 继续由官方 React/DOM 触发，不手搓 `/f/conversation` payload。新增 `genui_state_snapshots / conversation_mode / gizmo_id` 等字段由当前第一方前端自动生成；协议 ledger 仍记录这些变化，但不把“native-owned payload 自动跟随”误报成需要手工改生产 POST 模板。
7. 增加回归：catalog family 不交叉 baseline；global catalog 新形状不再因旧 TPP query 误报；checkpoint exact mapping 继承 turn trace；历史 header coverage 行为保持。
8. 跑 TypeScript、协议/daemon 定向测试、全量 `npm run check`；更新 PROGRESS.md。若代码改变生产 daemon 路径，再受控重载并验证 WSS/Bridge/Guardian/协议状态。

# Bark 手机通知人因化规范与 Watchdog 诊断精简（2026-10-14）

目标：把手机通知从“数据库字段展示器”恢复成锁屏上一眼可读的事件摘要。继承《Bark消息分组方案》中已经确定的 18 字聊天名截断、正文最多两行、长身份下沉正文、删除无信息增量套话等规则，并补充“诊断结论按用户关注顺序而不是 taxonomy 字段顺序展示”。

- [done] 新建长期文档 `NOTIFICATION_STYLE.md`，固化 Bark/手机通知规则，避免以后每加一种通知又重新发明文案。
- [done] Watchdog 第二阶段通知标题统一为 `Watchdog 诊断 · <短会话名>`，去掉 `ChatGPT` 前缀，也不再把 `active-zombie` / `watchdog-timeout` 塞进标题。
- [done] Watchdog 诊断正文最多两行；第一行只展示最强用户可见结论，优先级为 `canonical-tail-gap`（Body 尾部缺失） > confirmed Final > “未确认 Final、未发现尾部缺失”。若聊天名因 18 字限制被截断，第二行再放完整会话名；短会话名不重复写正文。
- [done] `watchdog-timeout` 继续保留为内部 lifecycle fallback，但不得冒充用户可见的“诊断根因”；`lifecycle / terminal / tail / head / reason / evidenceTypes` 完整保留在 SQLite/日志供排障。
- [done] 通知单测已覆盖短标题、长标题、tail-gap、Final、无 Final/无 gap 三类结果；定向 61/61、全量 `npm run check` 为 27 files / 233 tests 全绿，四套 build 全过。Windows 计划任务已受控重载生产 daemon，当前 PID 38504、Bridge=true、WSS=3/gap=null、Guardian failures=0、LifeOps pending=0、Bark/daemon lastError=null。

# 2026-10-14 Watchdog 起点通知 ExecPlan

目标：在每个新的 Watchdog generation 真正建立时立即发送一条轻量 Bark，让用户无需等到 45 分钟超时就能知道“这一轮从几点开始计时、预计几点触发 Watchdog”。通知沿用现有 Bark 标题截断、完整会话名、分组、URL 与持久去重机制，不改变 Watchdog 阈值、诊断、Incident 分类或现有超时通知语义。

- [done] 新增 `Watchdog 开始 · <聊天名>` payload builder：标题继续使用现有 18 Unicode 字符压缩规则；正文显示完整会话名、canonical Conversation ID、北京时间起点、预计超时点和当前 Watchdog 分钟数；归入 `Chat-Timeout`。
- [done] 只在**新的 CID 已知 Watchdog generation** 建立时发送，不在 daemon 启动恢复 `active_watchdogs` 时补发历史开始通知，避免部署/重启后一次轰炸所有旧 generation。
- [done] DevSpace first-tool、WSS 明确新 turn、catalog late-active 三条 generation 建立路径统一接入；同一 active generation 的后续 tool/progress 不重复发送。
- [done] Watchdog body 诊断若发现同 conversation 已切到更新 turn，仅当该新 turn 尚未再次跨过 Watchdog 阈值时补发一次该 generation 的开始通知；若已经超时则直接走现有超时/诊断链，避免同一瞬间连续“开始+超时”。
- [done] 使用 `turn_notification_ledger` 做持久幂等；Bark 发送失败不写成功 ledger，重复建立事实仍可安全重试。daemon restart 恢复的旧 generation 不主动补发 start，因为本功能只对上线后的新 generation 生效。
- [done] 增加短标题、长标题、CID、北京时间起点/预计超时、45 分钟阈值以及 generation 去重 key 的回归测试；同步 `.d.mts` 声明。
- [done] Archive daemon 定向 61/61、全量 27 files / 233 tests、TypeScript 和四套 build 全绿；Windows 计划任务已重载到 PID 21024，Bridge/WSS/Guardian/Bark 健康，且 ledger 验证启动恢复未补发任何历史 `watchdog-start`。
- [done] 2026-10-15 00:40 真实 canary 暴露“通知早于 ChatGPT 自动命名”：同 CID 已有 DevSpace `displayTitle=排查 Watchdog 漏通知并新增开始通知`，但 Bark 仍显示 `New chat`。现已修正为：canonical 标题若仍是 `New chat / 新聊天 / CID` 占位符，则优先使用该 CID 最新的非空 DevSpace displayTitle；一旦存在正式 canonical 标题，则始终优先正式标题。定向 62/62、全量 27 files / 234 tests 与四套 build 全绿；生产 daemon 已受控重载到 PID 22612，Bridge/WSS/Guardian/Bark 健康，重载后 `watchdog-start` 总数仍为 7、无历史补发。
- [done] 调整 Watchdog 起点 Bark 的锁屏信息顺序：正文第一行固定放 `起点 → 超时（45分钟）`，第二行才放 CID；CID 只作为排障身份，不再抢占首屏。即使聊天名被标题截断，也不再把完整会话名塞进起点通知正文。定向 62/62、全量 27 files / 234 tests 与四套 build 全绿；生产 daemon 已重载到 PID 31748，Bridge/WSS/Guardian/Bark 健康，重载前后 `watchdog-start` 总数保持 9 且新 daemon 启动后新增 0 条，确认无历史补发。

# 2026-10-14 Archive 429 分级 cooldown / 请求事件账本 ExecPlan

目标：保留现有 Retry-After 已显著改善 body 429 恢复的优点，但拆掉“任一 family 429 就冻结全部主动 API”的全局耦合。catalog 429 只抑制 catalog，body/mapping/Actor 继续按各自状态工作；同时从现在开始持久化轻量逐请求事件，为后续 rolling-window 429 风险建模提供真实 time series。

1. 保留旧 cooldownUntil 读取兼容，但新增持久化 family cooldown state。至少区分 catalog、body、mapping、actor；native sidebar catalog 与 Archive global catalog 共用 catalog family。
2. body / mapping / actor 有 Retry-After 时继续服从服务端 deadline + 5s buffer / 30s 下限；无 Retry-After 时保守回退，但只冻结对应 family，不再连带 catalog/其它主动能力。
3. catalog 无 Retry-After 时采用有上限的分级退避：5m → 10m → 20m → 30m → 60m。backoff 到期只允许 probation probe；连续 3 次成功、每次至少 30s 后恢复 HEALTHY。probation 中再次 429 则升一级，不回到 5m。
4. 原有全局 recovery slow-start 拆成 family probation；request slot 仍保持全局最小间隔，避免 family 解耦后形成并发 burst。
5. Guardian 本地 REST block 必须改为 family-aware，禁止 catalog 429 把 body 一并 block。若 Chrome Network.setBlockedURLs 无法安全表达分级语义，则只 block 具体 family pattern；不得用宽泛 conversation REST pattern。
6. Actor/Bridge 只读取 actor（以及未来明确的 global circuit breaker）状态；catalog/body 429 不再阻止正式 turn 提交。Watchdog/body sync 只服从 body family，catalog reconcile/gap repair 只服从 catalog family。
7. 新增轻量 request-event ledger（JSONL/轮转或等价低开销形式），逐次记录 timestamp/source/targetId/family/routeClass/status/retryAfter/latency/backoffStage，不保存正文、Cookie、Authorization、signed URL/token。native 与 active replay 继续去重归因。
8. 兼容旧 daemon state：若重启时只存在旧 cooldownUntil，按保守 legacy global 恢复一次；新版本写出 family state 后不再把 catalog family 映射回全局 60min。
9. 增加 helper/状态机单测：catalog 5/10/20/30/60 阶梯、probation 三次成功、probation 再 429 升级、Retry-After family 隔离、legacy state 迁移、Actor 不受 catalog cooldown、body 不受 catalog cooldown、native catalog 与 active catalog 共用同一 family。
10. 跑 node --check、TypeScript、daemon 定向测试、全量 npm run check；更新 PROGRESS.md。生产重载必须继承当前 cooldown/family state，不能靠重启绕过限流。

# Watchdog 分类来源解耦与诊断通知补全（2026-10-14）

目标：恢复既定语义——Watchdog 只负责“到点后强制诊断”，不能用计时器从 catalog 还是 DevSpace 启动来决定 lifecycle。最终分类必须来自本轮可观测状态，并继续保留 lifecycle / terminal / tail / head / incident_evidence 的正交模型。

- [done] 将 watchdog lifecycle 选择改为：超时诊断时若同一 conversation 仍有 catalog `async_status=3/5` active 证据，且 body 无 final/明确终止，则归 `active-zombie`；否则仅保留 `watchdog-timeout`。DevSpace-start 与 catalog-start 走同一规则。
- [done] 对已经先落成 `watchdog-timeout`、随后 catalog 仍持续 active 的同 turn open incident 做幂等 promotion 到 `active-zombie`，不新建第二条 incident，不抹掉 `canonical-tail-gap` 等 evidence；同时阻止后续 historical-turn 补账把已有强 lifecycle 再降级成 generic `abnormal-terminal`。
- [done] Watchdog 第二条 Bark 诊断通知显式展示 lifecycle、terminal、tail、head 与 evidenceTypes；不再只给一段 summary，让用户能直接看到多维错误分型。
- [done] 用《B站 OpenCLI能力需求》作为生产回归样本：已证实事故 turn `119180a3…` 在 Watchdog 前后 catalog 均为 active，body 为 `terminal=none / tail=tool-result-returned / head=aligned`，且存在 `canonical-tail-gap`；持久化分类已定点校正为 `resolved active-zombie + canonical-tail-gap`。后续另一个新 turn 正常 final，不改变该旧事故的分类，只负责把它 resolve。
- [done] daemon/db/notification 回归与全量 `npm run check` 已通过（25 files / 222 tests + Chrome/Edge/Firefox/Userscript build）；Windows 计划任务已受控重载生产 daemon，当前 PID 16616、WSS=3、Guardian failures=0、Bridge=true、LifeOps pending=0、Bark/daemon lastError=null。

# 2026-10-11 Archive Reader 长尾阻塞修复 ExecPlan

状态：实现完成，待生产迁移验证。

现象：LifeOps `/v1/search` 人为 5s HTTP timeout 再次触发。相同 query 直接请求本机 Bridge 墙钟 26.45s，但 Bridge 内部 search timing 仅 1.03s，证明大部分时间发生在 HTTP handler 得到主线程调度之前，而非搜索 SQL。

根因：
1. Archive Bridge 与 daemon 同 Node 主线程。
2. `mergeLiveMessagesPage()` 每页都调用 `rebuildConversationDerivedInsideTransaction()`；旧实现对整个 Conversation 重建 ordinal、三套 FTS、resources、markdown。
3. 对约 3500 条消息的 synthetic Conversation，只更新 24 条时旧路径约 48~54s；进一步分阶段计时发现全局 ordinal 窗口 UPDATE 单独耗时约 55s。

修复：
1. live merge 派生数据只刷新 touched messages；FTS rowid 与 canonical `messages.row_id` 对齐，按 rowid 主键删除/重插。
2. live 热路径不再重写整聊天 ordinal；Reader `getMessages()` 读取时按 `create_time,row_id` 动态生成稳定 ordinal 游标。
3. resources 按 message 时间动态排序；markdown 移出采集热路径，显式读取 live Conversation 时由 canonical messages 按需生成。
4. CLI 增加 `reindex --search-only`，生产一次性重建搜索派生索引以完成旧 FTS rowid 对齐。

验收门槛：全量测试/typecheck 通过；3500 条 Conversation 更新 24 条 synthetic merge <1s；生产并发同步期间 LifeOps 搜索不再触发 5s timeout。
# 2026-10-11 Archive daemon 常驻启动回填修复 ExecPlan

现象：生产 Archive daemon 在 15:30 左右无优雅 shutdown 记录直接消失；Windows 计划任务未接管。恢复计划任务后，新 daemon 又在 `DevSpace historical metadata seed complete` 后持续高 CPU / 约 1.1 GiB 工作集，迟迟未进入 wake listener 与 WSS 主循环。

根因：启动逻辑把“本次历史 seed 新建了任意 metadata 行”误当成“首次历史迁移”，于是只要 daemon 停机期间出现一个新 metadata，重启就会执行全量 `backfillStoredDevSpaceBindings()`。这与代码注释“全量 backfill 只在首次迁移执行一次”相违背，也会拖延常驻监控恢复。

修复计划：
1. 在 historical seed 前判断 Archive 是否已经存在任何 DevSpace binding 记录。
2. 只有“启动前 binding 表为空 且本次 seed 确实创建了历史行”时执行全量历史 backfill；普通重启只保留现有的近期窄窗口 backfill。
3. 增加纯函数门槛及回归测试，并同步声明文件。
4. 跑定向测试、TypeScript/全量检查；随后只通过 Windows 计划任务启动生产 daemon。
5. 验证 task owner、PID/state 新鲜度、Bridge 47832、DevSpace wake 47831、WSS、Guardian、Bark 配置与 lastError。

# 2026-10-11 CDP target 语义修正与残片课堂策略

用户校正：普通 ChatGPT tab 的 passive observer timeout 与 Guardian health 必须严格分层。普通 target 可能只是 Chrome 正常冻结/休眠，不能把它当 Guardian/CDP 总线故障，也不应指数退避到一小时；保持固定低频探测，醒来后应能及时重新 attach。Guardian 自身继续使用 target-level health probe，失败时 browser-level ping 只用于诊断“target 还是 browser”，不替代 health probe。

同时修正历史课堂策略：永久源缺失（明确资源不存在/404/410）不属于可恢复失败。若同一课堂已有至少一个成功分段，应允许按现有成功分段生成“残片 Notes”，并在输入元数据中明确缺失分段；只有下载中断、ASR 失败、临时网络错误等可恢复故障继续阻塞整堂 Notes。

Actor 提交不确定性不应简单永久 fail：正式 POST 后结果未知时，Archive 应优先 reconcile/探测是否已经产生对应 turn；只有明确证明未提交才允许重发。当前先保留 fail-closed 防双发边界，不把“未知”误当普通 timeout 自动重发；后续本轮评估是否能用现有 canonical/actor 证据实现确认态。

# 2026-10-11 Bark 高频通知文案精简 ExecPlan

目标：不改变 Bark 分组、触发频率、阈值、去重 key 或生命周期判定，只让高频通知适合手机锁屏快速扫读；关键信息优先放标题，正文只留一两行必要细节。

1. 统一标题中的聊天名压缩规则：去掉换行/多余空白，最多显示 18 个 Unicode 字符，超长后加 `…`；完整聊天名仅在被截断时补到正文。
2. 正常完成改为 `Turn 正常完成 · <聊天名>`；无可用聊天名时只显示 `Turn 正常完成`。正文仅保留 `已确认 Final`、可选图片数量，以及被截断时的完整聊天名。
3. 工具静默改为 `工具静默 X 分钟 · <聊天名>`；删除重复解释套话。未绑定且只有 metadata 时不把 metadata 塞进标题，正文仅保留 `未绑定 · meta/XXXXXXXX`。
4. Watchdog 到点改为 `Watchdog 超时 · <聊天名>`；正文只保留完整聊天名（若标题截断）、运行分钟数和本轮起点。未绑定且无可读 title 时标题使用 `Watchdog 超时 · 未绑定会话`，metadata 放正文。
5. 本轮暂不改漂移、429 cooldown、Watchdog 诊断、5 分钟诊断、checkpoint/conclusion；补短标题/长标题/metadata 回归后受控重载 daemon。
# 2026-10-11 Bark 通知统一分组 ExecPlan

目标：保持现有 Bark 通知频率和触发条件不变，只统一通知分组，让 iPhone/Bark 历史能按“聊天延迟、聊天超时、正常完成、真正事故、Archive 自身告警”等语义快速归类。

1. 固定七类 group：`Chat-Latency`、`Chat-Timeout`、`Chat-Done`、`Incident`、`Archive-Warning`、`LiveOps`、`Infra`；本仓库只负责当前实际拥有的前五类，LifeOps/Infra 保留给对应发送端。
2. DevSpace 1/3/5 分钟工具静默和 5 分钟诊断归 `Chat-Latency`；DevSpace checkpoint/conclusion 归 `Chat-Done`。
3. Watchdog 到点、cooldown-deferred、未绑定 Watchdog 归 `Chat-Timeout`；Watchdog 最终诊断按结果动态归 `Chat-Done`（final）或 `Incident`（异常）。
4. 正常 turn final、ImageGen 完成归 `Chat-Done`；conversation lifecycle 异常归 `Incident`。
5. DOM Drift、HTTP protocol drift、429 cooldown 统一归 `Archive-Warning`，明确与 conversation 自身异常隔离。
6. 不改 Bark token、声音、优先级、通知频率、持久去重 key 或生命周期判定，只补 group；配置里的默认 group 仅作为未来未知通知的 fallback。
7. 补 payload/build request 单测，跑 daemon 定向测试、notifier 测试、TypeScript 和全量测试；部署时只重载 Archive daemon，随后用本地 payload 验证所有 lane 都带正确 group。

# 2026-10-11 Conversation-first 搜索重构 ExecPlan

状态：**已完成并部署到生产。**

目标：把 Archive 搜索的第一返回单位从全局 message hit 改为 Conversation，避免高频词被少数长聊天占满 message limit；同时修复两字中文错误落入无界 LIKE 全表扫描造成的 12 秒级超时。

1. `ChatArchiveDb` 新增 Conversation-first 搜索：先按 Conversation 聚合命中并排序/limit，再为入选 Conversation 返回有限 snippets；结果带 `hitCount / bestRank / capturedAt`。
2. 模型可选择 `relevance / recent / frequency` 排序，以及 `conversationLimit / snippetsPerConversation`；全局 message hit 不再决定 Conversation 召回。
3. 原 message-level 搜索保留为独立 `searchMessages`/CLI `search-messages` 兼容与展开入口。
4. 中文 3+ 字继续 trigram；1~2 字 CJK 走专用短词 FTS（去重 unigram+bigram），禁止无界 `%LIKE%` 扫全库。
5. Archive Bridge `/v1/search` 一次返回 Conversation 结果并本地补 `lifecycleState`；不要求调用方再拉“最近 200 个 Conversation”。
6. 增加搜索 timing（DB search / lifecycle enrich / bridge total），并用 `LifeOps`、两字中文、英文及高频单聊天数据做召回与性能回归。
7. CLI 默认 `search` 切换为 Conversation-first；补充 `--sort`、`--snippets-per-conversation`，保留 `search-messages`。

验收：25/25 test files、215/215 tests 通过；最终 `tsc --noEmit` 通过。生产 Bridge 热态实测 `LifeOps` p50≈117.7ms、`搜索` p50≈344.1ms、单字 `肾` p50≈197.8ms；daemon WSS=3、gap=null、Bridge/LifeOps sync/Guardian 均健康。
# 2026-10-11 CDP 稳定性与提交不确定性加固

背景：历史 Notes 已完成 21/21 成功课堂回填，但日志显示两类 CDP timeout：一类是普通/睡眠 ChatGPT target 的 `Network.enable` 长期重试噪声；另一类是 Guardian 偶发 `Runtime.evaluate` / `Network.getResponseBody` timeout。当前 Guardian 现场基准正常（20 次 trivial Runtime.evaluate 全成功，P95 约 1ms），说明不是 127.0.0.1:9222 整体失效，而是 target/renderer 与同 session 诊断流量需要更细粒度隔离。

本轮目标：
1. 被动 observer 对连续 attach timeout 的 target 使用递增隔离窗口，避免同一个坏 target 每 5 分钟永久重试。
2. Guardian health probe timeout 时增加浏览器级 CDP ping，区分 target/renderer 故障与整个 Chrome CDP 故障；保留连续失败自动重建 Guardian，但日志明确故障层级。
3. Guardian 协议指纹 `Network.getResponseBody` 属于诊断流量，增加小并发上限；过载时直接跳过指纹，不与业务同步/health probe 抢同一 CDP session。
4. Actor 已观察到正式 `/backend-api/f/conversation` POST、但没有拿到 HTTP response 时，submission queue 禁止把它当普通 timeout 自动重发；改为 fail-closed 的“提交结果未知”终止错误，避免潜在重复 POST。当前已 accepted 的记录不受影响。
5. 回归：daemon/bridge/actor 定向测试 + typecheck + 全量 check；生产仅重启 Archive daemon，不重启日常 Chrome。

# 2026-10-11 Guardian REST block 状态分裂修复

现象：ClassFlow 历史 Notes submission 已全部由 Archive 接受，但 03:45 后大量 conversation 长期停在 generating。日志显示 WSS/Actor 已完成，canonical 同步却持续报 No fetch result for /backend-api/conversations/<cid>。原始 CDP 复现得到 TypeError: Failed to fetch。

根因：429 cooldown 会调用 Network.setBlockedURLs 临时阻断 Guardian conversation REST。若 CDP 调用超时，Chrome 可能已经执行 block，但本地布尔值仍保持 false；cooldown 到期时 setGuardianConversationRestBlocked(false) 又会因为缓存值已经 false 直接 return，导致真实 block 永远未清理。daemon/Guardian 重启复用同一 target 时也可能继承未知 block 状态。

修复：
1. Guardian block 状态改为“缓存状态 + uncertain”语义；CDP timeout 后标记 uncertain。
2. unblock（enabled=false）永远真实下发 Network.setBlockedURLs([])，不允许仅凭缓存 false 跳过。
3. Guardian attach/rebuild 后把 block 状态视为 unknown，并按当前 cooldown 真实同步一次目标状态。
4. cooldown 到期先成功解除 block，再清空 cooldownRecoveryPending/cooldownUntil；解除失败时保留 recovery pending，并禁止 active REST 继续执行。
5. 增加 helper 回归测试，覆盖 cached false 但 uncertain / disable 仍必须下发。
6. 部署前先对当前 Guardian 显式清空 blocked URLs，并用已卡住 CID 验证 conversation body 恢复。

# 2026-10-11 Archive 429 请求合并与 Retry-After 收口 ExecPlan

生产实证：WSS complete 后同一 conversation 的 body-latest 在 52ms 内先出现页面原生 GET 429、随后 daemon active GET 429；服务端 Retry-After=16s，但现有 tripCooldown 固定转换为 60min。目标是不牺牲 fail-closed 的前提下消除重复主动 body，并让明确的服务端冷却时间成为主要真相源。

1. 追踪 WSS complete → readyNotBefore/nativeBodyGrace → passive cache → syncConversation/fetchChecked 路径，确认原生 body 已在飞时 daemon 为什么仍主动 GET。
2. 为 conversation REST 增加 in-flight/coalescing 观测或门控：页面自然请求已经发出时，active sync 应等待其完成/短 grace；成功则复用 passive body，429 则直接服从同一 cooldown，不再补第二次 GET。
3. tripCooldown 解析 Retry-After（delta-seconds 与 HTTP-date）。有明确值时采用服务端 deadline + 小安全缓冲，并设置合理下限；无值/不可解析才使用保守本地 cooldown。重复 429 只向后延长，不把短 Retry-After 每次重置成 60min。
4. 增加 Retry-After、重复 429 延长、native in-flight coalescing 的单测，跑 Archive 全量 check。
5. 部署 daemon；由于当前 04:35 cooldown 是旧 60min 策略产物且原始 Retry-After=16s 已过期，部署时显式迁移该旧 runtime cooldown，随后验证 retry_waiting title 自动恢复、ClassFlow 不感知 429。
# 2026-10-11 Archive Actor 提交服务职责收口 ExecPlan

目标：把 ClassFlow 等上层调用方从 ChatGPT 网页发送细节中彻底解耦。Archive Bridge 对外只暴露幂等的“提交任务”，内部统一负责 Actor lease、最小提交间隔、Guardian 生命周期、429 cooldown、提交结果不确定与重启恢复；上层只观察 queued / accepted / failed。

1. POST /v1/turns 新增可选 idempotencyKey。带键请求进入 Archive 持久化提交队列；相同键+相同请求重复调用只返回同一提交记录，不重复发送；相同键+不同请求返回冲突。
2. 提交队列单消费者执行 sendActorPrompt()。429/cooldown/暂时性 Guardian 或 CDP 不可用保持 queued/retry_waiting，按明确 cooldown 截止或有界退避自动继续；只有确定不可恢复的输入/协议错误才进入 failed。
3. Actor 正式 /f/conversation / /f/steer_turn 返回 429 时立即回调 daemon tripCooldown()，不再依赖随后 catalog/body 碰巧再遇到 429 才建立全局熔断。
4. Guardian target 的 source of truth 统一为 daemon state。actor status 在 source=guardian 时实时读取 daemon guardian，不再把旧 archive-actor-state.json.targetId 当权威值。
5. 保留无 idempotencyKey 的旧 /v1/turns 同步兼容路径，避免现有 CLI/其它调用方瞬间破坏；ClassFlow 切换完成后再评估是否彻底移除。
6. 增加队列重启恢复、幂等去重、429 retry、冲突、Guardian stale-status 与现有 Bridge 行为的回归测试；通过 TypeScript、Vitest 与 production build 后再重启 daemon。
# 2026-10-10 5 分钟诊断通知 / Canonical Tail Gap 多维 Incident ExecPlan

目标：补齐 DevSpace 5 分钟静默 probe 的“扫完必须通知”闭环，并把 canonical Body 明显落后于 DevSpace audit/recovery overlay 的现象从 Watchdog/Active Zombie 中拆成一个可并存的独立证据维度。

1. **5 分钟 bound probe 必须有诊断结果通知**：阈值触发时登记 pending diagnosis；若当前已有 WSS complete / Watchdog 等更强 sync，则复用它的 body 结果，不额外请求；否则沿用 `devspace-idle:bound-probe` 抓一次 latest body。任意成功 sync 完成后都消费 pending diagnosis 并发送 Bark。
2. **通知重点改为 Body vs DevSpace Recovery**：正文展示 canonical terminal/tail、当前 turn canonical 最后节点时间；同 conversation 在该 canonical tail 之后的 DevSpace audit 数、普通 tool 数、checkpoint 数、最后 audit 时间以及 tail gap 时长。明确告诉用户 Body 是否已追平、是否存在 provisional recovery 节点需要依赖 Recover overlay。
3. **新增正交异常标签 `canonical-tail-gap`**：定义为当前 turn `terminalEvidence != final`，且 canonical 最后节点之后仍存在真实 DevSpace tool audit，gap >= 5s。它描述“正文完整性/尾部缺失”，不推断根因，更不直接命名为“审查异常”。
4. **不合并 Active Zombie**：`active-zombie` 继续表示 conversation list/catalog 长时间仍 active；`canonical-tail-gap` 表示 body 尾部落后。二者是独立维度，可同时存在。`watchdog-timeout` 视为发现/触发维度，保留兼容字段但不再把它当唯一错误类型。
5. **Incident 多维证据表**：保留现有 `incident_kind/lifecycle_class` 兼容行为，新建 `incident_evidence(incident_id, evidence_type, evidence_json)` 保存正交标签；`canonical-tail-gap` 的 JSON 包含 gapMs、audit/tool/checkpoint counts、canonical/recovery tail time。5 分钟 probe 若首次发现 tail-gap，可为当前 turn 建一个 generic `abnormal-terminal` incident 壳；后续 Watchdog/Active Zombie/complete 信号更新 lifecycle 时不抹掉 evidence。
6. **历史 backfill**：仅按“同 turn canonical tail → 下一 user turn 之前”的时间窗回填，避免同 conversation 后续 turn 污染。当前生产库初步统计：215 条 incident 中 14 条满足保守 tail-gap；14 条中 0 条 active-zombie。9 条 active-zombie 中 7 条缺 recovery audit 历史覆盖，剩余 2 条有 audit 但均不满足 tail-gap，因此现有数据不支持把二者视为同一种异常。
7. **unbound 5 分钟**：仍先跑 deferred catalog gap-repair；扫描结束若仍无可靠 binding，发送“扫描完成但无法定位 canonical conversation”的诊断通知，列出该 metadata 的 recovery audit/checkpoint 数；若随后建立 binding，则按 bound 路径做 body 对照。
8. **回归与生产验证**：覆盖 pending diagnosis 不重复请求、强 trigger 复用、tail-gap 判定、final 不误报、incident 多维字段持久化、历史 backfill 幂等、unbound scan-result 通知，以及既有 Watchdog/Active Zombie/complete-no-final 行为。

状态：已完成并部署。5 分钟诊断结果通知、bound/unbound 两路结果收口、`incident_evidence`、`canonical-tail-gap`、CLI/Bridge `evidenceTypes` 暴露、历史 backfill 均已实现。生产库回填 14 条 tail-gap：abnormal-terminal=9、watchdog-timeout=3、complete-no-final=2、active-zombie overlap=0。主要改造全量回归为 25 files / 201 tests + TypeScript + 四套 build 全绿；生产 daemon 恢复 WSS=3、Bridge/LifeOps/DevSpace listener 在线。

# 2026-10-10 Conversation Length-Cap / 吞回复异常研究

当前只做证据研究，不自动分类。已确认两个 UI Ground Truth：`迁移刷机方案` 与 `探讨 Sidebery 重构方案` 曾出现“你已达到此对话的长度上限，你可以开始新聊天以继续对话”，且对应 UI-only assistant error card 的 message id 不存在于 canonical body。用户现场进一步说明：该状态可能只在**原发送设备、原 SSE/render 未刷新**时短暂可见；同设备刷新、另一设备、单独 body 请求都会丢失，因此“事后 Guardian 扫 DOM”不是可靠捕获方案。

现有描述性统计：两个直接阳性 messageCount≈4895/4189，均处于全库约 99.9 百分位；但累计字符量差异很大（约 90 万 vs 364 万），说明固定字符阈值不足。`恢复并继续classflow` 当前 5317 messages（全库最高）、32 turns≈99.97 百分位、272 万字符≈99.62 百分位，且尾部出现连续 user-only Recover / 0 Final，属于高风险候选，但没有直接 length-cap 证据，禁止回填确定标签。

下一步研究方向：优先分析原发送 `/f/conversation` SSE 在“曾生成内容但 canonical body 后续回缩/完全缺失”时是否留有稳定 control/error 字段；若大部分非 Actor 会话拿不到原始 SSE，则建立后验风险模型，候选特征包括 message/node count、turn count、连续无 Final 次数、连续 Recover/继续文本、canonical-tail-gap 重复次数、conversation 尾部是否长期只有 user/context。该模型只能输出 `length-cap-suspected` 风险分，不自动升级为确定 incident；只有未来拿到直接 SSE/UI/第一方错误信号时才记录 `conversation-length-cap` evidence。

# 2026-10-10 DevSpace 5 分钟静默提前 Gap Repair ExecPlan

目标：复用 Archive 现有 1/3/5 分钟 DevSpace idle lane，在 5 分钟阈值把“软提醒”升级为一次低成本主动核验，从而比 45 分钟 Watchdog 更早识别异常结束；DevSpace 发信端和 tool_audit 协议保持不变。

1. **已绑定 metadata**：5 分钟阈值穿越时直接把对应 canonical conversation 放入现有 body sync 队列，只抓一次 latest body；若 body 已 final / explicit interrupted，则沿用现有 terminal/incident 分析并关闭该 generation 的 active/watchdog；若仍无 terminal，则只保留事实，不把静默本身判成异常。
2. **未绑定 metadata**：5 分钟阈值穿越时复用现有 deferred catalog gap-repair。由 conversation list 找出新增/变化且本地尚未追平的 conversation，再按既有 body exact tool+args matching 尝试建立 metadata→conversation binding；不凭标题/时间窗猜 CID。
3. **请求预算不扩散**：5 分钟 probe 只在 idle generation 第一次跨过 300s 时触发；bound 只排一条 body，unbound 只合并进已有去抖 gap-repair 队列。429 cooldown、主动请求串行门、passive cache 与 gap-repair min interval 全部继续生效。
4. **语义隔离**：1/3/5 分钟 Bark 仍是 DevSpace Bug 软提醒；5 分钟 probe 不是 confirmed complete 证据，因此只允许 body 中显式 final/interrupted/client_stopped 等事实改变终态，不能把 reasoning/tool/in_progress 尾巴升级成 complete-no-final。
5. **回归**：覆盖 5 分钟阈值识别、bound probe 可进入 terminal classifier 但不属于 confirmed-terminal trigger、1/3 分钟不触发 probe，以及既有 Watchdog/notification 行为不回归。

状态：已完成并部署 production。DevSpace 端未改协议；Archive 5 分钟阈值现在按 binding 分流为 `bound-body` / `unbound-catalog`，且不会覆盖已经排队的 WSS complete / Watchdog 等更强 trigger。`npm run check` 全绿：TypeScript、25 files / 196 tests、Chrome/Edge/Firefox/Userscript 四套 build 均通过。production daemon 已由 PID 53356 受控重载为 PID 29448，WSS 已恢复 3 sockets，Bridge / LifeOps / DevSpace UDP listener 均在线。重启期间出现的 `Inspected target navigated or closed` / CDP timeout 属于 startup 页面导航抖动，与本功能无关；等待下一次自然 5 分钟 idle canary，不人为伪造 audit。

# 2026-10-10 ClassFlow Notes Bridge / Actor 全局串行门 ExecPlan

目标：把已经验证过的 Guardian Actor 正式开放给 ClassFlow Phase 3，同时保持账户级主动请求预算可控、Project 导航不破坏 LiveTurn，并给 N1 一个可恢复的异步黑盒接口。

1. **Project 导航保持第一方 SPA**：`--project <name>` 只点击侧栏“在 <Project> 中开启新聊天”按钮并等待同 document route/composer 变化；不为 Project 创建调用 `Page.navigate()`。既有 2026-10-07 A-active→B-new 真机 canary 已证明同 Guardian SPA 切 conversation 不会中断 A 原始 SSE，也不会重建账户常驻 WSS。
2. **统一全局发送节拍**：保留现有跨进程 Actor lease，新增共享 `lastSubmittedAt`；任何入口（CLI send、batch、Bridge、ClassFlow）在拿到 lease 后都必须保证距离上一条正式 `/f/conversation` 提交至少 5000ms。`actor batch --min-gap-ms` 仍可提供额外更保守间隔，但不再是唯一限速来源。429 继续服从 daemon `cooldownUntil`，严禁换 target 绕过。
3. **Bridge 暴露已有 Project 参数**：`POST /v1/turns` 接受 `projectName`，daemon 原样传给 `sendActorPrompt()`；返回 CID 后 N1 通过现有 `GET /v1/conversations/:cid` 与 `/messages` 查询 canonical 生命周期和最终正文，不新增 ChatGPT polling。
4. **ClassFlow 异步恢复语义**：Windows/Bridge 在提交前不可达时由 N1 保持 pending 并自动稍后再试；一旦 CID 已返回，N1 永久 checkpoint CID，后续只等 Archive canonical body。incident/abnormal terminal 直接失败并等待人工 retry，不自动创建第二个 conversation。
5. **resume 作为正式恢复路径**：`resume_conversation_token` 可以持久化在 Archive 本地 state / trace / SQLite，用于同一 turn 的 SSE 重建；它不是账户级长期认证凭据。初始 SSE 异常断开且 turn 尚未终止时，优先用保存的 resume capability 自动恢复，并采用有上限的指数退避，避免网络异常时形成请求风暴。持续失败后停止主动 resume，退到 canonical body/final 保底。Bridge/前端不对外暴露 raw token。
6. **Guardian 发送后回 neutral new-chat**：`new/continue` 只有在正式 `/f/conversation` 2xx、CID 已绑定且已经观察到首个 SSE data 后，才允许通过第一方 SPA“新聊天”回到 `/`；`steer` 已由发送前 live-context 门控，可在 2xx 后直接 SPA 归位。归位失败不得把已成功发送改判失败，也绝不能用 `Page.navigate()`/reload 作为 cleanup fallback。这样 Guardian 的 idle route 与正在运行的 LiveTurn 解耦，下一笔 Actor 操作再按目标上下文重新 SPA 导航。

# 2026-10-09 ClassFlow Phase 3：已有 Project 新聊天最小闭环

ClassFlow 当前不等待完整 Project CRUD，只需要一个非常窄的生产能力：把“一节完整课程”的 ASR 文本发送到既有 ChatGPT Project `课堂录音→笔记`，一节课一个全新 conversation，并在 Archive canonical body 落盘后把 assistant final 返回给调用方。

已实现：

1. `actor send --project <已有项目名> --mode new`：只使用 ChatGPT 一方侧栏 Project action（真机 aria-label：`在 课堂录音→笔记 中开启新聊天`）进入 Project composer，再复用现有正式 `/f/conversation` 发送链；不实现 Project create/rename/move/delete。
2. Project 分组折叠时会先展开“一方项目分组”；Project 行尾 action 是 hover 图标按钮，保留尺寸/祖先可见性/pointer 门控，但不再用对后台 Guardian 不可靠的 `elementFromPoint` 中心点判定。
3. Project conversation URL 的 canonical UUID 解析兼容普通 `/c/<uuid>` 与 `/g/g-p-.../c/<uuid>` 两种形态。
4. `actor send --wait-final --final-timeout-ms N`：发送后仅轮询**本地 Archive SQLite**，等待 daemon 通过现有 SSE/WSS/body-sync 链写入本次提交之后的 `terminal_state=final`，再返回 assistant final 正文。此等待不会向 ChatGPT 增加 REST/body/catalog 轮询。
5. `actor batch` job 也可携带 `project` 字段；ClassFlow 初版仍优先使用单条 `send --wait-final`，便于一课一 manifest checkpoint。

当前生产 E2E 阻塞项不是上述功能本身，而是 Windows ChatGPT 网络路径：2026-10-09 14:08 起 Archive Guardian 与独立 browser-harness 临时 tab 均无法新导航 `https://chatgpt.com`，Chrome 返回 `net::ERR_CONNECTION_CLOSED`；同一时段 Guardian 降为 `chrome-error://chromewebdata/`、WSS=0。Mihomo `ChatGPT` 规则仍命中 `🚀 节点选择`，原选择器已恢复为 `替补-美东1`；ATT 家宽临时 A/B 后真实 TLS 也同样失败，已恢复原运行态。网络恢复后再做一次真正 `Project -> CID -> LiveTurn/WSS -> canonical final` smoke；此前两次 Project smoke 都在导航门前失败，没有发出 ChatGPT conversation POST。

## 2026-10-10 DevSpace provisional 虚拟 Conversation / Checkpoint 工具 ExecPlan

目标：继续保持 Archive canonical `conversations/messages` 为第一方事实源，同时把 DevSpace `tool_audit` 的先发优势扩展到**尚未可靠绑定 CID 的 metadata**；并把容易被模型误用成“命令注释”的 `conclusion` 字段迁移为独立阶段 checkpoint 工具。

1. 未绑定 metadata 也立即镜像 recovery audit，不再等待 canonical binding。内部使用稳定 synthetic id `devspace-meta/<hash>` 作为 provisional conversation key；display title 优先 `init.title`，否则回退 `meta/XXXXXXXX`。
2. synthetic conversation 只存在于 recovery/Bridge 展示层，不写 canonical `conversations/messages`，不参与 Watchdog terminal/incident、mapping、FTS 或 canonical source 统计。
3. Bridge `/v1/conversations` 追加 active provisional conversations；`/v1/conversations/:id/messages` 可直接读取其 provisional tool/checkpoint 尾部。这样即使 ChatGPT Body 尚未到、429/cooldown、CDP/REST 不可用或服务器最终漏节点，Archive Reader 仍可提前看到本地事实。
4. metadata 后续获得高置信 binding 时，把该 metadata 的 active recovery audits 从 synthetic id 原位迁移到 canonical CID；synthetic conversation 自动从 Bridge 列表消失，不复制、不重放、不改 canonical messages。
5. canonical body 到达后仍按现有 `tool + canonical args + 时间窗` supersede 对应 provisional tool audit；未被 body 覆盖的异常尾部继续保留。Checkpoint 则只在能找到语义对应的 canonical assistant commentary 时再覆盖；无法可靠对应时宁可保留 provisional，不做文本模糊猜测。
6. DevSpace 新增独立 `checkpoint(summary, next?)` 工具：只记录“阶段完成 / 新事实确认 / 重要决策 / 阻塞变化 / 值得 Recover 保存的中间结论”。`next` 只允许宏观下一阶段，可省略。明确禁止记录下一条命令、git status、一次 read/exec 是否完成之类微观工具注释。
7. 新 schema 不再在 `read/exec_command/write_stdin` 暴露 `conclusion`；旧 Host 缓存继续传多余字段时保持兼容、不让工具调用报错。Archive 同时兼容历史 `args.conclusion` 与新 `checkpoint` audit，Bark/overlay 均优先识别 checkpoint。
8. 所有更改保持旁路：不新增 ChatGPT 网络请求、不改变 active/watchdog/cooldown 状态机。回归必须覆盖 unbound->virtual、title fallback、late binding migrate、canonical supersede、orphan tail 保留、checkpoint 单节点展示、旧 conclusion 兼容，以及 Bridge 分页/列表行为。

状态：已完成并部署 production。canonical Archive 主表与 Watchdog/incident 主链保持不动；定向 82/82、全量 25 files / 189 tests 与四套 build 全通过。production daemon PID 22584，WSS=3、Bridge/LifeOps/DevSpace listener 正常、`lastError=null`；`display_title` migration 已生效。当前暂无部署后新产生的未绑定 metadata，因此 synthetic recovery rows 仍为 0；不为 canary 伪造 audit，等待下一条真实未绑定 metadata 自然验证。

## 2026-10-09 DevSpace Recover provisional body overlay ExecPlan

目标：当 ChatGPT Conversation Body 因 cooldown、429、CDP/REST 不可用或异常终止而暂时/永久缺失时，用 DevSpace 已落盘的 tool audit 生成**有来源标记的 provisional 节点**，让 Archive/Bridge 仍能展示真实工具轨迹；一旦 canonical body 后续出现相同 tool call，再自动以第一方节点覆盖/淘汰 provisional。MCP schema 本轮不改。

1. 新增 Archive 本地 `devspace_recovery_nodes`（或等价）持久表，保存 metadata/audit/conversation、tool call/result、可选 conclusion、时间、状态与 superseded 信息；绝不把合成节点伪装成 canonical `messages` 原始行。
2. DevSpace bridge 扩展只读 recovery audit：读取 args/result/error/start/finish；已有 conversation binding 时，daemon 在 audit start/finish 后机会式刷新该 audit 的 provisional 节点。绑定晚到时补当前 turn/局部窗口，不做全库扫描。
3. 一个 audit 最多生成两类可见节点：tool-call/result 节点；以及非空 conclusion 的 assistant checkpoint。Conclusion 明确标为 `provisional/recovery-source=devspace-conclusion`，不宣称是模型最终答复。
4. canonical body 每次 merge 后，用现有 DevSpace `tool + canonical args + 时间容差` 语义匹配 recovery tool-call；匹配到的 provisional tool/result 标记 superseded。与该 audit 绑定的 conclusion 也一并 supersede，避免真实 body 到达后重复显示。
5. `ArchiveDb.getMessages()` / Bridge messages API 叠加仍 active 的 provisional rows，并附 `provisional=true`、`recoverySource`、`auditId`、`superseded=false` 等字段。canonical message 始终优先；数据库原始 `messages`、mapping、terminal/incident 判定不读取 provisional，因此不会影响 Watchdog/终态分类。
6. 对 Conversation Body 拉取失败/处于 cooldown 的聊天，不需要再额外打 ChatGPT 网络请求：只要 DevSpace audit 已经绑定 conversation，overlay 会本地持续增长。异常终止且服务器永远没有对应节点时，provisional 继续保留作为 forensic recovery。
7. 回归覆盖：start→call、finish→result、conclusion checkpoint、绑定晚到回填、canonical exact match supersede、无 match 永久保留、Bridge 输出 provenance、provisional 不影响 terminal/incident。

状态：主体已完成并部署 production。现有 9 条 Conclusion 中约 3 条是真正阶段 checkpoint、其余多为下一步 action label；因此 Conclusion 只作为“可选 provisional assistant checkpoint”，不当作已验证 canonical 事实，也未修改 MCP schema/强制每次工具填写。全量 25 files / 185 tests + 四套 build 通过；PID 65276 真机已自然写入 recovery overlay。canonical supersede 的代码/单测已完成，线上自然证据等待后续 first-party body 自然到达，不为 canary 主动增加 ChatGPT 请求。

## 2026-10-09 DevSpace Conclusion 即时 Bark ExecPlan

目标：把 DevSpace 工具参数中的非空 `conclusion` 作为“阶段性结论”即时推送到手机，帮助用户在长工具链中及时掌握模型当前进展；该通知只做旁路可观测性，不改变 Watchdog / idle / turn 终态状态机。

1. 复用现有 DevSpace audit 事件流：每条新 `tool_audit` 首次被 Archive 观察到时解析 `args_json.conclusion`；为空则完全不做额外工作，非空才进入通知分支。
2. 通知命名优先级固定为：已绑定 canonical conversation -> Archive conversation title；未绑定但 DevSpace metadata context 有 `init.title` -> title；两者都没有 -> 仅显示“未命名、尚未绑定的 DevSpace 会话”，不再把 metadata ID 暴露给手机通知。
3. Bark 使用独立 `DevSpace Conclusion` group；正文包含工具名 + conclusion 原文，已绑定 conversation 时带聊天 URL；notification key 用 audit id 做持久去重，避免 UDP start/finish、60s catch-up 或 daemon 重启重复发送。
4. 不在 DevSpace 进程增加网络请求，不改 tool hot path；通知继续由 Archive detached Bark 分支负责。
5. 回归覆盖：有 conclusion 立即排队；无 conclusion 不通知；绑定 / title fallback / 无名 fallback 三种文案；同 audit id 持久去重。

状态：已确认生产数据中 Conclusion 上线后仅 9 次真实使用、涉及 3 个 metadata；正在实现 Archive 即时 Bark 与回归测试。

## 2026-10-08 DevSpace 工具静默独立 Bug 通知

目标：复用现有 Bark 传输和 DevSpace UDP 门铃，但与 45min Watchdog / incident taxonomy 完全解耦，增加一个只描述“工具活动静默”的轻量提醒通道。

1. 扩展 DevSpace SQLite 只读桥：按 metadata 读取当前 running tool 数、最后 start/finish 时间和 DevSpace 保存的 `init.title`；SQLite 是事实源，UDP 仍只做唤醒。
2. 每次 DevSpace start/finish 门铃后重算该 metadata 的 idle generation。只在 `runningTools === 0` 时，从最后一次 `finished_at` 开始计时；1/3/5 分钟分别发送一次，任何新 start 都取消旧 generation 并重置。
3. 已有 canonical binding 时用 Archive conversation title；未绑定时用 DevSpace metadata title，避免依赖猜测 M→C。两者都没有时只显示 metadata 的短标识。
4. 通知文案只说“可能已经停止，也可能正在准备 Final、纯思考或使用其他工具”，绝不把 1/3/5 分钟当 turn complete 或 incident 证据。
5. Bark 复用同一设备配置，但允许单条通知覆盖 group 为 `DevSpace Bug`，实现通知中心独立分组；持久 notification key 以 metadata + idle generation + 阈值去重。
6. 合并必须以当前 production main 的 Watchdog latch/two-stage notification 为底座；本功能只追加独立 idle lane，不允许改变现有 Watchdog 状态机。

状态：代码与隔离分支测试已完成；正进行 current-main 集成回归，尚未重载生产 daemon。

## 2026-10-08 Watchdog 单向闸门 / 通知完整性 / 官方页面止血 ExecPlan

- [done] 临时止血：通过 CDP 将 16 个普通 `chatgpt.com` 页面置为 `frozen`，仅保留 Archive Guardian 与 daemon 自己的受控主动请求链；不关闭标签页、不杀 Chrome，后续可恢复 `active`。
- [done] 把 Watchdog 语义改成“每个 logical turn 一次性单向闸门”：45min 一旦到点，本 generation 永久进入 timed-out / awaiting-diagnosis；同 turn 后续 DevSpace/WSS/catalog progress 只能补证据，绝不能重新武装或延后 deadline。明确的新 turn identity / explicit turn-start 才允许创建新的 Watchdog generation。
- [done] 通知矩阵改为用户最新要求：正常 turn = 1 条最终通知；WSS complete + no-final/interrupted = 1 条异常通知；Watchdog turn = 到点立即 1 条 `Watchdog 已超时`，不受 cooldown 影响，body 诊断成功后再且只再发 1 条诊断结果，总计恰好 2 条。旧 `watchdog-deferred-cooldown` ledger 视为已经完成第一阶段，升级后不重复补轰炸。
- [done] 审计近期漏通知：确认同时存在“根本未生成 ledger”“ledger 已 Bark 200 但客户端未显著收到”“功能上线前/历史 backfill 被策略抑制”三类。`分析异常终止原因` 虽有 11 个 incident 但均为历史/补档类，notification ledger=0；`构建个人工作基准`、`CapsWriter性能分析`、`分析工具调用超时规律` 等已有 provider=200 的 turn-final ledger。
- [done] 429 责任按共享门控累计量分析，不以最后一个 429 请求归责。05:09/07:26/09:30/11:41 四个独立 wave 前 60min，Archive 受管主动请求约 71/66/67/73 次，其中 Watchdog queue 约 62/60/59/60 次；说明 stale-Watchdog 风暴本身已是主要可控负载之一。旧遥测没有逐条持久成功 native request，因此无法诚实给出双方精确占比。
- [done] 解释周期：01:22 最后 audit 不是立即 replay；旧 seen-id 要先等绝对 2h 过期，约 03:22 才开始 stale overlap 重放。之后约每分钟一个 Watchdog/body 请求，约 05:09 首次重新撞共享 429；每次 60min cooldown + 后续再积累形成约两小时一波。
- [done] 增加回归：同 generation progress 不重启 watchdog；catalog progress 只更新证据；诊断后 tombstone 保留；Watchdog timeout/diagnosis 文案分离；旧 deferred ledger 兼容迁移。`node --check`、TypeScript、daemon 定向 38/38、全量 25 files / 177 tests 全通过。
- [done] 部署新 daemon 并做 production 验证：PID 3676，16 个官方页继续 frozen；原 cooldown `13:41:05 北京时间` 被完整继承，Guardian/WSS=3、Bridge=true、checkpoint=false、lastError=null。新状态显示 `active=0 / timedOutAwaitingDiagnosis=2`，证明 timed-out tombstone 已与 running 分离；重启未因新 notification key 重复补发第一阶段，05:06 后暂未出现新的 native/active 429 或主动 body/catalog sync。

## 2026-10-08 Protocol Drift 实时分级 / 可读告警 ExecPlan

- [done] 复盘 2026-09-28 至今的 HTTP/DOM drift ledger、Bark report-state 与 2026-10-07 Watchdog 协议升级，确认旧机制同时存在“daily 延迟”“exact-shape 噪声”“自己 canary/replay 污染”以及“只比 first-party baseline、不比 production implementation”四类问题。
- [done] HTTP drift 已升级为语义分级：核心 request header/query/POST schema 与 response transport 契约才进入 warning/critical；`message.metadata`、附件/语音/writing block/search 等内容多态、分页值变化、late first observation、sidebar-only DOM 变化都只保留 forensic/info，不再 Bark。
- [done] Bark/CLI 共用可读 formatter：直接说明 `新增协议 header`、`新增 POST 字段`、`缺少核心 response 字段`、route/method、影响与观察次数；semantic dedupe 会把 offset/new/continue 等多个 exact hash 合成一个人类事件。
- [done] 重要 HTTP drift 改成 daemon 事件触发：warning 第二次稳定复现、critical 第一次出现即进入约 10 秒聚合窗口并 Bark；DOM 未知安全骨架由 Actor fail-closed 时立即 Bark。每日 12:00 `ChatGPT Archive Protocol Drift` 计划任务已卸载，CLI `protocol report` 仅保留为人工审计入口。
- [done] 新增“first-party 当前协议 vs production replay header allowlist”正交检查，不依赖 24h baseline；专门补 2026-10-07 暴露的 bootstrap 漏报。生产当前扫描无未覆盖 header，因此部署没有补发历史假告警。
- [done] regression 已覆盖：metadata 多态不报警；重复新 header 升 warning；Conversation Body 核心 `messages` 消失首见即 critical；生产 header 覆盖检查可发现 baseline 前已经存在但实现未覆盖的字段；DOM 历史 sidebar-only pending 自动降噪。
- [done] `node --check`、TypeScript typecheck、全量 25 files / 177 tests 全通过。production daemon 已重载为 PID 14560，Bridge 正常，启动日志确认 WSS 恢复 3 sockets；重启原样继承既有 429 cooldown，没有主动探测/新增 ChatGPT backend 流量。

## 2026-10-08 Watchdog 468min / overnight 429 回放修复 ExecPlan

- [done] 修复 DevSpace audit overlap 去重：`seenDevSpaceAuditIds` 只能在事件已经落到下一次 `pollSince()` 查询下界之外后删除，不能按事件绝对年龄 2h 清理；否则长时间没有新 audit 时，最后一条旧 first-tool 会被 overlap 每轮重放并复活已关闭 watchdog。
- [done] 修复 catalog active generation 复活：catalog watchdog 完成一次 body 诊断且 body 仍无 terminal 时，保留“本 generation 已诊断”的持久 active_watchdog tombstone；同一未变化的 `async_status=active` 不得在后续 gap-repair 从旧 `firstSeenAt` 重新建代。只有 catalog update_time / strong progress 前进后才重新武装 45min 窗口。
- [done] 补齐 tombstone 的 daemon-restart 边界：首次 catalog observation 若已经 `complete`，即使内存 `catalogActive` 尚未重建也清除 persisted catalog watchdog；若 `update_time` 明确晚于上次 watchdog 诊断，则认定重启期间发生过真实 progress 并从当前观察时刻重新武装。
- [done] 增加回归：旧 audit 即使已经远超 2h，只要仍位于 overlap 查询窗口就必须继续去重；catalog zombie 诊断后不重复拉 body，真实 progress 后重新从 progress 时刻计 45min。
- [done] `node --check`、TypeScript typecheck、daemon 定向 38 tests 与全量 25 files / 173 tests 全通过；最终 production daemon 已重载为 PID 59440，WSS 恢复 3 sockets、Bridge 正常、checkpoint 仍关闭，并原样继承 12:41:50 北京时间的 429 cooldown/pending。重载后的新日志未再出现昨夜 `1791393748804 / 179139491819x` 两组陈旧 startedAt 回放。

## 2026-10-07 北京时间通知 / 429 波次复盘 ExecPlan

- [done] 人类可见时间统一改为北京时间：429 cooldown Bark 与 Watchdog deferred Bark 的绝对时间均格式化为 `YYYY-MM-DD HH:mm:ss 北京时间`。SQLite/内部状态继续保存 epoch/UTC 绝对时间，避免破坏排序、比较、迁移与跨时区计算。
- [done] 回归验证：`node --check`、TypeScript typecheck、全量 24 files / 164 tests 通过；production daemon 已重启为 PID 59024，继承当前 cooldown。只读 payload canary 已确认 `1791377301865 -> 2026-10-07 20:48:21 北京时间`。
- [done] 复盘 2026-10-06~10-07 北京时间的 429：按 `wasAlreadyCooling=false` 计 15 个独立 cooldown wave（10/6 3 波，10/7 截至约 19:40 12 波）；原始 `cooldown armed` 日志 65 条，因为同一波会被 passive observer / active request / 页面 retry 重复记录和滑动延长。
- [done] 根因分阶段：早期 429 大量来自 Archive 自己的 `devspace:binding-probe` 与 Phase 3 checkpoint 高频 body polling；checkpoint 已默认 disabled。当前 19:34 起的新波则来自 native ChatGPT 页面/Guardian 的 catalog 列表请求，随后普通页面 `body-latest` 也持续 429；Archive active REST 已被 cooldown 阻断，但页面原生请求仍会自动重试。
- [pending] 单独评估 native-page 429 的 cooldown 语义：当前任何普通页面再次 429 都会把 Archive 全局 60min cooldown 滑动延长，页面 retry loop 因而可能无限推迟 Archive recovery。不要未经讨论直接改；候选方案是区分 `account429Observed` 与 `archiveActiveCooldown`，或仅由 Archive/Guardian 主动请求的 429 延长完整 60min，而普通页面 429 只更新观测状态/尊重 Retry-After。

## 2026-10-07 LifeOps Bridge / Reader ExecPlan

> 目标：复用已经稳定运行的 Archive Bridge（127.0.0.1:47832），不要再造第二套本地控制面；只补 LifeOps 所需的工作现场读取、搜索、状态与同步能力，并继续保持 ChatGPT Cookie/Authorization 永不离开本机。

- [ ] 扩展 Bridge 只读接口：conversation 搜索、conversation detail、turn/incident/live 状态；保留现有 list/messages/events/actor 接口兼容性。
- [ ] 增加 LifeOps Worksite payload：conversationId + turnExchangeId 定位后返回标题、当前状态、canonical messages/tool 摘要和适合存入 LifeOps 的脱敏 metadata。
- [ ] 增加 LifeOps push client：Conversation created / turn final / abnormal terminal 等稳定事件可推送到 LifeOps archive inbox；失败只记录并重试，不影响 Archive 主流程。
- [ ] 外部访问继续走现有 `archive-bridge.zjhstudio.com -> win-laptop Tunnel -> 127.0.0.1:47832`，本地 Bridge 不改成公网 bind。
- [ ] Cloudflare Access Service Token 只用于 Worker↔Bridge；Bridge 自己原有 Bearer token 保留为第二层 origin auth。
- [ ] Archive Reader 所需数据全部来自 canonical SQLite / Bridge，不允许 Reader 为了展示主动增加 ChatGPT 私有 API 请求。
- [ ] 回归：archive-bridge tests、daemon tests、全量 tests、生产 daemon reload 后 health/list/search/worksite/event smoke test。

## 2026-10-07 Adaptive Watchdog / Gap Discovery / Safety Review 研究 ExecPlan

- [done] 核清当前 DevSpace→Archive 行为：bound metadata 的 first-tool 只启动/续本 CID Watchdog，不触发 catalog gap-repair，也不主动拉 body；unbound metadata 先保存 provisional start，只有跨过 45min 仍未绑定时才 `scheduleGapRepair('devspace-unbound-timeout')`。WSS conversation transport rotation 与 Guardian recover 同样进入 `scheduleGapRepair()`，最终共用 `reconcileCatalog('gap-repair')` overlap 扫描。
- [done] 明确 gap-repair 不是“每个新 turn 都打 conversation list”。当前只有 transport gap/recover 与 unbound-timeout 等恢复事件会排队；多次触发会合并为一个 pending repair。后续若做新 metadata 快速发现，应单独设计低频 binding-discovery，而不是滥用完整 gap-repair。
- [done] Safety Review 继续作为正交 transient 状态而非 incident 主类。`safety_review_update(active=true, protection_type=bio/cyber)` 来自 HTTP SSE；review active 时 transport 可继续 ping/收数据，最终仍可能正常 final。只有随后 WSS/body 终态或 45min hard watchdog 才决定 normal final / complete-no-final / active-zombie/watchdog-timeout。ghost-execution/persistence-stall 也与 safety review 正交：body 可停更而 DevSpace 工具继续执行。
- [done] 近期 2026-09-27 起可靠样本研究：76 个含 DevSpace 工具且最终自然 final、无 incident、tool audit 能与 turn/final 对齐的样本中，工具链跨度 p50≈8.29m、p75≈13.29m、p90≈16.51m、p95≈26.16m，最长≈32.98m；turn user→final p50≈10.32m、p90≈19.51m、p95≈31.65m，最长≈33.58m。顶端 33.2~33.6m 聚集提示可能存在约 2000s 级 wall-clock budget，但当前只能作为经验信号，不能宣称平台硬上限。
- [done] 同一批 76 个自然 final 工具型 turn 的“上一工具结束→下一工具开始”最大静默：p50≈0.90m、p90≈2.60m、p95≈2.95m、最大≈4.31m，0/76 出现 ≥5m 静默。说明进入 DevSpace 连续工具阶段后，5~10m 无 running tool 且无新 audit 是高价值软异常信号，且无需额外 OpenAI API 请求。
- [done] 单条 DevSpace tool audit 不能作为统一 hard timeout：近期绑定 metadata 共 7161 条完成调用，99% 单次时长约≤25s，但存在约 38.7m/42.2m 的成功 `exec_command` 长生命周期记录，因此必须区分“工具正在运行”与“工具链静默”。
- [pending] 设计 soft watchdog，不改 45min hard watchdog：优先维护 `lastStrongProgressAt`（DevSpace tool start/finish、SSE substantive event、WSS async progress、passive body head/update 变化）；已有工具链且无 running tool 时，≥5m 静默可记录 suspected-stall，建议 10m 再通知用户；SSE ping 只证明 transport 活着，safety-review active 是门控状态，二者都不能单独证明模型有正文进展。
- [pending] 评估“新 metadata 快速 binding discovery”：优先使用现有 passive catalog / conversation-created / 时间唯一候选，必要时把多个新 metadata 合并到一次低频首屏 catalog，而不是每个 first-tool 各打一轮 gap-repair。候选唯一时可建立 provisional binding，后续 canonical body 的 exact tool+args 再升级为 high-confidence。
- [pending] 暂不启用固定 10min body polling，也不自动 steer/stop。若后续需要“接近执行预算提醒”，先基于 28~30m wall-clock + 近期实测分布做只通知 canary；自动向 active turn 注入“请收尾”属于会改变模型行为的动作，需另行明确授权和验证。

## 2026-10-07 Turn 终态 / Watchdog Bark 通知矩阵 ExecPlan

- [done] 按用户新要求统一“每个 turn 最终都有可见 Bark 结果”：正常 complete+final 也通知；complete 后无 final/显式 interrupted 继续走 incident 通知；Watchdog 超时若当场拿得到 body，只发一次最终诊断，不先发重复 timeout 通知。
- [done] Watchdog 到点但因 active API cooldown 暂时拿不到本次诊断 body 时，立即发一次 `watchdog-deferred-cooldown` Bark，包含 conversation title/CID、真实 watchdog 起点、已超时时长、cooldown 解除时间，并保留 generation 等待后续 body；后续诊断若产生最终异常分类，再发最终诊断通知。
- [done] DevSpace metadata 尚未可靠绑定 canonical conversation 时，45min 到点仍发一次 `watchdog-unbound` Bark，明确“Watchdog 已到点，但当前无法可靠定位聊天”；不得猜 CID/title。绑定成功后继续既有 body 诊断链。
- [done] 为 normal final / deferred watchdog / unbound watchdog / incident 增加持久成功 ledger + 运行期 in-flight 去重，按 `conversation+turn/generation+notification-kind` 去重；Bark 失败不落成功 ledger，后续同事实仍可重试。
- [done] complete 通知只在 canonical body 已确认 final 后发送；`conversation-turn-complete` 首帧若 body 尚未 settle，不先报“正常完成”，15s settle 后按最终 body 只选一个终态通知。在线 gap-repair/wss-reconnect/guardian-recover/cooldown-recover 找回的 final 也通知，startup/periodic 历史补档不轰炸。
- [done] 隔离 worktree 与最新主分支均通过 node syntax、TypeScript typecheck、全量 24 files/163 tests；production daemon PID 55384 已部署。真实 Guardian canary `Notifyfinal1007`（CID `6ac625a8-...`）收到 WSS `conversation-turn-complete`，canonical final=`NOTIFYFINAL1007`，Bark HTTP 200，并在 `turn_notification_ledger` 落唯一 `turn-final:<cid>:<turn>` 记录。

## 2026-10-07 Watchdog generation 收口 / 漏通知修复 ExecPlan

- [done] 复原 `6ac53e83-...` 的真实漏通知链：上一轮 02:32 turn 已在 03:58 watchdog 诊断并 Bark 200，但 active_watchdog generation 未关闭；14:49 新 turn 的首个 DevSpace tool 因同 CID 仍 active 被误当 heartbeat，直到 16:19 body 才发现 turn key 已变化并错误从“发现时刻”重新计 45min。
- [done] 修改 watchdog 生命周期：一次 watchdog timeout 诊断成功并完成 incident 分类后关闭当前 generation；后续 DevSpace first-tool 必须创建新 generation，不能在已诊断旧轮上续 heartbeat。
- [done] 给“晚发现新 turn”增加真实 start 回填：若 watchdog body 能从当前 user node 取到 create_time，则以该时间作为新 generation 的保守起点；若它本身已经超过 watchdog 阈值，本次诊断即可按新 turn 立案，不能再额外延迟 45min。
- [done] 加回归覆盖：① watchdog incident 后 generation 关闭；②同 metadata 后续 first-tool 新建 generation；③ stale catalog watchdog 发现 newer turn 时使用 user create_time，不使用发现时刻；④已有 cooldown/terminal/notification 语义不回归。隔离 worktree 已通过 node syntax、TypeScript typecheck、定向 5 files / 64 tests 与全量 24 files / 159 tests。
- [done] 已 cherry-pick 回主分支并完成生产部署验证：daemon PID 47156 启动后先把 `6ac53e83-...` persisted start 从错误的 16:19:06 回夹到 turn `cb54e2a0-...` 的真实 user create_time=14:49:39，并立即在 16:39:45 排入 overdue watchdog。诊断 body 随后又发现用户已于 16:26:22 开启第三轮 `347a2da3-...`，因此第二轮按 historical abnormal-terminal 落库且不补发迟到 Bark；当前 active_watchdog 已准确切到第三轮 startedAt=16:26:22。生产 checkpoint 仍 disabled、Bridge 127.0.0.1:47832 正常、cooldown=null。

## 2026-10-06 并行协调：Watchdog / binding / cooldown / DevSpace env ExecPlan

> 并行约束：另一个 Agent 正在处理 Phase 3 / Phase 4 / Phase 5。本文任务只修改 DevSpace audit/env 热路径、Archive 历史 binding/backfill、429 cooldown 通知与相关文档/测试；不改 LiveTurn/Actor 主体实现。若发现目标文件被并行 Agent 修改，先停下对该文件的编辑并重新对比，不做覆盖式提交。

- [done] 解释历史 audit 边界：7/31 起已有 ChatGPT conversation-scope metadata（初版 hash，8/4 起直接存原始 scope id）；9/14 起才有逐工具 metadata/tool/args/result 的 tool_audit，9/27 才有 current/recover CLI。
- [done] 117 个 metadata 已全量分桶：97 可唯一 exact binding；其中当时 11 已绑定，所以新增 86。其余 20 均可解释为 body/时间证据缺失、弱共享 fingerprint 或被更强 metadata 压过，未发现强证据齐全却 matcher 随机失败。
- [done] 历史 seed/backfill 已实现：启动时先 GROUP BY seed 全部 DevSpace metadata first/last seen，再 exact backfill；历史 seed 不进入 live watchdog。并修复同一 CID 新 metadata 被旧 binding 提前 return/timeout probe 跳过的问题。
- [done] 2026-10-06 16:02:52+08 429 已复原：Archive 的 wss:conversation-turn-complete 主动 body 请求首次返回 429；此前约 6m14s 无主动请求，不像瞬时风暴。
- [done] 独立 429 cooldown 通知已实现：首次进入发一次，滑动延长只日志；通知包含 reason/route/Retry-After/解除时间，不进入 incidents。
- [done] DevSpace exec_command 已增加 refreshEnvironment=true；tool schema 与 MCP Codex instructions 均可见，默认仍走 30s cache。
- [done] warm exec 延迟已拆分：生产 MCP 8 次 126~143ms/平均 135ms；同机直接 ProcessSession 第一条 420ms、缓存热后约 71~103ms，说明默认环境刷新已消失，剩余主要是 Windows process-host/session 与约数十毫秒 MCP/调度成本。
- [in_progress] Archive 21 files / 131 tests、DevSpace 全量 test/build 已通过；正在把隔离 worktree 提交安全 cherry-pick 回并行主分支并做生产部署/healthz/status/backfill 结果验证。

## 2026-10-06 Phase 3/4/5 收尾实现 ExecPlan

- [done] 真实资源预算已完成：当前 Guardian V8 used heap 约 201MB，空白 ChatGPT 首页约 158~175MB，普通长聊天约 214MB；受控新增一张 idle ChatGPT 页的浏览器进程树边际 Working Set 常见约 +250~440MB，第二张缓存热后仍约 +140~220MB；一次较长渲染可让单页 JS heap 再增加约 50MB。结论：常驻多养 Listener/Actor tab 是数百 MB 级成本，值得合并为一个 Guardian page target；职责隔离放在 Node 状态机层。
- [in_progress] Phase 3 跨设备 fallback 的状态机/证据链已经实现并有单 watcher canary，但**主动 checkpoint polling 不再视为生产完成**：后续长时间真机运行证明把第一方短时 7~10s `stream_status + body` 行为复制到多个后台/sticky-active CID，会在约几十到上百次私有请求后反复触发账户 429。生产 daemon 当前默认 `checkpointRefresh.enabled=false`，仅显式 `--enable-checkpoint-polling` 才打开；WSS/SSE、被动网页观察、gap repair、watchdog 与 final-only canonical 同步继续工作。后续若恢复主动 polling，必须先完成单会话短窗口、no-progress stop、incident/watchdog stop 与请求预算重新验证。
- [in_progress] Phase 3 drift/安全：HTTP 协议 ledger、429 cooldown/通知、DOM drift ledger、人工 approve/lock 与 Actor 发送前 fail-closed 已落地；429 现场已经证明“单次恢复 canary 成功”不能外推为长期多 watcher 安全。当前重点改为积累第一方自然 cadence/terminal transition 样本，并验证真实 shape drift 的端到端告警/人工复核；任何主动 polling 都继续服从默认关闭与统一熔断。
- [done] Phase 4 Actor CLI 核心闭环已完成并通过四组 production E2E：支持 `new`、`continue <cid>`、active `follow-up/steer` 与 `batch --jobs-file` 顺序调度；导航/context/composer/prepare/正式 POST/2xx/conversation identity 均有闭环确认，waiting-for-final 与错误 mode 会提前拒绝。`new/continue` 严格要求 `text/event-stream`；2026-10-07 真机确认 `/f/steer_turn` 成功响应为 200 `application/json`，已按 mode 拆分响应契约。剩余 Phase 4 工作转为 project/archive/delete 等高级动作与语音/附件，不再阻塞文本 Actor 主链。
- [done] Phase 4 导航/DOM 安全层已落地：第一方 SPA/真实 DOM 优先，sidebar 找不到目标才 `Page.navigate()` fallback；可见性使用自身 pointer-events + ancestor hidden/display/visibility/opacity + `elementFromPoint` hit-test；消息上下文门控兼容当前 selection/search/user-bubble 等多代语义锚点。DOM drift ledger 已升级到 v2：voice/send/stop 归一为动态 `primary-action`，sidebar presence 仅在其余安全骨架与已批准 baseline 完全一致时视为可信动态变体；真正未知结构即使重复重试也持续 pending，必须人工 approve。
- [done] Guardian/Actor 合一后的 WSS 生命周期已收口：2026-10-07 07:08 真机发现顶层 document replacement 后旧 document 的 9 条 WSS 未收到 CDP close、新 document 又创建 3 条，`activeSockets` 虚增到 12。修复后受控 Guardian reload canary：旧 3 条在 `Page.frameNavigated` 被一次性 retire，新 document 建回 3 条，最终 `activeSockets=3`；conversation carrier `58448.394 -> 58448.813`、generation 1→2，gap-repair 语义保留。SPA route/iframe 不触发 retire。
- [pending] Phase 4 管理动作逐项取证并 CLI 化：archive/delete、project 内新建、move conversation A->B project、project create/rename/edit；每一项先抓第一方 native 行为，再决定 DOM 还是稳定 backend API，发送/Sentinel 仍坚持页面自身网络栈。
- [pending] Phase 4 语音/附件：取证 Web 语音输入的实际音频上传/转录流程，以及图片/文件 attachment 的第一方 upload/asset 绑定路径；优先复用原生 UI/协议，不自行仿造未验证 upload token。
- [pending] Phase 5 复用 Family-AI 产品壳：保留移动端/侧边栏的 conversation/project 列表、新建、切换、文本/语音/图片/文件输入和流式消息 UI；后端从原有第三方模型 API 改为 `ChatGPT Archive + Guardian/Actor CLI + LiveTurn/checkpoint stream`。iPhone 客户端只连自家后端，不直接持有 ChatGPT 会话凭据。
- [in_progress] Phase 5 数据面：本地 SQLite/Archive 已作为 canonical history，并已有 Bridge `/v1/events` 把 Actor/LiveTurn/WSS/canonical-update 脱敏为自有事件流；当前仍缺 Family-AI 前端按 turn identity 消费这些事件、断线后从 canonical messages 追平，以及未来若确需逐 token 正文时的专门 sanitizer。主动 checkpoint polling 继续默认关闭，不把高频私有请求当远端流式基础设施。
- [done] Phase 5 Bridge API v1 已进入 production daemon 并完成真机 E2E：默认仅监听 `127.0.0.1:47832`，独立 256-bit Bearer token 与 ChatGPT Cookie/Authorization 完全隔离；暴露 `/health`、canonical conversation list/messages、Actor new/continue/steer submit 和脱敏 `/v1/events`。2026-10-07 `PHASE5BRIDGE1007` 验证 `HTTP Bridge -> Guardian Actor -> LiveTurn -> WSS -> canonical final -> Bridge canonical-update` 全链路，HTTP 202 响应仅包含 conversationId/mode/submittedAt/boundAt/runningConfirmed，内部 CDP/DOM 字段不外泄；daemon 结束时 Bridge 同步关闭，非 loopback bind 必须显式 `--allow-remote-bridge`。Family-AI Worker 后续只以 Secret 持有 Bridge URL/token 并做代理，iPhone/browser 不接触 ChatGPT 凭据。

## 2026-10-06 Phase 3 收口 / Phase 4 Guardian-Actor 合并复核 ExecPlan

- [done] Phase 3 跨设备 late-open 研究告一段落：真实 iPhone -> PC 样本已确认存在 `stream_status + conversation body` checkpoint polling 路径；HTTP `/resume`、turn-WSS、checkpoint refresh、final-only fallback 已明确分层，证据与边界写入 `WSS_PROTOCOL.md / PROGRESS.md`。
- [done] “Guardian 必须与 Actor 分 tab”已被真机反证。正式 Guardian target 直接跑当前 Actor 代码，新建 conversation 和已完成 conversation continuation 均成功；Guardian targetId/health 保持稳定，账户 WSS 仍能收到两轮 complete。后续 `SAMETABB1006` 又进一步证明同 tab 可以在 A 仍 active 时 SPA 切 B 并启动新的 `/f/conversation`；旧 `SAMETABB928` 的“看不到 send button”只能视为 DOM/时序误判，不能再推出并发 UI 锁。
- [done] 已定位当前合并的真实工程副作用：Actor 无条件 `Page.navigate()` 会让 Guardian 每次发送重建一整套账户 WSS（3->6->9 overlap）并触发 conversation transport rotation；URL marker 会丢失；Guardian target 又被 LiveTurn passive observer 排除，导致自己发出的 SSE 不落 Phase 3；cooldown 的 Guardian REST block 也可能误伤 continuation 页面加载。
- [in_progress] 实现 Guardian-aware actor mode，而不是继续永久维护第二个常驻 Actor tab：①若当前页面已可发送，避免 full `Page.navigate`；②需要切 conversation 时优先使用第一方 SPA route/已有 DOM 导航并验证不会重建账户 WSS；③Guardian 自身 `/f/conversation`/`/resume` 复用 LiveTurn observer；④Guardian identity 由 targetId/state 持久恢复，不再单押 URL marker；⑤显式 actor 操作与 cooldown REST block 建立可预测门控。当前默认 target 已切为 Guardian，passive observer 也已覆盖 Guardian；闭环 Actor CLI 已实现 new/continue/steer 的主要状态门控。
- [done] Guardian/Actor 合并后的四组 E2E 已全部通过：① new chat `/f/conversation` 200 SSE + LiveTurn/WSS/canonical final；② finished continuation CID `6ac5ebe1-...` request `37424.1486` 200 SSE；③ active steer CID `6ac60377-...` request `58448.1039` 返回 200 `application/json`，随后 canonical assistant 精确收口为 `[PHASE4STEER2_1007]`；④ A=`6ac603a3-...` 原始 SSE `58448.1079` 尚在持续收流时，同一 Guardian target SPA 新建 B=`6ac603af-...` request `58448.1129` 成功，B canonical final 为 `[PHASE4B_1007]`，而 A transport 在 B 启动后仍 active。整个并发 canary 中 Guardian target 不变，账户 WSS generation=1、conversation carrier generation=4、activeSockets=3、HTTP 429=0、syncErrors=0；daemon RSS 约 68.3MB→63.2MB、heap 约 26.0MB→27.3MB，无额外常驻 Actor tab。**不再**把“同 tab 多 active conversation”视为需要备用 Actor pool 的限制。
- [done] Windows Guardian “真隐藏导致无法 hydration”假设已证伪：早先 `composer/messageNodes=0` 实际由旧 pointer-events 判定和过时消息 DOM 锚点共同造成。修正 hit-test 与消息锚点后，SW_HIDE Guardian 可以正常完成 finished-conversation context hydration；实验性的 show-offscreen visibility helper 已删除，不引入第二套窗口生命周期。
- [pending] Phase 4 后续管理动作按第一方 UI 逐项取证：project 内新建、move project、archive、delete，以及 project create/rename/edit；发送与管理动作均优先走网页自身 React/网络栈，不自行重写 Sentinel/PoW/challenge。active steer 已纳入核心 Actor 并完成 production E2E，不再列为待取证动作。

### 2026-10-06 active-turn 同 tab 发送语义复核

- [done] A 正在生成时的 follow-up 已真机复现：原始 A SSE `61856.1055` 尚未 DONE，第一方 Web 直接发出 `/f/steer_turn` request `61856.1092`；A 原 SSE 继续运行。active-turn follow-up 是正式支持路径，不是异常状态。
- [done] 同 tab 跨 conversation 并发已真机复现：A SSE 未结束时点“新聊天”SPA route 到 `/`，同 target 成功发出 B 的 `/f/conversation` `61856.1126`，B 完成后 A 仍继续收 SSE 超过 50 秒。旧 `SAMETABB928` 不能作为“一 tab 一 active generation”证据。
- [done] Actor 发送状态机已收口：删除“active generation 会阻止第二 conversation send / 必须 Actor pool”的前提；区分 new/continue `/f/conversation` 与 active follow-up `/f/steer_turn`；动态 composer 的 `停止/发送` 切换和 `/prepare -> submit` 两阶段均做多信号状态判断。2026-10-07 CLI 真机 E2E 已同时覆盖 active steer 与 A-active→B-new，两条路径均成功。

## 2026-10-06 DevSpace→Archive 事件唤醒 / binding 简化 / watchdog 语义修正 ExecPlan

- [done] 生产事实已还原：旧算法确实因“时间窗内必须只有一个 metadata”在并发聊天时放弃可确定 binding。改成 exact tool+args 后，历史 backfill 把现存 9 个 metadata 全部绑定，当前 unbound=0；当前长聊天已通过 body:exact-tool-args-backfill 高置信绑定到 canonical CID。
- [done] DevSpace→Archive 已改为事件驱动：tool_audit 先写 SQLite，再 fire-and-forget UDP localhost 门铃；Archive 收到后立即读 SQLite。固定 5s polling 已移出实时路径，只保留 60s durable catch-up。生产已收到 200+ 门铃且 invalid=0。
- [done] 删除 fast-path/时间猜 binding；body 中 api_tool.call_tool 的 tool+完整 args 与 DevSpace tool_audit 做 canonical JSON exact match。时间只用于缩小查询范围，不参与身份胜负判定；至少两个 exact fingerprints，或一个只属于单 metadata 的唯一 fingerprint 才绑定。
- [done] Watchdog 语义已修正：45min timeout 只触发本地 exact backfill、catalog repair/body probe；CID 解出后才进入 watchdog:devspace-timeout conversation body 诊断，再由 terminal/active-zombie/incident 分类决定是否 Bark。未绑定 timeout 本身不再直接通知。
- [done] 性能实测：裸 cmd 约 33~36ms；process-host 约 78ms；旧 DevSpace 空 exec 约 500~530ms。Secret 无占位符约 0.18微秒/次；audit+SQLite+UDP 约 0.188ms/次；Archive 10s 空闲窗口 CPU 0s、RSS 约 34~50MB。主要瓶颈定位为每条命令同步 PowerShell 刷新 Windows 环境。
- [done] DevSpace Windows persisted environment 已加默认 30s 缓存；隔离 dev 第一条约 472ms，后续热路径平均约 75ms。生产受控 helper/Task Scheduler 已重启到新 PID 28568，healthz=200；MCP 重新连通，生产实测首条 311ms、随后约 123~166ms。
- [done] raw metadata 已生产验证：新 tool_audit.request_meta_json 原样包含 openai/session/subject/organization/userAgent/locale/timezone/userLocation 等。DevSpace typecheck/test/build 与 Archive 21 files / 129 tests 均通过。

## 2026-10-06 DevSpace raw metadata / binding / watchdog 收口 ExecPlan

- [done] 取消 DevSpace request metadata 脱敏摘要：源码、测试、隔离 build 与生产进程均已切换为完整保存 MCP metadata / args / result；真实新 audit 行已原样落库。历史哈希化旧行无法逆推。
- [done] 复核 DevSpace migration 事故：问题确实是旧生产库已经登记 v7 后，修改 v7 实现不会重跑。现已由独立 v8=`tool-audit-request-metadata`、v9=`chatgpt-conversation-bindings` 修复；生产库 1~9 均已登记，实体列/表存在，并有 legacy-v7 升级回归。Archive 自身使用每次 open 的 `CREATE TABLE IF NOT EXISTS + ensureColumn`，不存在同类版本号复用。
- [done] 把 binding/watchdog 收拢成一条状态机：`openai/session` 是 conversation 级；已有 binding 时 first DevSpace call 直接启动 45min watchdog；未知 binding 时 firstSeenAt 立即持久化并独立计时，body/turn 到手后再做一次后验 binding。删除 `conversation-created ±45s` 时间窗口绑定，它不是启动/绑定的必要条件。
- [done] 修复 unbound provisional watchdog 缺口并纠正语义：firstSeenAt/timeout 仍持久化并可跨 daemon 重启恢复，但 timeout 只触发诊断和 binding probe，不再直接发“待绑定”事故通知；body/status 诊断完成后才按真实 lifecycle 决定通知。
- [done] Archive 当前已通过 node syntax、typecheck 与全量 21 files / 129 tests；DevSpace raw metadata、事件门铃、exact binding 与生产重启均已实测。

## 2026-10-03 iPhone -> PC 跨设备续流一次性全量取证 ExecPlan

- [done] 一次性 browser-level CDP flight recorder 已实现并经过三轮 smoke：自动附着当前/后续 ChatGPT page/worker/service-worker，专用 helper 从 about:blank 开始保证账户 WSS 不漏；被动记录全部 `backend-api/*` 请求摘要、WSS/SSE 控制面与 resume-store hash/长度，不保存正文或原始凭据。
- [done] 无需另造 iPhone 测试：2026-10-06 直接使用两个正在运行的真实手机发起 turn 作为天然样本，PC fresh tab late-open 全程由 `cross-device-current-1006.jsonl` 记录。
- [done] 两个样本均确认：PC 本地 resume-store 无可用 credential，`stream_status=IS_STREAMING` 后 `/f/conversation/resume=404`；没有 `conversation-turn-*` WSS；前端转为约 7~10 秒一次的 `stream_status + conversation body` polling。body 中 turn id 固定而 current_node/update_time 间歇推进，解释了“跨设备还能继续看到进度”并不必然等于真正 live transport。
- [done] turn 身份来源已在当前样本收口到 conversation body：`conversation/init` 与其它已观测非-body JSON 响应均未携带 turn/request/topic identity；late-open body 直接给出当前 `turn_exchange_id/working_turn_id/request_id`。现有账户 WSS 没拿到可靠 start/turn identity。
- [in_progress] 下一步把 Phase 3 语义正式拆成三层并考虑生产化：`live transport(SSE/resume/turn-WSS)`、`checkpoint refresh(stream_status+body polling)`、`final-only COMPLETE body`。Archive 的 start detector 需要另行评估“passive native catalog 发现 async_status=3 -> bounded/native body 获取 turn identity”是否比依赖不存在的 WSS start 更可维护；仍保持纯被动 turn-WSS recorder，等待真正自然 handoff 样本。

## 2026-10-03 Watchdog DevSpace 触发 / conversation transport repair ExecPlan

- [in_progress] 把 WSS gap repair 从“所有 ChatGPT WSS 必须先归零”改成 conversation transport generation：只追踪实际承载 `conversations/alder-conversations` 的 socket；carrier 换代即安排一次 debounced gap repair，`app_notifications/resource-updates` 单独重连不触发 catalog fallback。
- [pending] 将 watchdog 默认阈值从 30 分钟调整为 45 分钟，并保持 complete/final 提前收口；同一 conversation 在现有工程约束下按“同一时刻单 active turn”维护状态，不用 DevSpace 调用间隔硬切 turn。
- [pending] 接入 DevSpace supplementary start：DevSpace 只记录每次 MCP 调用的聊天级 `openai/session` 与可安全审计的 request metadata 形状；Archive 负责 metadata -> canonical conversation UUID binding、provisional active/watchdog、后验 tool-node/turn_exchange_id 校正。
- [pending] binding 采用轻量快速证据：优先直接 correlation/invocation metadata；若宿主未提供，再用 tool 名 + 规范化 args/result 指纹 + 时间/顺序做短序列匹配。首次可信匹配即可持久化，后续样本用于校验而非每次全历史重算。
- [pending] 复核 Archive SQLite：持久保存 metadata binding、最近确认的 conversation/turn_exchange_id、binding evidence/confidence 与 lifecycle 时间；DevSpace 可保留原始 metadata 观测，但不承载 watchdog 状态机。
- [pending] 核对所有主动 `conversation list/body` 请求继续经过同一个 global request gate；默认 body 6s、catalog 5s、统一 `lastActiveRequestAt` + 0~1.5s jitter，cooldown recovery 前 3 次请求 30s。除非测试证明仍有过密 429，否则本轮不再新增第二套限速器。
- [pending] 全量 typecheck/test 后更新 PROGRESS，并在不覆盖 DevSpace 当前未解决 merge conflict 的前提下部署 Archive；DevSpace 源码若无法安全提交则只完成可独立提交的观测改造或明确保留现场。

## 2026-09-28 WSS 轮换 / gap-repair / cooldown / DevSpace start 取证 ExecPlan

- [done] 先补 WSS 逐 socket 可观测性：记录 `requestId`、创建/关闭时间、该 socket 实际发送/收到的 subscribe topic、`recovered`、消息 topic 与关闭时仍承载的 topic；只记录控制面，不记录正文、cookie、token 或认证头。
- [done] 用 Git 历史和现有 daemon 日志定位“过去约 30–40 分钟原生 WSS 轮换会触发 fallback，而 2026-09-27 夜间未触发”的行为变化；确认 2026-09-13 `f062e1c` 已把 per-socket close 语义改成 global-zero gap，9/24 左右实际前端 socket 生命周期变化才暴露这个潜在假设。
- [done] 完整审计 gap-repair/cooldown：已区分 30 秒 debounce、10 分钟主动 repair 最小间隔、60 分钟滑动 429 cooldown、passive cache、Guardian REST block、recovery probation 与 periodic 6h；现有主动 list/body 共用同一个 global request gate。
- [done] 复核 DevSpace `openai/session metadata`：DevSpace 已写入 `tool_audit.metadata_id`，但 Archive 尚无 watcher/binding；该 metadata 是 conversation 级稳定键，不是 turn key。
- [done] 逐 socket 观测已证明稳定存在 3 条物理 WSS：`conversations+alder-conversations`、`app_notifications`、`resource-updates`。修复语义已决定升级为 conversation transport generation，不再等待全局 socket 归零。

## 2026-09-27 WSS 语义、Zombie 时序、Phase 3/4 继续实现 ExecPlan

- [done] 收拢 Phase 3 A/B 实验的请求预算副作用：确认多开真实 ChatGPT 页面本身会叠加第一方 sidebar/TPP/settings/catalog 请求并触发 429；本轮累计 20 次 429 被 daemon 被动观察后正常进入 1h cooldown，protocol learning 的 `approvedReplayTemplates=0`，未发生自动 replay 风暴。已关闭明确测试页，保留正常页 + Guardian + 单 Actor；archive/delete 等 UI 新实验等 cooldown 自然结束后再做。
- [done] 重新建立 WSS 分层词汇表：已新增 `WSS_PROTOCOL.md`，严格区分 `socket -> topic -> message envelope -> business event/update_type`，并按当前真机/历史/兼容三档标注证据。`conversation-created / conversation-turn-complete / conversation-update / conversation-history-update` 都是业务事件类型，不是 topic；当前稳定生命周期事件来自 `conversations`，`conversation-history-update` 仍只是 `alder-conversations` 候选。
- [done] 修复 catalog late-start watchdog 的跨 turn 计时污染：watchdog body 现在记录 turn identity；若同一 conversation 的诊断已从 turn A 变成 turn B，B 会以“首次确认看到 B”的时刻重新开始完整 watchdog 窗口，不能继承 A 的年龄直接立 `active-zombie`。
- [done] WSS state 已拆分 `explicitSubscribedTopics / observedMessageTopics / observedConversationEventTypes / eventTopicCounts`；短时间没看到 subscribe ACK 不再等价于 topic 退役。2026-09-28 当前 daemon 已再次确认四个显式 topic，实际 conversation business message 目前来自 `conversations`。
- [pending] 捕获当前 `conversation-update` 的真实 2026-09-27 wire shape。现有 WSS control summary 已再次看到 `async-task-update-message / async-task-steering-message`，但正式 `eventCounts` 仍只解析到 `conversation-created / conversation-turn-complete`，说明 update 的当前 envelope 与旧 fixture 可能不同；先脱敏保存结构，再决定是否扩 parser，禁止凭旧测试臆改。
- [done] Phase 3 HTTP LiveTurn observer：普通 ChatGPT 页已经发生的 `/f/conversation` 与 `/resume` SSE 已通过 `Network.streamResourceContent + dataReceived` 被动接入，只保存 conversation/turn id、resume credential 的 hash/长度、`: ping`、handoff、safety review、message-stream-complete、DONE 与网络收口，不保存原 token/正文。2026-09-28 production E2E `PHASE3LIVE928` 已验证 `Actor POST -> resume-token -> turn id -> message-stream-complete -> DONE -> stream-finished -> WSS complete -> canonical final` 同一 turn 闭环。动态 `conversation-turn-*` WSS 合流仍属后续 StreamHub。
- [done] Remote Late-Attach / Native UI Attach 的 Web token 路径已收口：same-profile 正常 `/resume` 依赖 `codex-browser-host` IndexedDB persisted capability；2026-10-03 在长 turn 仍为 `IS_STREAMING` 时关闭 A、删除该 CID capability 后，fresh B 立即 `/resume` 404，随后只以约 5～6 秒一次的 `stream_status` 轮询等待 `COMPLETE`，最终一次性显示 final。当前 Web 因而不存在“缺 token 时只凭 account + conversation_id 自动重新领取 resume credential”的简单路径。真正跨设备若有额外同步能力需另证，但 Phase 3 已不能把 `/resume` 当作 universal late-attach。
- [in_progress] Phase 3 下一主线为动态 `conversation-turn-*` WSS。协议 shape 已由多套近期实现交叉确认；主动认证 WSS probe 被安全检查阻止，因此不绕过，改为纯被动 production recorder：任何普通 ChatGPT 页只要第一方自然 `subscribe conversation-turn-*`，Archive 自动记录 ACK/recovered/catchups/live 并把 encoded SSE 合并进 LiveTurn。当前本账户历史 `stream-handoff=0`，故仍缺 first-party catchup/live fixture。若长期没有自然 handoff，则跨设备实时方案不能建立在 turn-WSS 必然可用上，只能增加 generation-intent 传感器或接受 `stream_status + final body` 降级。
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
- [pending] 继续真正 Remote Late-Attach Probe：same-profile token 路径已确认由共享 IndexedDB persisted atom 提供，因此后续必须换独立 storage context。由 Firefox / iPhone / 独立 Chrome profile 启动或加入长 turn，分别捕获 `stream_status`、账户 WSS、first-party loader 与 `/resume`，确认独立客户端如何 reacquire 当前 419-char resume credential；不得把同-profile结果外推到跨设备。
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

- [done] 仅保留 `ui-virtualizer-blank-view` 作为历史取证分类，不再建立独立 UI observer 开发任务。2026-09-24《漫画分镜设计》曾出现 canonical 正常 final、DOM `innerText` 仍有完整消息，但 `[data-message-id]=0` 且内容树位于巨大负坐标的样本；该事实继续保留在 incident taxonomy / forensic 记录中，但用户并未把“自动识别这种 UI renderer 故障”列为产品需求，后续不主动推进。
- [done] 对三个风险会话先做无刷新 CDP 抢救：保存 DOM HTML、纯文本、DOMSnapshot，以及可见 user/assistant 的真实 `data-message-id`；同时在停 daemon 前复制 SQLite/WAL/SHM/turn trace。
- [done] 解锁 SQLite 后与浏览器现场逐项对账，确认三例都存在“执行/前端现场比 canonical conversation archive 更靠后”的 persistence gap：迁移与异常分析缺整轮执行尾段，Sidebery 至少缺长度上限终止节点，工具过程另存在于 DOM/audit。
- [done] 当前接续聊天自身再次中断后形成第四个对照样本：canonical body 已有 491 节点且 `current_node` 指向真实 tool result，但 DOM 只显示 user + 合成 timeout error；将其单独命名为 `ui-hidden-canonical-tail`，明确它不是 persistence gap，也不是 confirmed head rollback。
- [done] `ui-hidden-canonical-tail` 只作为 2026-09-22 hidden-node/recovery 取证中得到的现象标签保留，不再转化为 Phase 3 独立待办。当前安全边界已经完成：DOM/DOMSnapshot/raw audit 可留存，但 UI-only timeout/length-cap 占位不进入 canonical messages；无需为此再建设常驻 UI observer。
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

## 2026-10-16 ClassFlow Notes：Project 瞬态不可见导致静默终止

### 现场结论
- 2026-10-16 08:00–09:40《泌尿生殖系统》的 ClassFlow Notes 在 Archive Actor 正式 POST 之前终止；submission 错误为 `ChatGPT actor project not found or not visible in sidebar: 课堂录音→笔记`。
- 2026-10-12 的课程出现过同一错误。当前 Guardian 的无障碍树已经再次能看到 `课堂录音→笔记` 以及 `在 课堂录音→笔记 中开启新聊天`，因此这是 Project/sidebar hydration 的瞬态就绪失败，不应按永久业务错误处理。
- 当前 submission queue 的 retryable 分类漏掉了该错误，因此第一次失败即写成 `failed`；同时 submission queue 的 attempt error 没有接入 daemon Bark 通知，所以既不会自动恢复，也不会产生手机告警。ClassFlow 自己的 stage-event 通知目前仍因 `CLASSFLOW_NOTIFICATIONS_ENABLED=false` 关闭。
- 进一步源码复核发现一个更具体的 UI race：`clickProjectNewChatSpa()` 在第一次找不到 Project action 时，会检查“项目”分组按钮并直接点击；但当前真实 DOM 的“项目”按钮带 `aria-expanded=true`。因此若 React 重渲染期间 Project 子项短暂消失、分组头仍存在，Actor 会把“已经展开但正在重挂载”误判成“折叠”，反而主动把 Project 区折叠掉，随后 2 秒内当然找不到目标 action。这是比 durable queue 分类更靠近根因的一层。
- `terminal failed` 仅指 **Archive submission queue 的自动状态机终止自动重试**，不是 ChatGPT 模型回复的 terminal/final，也不是 SSE 结束。它应该只用于确定性的永久输入错误，或正式 POST 结果长期不确定、继续自动重发会有重复 turn 风险的 fail-closed 场景。
- ClassFlow 的职责应继续保持“提交业务意图 + 查询 Archive submission 是否 accepted”；Archive 的 UI/CDP/429/Guardian 瞬态错误不应复制为 ClassFlow 业务 `last_error`。ClassFlow 只需在 Archive 真正给出 terminal failed 时以粗粒度方式停止业务流水线并指向 Archive 诊断。
- 当前 SSE 架构也要与 supervisor 启动窗分开理解：Actor 在正式 `/f/conversation` POST 拿到 2xx + conversationId 后即视为 accepted，不等待模型完整生成；daemon 的 LiveTurn SSE parser 目前只持久化 lifecycle/resume 控制面，不直接把 assistant 正文写进 canonical message 表，最终正文仍由 `conversation-turn-complete` 后的 canonical body sync/被动 body reuse 收口。45/90 秒仅是 daemon 人工 resume 的基础设施健康探针窗口，与单次 Actor UI hydration、SSE 生成时长均无关。

### ExecPlan
1. 将“Project 存在但当前 sidebar 未找到/不可见”的 Actor 错误归为可重试基础设施/UI 就绪错误；保留 `invalid projectName` 等真实输入错误为永久失败。
2. 为 ActorSubmissionQueue 增加失败尝试回调，并由 Archive Bridge 透传给 daemon。
3. daemon 对 terminal `failed` 立即发 Bark；对 Project/sidebar 瞬态不可见的首次 `retry_waiting` 发一次去重提醒，说明会自动重试；DOM drift 继续使用现有专用通知，避免重复。
4. 增加回归测试，跑 Archive 全套相关测试/类型检查；重启 daemon 后验证旧 failed submission 会按升级恢复逻辑进入 retry 并成功。
5. Archive submission accepted 后，通过 ClassFlow 现有精细恢复接口让今天失败的 Notes 重新进入正常流水线，确认 conversation、Notes、摘要邮件最终闭环。
6. 生产 canary 发现当前近期 DevSpace binding backfill 实际可占约 50 秒，超过 `daemon resume` 固定 45 秒健康窗口；将“部署恢复等待上限”放宽到 90 秒（仅影响人工 resume 的 fail-closed 等待，不改变 Task Scheduler 的 1 分钟自动监督周期），避免健康但启动较慢的 daemon 被误杀。
7. 修正 Project 导航的首层瞬态恢复：先在不改变 UI 状态的前提下以 50–100ms 粒度等待 Project action 重挂载；只有明确观察到“项目”分组 `aria-expanded=false` 时才点击展开，绝不在 `true`/未知状态下盲点 toggle。durable submission queue 保留为第二层跨秒/跨进程兜底。
8. 收紧 ClassFlow/Archive 边界：`queued/processing/retry_waiting` 只表示 Archive 已接管，不再把 Archive 内部 `lastError` 镜像进 ClassFlow 的业务 `last_error`；真正 `failed` 只记录粗粒度“Archive submission 已终止，需要查 Archive”的引用信息。
9. 用户确认 ClassFlow 保留 Archive 内部 `lastError` 对排障有价值，因此第 8 条取消，不改 ClassFlow 现状；恢复责任仍全部留在 Archive。
10. 将页面原生 `/f/conversation`、`/resume` 以及 turn-WSS `encoded_item` 的 SSE 原文升级为本地耐久证据：按 stream 独立追加写入，收到多少落多少，daemon/页面/网络异常中断后也保留已到达部分；控制面 tracker 继续独立解析 resume/handoff/done，避免“诊断日志”和“正文证据”互相污染。
11. 用一条受控 Actor canary 捕获当前第一方完整 SSE fixture，确认 message snapshot / delta_encoding / tool / reasoning 的真实 shape。只有拿到直接证据后才实现 SSE→canonical promotion，禁止凭历史印象猜协议。
12. promotion 的安全边界：只有 SSE 自己具备完整终止证据（DONE/message_stream_complete，且所需 delta 可完整重建）时，才允许直接把 SSE 消息 union/upsert 到 Archive 并跳过同 turn 的主动 body refresh；若 SSE 截断、解码不完整、协议未知或只拿到残片，则残片仍永久保留作 forensic/recovery evidence，但 canonical body fallback 继续存在。
13. 最新 production reload 后的 Actor canary 在任何导航/输入/POST 前命中 `CDP Page.enable timeout after 10000ms`。源码复核确认 Actor 不监听 Page 事件，`Page.enable` 与 `Runtime.enable` 都不是发送闭环的必要前置；真正必需的是 `Network.enable`。因此移除 Page/Runtime 的无意义硬门闩，并对幂等的 `Network.enable` 做有限短重试；若 Network 仍无法启用则继续 fail-closed，绝不在看不到正式 POST/response 的情况下发送。
14. 同一 production canary 随后证明长期 passive observer 可能进入“socket 仍 open、target 仍存在，但 Network 事件已经失明”的 zombie：Actor 新开的 CDP session 明确看到 `/f/conversation` 200 + SSE 首包并绑定 CID，而 08:44 挂载的 daemon observer 对同一 target 完全没有 journal/LiveTurn/SQLite 记录。给 passive observer 增加低频本地 liveness：默认每 30s 幂等重发一次 `Network.enable` 并要求短 ACK；目标当前有 active LiveTurn 时不探测，避免干扰正在收流。ACK 超时则清理该 observer/journal、关闭旧 session，并沿既有 retry backoff 在下一轮重挂。该探针不产生任何 ChatGPT HTTP 请求。
15. 不再把“完整 SSE”与“有价值 SSE 证据”混为一谈。只要 v1 decoder 已可靠重建出 conversation_id + 至少一条 message，即使 transport 后续因 review/handoff/网络/页面异常截断，也把截至截断点的已解码 message 作为 `live-sse-partial` provisional evidence 合并进 Archive；该路径固定 `updateCurrentState=false / updateIncidents=false`，绝不更新 current_node、绝不把 turn 判 closed、绝不设置 SSE-satisfied，也绝不取消 Body fallback。完整 `message_stream_complete + [DONE]` 仍走现有 `live-sse-complete` 快路径。
16. 补“同 message_id 不能被滞后 Body 回吃”的单调证据规则：live merge 对 text/content 采用严格 prefix 保护——若数据库已观察到的 text 是新 payload text 的严格更长前缀扩展，则保留更长 content，同时允许新 payload 的 status/end_turn/metadata/current_node 等 lifecycle 字段继续更新；若新文本更长、或双方并非 prefix（真实 replace/edit），按新 payload 更新。这样 SSE 比 Body 领先时不会丢已经见过的正文，而 Body 仍可提供更可靠的终态与 head。raw live_observation 继续分别保存每个来源的完整原始快照，便于审计。
13. 生产部署最终验收时暴露独立 startup 门闩：新 daemon 已完成 Bridge、DevSpace seed/cursor、wake listener，并在日志中到达 `guardian ready`，但 state 仍停在 initializing，90 秒 supervisor 最终 fail-closed。源码确认 `establishGuardian()` 在 `guardian ready` 后会同步 await `Page.navigate/Page.reload` 的 CDP command ACK，第一次 `writeState()` 在其后；该 ACK 不是 Guardian readiness 证据，不应阻塞整个 daemon。改为 listener 已挂载后 fire-and-observe 发起导航/reload，command reject/timeout 仅记录日志；仍保留最多 20 秒 auth 等待和后续 Guardian/WSS health gate。这样 supervisor 不会被一个非必要 CDP ACK 卡死，但也不会绕过真正健康检查。


