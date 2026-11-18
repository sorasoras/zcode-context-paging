// The Plan A proxy lane: rewrite the provider request in flight, keep ZCode's stored history
// untouched, and forward to the real upstream. ZCode never sees a near-full context, so its own
// auto-compaction never triggers — that is how "no surprise compaction" works without a PreCompact
// hook. Recovery reads ZCode's rollout files; nothing here writes into ~/.zcode.
//
// Session routing (choose one; later, the SessionStart hook writes the provider baseURL as
// http://127.0.0.1:<port>/s/<sessionId>):
//   path prefix  /s/<sessionId>/v1/...
//   header       x-context-paging-session: <sessionId>
//   query        ?zcp_session=<sessionId>
import { createServer, request as httpUpstreamRequest } from "node:http";
import { request as upstreamRequest } from "node:https";
import { createHash } from "node:crypto";
import { mkdir, appendFile, readFile, readdir, stat, open } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { selectContext } from "./policy.mjs";
import { detectShape, stableHash } from "./wire.mjs";
import { RolloutIdResolver, resolveRolloutFiles, HistoryStore } from "./history-store.mjs";
import { SessionStates } from "./session-state.mjs";
import { isRecoverableItem, publicItem, partsOf } from "./recovery.mjs";
import { searchHistory } from "./search.mjs";
import { guiHtml } from "./gui.mjs";

const MAX_BODY_BYTES = 512 * 1024 * 1024;

