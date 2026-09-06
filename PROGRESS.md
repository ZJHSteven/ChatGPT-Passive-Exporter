# 项目状态快照

## 当前版本
- 当前 Userscript：`0.5.2`，Tampermonkey 显示名为 `ChatGPT Companion`；更新文件名仍沿用 `chatgpt-passive-exporter.user.js`，避免破坏既有更新链。
- 当前项目路径：`D:\Workspace\ChatGPT-Passive-Exporter`。
- 当前浏览器实测基线：脚本安装在 `D:\AppData\Chrome\Chrome-CDP\User Data\Default` 这套独立 CDP profile；普通 `C:\Users\ZJHSteven\AppData\Local\Google\Chrome\User Data\Default` 虽也装有 Tampermonkey，但未发现 Companion userscript 数据。
- UI：入口已移到个人账户按钮正上方；主面板按“导出当前聊天 / 运行监控 / 设置”组织，工程诊断收进二级页。支持复制文字、PNG、Markdown、HTML、JSON、批量 ZIP。0.4.2 的运行监控直接列出运行中 / 异常 / 疑似会话标题并可点击进入，不再只显示计数。
- 性能：0.4.1 移除全 document subtree 的 sidebar MutationObserver，改为 1.5 秒低频自检 + 仅监听 tiny rail 模式属性。
- 回归：TypeScript 通过；Vitest 9 files / 37 tests 全通过；0.5.0 全端构建已通过；0.5.2 Userscript 构建通过。

## 2026-09-03 架构重构主线
- 项目终局已从“浏览器导出插件”调整为 **本地 ChatGPT Archive Core + SQLite + 增量同步 + WSS-first 监控 + 原生 CLI**；浏览器 Userscript/Extension 后续瘦身为 capture probe / operator UI。
- OpenCLI 地位调整：不作为本项目主 CLI 或数据库依赖；仅保留薄 adapter、浏览器生命周期/登录复用候选，以及未来把通用 ChatGPT adapter 改进贡献上游。
- 增量完整性规则已敲定：conversation list 必须翻到与本地可靠 overlap 才停止；conversation body 必须补到 node/message overlap 才停止。云端缺失对象只记来源消失/tombstone，不自动删除本地历史。
- `stream_status` 后续只做 watchdog/recovery oracle；正常 `turn-complete` 触发最新 body 增量同步，并由同一次 body 写库顺便更新终止/异常状态。
- 2026-09-06 用户侧 CLI 正式命名为 **ChatGPT Archive**，可执行命令 `chatgpt-archive`；原 `scripts/archive-cli.mjs` 已改名为 `scripts/chatgpt-archive.mjs`，OpenCLI 私有 adapter 跟随新入口，旧 `npm run archive` 仅保留兼容。
- 当前主线进入增量同步：先实现 conversation list 的 overlap discovery，再实现 conversation body 的 node/message overlap；WSS 只做 dirty/complete 实时触发，完整性仍由 overlap reconciliation 兜底。

