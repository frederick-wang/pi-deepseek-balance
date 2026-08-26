/** Live verification helper (dev only — excluded from the npm file whitelist). */
import * as nodeFs from "node:fs";
import * as nodePath from "node:path";
import { createBalanceClient, selectRow, currencySymbol } from "../extensions/deepseek-balance.ts";

const dir = process.env["PI_CODING_AGENT_DIR"] ?? nodePath.join(process.env.HOME ?? "", ".pi", "agent");
let key = process.env["DEEPSEEK_API_KEY"];
if (!key) {
	try {
		const raw = nodeFs.readFileSync(nodePath.join(dir, "auth.json"), "utf8");
		key = (JSON.parse(raw) as Record<string, { key?: string }>)["deepseek"]?.key;
	} catch {
		// no auth.json
	}
}
if (!key) {
	console.error("no API key found (auth.json deepseek entry or DEEPSEEK_API_KEY)");
	process.exit(1);
}
const client = createBalanceClient({ fetchImpl: fetch });
const res = await client.fetchBalance(key);
if (res.status !== "ok") {
	console.error("result:", res.status, "message" in res ? res.message : "");
	process.exit(1);
}
console.log("available:", res.balance.available);
for (const r of res.balance.rows) {
	console.log(`  ${r.currency}  total ${r.total.toFixed(2)}  granted ${r.granted.toFixed(2)}  topped-up ${r.toppedUp.toFixed(2)}`);
}
const row = selectRow(res.balance, process.env["PI_DEEPSEEK_BALANCE_CURRENCY"]);
console.log("selected:", row ? `${row.currency} ${currencySymbol(row.currency)}${row.total.toFixed(2)}` : "(none)");
