// One-shot migration: point every provider lane through the zcp tunnel,
// billion-context style: http://127.0.0.1:8787/zcp/<original-upstream>.
// Backs up provider_config.json first; skips rules already on the lane.
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";

const ts = new Date().toISOString().replace(/[:.]/g, "-");
const ppath = "C:/Users/Sora/.zcode/v2/provider_config.json";
copyFileSync(ppath, ppath + ".bak-zcp-tunnel-" + ts);

const p = JSON.parse(readFileSync(ppath, "utf8"));
const LANE = "http://127.0.0.1:8787";
const rules = p.config.providerConfigRules.providerRules;
for (const rule of rules) {
	const api = rule.config?.api;
	if (!api || typeof api.baseUrl !== "string" || api.baseUrl === "") continue;
	if (api.baseUrl.includes("/zcp/")) {
		console.log(`skip    ${rule.providerName} — already on the zcp lane`);
		continue;
	}
	// The Deepseek provider was rewired to the bare lane earlier; restore its bili chain
	// so it keeps compression behind the tunnel (verified: 200 through the nested form).
	const target = api.baseUrl === LANE
		? "http://127.0.0.1:18788/bili/https://api.deepseek.com/anthropic"
		: api.baseUrl;
	api.baseUrl = `${LANE}/zcp/${target}`;
	console.log(`rewired ${rule.providerName}`);
	console.log(`        ${api.baseUrl}`);
}
writeFileSync(ppath, JSON.stringify(p, null, 2) + "\n");

// Parse-back + durability check: every new baseUrl must be loopback-rooted so bili's
// SessionStart hook skips it (its unwrap regex is anchored to host+/bili/).
const check = JSON.parse(readFileSync(ppath, "utf8"));
let durable = 0;
for (const rule of check.config.providerConfigRules.providerRules) {
	const url = rule.config?.api?.baseUrl ?? "";
	const loopbackRooted = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/zcp\//.test(url) || url === LANE;
	if (loopbackRooted) durable++;
	else console.log(`NOT DURABLE: ${rule.providerName} -> ${url}`);
}
console.log(`${durable}/${check.config.providerConfigRules.providerRules.length} lanes durable against bili's re-wrap hook`);
console.log("backup:", ppath + ".bak-zcp-tunnel-" + ts);
