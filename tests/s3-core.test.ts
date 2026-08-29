import assert from "node:assert/strict";
import { test } from "node:test";
import {
	parseBalance,
	selectRow,
	estimateBurnRate,
	runwayHours,
	evaluateAlerts,
	parseThresholdsLike,
} from "../extensions/deepseek-balance.ts";

const CNY = (total: number, granted = 0, toppedUp = total) => ({
	currency: "CNY",
	total_balance: String(total),
	granted_balance: String(granted),
	topped_up_balance: String(toppedUp),
});

test("parseBalance: documented shape", () => {
	const b = parseBalance({
		is_available: true,
		balance_infos: [
			{ currency: "CNY", total_balance: "2172.39", granted_balance: "0.00", topped_up_balance: "2172.39" },
		],
	});
	assert.deepEqual(b, { available: true, rows: [{ currency: "CNY", total: 2172.39, granted: 0, toppedUp: 2172.39 }] });
});

test("parseBalance: rejects wrong shapes", () => {
	assert.equal(parseBalance(null), null);
	assert.equal(parseBalance({ is_available: "yes" }), null);
	assert.equal(parseBalance({ is_available: true, balance_infos: "x" }), null);
	assert.equal(parseBalance({ is_available: true, balance_infos: [{ currency: 5 }] }), null);
});

test("selectRow: zero USD never masks positive CNY", () => {
	const b = parseBalance({
		is_available: true,
		balance_infos: [
			{ currency: "USD", total_balance: "0.00", granted_balance: "0.00", topped_up_balance: "0.00" },
			CNY(120.5),
		],
	});
	assert.equal(selectRow(b!)?.currency, "CNY");
	assert.equal(selectRow(b!)?.total, 120.5);
});

test("selectRow: env override wins; falls back sensibly", () => {
	const b = parseBalance({ is_available: true, balance_infos: [CNY(10), { currency: "USD", total_balance: "3.00", granted_balance: "0.00", topped_up_balance: "3.00" }] });
	assert.equal(selectRow(b!, "USD")?.currency, "USD");
	assert.equal(selectRow(b!)?.currency, "CNY");
	const allZero = parseBalance({ is_available: true, balance_infos: [CNY(0), { currency: "EUR", total_balance: "0.00", granted_balance: "0.00", topped_up_balance: "0.00" }] });
	assert.equal(selectRow(allZero!)?.currency, "CNY", "all zero → CNY when present");
});

const H = 3_600_000;
const T0 = Date.UTC(2026, 7, 27, 0, 0, 0);

test("estimateBurnRate: gated below 3 snapshots or 1h span", () => {
	assert.equal(estimateBurnRate([{ t: T0, currency: "CNY", total: 100 }]), null);
	assert.equal(
		estimateBurnRate([
			{ t: T0, currency: "CNY", total: 100 },
			{ t: T0 + 30 * 60_000, currency: "CNY", total: 95 },
			{ t: T0 + 45 * 60_000, currency: "CNY", total: 90 },
		]),
		null,
		"span under 1h",
	);
});

test("estimateBurnRate: linear decline → perHour; top-up resets the window", () => {
	const rate = estimateBurnRate([
		{ t: T0, currency: "CNY", total: 100 },
		{ t: T0 + H, currency: "CNY", total: 90 },
		{ t: T0 + 2 * H, currency: "CNY", total: 80 },
	]);
	assert.ok(rate);
	assert.equal(rate!.currency, "CNY");
	assert.ok(Math.abs(rate!.perHour - 10) < 1e-9);
	// A top-up in the middle: window restarts, still 3+ samples after it.
	const afterTopUp = estimateBurnRate([
		{ t: T0, currency: "CNY", total: 100 },
		{ t: T0 + H, currency: "CNY", total: 200 },
		{ t: T0 + 2 * H, currency: "CNY", total: 190 },
		{ t: T0 + 3 * H, currency: "CNY", total: 180 },
	]);
	assert.ok(afterTopUp);
	assert.ok(Math.abs(afterTopUp!.perHour - 10) < 1e-9, `rate from post-top-up window, got ${afterTopUp!.perHour}`);
});

test("estimateBurnRate: mixed currencies gate to one", () => {
	assert.equal(
		estimateBurnRate([
			{ t: T0, currency: "CNY", total: 100 },
			{ t: T0 + H, currency: "CNY", total: 90 },
			{ t: T0 + 2 * H, currency: "USD", total: 5 },
		]),
		null,
	);
});

test("runwayHours: division and guards", () => {
	assert.ok(Math.abs(runwayHours(90, 10)! - 9) < 1e-9);
	assert.equal(runwayHours(90, 0), null);
});

