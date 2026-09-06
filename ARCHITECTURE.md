# ChatGPT Archive：当前权威架构

> 这份文件只记录当前已经收敛后的产品边界。历史 `PLANS.md` / `PROGRESS.md` 中仍保留早期 Fleet、轮询、WebExtension 等探索过程；若与本文件冲突，以本文件为准。

## 1. 项目真正的主体

项目主体不是浏览器插件，而是本地长期运行的 **ChatGPT Archive**：

- SQLite 是长期 source of truth；
- Browser/Userscript 只是页面侧探针与手动入口；
- Archive daemon 是长期控制平面；
- WSS 是实时事件主通道；
- conversation list / stream_status / body REST 都是按职责使用的补充平面，而不是固定轮询心跳；
- OpenCLI 是可复用的 Browser Bridge / profile / session / tab 生命周期基础设施，同时保留独立的上游 ChatGPT adapter 贡献线，但不承载 Archive Core。

## 2. 四个产品层

```text
ChatGPT Web
   │
   ├─ ① 手动交互层：Userscript
   │      - 当前聊天手动导出
   │      - 导出模式/格式选择
   │      - 阅读/书签等轻量页面功能
   │      - 不承担全局监控与长期同步
   │
   ├─ ② 专用守护页：单一 ChatGPT background tab
   │      - 只保留一个长期页面
   │      - 被动观察官方 WSS
   │      - 捕获页面真实 request context / passive response
   │      - 由 Archive daemon 负责存在性与恢复
   │
   └─ ③ Archive daemon
          - WSS event consumer
          - dirty queue
          - incremental body sync
          - reconciliation
          - watchdog / incidents
          - 配置与控制平面
          - 后续 recovery / send / todo

                    ↓

               ④ SQLite Archive
          canonical tables + raw snapshots
          FTS + assets + incident history
```

普通用户正在浏览的多个 ChatGPT tab **不应该各自运行全局 Fleet/监控**；全局监控由一个专用守护页承担，避免多实例重复 WSS/轮询、额外 CPU 和状态竞争。

## 3. 手动完整导出：多路径、明确 fallback

手动导出与后台增量同步是两个不同需求。

### 3.1 默认优先级

```text
本地 SQLite 已经是最新完整副本
        ↓
直接本地导出（0 请求）

否则页面 passive snapshot 已可证明完整
        ↓
直接 passive 导出（0 额外请求）

否则用户明确要求“完整导出”
        ↓
现代 plural conversations cursor pagination
        ↓
仍失败/兼容性异常
        ↓
legacy singular /conversation/<id> fallback
        ↓
必要时 DOM hydration / cleanup emergency fallback
```

### 3.2 Modern 主路径

跟随当前第一方网页真实分页：

```text
/backend-api/conversations/<id>
  ?include_has_versions=true
  &num_turns=10

page_info.has_previous_page=true
        ↓
/backend-api/conversations/<id>/messages
  ?before=<start_cursor>
  &include_has_versions=true
  &num_turns=10
        ↓
直到 has_previous_page=false
```

不要使用网页正常不会发出的 `num_turns=100/1000` 作为正式主路径。

### 3.3 Legacy fallback 必须保留

`/backend-api/conversation/<id>`（singular）不是主路径，但必须作为**稳定兼容 fallback**保留，不能因为 modern 路径更第一方就删掉。

这条 fallback 的维护策略：

- 尽量直接跟踪 `pionxzh/chatgpt-exporter` 的相关实现与兼容修复；
- citation / multimodal / hidden-tool filtering / continuation merge / renderer 等尽量复用上游维护成果；
- upstream 更新通过 pin + CI 检查 + 测试 + 人工/Agent review 移植；
- 不自动 merge 上游主动请求层，避免把不符合我们策略的网络行为直接带进主线。

CLI/UI 应允许明确选择或自动 fallback，例如：

```text
auto        modern → legacy → DOM
modern      只走 plural cursor pagination
legacy      只走 singular ChatGPT Exporter-compatible 路径
passive     只导出当前已捕获快照，不承诺全量
dom         emergency DOM 导出
```

## 4. 后台同步：WSS-first，不是 list-first

长期正常运行时：

```text
守护页加载
  ↓
吃页面自己产生的首次 conversation list baseline
  ↓
官方 conversations WSS
  ↓
conversation-created / update / turn-complete
  ↓
mark conversation dirty
  ↓
增量 body sync
  ↓
SQLite merge + terminal/incident update
```

### 4.1 Conversation list 的地位

conversation list 是 **reconciliation plane**，不是 heartbeat。

只有这些场景主动翻 list：

