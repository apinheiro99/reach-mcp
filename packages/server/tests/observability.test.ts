import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { AuditWriter, createAdminHandler, OperationalLogger, ProposalStore, RotatingTextWriter, type ConnectionOptions } from "../src/index.ts";
import { CLIENT_MARKER, MCP_MARKER, PHYSICAL_ROOT, requestsOf, startRuntime, until } from "./runtime-fixture.ts";

const FILE_CONTENT = "FILE-CONTENT-" + "Hq58Lw";
const NEW_BEARER = "attacker-bearer-" + "Tz31Rc88";

/** Real writers over a temporary directory, with their files read back as text. */
function writers() {
  const dir = mkdtempSync(path.join(tmpdir(), "reach-obs-"));
  const settings = () => ({ max_bytes: 1_000_000, retention_days: 5 });
  const logger = new OperationalLogger(new RotatingTextWriter({ dir, base: "reach", settings }));
  const audit = new AuditWriter(new RotatingTextWriter({ dir, base: "audit", settings }));
  const lines = (base: string) => {
    try {
      return readFileSync(path.join(dir, `${base}.log`), "utf8").split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };
  const everything = () => readdirSync(dir).map((f) => readFileSync(path.join(dir, f), "utf8")).join("\n");
  return { dir, logger, audit, log: () => lines("reach"), trail: () => lines("audit"), everything };
}

const answerOk = (client: { ws: import("ws").WebSocket }, request: { request_id?: string }, result: object) => client.ws.send(JSON.stringify({ kind: "response", request_id: request.request_id, ok: true, result }));

test("connection log lines carry ids and codes, never a credential; a refusal is logged by code only", async () => {
  const w = writers();
  const rt = await startRuntime({ logger: w.logger, audit: w.audit } as Partial<ConnectionOptions>);
  const client = await rt.connectClient();
  await until(() => client.frames.length === 2, "admitted");
  const refused = await rt.connectClient("/client", "nobody");
  await until(() => refused.frames.length > 0, "refused");
  client.ws.close();
  await until(() => w.log().some((l) => l.includes("client disconnected")), "disconnect logged");
  const text = w.log().join("\n");
  assert.match(text, /INFO connections client connected client_id=laptop/);
  assert.match(text, /WARNING connections client refused code=AUTH_FAILED/);
  assert.match(text, /INFO connections client disconnected client_id=laptop/);
  for (const secret of [CLIENT_MARKER, MCP_MARKER]) assert.ok(!w.everything().includes(secret), "no credential in any file");
  await rt.close();
});

test("a routed request is logged with its exact request_id and no payload; reads are not audited", async () => {
  const w = writers();
  const rt = await startRuntime({ logger: w.logger, audit: w.audit } as Partial<ConnectionOptions>);
  const client = await rt.connectClient();
  await until(() => client.frames.length === 2, "admitted");
  const pending = rt.connections.route("laptop", "web", { op: "fs_read", path: "secret.txt" }, { requestId: "req-read-1" });
  await until(() => requestsOf(client).length === 1, "request");
  answerOk(client, requestsOf(client)[0] as { request_id?: string }, { op: "fs_read", path: "secret.txt", start_line: 1, end_line: 1, total_lines: 1, truncated: false, next_start_line: null, redactions: 0, content: `1: ${FILE_CONTENT}` });
  assert.equal((await pending).ok, true);
  assert.deepEqual(w.log().filter((l) => l.includes("request completed")).map((l) => l.replace(/^\S+ /, "")), ["INFO connections request_id=req-read-1 request completed op=fs_read client_id=laptop project_id=web"]);
  assert.deepEqual(w.trail(), [], "a read creates no audit record");
  assert.ok(!w.everything().includes(FILE_CONTENT) && !w.everything().includes("secret.txt"), "no file content or path in the log");
  await rt.close();
});

test("each mutation is audited exactly once at its terminal outcome, with its request_id and no content", async () => {
  const w = writers();
  const rt = await startRuntime({ logger: w.logger, audit: w.audit, requestTimeoutMs: 80 } as Partial<ConnectionOptions>);
  const client = await rt.connectClient();
  await until(() => client.frames.length === 2, "admitted");
  const write = rt.connections.route("laptop", "web", { op: "fs_write", path: "a.txt", content: FILE_CONTENT }, { requestId: "req-w" });
  await until(() => requestsOf(client).length === 1, "write request");
  answerOk(client, requestsOf(client)[0] as { request_id?: string }, { op: "fs_write", path: "a.txt", bytes: 9 });
  await write;
  const edit = rt.connections.route("laptop", "web", { op: "fs_edit", path: "b.txt", old_text: "x", new_text: FILE_CONTENT }, { requestId: "req-e" });
  await until(() => requestsOf(client).length === 2, "edit request");
  client.ws.send(JSON.stringify({ kind: "response", request_id: "req-e", ok: false, error: { code: "NOT_FOUND", message: "no such file" } }));
  await edit;
  await rt.connections.route("laptop", "web", { op: "fs_remove", path: "c.txt" }, { requestId: "req-r" }); // never answered: times out
  const trail = w.trail().map((l) => l.replace(/^\S+\t/, ""));
  assert.deepEqual(trail, [
    "actor=chatgpt\taction=fs_write\tclient_id=laptop\tproject_id=web\ttarget=a.txt\trequest_id=req-w\tresult=ok",
    "actor=chatgpt\taction=fs_edit\tclient_id=laptop\tproject_id=web\ttarget=b.txt\trequest_id=req-e\tresult=NOT_FOUND",
    "actor=chatgpt\taction=fs_remove\tclient_id=laptop\tproject_id=web\ttarget=c.txt\trequest_id=req-r\tresult=timed_out",
  ]);
  assert.ok(w.log().some((l) => l.includes("ERROR connections request_id=req-r request timed out")));
  assert.ok(!w.everything().includes(FILE_CONTENT), "no file content anywhere");
  await rt.close();
});

test("admin and proposal actions are each audited once, without secret values", async () => {
  const w = writers();
  const rt = await startRuntime({ logger: w.logger, audit: w.audit } as Partial<ConnectionOptions>);
  const proposals = new ProposalStore({ path: path.join(w.dir, "proposal.json"), config: rt.config, connections: rt.connections, logger: w.logger, audit: w.audit });
  const admin = createServer(createAdminHandler({ config: rt.config, connections: rt.connections, proposals, serverBuild: "srv-1", logger: w.logger, audit: w.audit }));
  await new Promise<void>((r) => admin.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(admin.address() as AddressInfo).port}`;
  const put = (body: unknown) => fetch(`${base}/admin/api/config`, { method: "PUT", body: JSON.stringify(body) });
  const clients = () => rt.config.editableView().clients.map((c) => ({ client_id: c.client_id, display_name: c.display_name, enabled: c.enabled, projects: c.projects }));
  assert.equal((await put({ mcp_bearer: NEW_BEARER, clients: clients() })).status, 200);
  assert.equal((await put({ clients: [{ client_id: "x", enabled: true, projects: [] }] })).status, 422);
  const issued = await fetch(`${base}/admin/api/clients/idle/credential`, { method: "POST" });
  const credential = ((await issued.json()) as { result: { credential: string } }).result.credential;
  const id1 = (proposals.propose({ clients: clients().map((c) => ({ ...c, display_name: "ai" })) }) as { proposal_id: string }).proposal_id;
  assert.equal((await fetch(`${base}/admin/api/proposal/${id1}/approve`, { method: "POST" })).status, 200);
  const id2 = (proposals.propose({ clients: clients().map((c) => ({ ...c, display_name: "ai2" })) }) as { proposal_id: string }).proposal_id;
  await put({ clients: clients().map((c) => ({ ...c, display_name: "human" })) });
  assert.equal((await fetch(`${base}/admin/api/proposal/${id2}/approve`, { method: "POST" })).status, 409);
  assert.equal((await fetch(`${base}/admin/api/proposal/${id2}/reject`, { method: "POST" })).status, 200);
  const trail = w.trail().map((l) => l.replace(/^\S+\t/, ""));
  assert.deepEqual(trail, [
    "actor=admin\taction=config_edit\tresult=ok",
    "actor=admin\taction=config_edit\tresult=refused",
    "actor=admin\taction=credential_issue\ttarget=idle\tresult=ok",
    `actor=ai\taction=proposal_create\ttarget=${id1}\tresult=pending`,
    `actor=human\taction=proposal_approve\ttarget=${id1}\tresult=approved`,
    `actor=ai\taction=proposal_create\ttarget=${id2}\tresult=pending`,
    "actor=admin\taction=config_edit\tresult=ok",
    `actor=human\taction=proposal_approve\ttarget=${id2}\tresult=stale`,
    `actor=human\taction=proposal_reject\ttarget=${id2}\tresult=rejected`,
  ]);
  const files = readdirSync(w.dir).filter((f) => f.endsWith(".log")).map((f) => readFileSync(path.join(w.dir, f), "utf8")).join("\n");
  for (const secret of [credential, NEW_BEARER, CLIENT_MARKER, MCP_MARKER, PHYSICAL_ROOT, "sha256"]) assert.ok(!files.includes(secret), `a log or audit file leaked ${secret}`);
  admin.closeAllConnections();
  await new Promise<void>((r) => admin.close(() => r()));
  await rt.close();
});
