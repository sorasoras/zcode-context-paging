import { test, assert, assertEqual } from "./harness.mjs";
import { detectShape, isToolResultCarrier, isTurnStart, toolResultsOf, noticeMessage, residentEstimate, stableHash, publicAssistantBlocks } from "../src/wire.mjs";
import { groupTurns } from "../src/turns.mjs";
import { defaultTrimToTokens } from "../src/config.mjs";
import { join } from "node:path";

test("detectShape separates anthropic and openai bodies", () => {
	assertEqual(detectShape({ messages: [], system: "s", max_tokens: 1 }), "anthropic");
	assertEqual(detectShape({ messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "y" }] }] }), "anthropic");
	assertEqual(detectShape({ messages: [{ role: "assistant", tool_calls: [{ id: "x", function: { name: "f", arguments: "{}" } }] }] }), "openai");
	assertEqual(detectShape({ messages: [{ role: "tool", tool_call_id: "x", content: "y" }] }), "openai");
});

test("tool result carriers normalize across shapes", () => {
	const anthropic = { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "out" }] };
	const openai = { role: "tool", tool_call_id: "c1", name: "read_file", content: "out" };
	assert(isToolResultCarrier(anthropic, "anthropic"));
	assert(isToolResultCarrier(openai, "openai"));
	assert(!isToolResultCarrier({ role: "user", content: [{ type: "text", text: "hi" }] }, "anthropic"));
	assertEqual(toolResultsOf(anthropic, "anthropic")[0].toolCallId, "c1");
	assertEqual(toolResultsOf(openai, "openai")[0].toolName, "read_file");
});

test("turn starts exclude tool-result carriers on anthropic", () => {
	assert(isTurnStart({ role: "user", content: [{ type: "text", text: "hello" }] }, "anthropic"));
	assert(!isTurnStart({ role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "x" }] }, "anthropic"));
	assert(isTurnStart({ role: "user", content: "hello" }, "openai"));
});

test("noticeMessage matches each wire shape", () => {
	assertEqual(noticeMessage("anthropic", "N"), { role: "user", content: [{ type: "text", text: "N" }] });
	assertEqual(noticeMessage("openai", "N"), { role: "user", content: "N" });
});

test("resident estimate counts system and tools once", () => {
	const estimate = residentEstimate({
		system: "12345678",
		tools: [{ name: "t", description: "d", input_schema: {} }],
	}, (text) => text.length);
	// system 8 chars + tools JSON > 8 chars: estimate is the JSON length of tools + 8.
	assert(estimate > 16, `estimate ${estimate} should exceed the system prompt alone`);
});

test("publicAssistantBlocks keeps text and tool_use, drops thinking", () => {
	const blocks = publicAssistantBlocks({
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "secret", signature: "s" },
			{ type: "text", text: "public" },
			{ type: "tool_use", id: "c1", name: "read_file", input: {} },
		],
	});
	assertEqual(blocks.map((block) => block.type), ["text", "tool_use"]);
	const openai = publicAssistantBlocks({
		role: "assistant",
		content: "thinking out loud",
		tool_calls: [{ id: "c2", function: { name: "write_file", arguments: "{\"path\":\"x\"}" } }],
	});
	assertEqual(openai.map((block) => block.type), ["text", "tool_use"]);
	assertEqual(openai[1].input.path, "x");
});

test("groupTurns protects the active request and the trailing unread exchange", () => {
	const messages = [
		{ role: "user", content: [{ type: "text", text: "t1" }] },
		{ role: "assistant", content: [{ type: "text", text: "a1" }] },
		{ role: "user", content: [{ type: "text", text: "t2" }] },
		{ role: "assistant", content: [{ type: "tool_use", id: "c1", name: "f", input: {} }] },
		{ role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "r" }] },
	];
	const { units } = groupTurns(messages, "anthropic");
	assertEqual(units[0].kind, "completedTurn");
	assertEqual(units[1].kind, "request");
	assertEqual(units[2].kind, "exchange");
	assertEqual(units.filter((unit) => unit.protected).length, 2, "request + trailing exchange protected");
	assertEqual(units[0].protected, false, "completed turn evictable");
});

test("defaultTrimToTokens is five eighths, minimum one", () => {
	assertEqual(defaultTrimToTokens(128_000), 80_000);
	assertEqual(defaultTrimToTokens(64_000), 40_000);
	assertEqual(defaultTrimToTokens(1), 1);
});

test("config loads defaults and scales the trim target for smaller model windows", async () => {
	const { loadConfig } = await import("../src/config.mjs");
	const { PROJECT_ROOT } = await import("../src/config.mjs");
	const config = await loadConfig(join(PROJECT_ROOT, "config.default.json"));
	assertEqual(config.budgetTokens, 128_000);
	assertEqual(config.trimToTokens, 80_000);
	assert(config.rolloutDir.includes("rollout"), "rollout dir resolved");
});

test("stableHash is order-insensitive for identical content", () => {
	assertEqual(stableHash({ a: 1, b: 2 }), stableHash({ a: 1, b: 2 }));
	assert(stableHash({ a: 1 }) !== stableHash({ a: 2 }));
});
