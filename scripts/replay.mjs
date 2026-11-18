#!/usr/bin/env node
// Offline replay: drives the proxy with request bodies taken from a rollout file
// (read-only — the rollout file itself is never touched), behind a mock upstream.
// Verifies the end-to-end invariants: budget adherence, notice injection, stable frontier,
// idempotent re-send, and that the original bodies come back unmutated.
//
//   node scripts/replay.mjs [--session <id|path>] [--budget N] [--limit N] [--twice]
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.mjs";
import { createProxyServer } from "../src/proxy-server.mjs";
import { detectShape } from "../src/wire.mjs";
import { resolveRolloutFiles, HistoryStore } from "../src/history-store.mjs";

function parseArgs(argv) {
	const args = { session: null, budget: null, limit: Infinity, twice: false };
	for (let index = 0; index < argv.length; index++) {
		const token = argv[index];
		if (token === "--session") args.session = argv[++index];
		else if (token === "--budget") args.budget = Number(argv[++index]);
		else if (token === "--limit") args.limit = Number(argv[++index]);
		else if (token === "--twice") args.twice = true;
	}
	return args;
}

const args = parseArgs(process.argv.slice(2));

// --- mock upstream: records bodies, replies with a provider-shaped JSON answer -------------
const seen = [];
const mock = createServer((req, res) => {
	const chunks = [];
	req.on("data", (chunk) => chunks.push(chunk));
	req.on("end", () => {
		let body = {};
		try {
			body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		} catch {
			// tolerate empty bodies
		}
		seen.push(body);
		const messageChars = (body.messages ?? []).reduce((sum, message) => sum + JSON.stringify(message).length, 0);
		const inputTokens = Math.ceil(messageChars / 4) + 500;
		const shape = detectShape(body);
		const payload = shape === "anthropic"
			? {
				id: "msg_mock", type: "message", role: "assistant", model: body.model ?? "mock",
				content: [{ type: "text", text: "mock reply" }], stop_reason: "end_turn",
				usage: { input_tokens: inputTokens, output_tokens: 8 },
			}
			: {
				id: "chatcmpl-mock", object: "chat.completion", model: body.model ?? "mock",
				choices: [{ index: 0, message: { role: "assistant", content: "mock reply" }, finish_reason: "stop" }],
				usage: { prompt_tokens: inputTokens, completion_tokens: 8, total_tokens: inputTokens + 8 },
			};
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify(payload));
	});
});
await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
const mockPort = mock.address().port;

// --- proxy on an ephemeral port, state/log dirs in a temp folder ---------------------------
const config = await loadConfig();
config.upstream.baseUrl = `http://127.0.0.1:${mockPort}`;
config.enabled = true;
if (args.budget !== null && Number.isSafeInteger(args.budget) && args.budget > 0) {
	config.tokenBudget = args.budget;
	config.budgetTokens = args.budget;
	config.trimToTokens = Math.max(1, Math.floor((args.budget * 5) / 8));
}
const scratch = await mkdtemp(join(tmpdir(), "zcp-replay-"));
config.stateDir = join(scratch, "state");
config.logDir = join(scratch, "logs");

const files = await resolveRolloutFiles(config.rolloutDir, args.session);
if (files.length === 0) {
	console.error(`No rollout files matched session ${args.session ?? "(newest)"} in ${config.rolloutDir}`);
	process.exit(1);
}
const rolloutPath = files[0];
const sessionIdMatch = rolloutPath.match(/model-io-(.+)\.jsonl$/);
const sessionId = sessionIdMatch ? sessionIdMatch[1] : "replay";
const store = new HistoryStore(rolloutPath);
await store.load(); // warms the same parsing path the MCP tools use
// Reconstruct ordered request bodies from the raw lines.
const lines = (await readFile(rolloutPath, "utf8")).split("\n").filter((line) => line.trim() !== "");
const parsedBodies = [];
for (const line of lines) {
	try {
		const entry = JSON.parse(line);
		const body = entry.request?.body;
		if (body && Array.isArray(body.messages) && body.messages.length > 0) parsedBodies.push(body);
	} catch {
		// torn tail line
	}
}

const proxy = createProxyServer(config);
await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
const proxyPort = proxy.address().port;

const post = async (body, includeSession = true) => {
	const payload = JSON.stringify(body);
	const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(includeSession ? { "x-context-paging-session": sessionId } : {}),
			authorization: "Bearer client-key-ignored",
		},
		body: payload,
	});
	const text = await response.text();
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		parsed = null;
	}
	return { status: response.status, parsed };
};

const snapshot = (body) => JSON.stringify(body);

let paged = 0;
let within = 0;
let overflow = 0;
let maxEstimated = 0;
let maxSent = 0;
let failures = 0;
const checked = Math.min(parsedBodies.length, args.limit);
const originals = parsedBodies.slice(0, checked).map(snapshot);

for (let index = 0; index < checked; index++) {
	const body = parsedBodies[index];
	const first = await post(body);
	if (first.status !== 200 || !first.parsed) {
		failures++;
		console.error(`line ${index}: proxy status ${first.status}`);
		continue;
	}
	// What the proxy actually forwarded upstream (recorded by the mock):
	const forwarded = seen.at(-1) ?? {};
	const messages = forwarded.messages ?? [];
	const notice = messages[0]?.content?.[0]?.text ?? messages[0]?.content;
	const mode = notice !== undefined && typeof notice === "string" && notice.startsWith("[Context paging notice") ? "notice-first" : "passthrough-shape";
	const estimate = Math.ceil(messages.reduce((sum, message) => sum + JSON.stringify(message).length, 0) / 4);
	maxSent = Math.max(maxSent, messages.length);
	if (mode === "notice-first") {
		paged++;
		maxEstimated = Math.max(maxEstimated, estimate);
		if (estimate > config.budgetTokens * 1.35) {
			// Estimator vs. internal estimate can drift; only flag gross overshoot.
			failures++;
			console.error(`line ${index}: outgoing estimate ${estimate} far exceeds budget ${config.budgetTokens}`);
		}
		if (messages.length - 1 >= body.messages.length) {
			failures++;
			console.error(`line ${index}: paged request not smaller than original (${messages.length - 1} vs ${body.messages.length})`);
		}
	} else {
		within++;
	}
	// Idempotence + frontier stability: sending the same body again must produce byte-identical output.
	if (args.twice) {
		const beforeCount = seen.length;
		await post(body);
		const forwardedAgain = seen[beforeCount] ?? {};
		if (snapshot(forwardedAgain) !== snapshot(forwarded)) {
			failures++;
			console.error(`line ${index}: re-send produced a different outgoing request`);
		}
	}
	// Original body must be untouched by the proxy.
	if (snapshot(parsedBodies[index]) !== originals[index]) {
		failures++;
		console.error(`line ${index}: original body was mutated`);
	}
}

// A request with no session header routes to "default" and must not throw.
const noSession = await post(parsedBodies[Math.min(2, parsedBodies.length - 1)], false);
if (noSession.status !== 200) failures++;

proxy.close();
mock.close();

console.log(`replay report
  rollout file:    ${rolloutPath}
  session:         ${sessionId}
  budget:          ${config.budgetTokens} (trim to ${config.trimToTokens})
  requests tried:  ${checked}${args.twice ? " (each sent twice)" : ""}
  paged:           ${paged}
  within budget:   ${within}
  max messages sent: ${maxSent} (largest original: ${Math.max(...parsedBodies.slice(0, checked).map((body) => body.messages.length))})
  failures:        ${failures}
  state dir:       ${config.stateDir}`);
process.exitCode = failures === 0 ? 0 : 1;
