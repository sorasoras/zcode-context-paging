import { test, assert, assertEqual } from "./harness.mjs";
import { usageFrom } from "../src/proxy-server.mjs";
import { SessionStates } from "../src/session-state.mjs";

test("anthropic usage counts cached tokens as prompt tokens", () => {
	// A real steady-state request: most of the prompt is served from cache and is NOT in input_tokens.
	const usage = usageFrom({ input_tokens: 295, cache_read_input_tokens: 42_112, cache_creation_input_tokens: 0, output_tokens: 971 });
	assertEqual(usage.inputTokens, 295);
	assertEqual(usage.cacheReadTokens, 42_112);
	assertEqual(usage.promptTokens, 42_407, "prompt must include cache reads");
	assertEqual(usage.outputTokens, 971);
});

test("openai prompt_tokens is already inclusive and is not double-counted", () => {
	const usage = usageFrom({ prompt_tokens: 2_000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 1_500 } });
	assertEqual(usage.promptTokens, 2_000);
	assertEqual(usage.outputTokens, 50);
});

test("missing usage degrades to zeros instead of NaN", () => {
	const usage = usageFrom(undefined);
	assertEqual(usage.promptTokens, 0);
	assert(Number.isFinite(usage.inputTokens));
});

test("calibration converges toward one on cache-heavy traffic instead of pinning to the floor", () => {
	const states = new SessionStates("unused");
	const state = { calib: 1 };
	// Raw estimate 34,000 vs true prompt 42,407 → ratio ~1.25, not 0.25.
	const next = states.calibrate(state, 34_000, 42_407);
	assert(next > 1 && next < 1.3, `calib should rise modestly, got ${next}`);
	// The old bug: comparing against the uncached 295 drags the factor down hard each request.
	let bugged = { calib: 1 };
	for (let step = 0; step < 8; step++) bugged = { calib: states.calibrate(bugged, 34_000, 295) };
	assert(bugged.calib < 0.27, `uncached-only measurement collapses the factor, got ${bugged.calib}`);
	assert(next > bugged.calib * 3, `correct measurement (${next}) must dwarf the bugged one (${bugged.calib})`);
});

test("calibration ignores absent measurements", () => {
	const states = new SessionStates("unused");
	assertEqual(states.calibrate({ calib: 1.2 }, 1_000, 0), 1.2);
	assertEqual(states.calibrate({ calib: 1.2 }, 0, 1_000), 1.2);
});
