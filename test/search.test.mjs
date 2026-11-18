import { test, assert, assertEqual, throws } from "./harness.mjs";
import { searchHistory, browseHistory, tokenize } from "../src/search.mjs";
import { buildHistory } from "../src/history-store.mjs";

function preparedItems() {
	const lines = [
		{ request: { body: { model: "m", messages: [
			{ role: "user", content: [{ type: "text", text: "Investigate the flubber overflow." }] },
			{ role: "assistant", content: [{ type: "tool_use", id: "c1", name: "read_file", input: { path: "/etc/flubber.conf" } }] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: [{ type: "text", text: "overflow_guard=false\nmax_flubber=99" }] }] },
			{ role: "assistant", content: [{ type: "tool_use", id: "c2", name: "write_file", input: { path: "/etc/flubber.conf", content: "overflow_guard=true" } }] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "c2", is_error: true, content: [{ type: "text", text: "permission denied: /etc/flubber.conf" }] }] },
			{ role: "assistant", content: [{ type: "text", text: "The write failed due to permissions." }] },
		] } }, response: { text: "Done.", toolCalls: [] } },
	];
	const history = buildHistory(lines);
	history.items.forEach((item, index) => {
		item.sequence = index;
		const raw = item.raw ?? {};
		item.searchText = [
			item.kind === "user" ? item.text : "",
			...(item.toolResults ?? []).map((result) => (typeof result.content === "string" ? result.content : JSON.stringify(result.content))),
			...(Array.isArray(raw.content) ? raw.content.flatMap((block) => block?.type === "text" ? [block.text] : block?.type === "tool_use" ? [block.name, JSON.stringify(block.input)] : []) : []),
		].join("\n");
	});
	return history.items;
}

test("tokenizer keeps path separators and drops outer punctuation", () => {
	const tokens = tokenize("error: `max_flubber=99' at /etc/flubber.conf!");
	assert(tokens.has("max_flubber=99"), "separators inside identifiers preserved");
	assert(tokens.has("/etc/flubber.conf"), "paths survive");
	assert(tokens.has("error"), "outer colon stripped");
	assert(!tokens.has("flubber.conf!"), "trailing punctuation stripped");
});

test("search finds matches in tool output with an excerpt around the term", () => {
	const items = preparedItems();
	const result = searchHistory(items, { query: "overflow_guard" });
	assert(result.references.length >= 1, "expected hits");
	assert(result.references.some((reference) => reference.excerpt.includes("overflow_guard=false")), "excerpt shows the matching output");
});

test("tools filter matches any listed tool; failed filter keeps only errors", () => {
	const items = preparedItems();
	const writeOnly = searchHistory(items, { query: "flubber", tools: ["write_file"] });
	assert(writeOnly.references.length >= 1);
	assert(writeOnly.references.every((reference) => reference.tools.includes("write_file")), "only write_file turns");
	const failed = searchHistory(items, { query: "flubber", failed: true });
	assert(failed.references.length >= 1, "the denied write is a failure");
	const ok = searchHistory(items, { query: "permission denied", failed: false });
	assert(ok.references.length >= 1);
});

test("empty queries without filters are rejected politely", () => {
	const result = searchHistory(preparedItems(), { query: "" });
	assertEqual(result.references, []);
	assert(result.note !== undefined);
});

test("browse walks backward and around with stride", () => {
	const items = preparedItems();
	const anchor = items.at(-1).id;
	const backward = browseHistory(items, { historyId: anchor, direction: "backward", count: 3 });
	assert(backward.references.length === 3);
	assertEqual(backward.references.at(-1).historyId, anchor);
	const around = browseHistory(items, { historyId: items[2].id, direction: "around", count: 2 });
	assert(around.references.some((reference) => reference.historyId === items[2].id));
	assert(around.references.length >= 3, "around includes both sides");
	throws(() => browseHistory(items, { historyId: "nope", direction: "backward" }), /Unknown history ID/);
});
