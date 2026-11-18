#!/usr/bin/env node
// End-to-end probe of the recovery MCP server against the REAL rollout dir (read-only).
// Speaks newline-delimited JSON-RPC over a PassThrough, like a real MCP client would.
import { PassThrough } from "node:stream";
import { serveStdio } from "../src/mcp-server.mjs";
import { resolveRolloutFiles } from "../src/history-store.mjs";
import { loadConfig } from "../src/config.mjs";

const session = process.argv[2] ?? null;
const config = await loadConfig();
if (session) process.env.ZCP_SESSION_ID = session;

const input = new PassThrough();
const output = new PassThrough();
let buffer = "";
const pending = new Map();
let nextId = 1;

output.setEncoding("utf8");
output.on("data", (chunk) => {
	buffer += chunk;
	let index;
	while ((index = buffer.indexOf("\n")) >= 0) {
		const line = buffer.slice(0, index).trim();
		buffer = buffer.slice(index + 1);
		if (line === "") continue;
		const message = JSON.parse(line);
		if (message.id !== undefined && pending.has(message.id)) {
			pending.get(message.id)(message);
			pending.delete(message.id);
		}
	}
});

const call = (method, params) => new Promise((resolve) => {
	const id = nextId++;
	pending.set(id, resolve);
	input.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
});

await serveStdio(config, input, output);

const init = await call("initialize", { protocolVersion: "2024-11-05" });
console.log("server:", init.result?.serverInfo);

const tools = await call("tools/list", {});
console.log("tools:", tools.result?.tools?.map((tool) => tool.name).join(", "));

const search = await call("tools/call", { name: "search_history", arguments: { query: "context paging", limit: 3 } });
const searchPayload = JSON.parse(search.result?.content?.[0]?.text ?? "{}");
console.log("search hits:", (searchPayload.references ?? []).length);
for (const reference of (searchPayload.references ?? []).slice(0, 3)) {
	console.log(`  ${reference.historyId} (${reference.kind}) seq=${reference.sequence}: ${reference.excerpt.slice(0, 90).replace(/\n/g, " ")}`);
}

const browse = await call("tools/call", { name: "browse_history", arguments: { direction: "backward", count: 3 } });
const browsePayload = JSON.parse(browse.result?.content?.[0]?.text ?? "{}");
console.log("browse refs:", (browsePayload.references ?? []).length);

const firstId = searchPayload.references?.[0]?.historyId;
if (firstId) {
	const load = await call("tools/call", { name: "load_history", arguments: { historyIds: [firstId] } });
	const loadPayload = JSON.parse(load.result?.content?.[0]?.text ?? "{}");
	const loaded = loadPayload.items?.[0];
	console.log("load:", loaded?.id, "kind:", loaded?.kind, "text chars:", (loaded?.text ?? loaded?.content ?? "").length || (loaded?.text ? loaded.text.length : 0));
	const read = await call("tools/call", { name: "read_context_output", arguments: { historyId: firstId, part: loaded?.kind === "user" ? "/user/content" : "/assistant/text" } });
	const header = JSON.parse(read.result?.content?.[0]?.text ?? "{}");
	console.log("read header:", JSON.stringify({ part: header.part, format: header.format, offset: header.offset, totalCharacters: header.totalCharacters, nextOffset: header.nextOffset }));
	if (read.result?.content?.[1]) console.log("page head:", read.result.content[1].text.slice(0, 90).replace(/\n/g, " "));
}

const badRead = await call("tools/call", { name: "read_context_output", arguments: { historyId: "does-not-exist" } });
console.log("unknown id → isError:", badRead.result?.isError === true);

const files = await resolveRolloutFiles(config.rolloutDir, session);
console.log("rollout files:", files.length, "| newest:", files[0]?.split(/[\\/]/).at(-1));
process.exit(0);
