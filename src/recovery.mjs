// Public-item recovery: exact text and JSON parts under a 16 KiB reply budget, with deferred
// items and read handles. Ported from recovery-response.ts / recovery-loads.ts / output-pages.ts
// of @rochecompaan/pi-context-paging 0.3.11 (MIT, © Roché Compaan).
import { isRecoveryToolName } from "./history-store.mjs";
import { publicAssistantBlocks, toolResultsOf } from "./wire.mjs";

export const MAXIMUM_RECOVERY_REPLY_BYTES = 16_384;
export const MAXIMUM_PAGE_LIMIT = MAXIMUM_RECOVERY_REPLY_BYTES;
export const MAXIMUM_HISTORY_ID_CHARACTERS = 128;
export const MAXIMUM_PART_CHARACTERS = 512;
const MAXIMUM_INLINE_PART_BYTES = 4_096;

export function fitsTexts(texts) {
	return Buffer.byteLength(JSON.stringify({ content: texts.map((text) => ({ type: "text", text })) }), "utf8")
		<= MAXIMUM_RECOVERY_REPLY_BYTES;
}

export function textReply(texts) {
	if (!fitsTexts(texts)) throw new Error("Recovery text reply exceeds the 16 KiB byte limit.");
	return { content: texts.map((text) => ({ type: "text", text })) };
}

export function serialized(payload) {
	const text = JSON.stringify(payload);
	if (text === undefined) throw new Error("Recovery payload could not be serialized.");
	return text;
}

/** Public view of one history item: null slots keep original block indexes, as in the package. */
export function publicItem(item) {
	if (item.kind === "user") {
		const toolResults = (item.toolResults ?? [])
			.filter((result) => !isRecoveryToolName(result.toolName));
		return { ...item, toolResults };
	}
	if (item.kind === "assistant") {
		const blocks = publicAssistantBlocks(item.raw)
			.filter((block) => !(block.type === "tool_use" && isRecoveryToolName(block.name)));
		return { ...item, publicBlocks: blocks };
	}
	return item;
}

export function isRecoverableItem(item) {
	const view = publicItem(item);
	if (view.kind === "user") {
		return (view.text ?? "").trim() !== "" || (view.toolResults ?? []).length > 0;
	}
	if (view.kind === "assistant") {
		return view.publicBlocks.length > 0;
	}
	return (view.text ?? "") !== "";
}

/**
 * Part listing: [{ part, kind, format }] for every public part.
 * Paths: /user/content · /assistant/text[/<i>] · /assistant/block/<i> · /toolResult/<id>[/block/<j>]
 */
export function partsOf(item) {
	const view = publicItem(item);
	const parts = [];
	if (view.kind === "user") {
		if ((view.text ?? "") !== "") {
			parts.push({ part: "/user/content", kind: "user text", format: "text" });
		}
		for (const result of view.toolResults ?? []) {
			const idPart = `/toolResult/${result.toolCallId}`;
			const { format, text } = partText(result.content);
			parts.push({ part: idPart, kind: `tool result${result.isError ? " (error)" : ""}`, format, bytes: Buffer.byteLength(text, "utf8") });
			if (Array.isArray(result.content)) {
				result.content.forEach((block, index) => {
					if (block?.type === "image") {
						parts.push({ part: `${idPart}/block/${index}`, kind: "image", format: "image", mimeType: block.source?.media_type ?? block.mimeType });
					}
				});
			}
		}
		return parts;
	}
	if (view.kind === "assistant") {
		if (Array.isArray(view.raw.content)) {
			const rawBlocks = view.raw.content;
			view.publicBlocks.forEach((block) => {
				const index = rawBlocks.indexOf(block);
				if (block.type === "text") {
					parts.push({ part: `/assistant/text/${index}`, kind: "assistant text", format: "text" });
				} else if (block.type === "tool_use") {
					parts.push({ part: `/assistant/block/${index}`, kind: `tool call ${block.name}`, format: "json" });
				}
			});
		} else {
			// OpenAI shape: string content plus tool_calls.
			if (typeof view.raw.content === "string" && view.raw.content.trim() !== "") {
				parts.push({ part: "/assistant/text", kind: "assistant text", format: "text" });
			}
			(view.raw.tool_calls ?? []).forEach((call, index) => {
				parts.push({ part: `/assistant/block/${index}`, kind: `tool call ${call?.function?.name ?? "?"}`, format: "json" });
			});
		}
		return parts;
	}
	if ((view.text ?? "") !== "") parts.push({ part: "/user/content", kind: "text", format: "text" });
	return parts;
}