export function createProxyServer(config, dependencies = {}) {
	const states = dependencies.states ?? new SessionStates(config.stateDir);
	const resolver = dependencies.resolver ?? new RolloutIdResolver(config.rolloutDir);
	const calibHolder = { value: null };
	const estimateMessage = dependencies.estimateMessage ?? ((message) => {
		// ~4 characters per token, scaled by per-session calibration against provider usage.
		const state = calibHolder.value ?? { calib: 1 };
		return Math.ceil((JSON.stringify(message)?.length ?? 0) / 4 * state.calib);
	});
	const logLine = async (entry) => {
		if (!config.logDir) return;
		try {
			await mkdir(config.logDir, { recursive: true });
			await appendFile(join(config.logDir, "access.jsonl"), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
		} catch {
			// Logging must never break the request path.
		}
	};

	const startedAt = Date.now();
	const server = createServer(async (req, res) => {
		const started = Date.now();
		try {
			if (req.method === "GET" && (req.url?.startsWith("/__zcp/") || req.url === "/" || req.url === "/?")) {
				return controlEndpoint(req, res);
			}
			const { sessionId, path } = splitSession(req);
			if (!config.enabled) return void passthrough(req, res, path, undefined, sessionId);
			if (req.method !== "POST") return void passthrough(req, res, path, undefined, sessionId);

			const body = await readBody(req);
			let parsed;
			try {
				parsed = JSON.parse(body.toString("utf8"));
			} catch {
				return void forward(req, res, resolveUpstreamTarget(path, config), body, sessionId, undefined, started);
			}
			if (!parsed || !Array.isArray(parsed.messages)) {
				return void forward(req, res, resolveUpstreamTarget(path, config), body, sessionId, undefined, started);
			}

			const shape = detectShape(parsed);
			const state = await states.load(sessionId);
			calibHolder.value = state;
			resolver.withHint(sessionId);
			const index = await resolver.current().catch(() => null);
			const idOf = index ? (message) => index.byHash.get(hashOf(message)) : undefined;

			const selection = selectContext({
				body: parsed,
				shape,
				budgetTokens: config.budgetTokens,
				trimToTokens: config.trimToTokens,
				state: state.frontierIndex > 0 ? state : null,
				estimateMessage,
				resolveId: idOf,
				toolNameOf: toolNameOf,
			});

			// Counters update on every request — including within-budget passthrough — so the
			// monitor sees all lane traffic; frontier fields only move when a cut applies.
			{
				const next = { ...state };
				if (selection.frontier !== undefined) {
					next.frontierIndex = selection.frontier.frontierIndex;
					next.frontierHash = selection.frontier.frontierHash;
					next.noticeText = selection.frontier.noticeText;
				}
				next.stats = {
					...state.stats,
					requests: (state.stats?.requests ?? 0) + 1,
					paged: (state.stats?.paged ?? 0) + (selection.mode === "within-budget" ? 0 : 1),
					// Cumulative estimate of everything currently paged out of the window.
					tokensSaved: selection.evictedTokens ?? state.stats?.tokensSaved ?? 0,
				};
				await states.save(sessionId, next);
			}

			const outBody = Buffer.from(JSON.stringify(selection.body), "utf8");
			return void forward(req, res, resolveUpstreamTarget(path, config), outBody, sessionId, {
				originalMessages: parsed.messages.length,
				sentMessages: selection.sentMessages,
				mode: selection.mode,
				estimatedTokens: selection.estimatedTokens,
				evictedTokens: selection.evictedTokens,
				frontierIndex: selection.frontier?.frontierIndex ?? 0,
				calib: state.calib,
				upstream: new URL(resolveUpstreamTarget(path, config).origin).host,
			}, started);
		} catch (error) {
			res.writeHead(502, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: "zcode-context-paging proxy failure", message: String(error?.message ?? error) }));
			await logLine({ error: String(error?.stack ?? error) });
		}
	});

	function controlEndpoint(req, res) {
		const url = new URL(req.url, "http://localhost");
		const json = (payload) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(payload, null, 2));
		};
		if (url.pathname === "/" || url.pathname === "/__zcp/gui") {
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			return res.end(guiHtml);
		}
		if (url.pathname === "/__zcp/health") {
			return json({ ok: true, version: "0.1.0", enabled: config.enabled, uptimeSec: Math.floor((Date.now() - startedAt) / 1000) });
		}
		if (url.pathname.startsWith("/__zcp/status/")) {
			const sessionId = url.pathname.slice("/__zcp/status/".length);
			return states.load(sessionId).then((state) => json({
				sessionId,
				frontierIndex: state.frontierIndex,
				calib: state.calib,
				stats: state.stats,
				budgetTokens: config.budgetTokens,
				trimToTokens: config.trimToTokens,
			}));
		}
		if (url.pathname === "/__zcp/sessions") {
			return listSessions().then((sessions) => json(sessions)).catch((error) => json({ error: String(error?.message ?? error) }));
		}
		if (url.pathname === "/__zcp/log") {
			const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 100, 1), 1000);
			return json(readAccessLog(limit));
		}
		if (url.pathname === "/__zcp/lanes") {
			return json(readProviderLanes());
		}
		if (url.pathname === "/__zcp/stats") {
			return json(buildStats(readAccessLog(500)));
		}
		if (url.pathname === "/__zcp/config") {
			return json(effectiveConfig());
		}
		if (url.pathname === "/__zcp/rollouts") {
			return listRollouts().then((rollouts) => json(rollouts)).catch((error) => json({ error: String(error?.message ?? error) }));
		}
		if (url.pathname === "/__zcp/history") {
			return searchRolloutWeb(url.searchParams)
				.then((result) => json(result))
				.catch((error) => json({ error: String(error?.message ?? error) }));
		}
		if (url.pathname === "/__zcp/history/item") {
			return rolloutItemWeb(url.searchParams)
				.then((result) => json(result))
				.catch((error) => json({ error: String(error?.message ?? error) }));
		}
		if (url.pathname === "/__zcp/notices") {
			return listSessions().then((sessions) => json(sessions
				.filter((session) => session.noticeChars > 0)
				.map((session) => ({ sessionId: session.sessionId, noticeChars: session.noticeChars, noticeText: stateNoticeText(session.sessionId) }))));
		}
		if (url.pathname === "/__zcp/ping") {
			return pingLane(url.searchParams.get("provider"))
				.then((result) => json(result))
				.catch((error) => json({ error: String(error?.message ?? error) }));
		}
		res.writeHead(404);
		res.end("not found");
	}

	async function listSessions() {
		let entries;
		try {
			entries = await readdir(config.stateDir);
		} catch {
			return [];
		}
		const sessions = [];
		for (const name of entries.filter((entry) => entry.endsWith(".json")).sort()) {
			try {
				const path = join(config.stateDir, name);
				const info = await stat(path);
				const state = JSON.parse(await readFile(path, "utf8"));
				sessions.push({
					sessionId: name.slice(0, -5),
					frontierIndex: state.frontierIndex ?? 0,
					calib: state.calib ?? 1,
					stats: state.stats ?? {},
					noticeChars: state.noticeText ? state.noticeText.length : 0,
					updatedAt: info.mtime.toISOString(),
				});
			} catch {
				// torn or foreign file: skip it rather than failing the listing
			}
		}
		return sessions.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
	}

	function readAccessLog(limit) {
		try {
			const text = readFileSync(join(config.logDir, "access.jsonl"), "utf8");
			const lines = text.split("\n").filter((line) => line.trim() !== "");
			return lines.slice(-limit).flatMap((line) => {
				try {
					return [JSON.parse(line)];
				} catch {
					return [];
				}
			});
		} catch {
			return [];
		}
	}

	function readProviderLanes() {
		const path = config.providerConfigPath;
		if (!path) return [];
		let store;
		try {
			store = JSON.parse(readFileSync(path, "utf8"));
		} catch {
			return [];
		}
		const order = store.config?.providerOrder ?? [];
		const classify = (baseUrl) => {
			const text = String(baseUrl ?? "");
			if (text.includes(":8787/zcp/")) return { lane: "zcp", upstream: text.split("/zcp/")[1] ?? "" };
			if (text.includes(":8787")) return { lane: "zcp-lane", upstream: text };
			if (text.includes(":18788/bili/")) return { lane: "bili", upstream: text.split("/bili/")[1] ?? "" };
			return { lane: "direct", upstream: text };
		};
		return (store.config?.providerConfigRules?.providerRules ?? []).map((rule) => {
			const api = rule.config?.api ?? {};
			const { lane, upstream } = classify(api.baseUrl);
			return {
				id: rule.providerId,
				name: rule.providerName,
				api: api.type ?? "?",
				baseUrl: api.baseUrl ?? "",
				lane,
				upstream,
				models: rule.config?.modelOrder ?? [],
				active: order[0] === rule.providerId,
			};
		});
	}

	function buildStats(log) {
		const counted = log.filter((entry) => entry.mode !== undefined);
		const byMode = {};
		let promptTotal = 0;
		let cacheReadTotal = 0;
		let evictedTotal = 0;
		let durationTotal = 0;
		const sessionIds = new Set();
		for (const entry of counted) {
			byMode[entry.mode] = (byMode[entry.mode] ?? 0) + 1;
			promptTotal += entry.promptTokens ?? 0;
			cacheReadTotal += entry.cacheReadTokens ?? 0;
			evictedTotal += entry.evictedTokens ?? 0;
			durationTotal += entry.durationMs ?? 0;
			sessionIds.add(entry.session);
		}
		const last = counted.at(-1) ?? {};
		return {
			ok: true,
			version: "0.1.0",
			enabled: config.enabled,
			uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
			budgetTokens: config.budgetTokens,
			trimToTokens: config.trimToTokens,
			logRequests: counted.length,
			byMode,
			promptLast: last.promptTokens ?? null,
			cacheReadLast: last.cacheReadTokens ?? 0,
			estimatedLast: last.estimatedTokens ?? null,
			evictedLast: last.evictedTokens ?? 0,
			promptTotal,
			cacheReadTotal,
			evictedTotal,
			avgDuration: counted.length > 0 ? Math.round(durationTotal / counted.length) : null,
			sessionsSeen: sessionIds.size,
		};
	}

	// --- monitor tab data ----------------------------------------------------------------------

	function effectiveConfig() {
		const apiKey = config.upstream.apiKey ?? (config.upstream.apiKeyEnv ? process.env[config.upstream.apiKeyEnv] : undefined);
		return {
			version: "0.1.0",
			enabled: config.enabled,
			host: config.host,
			port: config.port,
			tokenBudget: config.tokenBudget,
			budgetTokens: config.budgetTokens,
			trimToTokens: config.trimToTokens,
			modelContextWindow: config.modelContextWindow,
			upstream: {
				baseUrl: config.upstream.baseUrl,
				// Never echo key material to a browser tab.
				apiKeySet: Boolean(apiKey),
				apiKeyEnv: config.upstream.apiKeyEnv ?? null,
			},
			rolloutDir: config.rolloutDir,
			stateDir: config.stateDir,
			logDir: config.logDir,
			providerConfigPath: config.providerConfigPath ?? null,
		};
	}

	const rolloutStores = new Map();

	function storeFor(path) {
		let store = rolloutStores.get(path);
		if (!store) {
			store = new HistoryStore(path);
			rolloutStores.set(path, store);
		}
		return store;
	}

	const ROLLOUT_TAIL_BYTES = 96 * 1024;

	/** Reads the tail of a rollout file cheaply — the newest model_io line carries the truth
	 *  about which model/provider the session last used on the wire. */
	async function lastProviderUse(path, size) {
		const handle = await open(path, "r").catch(() => null);
		if (!handle) return { modelId: null, providerId: null, at: null };
		try {
			const start = Math.max(0, size - ROLLOUT_TAIL_BYTES);
			const length = size - start;
			const buffer = Buffer.alloc(length);
			await handle.read(buffer, 0, length, start);
			const lines = buffer.toString("utf8").split("\n").filter((line) => line.trim() !== "");
			for (let index = lines.length - 1; index >= 0; index--) {
				try {
					const entry = JSON.parse(lines[index]);
					if (entry.model?.modelId) {
						return {
							modelId: entry.model.modelId,
							providerId: entry.model.providerId ?? "",
							at: entry.completedAt ?? null,
						};
					}
				} catch {
					// torn line at the read boundary — keep walking back
				}
			}
		} catch {
			// unreadable file — report unknown
		} finally {
			await handle.close();
		}
		return { modelId: null, providerId: null, at: null };
	}

	async function listRollouts() {
		const files = await resolveRolloutFiles(config.rolloutDir, null);
		const rollouts = [];
		for (const path of files.slice(0, 20)) {
			const info = await stat(path).catch(() => null);
			if (!info) continue;
			const match = path.match(/model-io-(.+)\.jsonl$/);
			rollouts.push({
				sessionId: match ? match[1] : path,
				file: path,
				sizeBytes: info.size,
				updatedAt: info.mtime.toISOString(),
				lastUse: await lastProviderUse(path, info.size),
			});
		}
		return rollouts;
	}

	/** Web search over public rollout items — the same recovery view the MCP tools serve. */
	async function searchRolloutWeb(params) {
		const files = await resolveRolloutFiles(config.rolloutDir, params.get("session"));
		const path = files[0];
		if (!path) return { references: [], note: "no rollout file matches this session" };
		const history = await storeFor(path).load();
		const items = history.items.filter((item) => isRecoverableItem(item));
		const limit = Math.min(Math.max(Number(params.get("limit")) || 8, 1), 20);
		const query = params.get("q") ?? "";
		const kind = params.get("kind");
		const failed = params.get("failed") === "1";
		const wantRecent = params.get("recent") === "1" || (query.trim() === "" && !failed);
		if (wantRecent) {
			// No query: newest items, newest first.
			return {
				rollout: path,
				references: items.slice(-limit).reverse()
					.filter((item) => !kind || item.kind === kind)
					.map((item) => ({
						historyId: item.id,
						kind: item.kind,
						sequence: item.sequence,
						excerpt: (item.searchText ?? "").slice(0, 200),
					})),
			};
		}
		const result = searchHistory(items, {
			query,
			limit,
			tools: params.get("tools") ? params.get("tools").split(",").filter(Boolean) : undefined,
			failed,
		});
		const references = kind ? result.references.filter((reference) => reference.kind === kind) : result.references;
		return { rollout: path, query: query || null, references, ...(result.note ? { note: result.note } : {}) };
	}

	async function rolloutItemWeb(params) {
		const files = await resolveRolloutFiles(config.rolloutDir, params.get("session"));
		const path = files[0];
		if (!path) throw new Error("no rollout file matches this session");
		const history = await storeFor(path).load();
		const item = history.items.find((candidate) => candidate.id === params.get("id"));
		if (item === undefined) throw new Error(`Unknown history ID ${params.get("id")}`);
		const view = publicItem(item);
		const compact = view.kind === "user"
			? { id: view.id, kind: view.kind, text: view.text, toolResults: view.toolResults }
			: view.kind === "assistant"
				? { id: view.id, kind: view.kind, content: view.raw.tool_calls ? view.publicBlocks : view.raw.content, toolCalls: view.raw.tool_calls ?? undefined }
				: { id: view.id, kind: view.kind, text: view.text };
		return { rollout: path, item: compact, parts: partsOf(item) };
	}

	function stateNoticeText(sessionId) {
		try {
			return JSON.parse(readFileSync(join(config.stateDir, `${sessionId.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 80)}.json`), "utf8")).noticeText ?? "";
		} catch {
			return "";
		}
	}

	async function pingLane(providerId) {
		const lane = readProviderLanes().find((candidate) => candidate.id === providerId);
		if (!lane) throw new Error(`Unknown provider ${providerId}`);
		// Probe the lane's resolved target root: reachability, not API semantics.
		const target = new URL(lane.upstream || lane.baseUrl);
		const started = Date.now();
		try {
			const response = await fetch(target, { signal: AbortSignal.timeout(4000), redirect: "manual" });
			return { provider: providerId, target: target.origin, ok: true, status: response.status, ms: Date.now() - started };
		} catch (error) {
			return { provider: providerId, target: target.origin, ok: false, status: null, ms: Date.now() - started, error: String(error?.message ?? error).slice(0, 120) };
		}
	}

	async function passthrough(req, res, path, _body, sessionId) {
		const hasBody = Number(req.headers["content-length"] ?? 0) > 0;
		const body = hasBody ? await readBody(req) : undefined;
		return forward(req, res, resolveUpstreamTarget(path, config), body, sessionId, undefined, Date.now());
	}

	async function forward(req, res, target, body, sessionId, meta, started) {
		const base = new URL(target.origin);
		const url = new URL(target.pathWithQuery, base);
		const headers = { ...req.headers };
		delete headers.host;
		delete headers["content-length"];
		delete headers.connection;
		delete headers["transfer-encoding"];
		const apiKey = config.upstream.apiKey ?? (config.upstream.apiKeyEnv ? process.env[config.upstream.apiKeyEnv] : undefined);
		if (apiKey) {
			// The client's own key pointed at the proxy; the real key belongs upstream only.
			delete headers.authorization;
			delete headers["x-api-key"];
			headers.authorization = `Bearer ${apiKey}`;
			if (base.hostname.includes("anthropic")) headers["x-api-key"] = apiKey;
		}
		// else: forward the client's auth headers unchanged (chained lanes like bili MITM).
		if (body !== undefined) headers["content-type"] = "application/json";
		if (sessionId) headers["x-context-paging-session"] = sessionId;

		const transport = url.protocol === "https:" ? upstreamRequest : httpUpstreamRequest;
		const upstream = transport(url, { method: req.method, headers: body !== undefined ? { ...headers, "content-length": String(body.length) } : headers });
		upstream.on("error", async (error) => {
			res.writeHead(502, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: "upstream_unreachable", message: error.message }));
			await logLine({ session: sessionId, error: `upstream: ${error.message}` });
		});
		upstream.on("response", (upstreamRes) => {
			const headersOut = { ...upstreamRes.headers };
			delete headersOut["content-length"]; // body may differ from upstream's framing
			res.writeHead(upstreamRes.statusCode ?? 502, headersOut);
			const tee = createUsageTee(upstreamRes.headers["content-type"] ?? "");
			upstreamRes.on("data", (chunk) => {
				res.write(chunk);
				tee.push(chunk);
			});
			upstreamRes.on("end", async () => {
				res.end();
				const usage = tee.finish();
				await settle(sessionId, meta, started, upstreamRes.statusCode, usage);
			});
			upstreamRes.on("error", () => res.end());
		});
		if (body !== undefined) upstream.end(body);
		else req.pipe(upstream);
	}

	async function settle(sessionId, meta, started, status, usage) {
		if (!meta) return;
		const state = await states.load(sessionId);
		if (usage && usage.promptTokens > 0 && meta.estimatedTokens > 0) {
			// calibrate() is defined over the *uncalibrated* estimate, so undo the factor that
			// was applied when this request was measured.
			const rawEstimate = meta.estimatedTokens / (meta.calib || 1);
			state.calib = states.calibrate(state, rawEstimate, usage.promptTokens);
			await states.save(sessionId, state);
		}
		await logLine({
			session: sessionId,
			...meta,
			status,
			durationMs: Date.now() - started,
			...(usage ?? {}),
		});
	}

	server.states = states;
	server.resolver = resolver;
	return server;
}

