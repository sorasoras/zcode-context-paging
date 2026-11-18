// Self-contained monitor GUI served by the proxy at /__zcp/gui (and /).
// Vanilla HTML/JS, no dependencies. Tabs: Overview, Sessions, Requests, History,
// Notices, Lanes, Config, Help. Polls JSON endpoints every 2 seconds.
export const guiHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>zcp monitor — zcode-context-paging</title>
<style>
  :root {
    --bg: #0d1117; --panel: #161b22; --border: #30363d; --text: #c9d1d9;
    --dim: #8b949e; --green: #3fb950; --amber: #d29922; --red: #f85149;
    --blue: #58a6ff; --purple: #bc8cff; --mono: ui-monospace, "Cascadia Mono", Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 13px/1.45 var(--mono); }
  header { display: flex; align-items: center; gap: 14px; padding: 12px 20px; border-bottom: 1px solid var(--border); position: sticky; top: 0; background: var(--bg); z-index: 2; }
  header h1 { font-size: 15px; margin: 0; font-weight: 600; letter-spacing: .5px; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--red); box-shadow: 0 0 6px currentColor; }
  .dot.on { background: var(--green); color: var(--green); }
  .meta { color: var(--dim); font-size: 12px; }
  .spacer { flex: 1; }
  .pause { background: var(--panel); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 4px 12px; cursor: pointer; font: 12px var(--mono); }
  .pause:hover { border-color: var(--blue); }
  nav { display: flex; gap: 4px; padding: 0 20px; border-bottom: 1px solid var(--border); background: var(--bg); position: sticky; top: 45px; z-index: 2; overflow-x: auto; }
  nav button { background: none; border: none; border-bottom: 2px solid transparent; color: var(--dim); padding: 9px 14px; cursor: pointer; font: 12px var(--mono); white-space: nowrap; }
  nav button:hover { color: var(--text); }
  nav button.on { color: var(--blue); border-bottom-color: var(--blue); }
  main { padding: 18px 20px 40px; max-width: 1280px; margin: 0 auto; }
  section[hidden] { display: none; }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 1.2px; color: var(--dim); margin: 22px 0 10px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; }
  .card .k { color: var(--dim); font-size: 11px; text-transform: uppercase; letter-spacing: .8px; }
  .card .v { font-size: 22px; margin-top: 4px; }
  .card .s { color: var(--dim); font-size: 11px; margin-top: 2px; }
  table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
  th, td { padding: 7px 10px; text-align: left; border-bottom: 1px solid var(--border); white-space: nowrap; }
  th { color: var(--dim); font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: .6px; background: #11161d; }
  tr:last-child td { border-bottom: none; }
  td.dim, .dim { color: var(--dim); }
  .badge { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 11px; border: 1px solid; }
  .b-paged { color: var(--amber); border-color: var(--amber); }
  .b-within { color: var(--green); border-color: var(--green); }
  .b-overflow, .b-error { color: var(--red); border-color: var(--red); }
  .b-tunnel { color: var(--purple); border-color: var(--purple); }
  .b-bili { color: var(--blue); border-color: var(--blue); }
  .b-direct { color: var(--dim); border-color: var(--dim); }
  .b-ok { color: var(--green); border-color: var(--green); }
  .b-fail { color: var(--red); border-color: var(--red); }
  .b-user { color: var(--blue); border-color: var(--blue); }
  .b-assistant { color: var(--purple); border-color: var(--purple); }
  #chart { display: flex; align-items: flex-end; gap: 2px; height: 64px; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 8px; }
  #chart div { flex: 1; background: var(--blue); border-radius: 1px 1px 0 0; min-height: 1px; opacity: .85; }
  #chart div.paged { background: var(--amber); }
  #chart div.overflow { background: var(--red); }
  .controls { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; align-items: center; }
  .controls input, .controls select, .controls button { background: var(--panel); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 5px 10px; font: 12px var(--mono); }
  .controls input { min-width: 220px; }
  .controls button { cursor: pointer; }
  .controls button:hover { border-color: var(--blue); }
  .controls label { color: var(--dim); font-size: 12px; }
  pre { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 12px; overflow-x: auto; white-space: pre-wrap; word-break: break-word; font: 12px var(--mono); max-height: 480px; overflow-y: auto; }
  details { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; margin-bottom: 10px; padding: 8px 12px; }
  details summary { cursor: pointer; color: var(--dim); font-size: 12px; }
  .rowclick { cursor: pointer; }
  tr.rowclick:hover td { background: #1c2129; }
  .err { color: var(--red); padding: 20px; }
  .foot { color: var(--dim); font-size: 11px; margin-top: 26px; }
  a { color: var(--blue); text-decoration: none; }
  code { color: var(--purple); }
  .help td { white-space: normal; }
</style>
</head>
<body>
<header>
  <span class="dot" id="dot"></span>
  <h1>zcp monitor</h1>
  <span class="meta" id="hdr-meta">connecting…</span>
  <span class="spacer"></span>
  <button class="pause" id="pause">⏸ pause</button>
</header>
<nav id="tabs"></nav>
<main>
  <!-- ==================== overview ==================== -->
  <section data-tab="overview">
    <div class="cards" id="cards"></div>
    <h2>Estimated request tokens · last 60</h2>
    <div id="chart"></div>
  </section>

  <!-- ==================== sessions ==================== -->
  <section data-tab="sessions" hidden>
    <table id="sessions"><thead><tr>
      <th>session</th><th>frontier</th><th>requests</th><th>paged</th><th>evicted tok</th><th>calib</th><th>notice</th><th>updated</th>
    </tr></thead><tbody></tbody></table>
    <h2>Recent rollout activity · all sessions, any provider</h2>
    <div class="dim" style="margin-bottom:8px">Sessions whose model runs on a provider that bypasses this proxy (e.g. the built-in z.ai plan account) never touch the lane — they are tracked here and in the History tab only.</div>
    <table id="rollouts"><thead><tr>
      <th>session</th><th>rollout updated</th><th>size</th><th>last model on the wire</th><th>lane</th>
    </tr></thead><tbody></tbody></table>
  </section>

  <!-- ==================== requests ==================== -->
  <section data-tab="requests" hidden>
    <div class="controls">
      <select id="f-mode"><option value="">all modes</option><option>paged</option><option>within-budget</option><option>protected-overflow</option></select>
      <label><input type="checkbox" id="f-errors"> errors only</label>
      <input id="f-session" placeholder="session contains…"></input>
      <select id="f-limit"><option>40</option><option>100</option><option>200</option></select>
      <span class="dim" id="f-count"></span>
    </div>
    <table id="log"><thead><tr>
      <th>time</th><th>session</th><th>upstream</th><th>mode</th><th>msgs</th><th>frontier</th><th>est tok</th><th>prompt tok</th><th>dur</th><th>status</th>
    </tr></thead><tbody></tbody></table>
  </section>

  <!-- ==================== history ==================== -->
  <section data-tab="history" hidden>
    <div class="controls">
      <select id="h-session"></select>
      <input id="h-q" placeholder="search paged history…"></input>
      <select id="h-kind"><option value="">all kinds</option><option>user</option><option>assistant</option><option>system</option></select>
      <label><input type="checkbox" id="h-failed"> failed only</label>
      <button id="h-search">Search</button>
      <button id="h-recent">Recent</button>
      <span class="dim" id="h-status"></span>
    </div>
    <table id="h-results"><thead><tr>
      <th>seq</th><th>historyId</th><th>kind</th><th>tools</th><th>excerpt</th>
    </tr></thead><tbody></tbody></table>
    <div id="h-detail"></div>
  </section>

  <!-- ==================== notices ==================== -->
  <section data-tab="notices" hidden>
    <div id="notices" class="dim">no paged sessions yet — the notice is what the model sees when older context leaves the window</div>
  </section>

  <!-- ==================== lanes ==================== -->
  <section data-tab="lanes" hidden>
    <div class="controls">
      <button id="l-testall">Test all lanes</button>
      <span class="dim">GET probe of each lane's resolved target root — reachability, not API semantics</span>
    </div>
    <table id="lanes"><thead><tr>
      <th>provider</th><th>api</th><th>lane</th><th>target</th><th>models</th><th>probe</th>
    </tr></thead><tbody></tbody></table>
  </section>

  <!-- ==================== config ==================== -->
  <section data-tab="config" hidden>
    <div id="config-table"></div>
    <h2>Raw</h2>
    <pre id="config-json"></pre>
  </section>

  <!-- ==================== help ==================== -->
  <section data-tab="help" hidden>
    <h2>What this proxy does</h2>
    <p>ZCode's model requests pass through here before the provider. Whole completed turns
    older than the rolling window (budget <code id="help-budget"></code> tokens, trim target
    <code id="help-trim"></code>) are evicted from the outgoing request — never from the stored
    session — and a paging notice tells the model how to recover exact text with the
    <code>search_history</code> / <code>browse_history</code> / <code>load_history</code> /
    <code>read_context_output</code> tools. Nothing is summarized; ZCode's own auto-compaction
    never fires because requests stay under budget.</p>
    <h2>Lanes</h2>
    <p>Any provider can ride the path-prefixed tunnel, billion-context style:
    <code>http://127.0.0.1:8787/zcp/&lt;upstream-url&gt;</code> — including nested bili hops.
    Per-session frontiers ride ZCode's own <code>x-session-id</code> header.</p>
    <h2>JSON endpoints</h2>
    <table class="help"><tbody>
      <tr><td><code>/__zcp/health</code></td><td class="dim">liveness, version, uptime</td></tr>
      <tr><td><code>/__zcp/stats</code></td><td class="dim">aggregate of the access log</td></tr>
      <tr><td><code>/__zcp/sessions</code></td><td class="dim">per-session frontier state files</td></tr>
      <tr><td><code>/__zcp/log?limit=N</code></td><td class="dim">recent requests, chronological</td></tr>
      <tr><td><code>/__zcp/lanes</code></td><td class="dim">provider lanes with classification</td></tr>
      <tr><td><code>/__zcp/config</code></td><td class="dim">effective config (keys redacted)</td></tr>
      <tr><td><code>/__zcp/rollouts</code></td><td class="dim">known rollout session files</td></tr>
      <tr><td><code>/__zcp/history?q=&amp;session=</code></td><td class="dim">search public rollout history</td></tr>
      <tr><td><code>/__zcp/history/item?id=</code></td><td class="dim">one public history item + parts</td></tr>
      <tr><td><code>/__zcp/notices</code></td><td class="dim">current paging notice text per session</td></tr>
      <tr><td><code>/__zcp/ping?provider=</code></td><td class="dim">reachability probe of one lane</td></tr>
    </tbody></table>
    <h2>Recovery from a session</h2>
    <p>Older detail lives in <code>~/.zcode/cli/rollout/model-io-*.jsonl</code> (read-only here).
    The model recovers it with the MCP tools; the History tab above is the same view, for humans.</p>
  </section>

  <div class="foot" id="foot">
    JSON: <a href="/__zcp/stats">stats</a> · <a href="/__zcp/sessions">sessions</a> · <a href="/__zcp/log?limit=200">log</a> · <a href="/__zcp/lanes">lanes</a> · <a href="/__zcp/config">config</a> · <a href="/__zcp/rollouts">rollouts</a> · <a href="/__zcp/notices">notices</a> · <a href="/__zcp/health">health</a>
     — paging policy ported from <code>@rochecompaan/pi-context-paging</code>
  </div>
  <div class="err" id="err" hidden></div>
</main>
<script>
"use strict";
var paused = false;
var BUDGET = 0;
var activeTab = "overview";
var rolloutsCache = [];
var lanesCache = [];
var logCache = [];
var sessionsCache = [];

document.getElementById("pause").onclick = function () {
  paused = !paused;
  document.getElementById("pause").textContent = paused ? "▶ resume" : "⏸ pause";
};

var TABS = ["overview", "sessions", "requests", "history", "notices", "lanes", "config", "help"];
var nav = document.getElementById("tabs");
TABS.forEach(function (name) {
  var button = document.createElement("button");
  button.textContent = name;
  button.dataset.tab = name;
  button.onclick = function () { showTab(name); };
  nav.appendChild(button);
});

function showTab(name) {
  activeTab = name;
  document.querySelectorAll("nav button").forEach(function (b) { b.className = b.dataset.tab === name ? "on" : ""; });
  document.querySelectorAll("main section[data-tab]").forEach(function (section) {
    section.hidden = section.dataset.tab !== name;
  });
  if (name === "history") bootHistory();
  if (name === "notices") loadNotices();
  if (name === "config") loadConfig();
}
showTab("overview");

function esc(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function shortSession(id) {
  var parts = String(id || "").replace(/^sess_/, "").split("-");
  return parts.length > 1 ? parts[0].slice(0, 8) + "…" + parts[parts.length - 1].slice(0, 6) : String(id || "").slice(0, 16);
}
function badge(mode) {
  var cls = mode === "within-budget" ? "b-within" : mode === "paged" ? "b-paged" : "b-overflow";
  var label = mode === "within-budget" ? "within" : mode === "paged" ? "paged" : mode || "?";
  return '<span class="badge ' + cls + '">' + esc(label) + "</span>";
}
function fmtTok(n) {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(Math.round(n));
}
function fmtDur(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  return ms >= 1000 ? (ms / 1000).toFixed(1) + "s" : ms + "ms";
}
function fmtUptime(sec) {
  var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return h > 0 ? h + "h " + m + "m" : m + "m " + Math.floor(sec % 60) + "s";
}
function fmtBytes(n) {
  return n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.round(n / 1024) + " KB";
}
function providerLabel(providerId) {
  var id = String(providerId || "");
  if (id.indexOf("account:") === 0 || id.indexOf("builtin:") === 0) return "plan (z.ai)";
  if (id.indexOf("f9fb3a7e") === 0) return "Deepseek (lane)";
  if (id.indexOf("new-prov") === 0) return "custom provider";
  if (id === "") return "unknown";
  return id.slice(0, 10);
}
function getJson(url) {
  return fetch(url).then(function (r) {
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  });
}

function renderHeader(stats) {
  document.getElementById("dot").className = "dot on";
  document.getElementById("hdr-meta").textContent =
    "v" + esc(stats.version) + " · budget " + fmtTok(stats.budgetTokens) + " tok" +
    " · trim " + fmtTok(stats.trimToTokens) + " · up " + fmtUptime(stats.uptimeSec || 0) +
    (stats.enabled ? "" : " · DISABLED");
}

function renderCards(stats) {
  var byMode = stats.byMode || {};
  var cards = [
    ["requests", fmtTok(stats.logRequests), "in view"],
    ["paged", fmtTok(byMode.paged || 0), Math.round((byMode.paged || 0) / Math.max(1, stats.logRequests) * 100) + "% of requests"],
    ["within budget", fmtTok(byMode["within-budget"] || 0), "passed through"],
    ["overflow", fmtTok(byMode["protected-overflow"] || 0), "sent once in full"],
    ["prompt tok (last)", fmtTok(stats.promptLast), "incl. cache " + fmtTok(stats.cacheReadLast)],
    ["evicted tok (last)", fmtTok(stats.evictedLast), "paged out of window"],
    ["sessions", fmtTok(stats.sessionsSeen), "known to the proxy"],
    ["avg duration", fmtDur(stats.avgDuration), "last " + stats.logRequests + " requests"]
  ];
  document.getElementById("cards").innerHTML = cards.map(function (c) {
    return '<div class="card"><div class="k">' + esc(c[0]) + '</div><div class="v">' + esc(c[1]) + '</div><div class="s">' + esc(c[2]) + "</div></div>";
  }).join("");
}

function renderChart(log) {
  var rows = log.filter(function (e) { return e.mode !== undefined; }).slice(-60);
  document.getElementById("chart").innerHTML = rows.map(function (e) {
    var pct = Math.max(2, Math.min(100, (e.estimatedTokens || 0) / Math.max(1, BUDGET) * 100));
    var cls = e.mode === "paged" ? "paged" : e.mode === "protected-overflow" ? "overflow" : "";
    var title = e.ts + " · " + e.mode + " · est " + e.estimatedTokens + " tok";
    return '<div class="' + cls + '" style="height:' + pct + '%" title="' + esc(title) + '"></div>';
  }).join("") || '<div style="background:none"></div>';
}

function renderSessions(sessions) {
  document.querySelector("#sessions tbody").innerHTML = sessions.map(function (s) {
    return "<tr><td>" + esc(s.sessionId) + "</td>" +
      "<td class='dim'>" + esc(s.frontierIndex) + " msgs</td>" +
      "<td>" + esc(s.stats && s.stats.requests || 0) + "</td>" +
      "<td>" + esc(s.stats && s.stats.paged || 0) + "</td>" +
      "<td class='dim'>" + fmtTok(s.stats && s.stats.tokensSaved || 0) + "</td>" +
      "<td class='dim'>" + Math.round((s.calib || 1) * 100) / 100 + "</td>" +
      "<td class='dim'>" + (s.noticeChars ? s.noticeChars + " chars" : "—") + "</td>" +
      "<td class='dim'>" + esc((s.updatedAt || "").slice(0, 19).replace("T", " ")) + "</td></tr>";
  }).join("") || "<tr><td colspan='8' class='dim'>no sessions yet</td></tr>";
}

function logFilters() {
  var mode = document.getElementById("f-mode").value;
  var errorsOnly = document.getElementById("f-errors").checked;
  var sessionNeedle = document.getElementById("f-session").value.toLowerCase();
  return logCache.filter(function (e) {
    if (e.mode === undefined && e.error === undefined) return false;
    if (mode && e.mode !== mode) return false;
    if (errorsOnly && !((e.status >= 400) || e.error)) return false;
    if (sessionNeedle && String(e.session || "").toLowerCase().indexOf(sessionNeedle) < 0) return false;
    return true;
  });
}

function renderLog() {
  var rows = logFilters().slice(-Number(document.getElementById("f-limit").value)).reverse();
  document.getElementById("f-count").textContent = rows.length + " shown";
  document.querySelector("#log tbody").innerHTML = rows.map(function (e) {
    if (e.error) return "<tr><td class='dim'>" + esc((e.ts || "").slice(11, 19)) + "</td><td colspan='9' style='color:var(--red)'>" + esc(e.error) + "</td></tr>";
    var prompt = e.promptTokens != null
      ? fmtTok(e.promptTokens) + (e.cacheReadTokens ? " <span class='dim'>(cache " + fmtTok(e.cacheReadTokens) + ")</span>" : "")
      : "—";
    return "<tr>" +
      "<td class='dim'>" + esc((e.ts || "").slice(11, 19)) + "</td>" +
      "<td title='" + esc(e.session) + "'>" + esc(shortSession(e.session)) + "</td>" +
      "<td class='dim'>" + esc(e.upstream || "") + "</td>" +
      "<td>" + badge(e.mode) + "</td>" +
      "<td>" + esc(e.sentMessages != null ? e.sentMessages + "/" + e.originalMessages : "—") + "</td>" +
      "<td class='dim'>" + esc(e.frontierIndex != null ? e.frontierIndex : "—") + "</td>" +
      "<td>" + fmtTok(e.estimatedTokens) + "</td>" +
      "<td>" + prompt + "</td>" +
      "<td class='dim'>" + fmtDur(e.durationMs) + "</td>" +
      "<td class='" + (e.status >= 400 ? "" : "dim") + "' style='" + (e.status >= 400 ? "color:var(--red)" : "") + "'>" + esc(e.status || "—") + "</td></tr>";
  }).join("") || "<tr><td colspan='10' class='dim'>no matching requests</td></tr>";
}

["f-mode", "f-errors", "f-session", "f-limit"].forEach(function (id) {
  document.getElementById(id).addEventListener("change", renderLog);
  document.getElementById(id).addEventListener("input", renderLog);
});

function renderLanes(lanes) {
  lanesCache = lanes;
  document.querySelector("#lanes tbody").innerHTML = lanes.map(function (l, index) {
    var lane = l.lane === "zcp" ? "<span class='badge b-tunnel'>zcp tunnel</span>"
      : l.lane === "zcp-lane" ? "<span class='badge b-tunnel'>zcp</span>"
      : l.lane === "bili" ? "<span class='badge b-bili'>bili</span>"
      : "<span class='badge b-direct'>direct</span>";
    var target = l.lane === "zcp" ? l.upstream : l.baseUrl;
    return "<tr><td>" + esc(l.name) + (l.active ? " <span class='badge b-ok'>active</span>" : "") + "</td>" +
      "<td class='dim'>" + esc(l.api) + "</td>" +
      "<td>" + lane + "</td>" +
      "<td class='dim' title='" + esc(target) + "'>" + esc(String(target).replace(/^https?:\\/\\//, "").slice(0, 64)) + "</td>" +
      "<td class='dim'>" + esc((l.models || []).join(", ").slice(0, 60)) + "</td>" +
      "<td><button class='pause' data-ping='" + esc(l.id) + "'>test</button> <span id='ping-" + esc(l.id) + "' class='dim'></span></td></tr>";
  }).join("");
  document.querySelectorAll("#lanes button[data-ping]").forEach(function (button) {
    button.onclick = function () { pingLane(button.dataset.ping, button); };
  });
}

function pingLane(providerId, button) {
  var out = document.getElementById("ping-" + providerId);
  if (button) button.disabled = true;
  if (out) out.textContent = "probing…";
  getJson("/__zcp/ping?provider=" + encodeURIComponent(providerId)).then(function (result) {
    if (out) out.innerHTML = result.ok
      ? "<span class='badge b-ok'>" + esc(result.status) + " · " + fmtDur(result.ms) + "</span>"
      : "<span class='badge b-fail' title='" + esc(result.error || "") + "'>fail · " + esc(result.error || "").slice(0, 40) + "</span>";
  }).catch(function (error) {
    if (out) out.innerHTML = "<span class='badge b-fail'>" + esc(error.message || error) + "</span>";
  }).finally(function () { if (button) button.disabled = false; });
}

document.getElementById("l-testall").onclick = function () {
  lanesCache.forEach(function (lane) {
    var button = document.querySelector("#lanes button[data-ping='" + lane.id + "']");
    pingLane(lane.id, button);
  });
};

// ---------------- history explorer ----------------
function bootHistory() {
  if (document.getElementById("h-session").options.length > 0) return;
  var fill = function (rollouts) {
    rolloutsCache = rollouts;
    var select = document.getElementById("h-session");
    select.innerHTML = rollouts.map(function (r) {
      return "<option value='" + esc(r.sessionId) + "'>" + esc(shortSession(r.sessionId)) +
        " · " + fmtBytes(r.sizeBytes) + " · " + esc((r.updatedAt || "").slice(0, 16).replace("T", " ")) + "</option>";
    }).join("");
    document.getElementById("h-status").textContent = rollouts.length + " rollout sessions";
    if (rollouts.length > 0) searchHistory();
  };
  if (rolloutsCache.length > 0) { fill(rolloutsCache); return; }
  getJson("/__zcp/rollouts").then(fill).catch(function (error) {
    document.getElementById("h-status").textContent = "rollouts unavailable: " + (error.message || error);
  });
}

function searchHistory() {
  var session = document.getElementById("h-session").value;
  var q = document.getElementById("h-q").value.trim();
  var kind = document.getElementById("h-kind").value;
  var failed = document.getElementById("h-failed").checked ? "1" : "";
  var url = "/__zcp/history?session=" + encodeURIComponent(session) + "&limit=15" +
    (q ? "&q=" + encodeURIComponent(q) : "") + (kind ? "&kind=" + kind : "") + (failed ? "&failed=1" : "") +
    (q || kind || failed ? "" : "&recent=1");
  document.getElementById("h-status").textContent = "searching…";
  getJson(url).then(function (result) {
    if (result.note) { document.getElementById("h-status").textContent = result.note; }
    else { document.getElementById("h-status").textContent = (result.references || []).length + " references" + (result.query ? " for “" + result.query + "”" : ""); }
    document.querySelector("#h-results tbody").innerHTML = (result.references || []).map(function (r) {
      return "<tr class='rowclick' data-id='" + esc(r.historyId) + "'>" +
        "<td class='dim'>" + esc(r.sequence) + "</td>" +
        "<td><code>" + esc(r.historyId) + "</code></td>" +
        "<td><span class='badge " + (r.kind === "user" ? "b-user" : r.kind === "assistant" ? "b-assistant" : "b-direct") + "'>" + esc(r.kind) + "</span></td>" +
        "<td class='dim'>" + esc((r.tools || []).join(", ")) + "</td>" +
        "<td class='dim' style='white-space:normal;max-width:520px'>" + esc(r.excerpt || "") + "</td></tr>";
    }).join("") || "<tr><td colspan='5' class='dim'>no matches</td></tr>";
    document.querySelectorAll("#h-results tr.rowclick").forEach(function (row) {
      row.onclick = function () { loadItem(row.dataset.id); };
    });
  }).catch(function (error) {
    document.getElementById("h-status").textContent = "search failed: " + (error.message || error);
  });
}

function loadItem(id) {
  var session = document.getElementById("h-session").value;
  var detail = document.getElementById("h-detail");
  detail.innerHTML = "<div class='dim'>loading " + esc(id) + "…</div>";
  getJson("/__zcp/history/item?session=" + encodeURIComponent(session) + "&id=" + encodeURIComponent(id)).then(function (result) {
    var item = result.item || {};
    var html = "<h2>" + esc(item.kind) + " · <code>" + esc(item.id) + "</code></h2>";
    if (item.text) html += "<pre>" + esc(String(item.text).slice(0, 6000)) + (String(item.text).length > 6000 ? "\\n… [" + fmtTok(String(item.text).length - 6000) + " more chars]" : "") + "</pre>";
    if (item.toolCalls) html += "<pre>" + esc(JSON.stringify(item.toolCalls, null, 2).slice(0, 4000)) + "</pre>";
    if (item.content && Array.isArray(item.content)) {
      html += item.content.map(function (block, index) {
        if (block === null) return "<div class='dim'>[" + index + "] omitted (private)</div>";
        if (block.type === "text") return "<pre>" + esc(block.text.slice(0, 4000)) + "</pre>";
        return "<pre>" + esc(JSON.stringify(block, null, 2).slice(0, 3000)) + "</pre>";
      }).join("");
    }
    if (item.toolResults && item.toolResults.length > 0) {
      html += item.toolResults.map(function (result) {
        var text = typeof result.content === "string" ? result.content : JSON.stringify(result.content);
        return "<h2>tool result · <code>" + esc(result.toolCallId) + "</code>" + (result.isError ? " <span class='badge b-fail'>error</span>" : "") + "</h2><pre>" +
          esc(String(text).slice(0, 6000)) + (String(text).length > 6000 ? "\\n… [" + fmtTok(String(text).length - 6000) + " more chars]" : "") + "</pre>";
      }).join("");
    }
    html += "<h2>Public parts</h2><pre>" + esc(JSON.stringify(result.parts, null, 2).slice(0, 3000)) + "</pre>";
    detail.innerHTML = html;
  }).catch(function (error) {
    detail.innerHTML = "<div class='err'>" + esc(error.message || error) + "</div>";
  });
}

document.getElementById("h-search").onclick = searchHistory;
document.getElementById("h-recent").onclick = function () {
  document.getElementById("h-q").value = "";
  document.getElementById("h-kind").value = "";
  document.getElementById("h-failed").checked = false;
  searchHistory();
};
document.getElementById("h-q").addEventListener("keydown", function (event) {
  if (event.key === "Enter") searchHistory();
});
document.getElementById("h-session").addEventListener("change", searchHistory);
document.getElementById("h-kind").addEventListener("change", searchHistory);
document.getElementById("h-failed").addEventListener("change", searchHistory);

// ---------------- notices ----------------
function loadNotices() {
  getJson("/__zcp/notices").then(function (notices) {
    document.getElementById("notices").innerHTML = notices.length > 0
      ? notices.map(function (n) {
        return "<details open><summary>" + esc(shortSession(n.sessionId)) + " · " + fmtTok(n.noticeChars) + " chars</summary>" +
          "<pre>" + esc(n.noticeText) + "</pre></details>";
      }).join("")
      : "<div class='dim' id='notices'>no paging notices yet</div>";
  }).catch(function (error) {
    document.getElementById("notices").innerHTML = "<div class='err'>" + esc(error.message || error) + "</div>";
  });
}

// ---------------- config ----------------
function loadConfig() {
  getJson("/__zcp/config").then(function (cfg) {
    var rows = [
      ["version", cfg.version], ["enabled", cfg.enabled], ["host:port", cfg.host + ":" + cfg.port],
      ["token budget", fmtTok(cfg.tokenBudget) + " tok (effective " + fmtTok(cfg.budgetTokens) + ")"],
      ["trim target", fmtTok(cfg.trimToTokens) + " tok"],
      ["model context window", cfg.modelContextWindow ? fmtTok(cfg.modelContextWindow) + " tok" : "unlimited"],
      ["upstream baseUrl", cfg.upstream.baseUrl],
      ["upstream api key", cfg.upstream.apiKeySet ? "<span class='badge b-ok'>set</span>" : "forwarding client auth", true],
      ["upstream key env", cfg.upstream.apiKeyEnv || "—"],
      ["rollout dir", cfg.rolloutDir], ["state dir", cfg.stateDir], ["log dir", cfg.logDir],
      ["provider config", cfg.providerConfigPath || "—"],
    ];
    document.getElementById("config-table").innerHTML = "<table><tbody>" + rows.map(function (r) {
      return "<tr><td class='dim' style='width:220px'>" + esc(r[0]) + "</td><td>" + (r[2] ? r[1] : esc(r[1])) + "</td></tr>";
    }).join("") + "</tbody></table>";
    document.getElementById("config-json").textContent = JSON.stringify(cfg, null, 2);
  }).catch(function (error) {
    document.getElementById("config-table").innerHTML = "<div class='err'>" + esc(error.message || error) + "</div>";
  });
}

// ---------------- poll loop ----------------
function renderError(message) {
  document.getElementById("dot").className = "dot";
  var el = document.getElementById("err");
  el.hidden = false;
  el.textContent = "proxy unreachable: " + message;
}

function tick() {
  if (paused) return;
  Promise.all([
    getJson("/__zcp/stats"),
    getJson("/__zcp/sessions"),
    getJson("/__zcp/log?limit=200"),
    getJson("/__zcp/lanes"),
    getJson("/__zcp/rollouts"),
  ]).then(function (all) {
    var stats = all[0];
    sessionsCache = all[1];
    logCache = all[2];
    rolloutsCache = all[4];
    document.getElementById("err").hidden = true;
    BUDGET = stats.budgetTokens || 0;
    document.getElementById("help-budget").textContent = fmtTok(BUDGET);
    document.getElementById("help-trim").textContent = fmtTok(stats.trimToTokens);
    renderHeader(stats);
    renderCards(stats);
    renderChart(logCache);
    renderSessions(sessionsCache);
    renderLog();
    renderLanes(all[3]);
  }).catch(function (error) {
    renderError(error.message || error);
  });
}

tick();
setInterval(tick, 2000);
</script>
</body>
</html>`;
