import { test, assert, assertEqual } from "./harness.mjs";
import { parseTunnelPath, resolveUpstreamTarget, splitSession } from "../src/proxy-server.mjs";

function fakeReq(url, headers = {}) {
	return { url, headers };
}

const laneConfig = { upstream: { baseUrl: "http://127.0.0.1:18788/bili/https://api.deepseek.com/anthropic" } };

test("tunnel parses scheme, authority, and the concatenated request path", () => {
	const target = parseTunnelPath("/zcp/https://openrouter.ai/api/v1/chat/completions");
	assertEqual(target, { origin: "https://openrouter.ai", pathWithQuery: "/api/v1/chat/completions" });
});

test("tunnel keeps inner bili prefixes intact for chained lanes", () => {
	const target = parseTunnelPath("/zcp/http://127.0.0.1:18788/bili/https://api.deepseek.com/anthropic/v1/messages");
	assertEqual(target, {
		origin: "http://127.0.0.1:18788",
		pathWithQuery: "/bili/https://api.deepseek.com/anthropic/v1/messages",
	});
});

test("tunnel preserves query strings and bare origins", () => {
	assertEqual(parseTunnelPath("/zcp/https://host.example"), { origin: "https://host.example", pathWithQuery: "/" });
	assertEqual(parseTunnelPath("/zcp/https://host.example/v1/x?stream=true&zcp_session=sess_1"), {
		origin: "https://host.example",
		pathWithQuery: "/v1/x?stream=true&zcp_session=sess_1",
	});
});

test("resolveUpstreamTarget strips the session query from tunnels and the default lane", () => {
	assertEqual(resolveUpstreamTarget("/zcp/https://host.example/v1/x?stream=true&zcp_session=sess_1", laneConfig), {
		origin: "https://host.example",
		pathWithQuery: "/v1/x?stream=true&",
	});
	assertEqual(resolveUpstreamTarget("/v1/messages?zcp_session=sess_1", laneConfig), {
		origin: "http://127.0.0.1:18788",
		pathWithQuery: "/bili/https://api.deepseek.com/anthropic/v1/messages",
	});
	assertEqual(resolveUpstreamTarget("/zcp/https://host.example/api/v1/chat/completions", laneConfig), {
		origin: "https://host.example",
		pathWithQuery: "/api/v1/chat/completions",
	});
});

test("non-tunnel paths return null", () => {
	assertEqual(parseTunnelPath("/v1/messages"), null);
	assertEqual(parseTunnelPath("/__zcp/health"), null);
	assertEqual(parseTunnelPath("/zcpx/https://host"), null);
	assertEqual(parseTunnelPath("/zcp/ftp://host/x"), null);
	assertEqual(parseTunnelPath(undefined), null);
});

test("session prefix composes with the tunnel", () => {
	const { path } = splitSession(fakeReq("/s/sess1/zcp/https://host.example/v1/messages"));
	assertEqual(path, "/zcp/https://host.example/v1/messages");
	assertEqual(parseTunnelPath(path), { origin: "https://host.example", pathWithQuery: "/v1/messages" });
});

test("x-session-id still routes tunnels per session", () => {
	const { sessionId } = splitSession(fakeReq("/zcp/https://host.example/v1/messages", { "x-session-id": "abc" }));
	assertEqual(sessionId, "sess_abc");
});
