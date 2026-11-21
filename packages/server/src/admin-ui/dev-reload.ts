// The one DEV-only reload path. The process answers an event stream with its own instance id. The page keeps that stream open;
// when the process is restarted by `node --watch` the browser reconnects by itself, receives a different id and reloads once.
// It exists only when the runtime switch --dev-live-reload is given, so a production process has neither the route nor the script.
import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";

export const DEV_RELOAD_PATH = "/admin/api/dev-reload";

export const DEV_RELOAD_SCRIPT = `
(() => {
  let seen = null;
  new EventSource("${DEV_RELOAD_PATH}").onmessage = (e) => { if (seen === null) seen = e.data; else if (seen !== e.data) location.reload(); };
})();
`;

export function createDevReload(): (res: ServerResponse) => void {
  const instance = randomUUID();
  return (res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    res.write(`data: ${instance}\n\n`);
  };
}
