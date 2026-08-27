import assert from "node:assert/strict";
import { test } from "node:test";
import { fakePi, freshCtx, invokeOverlay, press } from "./helpers.ts";
import { createExtension, type Balance } from "../extensions/deepseek-balance.ts";

const okBalance = (total = 34.12): Balance => ({
	available: true,
	rows: [{ currency: "CNY", total, granted: 0, toppedUp: total }],
});

function harness() {
	const pi = fakePi();
	const install = createExtension({
		env: { PI_DEEPSEEK_BALANCE_LANG: "en" },
		balanceClientFor: () => ({
			fetchBalance: () => Promise.resolve({ status: "ok" as const, balance: okBalance() }),
			resetBreaker: () => {},
		}),
		apiKeyFor: () => Promise.resolve("sk-test"),
		interactive: true,
	});
	install(pi as never);
	return pi;
}

/** Run /deepseek-balance in a fresh TUI ctx and return its captured overlay. */
async function runOverlay(pi: ReturnType<typeof fakePi>, args = "") {
	const { ctx, log } = freshCtx("tui");
	await pi.runCommand("deepseek-balance", args, ctx);
	return log;
}

// ---------------------------------------------------------------------------
// Contract regression: the bug that shipped — render returned a joined string.
// ---------------------------------------------------------------------------

test("overlay render returns string[] (not a joined string)", async () => {
	const pi = harness();
	const log = await runOverlay(pi);
	assert.equal(log.customCalls, 1);
	const comp = log.overlay!.component!;
	const out = comp.render(80);
	assert.ok(Array.isArray(out), "render must return an array");
	for (const line of out) assert.ok(!line.includes("\n"), "no embedded newlines");
});

test("overlay custom() receives overlay:true and maxHeight options", async () => {
	const pi = harness();
	const log = await runOverlay(pi);
	assert.equal(log.overlay!.options?.overlay, true);
	assert.equal(log.overlay!.options?.overlayOptions?.maxHeight, "80%");
});

test("--json path uses the same scrollable overlay", async () => {
	const pi = harness();
	const log = await runOverlay(pi, "--json");
	assert.equal(log.customCalls, 1, "TUI --json goes through the overlay too");
	const out = log.overlay!.component!.render(80);
	assert.ok(Array.isArray(out), "json overlay render returns array");
});

// ---------------------------------------------------------------------------
// Keys: Enter / Esc / Ctrl+C in legacy and Kitty encodings; no double-resolve.
// ---------------------------------------------------------------------------

test("overlay closes on Enter (legacy + Kitty CSI-u)", async () => {
	for (const key of ["\r", "\n", "\x1b[13u", "\x1bOM"]) {
		const pi = harness();
		const log = await runOverlay(pi);
		press(log, key);
		assert.equal(log.overlay!.doneCalls, 1, `key ${JSON.stringify(key)}`);
	}
});

test("overlay closes on Esc and Ctrl+C (legacy + Kitty CSI-u)", async () => {
	for (const key of ["\x1b", "\x1b[27u", "\x03", "\x1b[99;5u"]) {
		const pi = harness();
		const log = await runOverlay(pi);
		press(log, key);
		assert.equal(log.overlay!.doneCalls, 1, `key ${JSON.stringify(key)}`);
	}
});

test("repeated close keys do not double-resolve", async () => {
	const pi = harness();
	const log = await runOverlay(pi);
	press(log, "\r");
	press(log, "\r");
	press(log, "\x1b[27u");
	assert.equal(log.overlay!.doneCalls, 1);
});

// ---------------------------------------------------------------------------
// Chrome: title exactly once, footer always last, status line when needed.
// ---------------------------------------------------------------------------

test("report title appears exactly once; footer is always the last line", async () => {
	const pi = harness();
	const log = await runOverlay(pi);
	const out = invokeOverlay(log);
	const titles = out.filter((l) => l.includes("DeepSeek Balance"));
	assert.equal(titles.length, 1, `title lines: ${JSON.stringify(out)}`);
	assert.match(out.at(-1)!, /close/, "footer last");
});

test("short body (fits window): no status line, all lines present", async () => {
	const pi = harness();
	const log = await runOverlay(pi);
	const out = invokeOverlay(log, 80);
	assert.ok(!out.some((l) => /lines ·/.test(l)), "no status line when body fits");
	assert.ok(out.some((l) => /CNY/i.test(l)), "currency row present");
});

test("long body (exceeds window): every line reachable by scrolling; footer always last", async () => {
	const pi = harness();
	const log = await runOverlay(pi, "--json");
	const comp = log.overlay!.component!;
	const budget = Math.max(1, Math.floor(log.overlay!.rows * 0.8));
	// Render at several widths — output must never exceed the pi-side budget.
	for (const width of [80, 40, 20, 10]) {
		const out = comp.render(width);
		assert.ok(out.length <= budget, `width ${width}: ${out.length} > ${budget}`);
	}
	// Scrolling must actually move the window: compare consecutive renders.
	const before = comp.render(40);
	press(log, "\x1b[6~"); // PageDown
	const after = comp.render(40);
	assert.notDeepEqual(before, after, "status/body changed after PageDown");
	// At the end: footer last, status at end.
	press(log, "\x1b[F"); // End
	const outEnd = comp.render(40);
	assert.match(outEnd.at(-1)!, /close/);
	assert.ok(outEnd.some((l) => /lines ·/.test(l)), "status line present when overflowing");
});

