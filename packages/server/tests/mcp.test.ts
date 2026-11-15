import { test } from "node:test";
import assert from "node:assert/strict";
import { hashCredential } from "../src/index.ts";
import { PHYSICAL_ROOT, requestsOf, startRuntime, until, CLIENT_MARKER, MCP_MARKER } from "./runtime-fixture.ts";

const OPS = ["fs_list", "fs_find", "fs_read", "fs_search", "fs_read_image", "fs_read_pdf", "fs_write", "fs_edit", "fs_remove", "git_status", "git_diff", "git_log", "git_show"];
const initialize = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } };

type Tool = { name: string; annotations?: Record<string, unknown>; inputSchema: { properties: Record<string, unknown>; required?: string[] } };
const listTools = async (rt: Awaited<ReturnType<typeof startRuntime>>): Promise<Tool[]> => (await rt.rpc("tools/list", {})).body.result.tools;
const call = (rt: Awaited<ReturnType<typeof startRuntime>>, name: string, args: object, id = 1) => rt.rpc("tools/call", { name, arguments: args }, MCP_MARKER, id);
const answer = (client: { ws: import("ws").WebSocket }, request: { request_id?: string }, result: object) => client.ws.send(JSON.stringify({ kind: "response", request_id: request.request_id, ok: true, result }));

test("the SDK answers initialize with the injected build as its version", async () => {
  const rt = await startRuntime();
  const r = await rt.rpc("initialize", initialize);
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.result.serverInfo.name, r.body.result.serverInfo.version], ["reach", "srv-1"]);
  await rt.close();
});

test("tools/list is exactly discovery plus the 13 shared operations; no shell, Git mutation or admin tool", async () => {
  const rt = await startRuntime();
  const tools = await listTools(rt);
  assert.deepEqual(tools.map((t) => t.name).sort(), ["reach_discover", ...OPS].sort());
  assert.ok(!tools.some((t) => /shell|exec|commit|push|admin|setup/i.test(t.name)));
  for (const tool of tools.filter((t) => t.name !== "reach_discover")) {
    assert.ok("client_id" in tool.inputSchema.properties && "project_id" in tool.inputSchema.properties, `${tool.name} is qualified`);
    assert.ok(tool.inputSchema.required?.includes("client_id") && tool.inputSchema.required.includes("project_id"));
    assert.ok(!("op" in tool.inputSchema.properties), "the op is the tool name, not an argument");
  }
  await rt.close();
});

