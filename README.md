# pi-deepseek-balance

English | [简体中文](./README.zh-CN.md)

> **Unofficial.** Not affiliated with DeepSeek. Reads the documented
> [`GET /user/balance`](https://api-docs.deepseek.com/api/get-user-balance)
> endpoint. DeepSeek provides no token-usage or spend-history API (a community
> request has been open since 2026-06); everything beyond the raw balance is
> derived client-side and labeled as such.

DeepSeek API account balance in the
[pi coding agent](https://github.com/earendil-works/pi-mono) footer, with
low-balance alerts, an account-wide burn rate, and a `/deepseek-balance`
report.

pi's own footer already shows an estimated session cost in USD from catalog
prices. This extension shows a different number: the actual CNY account
balance and how fast it is draining. The two answer different questions.

```
DS ¥377.89 ≈ 9.0h
```

## Usage

### Footer

Appears when the active model's provider is `deepseek`; cleared on switching
to any other provider.

| Element | Meaning |
| --- | --- |
| `¥377.89` | selected currency row's total balance, role-colored by runway or thresholds |
| `≈ 9.0h` | estimated runway at the current burn rate, appended once a rate exists |
| `~` | the displayed value is stale: the last refresh failed, the previous number is kept |
| color | by runway when a rate exists (red < 2 h, yellow < 12 h); otherwise by the absolute thresholds (defaults ¥20 / ¥5, configurable via `PI_DEEPSEEK_BALANCE_THRESHOLDS`) |

**Currency selection** never indexes the first row: a zero USD row cannot
mask a positive CNY row (a parser bug observed in other tools). Order:
`PI_DEEPSEEK_BALANCE_CURRENCY` → first positive CNY row → first positive row
→ CNY if present.

### Burn rate and runway

The extension appends `{time, currency, total}` snapshots to
`~/.pi/agent/pi-deepseek-balance-snapshots.jsonl` on every successful fetch
(the file compacts to the newest 500 entries at 1000 lines).
A rate is shown only past a confidence gate: ≥3 snapshots, spanning ≥1 hour,
in one currency, after the most recent top-up. Below the gate nothing is
displayed. The rate is account-wide — it includes spend from any client
sharing the key, not just this pi session. Top-ups reset the window instead
of producing negative rates. Once a rate exists, the footer appends an
estimated runway (`≈ 9.0h` at the current rate).

### Threshold alerts

```
DeepSeek balance low: ¥15.42
```

Emitted once per downward crossing; re-armed by a top-up. Defaults warn at
¥20 and error at ¥5 — guesses about a typical CNY burn, labeled as such.
Override with `PI_DEEPSEEK_BALANCE_THRESHOLDS="20,5"` (`0,0` disables; a zero
tier is fully off, even at a zero balance). The same thresholds drive the
footer amount's color, applied to the selected currency row — below the rate
gate the footer and the notification use the same numbers, so they cannot
disagree there. Once a rate exists, footer color switches to runway-based
(rate-derived), while notifications keep using the absolute thresholds;
that is by design: the color answers "how long until empty?", the
notification answers "is it below my configured floor?".

### `/deepseek-balance`

Overlay with every currency row, the granted/topped-up split (granted balance
burns first), the burn rate and its window, and the snapshot count. The
overlay scrolls when the report is taller than the window: the title stays
fixed, the body scrolls (↑/↓, PgUp/PgDn, Home/End), and a status line shows
the position — even `--json` payloads are never truncated. Close with Enter,
Esc, or Ctrl+C. `/deepseek-balance --json` prints the raw payload (TUI and
print mode only).

### Refresh behavior

Fetches on activation and on `/deepseek-balance`; after each turn at most
every 5 minutes. 429/5xx backs off honoring `Retry-After` — the deadline is
absolute, even a forced refresh cannot shorten it. Rejected credentials trip
a breaker after two failed rounds. Headless runs (`pi -p`) make no requests.

## Install

npm (indexed by the [package catalog](https://pi.dev/packages)):

```bash
pi install npm:pi-deepseek-balance
```

Or from git:

```bash
pi install git:github.com/frederick-wang/pi-deepseek-balance
```

## Key setup

Resolution order: the `DEEPSEEK_API_KEY` environment variable, then the
`deepseek` entry in `~/.pi/agent/auth.json` (or `$PI_CODING_AGENT_DIR/auth.json`).

## Language

The footer is language-neutral. Toasts, the report, and error guidance follow
`PI_DEEPSEEK_BALANCE_LANG` (`zh` or `en`) when set; otherwise the process
locale (a deliberately Chinese shell locale counts as intent); otherwise
English. `--json` keys stay English.

## Related packages

[`@hk_net/pi-usage-bars`](https://pi.dev/packages/@hk_net/pi-usage-bars) shows
balance for eight providers including DeepSeek; this package goes deeper on
one: CNY-correct row selection, persisted snapshots, burn rate, balance
alerts, and the granted/topped-up split.
[`@alexanderfortin/pi-deepseek-usage`](https://www.npmjs.com/package/@alexanderfortin/pi-deepseek-usage)
also shows the balance footer.

## Privacy

No telemetry. The API key is read locally and used only for requests to
`api.deepseek.com/user/balance`. Balance snapshots stay in the local pi
config directory.

## Limitations

- The burn rate is account-wide and cannot attribute spend to this session.
- Whether DeepSeek decrements the balance continuously or in billing batches
  is unverified; short-window rates may read zero before a step lands.
- Node's built-in `fetch` ignores `HTTPS_PROXY`.

## Development

This repo uses pnpm (see `packageManager` in `package.json`). Local
development needs Node ≥ 23.6; CI runs Node 24.

```bash
pnpm install
pnpm run typecheck
pnpm test
pnpm run live-check  # reads the real key and fetches once
```

## License

MIT — see [LICENSE](./LICENSE).
