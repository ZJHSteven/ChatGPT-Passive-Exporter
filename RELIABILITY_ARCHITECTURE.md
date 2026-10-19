# ChatGPT Passive Exporter / Archive 架构契约

> 本项目已经进入“稳定性优先、原则上不再增加新功能”的长期维护阶段。
>
> 这份文档不是愿望清单，而是后续修改的边界：任何新代码都必须先回答它属于哪个子系统、
> 是否会进入常驻热路径、是否会持有 SQLite writer lock、失败时能否影响控制面。

## 1. 项目真正要解决的问题

核心目标只有三件：

1. **可靠捕获 ChatGPT conversation/message**，尽量实时，且不能因为 Watchdog/修复逻辑自身故障而丢失事实。
2. **可靠保存与快速检索 canonical 聊天记录**，供人工回查、LifeOps、未来 Memory/知识处理使用。
3. **保留足够的原始证据**，用于协议漂移、异常同步、事故复盘，但这些冷证据不能拖慢日常热路径。

非目标：

- 不是高并发网站，不需要按“数万 QPS”设计。
- 不是 CPU 密集型计算系统，不以多核利用率为优化目标。
- 不追求把所有诊断、repair、reindex 都压进 100ms；离线全库任务可以慢，但不能阻塞常驻控制面。
- 原则上不再增加新的用户功能。未来工作主要是可靠性、性能、存储瘦身和可维护性。

## 2. 功能面：九个逻辑子系统

### A. Capture Plane：事实采集

职责：

- Guardian / 普通 ChatGPT page 的 CDP Network 被动观察；
- conversations WSS；
- Live SSE journal / canonical accumulator；
- first-party Body / Mapping / Catalog / Project sidebar 的自然响应捕获。

规则：

- 只观察，不因为“想补数据”就无界主动请求。
- 睡眠/冻结 renderer target 不做长超时 attach；醒来后再接管。
- 网络/CDP 等待必须是异步的；不得用同步系统调用等待浏览器或网络。

### B. Control Plane：常驻控制面

职责：

- Guardian/CDP/WSS 健康；
- Watchdog 起点、超时和 lifecycle；
- DevSpace audit cursor / Binding；
- rate-limit / cooldown；
- Bark 通知状态；
- daemon state / Bridge 可用性。

这是最高优先级故障域。任何其它子系统失败都不得把它一起拖死。

### C. Canonical Archive：规范化事实

职责：

- conversations；
- messages；
- mapping_nodes；
- message_parts；
- incident / evidence；
- canonical head/current state。

规则：

- Canonical 是 source of truth；
- 热查询只依赖窄结构化字段；
- 不为了 forensic 方便把巨大 raw payload 永久塞进热 row。

### D. Cold Evidence：冷取证

职责：

- raw Body / Mapping / protocol payload；
- 未来的 message raw evidence；
- 只在事故、协议研究、显式 rebuild 时读取。

当前模型：

- payload 按 SHA-256 内容寻址；
- gzip blob 只保存一次；
- 每一次 observation 独立记录 event；
- SQLite/索引只保存引用和必要 provenance。

### E. Search Index：可重建搜索层

职责：

- 普通 FTS；
- trigram；
- CJK bigram；
- 搜索排序/摘要辅助。

规则：

- Search Index 不是 canonical source of truth；
- 可以删除并从 Canonical 重建；
- 目标是物理独立 search DB，避免 FTS rebuild/写放大污染 Hot Core writer lock。

### F. Reader / Bridge / LifeOps

职责：

- 本机 Archive Bridge；
- Reader/Search API；
- LifeOps 事件同步；
- CLI show/search/stats。

规则：

- 普通 Reader 不读 Cold Evidence；
- 普通 Reader 不触发 repair/reindex；
- 读请求慢于 1 秒属于 bug，不接受“库比较大”作为解释。

### G. Watchdog / Incident / Recovery

职责：

- 长 turn 超时诊断；
- lifecycle 分类；
- browser-memory recovery；
- gap repair；
- durable pending body-sync debt（待完成）。

规则：

- Watchdog 是观测系统，不得自己成为不可信噪声源；
- “没拿到证据”必须显式报告 unknown/deferred，不得猜终态；
- repair 失败不得关闭 Guardian。

### H. Protocol / DOM Drift / Actor

职责：

- 协议指纹、DOM 漂移；
- Actor 提交和状态；
- 相关诊断通知。

这是辅助功能，不得抢占 Canonical/Watchdog 控制面资源。

### I. Offline Maintenance

职责：

- 官方 Data Export 导入；
- full reindex；
- resource rebuild；
- mapping repair；
- compact / 数据迁移；
- 大型审计。

允许总任务 >1 秒，但必须满足：

- 分块；
- 可恢复/可重试；
- 不在 daemon Critical lane 运行；
- 单次 SQLite writer transaction 尽量 <500ms，>1s 必须视为需要修复的实现问题。

## 3. 进程与故障域

### 当前

常驻 Node daemon 仍承载很多 orchestration，但已拆成两条 lane：

- **Critical lane**：Guardian/CDP/WSS/rate-limit/state heartbeat；
- **Maintenance lane**：observer attach、reconcile、diagnosis、dirty/checkpoint drain、gap repair、image hydration 等。

Maintenance 可以等待异步 I/O，但失败不得进入 Critical teardown。

