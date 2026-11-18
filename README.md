# zcode-context-paging

Plan A from the integration analysis: a **proxy lane** that gives ZCode the same rolling-window
context policy as [`@rochecompaan/pi-context-paging`](https://www.npmjs.com/package/@rochecompaan/pi-context-paging)
0.3.11 — bounded requests, a stable cut frontier, a deterministic paging notice that **copies**
(never summarizes) the evicted conversation, and four exact-recovery tools over the real session
history.

> **Nothing here is wired into ZCode yet.** No `~/.zcode` file is read for writing, no config is
> changed, no plugin is installed. Everything lives in `B:\git\zcode-context-paging` and the only
> contact with ZCode is *read-only* access to `~/.zcode/cli/rollout/model-io-*.jsonl`.

## Why a proxy

ZCode's hook surface has seven events (`SessionStart`, `UserPromptSubmit`, `PreToolUse`,
`PermissionRequest`, `PostToolUse`, `PostToolUseFailure`, `Stop`) — all *additive*. No hook can
remove messages from the outgoing model request, and none fires before auto-compaction. The only
seam that can rewrite a request in flight is the provider `baseURL`. So the paging engine lives in
a local HTTP shim; ZCode never sees a near-full context, which means its own auto-compaction never
triggers — the same "no surprise compaction" guarantee, obtained structurally.

Architecture (same shape as the `billion-context` ZCode lane already present in
`~/.zcode/cli/config.json`, different policy):

```
ZCode ──POST /v1/messages──▶ zcp proxy (127.0.0.1:8787)
                              │  1. parse body (Anthropic or OpenAI shape)
                              │  2. whole-turn eviction to tokenBudget → trimToTokens
                              │  3. deterministic paging notice (copied conversation)
                              │  4. forward untouched to upstream
                              ▼
                         real provider API
                              │
   ~/.zcode/cli/rollout/*.jsonl  ◀── read-only ── MCP recovery tools (search_history,
   (stored session history)                      browse_history, load_history,
                                                 read_context_output)
```

## What is ported from the package (MIT, © Roché Compaan)

| Package module | Port | Notes |
| --- | --- | --- |
| `context-policy.ts` | `src/policy.mjs` | whole-turn FIFO eviction, stable frontier, protected active request + newest unread tool results, protected-overflow send-once |
| `paging-notice.ts` | `src/notice.mjs` | header lines, copied conversation (newest-first fill, oldest-first display, 3 recent replies, 6,000-char clips, 500-char floor, 10%-of-budget section cap) |
| `recovery-response.ts` / `output-pages.ts` / `recovery-loads.ts` / `recovery-parts.ts` | `src/recovery.mjs` | 16 KiB reply budget, JSON header + page blocks, `next` handles, UTF-16 offsets, surrogate safety, deferred items, `mode:"parts"`, `mode:"image"` with native attachment |
| `navigator.ts` | `src/search.mjs` | token search (punctuation-trimmed identifiers, path separators), `tools`/`files`/`failed` filters, browse with stride |
| `history.ts` / selection lookup | `src/turns.mjs` + `src/wire.mjs` | turn/exchange grouping over wire shapes; thinking blocks stay private; recovery-tool traffic excluded from recovery |
| — | `src/session-state.mjs` | per-session frontier persistence + EMA calibration against real provider usage (the package's token accounting, simplified) |

The package's Pi-specific pieces (`pi.on("context")`, session-tree branching, extension status
footer) have no ZCode equivalent and are replaced by the proxy loop, the rollout store, and
`/__zcp/status/<session>`.

## Layout

```
bin/zcp.mjs            CLI: serve | mcp | status | check
config.default.json    budget 128k / trim 80k / port 8787 (override via config.local.json)
src/
  proxy-server.mjs     the lane: body rewrite, session routing, SSE passthrough, usage tee
  policy.mjs           cut engine (frontier apply/advance, notice rebuild, overflow)
  turns.mjs            completed-turn / exchange segmentation, tail protection
  notice.mjs           notice text builder + EvictedConversation
  wire.mjs             Anthropic/OpenAI normalization, hashing, resident estimate
  history-store.mjs    rollout jsonl → deduplicated public timeline (stable ids rNmK / rNresp)
  recovery.mjs         16 KiB paging, part handles, deferred items, image attachment
  search.mjs           search_history / browse_history
  session-state.mjs    frontier state files + calibration
  mcp-server.mjs       stdio MCP server exposing the four tools
scripts/
  replay.mjs           offline replay against a real rollout file via a mock upstream
  mcp-probe.mjs        end-to-end MCP probe against the real rollout (read-only)
  session-start.mjs    advisory SessionStart hook (silent unless the proxy is up)
plugin/                inert ZCode plugin (hooks + MCP + /context-paging command)
test/                  47 unit tests (node test/run-tests.mjs)
```

State and logs stay inside the project (`state/`, `logs/`, gitignored). Rollout access is
read-only; session transcripts are never written or modified.

## Session routing and lanes

The proxy needs to know which session a request belongs to. In order:

1. **Path prefix** — `http://127.0.0.1:8787/s/<sessionId>/v1/messages`
2. **Header** — `x-context-paging-session: <sessionId>`
3. **Query** — `?zcp_session=<sessionId>`
4. **ZCode's own `x-session-id` header** — present on every model request; nothing to configure.

Without any, requests route to `default`.

## All-provider lanes (billion-context style)

Like bili's `/bili/<upstream>`, the proxy tunnels any provider through the path:

