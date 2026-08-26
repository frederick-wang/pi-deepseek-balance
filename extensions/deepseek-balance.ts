/**
 * pi-deepseek-balance — DeepSeek API account balance for the pi coding agent.
 *
 * Unofficial. Not affiliated with DeepSeek. Reads the documented
 * `GET /user/balance` endpoint; there is no official token-usage or
 * spend-history API (a community request has been open since 2026-06).
 *
 * Shows balance in the footer while the `deepseek` provider is active,
 * derives an account-wide burn rate from persisted balance snapshots
 * (CNY-only deltas — never converted across currencies), warns on low
 * balance, and answers `/deepseek-balance` with the full report.
 *
 * Erasable-syntax TypeScript only (Node type stripping; tsconfig enforces
 * erasableSyntaxOnly). Zero runtime dependencies. No runtime value imports
 * from @earendil-works packages.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as nodeFs from "node:fs";
import * as nodePath from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const STATUS_KEY = "pi-deepseek-balance";
const BALANCE_URL = "https://api.deepseek.com/user/balance";
const REQUEST_TIMEOUT_MS = 4000;
const THROTTLE_MS = 300_000; // balance moves slowly; 5 min is plenty
const SNAPSHOT_MIN_COUNT = 3;
const SNAPSHOT_MIN_SPAN_MS = 60 * 60_000; // 1 hour
const SNAPSHOT_KEEP = 500;

const DEFAULT_WARN_CNY = 20;
const DEFAULT_ERROR_CNY = 5;

export const ERR_PARSE = "pi-deepseek-balance: unexpected response from the balance endpoint";
export const ERR_TIMEOUT = "pi-deepseek-balance: the balance endpoint timed out";

// ---------------------------------------------------------------------------
// Balance parsing — S3 pure helpers.
// ---------------------------------------------------------------------------

export interface CurrencyRow {
	currency: string;
	total: number;
	granted: number;
	toppedUp: number;
}

export interface Balance {
	available: boolean;
	rows: CurrencyRow[];
}

export function parseBalance(raw: unknown): Balance | null {
	if (raw === null || typeof raw !== "object") return null;
	const o = raw as Record<string, unknown>;
	if (typeof o["is_available"] !== "boolean") return null;
	const infos = o["balance_infos"];
	if (!Array.isArray(infos)) return null;
	const rows: CurrencyRow[] = [];
	for (const item of infos) {
		if (item === null || typeof item !== "object") continue;
		const r = item as Record<string, unknown>;
		const currency = r["currency"];
		const total = Number(r["total_balance"]);
		const granted = Number(r["granted_balance"]);
		const toppedUp = Number(r["topped_up_balance"]);
		if (typeof currency !== "string") continue;
		if (!Number.isFinite(total) || !Number.isFinite(granted) || !Number.isFinite(toppedUp)) continue;
		rows.push({ currency, total, granted, toppedUp });
	}
	if (rows.length === 0) return null;
	return { available: o["is_available"], rows };
}

/**
 * Currency-row selection. Never index [0], never sum rows: a zero USD row
 * must not mask a positive CNY row (a real-world parser bug in the wild).
 * Order: explicit env override → first positive CNY → first positive row →
 * CNY if present → first row.
 */
export function selectRow(balance: Balance, override?: string): CurrencyRow | null {
	if (override) {
		const hit = balance.rows.find((r) => r.currency.toUpperCase() === override.toUpperCase());
		if (hit) return hit;
	}
	const positiveCny = balance.rows.find((r) => r.currency === "CNY" && r.total > 0);
	if (positiveCny) return positiveCny;
	const positive = balance.rows.find((r) => r.total > 0);
	if (positive) return positive;
	const cny = balance.rows.find((r) => r.currency === "CNY");
	return cny ?? balance.rows[0] ?? null;
}

export function currencySymbol(currency: string): string {
	if (currency === "CNY") return "¥";
	if (currency === "USD") return "$";
	return `${currency} `;
}