test("evaluateAlerts: descending crossings emit once; top-up re-arms", () => {
	const th = { warn: 20, error: 5 };
	const s1 = evaluateAlerts(null, "CNY", 30, th);
	assert.equal(s1.emitted.length, 0);
	const s2 = evaluateAlerts(s1.state, "CNY", 15, th);
	assert.deepEqual(s2.emitted.map((e) => e.tier), ["warn"]);
	const s3 = evaluateAlerts(s2.state, "CNY", 3, th);
	assert.deepEqual(s3.emitted.map((e) => e.tier), ["error"], "no repeat warn");
	const s4 = evaluateAlerts(s3.state, "CNY", 25, th);
	assert.equal(s4.emitted.length, 0, "top-up is quiet");
	const s5 = evaluateAlerts(s4.state, "CNY", 10, th);
	assert.deepEqual(s5.emitted.map((e) => e.tier), ["warn"], "re-armed");
});

test("evaluateAlerts: a zero tier is disabled even at total 0", () => {
	const off = evaluateAlerts(null, "CNY", 0, { warn: 0, error: 0 });
	assert.equal(off.emitted.length, 0, "0,0 with total 0 stays silent");
	const real = evaluateAlerts(null, "CNY", 0, { warn: 20, error: 5 });
	assert.deepEqual(real.emitted.map((e) => e.tier), ["error"], "total 0 with real thresholds is error");
});

test("thresholds parsing", () => {
	assert.deepEqual(parseThresholdsLike("20,5"), { warn: 20, error: 5 });
	assert.deepEqual(parseThresholdsLike("5,20"), { warn: 20, error: 5 }, "order-independent");
	assert.deepEqual(parseThresholdsLike(undefined), { warn: 20, error: 5 });
	assert.deepEqual(parseThresholdsLike("bad"), { warn: 20, error: 5 });
	assert.deepEqual(parseThresholdsLike("0,0"), { warn: 0, error: 0 }, "0 disables");
});

test("selectRow: positive CNY beats an earlier positive USD row", () => {
	const b = parseBalance({
		is_available: true,
		balance_infos: [
			{ currency: "USD", total_balance: "3.00", granted_balance: "0.00", topped_up_balance: "3.00" },
			CNY(10),
		],
	});
	assert.equal(selectRow(b!)?.currency, "CNY", "ordering is by rule, not array order");
});

// Captures the role passed to theme.fg so tests can assert footer coloring.
// The dim role is the runway suffix's, not the amount's — filter it out so
// the array pins exactly the amount's role.
const roleProbe = () => {
	const roles: string[] = [];
	return {
		theme: { fg: (role: string, text: string) => { if (role !== "dim") roles.push(role); return text; } },
		roles,
	};
};

const bal0 = (total: number, currency = "CNY") => ({
	available: true,
	rows: [{ currency, total, granted: 0, toppedUp: total }],
});

test("footer color: configured thresholds drive the absolute branch", async () => {
	const { renderFooter } = await import("../extensions/deepseek-balance.ts");
	const th = { warn: 50, error: 10 };
	const p = roleProbe();
	const out = renderFooter(bal0(43), bal0(43).rows[0], { now: 0, theme: p.theme, thresholds: th });
	assert.match(out, /43\.00/);
	assert.ok(p.roles.includes("warning"), "¥43 with warn=50 must be warning");
	const e = roleProbe();
	renderFooter(bal0(8), bal0(8).rows[0], { now: 0, theme: e.theme, thresholds: th });
	assert.ok(e.roles.includes("error"), "¥8 with error=10 must be error");
	const s = roleProbe();
	renderFooter(bal0(60), bal0(60).rows[0], { now: 0, theme: s.theme, thresholds: th });
	assert.ok(s.roles.includes("success"), "¥60 with warn=50 must be success");
});

test("footer color: thresholds apply to the selected row regardless of currency", async () => {
	const { renderFooter } = await import("../extensions/deepseek-balance.ts");
	const th = { warn: 50, error: 10 };
	const p = roleProbe();
	const usd = bal0(43, "USD");
	renderFooter(usd, usd.rows[0], { now: 0, theme: p.theme, thresholds: th });
	assert.ok(p.roles.includes("warning"), "USD row must color like the notification does");
});

