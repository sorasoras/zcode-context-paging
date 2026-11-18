import { test, assert, assertEqual } from "./harness.mjs";
import { EvictedConversation, pagingNoticeText, protectedOverflowNoticeText } from "../src/notice.mjs";

const entry = (kind, id, text, part) => ({ kind, historyId: id, text, part });

test("notice header carries budget, guidance, and handles", () => {
	const text = pagingNoticeText(128_000, "h009", { historyId: "h007", toolCallId: "call_1", toolName: "read_file" }, undefined);
	assert(text.includes("128,000-token rolling window"), "budget line missing");
	assert(text.includes("Recent evicted historyId: \"h009\""), "evicted id missing");
	assert(text.includes("\"toolCallId\":\"call_1\""), "tool recovery handle missing");
	assert(!text.includes("Earlier conversation"), "empty conversation must omit the section");
});

test("copied conversation lists evicted requests and recent replies oldest first", () => {
	const conversation = new EvictedConversation();
	conversation.addTurn([entry("user message", "h001", "First request about flubber.", "/user/content")]);
	conversation.addTurn([entry("user message", "h003", "Second request about widgets.", "/user/content"), entry("assistant reply", "h004", "Widget reply.", "/assistant/text")]);
	conversation.addTurn([entry("user message", "h005", "Third request.", "/user/content")]);
	conversation.addTurn([entry("user message", "h007", "Fourth request.", "/user/content"), entry("assistant reply", "h008", "Fourth reply.", "/assistant/text")]);
	conversation.addTurn([entry("user message", "h009", "Fifth request.", "/user/content"), entry("assistant reply", "h010", "Fifth reply.", "/assistant/text")]);
	const text = pagingNoticeText(128_000, "h010", undefined, conversation);
	const firstIndex = text.indexOf("First request");
	const fifthIndex = text.indexOf("Fifth request");
	assert(firstIndex >= 0 && fifthIndex > firstIndex, "entries must be oldest first");
	assert(text.includes("--- user message, historyId \"h001\" ---"), "entry headers with ids");
	// Only the newest 3 turns keep replies.
	assert(text.includes("Fifth reply") && text.includes("Fourth reply"), "recent replies present");
	assert(!text.includes("Widget reply."), "old replies are dropped");
	// All five requests fit the default room, so nothing is omitted.
	assert(!text.includes("not shown"), "omitted-count line only when entries are dropped");
});

test("long entries are clipped with a read handle", () => {
	const conversation = new EvictedConversation();
	conversation.addTurn([entry("user message", "h001", "x".repeat(50_000), "/user/content")]);
	const text = pagingNoticeText(128_000, "h001", undefined, conversation);
	assert(text.includes("[Clipped after"), "clip marker missing");
	assert(text.includes("read_context_output({\"historyId\":\"h001\",\"part\":\"/user/content\"})"), "clip handle missing");
});

test("a tight section room drops entries and reports the omitted count", () => {
	const conversation = new EvictedConversation();
	for (let index = 0; index < 30; index++) {
		conversation.addTurn([entry("user message", `h${index}`, `Request number ${index} `.repeat(40), "/user/content")]);
	}
	const text = pagingNoticeText(128_000, "h29", undefined, conversation, 1_900);
	assert(text.includes("earlier user messages are not shown"), "omitted-count line present");
});

test("an over-tight section room drops the section entirely", () => {
	const conversation = new EvictedConversation();
	conversation.addTurn([entry("user message", "h0", "y".repeat(20_000), "/user/content")]);
	const text = pagingNoticeText(128_000, "h0", undefined, conversation, 700);
	assert(!text.includes("Earlier conversation"), "no room means no section, like the package");
});

test("the section respects a tight maxCharacters budget", () => {
	const conversation = new EvictedConversation();
	for (let index = 0; index < 30; index++) {
		conversation.addTurn([entry("user message", `h${index}`, `Request number ${index} `.repeat(40), "/user/content")]);
	}
	const text = pagingNoticeText(128_000, "h29", undefined, conversation, 2_400);
	const at = text.indexOf("Earlier conversation");
	assert(at >= 0, "section present at this room size");
	const section = text.slice(at);
	assert(section.length <= 2_800, `section too long: ${section.length}`);
});

test("the section cap is 10% of the budget at small budgets", () => {
	const conversation = new EvictedConversation();
	conversation.addTurn([entry("user message", "h0", "z".repeat(5_000), "/user/content")]);
	const text = pagingNoticeText(2_000, "h0", undefined, conversation);
	// 2,000 tokens * 0.4 = 800 characters of room; the entry cannot fit after the header.
	assert(!text.includes("Earlier conversation"), "budget cap drops the section");
});

test("overflow notice is minimal and actionable", () => {
	const text = protectedOverflowNoticeText(64_000);
	assert(text.includes("64,000"), "budget mentioned");
	assert(text.includes("present in full for this follow-up call"), "one-call guarantee stated");
});