test("annotations are truthful: reads are read-only, writes are not, only removal is destructive", async () => {
  const rt = await startRuntime();
  const byName = Object.fromEntries((await listTools(rt)).map((t) => [t.name, t.annotations]));
  const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  for (const name of ["reach_discover", "fs_list", "fs_find", "fs_read", "fs_search", "fs_read_image", "fs_read_pdf", "git_status", "git_diff", "git_log", "git_show"]) {
    assert.deepEqual({ ...byName[name], title: undefined }, { ...read, title: undefined }, name);
  }
  assert.deepEqual(byName.fs_write, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
  assert.deepEqual(byName.fs_edit, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
  assert.deepEqual(byName.fs_remove, { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false });
  await rt.close();
});

test("discovery shows logical clients, projects, modes and online state, and nothing private", async () => {
  const rt = await startRuntime();
  const client = await rt.connectClient();
  await until(() => client.frames.length === 2, "admitted");
  const r = await call(rt, "reach_discover", {});
  const { clients } = r.body.result.structuredContent;
  assert.deepEqual(clients.map((c: { client_id: string; online: boolean }) => [c.client_id, c.online]), [["laptop", true], ["idle", false]]);
  assert.deepEqual(clients[0].projects, [{ project_id: "web", mode: "read_write" }, { project_id: "api", mode: "read_only" }]);
  assert.equal(clients[0].display_name, "Work laptop");
  const text = r.text;
  for (const secret of [PHYSICAL_ROOT, "/srv/", hashCredential(MCP_MARKER), hashCredential(CLIENT_MARKER), MCP_MARKER, CLIENT_MARKER, "physical_root", "credential", "config.json"]) assert.ok(!text.includes(secret), `leaked ${secret}`);
  await rt.close();
});

test("each operation tool routes the exact shared Operation to the addressed Client and project", async () => {
  const rt = await startRuntime();
  const client = await rt.connectClient();
  await until(() => client.frames.length === 2, "admitted");
  const pending = call(rt, "fs_read", { client_id: "laptop", project_id: "web", path: "src/a.ts", start_line: 2 });
  await until(() => requestsOf(client).length === 1, "request reached the Client");
  const request = requestsOf(client)[0]!;
  assert.deepEqual(request.operation, { op: "fs_read", path: "src/a.ts", start_line: 2 });
  assert.equal((request as { project_id?: string }).project_id, "web");
  answer(client, request, { op: "fs_read", path: "src/a.ts", start_line: 2, end_line: 2, total_lines: 9, truncated: false, next_start_line: 3, redactions: 0, content: "2: x" });
  const r = (await pending).body.result;
  assert.equal(r.isError, undefined);
  assert.equal(r.structuredContent.op, "fs_read");
  assert.equal(r._meta.request_id, request.request_id, "the id the Client saw on the wire");
  assert.equal(JSON.parse(r.content[0].text).request_id, request.request_id);
  assert.equal(r.structuredContent.content, "2: x");
  await rt.close();
});

test("failures are compact tool errors: unknown project, offline Client, bad arguments never reach a socket", async () => {
  const rt = await startRuntime();
  const client = await rt.connectClient();
  await until(() => client.frames.length === 2, "admitted");
  const cases: [string, object][] = [
    ["fs_list", { client_id: "laptop", project_id: "nope" }],
    ["fs_list", { client_id: "idle", project_id: "p" }],
    ["fs_list", { client_id: "ghost", project_id: "p" }],
    ["fs_read", { client_id: "laptop", project_id: "web" }],
    ["fs_list", { client_id: "laptop", project_id: "web", unknown: 1 }],
  ];
  for (const [name, args] of cases) {
    const r = (await call(rt, name, args)).body;
    const failed = r.error !== undefined || r.result?.isError === true;
    assert.ok(failed, `${name} ${JSON.stringify(args)}`);
    assert.ok(!JSON.stringify(r).includes(PHYSICAL_ROOT) && !/stack|\.ts:\d/.test(JSON.stringify(r)));
  }
  assert.equal(requestsOf(client).length, 0, "nothing was sent to the Client");
  await rt.close();
});

test("concurrent calls are independent: out-of-order answers reach the right caller", async () => {
  const rt = await startRuntime();
  const client = await rt.connectClient();
  await until(() => client.frames.length === 2, "admitted");
  const a = call(rt, "fs_list", { client_id: "laptop", project_id: "web", path: "a" }, 11);
  const b = call(rt, "fs_list", { client_id: "laptop", project_id: "api", path: "b" }, 12);
  await until(() => requestsOf(client).length === 2, "both sent");
  const [first, second] = requestsOf(client);
  const forPath = (p: string) => requestsOf(client).find((r) => r.operation?.path === p)!;
  assert.ok(first && second);
  answer(client, forPath("b"), { op: "fs_list", path: "b", entries: [], truncated: false });
  answer(client, forPath("a"), { op: "fs_list", path: "a", entries: [], truncated: false });
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.body.result.structuredContent.path, "a");
  assert.equal(rb.body.result.structuredContent.path, "b");
  assert.equal(ra.body.result._meta.request_id, forPath("a").request_id);
  assert.equal(rb.body.result._meta.request_id, forPath("b").request_id);
  assert.notEqual(ra.body.result._meta.request_id, rb.body.result._meta.request_id);
  await rt.close();
});

test("a mutation tool that times out on the Client is reported as indeterminate, once", async () => {
  const rt = await startRuntime();
  const client = await rt.connectClient();
  await until(() => client.frames.length === 2, "admitted");
  const pending = call(rt, "fs_remove", { client_id: "laptop", project_id: "web", path: "a.txt" });
  await until(() => requestsOf(client).length === 1, "sent");
  client.ws.terminate();
  const r = (await pending).body.result;
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /MUTATION_INDETERMINATE/);
  assert.equal(r._meta.request_id, requestsOf(client)[0]!.request_id, "a failure carries the id that was sent");
  assert.match(r.content[0].text, new RegExp(`request_id ${requestsOf(client)[0]!.request_id}`));
  await rt.close();
});

test("the MCP layer only adapts: no filesystem, Git, routing state or copied argument schemas", async () => {
  const { readFileSync } = await import("node:fs");
  const path = await import("node:path");
  const src = readFileSync(path.join(import.meta.dirname, "..", "src", "mcp.ts"), "utf8");
  assert.ok(!/node:fs|node:child_process|new Map\(|new Set\(|pending|sessions/.test(src.replace("new Map(connections.status()", "")));
  assert.ok(!/z\.(string|number|boolean|array|enum|int)\(/.test(src), "argument types come from the shared Operation schemas");
});