/** Resolves a part path to { format, text }: plain text for strings/text blocks, exact JSON otherwise. */
export function partTextOf(item, part) {
	const view = publicItem(item);
	if (part === "/user/content" && view.kind === "user") {
		return { format: "text", text: view.text };
	}
	if (view.kind === "assistant" && (part === "/assistant/text" || part.startsWith("/assistant/text/") || part.startsWith("/assistant/block/"))) {
		return assistantPartText(view, part);
	}
	if (part.startsWith("/toolResult/")) {
		const rest = part.slice("/toolResult/".length);
		const segments = rest.split("/");
		const toolCallId = decodeURIComponent(segments[0]);
		const result = (view.toolResults ?? []).find((candidate) => String(candidate.toolCallId) === toolCallId);
		if (result === undefined) throw new Error(`Unknown tool-result id ${toolCallId.slice(0, 40)}.`);
		if (segments.length === 1) return partText(sanitizeImages(result.content, view.id, part));
		if (segments[1] === "block") {
			const index = Number(segments[2]);
			const block = Array.isArray(result.content) ? result.content[index] : undefined;
			if (block === undefined) throw new Error(`Unknown block index ${index}.`);
			if (block?.type === "image") return imageMetadata(view.id, `${part}`, block);
			return partText(block);
		}
		throw new Error(`Unknown tool-result part ${part}.`);
	}
	throw new Error(`Unknown part ${part}. Use mode "parts" to list public parts.`);
}

function assistantPartText(view, part) {
	if (Array.isArray(view.raw.content)) {
		if (part === "/assistant/text") {
			const text = assistantJoinText(view);
			if (text === null) throw new Error("This assistant item has no public text.");
			return { format: "text", text };
		}
		const index = Number(part.split("/").at(-1));
		const block = view.raw.content[index];
		if (block === undefined) throw new Error(`Unknown assistant block index ${index}.`);
		if (block.type === "text") return { format: "text", text: block.text };
		if (block.type === "tool_use") {
			if (isRecoveryToolName(block.name)) throw new Error("Recovery-tool output is not available. Read the original history item instead.");
			return { format: "json", text: JSON.stringify(block) };
		}
		throw new Error(`Assistant block index ${index} is not public recovery output.`);
	}
	// OpenAI shape: string content plus tool_calls.
	if (part === "/assistant/text") {
		if (typeof view.raw.content !== "string" || view.raw.content.trim() === "") throw new Error("This assistant item has no public text.");
		return { format: "text", text: view.raw.content };
	}
	if (part.startsWith("/assistant/block/")) {
		const index = Number(part.split("/").at(-1));
		const call = (view.raw.tool_calls ?? [])[index];
		if (call === undefined) throw new Error(`Unknown tool-call index ${index}.`);
		if (isRecoveryToolName(call?.function?.name)) throw new Error("Recovery-tool output is not available. Read the original history item instead.");
		let input;
		try {
			input = JSON.parse(call.function.arguments ?? "{}");
		} catch {
			input = { raw: call.function.arguments };
		}
		return { format: "json", text: JSON.stringify({ type: "tool_use", id: call.id, name: call.function.name, input }) };
	}
	throw new Error(`Unknown part ${part}.`);
}

function assistantJoinText(view) {
	const texts = (view.publicBlocks ?? []).filter((block) => block.type === "text");
	if (texts.length === 0) return null;
	return texts.map((block) => block.text).join("\n");
}

function partText(content) {
	if (typeof content === "string") return { format: "text", text: content };
	if (Array.isArray(content) && content.length > 0 && content.every((block) => typeof block === "string" || block?.type === "text")) {
		return {
			format: "text",
			text: content.map((block) => (typeof block === "string" ? block : block.text)).join("\n"),
		};
	}
	if (Array.isArray(content) && content.length === 0) return { format: "text", text: "" };
	return { format: "json", text: JSON.stringify(content) };
}

/** Image blocks become metadata with attachment handles; base64 never enters text pages. */
function sanitizeImages(content, historyId, basePart) {
	if (!Array.isArray(content)) return content;
	if (!content.some((block) => block?.type === "image")) return content;
	return content.map((block, index) => {
		if (block?.type !== "image") return block;
		const source = block.source ?? block;
		return {
			type: "image",
			mimeType: source?.media_type ?? source?.mimeType ?? "unknown",
			handle: { historyId, part: `${basePart}/block/${index}`, mode: "image" },
		};
	});
}

function imageMetadata(historyId, part, block) {
	const source = block.source ?? block;
	return {
		format: "image",
		text: JSON.stringify({
			historyId,
			part,
			type: "image",
			mimeType: source?.media_type ?? source?.mimeType ?? "unknown",
			bytes: Math.floor(((source?.data?.length ?? 0) * 3) / 4),
			read: { historyId, part, mode: "image" },
		}),
	};
}

