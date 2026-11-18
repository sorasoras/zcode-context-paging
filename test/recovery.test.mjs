import { test, assert, assertEqual, throws } from "./harness.mjs";
import { buildHistory, resultText, isRecoveryToolName } from "../src/history-store.mjs";
import {
	publicItem, partsOf, partTextOf, readPage, loadItems, partsPage, imageAttachment,
	fitsTexts, textReply, isRecoverableItem, MAXIMUM_RECOVERY_REPLY_BYTES,
} from "../src/recovery.mjs";

function lines() {
	return [
		{
			request: { body: {
				model: "m", system: "sys",
				messages: [
					{ role: "user", content: [{ type: "text", text: "Find the flubber count." }] },
					{ role: "assistant", content: [
						{ type: "thinking", thinking: "private reasoning", signature: "s" },
						{ type: "text", text: "Reading the file." },
						{ type: "tool_use", id: "call_1", name: "read_file", input: { path: "flubber.json" } },
					] },
					{ role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: [{ type: "text", text: "count=42" }] }] },
				],
			} },
			response: { text: "The count is 42.", toolCalls: [] },
		},
		{
			request: { body: {
				model: "m", system: "sys",
				messages: [
					{ role: "user", content: [{ type: "text", text: "Find the flubber count." }] },
					{ role: "assistant", content: [
						{ type: "thinking", thinking: "private reasoning", signature: "s" },
						{ type: "text", text: "Reading the file." },
						{ type: "tool_use", id: "call_1", name: "read_file", input: { path: "flubber.json" } },
					] },
					{ role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: [{ type: "text", text: "count=42" }] }] },
					{ role: "assistant", content: [{ type: "text", text: "The count is 42." }] },
					{ role: "user", content: [{ type: "text", text: "Now the widget." }] },
				],
			} },
			response: { text: "", toolCalls: [{ id: "call_2", name: "read_file", arguments: { path: "widget.json" } }] },
		},
	];
}

function items() {
	const history = buildHistory(lines());
	history.items.forEach((item, index) => {
		item.sequence = index;
		item.searchText = item.kind === "user" ? item.text : JSON.stringify(item.raw);
	});
	return history.items;
}

test("buildHistory deduplicates resent messages and keeps stable ids", () => {
	const history = buildHistory(lines());
	const ids = history.items.map((item) => item.id);
	assertEqual(new Set(ids).size, ids.length, "ids must be unique");
	// The three messages resent in line 2 must NOT appear twice.
	assertEqual(history.items.filter((item) => JSON.stringify(item.raw).includes("flubber count")).length, 1);
	assert(ids.some((id) => id.endsWith("resp")), "response items are indexed");
});

test("thinking blocks are private: null slots keep original indexes", () => {
	const item = items().find((candidate) => candidate.kind === "assistant" && JSON.stringify(candidate.raw).includes("Reading the file."));
	const view = publicItem(item);
	const slots = view.raw.content.map((block) => {
		const found = view.publicBlocks.find((candidate) => candidate === block);
		return found ? found.type : null;
	});
	assertEqual(slots, [null, "text", "tool_use"], "text/tool_use public, thinking omitted as null slot");
	const parts = partsOf(item);
	assert(!parts.some((part) => part.part === "/assistant/text/0" || part.part === "/assistant/block/0"), "thinking block at index 0 must not be listed");
});

test("parts listing covers user text, tool results, assistant text, and calls", () => {
	const userItem = items().find((candidate) => candidate.kind === "user" && (candidate.toolResults ?? []).length > 0);
	const userParts = partsOf(userItem);
	assertEqual(userParts.map((part) => part.part), ["/toolResult/call_1"]);
	const textUser = items().find((candidate) => candidate.kind === "user" && candidate.text.includes("flubber count"));
	assertEqual(partsOf(textUser).map((part) => part.part), ["/user/content"]);
	const assistantItem = items().find((candidate) => candidate.kind === "assistant" && JSON.stringify(candidate.raw).includes("Reading the file."));
	const assistantParts = partsOf(assistantItem);
	assert(assistantParts.some((part) => part.part === "/assistant/text/1"), "text part at raw index 1");
	assert(assistantParts.some((part) => part.part === "/assistant/block/2"), "tool_use part at raw index 2");
});

test("partTextOf returns exact text and exact JSON", () => {
	const textUser = items().find((candidate) => candidate.kind === "user" && candidate.text.includes("flubber count"));
	assertEqual(partTextOf(textUser, "/user/content").text, "Find the flubber count.");
	const userItem = items().find((candidate) => candidate.kind === "user" && (candidate.toolResults ?? []).length > 0);
	assertEqual(partTextOf(userItem, "/toolResult/call_1").text, "count=42");
	const assistantItem = items().find((candidate) => candidate.kind === "assistant" && JSON.stringify(candidate.raw).includes("Reading the file."));
	const call = JSON.parse(partTextOf(assistantItem, "/assistant/block/2").text);
	assertEqual(call.name, "read_file");
	assertEqual(call.input.path, "flubber.json");
	throws(() => partTextOf(assistantItem, "/assistant/block/0"), /not public/);
});

