---
description: Show zcode-context-paging status and recovery tool guidance for this session
---

Check whether the zcode-context-paging proxy is running and report this session's paging state.

Steps:

1. Run `node B:\git\zcode-context-paging\bin\zcp.mjs check` to confirm configuration and rollout access.
2. Probe `http://127.0.0.1:8787/__zcp/status/<session>` if the user names a session, otherwise `/__zcp/health`.
   - The SessionStart hook prints the session id in its context note when the proxy is active; otherwise
     use `node bin\zcp.mjs status default`.
3. Report: proxy on/off, token budget, trim target, frontier index (how many messages are currently
   paged out), and request/paged counters.
4. If the proxy is off, tell the user the two activation steps (run `zcp serve`, point the provider
   baseURL at it) but do not change any configuration yourself.
