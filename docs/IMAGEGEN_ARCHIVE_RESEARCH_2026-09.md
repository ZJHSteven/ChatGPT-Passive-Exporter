# ChatGPT ImageGen 归档协议研究记录（2026-09）

> 目的：记录 ChatGPT-RQCLR / ChatGPT-Passive-Exporter 对图片生成节点、图片资源定位、下载、落盘和 incident 分类的完整研究证据链。本文区分“已被真实样本证实”“由当前生产前端 bundle 证实”“仅有工程推断/尚待 E2E”的不同置信等级，避免把私有后端接口误当成稳定公开 API。

## 1. 结论摘要

当前可以高置信确认：

1. ChatGPT ImageGen 的最终产物并不要求出现普通 `assistant final`。真实 conversation body 中，图片结果可以是：
   - `role=tool`
   - `channel=final`
   - `content_type=multimodal_text`
   - `parts[]` 内包含一个或多个 `image_asset_pointer`
   - pointer 形如 `sediment://file_...`
   - message metadata 可见 `notification_channel_id=image_gen`
2. `sediment://file_*` 是适合作为归档身份的稳定锚点；`/backend-api/estuary/content?...&sig=...&ts=...` 是短期下载能力，不适合作为永久身份。
3. 当前生产 ChatGPT Web bundle 明确实现了如下 resolver：

   ```text
   sediment://file_xxx
       ↓ 去掉 scheme
   file_xxx
       ↓ Request.safeGet('/files/download/{file_id}')
   { status?, download_url }
       ↓
   signed /backend-api/estuary/content?id=file_xxx&...&sig=...
       ↓
   image bytes
   ```

4. 但 `/files/download/{file_id}` 是 **ChatGPT Web 当前使用的私有后端接口，不是公开稳定 API**。我们已经证明接口存在于当前 bundle，但 Archive 自己的 active replay 尚未完成一次无 429 干扰的生产 E2E。因此主动 resolver 目前必须视为实验性能力。
5. 默认策略应是 **passive-first**：
   - 页面自然请求图片时，被动截获它已经收到的响应；
   - DOM 中已经有 signed URL 时，可以机会式复用；
   - 主动 resolver 默认关闭，只有显式 `--allow-active-image-resolver` 才启用。

## 2. 置信等级定义

本文使用以下四级：

| 等级 | 含义 |
| --- | --- |
| A | 多个真实生产样本直接验证，数据可复核 |
| B | 当前生产前端 bundle 明确实现，且部分 live 行为已验证 |
| C | 工程推断合理，但关键 E2E 尚未成功跑通 |
| D | 假设/待研究，不应进入默认生产路径 |

当前各环节评级：

| 环节 | 评级 | 说明 |
| --- | --- | --- |
| ImageGen message 结构 | A | 真实漫画会话 body 多个样本 |
| `sediment://file_*` 作为 stable identity | A | body、DOM、下载结果可一一对应 |
| signed estuary URL 为短期下载地址 | A | DOM 真实 URL + 页面 fetch 成功 |
| `/files/download/{file_id}` resolver 存在 | B | 当前生产 bundle 明确代码路径 |
| resolver 需要标准 Request auth context | B | 普通 `fetch(credentials)` live 实验为 403 |
| Archive 主动 resolver 可稳定长期运行 | C | 代码已实现，但 production E2E 被 429 阻断 |
| 该私有 endpoint 长期兼容性 | D | 没有公开兼容承诺，必须做漂移检测 |

## 3. 429：这次究竟发生了什么

### 3.1 本轮最早明确的 429 来自主动作参数探针

原始报告：

`data/protocol-probes/2026-09-26T18-52-14-954Z.json`

探针配置：

- `gapMs = 6000`
- 严格串行
- 收到第一条 429 后立即停止
- 使用 Guardian 正常第一方请求的 header 形状，仅在内存复用，不持久化认证值

本次报告实际只完成了两条请求：

