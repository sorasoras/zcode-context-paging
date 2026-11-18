// Per-session frontier state and calibration, persisted under stateDir.
// Mirrors ContextCutState from @rochecompaan/pi-context-paging 0.3.11 (MIT): the cut point lives
// in memory during a process and is persisted so a proxy restart can keep the same window.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

function sanitize(sessionId) {
	return String(sessionId ?? "default").replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 80) || "default";
}

export class SessionStates {
	constructor(stateDir) {
		this.stateDir = stateDir;
		this.cache = new Map();
		this.writes = new Map();
	}

	path(sessionId) {
		return join(this.stateDir, `${sanitize(sessionId)}.json`);
	}

	async load(sessionId) {
		if (this.cache.has(sessionId)) return this.cache.get(sessionId);
		const state = await readFile(this.path(sessionId), "utf8")
			.then((text) => JSON.parse(text))
			.catch(() => ({}));
		const value = {
			frontierIndex: 0,
			frontierHash: null,
			noticeText: null,
			calib: 1,
			stats: { requests: 0, paged: 0, tokensSaved: 0 },
			...state,
		};
		this.cache.set(sessionId, value);
		return value;
	}

	async save(sessionId, state) {
		this.cache.set(sessionId, state);
		// Write-then-rename so a concurrent reader never sees a truncated file.
		const write = (async () => {
			await mkdir(this.stateDir, { recursive: true });
			const target = this.path(sessionId);
			const temp = `${target}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			await writeFile(temp, JSON.stringify(state, null, "\t"));
			await rename(temp, target);
		})();
		// Coalesce bursts: only the latest write per session needs to land.
		this.writes.set(sessionId, write);
		try {
			await write;
		} finally {
			if (this.writes.get(sessionId) === write) this.writes.delete(sessionId);
		}
	}

	/**
	 * EMA calibration against real provider prompt sizes, clamped to a sane band.
	 * `promptTokens` must be the FULL prompt (uncached + cache read + cache creation) and
	 * `estimatedTokens` the uncalibrated estimate — mixing either up pins the factor to a clamp.
	 */
	calibrate(state, estimatedTokens, promptTokens) {
		if (!Number.isFinite(promptTokens) || promptTokens <= 0) return state.calib;
		if (!Number.isFinite(estimatedTokens) || estimatedTokens <= 0) return state.calib;
		const ratio = promptTokens / estimatedTokens;
		const clamped = Math.min(Math.max(ratio, 0.25), 8);
		return Math.min(Math.max(state.calib * 0.6 + clamped * 0.4, 0.25), 8);
	}
}