function splitsSurrogate(text, index) {
	return index > 0 && index < text.length
		&& /[\uD800-\uDBFF]/u.test(text[index - 1]) && /[\uDC00-\uDFFF]/u.test(text[index]);
}

/** One page: JSON header block, then the page text. `next` repeats the exact next-read arguments. */
export function readPage(item, input) {
	const historyId = input.historyId;
	if (historyId.length > MAXIMUM_HISTORY_ID_CHARACTERS) throw new Error(`historyId must be at most ${MAXIMUM_HISTORY_ID_CHARACTERS} characters.`);
	if (input.part !== undefined && input.part.length > MAXIMUM_PART_CHARACTERS) throw new Error(`part must be at most ${MAXIMUM_PART_CHARACTERS} characters.`);
	const offset = input.offset ?? 0;
	if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("offset must be a nonnegative integer.");
	if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > MAXIMUM_PAGE_LIMIT)) {
		throw new Error(`limit must be an integer from 1 to ${MAXIMUM_PAGE_LIMIT}.`);
	}
	const part = input.part ?? defaultPart(item, input);
	const { format, text } = partTextOf(item, part);
	if (offset > text.length) throw new Error("offset exceeds the output length.");
	if (splitsSurrogate(text, offset)) throw new Error("offset splits a Unicode character.");
	const headerAt = (end) => {
		const nextOffset = end < text.length ? end : null;
		const header = { historyId, part, format, offset, nextOffset, totalCharacters: text.length };
		if (nextOffset !== null) header.next = { historyId, part, offset: nextOffset, ...(input.limit !== undefined ? { limit: input.limit } : {}) };
		return { header, text: text.slice(offset, end) };
	};
	const textsOf = (page) => page.text === "" ? [JSON.stringify(page.header)] : [JSON.stringify(page.header), page.text];
	const boundary = (end) => splitsSurrogate(text, end) ? end - 1 : end;
	const fits = (end) => fitsTexts(textsOf(headerAt(boundary(end))));
	const end = Math.min(offset + (input.limit ?? MAXIMUM_PAGE_LIMIT), text.length);
	let low = offset;
	let high = end;
	if (fits(end)) low = end;
	else high = end - 1;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (fits(middle)) low = middle;
		else high = middle - 1;
	}
	low = boundary(low);
	if (low === offset && offset < text.length) throw new Error("limit is too small for the next Unicode character. Increase limit.");
	return headerAt(low);
}

/** Legacy selectors: source assistant/toolResult without an explicit part handle. */
function defaultPart(item, input) {
	if (input.source === "assistant") {
		const parts = partsOf(item).filter((part) => part.kind === "assistant text");
		if (parts.length === 1) return parts[0].part;
		if (input.contentIndex !== undefined) return `/assistant/text/${input.contentIndex}`;
		throw new Error("Assistant output needs contentIndex unless the item has exactly one public text block.");
	}
	if (input.source === "toolResult") {
		const parts = partsOf(item).filter((part) => part.kind.startsWith("tool result"));
		if (parts.length === 1) return parts[0].part;
		if (input.toolCallId !== undefined) return `/toolResult/${encodeURIComponent(input.toolCallId)}`;
		throw new Error("Tool-result output needs toolCallId unless the item has exactly one public tool result.");
	}
	const all = partsOf(item);
	if (all.length === 1) return all[0].part;
	throw new Error("Output requires a part handle or an assistant/toolResult source.");
}

/**
 * load_history: requested items whole, smallest first, while they fit the shared reply budget;
 * the rest deferred with part handles. Requested order is kept in `items`/`deferred`.
 */
export function loadItems(itemsById, historyIds) {
	const requested = historyIds.map((id) => {
		const item = itemsById.get(id);
		if (item === undefined) throw new Error(`Unknown history ID ${id}.`);
		return item;
	});
	const publicViews = requested.map((item) => publicItem(item));
	const whole = (item, view) => JSON.stringify(compactItem(view));
	const order = requested.map((item, index) => index).sort((a, b) => whole(requested[a], publicViews[a]).length - whole(requested[b], publicViews[b]).length);
	const loaded = [];
	const deferred = [];
	let used = 0;
	const budgetFor = (payload) => Buffer.byteLength(JSON.stringify(payload), "utf8");
	const remaining = () => MAXIMUM_RECOVERY_REPLY_BYTES - used;
	for (const index of order) {
		const item = requested[index];
		const view = publicViews[index];
		const wholeJson = whole(item, view);
		if (wholeJson.length <= Math.min(MAXIMUM_INLINE_PART_BYTES, remaining())) {
			loaded.push({ index, item: JSON.parse(wholeJson) });
			used += budgetFor(JSON.parse(wholeJson));
			continue;
		}
		deferred.push({ index, item: deferredItem(item, view) });
	}
	loaded.sort((a, b) => a.index - b.index);
	deferred.sort((a, b) => a.index - b.index);
	return {
		items: loaded.map((entry) => entry.item),
		...(deferred.length > 0 ? { deferred: deferred.map((entry) => entry.item) } : {}),
		loadedIds: loaded.map((entry) => entry.item.id),
		deferredIds: deferred.map((entry) => entry.item.id),
	};
}

