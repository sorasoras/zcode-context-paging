// Runs every test module sequentially with the tiny local harness.
import { runAll } from "./harness.mjs";

await import("./policy.test.mjs");
await import("./pairing.test.mjs");
await import("./notice.test.mjs");
await import("./recovery.test.mjs");
await import("./search.test.mjs");
await import("./wire.test.mjs");
await import("./usage.test.mjs");
await import("./tunnel.test.mjs");
await import("./monitor.test.mjs");
await import("./tabs.test.mjs");

const failed = await runAll();
process.exitCode = failed.length === 0 ? 0 : 1;
