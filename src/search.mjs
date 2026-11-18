// Recovery search and browse over public history items.
// Ported from navigator.ts of @rochecompaan/pi-context-paging 0.3.11 (MIT, © Roché Compaan).
import { isRecoverableItem } from "./recovery.mjs";
import { isRecoveryToolName } from "./history-store.mjs";

// Ignores punctuation around identifiers but preserves separators inside identifiers and paths.
const TOKEN_PATTERN = /[/\p{L}\p{N}_][\p{L}\p{N}_.\/\\:=+-]*/gu;
const EDGE_NOISE = /[^\p{L}\p{N}_/]+$/u;

export function tokenize(text) {
	const tokens = new Set();
	for (const match of String(text ?? "").toLowerCase().matchAll(TOKEN_PATTERN)) {
		// Trim outer punctuation ("error:", "\"path\"") but keep identifier and path edges.
		const token = match[0].replace(/^[^\p{L}\p{N}_/]+/u, "").replace(EDGE_NOISE, "");
		if (token !== "") tokens.add(token);
	}
	return tokens;
}

function toolNamesOf(item) {
	const names = new Set();
	const raw = item.raw ?? {};
	if (Array.isArray(raw.content)) {
		for (const block of raw.content) {
			if (block?.type === "tool_use" && !isRecoveryToolName(block.name)) names.add(block.name);
		}
	}
	if (Array.isArray(raw.tool_calls)) {
		for (const call of raw.tool_calls) {
			if (call?.function?.name && !isRecoveryToolName(call.function.name)) names.add(call.function.name);
		}
	}
	for (const result of item.toolResults ?? []) {
		if (result.toolName && !isRecoveryToolName(result.toolName)) names.add(result.toolName);
	}
	return names;
}

function hasFailure(item) {
	return (item.toolResults ?? []).some((result) => result.isError === true);
}

function excerptAround(text, terms, radius = 160) {
	const lower = text.toLowerCase();
	let position = -1;
	for (const term of terms) {
		const found = lower.indexOf(term);
		if (found >= 0 && (position === -1 || found < position)) position = found;
	}
	if (position === -1) return text.slice(0, radius * 2) + (text.length > radius * 2 ? "…" : "");
	const start = Math.max(0, position - radius);
	const end = Math.min(text.length, position + radius);
	return (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
}

/**
 * search_history over items. Every query term must appear; tools matches any listed tool;
 * files requires every listed file string; failed keeps only failed tool results.
 */
export function searchHistory(items, params) {
	const query = typeof params.query === "string" ? params.query : "";
	const terms = [...tokenize(query)];
	const files = Array.isArray(params.files) ? params.files : [];
	const tools = Array.isArray(params.tools) ? params.tools.map(String) : [];
	const failed = params.failed === true;
	const limit = Math.min(Math.max(Number.isInteger(params.limit) ? params.limit : 5, 1), 10);
	if (terms.length === 0 && files.length === 0 && tools.length === 0 && !failed) {
		return { references: [], note: "Provide a query or at least one filter." };
	}
	const references = [];
	for (const item of items) {
		if (!isRecoverableItem(item)) continue;
		if (tools.length > 0) {
			const names = toolNamesOf(item);
			if (!tools.some((tool) => [...names].some((name) => name === tool || name.endsWith(`.${tool}`) || name.includes(tool)))) continue;
		}
		if (failed && !hasFailure(item)) continue;
		const text = item.searchText ?? "";
		if (files.length > 0 && !files.every((file) => text.includes(file))) continue;
		if (terms.length > 0) {
			const tokens = tokenize(text);
			if (!terms.every((term) => tokens.has(term) || [...tokens].some((token) => token.includes(term)))) continue;
		}
		references.push({
			historyId: item.id,
			kind: item.kind,
			sequence: item.sequence,
			tools: [...toolNamesOf(item)].slice(0, 5),
			...(terms.length > 0 ? { excerpt: excerptAround(text, terms) } : { excerpt: text.slice(0, 160) }),
		});
		if (references.length >= limit) break;
	}
	return { references };
}

/** browse_history: compact references around an item, by historyId or sequence. */
export function browseHistory(items, params) {
	const direction = params.direction ?? "around";
	const count = Math.min(Math.max(Number.isInteger(params.count) ? params.count : 5, 1), 10);
	const stride = Math.min(Math.max(Number.isInteger(params.stride) ? params.stride : 1, 1), 10);
	let anchor = -1;
	if (params.historyId !== undefined) {
		anchor = items.findIndex((item) => item.id === params.historyId);
		if (anchor < 0) throw new Error(`Unknown history ID ${params.historyId}.`);
	} else if (Number.isInteger(params.sequence)) {
		anchor = params.sequence;
		if (anchor < 0 || anchor >= items.length) throw new Error(`Sequence ${anchor} is out of range.`);
	} else if (items.length > 0) {
		anchor = items.length - 1;
	}
	if (anchor < 0) return { references: [] };
	const indexes = [];
	for (let step = 0; step < count; step++) {
		if (direction === "backward" || direction === "around") {
			const index = anchor - step * stride;
			if (index >= 0) indexes.push(index);
		}
		if (direction === "forward" || direction === "around") {
			const index = anchor + step * stride;
			if (index < items.length) indexes.push(index);
		}
	}
	const unique = [...new Set(indexes)].sort((a, b) => a - b).filter((index) => isRecoverableItem(items[index]));
	return {
		anchor: items[anchor].id,
		references: unique.map((index) => {
			const item = items[index];
			return {
				historyId: item.id,
				kind: item.kind,
				sequence: index,
				preview: (item.searchText ?? "").slice(0, 160),
			};
		}),
	};
}