test("footer color: 0,0 disables the absolute branch; boundary is inclusive like evaluateAlerts", async () => {
	const { renderFooter } = await import("../extensions/deepseek-balance.ts");
	const off = roleProbe();
	renderFooter(bal0(3), bal0(3).rows[0], { now: 0, theme: off.theme, thresholds: { warn: 0, error: 0 } });
	assert.ok(off.roles.includes("success"), "0,0 keeps a low balance green");
	// The decisive boundary: total == 0 with 0,0 must NOT error (0 means disabled tier).
	const zero = bal0(0);
	const offZero = roleProbe();
	renderFooter(zero, zero.rows[0], { now: 0, theme: offZero.theme, thresholds: { warn: 0, error: 0 } });
	assert.ok(offZero.roles.includes("success"), "total 0 with 0,0 stays green: zero tier is disabled");
	assert.ok(!offZero.roles.includes("error"), "total 0 with 0,0 never errors");
	// With nonzero thresholds, total 0 IS error — that is not a disabled tier.
	const zeroErr = roleProbe();
	renderFooter(zero, zero.rows[0], { now: 0, theme: zeroErr.theme, thresholds: { warn: 20, error: 5 } });
	assert.ok(zeroErr.roles.includes("error"), "total 0 with real thresholds is error");
	// ¥20 with warn=20: evaluateAlerts fires at <= warn; color must agree.
	const edge = roleProbe();
	renderFooter(bal0(20), bal0(20).rows[0], { now: 0, theme: edge.theme, thresholds: { warn: 20, error: 5 } });
	assert.ok(edge.roles.includes("warning"), "total == warn is warning, matching evaluateAlerts");
	const edgeErr = roleProbe();
	renderFooter(bal0(5), bal0(5).rows[0], { now: 0, theme: edgeErr.theme, thresholds: { warn: 20, error: 5 } });
	assert.ok(edgeErr.roles.includes("error"), "total == error is error, matching evaluateAlerts");
});

test("footer color: a rate makes color runway-based, warnings stay threshold-based (by design)", async () => {
	const { renderFooter } = await import("../extensions/deepseek-balance.ts");
	// 4.00 with a 0.2/h rate: 20 h runway → success color, but 4 <= 5 is error for alerts.
	const bal = bal0(4);
	const p = roleProbe();
	const out = renderFooter(bal, bal.rows[0], {
		now: 0,
		theme: p.theme,
		rate: { currency: "CNY", perHour: 0.2 },
		thresholds: { warn: 20, error: 5 },
	});
	assert.ok(p.roles.includes("success"), "runway >= 12h wins over absolute thresholds");
	assert.ok(!p.roles.includes("warning"), "no absolute-threshold colors while a rate exists");
	assert.match(out, /≈ 20\.0h/, `got: ${out}`);
});

test("footer color: defaults stay ¥20 / ¥5 without config", async () => {
	const { renderFooter } = await import("../extensions/deepseek-balance.ts");
	const p = roleProbe();
	renderFooter(bal0(15), bal0(15).rows[0], { now: 0, theme: p.theme });
	assert.ok(p.roles.includes("warning"));
	const e = roleProbe();
	renderFooter(bal0(3), bal0(3).rows[0], { now: 0, theme: e.theme });
	assert.ok(e.roles.includes("error"));
	const s = roleProbe();
	renderFooter(bal0(30), bal0(30).rows[0], { now: 0, theme: s.theme });
	assert.ok(s.roles.includes("success"));
});

test("footer shows a readable runway suffix once a same-currency rate exists", async () => {
	const { renderFooter } = await import("../extensions/deepseek-balance.ts");
	const id = { fg: (_r: string, t: string) => t };
	const bal = { available: true, rows: [{ currency: "CNY", total: 90, granted: 0, toppedUp: 90 }] };
	const withRate = renderFooter(bal, bal.rows[0], { now: 0, theme: id, rate: { currency: "CNY", perHour: 10 } });
	assert.match(withRate, /90\.00 ≈ 9\.0h/, `got: ${withRate}`);
	const noRate = renderFooter(bal, bal.rows[0], { now: 0, theme: id });
	assert.doesNotMatch(noRate, /≈/);
	const wrongCurrency = renderFooter(bal, bal.rows[0], { now: 0, theme: id, rate: { currency: "USD", perHour: 1 } });
	assert.doesNotMatch(wrongCurrency, /≈/);
});

test("footer: currency symbol has breathing room before the bar", async () => {
	const { renderFooter } = await import("../extensions/deepseek-balance.ts");
	const id = { fg: (_r: string, t: string) => t };
	const bal = { available: true, rows: [{ currency: "CNY", total: 90, granted: 0, toppedUp: 90 }] };
	const out = renderFooter(bal, bal.rows[0], { now: 0, theme: id });
	assert.match(out, /^DS ¥ █/, `got: ${out}`);
	assert.doesNotMatch(out, /¥█/, "bar must not touch the symbol");
});

test("snapshot store compacts at 1000 lines to the newest 500", async () => {
	const { createSnapshotStore } = await import("../extensions/deepseek-balance.ts");
	let file = "";
	const store = createSnapshotStore(
		"/fake",
		() => file,
		(_p, s) => { file += s; },
		(_p, s) => { file = s; },
		() => {},
	);
	for (let i = 0; i < 1001; i++) store.append({ t: i, currency: "CNY", total: 1000 - i });
	const lines = file.trim().split("\n");
	assert.equal(lines.length, 500, "compacted");
	assert.equal(JSON.parse(lines[0]).t, 501, "kept the newest");
});
