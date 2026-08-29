# AGENTS.md — pi-deepseek-balance

A [pi coding agent](https://github.com/earendil-works/pi-mono) extension that shows the DeepSeek API account balance in the footer, with burn-rate estimation and low-balance alerts.

## Project standards

- **No credentials or personal data in any file**: no API keys, tokens, or identifiable personal info in configs, tests, docs, or examples. Keys come from env (`DEEPSEEK_API_KEY`) or the user's `auth.json` at runtime only; repo never stores them. Package coordinates (`pi-deepseek-balance`, the GitHub repo URL) are the only identity allowed.
- **Shipped text is English**; `README.zh-CN.md` mirrors it in idiomatic Chinese — same content, natural phrasing, never word-for-word; both language versions change together, with no notes about the sync process in reader-facing text.
- **UI language** follows `PI_DEEPSEEK_BALANCE_LANG`, then locale, then English; `--json` keys stay English.
- **Zero runtime dependencies.** No runtime value imports from `@earendil-works/pi-*` packages (`--omit=dev` installs break otherwise); the overlay renders plain text and compares raw key bytes.
- **Single extension file** (`extensions/deepseek-balance.ts`); the message catalog lives in it.
- **Currency is a correctness boundary**: never index the first `balance_infos` row, never sum rows, never convert between currencies. Burn rate is computed within one currency only.
- **Burn-rate honesty**: the rate is account-wide, gated (≥3 snapshots, ≥1 h, post-top-up window), and labeled an estimate. The footer shows only the current-rate runway estimate (`≈ N h`); long-horizon projections stay out until real data validates the estimator.
- **No gauge without a real denominator**: a meter needs a genuine 100% (quota, cap, pack size). DeepSeek exposes none, so the footer renders amount + runway only; never invent an axis to fill with a bar.

## Hard-won implementation notes (carried from pi-glm-usage + this project)

- Seed activation in `session_start` from `ctx.model` (`SessionStartEvent` carries no model). `model_select` alone never fires on a plain startup.
- Gate on `ctx.mode`/`ctx.hasUI` per event, never `stdout.isTTY`; `json` mode is treated like `rpc` (no stdout writes); only `print` mode may `console.log`.
- `ctx.ui.setStatus(key, undefined)` clears the slot.
- Before any release: install the packed tarball into a throwaway project and run it under real pi once.
- pnpm 11 build policy: `pnpm-workspace.yaml` `allowBuilds` with `true`/`false` values (v10 names are ignored; `block` is invalid).
- Editing `package.json` dependencies requires regenerating the lockfile in the same commit.
- `gh pr checks` emits `pass`/`fail`; `gh run view` emits `success`/`failure` — write polling exit conditions against the actual vocabulary.
- npm answers an anonymous PUT with **404**, not 401. OIDC trusted publishing requires the `actions/setup-node` + `registry-url` step before `npm publish`; `pnpm/setup`'s environment alone yields ENEEDAUTH. `repository.url` must use the `git+https://` form.
- Reader-facing text carries no maintainer meta-notes; the zh README is written as Chinese a Chinese engineer would write; name competitors directly with links. README examples must be reproducible: a rendered sample that no code path produces is a doc bug — regenerate it with the change that touches the render output.
- Footer text needs breathing room: spaces around reset countdowns (`67% ↻48m`) and segment separators (` · `) — a 0.1.2 visual regression caught only in live use.
- A config value that doubles as "disabled" (`0,0`) needs an explicit `> 0` gate on every comparison consuming it, plus boundary tests at the value it disables: an inclusive `<=` at zero fires (0.1.7).
- Isolated `PI_CODING_AGENT_DIR` smoke does not exercise provider/model resolution — pi reads those from the real `~/.pi`, so the extension may load but never activate there. Footer truth needs the real environment.
- State that must survive session restarts (snapshots) goes in its own append-only JSONL under the pi agent dir — `appendEntry` lives in one session tree.

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at repo root. See `docs/agents/domain.md`.
