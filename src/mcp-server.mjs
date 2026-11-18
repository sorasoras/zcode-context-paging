// MCP stdio server exposing the four recovery tools over ZCode rollout files.
// Wire protocol: newline-delimited JSON-RPC 2.0 (initialize / tools/list / tools/call / ping).
// Session selection: env ZCP_SESSION_ID, else the newest model-io-*.jsonl in the rollout dir.
import { RolloutIdResolver, resolveRolloutFiles, HistoryStore } from "./history-store.mjs";
import { searchHistory, browseHistory } from "./search.mjs";
import {
	readPage, loadItems, partsPage, imageAttachment, publicItem, isRecoverableItem,
	textReply, serialized, fitsTexts, MAXIMUM_HISTORY_ID_CHARACTERS, MAXIMUM_PART_CHARACTERS,
} from "./recovery.mjs";
import { loadConfig } from "./config.mjs";

const SERVER_INFO = { name: "zcode-context-paging", version: "0.1.0" };

const TOOL_DEFINITIONS = [
	{
		name: "search_history",
		description: "search_history finds public recovery references in paged session history. Query previews show context around a matching search term, including public tool output. With load:true, it loads up to three items and lists unloadedHistoryIds. Text replies are capped at 16 KiB; large items return deferred parts and read handles. Follow them with load_history or read_context_output.",
		inputSchema: {
			type: "object", additionalProperties: false,
			properties: {
				query: { type: "string", maxLength: 200 },
				files: { type: "array", maxItems: 10, items: { type: "string", maxLength: 200 } },
				tools: { type: "array", maxItems: 10, items: { type: "string", maxLength: 200 }, description: "Match any listed tool name. Omit or pass an empty list for no tool restriction." },
				failed: { type: "boolean" },
				limit: { type: "integer", minimum: 1, maximum: 10, default: 5 },
				load: { type: "boolean" },
			},
			required: ["query"],
		},
	},
	{
		name: "browse_history",
		description: "browse_history returns compact public recovery references around paged session history. Use load_history for public items or read_context_output for repeated output pages.",
		inputSchema: {
			type: "object", additionalProperties: false,
			properties: {
				historyId: { type: "string", maxLength: MAXIMUM_HISTORY_ID_CHARACTERS },
				sequence: { type: "integer", minimum: 0, maximum: 1_000_000 },
				direction: { type: "string", enum: ["backward", "forward", "around"] },
				count: { type: "integer", minimum: 1, maximum: 10, default: 5 },
				stride: { type: "integer", minimum: 1, maximum: 10, default: 1 },
			},
			required: ["direction"],
		},
	},
	{
		name: "load_history",
		description: "load_history returns public recovery items in requested order within a 16 KiB complete text reply. Items load whole, smallest first, while they fit; the rest return deferred parts and read handles. Follow readParts with read_context_output for additional parts.",
		inputSchema: {
			type: "object", additionalProperties: false,
			properties: {
				historyIds: { type: "array", minItems: 1, maxItems: 3, items: { type: "string", maxLength: MAXIMUM_HISTORY_ID_CHARACTERS } },
			},
			required: ["historyIds"],
		},
	},
	{
		name: "read_context_output",
		description: 'read_context_output reads public history through a part handle or legacy source selector. Default text mode returns a JSON header block, then the page as a second text block: plain text for strings and text blocks, exact JSON for other parts. Pages fill a reply capped at 16 KiB; while more remains, the header has next, the exact arguments for the next read. mode:"parts" pages part descriptions; mode:"image" returns one native image attachment. Private blocks and recovery-tool exchanges are unavailable.',
		inputSchema: {
			type: "object", additionalProperties: false,
			properties: {
				historyId: { type: "string", maxLength: MAXIMUM_HISTORY_ID_CHARACTERS },
				part: { type: "string", maxLength: MAXIMUM_PART_CHARACTERS, description: "Exact public part pointer from a recovery handle." },
				mode: { type: "string", enum: ["text", "parts", "image"] },
				source: { type: "string", enum: ["assistant", "toolResult"] },
				contentIndex: { type: "integer", minimum: 0 },
				toolCallId: { type: "string" },
				offset: { type: "integer", minimum: 0 },
				limit: { type: "integer", minimum: 1, maximum: 16_384, description: "Optional page cap in UTF-16 code units for text mode, or in part descriptions for mode:parts. Omit it to fill the 16 KiB reply." },
			},
			required: ["historyId"],
		},
	},
];

class RecoveryContext {
	constructor(config) {
		this.config = config;
		this.resolver = new RolloutIdResolver(config.rolloutDir);
		this.storeCache = new Map();
	}

	async hint() {
		return process.env.ZCP_SESSION_ID ?? null;
	}

	async store() {
		const hint = await this.hint();
		const files = await resolveRolloutFiles(this.config.rolloutDir, hint);
		const path = files[0];
		if (!path) throw new Error(`No rollout files found in ${this.config.rolloutDir}.`);
		let store = this.storeCache.get(path);
		if (!store) {
			store = new HistoryStore(path);
			this.storeCache.set(path, store);
		}
		return { store, path };
	}

