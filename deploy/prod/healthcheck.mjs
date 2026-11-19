// Container health: the setup-safe admin status route of the one listener, read from inside the container. It needs no bearer and answers 200
// in setup mode too.
import process from "node:process";

const { fetch, AbortSignal } = globalThis;
const port = process.env.REACH_PORT ?? "8787";
try {
  const res = await fetch(`http://127.0.0.1:${port}/admin/api/state`, { signal: AbortSignal.timeout(4000) });
  process.exit(res.status === 200 ? 0 : 1);
} catch {
  process.exit(1);
}