1. `list-expand-omitted`
   - `GET /backend-api/conversations?hide_snorlax=false&is_archived=false&is_starred=false&limit=20&order=updated&offset=0`
   - HTTP 200
2. `list-expand-true`
   - `GET /backend-api/conversations?expand=true&hide_snorlax=false&is_archived=false&is_starred=false&limit=20&order=updated&offset=0`
   - HTTP 429

因此，这一轮不能说“Guardian 正常页面自己首先制造了 429”。更准确的时间线是：

```text
02:52 左右（UTC+8）
受控主动参数探针：第 1 个请求 200
        ↓ 约 6 秒
受控主动参数探针：第 2 个请求 429
        ↓ 约 1 分钟
02:53 daemon 启动
        ↓
Guardian 正常 sidebar/TPP native catalog 仍得到 429
        ↓
daemon 检测到限流窗口仍在，进入 1h cooldown
```

后面的 Guardian 429 更适合解释为“服务端限流窗口尚未恢复”，而不是“它证明 Guardian 本身就是本轮限流的起因”。

### 3.2 为什么两条、相隔 6 秒也可能 429

这不能简单推出“服务端限制就是 1 次/6 秒”或“`expand=true` 参数有问题”。429 可能取决于：

- 之前数分钟/数十分钟累计请求；
- 同账户其它 ChatGPT tabs 的 native list/body；
- Guardian 自身页面请求；
- Archive 的历史主动 replay；
- 滚动窗口 / token bucket；
- endpoint 分类、query shape、账号状态或服务端动态策略。

所以这次实验只能证明一件重要的工程事实：**主动参数矩阵扫描本身有真实限流风险，不能做 CI、定时探针或后台常驻协议枚举。**

### 3.3 历史上 429 也不是单一来源

`PROGRESS.md` 已有更早现场记录：

- 普通 ChatGPT 页面自然 sidebar/list 曾出现 429；
- Guardian 的 TPP list 曾出现 429；
- 页面自然 body burst 也出现过 200/429 混合；
- daemon 主动补历史 body 也曾再次触发 429。

因此我们现在把 429 视为 **账户/会话级请求预算的一种外显信号**，而不是绑定到某一条固定 API 的简单 QPS 限制。

## 4. ImageGen 研究路径

下面按实际实验顺序记录。

### 实验 A：先看 conversation body，不猜 UI

目标：确定“图片生成后，conversation 持久化层到底长什么样”。

样本：`《漫画分镜设计》`，conversation：

`6ab3d7db-3f04-83e9-bad2-8abd105c3898`

结果：真实 body 中出现 `role=tool + channel=final + multimodal_text`，`parts[]` 可有多张 `image_asset_pointer`。

典型字段：

```text
asset_pointer = sediment://file_...
mime_type     = image/png
size_bytes    = ...
width/height  = ...
generation.gen_id = ...
metadata.notification_channel_id = image_gen
```

结论：

- 图片生成成功不能用“有没有 assistant final”判定；
- 原 incident 分类器把它误判为 `reasoning-ended-no-final / complete-no-final`；
- stable pointer、尺寸和 generation metadata 已足够建立结构化资产索引。

置信等级：**A**。

### 实验 B：观察正常网页实际显示图片时的 URL

目标：`sediment://file_*` 本身不是 HTTP URL，正常页面怎么把它变成图片？

观察到 DOM `<img src>` 最终为类似：

```text
/backend-api/estuary/content
  ?id=file_...
  &ts=...
  &p=fs
  &cid=1
  &sig=...
  &v=0
```

其中长期有意义的是 `id=file_*`；`sig/ts` 明显属于短期能力。

结论：不能把 signed URL 当数据库主键或永久下载地址。

置信等级：**A**。

### 实验 C：验证“拿到 signed URL 后”到底怎样才能正确下载

真实漫画任务里选取 4 张图片进行下载实验。

已验证正确完整 PNG 字节数：