export function formatAmount(amount: number): string {
	return amount.toFixed(2);
}

// ---------------------------------------------------------------------------
// Burn rate — S3 pure estimator over persisted snapshots.
// ---------------------------------------------------------------------------

export interface Snapshot {
	t: number;
	currency: string;
	total: number;
}

/**
 * Account-wide burn rate from snapshots. Gated: needs SNAPSHOT_MIN_COUNT
 * samples spanning SNAPSHOT_MIN_SPAN_MS, all in one currency, strictly
 * non-increasing totals after top-up resets. Returns CNY/hour (or the
 * row's currency per hour) — no FX conversion, ever.
 */
export function estimateBurnRate(snapshots: Snapshot[]): { currency: string; perHour: number } | null {
	const usable = snapshots.filter((s) => Number.isFinite(s.t) && Number.isFinite(s.total));
	if (usable.length < SNAPSHOT_MIN_COUNT) return null;
	const currency = usable[usable.length - 1].currency;
	const same = usable.filter((s) => s.currency === currency);
	if (same.length < SNAPSHOT_MIN_COUNT) return null;
	// Reset windows on top-ups: keep the longest tail of non-increasing totals
	// (walking backward, stop at the first earlier sample that is LOWER —
	// that would be an increase into our window, i.e. a top-up boundary).
	let start = same.length - 1;
	while (start > 0 && same[start - 1].total >= same[start].total) start -= 1;
	const window = same.slice(start);
	if (window.length < SNAPSHOT_MIN_COUNT) return null;
	const span = window[window.length - 1].t - window[0].t;
	if (span < SNAPSHOT_MIN_SPAN_MS) return null;
	const drop = window[0].total - window[window.length - 1].total;
	if (drop <= 0) return null;
	return { currency, perHour: (drop / span) * 3_600_000 };
}

export function runwayHours(balanceTotal: number, perHour: number): number | null {
	if (perHour <= 0) return null;
	const hours = balanceTotal / perHour;
	return Number.isFinite(hours) ? hours : null;
}

// ---------------------------------------------------------------------------
// Footer rendering — S3 pure helpers.
// ---------------------------------------------------------------------------

export interface FooterTheme {
	fg(role: string, text: string): string;
}

const identityTheme: FooterTheme = { fg: (_role, text) => text };

function colorRole(balance: CurrencyRow, rate: { currency: string; perHour: number } | null): string {
	// Runway-based coloring once a same-currency rate exists…
	if (rate && rate.currency === balance.currency && rate.perHour > 0) {
		const hours = balance.total / rate.perHour;
		if (hours < 2) return "error";
		if (hours < 12) return "warning";
		return "success";
	}
	// …absolute bootstrap thresholds otherwise (CNY defaults).
	if (balance.currency === "CNY") {
		if (balance.total < DEFAULT_ERROR_CNY) return "error";
		if (balance.total < DEFAULT_WARN_CNY) return "warning";
	}
	return "success";
}

export function renderBar(fraction: number, theme: FooterTheme, role: string): string {
	const width = 8;
	const clamped = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
	const filled = Math.round(clamped * width);
	return theme.fg(role, "█".repeat(filled)) + theme.fg("dim", "░".repeat(width - filled));
}

export interface FooterOpts {
	now: number;
	stale?: boolean;
	rate?: { currency: string; perHour: number } | null;
	thresholds?: { warn: number; error: number };
	theme?: FooterTheme;
}

