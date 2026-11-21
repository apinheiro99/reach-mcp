// The public, read-only release routes served by the service listener (8787): the canonical manifest and the Client artifacts.
// Installing a Client needs network reachability only; Client authentication begins when the installed Client connects. Nothing
// here touches the filesystem: it serves only what the injected ArtifactSource (artifacts.ts) declares, looked up by name only.
import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline, type Readable } from "node:stream";
import type { ArtifactSource } from "./artifacts.ts";
import { NO_AUDIT, type Audit } from "./audit.ts";

export const RELEASE_MANIFEST_ROUTE = "/release/manifest";
const RELEASE_ARTIFACT_ROUTE = /^\/release\/artifacts\/([^/]+)$/;

export const isReleasePath = (pathname: string): boolean => pathname === RELEASE_MANIFEST_ROUTE || pathname.startsWith("/release/artifacts/");

const SAFE_HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff" };

/** The one way an artifact leaves the Server: audited, never cached, exactly `size` bytes. Callers choose only the type headers. */
export function sendArtifact(res: ServerResponse, artifact: { size: number; stream(): Readable }, name: string, audit: Audit, typeHeaders: Record<string, string>): void {
  audit.record({ actor: "admin", action: "artifact_download", target: name, result: "ok" });
  res.writeHead(200, { ...SAFE_HEADERS, ...typeHeaders, "content-length": artifact.size });
  pipeline(artifact.stream(), res, () => undefined);
}

export function createReleaseHandler(deps: { artifacts?: ArtifactSource; audit?: Audit }): (req: IncomingMessage, res: ServerResponse) => void {
  const audit = deps.audit ?? NO_AUDIT;
  const status = (res: ServerResponse, code: number): void => void res.writeHead(code).end();
  return (req, res) => {
    if (req.method !== "GET") return status(res, 405);
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname === RELEASE_MANIFEST_ROUTE) {
      const manifest = deps.artifacts?.manifest() ?? null;
      if (manifest === null) return status(res, 404);
      return void res.writeHead(200, { ...SAFE_HEADERS, "content-type": "application/json", "content-length": manifest.length }).end(manifest);
    }
    const match = RELEASE_ARTIFACT_ROUTE.exec(pathname);
    if (!match) return status(res, 404);
    let name: string;
    try {
      name = decodeURIComponent(match[1] as string);
    } catch {
      name = ""; // malformed percent-encoding is just a name no source declares
    }
    const artifact = deps.artifacts?.artifact(name) ?? null;
    if (artifact === null) return status(res, 404);
    sendArtifact(res, artifact, name, audit, { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="${name}"` });
  };
}