| file id | 实际字节数 |
| --- | ---: |
| `file_000000009cfc8210bf6a7a3c5d1acaf0` | 2,172,878 |
| `file_00000000683481f5ac121aa3061256ad` | 2,298,054 |
| `file_0000000080fc81f5b7dc89b230b65e5d` | 2,247,734 |
| `file_00000000914481fd8f9946cb8684f351` | 2,386,978 |

实验分支：

1. shell 直接请求短期 URL：曾落到 39 B 内容，不能作为可靠下载方式；当时不能仅凭该结果区分是签名/认证/下载管理器/时效哪一层失败。
2. 浏览器下载管理器链路：同样出现过 39 B 文件，不适合作为归档器底层。
3. **已登录 ChatGPT 页面上下文 `fetch(img.src, {credentials:'include'})`**：可以得到正确 Blob；4 张图片实际字节数和 conversation body `size_bytes` 一致。

结论：

- signed URL 本身有效；
- “让现有登录 renderer 自己 fetch”比把 URL 丢给 shell/download manager 更可靠；
- 归档器需要做字节数/MIME/hash 校验，不能只看 HTTP 200 或文件存在。

置信等级：**A**。

### 实验 D：第一版自动化——只扫 DOM

实现：每隔 30 秒扫描 pending ImageGen，若该 conversation 已经在普通 ChatGPT tab 打开，则读取 DOM 中已经存在的 signed estuary URL，再让页面 fetch。

优点：非常保守，不生成新的 resolver 请求。

真实结果：`hydrateSuccesses=0`，全库 14 张 generated-image 仍 pending；其中漫画会话实际为 9 张。

原因：长会话虚拟化 / off-head 分支意味着：

- conversation 已打开 ≠ 历史图片节点仍在 DOM；
- 即使从顶部滚到尾部，也不保证旧分支图片会重新挂载；
- 当前 `performance.getEntriesByType('resource')` 也可能已经没有老 estuary 请求。

结论：纯 DOM opportunistic hydration 不够完整。

置信等级：**A**。

### 实验 E：增加真正 passive 的 Network 捕获

实现：复用普通 ChatGPT tab 的 CDP `Network.responseReceived/loadingFinished` observer。

当页面自己自然请求：

```text
/backend-api/estuary/content?id=file_...
```

Archive：

1. 只提取 stable `file_id`，不保存 signed URL；
2. 先查 SQLite，确认它确实是已知 pending `generated-image`；
3. `Network.getResponseBody` 读取浏览器**已经收到**的字节；
4. 校验预期 size/MIME；
5. 独立文件落盘，SQLite 只保存 local path / SHA-256 / actual size。

这条路径不会主动请求图片，也不会把普通用户上传图片因为 URL 长得类似就随便收进来。

局限：若历史/off-head 图片永远不再被页面自然渲染，Network observer 也永远没有机会捕获。

置信等级：实现机制 **A**；对于“能否覆盖所有历史图片”答案明确为 **不能**。

### 实验 F：离线分析当前 ChatGPT Web bundle，寻找真正 resolver

为避免猜 API，使用隐藏 Guardian 正常加载页面，仅记录它自然加载的 `/cdn/assets/*.js` 静态 bundle URL；随后公开静态 CDN 文件离线下载到 `.tmp/bundles-all/` 搜索。

关键 bundle：

```text
.tmp/bundles-all/109686.cd293bd41c.js
SHA-256 = FA6611C6E75B1EE50A6E5DE228A1AC3AC4DDD2023C42BD2CFE90E76B256312D3
```

其中图片资源模块明确实现：

```text
file-service://... / sediment://...
        ↓
strip scheme → file_id
        ↓
resolveAsset(file_id)
        ↓ 默认 resolver
safeGet('/files/download/{file_id}')
        ↓
解析 status + download_url
        ↓
fetch(download_url, headers?)
```

注意：这是**当前生产前端自己的实现证据**，比我们凭网络行为猜 endpoint 强很多；但它仍不是公开 API 契约。

置信等级：**B（对当前 build 很强，对未来兼容性没有保证）**。

