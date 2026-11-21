// The canonical list of the routes this Server actually implements, with the live status each owner can truthfully report. It is the only
// catalog: the API screen reads it and nothing routes through it. A route that does not exist in http-server.ts / release.ts is not listed.
export type EndpointStatus = "healthy" | "not_configured" | "unavailable";
export type Endpoint = { method: "GET" | "POST" | "WS"; path: string; purpose: string; status: EndpointStatus };
export type EndpointFacts = { configActive: boolean; artifactsConfigured: boolean };

/** Status comes from the owners' own facts (active configuration, configured artifacts), never from calling the route. */
export function endpointCatalog({ configActive, artifactsConfigured }: EndpointFacts): Endpoint[] {
  const needsConfig: EndpointStatus = configActive ? "healthy" : "unavailable";
  const release: EndpointStatus = artifactsConfigured ? "healthy" : "not_configured";
  return [
    { method: "GET", path: "/health", purpose: "Service health and readiness (build, uptime, clients, request counters). Bearer protected.", status: needsConfig },
    { method: "POST", path: "/mcp", purpose: "Stateless Streamable HTTP MCP endpoint for ChatGPT. Bearer protected.", status: needsConfig },
    { method: "GET", path: "/release/manifest", purpose: "The release manifest: build, artifacts and checksums.", status: release },
    { method: "GET", path: "/release/artifacts/:name", purpose: "Download one release artifact by name.", status: release },
    { method: "WS", path: "/client", purpose: "WebSocket for Client sessions: challenge, policy sync, requests and key rotation.", status: needsConfig },
  ];
}
