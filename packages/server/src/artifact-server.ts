// The Server's artifact plane: a third, separate HTTP listener that only transports the release manifest and the Client
// artifacts. It is GET-only, authenticates first through the auth owner (so a refusal never reveals whether an artifact exists),
// then looks up by name only through the injected ArtifactSource, which stays the sole catalog and path-safety owner.
// It serves nothing else: no admin, configuration, credential, proposal or MCP route lives here.
import { createServer, type Server, type ServerResponse } from "node:http";
import { pipeline } from "node:stream";
import type { ArtifactSource } from "./artifacts.ts";
import { authenticateBearer } from "./auth.ts";
import { NO_AUDIT, type Audit } from "./audit.ts";
import type { ServerConfigStore } from "./config.ts";

const MANIFEST_ROUTE = "/release/manifest";
const ARTIFACT_ROUTE = /^\/release\/artifacts\/([^/]+)$/;
const HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff" };

export type ArtifactServerDeps = { config: ServerConfigStore; artifacts?: ArtifactSource; audit?: Audit };

const status = (res: ServerResponse, code: number, headers: Record<string, string> = {}): void => void res.writeHead(code, headers).end();

export function createArtifactServer(deps: ArtifactServerDeps): Server {
  const audit = deps.audit ?? NO_AUDIT;
  // joinDuplicateHeaders: repeated Authorization lines are joined and then refused by the auth owner's exact parser, as on the data plane.
  return createServer({ joinDuplicateHeaders: true }, (req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    const artifactName = ARTIFACT_ROUTE.exec(pathname);
    if (pathname !== MANIFEST_ROUTE && !artifactName) return status(res, 404);
    const auth = authenticateBearer(deps.config, req.headers);
    if (auth !== 200) return status(res, auth, auth === 401 ? { "WWW-Authenticate": "Bearer" } : {});
    if (req.method !== "GET") return status(res, 405);
    if (!artifactName) {
      const manifest = deps.artifacts?.manifest() ?? null;
      if (manifest === null) return status(res, 404);
      return void res.writeHead(200, { ...HEADERS, "content-type": "application/json", "content-length": manifest.length }).end(manifest);
    }
    let name: string;
    try {
      name = decodeURIComponent(artifactName[1] as string);
    } catch {
      name = ""; // malformed percent-encoding is just a name no source declares
    }
    const artifact = deps.artifacts?.artifact(name) ?? null;
    if (artifact === null) return status(res, 404);
    audit.record({ actor: "client", action: "artifact_download", target: name, result: "ok" });
    res.writeHead(200, { ...HEADERS, "content-type": "application/octet-stream", "content-length": artifact.size, "content-disposition": `attachment; filename="${name}"` });
    pipeline(artifact.stream(), res, () => undefined);
  });
}
