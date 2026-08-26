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

test("footer shows a readable runway suffix once a same-currency rate exists", async () => {
	const { renderFooter } = await import("../extensions/deepseek-balance.ts");
	const id = { fg: (_r: string, t: string) => t };
	const bal = { available: true, rows: [{ currency: "CNY", total: 90, granted: 0, toppedUp: 90 }] };
	const withRate = renderFooter(bal, bal.rows[0], { now: 0, theme: id, rate: { currency: "CNY", perHour: 10 } });
	assert.match(withRate, /90\.00 ≈9\.0h/, `got: ${withRate}`);
	const noRate = renderFooter(bal, bal.rows[0], { now: 0, theme: id });
	assert.doesNotMatch(noRate, /≈/);
	const wrongCurrency = renderFooter(bal, bal.rows[0], { now: 0, theme: id, rate: { currency: "USD", perHour: 1 } });
	assert.doesNotMatch(wrongCurrency, /≈/);
});
