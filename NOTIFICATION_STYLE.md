# Bark / 手机通知文案规范

> 最后更新：2026-10-14  
> 适用范围：Archive / DevSpace / Watchdog 等发往 Bark 的手机通知。本文只规定“人看到什么”，不改变内部日志、SQLite、taxonomy 或取证字段。

## 1. 目标：锁屏上一眼就知道“发生了什么、是哪一个会话、最重要结论是什么”

手机通知不是调试面板。内部可以保留完整 `lifecycle / terminal / tail / head / reason / evidence`，但锁屏首先服务于快速扫视，而不是复刻数据库字段。

优先级固定为：

1. **事件主题 / 触发来源**：例如 `Watchdog 诊断`、`工具静默 3 分钟`、`Turn 正常完成`。
2. **会话身份**：尽量直接放进标题，便于一眼知道是哪一个聊天。
3. **最强、最有行动价值的结论**：例如 `Body 尾部缺失`、`已确认 Final`。
4. **只有确实需要时才下沉细节**：完整长标题、短 metadata 别名等。

不要把“字段齐全”误认为“信息清楚”。

## 2. 标题规则

标题使用稳定格式：

```text
<事件主题> · <短会话名>
```

例如：

```text
Watchdog 诊断 · B站 OpenCLI能力需求
工具静默 3 分钟 · ClassFlow 改造
Turn 正常完成 · 医学统计学课堂笔记
```

规则：

- 聊天名最多 **18 个 Unicode 字符**；超出后截断并追加 `…`。
- 完整长标题只在确实需要时放到正文，不让标题横向溢出。
- 不为了品牌重复加没有信息增量的前缀，例如 `ChatGPT Watchdog 诊断` 应写成 `Watchdog 诊断`。
- canonical Conversation title 优先于 `init.title`；两者都没有时，才使用可口述的短别名，例如 `meta/31BvfaYk`。完整 metadata ID 只留日志 / SQLite。
- 原始 CID、完整 metadata ID、request ID 等内部标识默认不进入标题。

## 3. 正文规则

- **默认最多两行。**
- 第一行必须是用户此刻最关心的结论，而不是实现字段名。
- 第二行只在“身份没有完整出现在标题”或“有一个不可缺少的补充事实”时使用。
- 已经通过标题表达的内容不要在正文机械重复。
- 删除长期固定、用户已经知道、没有信息增量的解释性套话。

例如 Watchdog 第二阶段诊断：

```text
标题：Watchdog 诊断 · B站 OpenCLI能力需求
正文：Body 尾部缺失 · DevSpace 审计晚于 canonical
```

或：

```text
标题：Watchdog 诊断 · 某个正常长任务
正文：已确认 Final · 未发现 Body 尾部缺失
```

若标题中的会话名被截断：

```text
标题：Watchdog 诊断 · 这是一个特别特别特别特别…
正文：Body 尾部缺失 · DevSpace 审计晚于 canonical
      会话：这是一个特别特别特别特别特别长的完整聊天标题
```

## 4. 诊断通知：展示“证据结论”，不要展示 taxonomy dump

诊断通知的用户可见优先级：

1. `canonical-tail-gap` → **`Body 尾部缺失 · DevSpace 审计晚于 canonical`**
2. confirmed `final` 且无 tail gap → **`已确认 Final · 未发现 Body 尾部缺失`**
3. 无 final、也无 tail gap → **`未确认 Final · 未发现 Body 尾部缺失`**

内部仍完整保存：

- lifecycle（如 `active-zombie`、`watchdog-timeout`）
- terminal evidence
- tail shape
- head state
- incident reason
- evidence types / evidence details

但这些字段默认不逐项打印到手机通知。用户需要深挖时，再从日志 / SQLite / Archive incident 读取。

`watchdog-timeout` 尤其不能当作 Watchdog 第二阶段的“诊断结论”展示：它只表示硬阈值已经达到、强制诊断发生后仍缺少更具体 lifecycle 证据，是内部 fallback，而不是对根因的解释。

## 5. 身份降级规则

从可读到不可读依次降级：

```text
canonical Conversation title
  > DevSpace init.title
  > meta/XXXXXXXX 短别名
```

完整 metadata ID / CID 保留在持久化层，手机只承担“可识别、可口述、可回查”。

## 6. 设计来源

本规范整理自此前《Bark消息分组方案》中已经确定的规则：重要信息前置到标题、聊天名最多 18 字、超长标题下沉正文、正文最多两行、删除解释性套话；以及《DevSpace功能改造》中补充的 metadata 短别名规则。2026-10-14 进一步增加“诊断按人类关注顺序展示最强证据结论，不按数据库字段顺序罗列”的原则。