export function splitSession(req) {
	const url = req.url ?? "/";
	const prefix = url.match(/^\/s\/([^/]+)(\/.*)?$/);
	if (prefix) return { sessionId: decodeURIComponent(prefix[1]), path: prefix[2] || "/" };
	const header = req.headers["x-context-paging-session"];
	if (typeof header === "string" && header !== "") {
		return { sessionId: header, path: url };
	}
	const query = url.match(/[?&]zcp_session=([^&]+)/);
	if (query) {
		return { sessionId: decodeURIComponent(query[1]), path: url.replace(/([?&])zcp_session=[^&]+/, "$1") };
	}
	// ZCode already stamps every model request with this header — free per-session routing.
	const zcodeSession = req.headers["x-session-id"];
	if (typeof zcodeSession === "string" && zcodeSession !== "") {
		return { sessionId: `sess_${zcodeSession}`, path: url };
	}
	return { sessionId: "default", path: url };
}

/**
 * Path-prefixed upstream tunneling, the same shape as billion-context's /bili/<upstream>:
 *   /zcp/<upstream-url><request-path><?query>
 * e.g. /zcp/https://openrouter.ai/api/v1/chat/completions forwards to
 *      https://openrouter.ai/api/v1/chat/completions.
 * The upstream base path and the request path arrive concatenated and cannot be split —
 * they are forwarded as one path, which is exactly what the provider baseUrl implies.
 */
