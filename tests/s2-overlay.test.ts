import assert from "node:assert/strict";
import { test } from "node:test";
import {
	visualWidth,
	wrapLines,
	clampScrollTop,
	windowSlice,
	type KeyLike,
} from "../extensions/deepseek-balance.ts";

// ---------------------------------------------------------------------------
// visualWidth — ANSI-aware display width
// ---------------------------------------------------------------------------

const RED = "\x1b[31m";
const RESET = "\x1b[0m";

test("visualWidth: plain ASCII", () => {
	assert.equal(visualWidth("abc"), 3);
	assert.equal(visualWidth(""), 0);
});

test("visualWidth: ANSI codes are zero-width", () => {
	assert.equal(visualWidth(`${RED}abc${RESET}`), 3);
	assert.equal(visualWidth(`${RED}${RESET}`), 0);
});

test("visualWidth: CJK double width", () => {
	assert.equal(visualWidth("余"), 2);
	assert.equal(visualWidth("余额"), 4);
	assert.equal(visualWidth(`${RED}余额${RESET}`), 4);
});

test("visualWidth: emoji are double width", () => {
	assert.equal(visualWidth("💥"), 2);
});

// ---------------------------------------------------------------------------
// wrapLines — wide-line wrapping, grapheme-safe, ANSI-preserving
// ---------------------------------------------------------------------------

test("wrapLines: short lines untouched", () => {
	assert.deepEqual(wrapLines(["abc", "de"], 10), ["abc", "de"]);
});

test("wrapLines: long ASCII wraps without losing characters", () => {
	const out = wrapLines(["abcdefghij"], 4);
	assert.deepEqual(out, ["abcd", "efgh", "ij"]);
	assert.equal(out.join(""), "abcdefghij");
});

test("wrapLines: CJK wraps on visual width, not code-unit count", () => {
	// 5 × 2-width chars in a width-6 line → 3 + 2
	const out = wrapLines(["余余额额余"], 6);
	assert.deepEqual(out, ["余余额", "额余"]);
});

