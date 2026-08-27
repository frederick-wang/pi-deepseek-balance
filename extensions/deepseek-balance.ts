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
// Terminal text helpers — S3 pure: ANSI-aware width, wrapping, scroll windows.
// ---------------------------------------------------------------------------

/**
 * Display width of a string, ANSI SGR sequences zero-width, CJK/emoji double.
 * A pragmatic subset of East-Asian-width: enough for every line we render
 * (currency rows, report text, JSON payload); surrogate pairs count as 2.
 */
export function visualWidth(s: string): number {
	let w = 0;
	for (let i = 0; i < s.length; ) {
		const cp = s.codePointAt(i) ?? 0;
		if (cp === 0x1b) {
			i = skipEscape(s, i);
			continue;
		}
		w += isWideChar(cp) ? 2 : 1;
		i += cp > 0xffff ? 2 : 1;
	}
	return w;
}

/**
 * Index just past an escape sequence starting at s[i] == ESC.
 * Handles CSI (ESC [ ... final) and OSC (ESC ] ... BEL|ST) forms.
 */
function skipEscape(s: string, i: number): number {
	if (s[i + 1] === "]") {
		// OSC: runs until BEL (0x07) or ST (ESC \\), may contain any bytes.
		let j = i + 2;
		while (j < s.length) {
			const b = s.charCodeAt(j);
			if (b === 0x07) {
				j += 1;
				break;
			}
			if (b === 0x1b && s[j + 1] === "\\") {
				j += 2;
				break;
			}
			j += 1;
		}
		return j;
	}
	let j = i + 1;
	while (j < s.length) {
		const b = s.charCodeAt(j);
		// '[' / ']' are CSI/OSC introducers, never finals.
		if (b >= 0x40 && b <= 0x7e && b !== 0x5b && b !== 0x5d) {
			j += 1;
			break;
		}
		j += 1;
	}
	return j;
}