export function parseTunnelPath(rawPath) {
	const match = String(rawPath ?? "").match(/^\/zcp\/(https?:\/\/[^/?]+)(\/[^?]*)?(\?.*)?$/);
	if (!match) return null;
	return {
		origin: match[1],
		pathWithQuery: (match[2] ?? "/") + (match[3] ?? ""),
	};
}

/** Strips the proxy's own session query parameter from any path+query. */
function stripSessionQuery(pathWithQuery) {
	return pathWithQuery.replace(/([?&])zcp_session=[^&]+/g, "$1").replace(/\?$/, "");
}

/** Resolves where a request should go: explicit tunnel first, then the configured lane. */
export function resolveUpstreamTarget(rawPath, config) {
	const tunnel = parseTunnelPath(rawPath);
	if (tunnel) return { origin: tunnel.origin, pathWithQuery: stripSessionQuery(tunnel.pathWithQuery) };
	const base = new URL(config.upstream.baseUrl);
	const cleanPath = stripSessionQuery(rawPath);
	const basePath = base.pathname.replace(/\/$/, "");
	const joined = basePath === "" || basePath === "/" ? cleanPath : basePath + (cleanPath.startsWith("/") ? cleanPath : "/" + cleanPath);
	return { origin: base.origin, pathWithQuery: joined + (base.search || "") };
}

