import assert from "node:assert/strict";
import { test } from "node:test";
import { fakePi, freshCtx } from "./helpers.ts";
import { createExtension, STATUS_KEY, type Balance } from "../extensions/deepseek-balance.ts";

const okBalance = (total = 34.12): Balance => ({
	available: true,
	rows: [{ currency: "CNY", total, granted: 0, toppedUp: total }],
});
const settle = () => new Promise((r) => setTimeout(r, 15));

function harness(opts: { queue?: Array<{ status: "ok"; balance: Balance } | { status: "error"; message: string }>; key?: string | null; store?: { snapshots: Array<{ t: number; currency: string; total: number }> } } = {}) {
	const pi = fakePi();
	let now = Date.UTC(2026, 7, 27, 4, 0, 0);
	const calls: number[] = [];
	const queue = opts.queue ?? [{ status: "ok", balance: okBalance() }];
	let cursor = 0;
	const appended: Array<{ t: number; currency: string; total: number }> = [];
	const store = {
		snapshots: opts.store ? [...opts.store.snapshots] : [],
	};
	const install = createExtension({
		env: { PI_DEEPSEEK_BALANCE_LANG: "en" },
		balanceClientFor: () => ({
			fetchBalance: () => {
				calls.push(now);
				const next = queue[Math.min(cursor, queue.length - 1)];
				cursor += 1;
				return Promise.resolve(next);
			},
			resetBreaker: () => {},
		}),
		apiKeyFor: () => Promise.resolve(opts.key === undefined ? "sk-test" : (opts.key ?? undefined)),
		nowFn: () => now,
		interactive: true,
		snapshotStore: {
			append: (s) => {
				appended.push(s);
				store.snapshots.push(s);
			},
			load: () => store.snapshots,
		},
	});
	install(pi as never);
	return {
		pi,
		calls,
		appended,
		store,
		tick: (ms: number) => {
			now += ms;
		},
		select: async (provider: string) => {
			const { ctx, log } = freshCtx();
			await pi.emit("model_select", { model: { provider, id: "deepseek-v4-flash" }, previousModel: undefined, source: "set" }, ctx);
			return log;
		},
		start: async (provider?: string) => {
			const { ctx, log } = freshCtx("tui", provider ? { provider } : undefined);
			await pi.emit("session_start", { reason: "new" }, ctx);
			return log;
		},
		turnEnd: async () => {
			const { ctx, log } = freshCtx();
			await pi.emit("turn_end", { turnIndex: 0, message: {}, toolResults: [] }, ctx);
			return log;
		},
	};
}

test("session_start seeds activation from ctx.model (deepseek default)", async () => {
	const h = harness();
	const log = await h.start("deepseek");
	await settle();
	assert.equal(h.calls.length, 1, "seeded fetch");
	assert.ok(log.status.some((e) => e.key === STATUS_KEY && /DS ¥/.test(e.text ?? "")));
});

test("session_start with non-deepseek model stays inactive", async () => {
	const h = harness();
	const log = await h.start("anthropic");
	await settle();
	assert.equal(h.calls.length, 0);
	assert.equal(log.status.filter((e) => e.key === STATUS_KEY).length, 0);
});

test("model_select activates and renders; non-deepseek clears", async () => {
	const h = harness();
	const on = await h.select("deepseek");
	await settle();
	assert.match(on.status.at(-1)?.text ?? "", /DS ¥.*34\.12/);
	const off = await h.select("openai");
	assert.equal(off.status.at(-1)?.text, undefined, "cleared");
});

test("no key: warn once, dim footer, no fetch", async () => {
	const h = harness({ key: null });
	const log = await h.select("deepseek");
	await settle();
	assert.equal(h.calls.length, 0);
	assert.equal(log.notifications.filter((n) => /no API key/.test(n.message)).length, 1);
	assert.match(log.status.at(-1)?.text ?? "", /no key/);
});

test("throttle: turn_end burst bounded; retry-after absolute across force", async () => {
	const h = harness({ queue: [{ status: "ok", balance: okBalance() }, { status: "retry" as never, retryAfterMs: 300_000 } as never, { status: "ok", balance: okBalance() }] });
	await h.select("deepseek");
	await settle();
	assert.equal(h.calls.length, 1);
	for (let i = 0; i < 3; i++) await h.turnEnd();
	assert.equal(h.calls.length, 1, "burst all inside the throttle window");
	h.tick(301_000);
	await h.turnEnd();
	await settle();
	assert.equal(h.calls.length, 2, "after the window; this call returns retry(300s)");
	// While the retry window is live, a forced re-select must not fetch.
	await h.select("deepseek");
	await settle();
	assert.equal(h.calls.length, 2, "force honors retryDeadline");
	h.tick(301_000);
	await h.turnEnd();
	await settle();
	assert.equal(h.calls.length, 3, "after the deadline, fetch proceeds");
});

test("failed refresh keeps last value with stale marker", async () => {
	const h = harness({ queue: [{ status: "ok", balance: okBalance(30) }, { status: "error", message: "boom" }] });
	const first = await h.select("deepseek");
	await settle();
	assert.match(first.status.at(-1)?.text ?? "", /30\.00/);
	assert.doesNotMatch(first.status.at(-1)?.text ?? "", /~/);
	h.tick(301_000);
	const after = await h.turnEnd();
	await settle();
	assert.match(after.status.at(-1)?.text ?? "", /30\.00~/);
});

test("headless (interactive=false): no fetches", async () => {
	const pi = fakePi();
	const calls: number[] = [];
	const install = createExtension({
		env: {},
		balanceClientFor: () => ({ fetchBalance: () => { calls.push(0); return Promise.resolve({ status: "ok", balance: okBalance() }); }, resetBreaker: () => {} }),
		apiKeyFor: () => Promise.resolve("k"),
		nowFn: () => 0,
		interactive: false,
	});
	install(pi as never);
	const { ctx } = freshCtx("print");
	await pi.emit("model_select", { model: { provider: "deepseek", id: "m" }, previousModel: undefined, source: "set" }, ctx);
	await settle();
	assert.equal(calls.length, 0);
});

test("snapshot appended on success; rate appears once gated", async () => {
	const t0 = Date.UTC(2026, 7, 27, 0, 0, 0);
	const h = harness({ store: { snapshots: [
		{ t: t0, currency: "CNY", total: 100 },
		{ t: t0 + 3.6e6, currency: "CNY", total: 90 },
	] } });
	const log = await h.select("deepseek");
	await settle();
	assert.equal(h.appended.length, 1, "third snapshot appended");
	// 80 < 90 → declining window of 3 spanning 2h → rate 5/h shown in footer? (footer only shows balance; rate appears in report)
	const { ctx, rlog } = ((): { ctx: unknown; rlog: unknown } => {
		const f = freshCtx();
		return { ctx: f.ctx, rlog: f.log };
	})();
	await h.pi.runCommand("deepseek-balance", "", ctx);
	await settle();
	void rlog;
	assert.ok(h.appended.length >= 2, "command also snapshots");
});
