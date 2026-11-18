// Synthetic fixtures shared by the test modules.
export function anthropicBody(overrides = {}) {
	return {
		model: "test-model",
		max_tokens: 4096,
		system: [{ type: "text", text: "You are a test harness system prompt. " .repeat(4) }],
		tools: [{
			name: "read_file",
			description: "Read a file.",
			input_schema: { type: "object", properties: { path: { type: "string" } } },
		}],
		messages: [
			{ role: "user", content: [{ type: "text", text: "Turn one: inspect the flubber configuration." }] },
			{ role: "assistant", content: [
				{ type: "thinking", thinking: "secret reasoning about flubber", signature: "sig" },
				{ type: "text", text: "I will read the flubber config now." },
				{ type: "tool_use", id: "call_1", name: "read_file", input: { path: "flubber.json" } },
			] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: [{ type: "text", text: "flubber=true\ncount=42\npath=/etc/flubber.json" }] }] },
			{ role: "assistant", content: [{ type: "text", text: "The flubber config says count is 42." }] },
			{ role: "user", content: [{ type: "text", text: "Turn two: now calibrate the widget." }] },
			{ role: "assistant", content: [
				{ type: "text", text: "Reading widget calibration." },
				{ type: "tool_use", id: "call_2", name: "read_file", input: { path: "widget.json" } },
			] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "call_2", content: [{ type: "text", text: "widget=7" }] }] },
			{ role: "assistant", content: [{ type: "text", text: "Widget calibrated to 7." }] },
			{ role: "user", content: [{ type: "text", text: "Turn three: summarize both." }] },
		],
		...overrides,
	};
}

/** message id → stable recovery id (deterministic, like the rollout index). */
export function makeIdResolver() {
	const ids = new Map();
	let counter = 0;
	return (message) => {
		const key = JSON.stringify(message);
		if (!ids.has(key)) ids.set(key, `h${String(counter++).padStart(3, "0")}`);
		return ids.get(key);
	};
}

export const simpleEstimator = (message) => Math.ceil(JSON.stringify(message).length / 4);
