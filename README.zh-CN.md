# pi-deepseek-balance

**[English](./README.md)** | 简体中文

> **非官方项目。** 与 DeepSeek 无关联。数据来自官方文档化的
> [`GET /user/balance`](https://api-docs.deepseek.com/api/get-user-balance)
> 端点。DeepSeek 没有提供 token 用量或消费历史的 API（社区请求自 2026-06
> 起悬而未决）；余额之外的数字均为本地推导，并明确标注为估算。

在 [pi coding agent](https://github.com/earendil-works/pi-mono) 底部状态栏显示
DeepSeek API 账户余额，提供低余额提醒、账户级消耗速率和 `/deepseek-balance` 报告。

pi 自带的状态栏已按目录价格显示会话成本的美元估算。本扩展显示的是另一个数字：
真实的 CNY 账户余额及其消耗快慢。两者回答不同的问题。

```
DS ¥377.89 ≈ 9.0h
```

## 用法

### 状态栏

活动模型的供应商为 `deepseek` 时显示；切换到其他供应商即清除。

| 元素 | 含义 |
| --- | --- |
| `¥377.89` | 所选货币行的总余额，按可用时长或阈值着色 |
| `≈ 9.0h` | 有了消耗速率后追加的预计可用时长（按当前速度估算） |
| `~` | 显示值为过期数据：上次刷新失败，保留旧值 |
| 颜色 | 有速率时按可用时长（红 < 2 小时，黄 < 12 小时）；此前按绝对阈值（默认 ¥20 / ¥5，可通过 `PI_DEEPSEEK_BALANCE_THRESHOLDS` 配置） |

**货币行选择**不取第一行：零余额的 USD 行不会遮蔽正余额的 CNY 行（其他工具中出现过这个解析 bug）。顺序：`PI_DEEPSEEK_BALANCE_CURRENCY` → 首个正数 CNY 行
→ 首个正数行 → 存在 CNY 则取 CNY。

### 消耗速率与可用时长

每次成功获取后，扩展把 `{时间, 币种, 总额}` 快照追加到
`~/.pi/agent/pi-deepseek-balance-snapshots.jsonl`（文件达到 1000 行时压缩为最新的
500 条，不会无限增长）。速率只在置信门控之后显示：
至少 3 个快照、跨度至少 1 小时、同一币种、且位于最近一次充值之后。未达门控时
不显示任何内容。该速率为账户级——包含共享此 key 的所有客户端的消耗，不只本
pi 会话。充值会重置窗口而不是产生负速率。有了速率之后，状态栏会追加按当前
速度的预计可用时长（如 `≈ 9.0h`）。

### 阈值提醒

```
DeepSeek 余额偏低：¥15.42
```

向下越限时提醒一次；充值后重新武装。默认 ¥20 警告、¥5 告急——这是对
典型 CNY 消耗速度的猜测，故标注为默认值。用 `PI_DEEPSEEK_BALANCE_THRESHOLDS="20,5"`
覆盖（`0,0` 关闭；某一档为 0 即完全关闭该档，余额到 0 也不提醒）。状态栏
金额颜色使用同一组阈值，作用于选中的货币行——未达速率门槛时，两者用同一套
数字，不可能不一致。一旦有了消耗速率，颜色改为按可用时长（速率推导），
提醒仍用绝对阈值；这是有意为之：颜色回答“还能用多久”，提醒回答“是否低于
我配置的保底金额”。

### `/deepseek-balance`

覆盖层显示全部货币行、赠送/充值拆分（赠送余额先扣）、消耗速率及其窗口、
快照数。报告超出窗口高度时可滚动：标题固定，正文用 ↑/↓、PgUp/PgDn、
Home/End 滚动，状态行显示位置——即使 `--json` 长载荷也不会被截断。
按 Enter、Esc 或 Ctrl+C 关闭。`/deepseek-balance --json` 输出原始数据
（仅 TUI 与 print 模式）。

### 刷新行为

激活时与执行 `/deepseek-balance` 时获取；每轮对话后至多每 5 分钟一次。
429/5xx 遵循 `Retry-After` 退避——该死线是绝对的，强制刷新也不能缩短。
凭据被拒两轮后熔断。`pi -p` 无头模式不发任何请求。

## 安装

npm（会被 [pi 包目录](https://pi.dev/packages) 收录）：

```bash
pi install npm:pi-deepseek-balance
```

或从 git 安装：

```bash
pi install git:github.com/frederick-wang/pi-deepseek-balance
```

## 密钥配置

解析顺序：环境变量 `DEEPSEEK_API_KEY`，然后是 `~/.pi/agent/auth.json`
（或 `$PI_CODING_AGENT_DIR/auth.json`）中的 `deepseek` 条目。

## 界面语言

状态栏为语言中立的符号。提醒、报告与错误指引遵循 `PI_DEEPSEEK_BALANCE_LANG`
（`zh` 或 `en`）；未设置时读取进程 locale——用户显式设置的中文 locale 视为需要
中文；再否则为英文。`--json` 的输出字段固定为英文。

## 相关包

[`@hk_net/pi-usage-bars`](https://pi.dev/packages/@hk_net/pi-usage-bars) 覆盖
八个供应商的余额显示（含 DeepSeek）；本包在单一供应商上做得更深：CNY 正确的
货币行选择、持久化快照、消耗速率、余额提醒、赠送/充值拆分。
[`@alexanderfortin/pi-deepseek-usage`](https://www.npmjs.com/package/@alexanderfortin/pi-deepseek-usage)
同样显示余额状态栏。

## 隐私

不采集任何数据。API key 只在本地读取，仅用于请求
`api.deepseek.com/user/balance`。余额快照保存在本地 pi 配置目录。

## 限制

- 消耗速率为账户级，无法把消耗归属到本会话。
- DeepSeek 是连续扣减余额还是按账单批次扣减未经验证；短窗口速率可能在
  批次落地前读作零。
- Node 内置 `fetch` 不读取 `HTTPS_PROXY` 代理设置。pi 本身能通过代理正常
  使用时，本扩展的请求仍走直连，状态栏因此可能一直显示过期数据。

## 开发

本仓库使用 pnpm（版本见 `package.json` 的 `packageManager` 字段）。本地开发
需要 Node ≥ 23.6；CI 使用 Node 24。

```bash
pnpm install
pnpm run typecheck
pnpm test
pnpm run live-check  # 读取本机密钥并请求一次真实余额
```

## 许可

MIT 许可证，全文见 [LICENSE](./LICENSE)。