## 官方 Data Export Ground Truth（2026-09-03）
- 已找回并验证两份本地官方 ZIP：旧包 `D:\Archive\ChatGPT-exports\ChatGPT-export-2026-07-02.zip`（2.593 GiB），新包位于 `D:\Downloads\ChatGPTExport\...2026-09-01...zip`（2.905 GiB）。
- 旧包 5644 conversations / 90082 mapping nodes；新包 6153 / 109409。
- 共同 5642；新包独有 511；**旧包独有 2**。因此新版官方导出不是旧版严格超集，官方 Data Export 是时间点快照而不是 append-only 历史账本。
- 共同 conversation：旧 mapping nodes 丢失 0、旧 message IDs 丢失 0、mapping 缩短 0；3 个旧聊天发生后续增长。
- 共同消息字符串 text parts 变化 0；但 1095 个 `content` 对象和 1003 个 message metadata 出现结构化变化，说明规范化 current state 与 raw snapshot history 都需要保留。
- Asset manifest 3313 → 3486；旧包有 9 个 asset 在新包中消失，且按 ZIP size+CRC 无同内容改名副本。Genesis 数据库应合并多份 ZIP，而不是只导入最新一份。
- Genesis/Archive Core 已于 2026-09-06 完成并验收；当前主线切换到 conversation-list overlap + body overlap 的在线增量同步。
- 已开始落地 Archive DB v2 schema：新增 `archive_sources / conversation_snapshots / mapping_nodes / message_parts / archive_assets / asset_snapshots / source_documents / schema_field_stats / message_fts_all`，并为 conversation/message 增加模型、终止状态、request/turn、source observation、raw content/metadata 等列。官方 mapping 导入路径按所有 branch node 做 union/upsert，不再先删 conversation；每个 conversation 同时保存 gzip raw snapshot。
- 已增加官方 ZIP 流式 importer：使用现有 `fflate` 逐 entry 读取，仅解压 JSON，不落地/重复解压数 GB `.dat`；`import-official` 支持多 ZIP 按导出时间从旧到新 Genesis merge，并新增 `sources/schema` CLI 供来源与字段覆盖率审计。
- 第一轮真实 Genesis 性能验收在约 900 conversations 时主动停止：功能正常、进程内存约 245MB，但逐 conversation 重建三套 FTS 明显过慢。已把 FTS 改为全部 ZIP merge 完后一次性顺序重建，避免 O(N×FTS-maintenance)；准备重新跑两份真实大包。
- 第二轮真实 Genesis 已完成结构化 union：6155 conversations / 109415 mapping nodes / 103260 messages / 11797 raw snapshots / 3495 assets，且精确标出 2 个旧 conversation 与 9 个旧 asset `source_missing`。随后发现“所有 tool/reasoning 文本做 trigram FTS”会把 Node 工作集推到约 3GB；已将该审计索引改为 `reindex --all` 显式 opt-in，默认 Genesis 只构建日常找聊天所需的可读 User/Assistant FTS，raw/tool 数据仍完整保留。
- 2026-09-06 Phase 1 收尾复核：默认正文 FTS 已确认完整建成，56890 条可读 User/Assistant message 同时进入 unicode61 与 trigram 索引；真实检索“三峡 / DevSpace / WSS”均命中历史 conversation。最新官方 source 的 schema audit 已完成，确认 conversation/node/message 主结构稳定，metadata 中还存在 attachments、content_references、search_result_groups、serialization_metadata、tool_icons、branching/targeted reply 等丰富字段，继续采用“常用字段列式化 + metadata/raw JSON 无损保留”。
- Genesis 的 `resources` 派生目录已补齐设计：官方 ZIP 在所有 source union 完成后，从 `messages.raw_json` 统一重建 Web Search / image-group / widget / sandbox / asset-pointer 等目录并回填 `resource_count`；事实源仍是 raw JSON/snapshot，resources 可随 parser 升级随时重建。
- 正式资源重建结果：10549 条，其中 Web Search 6790、asset pointer 2824、image group 628、sandbox file 277、widget 30。
- 数据一致性最终验收：`PRAGMA quick_check=ok`、foreign key errors=0、duplicate messages=0、orphan messages=0、orphan mapping nodes=0。官方 ZIP union 的 message role 为 assistant 81017 / user 22243；content type 为 text 46419 / thoughts 44081 / reasoning_recap 9931 / multimodal_text 2829。两份官方大包未提供可用的 finish_details/reasoning_status，因此异常历史不能仅靠官方 Data Export 回填。
- 正式主库已切换为 `data/chatgpt-archive.sqlite`（约 3.35GB，6155 conversations）；原 6MB prototype 无删除，保留为 `data/chatgpt-archive-prototype-20260902.sqlite`。默认 CLI 已实测直接从正式主库检索成功。
- 体积审计：当前约 3.35GB 主要由 messages（约 1.34GB）、两套正文 FTS（合计约 0.98GB）、gzip conversation snapshots（约 0.33GB）、resources（约 0.20GB）和 message_parts（约 0.17GB）构成。message/raw 与 FTS 尚有进一步去重空间，但不阻塞增量同步主线；后续可单独做 storage compaction migration。