	async items() {
		const { store } = await this.store();
		const history = await store.load();
		return history.items.filter((item) => isRecoverableItem(item));
	}

	itemsById(items) {
		return new Map(items.map((item) => [item.id, item]));
	}
}

function mcpText(texts) {
	return { content: texts.map((text) => ({ type: "text", text })) };
}

function mcpError(message) {
	return { content: [{ type: "text", text: String(message) }], isError: true };
}

async function callTool(context, name, args) {
	if (name === "search_history") {
		const items = await context.items();
		const result = searchHistory(items, args);
		if (args.load && result.references?.length > 0) {
			const byId = context.itemsById(items);
			const ids = result.references.slice(0, 3).map((reference) => reference.historyId);
			const loaded = loadItems(byId, ids);
			return mcpText([serialized({ ...loaded, references: result.references })]);
		}
		return mcpText([serialized(result)]);
	}
	if (name === "browse_history") {
		const items = await context.items();
		return mcpText([serialized(browseHistory(items, args))]);
	}
	if (name === "load_history") {
		const items = await context.items();
		const loaded = loadItems(context.itemsById(items), args.historyIds);
		return mcpText([serialized(loaded)]);
	}
	if (name === "read_context_output") {
		const items = await context.items();
		const byId = context.itemsById(items);
		const item = byId.get(args.historyId);
		if (item === undefined) throw new Error(`Unknown history ID ${args.historyId}.`);
		const mode = args.mode ?? "text";
		if (mode === "text") {
			const page = readPage(item, args);
			const texts = page.text === "" ? [JSON.stringify(page.header)] : [JSON.stringify(page.header), page.text];
			return mcpText(texts);
		}
		if (args.source !== undefined || args.contentIndex !== undefined || args.toolCallId !== undefined) {
			throw new Error("Part-list and image modes do not accept legacy output selectors.");
		}
		if (mode === "parts") {
			if (args.part !== undefined) throw new Error("Part-list mode does not accept a part selector.");
			const view = publicItem(item);
			if (view.kind === "assistant" && !Array.isArray(view.raw.content) && !(view.raw.tool_calls?.length)) {
				throw new Error("This item has no public parts.");
			}
			return mcpText([serialized(partsPage(item, args.offset ?? 0, args.limit))]);
		}
		if (mode === "image") {
			if (args.part === undefined || args.offset !== undefined || args.limit !== undefined) {
				throw new Error("Image mode requires a part handle without text-page bounds.");
			}
			const image = imageAttachment(item, args.part);
			return {
				content: [
					{ type: "image", data: image.data, mimeType: image.mimeType },
					{ type: "text", text: serialized(image.metadata) },
				],
			};
		}
		throw new Error("Unknown recovery read mode.");
	}
	throw new Error(`Unknown tool ${name}.`);
}

export async function serveStdio(config = null, input = process.stdin, output = process.stdout) {
	const resolved = config ?? await loadConfig();
	const context = new RecoveryContext(resolved);
	let buffer = "";
	const respond = (id, result) => {
		if (id === undefined || id === null) return;
		output.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
	};
	const respondError = (id, code, message) => {
		if (id === undefined || id === null) return;
		output.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
	};
	input.setEncoding("utf8");
	input.on("data", (chunk) => {
		buffer += chunk;
		let index;
		while ((index = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, index).trim();
			buffer = buffer.slice(index + 1);
			if (line === "") continue;
			let message;
			try {
				message = JSON.parse(line);
			} catch {
				continue;
			}
			void handleMessage(message);
		}
	});
	async function handleMessage(message) {
		const { id, method, params } = message;
		try {
			switch (method) {
				case "initialize":
					return respond(id, {
						protocolVersion: params?.protocolVersion ?? "2024-11-05",
						capabilities: { tools: {} },
						serverInfo: SERVER_INFO,
					});
				case "ping":
					return respond(id, {});
				case "tools/list":
					return respond(id, { tools: TOOL_DEFINITIONS });
				case "tools/call": {
					const result = await callTool(context, params?.name, params?.arguments ?? {});
					return respond(id, result);
				}
				default:
					if (method?.startsWith("notifications/")) return; // no response for notifications
					return respondError(id, -32601, `Method not found: ${method}`);
			}
		} catch (error) {
			if (id === undefined || id === null) return;
			if (method === "tools/call") return respond(id, mcpError(error?.message ?? error));
			return respondError(id, -32603, String(error?.message ?? error));
		}
	}
	return { close: () => input.destroy() };
}

import { pathToFileURL } from "node:url";
const invokedDirectly = process.argv[1] !== undefined
	&& import.meta.url === pathToFileURL(process.argv[1]).href;
if (process.env.ZCP_MCP_STANDALONE === "1" || invokedDirectly) {
	await serveStdio();
}
