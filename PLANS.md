# ChatGPT Passive Exporter ExecPlan

## 目标

构建一个尽量不主动调用 ChatGPT 私有后端 API 的聊天归档工具：监听页面自己已经发出的请求并复制响应，随后将不同年代/不同接口形态的 ChatGPT conversation payload 归一化，再导出可读 Markdown、原始 JSON 和附件/富媒体清单。

## 设计原则

1. **被动捕获优先**：不自行构造 `/backend-api/conversation*` 请求，不读取或保存 Authorization/access token；只复制 ChatGPT 页面自己收到的符合白名单的响应。
2. **捕获与解析解耦**：页面 hook 只负责捕获；adapter 负责 `messages[]` / legacy `mapping` 等 schema；renderer 只面对稳定的 canonical model。
3. **正文与审计分层**：默认 Markdown 只保留 User / Assistant 可见正文；工具调用、Web Search、App Connector、图片组、Widget、reasoning 摘要和文件作为可选附录/manifest。
4. **附件独立处理**：聊天正文里的 `sandbox:/mnt/data/...` 先记录为 manifest；只有用户主动要求“同时下载附件”时才跟随页面自身下载行为获取文件。
5. **复用上游维护**：尽量复用 pionxzh/chatgpt-exporter 的 Markdown/citation/multimodal 渲染思想，但不复用其主动 `fetchConversation` 数据获取层。
6. **跨端共享核心**：WXT 构建 Chrome / Edge / Firefox 扩展；vite-plugin-monkey 构建 Tampermonkey/Violentmonkey/Greasemonkey userscript；两者共用同一 capture/parser/export core。

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

### Phase 4：多端壳
- WXT：Chrome / Edge / Firefox。
- vite-plugin-monkey：userscript。
- 首版 UI 先做轻量导出入口和开关，不依赖 ChatGPT DOM 的复杂结构。

### Phase 5：上游同步与 CI
- 固定记录 `pionxzh/chatgpt-exporter` upstream SHA。
- 周期性 CI 检查 upstream 变化。
- 只同步/比对 exporter、citation、multimodal 相关模块；捕获层永远保持本项目自有。
- CI 跑 Travel fixture 契约测试；通过后自动开 PR，而不是无审查直接合并主分支。

## 验收

- 浏览正常打开某聊天时，扩展可被动获得页面自身返回的 conversation payload；网络面板中不出现由本插件额外发起的 conversation API 请求。
- Travel 复杂 fixture 的默认 Markdown与现有 ChatGPT Exporter 风格结果语义一致。
- Rich manifest 能识别 Web Search、Trip.com、image_group、map widget 和 7 个生成文件链接。
- Chrome/Edge/Firefox 扩展均可构建；userscript 可构建。
- 单元/fixture 测试全部通过。