### 实验 G：普通 renderer fetch resolver，验证 Cookie 是否足够

请求：

```text
GET /backend-api/files/download/{file_id}
credentials: include
```

结果：HTTP **403**。

这和 bundle 的 `Request.safeGet(...)` 差异说明：正常前端 Request 层还会附带应用层认证/客户端上下文，不能把 resolver 简化成“只带浏览器 Cookie 的 GET”。

结论：

- 不应该用 shell 手工保存 token/cookie；
- daemon 若主动 resolver，只能复用已经从第一方正常 backend 请求中**内存捕获**的允许列表 header；
- auth 失效返回 401/403 时必须立即停主动请求。

置信等级：**B**。

### 实验 H：实现 active resolver fallback，但尚未完成 production E2E

当前代码已实现：

1. 被动 Network/DOM 优先；
2. 只有长期 pending 才考虑 active resolver；
3. 每个 hydration 周期最多 1 张；
4. 使用统一 active request gap / jitter / 429 cooldown；
5. resolver 响应只接受：
   - HTTPS；
   - `chatgpt.com` 或其子域；
   - `/backend-api/estuary/content`；
   - URL 中 `id` 必须和原 stable `file_id` 完全一致；
6. signed URL 不落库、不写日志；
7. 图片 bytes 再校验 body 中的期望 size 和 MIME，最终计算 SHA-256。

但是：第一次准备做 production E2E 时，账户请求窗口已经因前述主动参数探针处于 429 cooldown；daemon 正确保持：

```text
activeResolverAttempts = 0
```

所以**不能把“代码通过测试”写成“active resolver 已被真实生产下载验证”**。

置信等级：**C**。

## 5. 当前设计：哪些默认开，哪些默认关

### 默认开启

1. ImageGen message / manifest / SQLite metadata 识别；
2. `image-generation-final` terminal classification；
3. 图片节点 Bark warning（与 error incident 分层）；
4. 普通 ChatGPT 页面自然 estuary response 的 passive capture；
5. 已在 DOM 中存在 signed URL 时的 opportunistic page fetch；
6. size/MIME/SHA-256 校验；
7. 图片二进制 SQLite 外部落盘。

### 默认关闭

主动 `/backend-api/files/download/{file_id}` resolver。

只有显式：

```text
chatgpt-archive daemon start --allow-active-image-resolver
```

才允许 active resolver。

原因不是认为 endpoint 是假的，而是：

- 它是当前私有 Web API；
- 当前证据证明“前端在用”，但还没有 Archive active replay 的完整 production E2E；
- 我们已经刚刚看到主动协议探针可以撞 429；
- 默认 daemon 应优先保证归档主链稳定，不应该为了补历史图片扩大主动私有 API 面。

## 6. “这个后端 API 靠不靠谱”应怎样理解

这里需要拆成两个问题。

### 6.1 当前协议真实性：高

`/files/download/{file_id}` 不是我们从 404/猜名字撞出来的。它由当前生产 ChatGPT Web bundle 明确调用，因此“**当前网页存在这条 resolver 协议**”的可信度很高。

### 6.2 长期稳定性：未知/低保证

它是私有 API，没有公开版本/兼容承诺。因此可能随前端发布发生：

- endpoint 改名；
- path parameter 变 query/body；
- `status/download_url` schema 改变；
- Target-Path/Target-Route 或 auth headers 改变；
- signed URL 域名/路径迁移；
- 新增一次性 nonce；
- 请求预算调整。

所以“真实”不等于“稳定”。

## 7. 风险模型

### 风险 1：协议漂移

后果：403/404/schema mismatch，通常是功能失效，不应导致数据损坏。

防护：

- 默认 active resolver off；
- signed URL 严格 shape 校验；
- resolver payload 不符合预期就停止，不猜；
- protocol fingerprint / drift watcher 只被动学习正常页面请求形状。

### 风险 2：429 / 请求预算

后果：影响正常 ChatGPT 网页，甚至造成持续 cooldown。

