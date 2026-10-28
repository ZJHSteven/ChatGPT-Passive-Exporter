# RQCI 异步生成任务公共接口（2026-10-28）

## 服务边界

RQCI 是 ChatGPT 生成过程及 Archive 数据的唯一负责人。消费者（例如 ClassFlow）
只应提交任务、检查任务状态、获取最终结果，不应解析 Archive 的消息顺序、
channel、endTurn、finishType，更不能直接轮询 ChatGPT 的私有 REST/SSE。

- `POST /v1/jobs`：用 `idempotencyKey` 持久化任务，返回 HTTP 202 和 Job。
- `GET /v1/jobs?key=<idempotencyKey>`：获取任务状态与完成后的正文。
- `queued` / `submitting` / `retry_waiting`：任务未接收成功。
- `accepted`：ChatGPT 已确认接收，**不代表生成结束**。
- `completed`：消息状态 `finished_successfully` 且 `endTurn=true`；
  RQCI 已将最终回答持久化，返回 `result.text`、`conversationId`、
  `turnExchangeId`、`messageId`、`modelSlug` 和完成时间。
- `failed`：任务提交或最终回复明确失败。
- `tracked=false`：历史版本尚未记录最终答复的旧提交，调用方应按旧版
  兼容流程处理，不应把 `accepted` 解释成完成。

### CLI 示例

```sh
# 生成一个可恢复的稳定业务 key。重复提交同 key 和同文本不会重复调用 ChatGPT。
chatgpt-archive job submit --prompt-file notes.md --key course-20261028-notes --mode new --project 课堂录音笔记
chatgpt-archive job status --key course-20261028-notes
chatgpt-archive job result --key course-20261028-notes
# 人工或脚本确实需要阻塞式等待时才使用 wait（只等待本机公共 Job 状态）。
chatgpt-archive job wait --key course-20261028-notes --timeout-ms 1800000
```

CLI 默认走本机 Bridge `http://127.0.0.1:47832`，从守护进程的授权文件
`data/archive-bridge-auth.local.json` 读取凭据；可通过
`--bridge-url` / `--bridge-auth` 指向其他受信实例。CLI 不读取 Archive
私有消息投影，也不直接请求 ChatGPT。远程系统需部署自己的受保护网络入口。

### 状态持久化与性能

队列在收到模型最终答案时由生产者内部的 `canonical-update` 事件驱动完成标记；
15 秒的仅本机 SQLite 补偿扫描负责重启或事件丢失恢复。这一过程不增加
ChatGPT 请求次数。对外 GET 仅读取已持久化的 Job，不扫描 Archive。
本地队列状态采用原子替换落盘，临时 Windows 文件占用会有限次重试。

## 与 ClassFlow 的集成

ClassFlow 新任务分别使用 Notes、Title、Summary 的稳定业务 key，
每一步只能在上一 Job 的 `completed` 正文经过业务校验后入库和发布。
旧任务继续使用严格终止判定的历史兼容分支，直到全部清理完毕。

## 验证

2026-10-28：340 项 Vitest 全部通过，TypeScript 和 Chrome、Edge、
Firefox、Userscript 构建通过；守护进程平滑重启恢复；
远端 N1 通过 Cloudflare Access 读取公共 Job 成功。

真实事故回归：20:02:44 的 `final/in_progress` 正文只有
`## 通知与` 六个字符，必须保持 pending；20:03:01 的
`finished_successfully/endTurn=true` 消息包含 1263 字符，才允许完成。
