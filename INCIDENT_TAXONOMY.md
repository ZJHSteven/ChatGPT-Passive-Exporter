# ChatGPT Archive Incident Taxonomy

> 最后更新：2026-09-25  
> 本文只描述 Archive 已有真实样本支持的分类。名称分为“正式持久化字段”和“取证/研究标签”；后者不能冒充 lifecycle class。

## 1. 为什么必须分轴

一次异常可以同时满足：

```text
lifecycle = complete-no-final
tail = tool-call-open
head = behind-same-turn
execution/persistence = ghost-execution
ui = hidden-canonical-tail
```

这些描述回答的是不同问题，不能被压成一个互斥枚举：

1. **Lifecycle：为什么这一轮算事故？**
2. **Tail shape：conversation body 最后持久化到哪一步？**
3. **Head relation：current_node 与 plural messages[] 是否一致？**
4. **Execution / persistence：工具执行链与 conversation 持久化链是否同步？**
5. **UI visibility：服务器/Archive 中存在的 canonical 内容是否被前端正确显示？**

## 2. 正式 Lifecycle Classes

这些值进入 `incidents.lifecycle_class`。

| Lifecycle class | 状态 | 定义 | 典型证据 |
|---|---|---|---|
| `complete-no-final` | 正式 | 已有 WSS complete、catalog active→complete 或历史后续 turn 等结束证据，但该 turn 没有正常 final | `conversation-turn-complete + no final` |
| `watchdog-timeout` | 正式 | 已有可靠 start，超过 watchdog 阈值仍未观察到 complete；这是“超时即立案并调查”，不是自动宣判根因 | actor/WSS/async-progress start → timeout |
| `active-zombie` | **2026-09-25 新正式类型** | 没有可靠 start 时，catalog 首次看到 `async_status=3/5` 作为保守 late-start；超过 watchdog 阈值仍 active，body 也没有 final/明确终止 | catalog active 长期不收口 |
| `explicit-interrupted` | 正式 | body 明确出现 `client_stopped` / `interrupted` | `finish_details` 等显式终止信息 |
| `abnormal-terminal` | 正式兼容桶 | 旧迁移或尚未细分的异常终态；新代码应优先落到更具体 lifecycle | legacy / fallback |

### 2.1 `active-zombie` 与 `watchdog-timeout` 的区别

两者都表示“运行时间异常长”，但证据等级不同：

- `watchdog-timeout` 的计时起点来自较可靠的 turn start；
- `active-zombie` 的计时起点只是 **第一次观察到 catalog active**，真实 POST 必然更早。

因此 catalog late-start 只会让报警**更晚**，不会因为“把扫描时刻当发送时刻”导致提前 35 分钟误报。

如果 body 后来明确 final / interrupted，late-start active 会被清理，不建立 zombie incident。

## 3. Tail Shape：不是根因

这些值进入 `incidents.tail_shape` / RunDiagnostic：

- `final`
- `image-generation-final`
- `tool-call-open`
- `tool-result-returned`
- `reasoning-open`
- `reasoning-ended-no-final`
- `context-only-no-output`
- `other`

它们只回答“持久化最后停在哪”，不能单独证明 turn 已死。例如 `tool-call-open` 在一个仍正常运行的长工具任务里完全可能出现；只有叠加 lifecycle 结束/超时证据后才能形成事故解释。

## 4. Head / Messages 一致性：正式结构维度

`RunDiagnostic.headState` 当前正式支持：

- `aligned`
- `behind-same-turn`
- `behind-other-turn`
- `current-node-missing`
- `unknown`

并额外持久化：

- `head_rollback`
- `off_head_same_turn_count`

### 4.1 divergence 不等于 rollback

如果 plural `messages[]` 已经出现更晚的同 turn 节点，而 `current_node` 仍停在旧节点，只能叫 **head/messages divergence**。

只有真实 head history 观察到类似：

```text
A → B → A
```

才允许标记 `headRollbackObserved=true`。不能因为刷新后少了几步就倒推出 rollback。

## 5. Execution / Persistence 取证维度

### `ghost-execution / persistence-stall`

**已由真实样本确认，但目前不是 lifecycle enum。**

定义：

```text
conversation body/update_time 停止推进
        但
模型 / MCP / DevSpace 工具继续实际执行
        且
Git / 文件 / SSH 等 side effect 继续发生
```

这说明 execution plane 与 conversation persistence plane 脱钩。

它可以与 `complete-no-final` 同时存在；例如《迁移刷机方案》的异常 turn 既有 WSS complete/no-final，又有 body 停滞后 DevSpace 继续执行的证据。

当前状态：**正式文档化、审计可证，但尚无独立数据库列。** 后续更适合作为 forensic flag，而不是再造一个互斥 lifecycle class。

### `persistence-gap`

表示浏览器/工具现场存在真实消息或执行证据，但 canonical archive/body 缺一段。它是数据完整性问题，可通过只增量 recovery 处理；同样不应自动当作 lifecycle 根因。

