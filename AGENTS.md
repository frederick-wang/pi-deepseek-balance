# AGENTS.md — pi-deepseek-balance

A [pi coding agent](https://github.com/earendil-works/pi-mono) extension that shows the DeepSeek API account balance in the footer, with burn-rate estimation and low-balance alerts.

## Project standards

- **No personal information in any file**, including git history. Package coordinates (`pi-deepseek-balance`, the GitHub repo URL) are the only identity allowed. Set the repo-local neutral git identity before the first commit.
- **Shipped text is English**; `README.zh-CN.md` mirrors it in idiomatic Chinese — same content, natural phrasing, never word-for-word; both language versions change together, with no notes about the sync process in reader-facing text.
- **UI language** follows `PI_DEEPSEEK_BALANCE_LANG`, then locale, then English; `--json` keys stay English.
- **Zero runtime dependencies.** No runtime value imports from `@earendil-works/pi-*` packages (`--omit=dev` installs break otherwise); the overlay renders plain text and compares raw key bytes.
- **Single extension file** (`extensions/deepseek-balance.ts`); the message catalog lives in it.
- **Currency is a correctness boundary**: never index the first `balance_infos` row, never sum rows, never convert between currencies. Burn rate is computed within one currency only.
- **Burn-rate honesty**: the rate is account-wide, gated (≥3 snapshots, ≥1 h, post-top-up window), and labeled an estimate. Runway projection stays out until real data validates the estimator.

## Hard-won implementation notes (carried from pi-glm-usage + this project)

- Seed activation in `session_start` from `ctx.model` (`SessionStartEvent` carries no model). `model_select` alone never fires on a plain startup.
- Gate on `ctx.mode`/`ctx.hasUI` per event, never `stdout.isTTY`; `json` mode is treated like `rpc` (no stdout writes); only `print` mode may `console.log`.
- `ctx.ui.setStatus(key, undefined)` clears the slot.
- Before any release: install the packed tarball into a throwaway project and run it under real pi once.
- pnpm 11 build policy: `pnpm-workspace.yaml` `allowBuilds` with `true`/`false` values (v10 names are ignored; `block` is invalid).
- Editing `package.json` dependencies requires regenerating the lockfile in the same commit.
- `gh pr checks` emits `pass`/`fail`; `gh run view` emits `success`/`failure` — write polling exit conditions against the actual vocabulary.
- npm answers an anonymous PUT with **404**, not 401. OIDC trusted publishing requires the `actions/setup-node` + `registry-url` step before `npm publish`; `pnpm/setup`'s environment alone yields ENEEDAUTH. `repository.url` must use the `git+https://` form.
- Reader-facing text carries no maintainer meta-notes; the zh README is written as Chinese a Chinese engineer would write; name competitors directly with links.
- Footer text needs breathing room: spaces around reset countdowns (`67% ↻48m`) and segment separators (` · `) — a 0.1.2 visual regression caught only in live use.
- State that must survive session restarts (snapshots) goes in its own append-only JSONL under the pi agent dir — `appendEntry` lives in one session tree.

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at repo root. See `docs/agents/domain.md`.