## 已落地能力
- Passive Export：只复制 ChatGPT 页面自身已经收到的 conversation `fetch`/XHR 响应，不额外请求 conversation 正文；兼容新 `messages[]` 与 legacy `mapping`。
- 导出：Markdown、安全 archive JSON、rich manifest；识别 Web Search、App Connector、image_group、widget、sandbox 文件引用。
- Run Watch：当前页面 iframe/Apps SDK widget、JS heap、Long Tasks、页面生命周期、网络生命周期取证；不保存 Authorization/cookie/tool payload 正文。
- Widget Pressure：可从原始 conversation 统计 `chatgpt_sdk` / DevSpace widget 密度，和实时 iframe 数交叉判断“设计性累积 vs remount 泄漏”。
- Fleet Watch：只需一张轻量 ChatGPT 首页即可观察手机/其它端启动的最近 conversation；无需为每个长聊天开标签。
- Fleet 多标签页互斥：`0.3.7` 使用 Web Locks 做跨 tab leader election；同一浏览器 profile 只有 1 张 ChatGPT 首页会主动轮询，其它首页为 `waiting`，leader 关闭后自动接棒。
- 本地归档：Node 24 `node:sqlite` + FTS5/trigram + 中文短词 LIKE fallback；真实 Travel 样本已导入验证。
- OpenCLI：已安装 `archive-import / archive-list / archive-search / archive-read / archive-sync` 薄 adapter，统一调用项目实现。
- Upstream Watch：跟踪 ChatGPT Exporter、chatgpt-sync、chatgpt-source-watch；CI 检测变化并跑测试/构建后开审查 PR，不自动 merge。

## Chrome 长会话性能取证（2026-08-31）
- 目标会话 `6a8ed5ab-4574-83eb-a626-a35eb773a651` 在 Chromium 中稳定会恢复约 220–227 个 iframe；Companion 禁用时同样如此，因此 iframe 数量不是插件制造的。
- 同一 CDP Chrome、同一账号、同一会话、同一完成条件（iframe ≥220 且正文稳定）A/B：Companion 0.4.0 开启约 `33.45s`，禁用约 `33.10s`，总加载时差约 1%，页面主体卡顿来自 ChatGPT/DevSpace hydration。
- 但 0.4.0 确实有自身性能浪费：CPU profiler 20,355 个采样中，1,072 个采样的调用栈包含 Companion，inclusive CPU 约 `5.27%`；其中 1,004 个归因到 sidebar `isUsableSidebarElement → getBoundingClientRect`。
- 0.4.1 移除全树 sidebar MutationObserver 后，同一 profiler 复测：Companion inclusive CPU `82 / 21,510 = 0.381%`，约降低 14 倍；sidebar 可见性路径降到 59 个采样。
- 因此当前结论是“双重成立”：ChatGPT/DevSpace 的数百 iframe 是三十秒级卡顿主因；Companion 0.4.0 的 observer 是额外约 5% 主线程浪费，0.4.1 已修复到接近噪声水平。
- 稳态交互对照：`核查模型说法可信度` 实测约 250 iframe / 249 DevSpace sandbox / 1.5–2.0GB JS heap / 481 SDK widget（单轮峰值 189）；`配置 iframe 显示模式` 约 25 iframe / 131–138MB JS heap。25ms 心跳测试中，轻页 5s 跑满 200 tick、最大延迟 13ms；重页 6.6s 只执行 3 tick，分别延迟约 2.60s / 2.02s / 1.92s，直接解释拖选文字、滚动和输入焦点的秒级卡顿。

## 运行状态判据（2026-08-30 实测）
- `stream_status` 是服务端 endpoint，不依赖 Stop button/手机 UI/当前 conversation DOM。
- conversation list 还提供独立字段 `async_status`。
- 最近 100 条真实 conversation 普查：`null=93`、`4=6`、`3=1`；唯一 `3` 是当时真正运行中的会话。
- 7 条非 null conversation 逐条交叉：`3 + IS_STREAMING` 为 1/1；`4 + COMPLETE` 为 6/6。
- 抓到自然迁移样本：`音频压缩与存储方案` 从 `async_status=3 + IS_STREAMING` 自然变成 `async_status=4 + COMPLETE`，随后最后 2 turns 存在正常 final、无 interrupted。
- 历史“工具实际执行但 tool result/stream 回传丢失”快照：`async_status=null`，最后持久化节点停在 `assistant → api_tool.call_tool`，无 final、无后续 tool result。
- 历史 `client_stopped` 样本曾现场观察到：服务器 `COMPLETE`，payload 明确 `finish_details.type=interrupted / reason=client_stopped`。

