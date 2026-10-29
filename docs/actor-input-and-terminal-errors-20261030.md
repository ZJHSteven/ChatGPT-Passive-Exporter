# Archive Actor 长文本输入与终止错误契约（2026-10-30）

## 本次生产事故与根因

原任务键：`classflow:debate:2026-10-29:postmatch-allpoints-v1`，Job ID `2e34d639-6c5a-4de9-8dab-a8444ab6b350`。CRM 持久化原文 **40,301** 字符，其中 CRLF 的 `\r` 为 342 个；浏览器规范化成 LF 后应为 **39,959** 字符。ChatGPT canonical user message 实际为 **119,877** 字符，已逐字验证为规范化输入连续重复 **3 遍**。后台 Guardian 的 `Ctrl+A → Backspace` 获得 CDP ACK 不代表 ProseMirror 真正清空；前 20 次输入重试发生 `CDP Input.insertText timeout after 10000ms`，第 21 次网络 POST 被接收，却因重复内容被后端拒绝。

原始 `/f/conversation` SSE（HTTP 200）明确包含：

```json
{"conversation_id":"6ae37538-a4d0-83ea-a2f8-33d4a8d543f1","error_code":"input_too_large","error_reason":"last_user_message","error":"你提交的消息过长，请编辑后重新发送。"}
```

当前前端页面加载的 127 个 JS bundle 中，`7078.6cca9159bc.js` 有 `input_too_large` 与 `last_user_message/context_window` 的错误映射，`767086.25089e447c.js` 有错误码列表。没有发现经过验证的固定字符数阈值；本次证据可确认**服务端 SSE 拒绝、前端识别展示**，不能推出“全部长度校验仅发生在后端”或任意固定上限。

## Actor 核心输入流程（不允许上层应用旁路）

所有 ClassFlow/CLI/Bridge 发送都应复用 `sendActorPrompt`，而不是 ClassFlow 自行操作 CDP：

1. 在真正的 React/ProseMirror composer 内通过 DOM Selection 全选原内容；`Input.insertText` 首块覆盖（不直接修改 DOM 的 value/textContent）。
2. 默认每 **512 个 Unicode 字符**一块（CLI `actor send --input-chunk-chars N`，64–2048），每块前重新定位光标到编辑器文档末尾，严格等待 CDP ACK；失败指出分块序号及 offset。
3. 正式 POST **之前**读取 composer 的真实文本，规范化 CRLF→LF 后与原始输入逐字符相等才允许点击发送；任何长度/内容/顺序不符立即 fail-closed，不触发网络 POST。
4. CDP 输入分块只是浏览器操作优化，**并非**拆成多条 ChatGPT 用户消息；对真正超过服务端限额的任务仍须另行开发安全的多条消息/第一方附件路线。

后台独立测试页（没有点击发送）：39,829 字符、78 个块、9.16 秒，完整文本逐字符相等；这验证输入路径，不意味着所有长度都被服务端允许。

## 对外 Job API 与 CLI 的失败契约

`GET /v1/jobs?key=...` 的 `status` 为 `failed` 时：

```json
{
  "status": "failed",
  "result": null,
  "error": "你提交的消息过长，请编辑后重新发送。",
  "errorCode": "input_too_large",
  "errorReason": "last_user_message"
}
```

`chatgpt-archive job result --key ...` 与 `job wait` 在失败时非零退出并直接报告 `RQCI job failed [input_too_large/last_user_message]: ...`；ClassFlow 不读取 Archive 内部 SSE 文件或浏览器状态。

错误事件可能先于 Actor 的 `accepted` 回调，因此先将脱敏的错误证据持久化，随后必须以会话、turn、提交时间窗口和完整用户 prompt **精确关联**，再将 `completion.status` 设为 `failed`。为恢复本次历史事故，错误归属**仅针对失败**容许同一规范化原文连续重复 2、3、4 次；成功完成条件绝不放宽。重启时可从最近 48 小时、有界大小的本机 SSE 证据安全恢复，**不会再次发送用户消息**。

## 实测与遗留项

- 生产历史任务已从 `accepted` 转成 `failed`，两个结构化错误字段与服务端原文一致；CLI `job result` 实际退出码为 1。
- `npm run check` 最终为 **34 个测试文件、344 项测试全部通过**，TypeScript 及 Chrome/Edge/Firefox/Userscript 构建通过。
- 尚未使用新代码完成正式的短消息 POST E2E 或长期重试稳定性取样；不应宣称零超时。
- 未获得可信固定上限，不能凭单次报错定死“最大字符数”，更不能要求上层业务猜上限。对超过服务端可接受限制的输入应由公共控制面提供结构化拒绝与未来的安全分条/附件方案。
