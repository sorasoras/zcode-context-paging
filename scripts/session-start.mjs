// SessionStart hook: purely advisory. It checks whether the zcode-context-paging proxy is
// running and, only then, tells the model the recovery tools exist. It never modifies any
// configuration, writes nothing, and prints nothing when the proxy is absent.
const PORT = process.env.ZCP_PORT ?? "8787";
const HOST = process.env.ZCP_HOST ?? "127.0.0.1";

try {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 500);
	const response = await fetch(`http://${HOST}:${PORT}/__zcp/health`, { signal: controller.signal });
	clearTimeout(timer);
	if (!response.ok) process.exit(0);
	const health = await response.json().catch(() => null);
	if (!health?.ok) process.exit(0);
	const context = [
		"[zcode-context-paging] The paging proxy is active for this session.",
		"Older conversation may have left the rolling window; nothing was summarized and the raw session history is unchanged.",
		"If context seems missing, use search_history or browse_history to find it, load_history for exact items,",
		"and read_context_output for exact output pages (part handles, 16 KiB pages). Continue the task; do not stop because of this notice.",
	].join(" ");
	// Claude-Code-shaped hook JSON; ZCode mirrors the schema (hook_event_name, additionalContext).
	process.stdout.write(JSON.stringify({
		hookSpecificOutput: {
			hookEventName: "SessionStart",
			additionalContext: context,
		},
	}));
} catch {
	// Proxy not running: stay completely silent and inert.
	process.exit(0);
}