function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				reject(new Error("request body exceeds the proxy limit"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}

/** Sniffs input-token usage out of streamed SSE or a buffered JSON response. */
// Anthropic reports prompt size across input_tokens + cache_*_input_tokens; the cached part is
// NOT included in input_tokens. Calibrating against input_tokens alone makes every cached
// (i.e. every steady-state) request look 10–40x cheaper than it is. OpenAI's prompt_tokens is
// already inclusive, so it is used as-is.
export function usageFrom(rawUsage) {
	if (!rawUsage || typeof rawUsage !== "object") return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, promptTokens: 0 };
	const inputTokens = Number(rawUsage.input_tokens ?? rawUsage.prompt_tokens ?? rawUsage.inputTokens ?? 0) || 0;
	const cacheReadTokens = Number(rawUsage.cache_read_input_tokens ?? 0) || 0;
	const cacheCreationTokens = Number(rawUsage.cache_creation_input_tokens ?? 0) || 0;
	const outputTokens = Number(rawUsage.output_tokens ?? rawUsage.completion_tokens ?? 0) || 0;
	const inclusive = rawUsage.prompt_tokens !== undefined && rawUsage.cache_read_input_tokens === undefined;
	return {
		inputTokens,
		outputTokens,
		cacheReadTokens,
		cacheCreationTokens,
		promptTokens: inclusive ? inputTokens : inputTokens + cacheReadTokens + cacheCreationTokens,
	};
}

