// Container health: the public release manifest of the service listener, read from inside the container. It needs no bearer, answers 200 in setup mode
// too and does not depend on the Admin plane's direct-peer allowlist.
import process from "node:process";

const { fetch, AbortSignal } = globalThis;
const port = process.env.REACH_PORT ?? "8787";
try {
  const res = await fetch(`http://127.0.0.1:${port}/release/manifest`, { signal: AbortSignal.timeout(4000) });
  process.exit(res.status === 200 ? 0 : 1);
} catch {
  process.exit(1);
}