export function renderFooter(balance: Balance, row: CurrencyRow, opts: FooterOpts): string {
	const theme = opts.theme ?? identityTheme;
	if (!balance.available) {
		return theme.fg("error", "DS unavailable");
	}
	const sym = currencySymbol(row.currency);
	const role = colorRole(row, opts.rate ?? null);
	// Bar fraction: runway-normalized when a rate exists (12h = full bar),
	// else balance vs the warn threshold band (error..warn..comfort).
	let fraction: number;
	if (opts.rate && opts.rate.currency === row.currency && opts.rate.perHour > 0) {
		fraction = (row.total / opts.rate.perHour) / 12;
	} else {
		const warn = opts.thresholds?.warn ?? DEFAULT_WARN_CNY;
		fraction = Math.min(1, row.total / (warn * 3));
	}
	const stale = opts.stale ? "~" : "";
	const pct = `${formatAmount(row.total)}${stale}`;
	// Readable runway suffix once a same-currency rate exists (the bar's
	// normalization stays implicit; this makes it explicit).
	let runway = "";
	if (opts.rate && opts.rate.currency === row.currency && opts.rate.perHour > 0) {
		const hours = runwayHours(row.total, opts.rate.perHour);
		if (hours !== null) runway = ` ${theme.fg("dim", `≈${formatRunway(hours)}`)}`;
	}
	return `DS ${sym}${renderBar(fraction, theme, role)} ${theme.fg(role, pct)}${runway}`;
}

// ---------------------------------------------------------------------------
// Threshold alerts — descending crossings, re-arm on top-up.
// ---------------------------------------------------------------------------

export interface AlertUnitState {
	lastTotal: number | null;
	warned: boolean;
	errored: boolean;
}

export type AlertState = Record<string, AlertUnitState>;

export interface AlertEmission {
	tier: "warn" | "error";
}

export function evaluateAlerts(
	state: AlertState | null,
	currency: string,
	total: number,
	thresholds: { warn: number; error: number },
): { emitted: AlertEmission[]; state: AlertState } {
	const next: AlertState = { ...(state ?? {}) };
	const key = currency;
	const prev = next[key];
	let warned = prev?.warned ?? false;
	let errored = prev?.errored ?? false;
	const lastTotal = prev?.lastTotal ?? null;
	const emitted: AlertEmission[] = [];
	// Top-up (small epsilon for float noise) re-arms both tiers.
	if (lastTotal !== null && total > lastTotal + 1e-9) {
		warned = false;
		errored = false;
	}
	if (total <= thresholds.error) {
		if (!errored) emitted.push({ tier: "error" });
		errored = true;
		warned = true;
	} else if (total <= thresholds.warn) {
		if (!warned) emitted.push({ tier: "warn" });
		warned = true;
	}
	next[key] = { lastTotal: total, warned, errored };
	return { emitted, state: next };
}

// ---------------------------------------------------------------------------
// Messages — en/zh, same signal chain as pi-glm-usage.
// ---------------------------------------------------------------------------

export type Lang = "en" | "zh";

export function resolveLang(env: Record<string, string | undefined>): Lang {
	const explicit = env["PI_DEEPSEEK_BALANCE_LANG"];
	if (explicit === "zh" || explicit === "en") return explicit;
	const locale = new Intl.DateTimeFormat().resolvedOptions().locale;
	return locale.toLowerCase().startsWith("zh") ? "zh" : "en";
}

type MsgVars = Record<string, string | number>;

