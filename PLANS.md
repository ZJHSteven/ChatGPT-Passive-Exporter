# ChatGPT Passive Exporter ExecPlan

## 目标

构建一个尽量不主动调用 ChatGPT 私有后端 API 的聊天归档工具：监听页面自己已经发出的请求并复制响应，随后将不同年代/不同接口形态的 ChatGPT conversation payload 归一化，再导出可读 Markdown、原始 JSON 和附件/富媒体清单。

## 设计原则

1. **被动捕获优先**：不自行构造 `/backend-api/conversation*` 请求，不读取或保存 Authorization/access token；只复制 ChatGPT 页面自己收到的符合白名单的响应。
2. **捕获与解析解耦**：页面 hook 只负责捕获；adapter 负责 `messages[]` / legacy `mapping` 等 schema；renderer 只面对稳定的 canonical model。
3. **正文与审计分层**：默认 Markdown 只保留 User / Assistant 可见正文；工具调用、Web Search、App Connector、图片组、Widget、reasoning 摘要和文件作为可选附录/manifest。
4. **附件独立处理**：聊天正文里的 `sandbox:/mnt/data/...` 先记录为 manifest；只有用户主动要求“同时下载附件”时才跟随页面自身下载行为获取文件。
5. **复用上游维护**：尽量复用 pionxzh/chatgpt-exporter 的 Markdown/citation/multimodal/UI 维护成果；捕获层维持独立，但允许同时实验“被动捕获”和“观察真实请求头后直接读取后端”两种 transport，用实测稳定性、风控面和维护成本决定默认路径。
6. **跨端共享核心**：WXT 构建 Chrome / Edge / Firefox 扩展；vite-plugin-monkey 构建 Tampermonkey/Violentmonkey/Greasemonkey userscript；两者共用同一 capture/parser/export core。
7. **原生侧栏 UI**：不使用 Shadow DOM；复用/跟随 ChatGPT Exporter 的 sidebar 注入思路，在 ChatGPT 侧栏直接插入导出入口，视觉上跟随页面当前导航项。
8. **本地优先检索**：长期目标不是反复在线抓取，而是把云端 conversation 可靠搬到本地 SQLite/文件仓库，AI/用户的搜索与读取优先走本地索引。

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
- 建立 SQLite conversation/message/resource/index 数据库，并保留原始 snapshot/Markdown/assets。
- “小同步”：根据 conversation id + update_time/watermark + overlap 找新增/更新聊天，只搬变化部分。
- “大同步”：用户手动从 ChatGPT 官方 Data Export 下载 15–20GB 级 ZIP 后，离线解包 `conversations.json`/assets，与本地数据库做 diff/reconcile；官方包作为低频权威基线，不要求自动触发导出。
- 本地全文检索优先 SQLite FTS；后续再决定是否增加 embedding/向量检索。

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
- 桌面只保留一张轻量 `https://chatgpt.com/` 首页作为监控站；低频读取最近更新 conversation 列表，只对新变化和已观察到 `IS_STREAMING` 的少量会话查询 `stream_status`。
- 首次启动只建立基线，不扫描/通知历史故障；只有 `update_time` 新变化或从 `IS_STREAMING`→`COMPLETE` 后才读取最后 1～2 turns 做后验归因。
- 正常 `COMPLETE + final` 静默；明确异常进入持久事件队列并通知。未知 status、429、认证丢失都保持 unknown/error，不猜测。
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
- **历史审计**：正常实时 Fleet 仍只看最近/变化会话，避免高流量；另提供用户显式触发的慢速 audit，分页扫描历史 conversation，并对候选 COMPLETE 会话低速读取最后少量 turns，建立过去的 incomplete/abnormal 事故清单。已有本地 raw archive 优先离线审计。
- **通知与恢复闭环**：明确 abnormal incident → 持久化 → 桌面/手机通知 → 恢复审批。手机通知和长期执行迁到 Companion daemon；页面 Userscript 不保存第三方 push token。
- **Luna 审批门**：无人值守恢复先把事故摘要、最后工具动作、是否可能有副作用、仓库/设备真实状态检查结果交给 PI `openai-codex/gpt-5.6-luna`。只有 Luna 明确判定可安全继续时才发送续跑；写入/删除/安装/上传/git 等副作用状态不明时必须先核验，禁止盲目重复上一工具。
- Reader / iframe lazy load 在上述闭环完成后继续；Reader 仍以“不创建历史 Apps SDK iframe”为目标，但不再抢占当前主线。

## 验收

- 浏览正常打开某聊天时，扩展可被动获得页面自身返回的 conversation payload；网络面板中不出现由本插件额外发起的 conversation API 请求。
- Travel 复杂 fixture 的默认 Markdown与现有 ChatGPT Exporter 风格结果语义一致。
- Rich manifest 能识别 Web Search、Trip.com、image_group、map widget 和 7 个生成文件链接。
- Chrome/Edge/Firefox 扩展均可构建；userscript 可构建。
- 单元/fixture 测试全部通过。
