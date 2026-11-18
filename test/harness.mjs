// Tiny sequential test harness (no runner dependencies; usable on plain `node`).
const registry = [];

export function test(name, fn) {
	registry.push({ name, fn });
}

export async function runAll() {
	let passed = 0;
	const failed = [];
	for (const { name, fn } of registry) {
		try {
			await fn();
			passed++;
			console.log(`  ok  ${name}`);
		} catch (error) {
			failed.push({ name, error });
			console.error(`FAIL  ${name}`);
			console.error(`      ${String(error?.stack ?? error).split("\n").slice(0, 6).join("\n      ")}`);
		}
	}
	console.log(`\n${passed} passed, ${failed.length} failed`);
	return failed;
}

export function assert(condition, message) {
	if (!condition) throw new Error(message ?? "assertion failed");
}

export function assertEqual(actual, expected, message) {
	const a = JSON.stringify(actual);
	const b = JSON.stringify(expected);
	if (a !== b) throw new Error(`${message ?? "not equal"}\n  actual:   ${a}\n  expected: ${b}`);
}

export function throws(fn, matcher, message) {
	try {
		fn();
	} catch (error) {
		if (matcher instanceof RegExp && !matcher.test(String(error?.message ?? error))) {
			throw new Error(`threw the wrong error: ${error?.message ?? error}`);
		}
		return error;
	}
	throw new Error(message ?? "expected function to throw");
}