const MESSAGES: Record<Lang, Record<string, (v: MsgVars) => string>> = {
	en: {
		reportTitle: () => "DeepSeek Balance",
		pressClose: () => "Press Enter or Esc to close",
		allCurrencies: () => "Currencies:",
		granted: () => "granted",
		toppedUp: () => "topped up",
		unavailable: () => "Account unavailable (is_available: false).",
		burnRate: (v) => `Burn rate: ${v.rate} ${v.currency}/h (account-wide, last ${v.window})`,
		runway: (v) => `Runway: ~${v.hours} h at the current rate (estimate)`,
		noRate: () => "Burn rate: needs ≥3 snapshots spanning ≥1 h; collecting.",
		alertWarn: (v) => `DeepSeek balance low: ${v.amount}`,
		alertError: (v) => `DeepSeek balance critical: ${v.amount}`,
		noKey: () => "pi-deepseek-balance: no API key for the deepseek provider.",
		jsonModeRestricted: () => "pi-deepseek-balance: --json requires TUI or print mode.",
		fetchFailed: () => "pi-deepseek-balance: balance fetch failed.",
		rateLimited: () => "pi-deepseek-balance: rate-limited; retrying later.",
		snapshots: (v) => `Snapshots: ${v.count}`,
	},
	zh: {
		reportTitle: () => "DeepSeek 余额",
		pressClose: () => "按 Enter 或 Esc 关闭",
		allCurrencies: () => "各币种余额：",
		granted: () => "赠送",
		toppedUp: () => "充值",
		unavailable: () => "账户不可用（is_available: false）。",
		burnRate: (v) => `消耗速率：${v.rate} ${v.currency}/小时（账户级，近 ${v.window}）`,
		runway: (v) => `按当前速率约可用 ${v.hours} 小时（估算）`,
		noRate: () => "消耗速率：需至少 3 个快照且跨度 ≥1 小时，采集中。",
		alertWarn: (v) => `DeepSeek 余额偏低：${v.amount}`,
		alertError: (v) => `DeepSeek 余额告急：${v.amount}`,
		noKey: () => "pi-deepseek-balance：未找到 deepseek 供应商的 API key。",
		jsonModeRestricted: () => "pi-deepseek-balance：--json 仅支持 TUI 或 print 模式。",
		fetchFailed: () => "pi-deepseek-balance：余额获取失败。",
		rateLimited: () => "pi-deepseek-balance：被限流，稍后重试。",
		snapshots: (v) => `快照数：${v.count}`,
	},
};

export type MsgKey = keyof typeof MESSAGES.en;

export function msg(lang: Lang, key: MsgKey, vars: MsgVars = {}): string {
	const fn = MESSAGES[lang][key] ?? MESSAGES.en[key];
	return fn ? fn(vars) : key;
}

// ---------------------------------------------------------------------------
// Snapshot store — append-only JSONL in the pi agent dir; tolerant reads.
// ---------------------------------------------------------------------------

export interface SnapshotStore {
	append(snapshot: Snapshot): void;
	load(): Snapshot[];
}

export function createSnapshotStore(dir: string, readFile: (p: string) => string | null, appendFile: (p: string, s: string) => void): SnapshotStore {
	const file = nodePath.join(dir, "pi-deepseek-balance-snapshots.jsonl");
	return {
		append(snapshot) {
			try {
				appendFile(file, JSON.stringify(snapshot) + "\n");
			} catch {
				// Persistence is best-effort; the in-memory view still works.
			}
		},
		load() {
			let raw: string | null;
			try {
				raw = readFile(file);
			} catch {
				raw = null;
			}
			if (raw === null) return [];
			const out: Snapshot[] = [];
			for (const line of raw.split("\n")) {
				const t = line.trim();
				if (!t) continue;
				try {
					const parsed = JSON.parse(t) as Snapshot;
					if (typeof parsed.t === "number" && typeof parsed.total === "number" && typeof parsed.currency === "string") {
						out.push(parsed);
					}
				} catch {
					// Corrupt line: skip, keep reading.
				}
			}
			return out.slice(-SNAPSHOT_KEEP);
		},
	};
}

// ---------------------------------------------------------------------------
// Balance client — S2 boundary.
// ---------------------------------------------------------------------------

export type BalanceResult =
	| { status: "ok"; balance: Balance }
	| { status: "retry"; retryAfterMs: number }
	| { status: "error"; message: string };

export interface BalanceClientDeps {
	fetchImpl: typeof fetch;
	timeoutMs?: number;
}