test("wrapLines: ANSI styling reapplied per wrapped segment", () => {
	const styled = `${RED}abcdef${RESET}`;
	const out = wrapLines([styled], 3);
	assert.equal(out.length, 2);
	// Every segment carries the leading style (pi appends its own per-line
	// SGR reset, so trailing resets are not required).
	for (const line of out) {
		assert.match(line, /^\x1b\[31m/);
	}
	// Stripped content still complete
	assert.equal(out.map((l) => l.replace(/\x1b\[[0-9;]*m/g, "")).join(""), "abcdef");
});

test("wrapLines: inline ANSI (mid-line escapes) never split", () => {
	const out = wrapLines([`ab${RED}cd${RESET}ef`], 4);
	assert.equal(out.map((l) => l.replace(/\x1b\[[0-9;]*m/g, "")).join(""), "abcdef");
	// No segment contains a truncated escape fragment: every escape run intact.
	for (const line of out) {
		const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
		assert.equal(line.includes("\x1b[") ? /\x1b\[[0-9;]*m$/.test(line) || /^\x1b\[[0-9;]*m/.test(line) : true, true);
		void stripped;
	}
});

test("wrapLines: every segment's visual width <= width (CJK + ANSI)", () => {
	const line = `${RED}余额混合abc 行 data${RESET}`;
	for (const width of [80, 40, 20, 10]) {
		const out = wrapLines([line], width);
		for (const seg of out) {
			assert.ok(visualWidth(seg) <= width, `width ${width}: ${visualWidth(seg)} > ${width} :: ${JSON.stringify(seg)}`);
		}
		assert.equal(out.map((l) => l.replace(/\x1b\[[0-9;]*m/g, "")).join(""), line.replace(/\x1b\[[0-9;]*m/g, ""), "content preserved");
	}
});

test("visualWidth: OSC-8 hyperlink sequence is zero-width", () => {
	const link = "\x1b]8;;https://example.com\x1b\\text\x1b]8;;\x1b\\";
	assert.equal(visualWidth(link), 4);
});
test("wrapLines: zero/negative width never infinite-loops", () => {
	assert.deepEqual(wrapLines(["abcdef"], 0), ["abcdef"]);
	assert.deepEqual(wrapLines(["abcdef"], -1), ["abcdef"]);
});

// ---------------------------------------------------------------------------
// clampScrollTop / windowSlice — scroll window math
// ---------------------------------------------------------------------------

test("clampScrollTop: clamps to [0, body.length - avail]", () => {
	assert.equal(clampScrollTop(0, 10, 5), 0);
	assert.equal(clampScrollTop(-3, 10, 5), 0);
	assert.equal(clampScrollTop(4, 10, 5), 4);
	assert.equal(clampScrollTop(99, 10, 5), 5, "10-5=5 is the max");
});

test("clampScrollTop: body fits window → 0", () => {
	assert.equal(clampScrollTop(3, 3, 5), 0);
	assert.equal(clampScrollTop(3, 0, 5), 0);
});

test("windowSlice: honors clamped top, reports atEnd", () => {
	const body = ["a", "b", "c", "d", "e", "f"];
	const w = windowSlice(body, 0, 4);
	assert.deepEqual(w.lines, ["a", "b", "c", "d"]);
	assert.equal(w.atEnd, false);
	const end = windowSlice(body, 99, 4);
	assert.deepEqual(end.lines, ["c", "d", "e", "f"]);
	assert.equal(end.atEnd, true);
	const fit = windowSlice(body, 0, 10);
	assert.deepEqual(fit.lines, body);
	assert.equal(fit.atEnd, true, "fits → atEnd");
});

// ---------------------------------------------------------------------------
// KeyLike stub semantics — mirror pi's accepted forms
// ---------------------------------------------------------------------------

function stubKb(codes: Record<string, string[]>): KeyLike {
	return {
		matches(data: string, id: string) {
			return (codes[id] ?? []).includes(data);
		},
	};
}

test("stubKb: mirrors legacy + Kitty forms for confirm/cancel", () => {
	const kb = stubKb({
		"tui.select.confirm": ["\r", "\x1b[13u"],
		"tui.select.cancel": ["\x1b", "\x1b[27u", "\x03", "\x1b[99;5u"],
	});
	assert.ok(kb.matches("\r", "tui.select.confirm"));
	assert.ok(kb.matches("\x1b[13u", "tui.select.confirm"));
	assert.ok(kb.matches("\x1b", "tui.select.cancel"));
	assert.ok(kb.matches("\x1b[27u", "tui.select.cancel"));
	assert.ok(kb.matches("\x03", "tui.select.cancel"));
	assert.ok(kb.matches("\x1b[99;5u", "tui.select.cancel"));
	assert.ok(!kb.matches("x", "tui.select.confirm"));
});

test("createOverlayComponent: output never exceeds the row budget at any width", async () => {
	const { createOverlayComponent } = await import("../extensions/deepseek-balance.ts");
	const kb = { matches: () => false };
	const body = Array.from({ length: 60 }, (_, i) => `row ${i} 余额 long data here`);
	const id = { fg: (_r: string, t: string) => t };
	for (const rows of [6, 9, 12, 25, 50]) {
		const budget = Math.max(1, Math.floor(rows * 0.8));
		for (const width of [80, 40, 20, 10, 5, 3]) {
			const c = createOverlayComponent({
				header: "DeepSeek 余额",
				body,
				footer: "按 Enter、Esc 或 Ctrl+C 关闭",
				theme: id,
				kb,
				done: () => {},
				rowGen: () => rows,
				lang: "zh",
			});
			const out = c.render(width);
			assert.ok(out.length <= budget, `rows=${rows} width=${width}: ${out.length} > ${budget}`);
		}
	}
});

test("createOverlayComponent: resize shrinks the budget live (footer preserved)", async () => {
	const { createOverlayComponent } = await import("../extensions/deepseek-balance.ts");
	const kb = { matches: () => false };
	const body = Array.from({ length: 40 }, (_, i) => `row ${i}`);
	const id = { fg: (_r: string, t: string) => t };
	let rows = 40;
	const c = createOverlayComponent({
		header: "T",
		body,
		footer: "close",
		theme: id,
		kb,
		done: () => {},
		rowGen: () => rows,
		lang: "en",
	});
	rows = 12; // terminal shrinks
	const out = c.render(80);
	const budget = Math.max(1, Math.floor(rows * 0.8));
	assert.ok(out.length <= budget, `after shrink: ${out.length} > ${budget}`);
	assert.match(out.at(-1)!, /close/, "footer still last after shrink");
});