- Genesis 首次追平；
- Archive daemon 冷启动，怀疑离线期间漏事件；
- WSS close/reconnect 且 fresh subscribe `recovered=false`；
- offline → online / 长睡眠恢复；
- 本地状态与 WSS/body 明显冲突；
- 用户显式手工 reconcile；
- 可选的数小时级低频兜底。

主动 reconciliation 从最新往旧扫描，以 `conversation_id + update_time + title` 与本地 overlap 决定停止；不能依赖 list payload 的 `total` 作为账号全量总数。

### 4.2 Body 增量规则

WSS 只告诉我们“哪个 conversation 变了”，完整正文仍来自 body API。

dirty conversation：

```text
先拿最新 body page
  ↓
只要当前页存在本地未知 node/message
  ↓
继续按 cursor 往旧翻
  ↓
直到取得一整页全部已知 overlap
或 has_previous_page=false
```

SQLite 只 merge/insert/update；在线分页绝不能因为当前页没出现旧 node 就删除本地历史。

## 5. 监控与事故判定

### 5.1 主信号

```text
WSS turn start / update
        ↓
本地 running 状态

WSS conversation-turn-complete
        ↓
同步最新 body
        ↓
同时完成归档 + terminal/incident 分类
```

body 中可观察：final、interrupted/client_stopped、悬空 tool call、reasoning 状态等。

### 5.2 stream_status

`stream_status` 是 **watchdog / recovery oracle**，不是心跳。

仅在：

- turn 长时间没有 complete；
- WSS gap/reconnect；
- COMPLETE 事件与正文矛盾；
- 本地状态冲突；

时做一次或极少量确认。

watchdog 阈值必须可配置，不能把 30 分钟写死成“超过即异常”。

## 6. Archive daemon 与 OpenCLI 的职责边界

### 6.1 OpenCLI 可以复用什么

OpenCLI Browser Bridge / daemon 已经提供：

- 长期 daemon；
- Chrome profile 连接；
- background adapter window；
- persistent site session；
- tab/session/lease 管理；
- 浏览器自动化与页面恢复基础能力。

因此我们不必再造一整套 Chrome/profile/browser bridge。

### 6.2 OpenCLI 不能直接替代什么

OpenCLI daemon 不是我们的业务 watcher；`persistent siteSession` 表示命令间复用稳定站点 session/tab，并不等于“永久消费某个 ChatGPT WSS，直到用户 stop”。

所以仍需一个很轻的 **ChatGPT Archive daemon/job**：

```text
start
  ↓
确保 OpenCLI Browser Bridge/profile 健康
  ↓
确保专用 ChatGPT 守护页存在
  ↓
长期消费 WSS / dirty queue / SQLite / watchdog
  ↓
守护页消失或 Chrome 恢复后重新建立并 reconcile

stop
  ↓
停止业务 watcher；是否保留 OpenCLI daemon 由 OpenCLI 自己管理
```

OpenCLI 是浏览器基础设施；Archive daemon 是业务控制平面。

## 7. Userscript 与 WebExtension

当前产品不需要把全局同步/监控强绑定在每个页面的 Userscript 上。

Userscript 继续存在，但定位为：

- 手动导出入口；
- 当前页轻量状态/UI；
- 阅读/书签等交互增强；
- 必要的 passive capture 适配。

不要求所有 ChatGPT tab 都监听全局状态。

WebExtension 不是当前主线硬依赖。若未来它在单一守护页、Browser Bridge 或事件转发上有明确优势，再评估；当前优先复用已长期运行的 OpenCLI Browser Bridge，避免维护第二套高权限扩展。

## 8. SQLite 是真正中心

所有长期状态最终写入 SQLite：

- conversation metadata / title history / update watermark；
- mapping nodes / messages / structured parts；
- raw gzip snapshots；
- assets/resources；
- FTS；
- terminal_state / incident_state；
- sync observations / source missing/tombstone；
- 后续 unread / todo / recovery ledger。

网页是数据输入源，不是长期事实源。

## 9. 当前阶段

Phase 0 / 1 已完成：官方两份 ZIP union Genesis，正式库 6155 conversations。

2026-09-06 手工 reconcile 结果：

- 64 个本地全新 conversation；
- 8 个已有 conversation 后续更新；
- 共 72 dirty；
- 最后一个变化在 list 第 72 条；
- 第 73–140 条连续 68 条稳定 overlap 后停止。

下一步 Phase 2 不再继续设计高频 list polling，而是实现：

1. Archive daemon + 单一专用守护页生命周期；
2. 守护页 WSS → daemon 事件通道；
3. dirty queue → modern cursor body incremental merge；
4. body 同步时更新 incident/terminal；
5. 冷启动/WSS gap/低频 fallback reconciliation；
6. 把当前 72 dirty 以该正式链路补进主库；
7. 手动导出 UI/CLI 暴露 `auto/modern/legacy/passive/dom` 获取策略。