防护：

- passive-first；
- active resolver 每周期最多 1 张；
- 与 conversation REST 共用全局间隔和 jitter；
- 任一 429 立即 1h cooldown；
- cooldown 时 Guardian conversation REST 也预先 block，但 WSS 不受影响；
- 主动参数矩阵 probe 禁止进入 CI/定时任务，必须显式 opt-in。

### 风险 3：下载错图 / pointer 错配

后果：归档文件与 message 错配，是最危险的数据完整性问题。

防护：

- stable identity 永远使用 conversation body 的 `sediment://file_*`；
- resolver URL 的 `id` 必须和该 stable file id 相同；
- expected size 必须匹配；
- MIME 必须是 image；
- 最终落盘计算 SHA-256；
- signed URL 绝不作为主键。

### 风险 4：认证信息泄漏

防护：

- 不把 Authorization/Cookie 写 SQLite；
- 不把它们写协议报告；
- 只在 daemon 内存中复用第一方请求允许列表；
- signed URL 的 `sig/ts` 不落日志/库。

## 8. Active resolver 何时才可以考虑默认开启

至少完成以下验收：

1. cooldown 完全结束，普通页面访问稳定；
2. 只选 1 张已知 pending generated-image；
3. Archive resolver 请求真实 200；
4. payload `download_url` 通过所有 shape/file-id 校验；
5. 图片实际字节数与 conversation body `size_bytes` 完全一致；
6. MIME 正确且可解码；
7. SHA-256 落盘后再次读取一致；
8. 再在另一个 conversation / 一个多图 message 上各复验一次；
9. 整个过程不出现 429，不干扰正常网页；
10. 模拟 resolver 401/403/404/429/schema drift 时均 fail-closed。

在这些条件满足之前，主动 resolver 保持 opt-in。

## 9. Incident 分类为什么也必须一起改

图片下载不是独立的小功能。最初“漏洞”的另一半就是 terminal classification：

```text
reasoning/tool work
  ↓
ImageGen tool final
  ↓
可能还有 reasoning_recap
```

旧分类器只承认普通 assistant final，于是一个成功生图 turn 会被错误看成“reasoning 结束但没 final”。

现在：

- ImageGen tool final 继续提供 `terminalEvidence=final`；
- 另加 `tailShape=image-generation-final`；
- 正常生图不制造 error incident；
- 仍可发独立“图片节点” warning，告诉用户本轮已经转进生图；
- 一条 message 多图只提醒一次。

这样“图片节点”和“真正异常终止”不会混在一个错误桶里。

## 10. 证据索引

### 代码/设计

- `scripts/chatgpt-archive-daemon.mjs`
- `src/local/archive-db.ts`
- `src/core/image-assets.ts`
- `tests/archive-daemon.test.ts`
- `tests/archive-db.test.ts`
- `PLANS.md`
- `PROGRESS.md`

### 真实协议参数探针

- `data/protocol-probes/2026-09-26T18-52-14-954Z.json`

### 漫画会话实验材料

- `.tmp/manga-conversation.json`
- `D:/Workspace/AnimeComicSubmission2026/source/`

### 当前生产前端 bundle 取证

- `.tmp/bundles-all/109686.cd293bd41c.js`
- SHA-256：`FA6611C6E75B1EE50A6E5DE228A1AC3AC4DDD2023C42BD2CFE90E76B256312D3`

> `.tmp` 仅是研究现场缓存，不应作为长期唯一证据。真正需要长期复现的协议事实已经写入本文和测试；若后续 bundle hash 改变，应重新做被动取证，而不是继续假定旧私有 API 永久有效。

## 11. 当前状态

- ImageGen 结构化归档：完成。
- ImageGen incident 误报修复：完成。
- passive estuary response capture：完成。
- DOM opportunistic hydration：完成，但覆盖不完整是已知事实。
- active resolver：实现完成，**默认关闭 / 实验性**。
- active resolver production E2E：待 429 cooldown 后单张受控验证。