## 6. UI-only 取证维度

这些异常不能污染服务器 lifecycle ledger。

### `ui-hidden-canonical-tail`

服务器/Archive 已经保存 canonical tail，`current_node` 也可以正常指向它，但 ChatGPT 前端 error state 把真实尾巴隐藏，并显示“消息发送超时，请重试”等合成占位。

### `ui-virtualizer-blank-view`

canonical conversation 与 final 都正常，但前端 virtualizer/renderer 把消息树排到异常坐标或不产生正常 message DOM，视觉上像“聊天空了”。

### UI length-cap / send-timeout placeholder

前端生成的“达到长度上限”“消息发送超时”等 error card 即使带 `data-message-id`，也不能自动写进 canonical messages；必须先证明服务器 body 中存在该 message。

## 7. Discovery / Coverage 状态

### `no-complete / no-final` blind spot

这是**监控覆盖缺口**，不是根因类：

```text
没有观察到 WSS complete
没有可靠 start
没有 final
```

旧实现中 watchdog 因没有 start 而完全不起表。2026-09-25 起，若后续 reconciliation 至少能看到 catalog active，就由 `active-zombie` late-start watchdog 兜住；若连 catalog active 都没有观察到，仍属于 discovery blind spot，需要 Phase 3 early signal / actor / StreamHub 或 DevSpace metadata binding 补齐。

### DevSpace `openai/session`

DevSpace audit metadata 是 execution plane 的稳定匿名键，通常在首次 DevSpace 工具调用后出现，可能比低频 catalog reconciliation 快很多。但它必须先可靠绑定到 canonical conversation UUID，才能安全作为 watchdog start；目前保留为 supplementary discovery，不强行接入。

## 8. 真实样本索引

| 日期 | Conversation / 聊天 | 主要现象 | 当前归类 |
|---|---|---|---|
| 2026-09-20 | `6aae9979-dec8-83ea-a6b4-956e57cbd7f1`《自动化课程下载平台》 | 最后工具已结束约 10 小时，catalog 仍 `async_status=3`；UI 长期 Stop，后来变 timeout | `active-zombie` 原始 Ground Truth |
| 2026-09-21 | `6aace9f9-bc30-83ea-89d7-eb34002caa10`《迁移刷机方案》 | WSS complete/no-final；body 停住后 DevSpace 仍继续数分钟 | `complete-no-final` + `ghost-execution`；tail 分别含 `tool-call-open` / `context-only-no-output` |
| 2026-09-21 | `6ab0eeb8-fc9c-83ea-ac21-ddf0b39e9d3b`《异常类型对比分析》 | messages 比 current_node 更靠后；后续又出现长期 active | head/messages divergence；另有 active-zombie 样本 |
| 2026-09-22 | `6ab15cc0-f730-83ea-8e28-6472dbe176ab`《隐藏节点异常分析》 | canonical 有 491 节点，UI 只显示 user + timeout error | `ui-hidden-canonical-tail` |
| 2026-09-24 | `6ab3d7db-3f04-83e9-bad2-8abd105c3898`《漫画分镜设计》 | 没有观察到 complete/start，Bark 不触发；另有整页 virtualizer 空白 | `no-complete/no-final` discovery blind spot + `ui-virtualizer-blank-view` |
| 2026-09-25 | `6ab63c6c-02f4-83ea-a535-d849e3962d8f` FrameForge AI 智能体赛道 | Web body 200 且约 1.7 MB；旧 `/f/conversation/resume` 404；catalog active；Archive 未落 body；旧执行已停但 UI/服务状态未收口 | 当前 `active-zombie` + Archive discovery/sync gap 样本 |

## 9. 当前自动化覆盖矩阵

| 现象 | 自动发现 | SQLite 正式字段 | 手机通知 |
|---|---:|---:|---:|
| WSS complete + no final | 是 | `complete-no-final` | 是 |
| 可靠 start 超时 | 是 | `watchdog-timeout` | 是 |
| catalog late-start 长期 active | **是（2026-09-25 新增）** | **`active-zombie`** | **是** |
| explicit interrupted/client_stopped | 是 | `explicit-interrupted` | 是 |
| tail subtype | 随 body 诊断 | `tail_shape` | 仅随 lifecycle 事故解释 |
| head/messages divergence | 随 body 诊断 | `head_state/off_head*` | 不单独报警 |
| confirmed head rollback | 有 head history 时 | `head_rollback` | 不单独报警 |
| ghost-execution / persistence-stall | 人工/审计侧可证 | 暂无独立列 | 否 |
| UI hidden / virtualizer blank | 目前主要靠 CDP 取证 | 不进 lifecycle | 否 |
| 完全无 start、无 complete、也无 catalog active | 否 | 历史补账可能发现 | 否；仍是 Phase 3 缺口 |

