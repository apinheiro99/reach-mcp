// The public install-discovery routes of the service listener (8787): a minimal root page with the canonical Client install commands and the two
// fixed installer downloads. The installer bytes belong to the injected ArtifactSource (artifacts.ts) and are looked up by these two exact names only;
// nothing here reads the filesystem. A command is advertised only while its installer is actually available, and no installer logic lives here.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ArtifactSource } from "./artifacts.ts";
import { NO_AUDIT, type Audit } from "./audit.ts";
import { sendArtifact } from "./release.ts";

export const INSTALLER_NAMES = { sh: "install.sh", ps1: "install.ps1" } as const;
const ROOT = "/";
const INSTALLER_ROUTES: Record<string, { name: string; type: string }> = {
  "/install.sh": { name: INSTALLER_NAMES.sh, type: "text/x-shellscript; charset=utf-8" },
  "/install.ps1": { name: INSTALLER_NAMES.ps1, type: "text/plain; charset=utf-8" },
};
// A Host value that is safe to print: a host name, IPv4 address or bracketed IPv6 address, with an optional port. Anything else is not rendered.
const SAFE_AUTHORITY = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|\[[0-9A-Fa-f:.]{2,45}\])(?::[0-9]{1,5})?$/;
const PLACEHOLDER = "<server-address>";

export const isInstallPath = (pathname: string): boolean => pathname === ROOT || pathname in INSTALLER_ROUTES;

/** Which installers the source can serve right now: the owner's own fact, used by the routes, the page and the endpoint catalog alike. */
export const installerFacts = (artifacts?: ArtifactSource): { sh: boolean; ps1: boolean } => ({
  sh: artifacts?.artifact(INSTALLER_NAMES.sh) != null,
  ps1: artifacts?.artifact(INSTALLER_NAMES.ps1) != null,
});

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function createInstallHandler(deps: { artifacts?: ArtifactSource; audit?: Audit }): (req: IncomingMessage, res: ServerResponse) => void {
  const audit = deps.audit ?? NO_AUDIT;
  return (req, res) => {
    if (req.method !== "GET") return void res.writeHead(405).end();
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    const route = INSTALLER_ROUTES[pathname];
    if (route !== undefined) {
      const artifact = deps.artifacts?.artifact(route.name) ?? null;
      if (artifact === null) return void res.writeHead(404).end();
      return sendArtifact(res, artifact, route.name, audit, { "content-type": route.type });
    }
    // Only the Host header names this Server, never a forwarded one, and only when it is safe to print.
    const host = req.headers.host;
    const authority = host !== undefined && SAFE_AUTHORITY.test(host) ? host : PLACEHOLDER;
    const available = installerFacts(deps.artifacts);
    const commands = [
      ...(available.sh ? [["Linux", `curl -fsSL http://${authority}/install.sh | sudo sh -s -- --server-origin http://${authority}`]] : []),
      ...(available.ps1 ? [["Windows (PowerShell)", `irm http://${authority}/install.ps1 | iex`]] : []),
    ];
    const body = `<!doctype html>\n<meta charset="utf-8">\n<title>Install the REACH Client</title>\n<h1>Install the REACH Client</h1>\n${
      commands.length === 0 ? "<p>No installer is available on this Server yet.</p>\n" : commands.map(([label, command]) => `<h2>${label}</h2>\n<pre>${escapeHtml(command as string)}</pre>\n`).join("")
    }`;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(body), "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'" }).end(body);
  };
}
