#!/usr/bin/env node
// zcp — control CLI for zcode-context-paging.
//   zcp serve [--port N] [--config PATH]   start the paging proxy
//   zcp monitor [--port N] [--config PATH] open the monitor GUI (starts the proxy if needed)
//   zcp mcp   [--config PATH]              run the recovery MCP server on stdio
//   zcp status [SESSION] [--config PATH]   print per-session frontier state
//   zcp check  [--config PATH]             validate config + rollout dir readability
import { spawn } from "node:child_process";
import { loadConfig } from "../src/config.mjs";
import { createProxyServer } from "../src/proxy-server.mjs";
import { resolveRolloutFiles } from "../src/history-store.mjs";
import { SessionStates } from "../src/session-state.mjs";

function parseArgs(argv) {
	const args = { _: [] };
	for (let index = 0; index < argv.length; index++) {
		const token = argv[index];
		if (token === "--config") args.config = argv[++index];
		else if (token === "--port") args.port = Number(argv[++index]);
		else if (token === "--rollout") args.rollout = argv[++index];
		else if (token === "--budget") args.budget = Number(argv[++index]);
		else args._.push(token);
	}
	return args;
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0] ?? "help";
const config = await loadConfig(args.config);
if (args.port !== undefined) config.port = args.port;
if (args.rollout !== undefined) config.rolloutDir = args.rollout;
if (args.budget !== undefined && Number.isSafeInteger(args.budget) && args.budget > 0) {
	config.tokenBudget = args.budget;
	config.budgetTokens = args.budget;
	config.trimToTokens = Math.max(1, Math.floor((args.budget * 5) / 8));
}

if (command === "serve") {
	const server = createProxyServer(config);
	server.listen(config.port, config.host, () => {
		console.error(`zcode-context-paging proxy on http://${config.host}:${config.port}`);
		console.error(`  upstream:        ${config.upstream.baseUrl}`);
		console.error(`  token budget:    ${config.budgetTokens} (trim to ${config.trimToTokens})`);
		console.error(`  rollout dir:     ${config.rolloutDir} (read-only)`);
		console.error(`  session routing: /s/<sessionId>/... , x-session-id, x-context-paging-session header, ?zcp_session=`);
		console.error(`  lanes:           /zcp/<upstream-url>  (billion-context style path tunneling)`);
		console.error(`  monitor GUI:     http://${config.host}:${config.port}/__zcp/gui`);
	});
} else if (command === "monitor") {
	const guiUrl = `http://${config.host}:${config.port}/__zcp/gui`;
	const healthy = async () => {
		try {
			const response = await fetch(`http://${config.host}:${config.port}/__zcp/health`, { signal: AbortSignal.timeout(500) });
			return response.ok;
		} catch {
			return false;
		}
	};
	if (!(await healthy())) {
		console.error(`proxy not running on ${config.host}:${config.port} — starting it detached…`);
		const child = spawn(process.execPath, [process.argv[1], "serve", ...(args.config ? ["--config", args.config] : [])], {
			detached: true,
			stdio: "ignore",
		});
		child.unref();
		const deadline = Date.now() + 6000;
		while (!(await healthy()) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 150));
		if (!(await healthy())) {
			console.error("proxy failed to start — run `zcp serve` to see the error.");
			process.exit(1);
		}
	}
	const opener = process.platform === "win32" ? ["cmd", ["/c", "start", "", guiUrl]]
		: process.platform === "darwin" ? ["open", [guiUrl]]
		: ["xdg-open", [guiUrl]];
	spawn(opener[0], opener[1], { detached: true, stdio: "ignore" }).unref();
	console.log(`zcp monitor: ${guiUrl}`);
} else if (command === "mcp") {
	const { serveStdio } = await import("../src/mcp-server.mjs");
	await serveStdio(config);
} else if (command === "status") {
	const sessionId = args._[1] ?? "default";
	const states = new SessionStates(config.stateDir);
	const state = await states.load(sessionId);
	console.log(JSON.stringify({ sessionId, ...state, budgetTokens: config.budgetTokens, trimToTokens: config.trimToTokens }, null, 2));
} else if (command === "check") {
	const files = await resolveRolloutFiles(config.rolloutDir, process.env.ZCP_SESSION_ID ?? null);
	console.log(JSON.stringify({
		config: "ok",
		enabled: config.enabled,
		budgetTokens: config.budgetTokens,
		trimToTokens: config.trimToTokens,
		upstream: config.upstream.baseUrl,
		rolloutDir: config.rolloutDir,
		rolloutFiles: files.length,
		newest: files[0] ?? null,
	}, null, 2));
} else {
	console.log(`zcp — zcode-context-paging

  serve    start the paging proxy (default port ${config.port})
  mcp      run the recovery MCP server on stdio
  status   print per-session frontier state
  check    validate config and rollout access

Flags: --config PATH  --port N  --budget N  --rollout DIR`);
}