### 当前安全判定
- `3/5 + IS_STREAMING`：服务器一致报告“进行中”。这不是“模型一定还在计算”的数学证明；若 `update_time` 长时间不变，只发 `suspected-stall`，绝不自动续跑。
- `4/null + COMPLETE`：服务器一致报告“终止候选”；等待约 3 秒再次得到 `COMPLETE` 后，才读取最后少量 turns 做后验归因。
- 二次 COMPLETE + final：正常结束。
- 二次 COMPLETE + explicit interrupted/client_stopped：确认异常。
- 二次 COMPLETE + open tool/reasoning tail：确认服务器已结束但持久化收尾异常。
- 401/403/429/fetch reject/JSON 失败/missing status/两信号冲突：统一 `UNKNOWN`，下轮重试，不报警、不自动恢复。
- 超过 26–27 分钟、Stop button、长时间无可见文本都只能是弱信号；不能单独判死。

## 主动 vs 被动网络边界
### 被动
- conversation 正文捕获：被动。`Response.clone()`/XHR 副本，不额外发正文请求。
- 页面性能、iframe、Long Task、UI 取证：本地观察，不产生 ChatGPT API 流量。

### 主动
Fleet Watch 为了监控“手机发起、桌面没有打开”的其它 conversation，必须主动发只读 GET：
1. conversation list；
2. 少量 `stream_status`；
3. 仅在确认终止后读取最后约 2 turns。

`0.5.1/0.5.2` 在原有单 leader 基础上收紧主动流量，并把节奏做成用户可配置：
- 同一 profile 只有 1 个 Fleet leader。
- 0.5.1 紧急默认曾从 60 秒降到 5 分钟；0.5.2 改为设置项，默认 2 分钟，可选 30 秒 / 1 / 2 / 5 / 10 分钟，并在当前 leader 上即时生效。
- list query 固定复用当前 ChatGPT sidebar 实测的一等请求形状：`offset=0&limit=28&order=updated&is_archived=false&is_starred=false`，再本地 slice。
- 新发现 async 进行态时可查一次 `stream_status`；健康 steady-state streaming 默认只在 async/update 变化或疑似卡住时复核。用户可选每 1 / 2 / 5 / 10 分钟周期复核，或保持“仅状态变化时”。
- 每轮最多 status 默认 2 条，可配置 1 / 2 / 4 / 8 条。
- `async_status`/`update_time` 变化时立即复核；终止时额外二次 COMPLETE + 尾部约 2 turns。
- 任意 Companion 主动请求若真实收到 HTTP 429，会在 `chatgpt.com` localStorage 写入跨标签共享 circuit breaker；默认冷却 60 分钟，可配置 15 / 30 / 60 / 120 分钟。退避期间所有 Fleet/历史审计/主动补取请求直接本地拒绝。
- 历史审计默认 5s/条、50 条，可配置 1 / 2 / 5 / 10 秒/条和 25 / 50 / 100 / 200 条；任意一步命中 429 立即停止审计。
- 设置页还提供 Fleet 总开关；关闭后不启动 discovery / stream_status 主动监控。

### 2026-09-02 限流现场取证
- 用户报告 ChatGPT 多页面出现“请求次数过多 / 暂时无法看到对话内容”类错误后，优先检查 Companion 是否仍在主动打私有 API。
- 现场 Chrome 当时没有 `https://chatgpt.com/` 空白首页，唯一 ChatGPT conversation tab 的 `fleetRole=unsupported`，因此 Fleet 当时并未运行。
- Fleet 持久状态 `lastPollAt=2026-09-01 17:46:03Z`；用户本次报告约在 2026-09-02 03:51Z，说明当前异常发生时 Fleet 已停约 10 小时。
- 在当前 conversation tab 连续 70 秒抓 CDP Network：没有观察到 4xx/429，也没有 Companion conversation 主动请求；截至当前**尚未抓到一条真实 HTTP 429**，因此用户可见“请求次数过多”不能直接等同成“已证实 429”。
- 切回前台时 ChatGPT 自己的一次 `/backend-api/conversations` 返回 HTTP 200，但耗时约 27 秒。
- 后续在一张全新轻量 ChatGPT 首页、Companion 主动 API 仍处于退避状态时被动抓包：ChatGPT 官方自然发出两条列表请求（第二条带 `hide_snorlax=true`），均 HTTP 200、各 28 条 conversation；JSON 约 21.6 KB，HTTP/2 encoded 约 4.3 KB；耗时约 0.76s / 1.37s。说明 27 秒不是列表数据量导致，而是当时的异常等待；当前列表访问已恢复到正常量级。
- 同一页面 Run Watch 在 Fleet 已停数小时后仍记录到页面自身约每分钟一次 `TypeError: Failed to fetch`，说明当前网络/服务异常不能归因于“Fleet 仍在持续轮询”。
- 后续被动失败监听期间未再次复现 `Network.loadingFailed`；因此之前每分钟 `Failed to fetch` 目前只能定性为暂态页面/网络故障，尚未定位具体 endpoint。
- 结论：没有证据证明本次用户可见限流就是 Fleet 直接造成；旧的 60s list + 350ms 历史审计策略仍然过于激进，因此已收紧并加入可配置策略与真实 429 circuit breaker。