### 目标

默认仍保持简单，不为了“用满多核”拆进程。

只有在完成 SQL/数据布局优化后，若 `DatabaseSync` 仍不可避免地造成控制面 >100ms starvation，
才引入**一个** writer sidecar：

- Main daemon：事件、网络、CDP、Watchdog、Bridge、轻量只读；
- Writer sidecar：Hot Core canonical 写入 + Search/Cold Evidence 调度；
- Offline CLI：import/reindex/compact。

不采用 worker farm / 多 writer。SQLite WAL 仍然只有一个 writer，多进程不能改变这一事实。

## 4. SQLite 契约

### Hot DB 可以包含

- canonical identity / message 热字段；
- mapping/head；
- Watchdog/Binding/incident/runtime 状态；
- 窄索引和 CAS 引用。

### Hot DB 不应包含

- 重复 raw Body BLOB；
- 每次 observation 的完整 payload 副本；
- 可随时重建的巨大搜索私有内容副本；
- 只为协议研究保存的大对象。

### Writer lock

SQLite WAL 允许并发 reader，但同一时刻仍只有一个 writer。

因此：

- “把写入搬进另一个进程”**不会**自动解决锁；
- Main daemon 不能用 `busy_timeout=5000` 同步等另一个 writer 5 秒作为长期方案；
- 目标是单 writer + 短事务；若锁短暂冲突，fail-fast 后异步 retry/pending，而不是阻塞 event loop；
- 任何 >1s writer transaction 都应先找 SQL/算法 bug，不先归因于“数据多”。

## 5. 延迟 SLO

这些是维护目标，不是对外 SLA。

| 路径 | 目标 | 警戒 | 不可接受 |
|---|---:|---:|---:|
| Critical callback / DevSpace wake / Bridge bookkeeping | <50ms | >100ms | >250ms |
| 普通 Hot DB read / Reader page | <100ms | >250ms | >1s |
| no-op canonical Body merge | <100ms | >250ms | >1s |
| 有真实新消息的单页 canonical merge | <500ms | >750ms | >1s |
| 本地 CDP command（健康 renderer） | <100ms | >500ms | >1s |
| Maintenance 单个 DB transaction | <500ms | >750ms | >1s |
| Full import/reindex/compact 总任务 | 可 >1s | 必须分块/可恢复 | 不得长时间独占 writer |

`>1s` 不是“后台所以可以接受”。只有**整个离线任务总时长**可以超过 1 秒；其中每个不可抢占单元仍应短。

## 6. 重试与失败语义

- 网络/CDP：异步 timeout；失败只影响当前 target/请求。
- SQLite transient busy：最终应 fail-fast + pending retry；不得让主 event loop 同步睡满数秒。
- Canonical 写失败：保留 durable debt / queue，不能静默丢失。
- Cold Evidence 写失败：当前实现回退 legacy SQLite evidence，优先保证 ground truth。
- Notification/LifeOps 失败：事实先落本地，发送可重试；通知失败不能回滚 canonical。
- Maintenance 失败：记录 telemetry，下一轮可继续；不得拆 Guardian。

## 7. 数据迁移安全规则

所有大迁移必须使用“小步验证”，禁止 big-bang：

1. 新路径先 shadow/双写或旁路写；
2. 自动测试验证语义；
3. 生产自然样本验证；
4. 新旧 count/hash/query 对账；
5. 停止旧路径新增；
6. 观察一个稳定窗口；
7. 再迁旧数据；
8. 最后删除旧 payload/表并 compact。

“迁移”不能长期变成“复制”。旧数据只有在新路径可靠、可读、可恢复后才删除。

## 8. 后续修改的硬规则

禁止：

- 在 Critical loop 直接 `await` 大型 maintenance；
- 在 daemon 热路径新增 `execFileSync` / `spawnSync` / 大文件同步 I/O；
- 把 full reindex/full scan 放进常驻自动恢复；
- 用增加 `busy_timeout` 掩盖长 writer transaction；
- 因为“以后也许有用”就在 Hot DB 复制一份大 JSON；
- 没有 shadow 对账就直接删旧索引/旧证据；
- 为了多核而增加多 writer / worker farm。

要求：

- 新的 >100ms 同步段必须有 stage telemetry；
- 新 schema/migration 必须 bump schema version；
- 新常驻功能必须明确属于上述某个子系统，并给出失败边界；
- 每次可靠性改动优先做等价、小范围、可回滚修改；
- 完成后必须跑 `npm run check`，生产部署后再看自然样本，而不是只信 fixture。

## 9. 当前已知技术债

1. `messages.raw_json` 仍让 Hot message row 过肥；需要 `raw_hash/evidence_sha` + Cold Evidence rebuild 后迁走。
2. 三套 FTS 仍与 Hot Core 共库；需 shadow search DB 对账后拆出。
3. `DatabaseSync` 主连接仍配置 5s `busy_timeout`；在单 writer / retry 机制完成前不能贸然降低，但它不是长期设计。
4. canonical merge 对长聊天仍读取/触碰过多已知 message；批量读取只是第一步，最终用 raw hash 避免搬运大 raw JSON。
5. daemon orchestration 文件仍约 10k 行；应按上述子系统逐步抽 orchestration module，但不做一次性大重写。
6. WSS complete 后 Body 429 的 pending sync debt 仍需完全 durable 化。