function isWideChar(cp: number): boolean {
	return (
		(cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
		(cp >= 0x2e80 && cp <= 0xa4cf) || // CJK radicals … Yi
		(cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
		(cp >= 0xf900 && cp <= 0xfaff) || // CJK compat ideographs
		(cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compat forms
		(cp >= 0xff00 && cp <= 0xff60) || // Fullwidth forms
		(cp >= 0xffe0 && cp <= 0xffe6) || // Fullwidth signs
		(cp >= 0x1f300 && cp <= 0x1f64f) || // Emoji (pictographs)
		(cp >= 0x1f900 && cp <= 0x1f9ff) || // Emoji (supplement)
		(cp >= 0x20000 && cp <= 0x3fffd) // CJK ext B+ / ideographs
	);
}

/**
 * Wrap a line so no segment exceeds `width` visible columns. ANSI SGR codes
 * are preserved and re-applied at the start of each segment (pi resets styles
 * per line). Segments are cut at grapheme boundaries (surrogate pairs never
 * split; a wide char is never split across segments). Inline escape sequences
 * are carried through untouched.
 */
export function wrapLines(lines: string[], width: number): string[] {
	if (width <= 0) return [...lines];
	const out: string[] = [];
	for (const line of lines) {
		if (visualWidth(line) <= width) {
			out.push(line);
			continue;
		}
		// Tokenize so visible text and ANSI runs are handled separately: a
		// segment never splits an escape sequence, and styles stay intact.
		const tokens = ansiTokens(line);
		const wrapped: string[] = [];
		let cur = "";
		let curW = 0;
		for (const tok of tokens) {
			if (tok.ansi) {
				// Escape runs are zero-width and must stay with the segment.
				cur += tok.s;
				curW += 0;
				continue;
			}
		const cw = isWideChar(tok.cp) ? 2 : 1;
			if (curW + cw > width && visibleCharCount(cur) > 0) {
				wrapped.push(cur);
				// A single glyph wider than the whole line can never fit: drop it
				// rather than emit an overflowing row (a 2-col char in a 1-col
				// line would break the box frame).
				cur = cw <= width ? tok.s : "";
				curW = cw <= width ? cw : 0;
			} else if (cw > width) {
				// First char of a fresh segment can't fit either: drop silently.
				cur = "";
				curW = 0;
			} else {
				cur += tok.s;
				curW += cw;
			}
		}
		if (cur.length > 0) wrapped.push(cur);
		// Re-apply the line's leading style to every segment after the first:
		// the first already carries it (token flow), and pi resets styles per
		// rendered line, so without this only the first row keeps the color.
		// Strip ALL whitespace from the style prefix — a continuation segment
		// must not inherit the original indentation.
		const { ansiPrefix } = splitAnsi(line);
		const styleOnly = ansiPrefix.replace(/\s/g, "");
		for (let k = 0; k < wrapped.length; k++) {
			out.push(k === 0 ? wrapped[k] : `${styleOnly}${wrapped[k]}`);
		}
	}
	return out;
}

/** Visible (non-escape) character count of a segment. */
function visibleCharCount(s: string): number {
	let n = 0;
	let i = 0;
	while (i < s.length) {
		if (s[i] === "\x1b") {
			i = skipEscape(s, i);
		} else {
			const cp = s.codePointAt(i) ?? 0;
			n += 1;
			i += cp > 0xffff ? 2 : 1;
		}
	}
	return n;
}

/** Pad a line to `width` visible columns with trailing spaces (ANSI-aware). */
function padToWidth(line: string, width: number): string {
	const cur = visualWidth(line);
	return cur >= width ? line : `${line}${" ".repeat(width - cur)}`;
}

/**
 * Chrome lines (header/status/footer) are status-bar-like: never wrap —
 * truncate to the width by visible columns. Tokenizes so escape sequences
 * stay atomic; leading spaces + style prefix survive intact.
 */
function clampChrome(line: string, width: number): string {
	if (visualWidth(line) <= width) return line;
	const tokens = ansiTokens(line);
	let out = "";
	let w = 0;
	let sawVisible = false;
	for (const tok of tokens) {
		if (tok.ansi) {
			out += tok.s;
			continue;
		}
		const cw = isWideChar(tok.cp) ? 2 : 1;
		if (!sawVisible && tok.s.trim() === "") {
			// Leading whitespace is chrome formatting: keep up to width.
			if (w + cw > width) break;
			out += tok.s;
			w += cw;
			continue;
		}
		if (w + cw > width && w > 0) break;
		out += tok.s;
		w += cw;
		sawVisible = true;
	}
	return out;
}

interface AnsiToken {
	ansi: boolean;
	s: string;
	cp: number;
}

/** Split a line into [visible char | ANSI run] tokens, code-point aware. */
function ansiTokens(line: string): AnsiToken[] {
	const tokens: AnsiToken[] = [];
	let i = 0;
	while (i < line.length) {
		if (line[i] === "\x1b") {
			const j = skipEscape(line, i);
			tokens.push({ ansi: true, s: line.slice(i, j), cp: 0 });
			i = j;
		} else {
			const cp = line.codePointAt(i) ?? 0;
			const ch = String.fromCodePoint(cp);
			tokens.push({ ansi: false, s: ch, cp });
			i += cp > 0xffff ? 2 : 1;
		}
	}
	return tokens;
}

/** Strip leading and trailing ANSI SGR runs; return them separately. */
function splitAnsi(line: string): { text: string; ansiPrefix: string; ansiSuffix: string } {
	// Tokenize into [ansi | text] runs; prefix = leading spaces + leading ansi
	// tokens, suffix = trailing ansi tokens, text = everything in between.
	const tokens = ansiTokens(line);
	let prefix = "";
	let start = 0;
	// Leading whitespace is formatting, not content — keep with the prefix.
	while (start < tokens.length && (tokens[start].ansi || tokens[start].s.trim() === "")) {
		prefix += tokens[start].s;
		start += 1;
	}
	let suffix = "";
	let end = tokens.length;
	while (end > start && tokens[end - 1].ansi) {
		suffix = tokens[end - 1].s + suffix;
		end -= 1;
	}
	return { text: tokens.slice(start, end).map((t) => t.s).join(""), ansiPrefix: prefix, ansiSuffix: suffix };
}

/** Clamp scrollTop into [0, max(0, body.length - avail)]. */
export function clampScrollTop(scrollTop: number, bodyLength: number, avail: number): number {
	const max = Math.max(0, bodyLength - avail);
	return Math.min(Math.max(0, scrollTop), max);
}

export interface WindowResult {
	top: number;
	lines: string[];
	atEnd: boolean;
}

/** The visible window of a scrollable body, clamped, with end-of-content flag. */
export function windowSlice(body: string[], scrollTop: number, avail: number): WindowResult {
	const top = clampScrollTop(scrollTop, body.length, avail);
	return {
		top,
		lines: body.slice(top, top + avail),
		atEnd: top >= Math.max(0, body.length - avail),
	};
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
		if (hours !== null) runway = ` ${theme.fg("dim", `≈ ${formatRunway(hours)}`)}`;
	}
	return `DS ${sym} ${renderBar(fraction, theme, role)} ${theme.fg(role, pct)}${runway}`;
}

// ---------------------------------------------------------------------------
// Key matching — structural type for pi's injected KeybindingsManager.
// ---------------------------------------------------------------------------

export interface KeyLike {
	matches(data: string, id: string): boolean;
}

// ---------------------------------------------------------------------------
// Overlay component — hand-rolled per zero-runtime-dep rule; types local.
// ---------------------------------------------------------------------------

export interface OverlayComponent {
	render(width: number): string[];
	invalidate(): void;
	handleInput(data: string): void;
}

export interface OverlayComponentOpts {
	header: string;
	body: string[];
	footer: string;
	theme: FooterTheme;
	kb: KeyLike;
	done: (value: unknown) => void;
	// Live row source — read at render time so terminal resizes are honored.
	rowGen: () => number;
	lang: Lang;
}

/**
 * Fixed header + scrollable body + optional status line + fixed footer.
 * Body is never truncated: it scrolls. `render` recomputes styled lines so
 * `invalidate()` (called on theme change) really refreshes colors.
 */
export function createOverlayComponent(opts: OverlayComponentOpts): OverlayComponent {
	const { header, body, footer, theme, kb, done, rowGen, lang } = opts;
	let scrollTop = 0;
	let closed = false;
	// Last render width — scroll math must agree with the wrapping render used.
	let lastWidth = 80;
	// Drop a leading blank from the body: render already adds one after the
	// header, so a body starting with "" would double up the spacing.
	const body0 = body[0] === "" ? body.slice(1) : body;	

	const close = () => {
		if (closed) return;
		closed = true;
		done(undefined);
	};

	/**
	 * Row budget read live (terminal resizes), matching pi's maxHeight
	 * "80%" — the returned array must never exceed it or pi's head-keeping
	 * clip would drop the bottom border after a shrink.
	 */
	function maxRowsAt(): number {
		return Math.max(1, Math.floor(rowGen() * 0.8));
	}

	/**
	 * Body availability for a given maxRows. The box always keeps: top
	 * border(1) + blank(1) + footer row(1) + blank before footer(1) +
	 * bottom border(1) = 5 chrome rows; with a status line: + status row +
	 * its blank = 7. Body gets the rest; when maxRows can't fit a status
	 * line it's dropped (content wins over chrome). When maxRows < 6 the
	 * box cannot physically render (5-row minimum): degrade to borderless
	 * plain rows so the overlay still closes the budget.
	 */
	function layout(width: number): { avail: number; canStatus: boolean; boxed: boolean } {
		const maxRows = maxRowsAt();
		// Box needs 2 columns for the side bars + a title that fits; below that
		// (or tiny terminals) degrade to borderless plain rows.
		const boxed = maxRows >= 6 && width >= 8;
		// Boxed: borders(2) + title blank(1) + footer blank(1) + footer row(1) = 5.
		// Borderless (tiny): header(1) + blank(1) + footer(1) = 3 — body gets
		// whatever is left so content isn't dropped on short terminals.
		const chrome = boxed ? 5 : 3;
		const avail = Math.max(0, maxRows - chrome);
		const canStatus = boxed && maxRows >= chrome + 2 + 1;
		return { avail, canStatus, boxed };
	}

	/**
	 * Scroll window for the current body at the given inner width: how many
	 * body rows fit (status line costing two rows) and whether status shows.
	 * Shared by render and handleInput so the math never drifts.
	 */
	function scrollWindowAt(w: number): { bodyLines: string[]; avail: number; needsStatus: boolean } {
		const innerW = Math.max(1, w - 2);
		const bodyLines = wrapLines(body0, innerW);
		const { avail, canStatus } = layout(w);
		const needsStatus = canStatus && bodyLines.length > avail;
		const bodyAvail = needsStatus ? Math.max(0, avail - 2) : avail;
		return { bodyLines, avail: bodyAvail, needsStatus };
	}

	function renderLines(width: number): string[] {
		const w = Math.max(1, width);
		const innerW = Math.max(1, w - 2);
		const { bodyLines, avail: bodyAvail, needsStatus } = scrollWindowAt(w);
		const { boxed } = layout(w);
		const win = windowSlice(bodyLines, scrollTop, bodyAvail);
		scrollTop = win.top; // write back the clamp so input math agrees

		const statusRow = needsStatus
			? clampChrome(`  ${theme.fg("muted", msg(lang, "scrollStatus", { pos: win.atEnd ? bodyLines.length : win.top + win.lines.length, total: bodyLines.length }))}`, innerW)
			: null;
		// Pick the short close-hint variant when the full one can't fit the
		// inner width (2-col indent included) — truncating mid-word is worse.
		const footerText = visualWidth(footer) + 2 > innerW ? msg(lang, "pressCloseShort") : footer;
		const footerRow = clampChrome(`  ${theme.fg("dim", footerText)}`, innerW);
		const titleRow = clampChrome(`  ${theme.fg("accent", header)}`, innerW);

		const blocks: string[] = [""]; // blank under the top border
		blocks.push(...win.lines);
		if (statusRow) {
			blocks.push("");
			blocks.push(statusRow);
		}
		blocks.push("");
		blocks.push(footerRow);

		if (!boxed) {
			// Degraded mode (maxRows < 6): borderless plain rows so the overlay
			// still closes the height budget on absurdly short terminals.
			const out: string[] = [titleRow];
			if (win.lines.length > 0) out.push("", ...win.lines);
			if (statusRow) out.push("", statusRow);
			out.push(footerRow);
			return out;
		}

		// Top border: ╭─[centered title]─╮ (single corner char each side)
		const titleStr = clampChrome(` ${theme.fg("accent", header)} `, innerW);
		const titleW = visualWidth(titleStr);
		const pad = Math.max(0, innerW - titleW);
		const topPad = Math.floor(pad / 2);
		const topPad2 = pad - topPad;
		const top = theme.fg("border", "╭") + theme.fg("border", "─".repeat(topPad)) + titleStr + theme.fg("border", "─".repeat(topPad2)) + theme.fg("border", "╮");
		const bottom = theme.fg("border", `╰${"─".repeat(Math.max(0, innerW))}╯`);

		const out: string[] = [top];
		for (const line of blocks) {
			const inner = line === "" ? " ".repeat(innerW) : padToWidth(line, innerW);
			out.push(`${theme.fg("border", "│")}${inner}${theme.fg("border", "│")}`);
		}
		out.push(bottom);
		return out;
	}

	return {
		render(width: number) {
			lastWidth = Math.max(1, width);
			return renderLines(lastWidth);
		},
		invalidate() {
			// render() recomputes everything from theme each call; nothing cached.
			// Kept as the pi contract entry point for theme changes.
		},
		handleInput(data: string) {
			if (closed) return;
			if (kb.matches(data, "tui.select.confirm") || kb.matches(data, "tui.select.cancel")) {
				close();
				return;
			}
			const w = Math.max(1, lastWidth);
			const { bodyLines, avail: bodyAvail } = scrollWindowAt(w);
			const max = Math.max(0, bodyLines.length - bodyAvail);
			if (kb.matches(data, "tui.select.up")) {
				scrollTop = clampScrollTop(scrollTop - 1, bodyLines.length, bodyAvail);
			} else if (kb.matches(data, "tui.select.down")) {
				scrollTop = clampScrollTop(scrollTop + 1, bodyLines.length, bodyAvail);
			} else if (kb.matches(data, "tui.select.pageUp") || kb.matches(data, "tui.altScreen.pageUp")) {
				scrollTop = clampScrollTop(scrollTop - Math.max(1, bodyAvail - 1), bodyLines.length, bodyAvail);
			} else if (kb.matches(data, "tui.select.pageDown") || kb.matches(data, "tui.altScreen.pageDown")) {
				scrollTop = clampScrollTop(scrollTop + Math.max(1, bodyAvail - 1), bodyLines.length, bodyAvail);
			} else if (kb.matches(data, "tui.altScreen.top")) {
				scrollTop = 0;
			} else if (kb.matches(data, "tui.altScreen.bottom")) {
				scrollTop = max;
			}
		},
	};
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
		pressClose: () => "Press Enter, Esc, or Ctrl+C to close",
		pressCloseShort: () => "Esc to close",
		scrollStatus: (v) => `${v.pos}/${v.total} lines · ↑↓ scroll · Enter closes`,
		allCurrencies: () => "Currencies:",
		granted: () => "granted",
		toppedUp: () => "topped up",
		unavailable: () => "Account unavailable (is_available: false).",
		burnRate: (v) => `Burn rate: ${v.rate} ${v.currency}/h (account-wide, last ${v.window})`,
		runway: (v) => `Runway: ~${formatRunway(Number(v.hours))} at the current rate (estimate)`,
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
		pressClose: () => "按 Enter、Esc 或 Ctrl+C 关闭",
		pressCloseShort: () => "Esc 关闭",
		scrollStatus: (v) => `第 ${v.pos}/${v.total} 行 · ↑↓ 滚动 · Enter 关闭`,
		allCurrencies: () => "各币种余额：",
		granted: () => "赠送",
		toppedUp: () => "充值",
		unavailable: () => "账户不可用（is_available: false）。",
		burnRate: (v) => `消耗速率：${v.rate} ${v.currency}/小时（账户级，近 ${v.window}）`,
		runway: (v) => {
			const h = Number(v.hours);
			const unit = h >= 24 ? `${(h / 24).toFixed(1)} 天` : h >= 1 ? `${h.toFixed(1)} 小时` : `${Math.round(h * 60)} 分钟`;
			return `按当前速率约可用 ${unit}（估算）`;
		},
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

export function createSnapshotStore(
	dir: string,
	readFile: (p: string) => string | null,
	appendFile: (p: string, s: string) => void,
	writeFile: (p: string, s: string) => void,
	rename: (from: string, to: string) => void,
): SnapshotStore {
	const file = nodePath.join(dir, "pi-deepseek-balance-snapshots.jsonl");
	// Append-only between compactions: the file is rewritten (atomically:
	// temp + rename) to the newest SNAPSHOT_KEEP entries once it exceeds
	// twice that, so it never grows unboundedly.
	const parseAll = (): Snapshot[] => {
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
		return out;
	};
	return {
		append(snapshot) {
			try {
				const all = parseAll();
				all.push(snapshot);
				if (all.length > SNAPSHOT_KEEP * 2) {
					const kept = all.slice(-SNAPSHOT_KEEP);
					const tmp = `${file}.tmp`;
					writeFile(tmp, kept.map((r) => JSON.stringify(r)).join("\n") + "\n");
					rename(tmp, file);
				} else {
					appendFile(file, JSON.stringify(snapshot) + "\n");
				}
			} catch {
				// Persistence is best-effort; the in-memory view still works.
			}
		},
		load() {
			return parseAll().slice(-SNAPSHOT_KEEP);
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
			lines.push(msg(lang, "runway", { hours }));
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
	// The custom factory option is typed structurally here (the SDK ships its
	// own; we only need the subset pi actually calls at runtime).
	custom?<T>(factory: (tui: unknown, theme: FooterTheme, kb: KeyLike, done: (value: unknown) => void) => T, options?: { overlay?: boolean; overlayOptions?: { maxHeight?: string | number } }): Promise<T>;
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
			await ctx.ui.custom?.((tui: unknown, theme: FooterTheme, kb: KeyLike, done: (value: unknown) => void) => {
				const rowGen = () => (tui as { terminal?: { rows?: number } }).terminal?.rows ?? 24;
				return createOverlayComponent({
					header: msg(lang, "reportTitle"),
					body: text.split("\n"),
					footer: msg(lang, "pressClose"),
					theme,
					kb,
					done,
					rowGen,
					lang,
				});
			}, { overlay: true, overlayOptions: { maxHeight: "80%" } });
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
		(p, s) => {
			try {
				nodeFs.writeFileSync(p, s);
			} catch {
				// best-effort
			}
		},
		(from, to) => {
			try {
				nodeFs.renameSync(from, to);
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
