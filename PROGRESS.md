# 项目状态快照

## 当前结论
- 现状：新项目已创建于 `D:\Workspace\ChatGPT-Passive-Exporter`，Git 主分支已初始化。
- 已确认：`Travel/三峡` 中的《旅游插件与平台比较》原始捕获是 2026-08 ChatGPT Web 的有序 `messages[]` 格式，共 129 条消息，且分页标记显示该次捕获完整。
- 已确认：该样本包含 Web Search、Trip.com App Connector、image_group、map widget、reasoning/commentary/final、sandbox 文件链接，适合作为复杂兼容性 fixture。
- 已确认：现有 Travel Markdown 兼容器默认行为合理——只输出可见 User/Assistant 正文并合并 assistant continuation；工具/富媒体应改为可选附录，而不是默认污染正文。
- 已确认：pionxzh/chatgpt-exporter 的当前源码仍以主动读取 legacy `/backend-api/conversation/:id` + `mapping` 为核心；其 Markdown/citation/multimodal 渲染逻辑值得复用，但抓取层不符合本项目“被动旁路”目标。
- 已确认：扩展端不采用 `chrome.debugger`；按 WXT 官方建议，以 isolated content script 在 `document_start` 注入 MAIN-world unlisted script，从页面原生 `fetch`/XHR 复制白名单响应。
- 正在做：搭建共享 capture/parser/export core、WXT 扩展壳、vite-plugin-monkey userscript 壳与 fixture contract tests。
- 下一步：完成首版构建与测试，并加入 upstream 变更检查/CI 设计。

## 关键决策与理由
- 决策：页面 hook 永远不读取请求 headers/cookies/access token。（原因：被动导出只需要响应正文，减少敏感信息面和维护风险。）
- 决策：将 `messages[]` 和 legacy `mapping` 先归一化为 canonical model，再渲染 Markdown。（原因：后端 schema 变化时只维护 adapter。）
- 决策：App Connector 卡片、图片轮播、地图 Widget、工具轨迹进入 rich manifest/可选附录。（原因：Markdown 正文应保持 ChatGPT Exporter 风格可读性，同时不丢审计信息。）
- 决策：上游 ChatGPT Exporter 采用“检查/同步 + fixture 测试 + PR”而非自动覆盖。（原因：上游仍主动请求旧 API，不能无条件合并。）

## 常见坑 / 复现方法
- 新式 plural conversation 路由可返回 `messages[]`，而旧 ChatGPT Exporter 类型仍假定 `mapping`；两者不能直接共用提取层。
- `webRequest` 普通扩展 API不能直接给出任意响应 body；`chrome.debugger` 虽可做到但权限过重，因此使用 page-world `fetch`/XHR clone 更合适。
- `sandbox:/mnt/data/...` 在历史 UI 中可能渲染为文件卡片/按钮；正文链接识别和真实附件下载必须分成两个步骤。