function createUsageTee(contentType) {
	const isSse = String(contentType).includes("event-stream");
	let buffer = "";
	let usage;
	if (!isSse) {
		const chunks = [];
		return {
			push: (chunk) => chunks.push(chunk),
			finish: () => {
				try {
					const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
					usage = usageFrom(body.usage);
				} catch {
					usage = undefined;
				}
				return usage;
			},
		};
	}
	return {
		push: (chunk) => {
			buffer += chunk.toString("utf8");
			let match;
			// Anthropic message_start / message_delta and OpenAI final usage chunks.
			const dataLines = buffer.split("\n").filter((line) => line.startsWith("data:"));
			for (const line of dataLines) {
				try {
					const payload = JSON.parse(line.slice(5).trim());
					const raw = payload?.message?.usage ?? payload?.usage;
					if (!raw) continue;
					const next = usageFrom(raw);
					usage = {
						inputTokens: Math.max(usage?.inputTokens ?? 0, next.inputTokens),
						outputTokens: Math.max(usage?.outputTokens ?? 0, next.outputTokens),
						cacheReadTokens: Math.max(usage?.cacheReadTokens ?? 0, next.cacheReadTokens),
						cacheCreationTokens: Math.max(usage?.cacheCreationTokens ?? 0, next.cacheCreationTokens),
						promptTokens: Math.max(usage?.promptTokens ?? 0, next.promptTokens),
					};
				} catch {
					// partial SSE line; keep buffering
				}
			}
			if (buffer.length > 1_000_000) buffer = buffer.slice(-100_000);
		},
		finish: () => usage,
	};
}

function toolNameOf(message, toolCallId) {
	const blocks = Array.isArray(message?.content) ? message.content : [];
	for (const block of blocks) {
		if (block?.type === "tool_use" && block.id === toolCallId) return block.name;
	}
	if (Array.isArray(message?.tool_calls)) {
		for (const call of message.tool_calls) {
			if (call?.id === toolCallId) return call.function?.name;
		}
	}
	return undefined;
}

function hashOf(message) {
	return stableHash(message);
}
