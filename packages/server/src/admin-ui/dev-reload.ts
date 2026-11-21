// The one DEV-only reload path. The process answers an event stream with its own instance id. The page keeps that stream open;
// when the process restarts the browser reconnects by itself, receives a different id and reloads once. The restart itself is
// triggered by the one source watcher below, which polls file times because the sources live on a network share, where inotify
// (and so `node --watch`) never sees a change made from another machine. systemd (Restart=always in the DEV unit) starts the process again.
// It exists only when the runtime switch --dev-live-reload is given, so a production process has neither the route, the script nor the watcher.
import { readdirSync, watchFile } from "node:fs";
import type { ServerResponse } from "node:http";
import path from "node:path";

export const DEV_RELOAD_PATH = "/admin/api/dev-reload";

export const DEV_RELOAD_SCRIPT = `
(() => {
  let seen = null;
  new EventSource("${DEV_RELOAD_PATH}").onmessage = (e) => { if (seen === null) seen = e.data; else if (seen !== e.data) location.reload(); };
})();
`;

export function createDevReload(): (res: ServerResponse) => void {
  const instance = `${process.pid}-${process.hrtime.bigint()}`; // differs for every process start, which is all the page compares
  return (res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    res.write(`data: ${instance}\n\n`);
  };
}

/** Calls onChange once when any source file under the given directories changes (polled every second, DEV only). */
export function watchSources(dirs: readonly string[], onChange: () => void): void {
  let fired = false;
  for (const dir of dirs) {
    for (const file of readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts") || f.endsWith(".png"))) {
      watchFile(path.join(dir, file), { interval: 1000, persistent: false }, (now, before) => {
        if (fired || now.mtimeMs === before.mtimeMs) return;
        fired = true;
        onChange();
      });
    }
  }
}
