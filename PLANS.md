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

## 验收

- 浏览正常打开某聊天时，扩展可被动获得页面自身返回的 conversation payload；网络面板中不出现由本插件额外发起的 conversation API 请求。
- Travel 复杂 fixture 的默认 Markdown与现有 ChatGPT Exporter 风格结果语义一致。
- Rich manifest 能识别 Web Search、Trip.com、image_group、map widget 和 7 个生成文件链接。
- Chrome/Edge/Firefox 扩展均可构建；userscript 可构建。
- 单元/fixture 测试全部通过。
