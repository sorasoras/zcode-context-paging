#!/usr/bin/env node
// Live functional test for the zcp lane: real DeepSeek through proxy -> bili -> upstream.
// Runs on an isolated port with a small budget so paging engages on a cheap conversation.
//   node scripts/functional-test.mjs [--port 8788] [--budget 1200]
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
	const index = argv.indexOf(name);
	return index >= 0 ? Number(argv[index + 1]) : fallback;
};
const PORT = argOf("--port", 8788);
const BUDGET = argOf("--budget", 1200);
const SESSION_TAG = `zcp-func-${Date.now().toString(36)}`;
const results = [];
let failures = 0;

function record(name, ok, detail) {
	results.push({ name, ok, detail });
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

// --- credentials: reuse the provider store's key, never printed ------------------------------
const providerStore = JSON.parse(readFileSync("C:/Users/Sora/.zcode/v2/provider_config.json", "utf8"));
const activeRule = providerStore.config.providerConfigRules.providerRules
	.find((rule) => rule.providerId === providerStore.config.providerOrder[0]);
const apiKey = activeRule?.config?.access?.apiKey;
if (!apiKey) throw new Error("no api key in active provider rule");

// --- isolated lane ---------------------------------------------------------------------------
const lane = spawn(process.execPath, [join(ROOT, "bin/zcp.mjs"), "serve", "--port", String(PORT), "--budget", String(BUDGET)], {
	stdio: ["ignore", "ignore", "pipe"],
});
let laneErr = "";
lane.stderr.on("data", (chunk) => { laneErr += String(chunk); });

async function waitForHealth(timeoutMs = 8000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`http://127.0.0.1:${PORT}/__zcp/health`);
			if (response.ok) return true;
		} catch { /* not up yet */ }
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	return false;
}

// --- conversation builders -------------------------------------------------------------------
const filler = (index) =>
	`Turn ${index}: inspecting module ${index} for the paging frontier. ` +
	"The loader walks each artifact, records its byte span, and returns a stable handle for later reads. ".repeat(3);

function toolTurns(startIndex, count) {
	const turns = [];
	for (let index = 0; index < count; index++) {
		const t = startIndex + index;
		turns.push({ role: "user", content: [{ type: "text", text: `Please inspect module ${t}.\n${filler(t)}` }] });
		turns.push({
			role: "assistant",
			content: [
				{ type: "text", text: `Reading module ${t}.` },
				{ type: "tool_use", id: `toolu_${t}`, name: "read_file", input: { path: `src/module-${t}.mjs`, limit: 200 } },
			],
		});
		turns.push({
			role: "user",
			content: [{ type: "tool_result", tool_use_id: `toolu_${t}`, content: `module ${t} contents: ${filler(t)}` }],
		});
		turns.push({ role: "assistant", content: [{ type: "text", text: `Module ${t} looks consistent. ${filler(t)}` }] });
	}
	return turns;
}

function conversation(count) {
	return [...toolTurns(0, count), { role: "user", content: [{ type: "text", text: "Reply with exactly: paging-live" }] }];
}

async function post(sessionId, messages, extra = {}) {
	const started = Date.now();
	const response = await fetch(`http://127.0.0.1:${PORT}/v1/messages`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-api-key": apiKey,
			"anthropic-version": "2023-06-01",
			"x-session-id": sessionId,
		},
		body: JSON.stringify({ model: "deepseek-v4-flash", max_tokens: 64, messages, ...extra }),
	});
	const text = await response.text();
	return { status: response.status, text, ms: Date.now() - started };
}

