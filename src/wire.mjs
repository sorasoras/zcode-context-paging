// Wire-format accessors: one normalized view over Anthropic Messages and OpenAI Chat request bodies.
// Semantics guided by @rochecompaan/pi-context-paging 0.3.11 (MIT).
import { createHash } from "node:crypto";

export function detectShape(body) {
	if (!body || !Array.isArray(body.messages)) return "unknown";
	if (body.system !== undefined) return "anthropic";
	if (body.tools?.some((tool) => tool && typeof tool.input_schema === "object")) return "anthropic";
	if (body.tools?.some((tool) => tool && typeof tool.function === "object")) return "openai";
	if (body.messages.some((message) => message.role === "tool" || Array.isArray(message?.tool_calls))) return "openai";
	if (body.messages.some((message) => Array.isArray(message.content)
		&& message.content.some((block) => block && ["tool_use", "tool_result", "thinking"].includes(block.type)))) return "anthropic";
	return body.max_tokens !== undefined ? "anthropic" : "openai";
}

export function isTextBlock(block) {
	return block && block.type === "text" && typeof block.text === "string";
}

/** Stable content hash used for frontier identity; stable across restarts and JSON key order changes. */
export function stableHash(value) {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
}

export function messageRole(message) {
	if (typeof message.role !== "string") return "unknown";
	return message.role === "tool" ? "user" : message.role; // normalize OpenAI tool results under "user"
}

/** User-side message that carries only tool results (Anthropic tool_result blocks / OpenAI role:tool). */
export function isToolResultCarrier(message, shape) {
	if (shape === "anthropic") {
		if (message.role !== "user" || !Array.isArray(message.content)) return false;
		return message.content.length > 0 && message.content.every((block) => block && block.type === "tool_result");
	}
	return message.role === "tool";
}

/** A user message that begins a new logical turn. */
export function isTurnStart(message, shape) {
	if (shape === "anthropic") return message.role === "user" && !isToolResultCarrier(message, shape);
	return message.role === "user";
}

export function userTextOf(message) {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.map((block) => isTextBlock(block) ? block.text : block?.type === "image" ? "[image]" : "")
		.filter((text) => text !== "")
		.join("\n");
}

export function assistantTextOf(message) {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter((block) => isTextBlock(block) && block.text.trim() !== "")
		.map((block) => block.text)
		.join("\n");
}

/** Public assistant blocks: text and tool_use; thinking/signatures never surface. */
export function publicAssistantBlocks(message) {
	if (message.tool_calls) {
		// OpenAI shape: string (or block array) content alongside tool_calls.
		const blocks = [];
		const text = typeof message.content === "string"
			? message.content
			: Array.isArray(message.content)
				? message.content.filter((block) => isTextBlock(block)).map((block) => block.text).join("\n")
				: "";
		if (text.trim() !== "") blocks.push({ type: "text", text });
		for (const call of message.tool_calls) {
			if (!call?.function) continue;
			let arguments_;
			try {
				arguments_ = JSON.parse(call.function.arguments ?? "{}");
			} catch {
				arguments_ = { raw: call.function.arguments };
			}
			blocks.push({ type: "tool_use", id: call.id, name: call.function.name, input: arguments_ });
		}
		return blocks;
	}
	if (typeof message.content === "string") return [{ type: "text", text: message.content }];
	if (!Array.isArray(message.content)) return [];
	return message.content.filter((block) => block && (block.type === "text" || block.type === "tool_use"));
}

export function toolUsesOf(message) {
	return publicAssistantBlocks(message)
		.filter((block) => block.type === "tool_use")
		.map((block) => ({ id: block.id, name: block.name, input: block.input }));
}

/** Tool results carried by a user-side message, as { toolCallId, toolName, content, isError, raw }. */
export function toolResultsOf(message, shape) {
	if (shape === "anthropic") {
		if (message.role !== "user" || !Array.isArray(message.content)) return [];
		return message.content
			.filter((block) => block && block.type === "tool_result")
			.map((block) => ({ toolCallId: block.tool_use_id, toolName: undefined, content: block.content, isError: block.is_error === true, raw: block }));
	}
	if (message.role !== "tool") return [];
	return [{
		toolCallId: message.tool_call_id,
		toolName: message.name,
		content: message.content,
		isError: false,
		raw: message,
	}];
}

export function toolNamesIn(message, shape) {
	const names = new Set(toolUsesOf(message).map((call) => call.name));
	for (const result of toolResultsOf(message, shape)) {
		if (result.toolName) names.add(result.toolName);
	}
	return names;
}

/** A synthetic user message carrying the paging notice, in the request's wire shape. */
export function noticeMessage(shape, text) {
	return shape === "anthropic"
		? { role: "user", content: [{ type: "text", text }] }
		: { role: "user", content: text };
}

/** Resident (counted-once) payload: system prompt plus tool definitions, in tokens. */
export function residentEstimate(body, estimateText) {
	const parts = [];
	if (typeof body.system === "string") parts.push(body.system);
	else if (Array.isArray(body.system)) parts.push(body.system.map((block) => isTextBlock(block) ? block.text : "").join("\n"));
	if (Array.isArray(body.tools)) parts.push(JSON.stringify(body.tools));
	return estimateText(parts.join("\n"));
}
