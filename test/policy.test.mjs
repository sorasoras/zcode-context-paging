import { test, assert, assertEqual } from "./harness.mjs";
import { selectContext } from "../src/policy.mjs";
import { anthropicBody, makeIdResolver, simpleEstimator } from "./fixtures.mjs";
import { stableHash } from "../src/wire.mjs";

const run = (body, options = {}) => selectContext({
	body,
	shape: "anthropic",
	budgetTokens: options.budget ?? 1_000_000,
	trimToTokens: options.trim ?? Math.floor(((options.budget ?? 1_000_000) * 5) / 8),
	state: options.state ?? null,
	estimateMessage: options.estimate ?? simpleEstimator,
	resolveId: makeIdResolver(),
});

test("within-budget requests pass through unchanged", () => {
	const body = anthropicBody();
	const result = run(body);
	assertEqual(result.mode, "within-budget");
	assertEqual(result.body.messages.length, body.messages.length);
	assertEqual(result.body.messages, body.messages);
	assertEqual(result.frontier, undefined);
});

test("the input body is never mutated", () => {
	const body = anthropicBody();
	const before = JSON.stringify(body);
	run(body, { budget: 300, trim: 200 });
	assertEqual(JSON.stringify(body), before);
});

test("small budgets page whole completed turns and inject the notice", () => {
	const body = anthropicBody();
	const result = run(body, { budget: 300, trim: 200 });
	assertEqual(result.mode, "paged");
	const messages = result.body.messages;
	// First message is the paging notice.
	assert(messages[0].role === "user", "notice must be a user message");
	const text = messages[0].content[0].text;
	assert(text.startsWith("[Context paging notice"), "notice header missing");
	assert(text.includes("Nothing was summarized"), "notice must state nothing was summarized");
	// The active request survives.
	assert(messages.at(-1).content[0].text.includes("Turn three"), "active request must survive");
	// At least one completed turn was evicted.
	assert(messages.length < body.messages.length, "paged request must be smaller");
	assert(!JSON.stringify(messages).includes("flubber.json"), "completed tool exchanges evicted");
	// At toy budgets the header and handles fit; the copied section needs a larger budget
	// (covered by the big-fixture test below).
	assert(text.includes("historyId"), "notice entries carry historyIds");
});

test("paged requests stay within budget with a simple estimator", () => {
	const body = anthropicBody();
	const result = run(body, { budget: 300, trim: 200 });
	const sent = result.body.messages.reduce((sum, message) => sum + simpleEstimator(message), 0);
	const resident = simpleEstimator({ role: "user", content: JSON.stringify(body.tools) });
	assert(sent + resident <= 300 + 60, `estimated ${sent + resident} should fit ~budget 300`);
});

test("frontier is stable across repeated requests", () => {
	const body = anthropicBody();
	const first = run(body, { budget: 300, trim: 200 });
	assert(first.frontier !== undefined);
	const second = run(body, { budget: 400, trim: 250, state: first.frontier });
	assertEqual(JSON.stringify(second.body.messages), JSON.stringify(first.body.messages));
	assertEqual(second.frontier.frontierIndex, first.frontier.frontierIndex);
});

test("appending the next turn keeps the frontier and notice stable", () => {
	const body = anthropicBody();
	const first = run(body, { budget: 300, trim: 200 });
	const next = structuredClone(body);
	next.messages.push({ role: "assistant", content: [{ type: "text", text: "Summary of flubber and widget." }] });
	const result = run(next, { budget: 400, trim: 250, state: first.frontier });
	assertEqual(result.frontier.noticeText, first.frontier.noticeText);
});

test("a hash mismatch resets the cut", () => {
	const body = anthropicBody();
	const first = run(body, { budget: 300, trim: 200 });
	const edited = structuredClone(body);
	// Rewrite an old message (as compaction or an edit would).
	edited.messages[0].content[0].text = "Rewritten history.";
	const result = run(edited, { budget: 400, trim: 250, state: first.frontier });
	assertEqual(result.mode, "paged");
	// The rewritten message hashes differently, so the stale frontier must not short-circuit.
	assert(result.frontier.frontierHash === stableHash(edited.messages[result.frontier.frontierIndex]), "frontier hash must match the new anchor");
});

test("protected overflow keeps the unread exchange once with the minimal notice", () => {
	const body = anthropicBody({
		messages: [
			...anthropicBody().messages,
			{ role: "user", content: [{ type: "text", text: "Turn four: process the dump." }] },
			{ role: "assistant", content: [{ type: "tool_use", id: "call_4", name: "read_file", input: { path: "dump.bin" } }] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "call_4", content: [{ type: "text", text: "D".repeat(4000) }] }] },
		],
	});
	const result = run(body, { budget: 300, trim: 200 });
	assertEqual(result.mode, "protected-overflow");
	const text = result.body.messages[0].content[0].text;
	assert(text.includes("present in full for this follow-up call"), "overflow notice text missing");
	// The giant unread tool result stays in full; older turns are gone.
	const sent = JSON.stringify(result.body.messages);
	assert(sent.includes("DDDD"), "protected tool result survives in full");
	assert(!sent.includes("Turn one"), "older turns evicted");
});

test("when only the active request remains after eviction, the mode is paged", () => {
	const result = run(anthropicBody(), { budget: 300, trim: 200 });
	assertEqual(result.mode, "paged");
	assertEqual(result.body.messages.length, 2, "notice + active request only");
});

test("when the trim target is already met, no further cut advances", () => {
	const body = anthropicBody();
	const first = run(body, { budget: 300, trim: 200 });
	const bigState = { ...first.frontier };
	const second = run(body, { budget: 400, trim: 250, state: bigState });
	assertEqual(JSON.stringify(second.body.messages), JSON.stringify(first.body.messages), "stable cut must not advance when within budget");
});

test("the notice copies the evicted conversation when the budget affords it", () => {
	// Twelve substantial turns; the active request is turn thirteen.
	const messages = [];
	for (let turn = 1; turn <= 12; turn++) {
		messages.push({ role: "user", content: [{ type: "text", text: `Turn ${turn}: investigate the flubber anomaly. ${"detail ".repeat(60)}` }] });
		messages.push({ role: "assistant", content: [{ type: "text", text: `Turn ${turn} findings logged.` }] });
	}
	messages.push({ role: "user", content: [{ type: "text", text: "Turn thirteen: write the final flubber report." }] });
	const body = anthropicBody({ messages });
	const result = run(body, { budget: 1_200, trim: 750 });
	assertEqual(result.mode, "paged");
	const text = result.body.messages[0].content[0].text;
	assert(text.includes("Earlier conversation"), "copied conversation section present");
	assert(text.includes("Turn 8 findings logged."), "the newest evicted reply is copied (trim 750 evicts eight turns)");
	assert(text.includes("not shown"), "entries beyond the room are counted as omitted");
	assert(!JSON.stringify(result.body.messages.slice(1)).includes("Turn 1 findings"), "evicted turns left the window");
	assert(JSON.stringify(result.body.messages).includes("Turn thirteen"), "active request survives");
});

test("empty message lists are passed through", () => {
	const result = run({ model: "m", messages: [] });
	assertEqual(result.mode, "within-budget");
	assertEqual(result.body.messages.length, 0);
});