function answerText(raw) {
	try {
		const body = JSON.parse(raw);
		return (body.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join(" ").trim();
	} catch { return ""; }
}

async function lastLogFor(session) {
	// The access log is written when the upstream stream ends, which can trail the client's
	// response by a few ms — wait briefly for the entry instead of racing it.
	const deadline = Date.now() + 3000;
	while (Date.now() < deadline) {
		try {
			const lines = readFileSync(join(ROOT, "logs/access.jsonl"), "utf8").trim().split("\n");
			for (let index = lines.length - 1; index >= 0; index--) {
				if (!lines[index]) continue;
				const entry = JSON.parse(lines[index]);
				if (entry.session === session) return entry;
			}
		} catch { /* no log yet */ }
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return null;
}

function readState(session) {
	try {
		return JSON.parse(readFileSync(join(ROOT, "state", `${session}.json`), "utf8"));
	} catch { return null; }
}

// The proxy's final state save (settle) trails the client's response like the access-log write
// does — poll until the expected condition holds instead of racing it.
async function waitForState(session, condition, timeoutMs = 3000) {
	const deadline = Date.now() + timeoutMs;
	let state = readState(session);
	while (Date.now() < deadline) {
		state = readState(session);
		if (state && condition(state)) return state;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return state;
}

// --- run --------------------------------------------------------------------------------------
try {
	if (!await waitForHealth()) throw new Error(`lane did not start: ${laneErr.slice(0, 400)}`);
	record("lane starts on isolated port", true, `port ${PORT}, budget ${BUDGET} tokens`);

	// 1. short conversation stays within budget and passes through untouched
	const smallTag = `${SESSION_TAG}-small`;
	const smallSession = `sess_${smallTag}`;
	const small = await post(smallTag, conversation(0).slice(-2), {});
	const smallLog = await lastLogFor(smallSession);
	record("within-budget passthrough returns 200", small.status === 200, `${small.ms} ms`);
	record("within-budget sends all messages", smallLog?.mode === "within-budget" && smallLog.originalMessages === smallLog.sentMessages,
		`mode=${smallLog?.mode} ${smallLog?.sentMessages}/${smallLog?.originalMessages}`);
	record("within-budget answer is non-empty", answerText(small.text).length > 0, JSON.stringify(answerText(small.text).slice(0, 40)));

	// 2. oversized conversation is paged
	const bigTag = `${SESSION_TAG}-big`;
	const bigSession = `sess_${bigTag}`;
	const big = conversation(6);
	const bigCall = await post(bigTag, big, {});
	const bigLog = await lastLogFor(bigSession);
	const bigState = readState(bigSession);
	record("paged request returns 200", bigCall.status === 200, `${bigCall.ms} ms`);
	record("paging engages", bigLog?.mode !== "within-budget", `mode=${bigLog?.mode} sent ${bigLog?.sentMessages}/${bigLog?.originalMessages} msgs`);
	record("older turns are actually dropped", (bigLog?.sentMessages ?? 0) < (bigLog?.originalMessages ?? 0),
		`${bigLog?.sentMessages}/${bigLog?.originalMessages}`);
	record("frontier recorded", (bigState?.frontierIndex ?? 0) > 0, `frontierIndex=${bigState?.frontierIndex}`);
	record("paging notice stored", typeof bigState?.noticeText === "string" && bigState.noticeText.includes("zcode-context-paging"),
		`${bigState?.noticeText?.length ?? 0} chars`);
	record("paged answer is non-empty", answerText(bigCall.text).length > 0, JSON.stringify(answerText(bigCall.text).slice(0, 40)));

	// 3. conversation grows by one turn: frontier must hold, not recompute from scratch
	const grown = [
		...big,
		{ role: "assistant", content: [{ type: "text", text: answerText(bigCall.text) || "acknowledged" }] },
		{ role: "user", content: [{ type: "text", text: `Next: check module 6. ${filler(6)}` }] },
	];
	const grownCall = await post(bigTag, grown, {});
	const grownLog = await lastLogFor(bigSession);
	const grownState = await waitForState(bigSession, (state) => (state.stats?.requests ?? 0) >= 2);
	record("grown conversation returns 200", grownCall.status === 200, `${grownCall.ms} ms`);
	record("frontier does not reset", (grownState?.frontierIndex ?? 0) >= (bigState?.frontierIndex ?? 0),
		`${bigState?.frontierIndex} -> ${grownState?.frontierIndex}`);
	record("grown request still paged", grownLog?.mode !== "within-budget", `sent ${grownLog?.sentMessages}/${grownLog?.originalMessages}`);
	record("request counter accumulates", (grownState?.stats?.requests ?? 0) >= 2 && (grownState?.stats?.paged ?? 0) >= 2,
		JSON.stringify(grownState?.stats));

	// 4. streaming passthrough
	const streamTag = `${SESSION_TAG}-stream`;
	const streamSession = `sess_${streamTag}`;
	const streamResponse = await fetch(`http://127.0.0.1:${PORT}/v1/messages`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-api-key": apiKey,
			"anthropic-version": "2023-06-01",
			"x-session-id": streamTag,
		},
		body: JSON.stringify({ model: "deepseek-v4-flash", max_tokens: 48, stream: true, messages: conversation(6) }),
	});
	let sse = "";
	for await (const chunk of streamResponse.body) sse += Buffer.from(chunk).toString("utf8");
	const eventTypes = [...sse.matchAll(/^event: (.+)$/gm)].map((match) => match[1]);
	record("streaming returns 200", streamResponse.status === 200, `content-type=${streamResponse.headers.get("content-type")}`);
	record("streaming delivers SSE events", eventTypes.includes("message_start") && eventTypes.includes("message_stop"),
		`${eventTypes.length} events: ${[...new Set(eventTypes)].join(",")}`.slice(0, 120));
	const streamLog = await lastLogFor(streamSession);
	record("streaming request was paged too", streamLog !== null && streamLog.mode !== "within-budget",
		`mode=${streamLog?.mode} sent ${streamLog?.sentMessages}/${streamLog?.originalMessages}`);
} catch (error) {
	record("functional run", false, String(error?.message ?? error));
} finally {
	lane.kill();
}

console.log(`\n${results.length - failures}/${results.length} checks passed`);
if (failures > 0) process.exitCode = 1;
