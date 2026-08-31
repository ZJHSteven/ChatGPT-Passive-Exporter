# 项目状态快照

## 当前版本
- 当前 Userscript：`0.3.8`，Tampermonkey 显示名正式改为 `ChatGPT Companion`；更新文件名仍沿用 `chatgpt-passive-exporter.user.js`，避免破坏既有更新链。
- 当前项目路径：`D:\Workspace\ChatGPT-Passive-Exporter`。
- 当前浏览器实测基线：脚本安装在 `D:\AppData\Chrome\Chrome-CDP\User Data\Default` 这套独立 CDP profile；普通 `C:\Users\ZJHSteven\AppData\Local\Google\Chrome\User Data\Default` 虽也装有 Tampermonkey，但未发现 Companion userscript 数据。
- UI：ChatGPT sidebar 顶部为 36×36 Companion 入口；0.3.8 将容易误认成“下载”的箭头改为圆形 `C` 标识，展开 sidebar 显示 `ChatGPT Companion`。
- 回归：TypeScript 通过；Vitest 6 files / 25 tests 全通过；Userscript 构建通过。

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

`0.3.7` 已做流量收敛：
- 同一 profile 只有 1 个 Fleet leader。
- 默认 conversation list 约每 60 秒 1 次。
- list query 固定复用当前 ChatGPT sidebar 实测的一等请求形状：`offset=0&limit=28&order=updated&is_archived=false&is_starred=false`，再本地 slice。
- 新发现 async 进行态时查一次 `stream_status`；steady-state streaming 默认约 10 分钟才交叉复核一次，而不是每分钟对每条 active conversation 查询。
- `async_status`/`update_time` 变化时立即复核；终止时额外二次 COMPLETE + 尾部约 2 turns。

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
- page-world 包装 `window.fetch` 会让 DevTools initiator stack 顶层显示 userscript；服务器不会看到 DevTools initiator stack，但页面 JS 理论上可检测 fetch 被包装。
- CDP 多 target/iframe 时调试 session 可能串到其它 page；曾误读到 Owlbear HTML，故所有诊断必须校验 origin/content-type，不能把调试控制面错误当 ChatGPT 状态。
- 多张旧版 ChatGPT 首页会各自运行 Fleet；0.3.7 已用 Web Locks 修复，但旧 tab 必须 reload 或关闭。

## 下一阶段
- 积累真实 `IS_STREAMING` 僵尸/断流样本，验证是否存在“服务器永远卡 running”的 failure mode；在此之前不默认全自动续跑。
- 将 Fleet 轮询最终迁到本地 Companion daemon，浏览器页只提供短期登录/auth context，避免 background timer throttling / Memory Saver / 页面 crash。
- iPhone push 由 Companion daemon 转发；不把 push token 放进 Userscript。
- 继续做本地轻量 Reader：历史 DevSpace tool/widget 默认静态折叠渲染，不创建真实 Apps SDK iframe。
- 开发期模块继续分离；最终合并为单一 ChatGPT Companion runtime，Exporter / Run Watch / Fleet / Reader / Bookmark / Notification 共享状态与网络层。
