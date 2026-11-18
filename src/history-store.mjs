// Recovery history over ZCode rollout files: ~/.zcode/cli/rollout/model-io-<sessionId>.jsonl.
// One JSON line per model call with the full request body, the normalized response, and usage.
// IDs are stable: r<line>m<idx> for request messages, r<line>resp for the response message.
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { detectShape, stableHash } from "./wire.mjs";

const RECOVERY_TOOL_NAMES = new Set(["search_history", "browse_history", "load_history", "read_context_output"]);

export function isRecoveryToolName(name) {
	if (typeof name !== "string") return false;
	const bare = name.includes("__") ? name.split("__").at(-1) : name;
	return RECOVERY_TOOL_NAMES.has(bare);
}

function responseAssistantMessage(line) {
	const response = line.response;
	if (!response || (typeof response.text !== "string" || response.text.trim() === "") && !Array.isArray(response.toolCalls)) {
		return undefined;
	}
	const content = [];
	if (typeof response.text === "string" && response.text.trim() !== "") {
		content.push({ type: "text", text: response.text });
	}
	for (const call of response.toolCalls ?? []) {
		const name = call.name ?? call.toolName;
		if (typeof name !== "string") continue;
		content.push({
			type: "tool_use",
			id: call.id ?? call.toolCallId ?? `${name}-${content.length}`,
			name,
			input: call.arguments ?? call.input ?? {},
		});
	}
	return content.length === 0 ? undefined : { role: "assistant", content };
}

/** Builds the deduplicated public timeline and a message-hash → historyId index. */
export function buildHistory(lines) {
	const items = [];
	const byHash = new Map();
	const add = (id, message, shape, lineMeta) => {
		if (message === undefined || message === null) return;
		const hash = stableHash(message);
		if (byHash.has(hash)) return; // identical resend: first-seen id stays stable
		const item = makeItem(id, message, shape, lineMeta);
		if (item === undefined) return;
		items.push(item);
		byHash.set(hash, id);
	};
	lines.forEach((line, lineIndex) => {
		const body = line.request?.body;
		const requestMessages = line.request?.messages;
		// Rollout lines come in two encodings: full snapshots carry request.messages; delta
		// lines carry the new suffix in request.body.messages. Index both; dedup by hash.
		const shape = detectShape(body ?? { messages: requestMessages ?? [] });
		if (Array.isArray(requestMessages) && line.request?.messagesKind === "full") {
			requestMessages.forEach((message, index) => add(`r${lineIndex}f${index}`, message, shape, line));
		}
		if (body && Array.isArray(body.messages)) {
			body.messages.forEach((message, index) => add(`r${lineIndex}m${index}`, message, shape, line));
		}
		add(`r${lineIndex}resp`, responseAssistantMessage(line), shape, line);
	});
	return { items, byHash };
}

function makeItem(id, message, shape, line) {
	const role = message.role;
	if (role === "system") {
		return { id, kind: "system", text: typeof message.content === "string" ? message.content : "", raw: message, shape, line };
	}
	if (role === "user") {
		const text = typeof message.content === "string" ? message.content : (Array.isArray(message.content) ? message.content : [])
			.filter((block) => block && block.type === "text").map((block) => block.text).join("\n");
		const toolResults = (Array.isArray(message.content) ? message.content : [])
			.filter((block) => block && block.type === "tool_result")
			.map((block) => ({
				toolCallId: block.tool_use_id,
				toolName: undefined,
				content: block.content,
				isError: block.is_error === true,
			}));
		return { id, kind: "user", text, toolResults, raw: message, shape, line };
	}
	if (role === "tool") {
		return {
			id, kind: "user", text: "",
			toolResults: [{ toolCallId: message.tool_call_id, toolName: message.name, content: message.content, isError: false }],
			raw: message, shape, line,
		};
	}
	if (role === "assistant") {
		return { id, kind: "assistant", raw: message, shape, line };
	}
	return undefined;
}

// Sequences are assigned positionally in buildHistory after all items are collected.

/** A cached per-file reader. Callers pass an absolute jsonl path. */
export class HistoryStore {
	constructor(path) {
		this.path = path;
		this.cache = null;
	}

