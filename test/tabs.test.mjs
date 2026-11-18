import { test, assert, assertEqual } from "./harness.mjs";
import { createProxyServer } from "../src/proxy-server.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

const rolloutLines = [
	JSON.stringify({
		request: { body: { model: "m", system: "sys", messages: [
			{ role: "user", content: [{ type: "text", text: "Find the flubber count in the config." }] },
			{ role: "assistant", content: [
				{ type: "thinking", thinking: "private", signature: "s" },
				{ type: "text", text: "Reading the file." },
				{ type: "tool_use", id: "call_1", name: "read_file", input: { path: "flubber.json" } },
			] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: [{ type: "text", text: "count=42" }] }] },
		] } },
		response: { text: "The count is 42.", toolCalls: [] },
	}),
];

test("monitor tabs: config redaction, rollouts, history search+item, notices, lane ping", async () => {
	const scratch = mkdtempSync(join(tmpdir(), "zcp-tabs-"));
	const stateDir = join(scratch, "state");
	const logDir = join(scratch, "logs");
	const rolloutDir = join(scratch, "rollout");
	mkdirSync(stateDir, { recursive: true });
	mkdirSync(logDir, { recursive: true });
	mkdirSync(rolloutDir, { recursive: true });
	writeFileSync(join(rolloutDir, "model-io-sess_tabdemo.jsonl"), rolloutLines.join("\n") + "\n");
	writeFileSync(join(stateDir, "sess_tabdemo.json"), JSON.stringify({
		frontierIndex: 3, frontierHash: "h", noticeText: "[Context paging notice — older context left the window]", calib: 1,
		stats: { requests: 1, paged: 1, tokensSaved: 100 },
	}));

	// A real local HTTP server as a ping target.
	const probe = createServer((request, response) => { response.writeHead(418); response.end("teapot"); });
	await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
	const probePort = probe.address().port;

	const providerConfig = {
		schemaVersion: 1,
		config: { providerOrder: ["p1"], providerConfigRules: { providerRules: [
			{ providerId: "p1", providerName: "Probed", config: { api: { type: "openai-chat-completions", baseUrl: `http://127.0.0.1:${probePort}/v1` }, modelOrder: ["m"] } },
		] } },
	};
	writeFileSync(join(scratch, "providers.json"), JSON.stringify(providerConfig));

	const config = {
		enabled: true, host: "127.0.0.1", port: 0,
		tokenBudget: 128_000, budgetTokens: 128_000, trimToTokens: 80_000, modelContextWindow: null,
		upstream: { baseUrl: "http://127.0.0.1:9", apiKeyEnv: "ZCP_TEST_KEY", apiKey: null },
		stateDir, logDir, rolloutDir,
		providerConfigPath: join(scratch, "providers.json"),
	};
	process.env.ZCP_TEST_KEY = "super-secret-value";
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
		const cfg = await get("/__zcp/config");
		assertEqual(cfg.json.upstream.apiKeySet, true, "env-provided key is detected");
		assertEqual(cfg.json.upstream.apiKeyEnv, "ZCP_TEST_KEY");
		assert(!JSON.stringify(cfg.json).includes("super-secret-value"), "config endpoint never echoes key material");
		assertEqual(cfg.json.budgetTokens, 128_000);

		const rollouts = await get("/__zcp/rollouts");
		assertEqual(rollouts.json.length, 1);
		assertEqual(rollouts.json[0].sessionId, "sess_tabdemo");
		assert(rollouts.json[0].sizeBytes > 0);

		const recent = await get("/__zcp/history?session=sess_tabdemo&recent=1");
		assert(recent.json.references.length >= 3, "recent items listed newest first");
		assert(recent.json.references[0].sequence > recent.json.references.at(-1).sequence, "newest first");

		const search = await get("/__zcp/history?session=sess_tabdemo&q=flubber+count");
		assertEqual(search.json.references.length, 1);
		assertEqual(search.json.references[0].kind, "user");
		assert(search.json.references[0].excerpt.includes("flubber"));

		const byKind = await get("/__zcp/history?session=sess_tabdemo&q=flubber&kind=assistant");
		assertEqual(byKind.json.references.length, 1, "kind filter keeps only assistant items");
		assertEqual(byKind.json.references[0].kind, "assistant");
		assert(byKind.json.references[0].excerpt.includes("flubber"), "assistant tool_use also matches flubber");

		const item = await get("/__zcp/history/item?session=sess_tabdemo&id=" + encodeURIComponent(recent.json.references.at(-1).historyId));
		assertEqual(item.json.item.kind, "user");
		assert(item.json.item.text.includes("Find the flubber count"));
		assert(item.json.parts.some((part) => part.part === "/user/content"));

		const privateItem = await get("/__zcp/history/item?session=sess_tabdemo&id=" + encodeURIComponent(search.json.references[0].historyId));
		const dumped = JSON.stringify(privateItem.json.item);
		assert(!dumped.includes("private"), "thinking blocks stay out of the web view");

		const notices = await get("/__zcp/notices");
		assertEqual(notices.json.length, 1);
		assert(notices.json[0].noticeText.startsWith("[Context paging notice"));

		const ping = await get("/__zcp/ping?provider=p1");
		assertEqual(ping.json.ok, true, `probe target reachable: ${JSON.stringify(ping.json)}`);
		assertEqual(ping.json.status, 418, "status passes through verbatim");

		const pingBad = await get("/__zcp/ping?provider=nope");
		assert(pingBad.json.error !== undefined, "unknown provider errors cleanly");
	} finally {
		server.close();
		probe.close();
		delete process.env.ZCP_TEST_KEY;
		rmSync(scratch, { recursive: true, force: true });
	}
});