test("scrolling: ↑↓ move one row; Home returns to top; End never exceeds max", async () => {
	const pi = harness();
	const log = await runOverlay(pi, "--json");
	const comp = log.overlay!.component!;
	// Body window = render output minus chrome: skip header(1) + blank(1),
	// then everything up to (but not including) the closing chrome suffix.
	// Suffix layout: [body...][blank][status][blank][footer] (status present)
	// or [body...][blank][footer] (status absent).
	const bodyWindow = () => {
		const out = comp.render(80);
		const hasStatus = /lines ·/.test(out[out.length - 3] ?? "");
		const chromeTail = hasStatus ? 4 : 2; // [blank][status][blank][footer] | [blank][footer]
		return out.slice(2, out.length - chromeTail);
	};
	const top = bodyWindow();
	press(log, "\x1b[A"); // Up at top: stays
	assert.deepEqual(bodyWindow(), top, "up at top is a no-op");
	press(log, "\x1b[B"); // Down one row
	const oneDown = bodyWindow();
	assert.notDeepEqual(oneDown, top, "down moves the body window");
	press(log, "\x1b[A"); // Up one row: back
	assert.deepEqual(bodyWindow(), top, "up returns exactly one row");
	press(log, "\x1b[H"); // Home
	assert.deepEqual(bodyWindow(), top, "home returns to top");
	for (let i = 0; i < 200; i++) press(log, "\x1b[B"); // hammer down
	const bottom = bodyWindow();
	assert.match(comp.render(80).at(-1)!, /close/, "footer last after hammering down");
	press(log, "\x1b[F"); // End at bottom
	assert.deepEqual(bodyWindow(), bottom, "end at bottom is stable (no overshoot)");
	// Content-completeness invariant: walking down from the top visits every
	// scroll position — each window head is a distinct body row (a skipped
	// row would mean truncation). With 21 rows and a 13-row window there are
	// 9 positions; the walk must visit each exactly.
	press(log, "\x1b[H");
	const firsts = new Set<string>();
	for (let i = 0; i < 200; i++) {
		firsts.add(bodyWindow()[0] ?? "");
		press(log, "\x1b[B");
	}
	const statusLine = comp.render(80).find((l) => /lines ·/.test(l));
	const m = statusLine?.match(/(\d+)\/(\d+) lines/);
	if (m) {
		const total = Number(m[2]);
		const winLen = bodyWindow().length;
		const positions = Math.max(1, total - winLen + 1);
		assert.equal(firsts.size, positions, `each scroll position visited; got ${firsts.size} of ${positions}`);
	}
	// End window is stable: twice pressing End yields the same window.
	press(log, "\x1b[F");
	const end1 = bodyWindow();
	press(log, "\x1b[F");
	assert.deepEqual(bodyWindow(), end1, "end is stable");
});

// ---------------------------------------------------------------------------
// invalidate — theme refresh is real (render recomputes with the theme).
// ---------------------------------------------------------------------------

test("invalidate + render reflects a changed theme (mutated theme object)", async () => {
	const pi = fakePi();
	const theme = { fg: (role: string, t: string) => (role === "accent" ? `AC(${t})` : t) };
	const install = createExtension({
		env: { PI_DEEPSEEK_BALANCE_LANG: "en" },
		balanceClientFor: () => ({
			fetchBalance: () => Promise.resolve({ status: "ok" as const, balance: okBalance() }),
			resetBreaker: () => {},
		}),
		apiKeyFor: () => Promise.resolve("sk-test"),
		interactive: true,
	});
	install(pi as never);
	const { ctx, log } = freshCtx("tui");
	ctx.ui.theme = theme;
	await pi.runCommand("deepseek-balance", "", ctx);
	const out1 = invokeOverlay(log);
	assert.ok(out1.some((l) => l.includes("AC(DeepSeek Balance)")), `accent applied: ${JSON.stringify(out1)}`);
	// Mutate the SAME theme object (as pi's theme controller does on switch)
	// and validate that render (after invalidate) picks it up.
	theme.fg = (role: string, t: string) => (role === "accent" ? `NEW(${t})` : t);
	const comp = log.overlay!.component!;
	comp.invalidate();
	const out2 = comp.render(80);
	assert.ok(out2.some((l) => l.includes("NEW(DeepSeek Balance)")), `theme change reflected: ${JSON.stringify(out2)}`);
});

test("colored theme: narrow widths never emit ANSI fragments", async () => {
	const pi = fakePi();
	const theme = { fg: (role: string, t: string) => `\x1b[38;2;90;28;128m${t}\x1b[0m` };
	const install = createExtension({
		env: { PI_DEEPSEEK_BALANCE_LANG: "en" },
		balanceClientFor: () => ({
			fetchBalance: () => Promise.resolve({ status: "ok" as const, balance: okBalance() }),
			resetBreaker: () => {},
		}),
		apiKeyFor: () => Promise.resolve("sk-test"),
		interactive: true,
	});
	install(pi as never);
	const { ctx, log } = freshCtx("tui");
	ctx.ui.theme = theme;
	await pi.runCommand("deepseek-balance", "", ctx);
	const comp = log.overlay!.component!;
	for (const width of [40, 20, 12, 8, 5, 3]) {
		const out = comp.render(width);
		for (const line of out) {
			// After removing complete SGR sequences, no ESC may remain: any
			// leftover byte means a fragmented escape sequence escaped.
			const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
			assert.ok(!stripped.includes("\x1b"), `width ${width}: fragmented escape: ${JSON.stringify(line)}`);
		}
	}
});
