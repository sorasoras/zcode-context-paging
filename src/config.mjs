// Configuration loading for zcode-context-paging.
// Semantics and defaults ported from @rochecompaan/pi-context-paging 0.3.11 (MIT, © Roché Compaan).
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const DEFAULTS = {
	enabled: true,
	host: "127.0.0.1",
	port: 8787,
	tokenBudget: 128_000,
	// null → max(1, floor(tokenBudget * 5 / 8)), as in the package.
	trimToTokens: null,
	modelContextWindow: null,
	upstream: {
		// Where untrimmed requests are forwarded after paging.
		baseUrl: "http://127.0.0.1:8788",
		apiKey: null,
		apiKeyEnv: "ZCP_UPSTREAM_API_KEY",
	},
	rolloutDir: join(os.homedir(), ".zcode", "cli", "rollout"),
	providerConfigPath: join(os.homedir(), ".zcode", "v2", "provider_config.json"),
	stateDir: join(PROJECT_ROOT, "state"),
	logDir: join(PROJECT_ROOT, "logs"),
};

function deepMerge(base, override) {
	const out = { ...base };
	for (const [key, value] of Object.entries(override ?? {})) {
		if (value === undefined || value === null) continue;
		out[key] = value && typeof value === "object" && !Array.isArray(value)
			? deepMerge(base[key] && typeof base[key] === "object" ? base[key] : {}, value)
			: value;
	}
	return out;
}

export function defaultTrimToTokens(budget) {
	return Math.max(1, Math.floor((budget * 5) / 8));
}

/** Positive safe integers only; strings, fractions and other junk are rejected, as in the package. */
function validTokens(value) {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function expandHome(path) {
	if (typeof path !== "string") return path;
	if (path === "~") return os.homedir();
	if (path.startsWith("~/") || path.startsWith("~\\")) return join(os.homedir(), path.slice(2));
	return path;
}

export async function loadConfig(explicitPath) {
	const candidates = explicitPath
		? [explicitPath]
		: [join(PROJECT_ROOT, "config.default.json"), join(PROJECT_ROOT, "config.local.json")];
	let merged = { ...DEFAULTS };
	for (const path of candidates) {
		if (!existsSync(path)) continue;
		const parsed = JSON.parse(await readFile(path, "utf8"));
		merged = deepMerge(merged, parsed);
	}
	if (!validTokens(merged.tokenBudget)) throw new Error(`tokenBudget must be a positive safe integer, got ${merged.tokenBudget}`);
	if (merged.trimToTokens !== null && !validTokens(merged.trimToTokens)) {
		throw new Error(`trimToTokens must be null or a positive safe integer, got ${merged.trimToTokens}`);
	}
	if (merged.modelContextWindow !== null && !(typeof merged.modelContextWindow === "number" && merged.modelContextWindow > 0)) {
		throw new Error(`modelContextWindow must be null or positive, got ${merged.modelContextWindow}`);
	}
	const budgetTokens = merged.modelContextWindow === null
		? merged.tokenBudget
		: Math.min(merged.tokenBudget, merged.modelContextWindow);
	const configuredTrim = merged.trimToTokens ?? defaultTrimToTokens(merged.tokenBudget);
	// The effective budget never exceeds the model window; an explicit target scales by the same ratio.
	const trimToTokens = Math.max(1, Math.floor((configuredTrim * budgetTokens) / merged.tokenBudget));
	const resolveDir = (path) => {
		const expanded = expandHome(path);
		return isAbsolute(expanded) ? expanded : join(PROJECT_ROOT, expanded);
	};
	return {
		...merged,
		rolloutDir: expandHome(merged.rolloutDir),
		stateDir: resolveDir(merged.stateDir),
		logDir: resolveDir(merged.logDir),
		budgetTokens,
		trimToTokens,
		enabled: merged.enabled !== false,
	};
}