test("within-budget requests bump session counters so the monitor sees all lane traffic", async () => {
	const scratch = mkdtempSync(join(tmpdir(), "zcp-wb-"));
	const stateDir = join(scratch, "state");
	const logDir = join(scratch, "logs");
	mkdirSync(stateDir, { recursive: true });
	mkdirSync(logDir, { recursive: true });
	const config = {
		enabled: true, host: "127.0.0.1", port: 0,
		tokenBudget: 100_000, budgetTokens: 100_000, trimToTokens: 60_000, modelContextWindow: null,
		upstream: { baseUrl: "http://127.0.0.1:9", apiKey: null, apiKeyEnv: null },
		stateDir, logDir,
		rolloutDir: join(scratch, "rollout"),
		providerConfigPath: join(scratch, "providers.json"),
	};
	let respondMode = 0;
	const upstream = createServer((request, response) => {
		const chunks = [];
		request.on("data", (chunk) => chunks.push(chunk));
		request.on("end", () => {
			respondMode += 1;
			const notice = respondMode === 1 ? "within" : "paged";
			// First request: tiny (within budget). Second: huge (forces paging).
			const extra = respondMode === 1 ? "" : " x".repeat(40_000);
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({
				id: "m1", type: "message", role: "assistant", model: "m",
				content: [{ type: "text", text: "reply " + notice + extra }],
				usage: { input_tokens: 100 + respondMode * 900, output_tokens: 5 },
			}));
		});
	});
	await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
	config.upstream.baseUrl = `http://127.0.0.1:${upstream.address().port}`;

	const server = createProxyServer(config);
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const base = `http://127.0.0.1:${server.address().port}`;
	const post = (messages) => fetch(base + "/v1/messages", {
		method: "POST",
		headers: { "content-type": "application/json", "x-api-key": "k", "x-session-id": "wbtest" },
		body: JSON.stringify({ model: "m", max_tokens: 32, messages }),
	});

	try {
		await post([{ role: "user", content: [{ type: "text", text: "tiny" }] }]);
		let state = JSON.parse(readFileSync(join(stateDir, "sess_wbtest.json"), "utf8"));
		assertEqual(state.stats.requests, 1, "within-budget request counted");
		assertEqual(state.stats.paged, 0);
		assertEqual(state.frontierIndex, 0);

		// An evictable completed turn plus the giant active request, so a cut can advance.
		await post([
			{ role: "user", content: [{ type: "text", text: "small-a" }] },
			{ role: "assistant", content: [{ type: "text", text: "ok-a" }] },
			{ role: "user", content: [{ type: "text", text: "big" + " y".repeat(600_000) }] },
		]);
		state = JSON.parse(readFileSync(join(stateDir, "sess_wbtest.json"), "utf8"));
		assertEqual(state.stats.requests, 2, "paged request counted");
		assertEqual(state.stats.paged, 1);
		assert(state.frontierIndex > 0, "frontier advanced");

		const sessions = await (await fetch(base + "/__zcp/sessions")).json();
		assertEqual(sessions.length, 1, "session visible in monitor after within-budget traffic");
		assertEqual(sessions[0].stats.requests, 2);
	} finally {
		server.close();
		upstream.close();
		rmSync(scratch, { recursive: true, force: true });
	}
});