	async load(force = false) {
		const info = await stat(this.path).catch(() => null);
		if (!info) throw new Error(`Rollout file not found: ${this.path}`);
		if (!force && this.cache && this.cache.size === info.size && this.cache.mtimeMs === info.mtimeMs) {
			return this.cache.history;
		}
		const text = await readFile(this.path, "utf8");
		const lines = text.split("\n").filter((line) => line.trim() !== "").map((line) => {
			try {
				return JSON.parse(line);
			} catch {
				return null; // tolerate a torn tail write
			}
		}).filter(Boolean);
		const history = buildHistory(lines);
		// Assign chronological sequence numbers and search metadata.
		history.items.forEach((item, index) => {
			item.sequence = index;
			item.searchText = searchTextOf(item);
		});
		this.cache = { size: info.size, mtimeMs: info.mtimeMs, history };
		return history;
	}

	item(items, historyId) {
		return items.find((item) => item.id === historyId);
	}
}

function searchTextOf(item) {
	const parts = [];
	if (item.kind === "user") {
		parts.push(item.text ?? "");
		for (const result of item.toolResults ?? []) parts.push(resultText(result));
	}
	if (item.kind === "assistant") {
		if (typeof item.raw.content === "string") parts.push(item.raw.content);
		const blocks = Array.isArray(item.raw.content) ? item.raw.content : [];
		for (const block of blocks) {
			if (block?.type === "text") parts.push(block.text);
			else if (block?.type === "tool_use" && !isRecoveryToolName(block.name)) {
				parts.push(block.name, JSON.stringify(block.input ?? {}));
			}
		}
		if (item.raw.tool_calls) {
			for (const call of item.raw.tool_calls) {
				if (call?.function && !isRecoveryToolName(call.function.name)) {
					parts.push(call.function.name, String(call.function.arguments ?? ""));
				}
			}
		}
	}
	if (item.kind === "system") parts.push(item.text ?? "");
	return parts.join("\n");
}

export function resultText(result) {
	if (typeof result.content === "string") return result.content;
	if (Array.isArray(result.content)) {
		return result.content.map((block) => {
			if (typeof block === "string") return block;
			if (block?.type === "text") return block.text;
			if (block?.type === "image") return "[image]";
			return JSON.stringify(block);
		}).join("\n");
	}
	return result.content === undefined ? "" : JSON.stringify(result.content);
}

/** Resolves a session id (sess_<uuid>, <uuid>, <hex>, subagent ids) to rollout file paths, newest first. */
export async function resolveRolloutFiles(rolloutDir, sessionHint) {
	const entries = await readdir(rolloutDir).catch(() => []);
	const files = entries.filter((name) => name.startsWith("model-io-") && name.endsWith(".jsonl"));
	if (!sessionHint) {
		const byTime = [];
		for (const name of files) {
			const info = await stat(join(rolloutDir, name)).catch(() => null);
			if (info) byTime.push({ name, mtime: info.mtimeMs });
		}
		byTime.sort((a, b) => b.mtime - a.mtime);
		return byTime.map((entry) => join(rolloutDir, entry.name));
	}
	const hint = String(sessionHint).replace(/^model-io-/, "");
	// Session ids come in spellings: sess_<uuid>, session_<uuid>, or the bare uuid.
	const bare = hint.replace(/^sess(ion)?_?/, "");
	const matches = files.filter((name) => name.includes(hint) || (bare.length >= 8 && name.includes(bare)));
	const byTime = [];
	for (const name of matches) {
		const info = await stat(join(rolloutDir, name)).catch(() => null);
		if (info) byTime.push({ name, mtime: info.mtimeMs });
	}
	byTime.sort((a, b) => b.mtime - a.mtime);
	return byTime.map((entry) => join(rolloutDir, entry.name));
}

/** message-hash → id index for the proxy's resolveId; picks the file matching this session. */
export class RolloutIdResolver {
	constructor(rolloutDir) {
		this.rolloutDir = rolloutDir;
		this.stores = new Map(); // path → HistoryStore
		this.index = null; // { path, size, mtimeMs, byHash }
	}

	async byHash(message) {
		const hash = stableHash(message);
		const index = await this.current();
		return index?.byHash.get(hash);
	}

	async current() {
		const files = await resolveRolloutFiles(this.rolloutDir, this.hint);
		const path = files[0];
		if (!path) return null;
		const info = await stat(path).catch(() => null);
		if (!info) return null;
		if (this.index && this.index.path === path && this.index.size === info.size && this.index.mtimeMs === info.mtimeMs) {
			return this.index;
		}
		let store = this.stores.get(path);
		if (!store) {
			store = new HistoryStore(path);
			this.stores.set(path, store);
		}
		const history = await store.load();
		this.index = { path, size: info.size, mtimeMs: info.mtimeMs, byHash: history.byHash };
		return this.index;
	}

	/** Bind to a specific session (called by the proxy per request). */
	withHint(hint) {
		this.hint = hint;
		return this;
	}
}