test("readPage paginates to the reply budget with a next handle", () => {
	const item = { id: "hX", kind: "user", text: "y".repeat(50_000), toolResults: [], raw: { role: "user", content: "y".repeat(50_000) } };
	let offset = 0;
	let pages = 0;
	let lastHeader;
	while (pages < 10) {
		const page = readPage(item, { historyId: item.id, part: "/user/content", offset });
		lastHeader = page.header;
		pages++;
		if (page.header.nextOffset === null) break;
		offset = page.header.nextOffset;
	}
	assert(pages > 1, `expected multiple pages, got ${pages}`);
	assertEqual(lastHeader.nextOffset, null, "final page closes the chain");
	assert(pages * MAXIMUM_RECOVERY_REPLY_BYTES >= 50_000, "pages filled the budget");
	// Headers echo identity for gapless follow-up reads.
	assertEqual(lastHeader.historyId, "hX");
	assertEqual(lastHeader.totalCharacters, 50_000);
});

test("readPage never splits surrogate pairs", () => {
	const item = { id: "hS", kind: "user", text: "a" + "😀".repeat(20_000), toolResults: [], raw: { role: "user", content: "a" + "😀".repeat(20_000) } };
	const page = readPage(item, { historyId: "hS", part: "/user/content", offset: 0 });
	assert(!/[\uD800-\uDBFF]$/.test(page.text), "page must not end on a lone high surrogate");
});

test("loadItems loads small items whole and defers large ones with handles", () => {
	const itemsById = new Map();
	const small = { id: "small", kind: "user", text: "tiny", toolResults: [], raw: { role: "user", content: "tiny" } };
	const large = { id: "large", kind: "user", text: "z".repeat(60_000), toolResults: [], raw: { role: "user", content: "z".repeat(60_000) } };
	itemsById.set("small", small);
	itemsById.set("large", large);
	const result = loadItems(itemsById, ["large", "small"]);
	assertEqual(result.items.map((item) => item.id), ["small"], "small loads whole");
	assertEqual(result.deferredIds, ["large"], "large defers");
	const deferred = result.deferred[0];
	assertEqual(deferred.deferred, true);
	assert(deferred.parts.some((part) => part.part === "/user/content"), "deferred lists parts");
	assertEqual(deferred.readParts, { historyId: "large", mode: "parts" });
	throws(() => loadItems(itemsById, ["missing"]), /Unknown history ID/);
});

test("partsPage respects the reply budget and reports nextPartOffset", () => {
	// Long tool-call ids make each part description big enough that the 16 KiB reply caps the page.
	const item = { id: "hP", kind: "user", text: "", toolResults: Array.from({ length: 60 }, (_, index) => ({
		toolCallId: `call_${index}_${"k".repeat(300)}`,
		content: [{ type: "text", text: `result ${index}` }],
		isError: false,
	})), raw: { role: "user", content: [] } };
	const first = partsPage(item, 0);
	assert(first.parts.length < 60, "budget caps the page");
	assert(first.nextPartOffset !== null, "more parts remain");
	const second = partsPage(item, first.nextPartOffset);
	assertEqual(second.parts[0].index, first.nextPartOffset, "second page continues 0-based numbering");
	// Small part listings fit whole.
	const tiny = { id: "hT", kind: "user", text: "hi", toolResults: [], raw: { role: "user", content: "hi" } };
	const wholePage = partsPage(tiny, 0);
	assertEqual(wholePage.parts.length, 1);
	assertEqual(wholePage.nextPartOffset, null);
});

test("image parts stay out of text and attach natively on request", () => {
	const data = Buffer.from("fake-png-bytes").toString("base64");
	const item = { id: "hI", kind: "user", text: "see attachment", toolResults: [{
		toolCallId: "call_img",
		content: [{ type: "image", source: { type: "base64", media_type: "image/png", data } }],
		isError: false,
	}], raw: { role: "user", content: [{ type: "tool_result", tool_use_id: "call_img", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data } }] }] } };
	const text = JSON.stringify(partTextOf(item, "/toolResult/call_img"));
	assert(!text.includes(data), "base64 must not enter text pages");
	const image = imageAttachment(item, "/toolResult/call_img/block/0");
	assertEqual(image.mimeType, "image/png");
	assertEqual(image.data, data);
});

test("reply budget helpers count serialized bytes", () => {
	assert(fitsTexts(["ok"]));
	assert(!fitsTexts(["x".repeat(MAXIMUM_RECOVERY_REPLY_BYTES + 10)]));
	assertEqual(textReply(["a"]).content.length, 1);
});

test("recovery tools exclude their own traffic", () => {
	assert(isRecoveryToolName("search_history"));
	assert(isRecoveryToolName("mcp__zcp__read_context_output".split("__").at(-1)));
	assert(!isRecoveryToolName("read_file"));
	const pagingTurn = {
		id: "hR", kind: "assistant", raw: { role: "assistant", content: [
			{ type: "tool_use", id: "c9", name: "search_history", input: {} },
		] },
	};
	assert(!isRecoverableItem(pagingTurn), "paging-only turns are hidden");
});

test("resultText renders blocks, strings, and images safely", () => {
	assertEqual(resultText({ content: "plain" }), "plain");
	assertEqual(resultText({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }), "a\nb");
	assertEqual(resultText({ content: [{ type: "image", source: { data: "xx" } }] }), "[image]");
});