```
http://127.0.0.1:8787/zcp/<upstream-url>
```

The upstream base path and the request path arrive concatenated and are forwarded as one —
so provider baseUrls compose exactly as they did against bili, including nesting:

```
http://127.0.0.1:8787/zcp/http://127.0.0.1:18788/bili/https://api.deepseek.com/anthropic
  = ZCode → zcp (paging) → bili (compression) → api.deepseek.com
```

All nine providers in `provider_config.json` are migrated this way (`scripts/migrate-lanes.mjs`).
Durability: bili's SessionStart hook unwraps only `^https?://host/bili/…` — our `…:8787/zcp/…`
URLs don't match, and their host is loopback, so the hook skips them; the lanes survive
session restarts (`scripts/migrate-lanes.mjs` asserts 9/9 durable).

## Verification (all read-only)

```sh
npm test                         # 47/47 pass
node scripts/replay.mjs --session sess_52a86d31 --budget 30000 --twice
node scripts/replay.mjs --session sess_52a86d31            # default 128k budget
node scripts/mcp-probe.mjs sess_52a86d31
```

Observed on the real `sess_52a86d31` rollout:

- **128k budget**: all 4 full snapshots pass through unpaged (`within budget: 4`).
- **30k budget**: all 4 paged; the 149-message request goes out as 22 messages + notice;
  re-sending any request produces a **byte-identical** outgoing body (stable frontier);
  original bodies are never mutated.
- **MCP probe**: `search_history` finds the session's first message, `load_history` returns it
  whole, `read_context_output` pages it with a correct header, unknown ids return `isError`.

## Monitor GUI

The proxy serves a self-contained dashboard (no dependencies, vanilla HTML) at:

```
http://127.0.0.1:8787/__zcp/gui      # or just http://127.0.0.1:8787/
zcp monitor                          # CLI: starts the proxy if down, then opens the browser
```

What it shows, in the spirit of bili's dashboard but read-only:

- **Overview cards** — request counts by mode (paged / within / overflow), last prompt tokens
  (with the cache-read split), last evicted-token estimate, session count, average duration.
- **Estimated-token chart** — bar per request over the last 60, amber when paged, red on
  protected-overflow, against the configured budget.
- **Sessions** — per-session frontier (messages paged out), request/paged counters, calibration
  factor, notice size.
- **Live request tail** — time, session, upstream host, mode badge, messages sent/total,
  estimate vs. real provider prompt tokens (the calibration evidence), duration, status.
- **Provider lanes** — every provider from `provider_config.json` with its lane classification
  (zcp tunnel / zcp / bili / direct), the resolved target, and a **reachability probe** button
  (GET on the resolved target root; status + latency, 4 s timeout).

Tabs:

| Tab | Contents |
| --- | --- |
| Overview | aggregate cards + estimated-token chart |
| Sessions | per-session frontier table |
| Requests | live log with mode/error/session filters |
| History | rollout explorer: pick a session, search public history (the same recovery view the MCP tools serve), open items with private blocks omitted |
| Notices | the actual paging-notice text each paged session's model sees |
| Lanes | provider lanes + connectivity probes |
| Config | effective resolved config (key material redacted to `set` / env name) |
| Help | policy summary + full endpoint list |

Plain JSON twins for scripting: `/__zcp/stats`, `/__zcp/sessions`, `/__zcp/log?limit=N`,
`/__zcp/lanes`, `/__zcp/config`, `/__zcp/rollouts`, `/__zcp/history?q=&session=&kind=&failed=1`,
`/__zcp/history/item?id=`, `/__zcp/notices`, `/__zcp/ping?provider=`, `/__zcp/health`,
`/__zcp/status/<session>`.

## Activation (not performed)

1. Start the proxy with a real upstream:
   ```sh
   ZCP_UPSTREAM_API_KEY=<key> node bin/zcp.mjs serve --port 8787
   # config.default.json → upstream.baseUrl must point at the real provider
   ```
2. Point ZCode's provider `baseURL` for the target model at `http://127.0.0.1:8787/s/<sessionId>`
   (per-session rewrite, the `billion-context` pattern), or set the header/query variant.
3. Optionally install the plugin for the recovery tools + `/context-paging` command:
   `zcode plugins install B:\git\zcode-context-paging\plugin` — the manifest references
   `../src/mcp-server.mjs`, so the repo must stay at its current path (or copy `src/` into the
   plugin and fix the arg).
4. `node bin/zcp.mjs check` and `/context-paging` in a session to confirm.

Removing it is trivial: stop the process, restore the original `baseURL`.

## Known limits

- **Token estimation** is characters/4 with EMA calibration from real usage (±25 % clamped).
  The package uses Pi's estimator; expect slightly different cut points, not different policy.
- **Tail-line rollout encoding**: rollout files interleave full snapshots (`request.messages`)
  and delta lines (`request.body.messages`). Both are indexed; positional reconstruction of
  deltas is not attempted — the newest full snapshot plus every delta still covers the session
  for search/browse, and ids are stable per line.
- **Branching/forks** are not tracked; a hash mismatch on the frontier anchor resets the cut
  (same recompute-from-scratch behavior as the package's fallback path).
- **No compaction veto**: keeping requests under budget prevents auto-compaction implicitly;
  a manual `/compact` still works and simply invalidates the frontier (hash reset).
- Subagent lanes get their own rollout files; point `ZCP_SESSION_ID` at one or use the newest.
