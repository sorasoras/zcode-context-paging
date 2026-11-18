// One-shot installer: wires zcode-context-paging into the ZCode harness.
// Backs up both target files with a timestamp before touching anything.
import { copyFileSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const ts = new Date().toISOString().replace(/[:.]/g, "-");
const ZCP_ROOT = "B:/git/zcode-context-paging";

// --- 1. provider_config.json: rewire the ACTIVE provider to the zcp lane -------------------
const ppath = "C:/Users/Sora/.zcode/v2/provider_config.json";
copyFileSync(ppath, ppath + ".bak-zcp-" + ts);
const p = JSON.parse(readFileSync(ppath, "utf8"));
const rules = p.config.providerConfigRules.providerRules;
const rule = rules.find((r) => r.providerId === "f9fb3a7e-3a8c-42c5-ac55-7fa9bc52857f");
if (!rule) throw new Error("active provider rule not found");
const before = rule.config.api.baseUrl;
rule.config.api.baseUrl = "http://127.0.0.1:8787";
writeFileSync(ppath, JSON.stringify(p, null, 2) + "\n");
console.log(`provider baseUrl: ${before} -> ${rule.config.api.baseUrl}`);

// --- 2. config.json: SessionStart hook + MCP server + command registration -----------------
const cpath = "C:/Users/Sora/.zcode/cli/config.json";
copyFileSync(cpath, cpath + ".bak-zcp-" + ts);
const c = JSON.parse(readFileSync(cpath, "utf8"));
if (!c.hooks || typeof c.hooks !== "object") c.hooks = { enabled: true, events: {} };
c.hooks.enabled = true;
if (!c.hooks.events || typeof c.hooks.events !== "object") c.hooks.events = {};
if (!Array.isArray(c.hooks.events.SessionStart)) c.hooks.events.SessionStart = [];
const hookEntry = { type: "process", command: "node", args: [ZCP_ROOT + "/scripts/session-start.mjs"] };
const alreadyHooked = c.hooks.events.SessionStart.some((entry) =>
	(entry.hooks ?? []).some((hook) => JSON.stringify(hook.args ?? []).includes("zcode-context-paging")));
if (!alreadyHooked) c.hooks.events.SessionStart.push({ hooks: [hookEntry] });
if (!c.mcp || typeof c.mcp !== "object") c.mcp = {};
if (!c.mcp.servers || typeof c.mcp.servers !== "object") c.mcp.servers = {};
c.mcp.servers.zcp = { type: "stdio", command: "node", args: [ZCP_ROOT + "/src/mcp-server.mjs"] };
if (!c.command || typeof c.command !== "object") c.command = {};
c.command["C:\\Users\\Sora\\.zcode\\commands\\context-paging.md"] = { enable: true };
writeFileSync(cpath, JSON.stringify(c, null, 2) + "\n");
console.log(`config.json: SessionStart hook entries: ${c.hooks.events.SessionStart.length}`);
console.log(`config.json: mcp servers: ${Object.keys(c.mcp.servers).join(", ")}`);
console.log("config.json: /context-paging command registered");

// --- 3. command file into ~/.zcode/commands -------------------------------------------------
mkdirSync("C:/Users/Sora/.zcode/commands", { recursive: true });
copyFileSync(join(ZCP_ROOT, "plugin/commands/context-paging.md"), "C:/Users/Sora/.zcode/commands/context-paging.md");
console.log("command file installed: ~/.zcode/commands/context-paging.md");

// --- 4. parse-back verification --------------------------------------------------------------
JSON.parse(readFileSync(ppath, "utf8"));
JSON.parse(readFileSync(cpath, "utf8"));
console.log("both files parse cleanly");

// Show what backups were made.
console.log("backups:", [ppath, cpath].map((path) => path + ".bak-zcp-" + ts).join("\n         "));
