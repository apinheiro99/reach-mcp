// The public, read-only release routes served by the service listener (8787): the canonical manifest, the same manifest in a Server-signed
// envelope, the Server public trust key (for the installer's trust-on-first-use pin), and the Client artifacts.
// Installing a Client needs network reachability only; Client authentication begins when the installed Client connects. Nothing
// here touches the filesystem: it serves only what the injected ArtifactSource (artifacts.ts) declares, looked up by name only.
import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline, type Readable } from "node:stream";
import type { ArtifactSource } from "./artifacts.ts";
import { NO_AUDIT, type Audit } from "./audit.ts";
import type { ServerTrustStore } from "./server-trust.ts";

export const RELEASE_MANIFEST_ROUTE = "/release/manifest";
/** The manifest bytes inside the signed envelope {release_epoch, manifest, signature}; the manifest route above keeps serving the exact bytes for installers and pre-change Clients. */
export const RELEASE_ENVELOPE_ROUTE = "/release/envelope";
/** The Server public trust key, `{ "public_key": "<base64url>" }`: what the installer pins on first use. */
export const RELEASE_TRUST_KEY_ROUTE = "/release/trust-key";
const RELEASE_ARTIFACT_ROUTE = /^\/release\/artifacts\/([^/]+)$/;

export const isReleasePath = (pathname: string): boolean => [RELEASE_MANIFEST_ROUTE, RELEASE_ENVELOPE_ROUTE, RELEASE_TRUST_KEY_ROUTE].includes(pathname) || pathname.startsWith("/release/artifacts/");

const SAFE_HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff" };

/** The one way an artifact leaves the Server: audited, never cached, exactly `size` bytes. Callers choose only the type headers. */
export function sendArtifact(res: ServerResponse, artifact: { size: number; stream(): Readable }, name: string, audit: Audit, typeHeaders: Record<string, string>): void {
  audit.record({ actor: "admin", action: "artifact_download", target: name, result: "ok" });
  res.writeHead(200, { ...SAFE_HEADERS, ...typeHeaders, "content-length": artifact.size });
  pipeline(artifact.stream(), res, () => undefined);
}

/** The signed envelope of the manifest the source holds, or null when there is no manifest or no trust key. */
function envelopeOf(deps: { artifacts?: ArtifactSource; trust?: ServerTrustStore }) {
  const manifest = deps.artifacts?.manifest() ?? null;
  return manifest === null || !deps.trust ? null : deps.trust.envelope(manifest);
}

export function createReleaseHandler(deps: { artifacts?: ArtifactSource; audit?: Audit; trust?: ServerTrustStore }): (req: IncomingMessage, res: ServerResponse) => void {
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
    if (pathname === RELEASE_ENVELOPE_ROUTE || pathname === RELEASE_TRUST_KEY_ROUTE) {
      const body = pathname === RELEASE_TRUST_KEY_ROUTE ? (deps.trust ? { public_key: deps.trust.publicKey() } : null) : envelopeOf(deps);
      if (body === null) return status(res, 404);
      const json = Buffer.from(JSON.stringify(body));
      return void res.writeHead(200, { ...SAFE_HEADERS, "content-type": "application/json", "content-length": json.length }).end(json);
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