function deferredItem(item, view) {
	const descriptions = partsOf(item).slice(0, 8);
	const payload = {
		id: item.id,
		kind: view.kind,
		deferred: true,
		parts: descriptions.map((part) => ({ part: part.part, kind: part.kind, format: part.format, ...(part.mimeType ? { mimeType: part.mimeType } : {}) })),
		totalParts: partsOf(item).length,
	};
	payload.nextPartOffset = descriptions.length < payload.totalParts ? descriptions.length : null;
	payload.readParts = { historyId: item.id, mode: "parts" };
	return payload;
}

/** mode:"parts" listing page, capped by count and the reply budget. */
export function partsPage(item, offset = 0, limit) {
	const parts = partsOf(item).map((part, index) => ({ index: index + offset, ...part }));
	const page = typeof limit === "number" ? parts.slice(0, limit) : parts;
	let selected = [];
	for (const entry of page) {
		const candidate = [...selected, entry];
		if (!fitsTexts([serialized({ historyId: item.id, parts: candidate, totalParts: partsOf(item).length, nextPartOffset: null })])) break;
		selected = candidate;
	}
	return {
		historyId: item.id,
		parts: selected,
		totalParts: partsOf(item).length,
		nextPartOffset: offset + selected.length < partsOf(item).length ? offset + selected.length : null,
		...(offset + selected.length < partsOf(item).length ? { readParts: { historyId: item.id, mode: "parts", offset: offset + selected.length } } : {}),
	};
}

/** mode:"image": metadata plus one native image attachment, never base64 text. */
export function imageAttachment(item, part) {
	const view = publicItem(item);
	let block;
	if (part.startsWith("/toolResult/")) {
		const segments = part.split("/");
		const result = (view.toolResults ?? []).find((candidate) => String(candidate.toolCallId) === decodeURIComponent(segments[2]));
		block = Array.isArray(result?.content) ? result.content[Number(segments.at(-1))] : undefined;
	} else {
		const blocks = Array.isArray(view.raw?.content) ? view.raw.content : [];
		block = blocks.find((candidate) => candidate?.type === "image");
	}
	const source = block?.source ?? block;
	if (!block || block.type !== "image" || typeof source?.data !== "string") {
		throw new Error("The selected public part is not an image.");
	}
	return {
		mimeType: source.media_type ?? source.mimeType ?? "image/png",
		data: source.data,
		metadata: { historyId: item.id, part, bytes: Math.floor((source.data.length * 3) / 4) },
	};
}

function compactItem(view) {
	if (view.kind === "user") {
		return {
			id: view.id,
			kind: "user",
			...(view.text !== "" ? { text: view.text } : {}),
			...(view.toolResults?.length ? { toolResults: view.toolResults.map((result) => compactResult(view.id, result)) } : {}),
		};
	}
	if (view.kind === "assistant") {
		return {
			id: view.id,
			kind: "assistant",
			content: assistantSlots(view),
		};
	}
	return { id: view.id, kind: view.kind, text: view.text };
}

function assistantSlots(view) {
	const raw = view.raw;
	if (!Array.isArray(raw.content)) return view.publicBlocks ?? [];
	const out = [];
	for (const block of raw.content) {
		const publicBlock = (view.publicBlocks ?? []).find((candidate) => candidate === block)
			?? (block?.type === "text"
				? (view.publicBlocks ?? []).find((candidate) => candidate.type === "text" && candidate.text === block.text)
				: undefined);
		if (publicBlock) {
			out.push(publicBlock.type === "text"
				? { type: "text", text: publicBlock.text }
				: { type: "tool_use", id: publicBlock.id, name: publicBlock.name, input: publicBlock.input });
		} else {
			out.push(null); // omitted (private) block keeps its original index
		}
	}
	return out;
}

function compactResult(historyId, result) {
	const { format, text } = partText(result.content);
	const inline = text.length <= MAXIMUM_INLINE_PART_BYTES;
	return {
		toolCallId: result.toolCallId,
		...(result.toolName ? { toolName: result.toolName } : {}),
		...(result.isError ? { isError: true } : {}),
		...(inline ? { content: JSON.parse(JSON.stringify(result.content)) } : {
			deferred: true,
			format,
			totalCharacters: text.length,
			readPart: { historyId, part: `/toolResult/${encodeURIComponent(result.toolCallId)}` },
		}),
	};
}