## 请求头对照
- Fleet 不自己保存固定 token；只从 ChatGPT 页面真实 backend 请求中临时捕获允许列表，驻留闭包内存。
- 当前允许列表：Authorization、OAI session/device/client version/build/language、`X-OAI-IS-Client-Observation`。
- 每个主动请求按 endpoint 重写 `X-OpenAI-Target-Path/Route`。
- Cookies 由浏览器通过 `credentials: include` 正常携带；User-Agent/Referer/sec-ch-* 由浏览器自身生成。
- 实测 ChatGPT 正常 sidebar `/backend-api/conversations` 与 Fleet 请求的 header 名集合一致。
- 风险仍不能宣称为零：服务器可观察请求频率、访问多个 conversation id 的模式和 query 时序；因此当前策略是“减少不必要请求、单 leader、只读、低频交叉确认”，而不是声称完全不可区分。

## 已确认的坑
- Chrome profile 是完全独立的安装边界：当前机器磁盘上同时存在普通 Chrome `C:\Users\ZJHSteven\AppData\Local\Google\Chrome\User Data\Default` 与 CDP Chrome `D:\AppData\Chrome\Chrome-CDP\User Data\Default`。两边 Tampermonkey 扩展本体互不共享 userscript 数据；当前 Companion 只安装在 CDP profile。
- 0.3.7 以前 Tampermonkey 仍显示 `ChatGPT Passive Exporter`，虽然 Run Watch/Fleet 已合并其中，容易让人误以为监控脚本没有安装；0.3.8 已改名 `ChatGPT Companion`。
- Tampermonkey 更新后，已经打开的老 ChatGPT tab 可能继续运行旧 userscript，必须 reload/新开页面才能加载新版本。
- Chrome 151 的“允许运行用户脚本”总开关可能关闭；Tampermonkey 显示已安装不代表实际注入成功。
- ChatGPT tiny sidebar rail 只有约 52px；宽文本 item 会被 overflow 裁掉，因此紧凑模式必须使用 36×36 图标按钮。
- ChatGPT 展开 sidebar 时不会删除 tiny rail，而是把它设为 `inert / pointer-events:none / opacity:0`；所有 sidebar template/anchor 选择必须检查完整祖先链的真实可交互性，不能使用裸 `querySelector()`。0.3.9 加入可见性过滤；0.4.1 又移除了为 SPA 重挂载而监听整棵 document subtree 的 observer，避免 hydration 期间反复触发布局读取。
- page-world 包装 `window.fetch` 会让 DevTools initiator stack 顶层显示 userscript；服务器不会看到 DevTools initiator stack，但页面 JS 理论上可检测 fetch 被包装。
- CDP 多 target/iframe 时调试 session 可能串到其它 page；曾误读到 Owlbear HTML，故所有诊断必须校验 origin/content-type，不能把调试控制面错误当 ChatGPT 状态。
- 多张旧版 ChatGPT 首页会各自运行 Fleet；0.3.7 已用 Web Locks 修复，但旧 tab 必须 reload 或关闭。

## 下一阶段
- 积累真实 `IS_STREAMING` 僵尸/断流样本，验证是否存在“服务器永远卡 running”的 failure mode；在此之前不默认全自动续跑。
- 将 Fleet 轮询最终迁到本地 Companion daemon，浏览器页只提供短期登录/auth context，避免 background timer throttling / Memory Saver / 页面 crash。
- iPhone push 由 Companion daemon 转发；不把 push token 放进 Userscript。
- 继续做本地轻量 Reader：历史 DevSpace tool/widget 默认静态折叠渲染，不创建真实 Apps SDK iframe。
- 开发期模块继续分离；最终合并为单一 ChatGPT Companion runtime，Exporter / Run Watch / Fleet / Reader / Bookmark / Notification 共享状态与网络层。
