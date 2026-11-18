import { test, assert, assertEqual } from "./harness.mjs";
import { createProxyServer } from "../src/proxy-server.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("monitor endpoints serve stats, sessions, log, lanes, and the GUI", async () => {
	const scratch = mkdtempSync(join(tmpdir(), "zcp-monitor-"));
	const stateDir = join(scratch, "state");
	const logDir = join(scratch, "logs");
	mkdirSync(stateDir, { recursive: true });
	mkdirSync(logDir, { recursive: true });
	writeFileSync(join(stateDir, "sess_demo.json"), JSON.stringify({
		frontierIndex: 42, frontierHash: "h", noticeText: "[Context paging notice x]", calib: 1.05,
		stats: { requests: 3, paged: 2, tokensSaved: 1500 },
	}));
	writeFileSync(join(logDir, "access.jsonl"), [
		JSON.stringify({ ts: "2026-11-19T10:00:00Z", session: "sess_demo", mode: "paged", originalMessages: 30, sentMessages: 6, estimatedTokens: 900, evictedTokens: 1200, promptTokens: 42_000, cacheReadTokens: 40_000, durationMs: 800, status: 200, upstream: "127.0.0.1:18788" }),
		JSON.stringify({ ts: "2026-11-19T10:00:05Z", session: "sess_demo", mode: "within-budget", originalMessages: 4, sentMessages: 4, estimatedTokens: 300, durationMs: 500, status: 200, upstream: "127.0.0.1:18788" }),
		"not json at all",
	].join("\n") + "\n");
	const providerConfig = {
		schemaVersion: 1,
		config: {
			providerOrder: ["p1"],
			providerConfigRules: { providerRules: [
				{ providerId: "p1", providerName: "Demo", config: { api: { type: "anthropic-messages", baseUrl: "http://127.0.0.1:8787/zcp/http://127.0.0.1:18788/bili/https://api.example.com/anthropic" }, modelOrder: ["demo-model"] } },
				{ providerId: "p2", providerName: "Direct", config: { api: { type: "openai-chat-completions", baseUrl: "https://api.example.com/v1" }, modelOrder: ["m2"] } },
			] },
		},
	};
	writeFileSync(join(scratch, "providers.json"), JSON.stringify(providerConfig));

	const config = {
		enabled: true,
		host: "127.0.0.1",
		port: 0,
		budgetTokens: 128_000,
		trimToTokens: 80_000,
		upstream: { baseUrl: "http://127.0.0.1:9" },
		stateDir,
		logDir,
		providerConfigPath: join(scratch, "providers.json"),
		rolloutDir: join(scratch, "nonexistent-rollout"),
	};
	const server = createProxyServer(config);
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const base = `http://127.0.0.1:${server.address().port}`;
	const get = async (path) => {
		const response = await fetch(base + path);
		const text = await response.text();
		try { return { status: response.status, json: JSON.parse(text) }; }
		catch { return { status: response.status, text }; }
	};

	try {
		const health = await get("/__zcp/health");
		assertEqual(health.json.ok, true);
		assert(Number.isFinite(health.json.uptimeSec));

		const gui = await fetch(base + "/__zcp/gui");
		const html = await gui.text();
		assertEqual(gui.headers.get("content-type").includes("text/html"), true);
		assert(html.includes("zcp monitor") && html.includes("/__zcp/stats"), "GUI page served with links");

		const root = await fetch(base + "/");
		assertEqual((await root.text()).includes("zcp monitor"), true, "bare origin serves the GUI");

		const sessions = await get("/__zcp/sessions");
		assertEqual(sessions.json.length, 1);
		assertEqual(sessions.json[0].sessionId, "sess_demo");
		assertEqual(sessions.json[0].frontierIndex, 42);
		assertEqual(sessions.json[0].noticeChars, "[Context paging notice x]".length);
		assertEqual(sessions.json[0].stats.tokensSaved, 1500);

		const log = await get("/__zcp/log?limit=10");
		assertEqual(log.json.length, 2, "torn line skipped");
		assertEqual(log.json[0].mode, "paged", "file order is chronological, oldest first");
		assertEqual(log.json[1].mode, "within-budget");
		assertEqual(log.json[1].upstream, "127.0.0.1:18788");

		const lanes = await get("/__zcp/lanes");
		assertEqual(lanes.json.length, 2);
		assertEqual(lanes.json[0].lane, "zcp");
		assertEqual(lanes.json[0].upstream, "http://127.0.0.1:18788/bili/https://api.example.com/anthropic");
		assertEqual(lanes.json[0].active, true);
		assertEqual(lanes.json[1].lane, "direct");

		const stats = await get("/__zcp/stats");
		assertEqual(stats.json.logRequests, 2);
		assertEqual(stats.json.byMode.paged, 1);
		assertEqual(stats.json.byMode["within-budget"], 1);
		assertEqual(stats.json.promptTotal, 42_000);
		assertEqual(stats.json.cacheReadTotal, 40_000);
		assertEqual(stats.json.evictedTotal, 1200);
		assertEqual(stats.json.sessionsSeen, 1);
		assertEqual(stats.json.budgetTokens, 128_000);
	} finally {
		server.close();
		rmSync(scratch, { recursive: true, force: true });
	}
});