export function createBalanceClient(deps: BalanceClientDeps) {
	const timeoutMs = deps.timeoutMs ?? REQUEST_TIMEOUT_MS;
	let consecutiveAuthFailures = 0;
	let breakerOpen = false;

	async function fetchBalance(key: string): Promise<BalanceResult> {
		if (breakerOpen) return { status: "error", message: ERR_PARSE };
		let res: Response;
		try {
			res = await deps.fetchImpl(BALANCE_URL, {
				headers: { Authorization: `Bearer ${key}`, Accept: "application/json", "User-Agent": "pi-deepseek-balance" },
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch (err) {
			const name = err instanceof Error ? err.name : "";
			return name === "TimeoutError" || name === "AbortError"
				? { status: "error", message: ERR_TIMEOUT }
				: { status: "error", message: ERR_PARSE };
		}
		if (res.status === 401 || res.status === 403) {
			consecutiveAuthFailures += 1;
			if (consecutiveAuthFailures >= 2) breakerOpen = true;
			return { status: "error", message: ERR_PARSE };
		}
		if (res.status === 429 || res.status >= 500) {
			const ra = res.headers.get("retry-after");
			const seconds = Number(ra);
			const retryAfterMs = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 60_000;
			return { status: "retry", retryAfterMs };
		}
		let body: unknown;
		try {
			body = await res.json();
		} catch {
			return { status: "error", message: ERR_PARSE };
		}
		const balance = parseBalance(body);
		if (!balance) return { status: "error", message: ERR_PARSE };
		consecutiveAuthFailures = 0;
		return { status: "ok", balance };
	}

	function resetBreaker(): void {
		breakerOpen = false;
		consecutiveAuthFailures = 0;
	}

	return { fetchBalance, resetBreaker };
}

// ---------------------------------------------------------------------------
// Report building — S3.
// ---------------------------------------------------------------------------

export function buildReportText(
	balance: Balance,
	row: CurrencyRow,
	snapshots: Snapshot[],
	rate: { currency: string; perHour: number } | null,
	opts: { lang?: Lang } = {},
): string {
	const lang = opts.lang ?? "en";
	const lines: string[] = [];
	lines.push(msg(lang, "reportTitle"));
	if (!balance.available) {
		lines.push("", msg(lang, "unavailable"));
	}
	lines.push("", msg(lang, "allCurrencies"));
	for (const r of balance.rows) {
		const parts = [`${currencySymbol(r.currency)}${formatAmount(r.total)}`];
		if (r.granted > 0 || r.toppedUp > 0) {
			parts.push(`(${msg(lang, "granted")} ${formatAmount(r.granted)} / ${msg(lang, "toppedUp")} ${formatAmount(r.toppedUp)})`);
		}
		lines.push(`  ${r.currency.padEnd(4)} ${parts.join("  ")}`);
	}
	lines.push("", rate ? msg(lang, "burnRate", { rate: rate.perHour.toFixed(2), currency: rate.currency, window: formatWindow(snapshots) }) : msg(lang, "noRate"));
	if (rate) {
		const hours = runwayHours(row.total, rate.perHour);
		if (hours !== null && rate.currency === row.currency) {
			lines.push(msg(lang, "runway", { hours: formatRunway(hours) }));
		}
	}
	lines.push("", msg(lang, "snapshots", { count: snapshots.length }));
	return lines.join("\n");
}

function formatWindow(snapshots: Snapshot[]): string {
	if (snapshots.length < 2) return "—";
	const spanH = (snapshots[snapshots.length - 1].t - snapshots[0].t) / 3_600_000;
	return spanH >= 1 ? `${spanH.toFixed(1)} h` : `${Math.round(spanH * 60)} min`;
}

function formatRunway(hours: number): string {
	if (hours >= 24) return `${(hours / 24).toFixed(1)}d`;
	if (hours >= 1) return `${hours.toFixed(1)}h`;
	return `${Math.round(hours * 60)}min`;
}

// ---------------------------------------------------------------------------
// Extension assembly — S1 seam.
// ---------------------------------------------------------------------------

export interface UiLike {
	setStatus(key: string, text?: string): void;
	notify(message: string, level?: string): void;
	theme: FooterTheme;
}

interface CtxLike {
	mode?: string;
	hasUI?: boolean;
	ui: UiLike;
	model?: { provider?: string };
	sessionManager?: unknown;
}

export interface BalanceClientLike {
	fetchBalance(key: string): Promise<BalanceResult>;
	resetBreaker(): void;
}

export interface ExtensionDeps {
	env?: Record<string, string | undefined>;
	balanceClientFor(): BalanceClientLike;
	apiKeyFor(): Promise<string | undefined>;
	nowFn?(): number;
	interactive?: boolean;
	setInterval?: typeof setInterval;
	clearInterval?: typeof clearInterval;
	snapshotStore?: SnapshotStore;
}

const COUNTDOWN_TICK_MS = 30_000;

export function createExtension(deps: ExtensionDeps) {
	const now = () => (deps.nowFn ?? Date.now)();
	const setIntervalImpl = deps.setInterval ?? setInterval;
	const clearIntervalImpl = deps.clearInterval ?? clearInterval;
	const isInteractive = (ctx: CtxLike) =>
		deps.interactive ?? (ctx.mode === "tui" || ctx.hasUI === true);
	return function install(pi: ExtensionAPI): void {
		let generation = 0;
		const lang = resolveLang(deps.env ?? {});
		const thresholds = parseThresholdsLike(deps.env?.["PI_DEEPSEEK_BALANCE_THRESHOLDS"]);
		const currencyOverride = deps.env?.["PI_DEEPSEEK_BALANCE_CURRENCY"];

		let active = false;
		let apiKey: string | null = null;
		let balance: Balance | null = null;
		let row: CurrencyRow | null = null;
		let stale = false;
		let nextAllowedAt = 0;
		let retryDeadline = 0;
		let inFlight = false;
		let timer: ReturnType<typeof setIntervalImpl> | null = null;
		let timerRunning = false;
		let lastUi: UiLike | null = null;
		const store: SnapshotStore = deps.snapshotStore ?? noopStore();
		let snapshots: Snapshot[] = store.load();

		function clearTimer(): void {
			if (timer !== null) {
				clearIntervalImpl(timer as never);
				timer = null;
			}
			timerRunning = false;
		}

		function rate(): { currency: string; perHour: number } | null {
			return estimateBurnRate(snapshots);
		}

		function render(ui: UiLike): void {
			if (!active || row === null || balance === null) {
				ui.setStatus(STATUS_KEY, undefined);
				return;
			}
			ui.setStatus(
				STATUS_KEY,
				renderFooter(balance, row, { now: now(), stale, rate: rate(), thresholds, theme: ui.theme }),
			);
		}

		function refresh(ctx: CtxLike, force = false): void {
			lastUi = ctx.ui;
			if (!isInteractive(ctx) || !active || apiKey === null || inFlight) return;
			if (now() < retryDeadline) return;
			if (!force && now() < nextAllowedAt) return;
			inFlight = true;
			nextAllowedAt = Math.max(nextAllowedAt, now() + THROTTLE_MS);
			const gen = generation;
			const ui = ctx.ui;
			deps
				.balanceClientFor()
				.fetchBalance(apiKey)
				.then((res) => {
					if (gen !== generation) return;
					if (res.status === "ok") {
						retryDeadline = 0;
						balance = res.balance;
						row = selectRow(res.balance, currencyOverride);
						stale = false;
						if (row) {
							const snap: Snapshot = { t: now(), currency: row.currency, total: row.total };
							snapshots.push(snap);
							snapshots = snapshots.slice(-SNAPSHOT_KEEP);
							store.append(snap);
							const alerts = evaluateAlerts(alertState, row.currency, row.total, thresholds);
							alertState = alerts.state;
							for (const e of alerts.emitted) {
								const amount = `${currencySymbol(row.currency)}${formatAmount(row.total)}`;
								ui.notify(
									msg(lang, e.tier === "error" ? "alertError" : "alertWarn", { amount }),
									e.tier === "error" ? "error" : "warning",
								);
							}
						}
					} else if (res.status === "retry") {
						retryDeadline = Math.max(retryDeadline, now() + res.retryAfterMs);
						nextAllowedAt = Math.max(nextAllowedAt, retryDeadline);
					} else if (balance !== null) {
						stale = true;
					}
					render(ui);
				})
				.catch(() => {
					if (gen !== generation) return;
					if (balance !== null) stale = true;
					render(ui);
				})
				.finally(() => {
					inFlight = false;
				});
		}

		let alertState: AlertState | null = null;

		async function showOverlay(text: string, ctx: CtxLike): Promise<void> {
			await (ctx.ui as UiLike & { custom(factory: unknown, opts?: unknown): Promise<unknown> }).custom(
				(_tui: unknown, theme: FooterTheme, _kb: unknown, done: (value: unknown) => void) => {
					const lines = [
						`  ${theme.fg("accent", msg(lang, "reportTitle"))}`,
						"",
						...text.split("\n"),
						"",
						`  ${theme.fg("dim", msg(lang, "pressClose"))}`,
					];
					return {
						render: (width: number) => lines.map((l) => l.slice(0, Math.max(0, width))).join("\n"),
						invalidate: () => {},
						handleInput: (data: string) => {
							if (data === "\r" || data === "\n" || data === "\x1b") done(undefined);
						},
					};
				},
				{ overlay: true },
			);
		}

		pi.on("session_start", async (_event, ctx) => {
			// Seed activation from ctx.model (SessionStartEvent carries no model).
			const provider = (ctx as CtxLike).model?.provider;
			if (provider === "deepseek") {
				const key = await deps.apiKeyFor();
				if (key) {
					active = true;
					apiKey = key;
					deps.balanceClientFor().resetBreaker();
					render((ctx as CtxLike).ui);
					refresh(ctx as CtxLike, true);
				}
			}
		});

		pi.on("model_select", async (event, ctx) => {
			generation += 1;
			lastUi = (ctx as CtxLike).ui;
			const provider = event.model.provider;
			if (provider !== "deepseek") {
				active = false;
				apiKey = null;
				balance = null;
				row = null;
				stale = false;
				clearTimer();
				(ctx as CtxLike).ui.setStatus(STATUS_KEY, undefined);
				return;
			}
			const key = await deps.apiKeyFor();
			if (!key) {
				active = false;
				apiKey = null;
				(ctx as CtxLike).ui.notify(msg(lang, "noKey"), "warning");
				(ctx as CtxLike).ui.setStatus(STATUS_KEY, (ctx as CtxLike).ui.theme.fg("dim", "DS no key"));
				return;
			}
			active = true;
			apiKey = key;
			balance = null;
			row = null;
			stale = false;
			deps.balanceClientFor().resetBreaker();
			render((ctx as CtxLike).ui);
			refresh(ctx as CtxLike, true);
		});

		pi.on("turn_end", async (_event, ctx) => {
			refresh(ctx as CtxLike, false);
		});

		pi.on("agent_start", async (_event, ctx) => {
			lastUi = (ctx as CtxLike).ui;
			if (!isInteractive(ctx as CtxLike) || !active || timerRunning) return;
			timerRunning = true;
			timer = setIntervalImpl(() => {
				if (lastUi && active) render(lastUi);
			}, COUNTDOWN_TICK_MS);
			timer?.unref?.();
		});

		pi.on("agent_end", async () => {
			clearTimer();
		});

		pi.on("session_shutdown", async () => {
			generation += 1;
			clearTimer();
		});

		pi.registerCommand("deepseek-balance", {
			description: "Show DeepSeek account balance (add --json for raw output)",
			handler: async (args: string, ctxRaw: unknown) => {
				const ctx = ctxRaw as CtxLike;
				let key = apiKey;
				if (!key) {
					// The command works regardless of the active provider; resolving
					// a key here must NOT flip footer activation (B3).
					key = (await deps.apiKeyFor()) ?? null;
				}
				if (!key) {
					ctx.ui.notify(msg(lang, "noKey"), "error");
					return;
				}
				const res = await deps.balanceClientFor().fetchBalance(key);
				if (res.status !== "ok") {
					ctx.ui.notify(res.status === "retry" ? msg(lang, "rateLimited") : msg(lang, "fetchFailed"), "error");
					return;
				}
				balance = res.balance;
				row = selectRow(res.balance, currencyOverride);
				stale = false;
				const chosen = row ?? { currency: "CNY", total: 0, granted: 0, toppedUp: 0 };
				const snap: Snapshot = { t: now(), currency: chosen.currency, total: chosen.total };
				snapshots.push(snap);
				snapshots = snapshots.slice(-SNAPSHOT_KEEP);
				store.append(snap);
				render(ctx.ui);
				const wantJson = args.includes("--json");
				if (wantJson) {
					const payload = JSON.stringify({ balance: res.balance, selected: row, rate: rate(), snapshots: snapshots.length }, null, 2);
					if (ctx.mode === "tui") {
						await showOverlay(payload, ctx);
					} else if (ctx.mode === "print") {
						// Only print mode owns stdout; RPC/JSON stdout is protocol.
						console.log(payload);
					} else {
						ctx.ui.notify(msg(lang, "jsonModeRestricted"), "warning");
					}
					return;
				}
				const text = buildReportText(res.balance, chosen, snapshots, rate(), { lang });
				if (ctx.mode === "tui") {
					await showOverlay(text, ctx);
				} else {
					ctx.ui.notify(`${currencySymbol(chosen.currency)}${formatAmount(chosen.total)}`, "info");
				}
			},
		});
	};
}

export function parseThresholdsLike(value: string | undefined): { warn: number; error: number } {
	if (value === undefined) return { warn: DEFAULT_WARN_CNY, error: DEFAULT_ERROR_CNY };
	const parts = value.split(",").map((x) => Number(x.trim()));
	if (parts.length === 2 && parts.every((n) => Number.isFinite(n) && n >= 0)) {
		return { warn: Math.max(parts[0], parts[1]), error: Math.min(parts[0], parts[1]) };
	}
	return { warn: DEFAULT_WARN_CNY, error: DEFAULT_ERROR_CNY };
}

function noopStore(): SnapshotStore {
	return { append: () => {}, load: () => [] };
}

// ---------------------------------------------------------------------------
// Default export — real wiring.
// ---------------------------------------------------------------------------

export default function deepseekBalance(pi: ExtensionAPI): void {
	const env = process.env as Record<string, string | undefined>;
	const store = createSnapshotStore(
		env["PI_CODING_AGENT_DIR"] ?? nodePath.join(process.env.HOME ?? "", ".pi", "agent"),
		(p) => {
			try {
				return nodeFs.readFileSync(p, "utf8");
			} catch {
				return null;
			}
		},
		(p, s) => {
			try {
				nodeFs.appendFileSync(p, s);
			} catch {
				// best-effort
			}
		},
	);
	const apiKeyFor = async (): Promise<string | undefined> => {
		const registry = (pi as { ctx?: unknown }).ctx;
		void registry;
		// ctx is not available at install time; modelRegistry arrives per-event.
		// Fallback chain: env (pi's documented variable) then auth.json.
		if (env["DEEPSEEK_API_KEY"]) return env["DEEPSEEK_API_KEY"];
		try {
			const dir = env["PI_CODING_AGENT_DIR"] ?? nodePath.join(process.env.HOME ?? "", ".pi", "agent");
			const raw = nodeFs.readFileSync(nodePath.join(dir, "auth.json"), "utf8");
			const parsed = JSON.parse(raw) as Record<string, { key?: unknown }>;
			const key = parsed["deepseek"]?.key;
			if (typeof key === "string") return key;
		} catch {
			// JSON.parse failures never leak file content.
		}
		return undefined;
	};
	const client = createBalanceClient({ fetchImpl: fetch });
	createExtension({
		env,
		balanceClientFor: () => client,
		apiKeyFor,
		snapshotStore: store,
	})(pi);
}
