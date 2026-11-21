import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashCredential, ProposalStore } from "../src/index.ts";
import { CLIENT_MARKER, MCP_MARKER, startRuntime } from "./runtime-fixture.ts";
import { LAPTOP } from "./identity-fixture.ts";

type Rt = Awaited<ReturnType<typeof startRuntime>>;
const proposalFile = (rt: Rt) => path.join(path.dirname(rt.file), "proposal.json");

/** A view Client without its read-only enrollment flag, as an edit may carry it. */
const plain = (c: ReturnType<Rt["config"]["editableView"]>["clients"][number]) => ({ client_id: c.client_id, display_name: c.display_name, enabled: c.enabled, projects: c.projects });

/** The current editable Clients, with one project's mode changed: a small, valid AI edit. */
const edit = (rt: Rt, mode: "read_only" | "read_write" = "read_write") => ({
  clients: rt.config.editableView().clients.map(plain).map((c) => ({ ...c, projects: c.projects.map((p) => (p.project_id === "api" ? { ...p, mode } : p)) })),
});

function spySync(rt: Rt) {
  const counter = { n: 0 };
  const real = rt.connections.syncAllPolicies.bind(rt.connections);
  rt.connections.syncAllPolicies = () => (counter.n++, real());
  return counter;
}

test("propose: stores only a redacted base and a secret-free edit, and changes nothing live", async () => {
  const rt = await startRuntime();
  const sync = spySync(rt);
  const before = readFileSync(rt.file, "utf8");
  const result = rt.proposals.propose(edit(rt));
  assert.equal(result.status, "pending");
  const stored = readFileSync(proposalFile(rt), "utf8");
  assert.deepEqual(Object.keys(JSON.parse(stored)).sort(), ["base", "created_at", "edit", "proposal_id"]);
  for (const secret of [hashCredential(MCP_MARKER), hashCredential(CLIENT_MARKER), MCP_MARKER, CLIENT_MARKER, "sha256", "mcp_bearer"]) assert.ok(!stored.includes(secret), `proposal file leaked ${secret}`);
  assert.equal(readFileSync(rt.file, "utf8"), before, "the config file is untouched");
  assert.equal(rt.config.editableView().clients[0]?.projects[1]?.mode, "read_only", "the active snapshot is untouched");
  assert.equal(sync.n, 0, "no policy sync on a proposal");
  assert.deepEqual(rt.proposals.pending()?.diff, [{ path: "clients[laptop].projects[api].mode", before: '"read_only"', after: '"read_write"' }]);
  await rt.close();
});

test("propose: secret fields, invalid edits and a second proposal create nothing", async () => {
  const rt = await startRuntime();
  const good = edit(rt);
  for (const bad of [{ ...good, mcp_bearer: "attacker-bearer-0123456789" }, { clients: good.clients.map((c) => ({ ...c, public_key: "a".repeat(43) })) }, { clients: [{ client_id: "x", enabled: true, projects: [] }] }, { clients: "no" }]) {
    assert.equal(rt.proposals.propose(bad).status, "invalid");
  }
  assert.equal(rt.proposals.pending(), null);
  const first = rt.proposals.propose(good);
  assert.equal(first.status, "pending");
  assert.deepEqual(rt.proposals.propose(edit(rt, "read_only")), { status: "already_pending", proposal_id: (first as { proposal_id: string }).proposal_id });
  await rt.close();
});

test("approve: activates through the config owner, syncs policies exactly once, and removes the proposal", async () => {
  const rt = await startRuntime();
  const id = (rt.proposals.propose(edit(rt)) as { proposal_id: string }).proposal_id;
  const sync = spySync(rt);
  assert.deepEqual(rt.proposals.approve(id), { status: "approved" });
  assert.equal(sync.n, 1);
  assert.equal(rt.config.editableView().clients[0]?.projects[1]?.mode, "read_write");
  assert.equal(rt.config.publicKeyFor("laptop"), LAPTOP.publicKey, "public keys survive an approved edit");
  assert.equal(rt.proposals.pending(), null);
  assert.equal(rt.proposals.approve(id).status, "not_found");
  await rt.close();
});

test("approve: a proposal made stale by a human edit is refused, stays pending and changes nothing", async () => {
  const rt = await startRuntime();
  const id = (rt.proposals.propose(edit(rt)) as { proposal_id: string }).proposal_id;
  const human = rt.config.editableView().clients.map(plain).map((c) => ({ ...c, display_name: "edited by a human" }));
  rt.config.applyEdit({ clients: human });
  const sync = spySync(rt);
  assert.deepEqual(rt.proposals.approve(id), { status: "stale" });
  assert.equal(sync.n, 0);
  assert.equal(rt.config.editableView().clients[0]?.projects[1]?.mode, "read_only");
  assert.equal(rt.config.editableView().clients[0]?.display_name, "edited by a human");
  assert.equal(rt.proposals.pending()?.proposal_id, id, "left for a human to reject");
  await rt.close();
});

test("reject: only the proposal goes away; no config change and no sync", async () => {
  const rt = await startRuntime();
  const id = (rt.proposals.propose(edit(rt)) as { proposal_id: string }).proposal_id;
  const before = readFileSync(rt.file, "utf8");
  const sync = spySync(rt);
  assert.deepEqual(rt.proposals.reject(id), { status: "rejected" });
  assert.equal(rt.proposals.pending(), null);
  assert.equal(readFileSync(rt.file, "utf8"), before);
  assert.equal(sync.n, 0);
  assert.equal(rt.proposals.reject(id).status, "not_found");
  await rt.close();
});

test("approve: an activation failure keeps the proposal pending, the old config active and sends no sync", async () => {
  const rt = await startRuntime();
  const apart = new ProposalStore({ path: path.join(mkdtempSync(path.join(tmpdir(), "reach-prop-")), "proposal.json"), config: rt.config, connections: rt.connections });
  const id = (apart.propose(edit(rt)) as { proposal_id: string }).proposal_id;
  const dir = path.dirname(rt.file);
  rmSync(dir, { recursive: true });
  writeFileSync(dir, "a file where the directory was"); // the config can no longer be written
  const sync = spySync(rt);
  const result = apart.approve(id);
  assert.equal(result.status, "invalid");
  assert.equal(sync.n, 0);
  assert.equal(rt.config.editableView().clients[0]?.projects[1]?.mode, "read_only", "the old snapshot stays active");
  assert.equal(apart.pending()?.proposal_id, id, "still pending");
  await rt.close();
});

test("a pending proposal survives a restart; a malformed file is no proposal and cannot mutate config", async () => {
  const rt = await startRuntime();
  const id = (rt.proposals.propose(edit(rt)) as { proposal_id: string }).proposal_id;
  const restarted = new ProposalStore({ path: proposalFile(rt), config: rt.config, connections: rt.connections });
  assert.equal(restarted.pending()?.proposal_id, id);
  writeFileSync(proposalFile(rt), '{"proposal_id": "x", "edit": ');
  assert.equal(restarted.pending(), null);
  assert.equal(restarted.approve("x").status, "not_found");
  assert.equal(rt.config.editableView().clients[0]?.projects[1]?.mode, "read_only");
  assert.equal(restarted.propose(edit(rt)).status, "pending", "a new proposal replaces the unusable file");
  const elsewhere = new ProposalStore({ path: path.join(mkdtempSync(path.join(tmpdir(), "reach-prop-")), "none.json"), config: rt.config, connections: rt.connections });
  assert.equal(elsewhere.pending(), null);
  await rt.close();
});

test("a tampered proposal file cannot smuggle a secret through approval", async () => {
  const rt = await startRuntime();
  const id = (rt.proposals.propose(edit(rt)) as { proposal_id: string }).proposal_id;
  const stored = JSON.parse(readFileSync(proposalFile(rt), "utf8"));
  stored.edit.mcp_bearer = "attacker-bearer-0123456789";
  writeFileSync(proposalFile(rt), JSON.stringify(stored));
  assert.equal(rt.proposals.approve(id).status, "not_found", "a tampered file is no proposal");
  assert.equal(rt.config.mcpBearerDigest(), hashCredential(MCP_MARKER));
  await rt.close();
});

test("a tampered proposal file fails closed: unknown or secret fields anywhere make it no proposal, with no leak and no mutation", async () => {
  const rt = await startRuntime();
  const id = (rt.proposals.propose(edit(rt)) as { proposal_id: string }).proposal_id;
  const original = readFileSync(proposalFile(rt), "utf8");
  const LEAK = "leak-marker-" + "Zq41";
  const tampers: [string, (string | number)[], unknown][] = [
    ["top-level unknown", ["extra"], LEAK],
    ["base client key", ["base", "clients", 0, "public_key"], LEAK],
    ["base client bearer", ["base", "clients", 0, "mcp_bearer"], LEAK],
    ["base project unknown", ["base", "clients", 0, "projects", 0, "surprise"], LEAK],
    ["base top-level unknown", ["base", "mcp_bearer_sha256"], LEAK],
    ["edit bearer", ["edit", "mcp_bearer"], LEAK],
    ["edit key", ["edit", "clients", 0, "public_key"], LEAK],
    ["edit project unknown", ["edit", "clients", 0, "projects", 0, "surprise"], LEAK],
    ["bad time", ["created_at"], "yesterday"],
  ];
  const setAt = (root: unknown, keys: (string | number)[], value: unknown) => {
    const parent = keys.slice(0, -1).reduce((node, key) => (node as Record<string | number, unknown>)[key], root) as Record<string | number, unknown>;
    parent[keys[keys.length - 1] as string | number] = value;
  };
  const sync = spySync(rt);
  for (const [name, keys, value] of tampers) {
    const stored = JSON.parse(original);
    setAt(stored, keys, value);
    writeFileSync(proposalFile(rt), JSON.stringify(stored));
    assert.equal(rt.proposals.pending(), null, name);
    assert.equal(rt.proposals.approve(id).status, "not_found", name);
    assert.equal(rt.proposals.reject(id).status, "not_found", name);
    const get = await rt.rpc("tools/call", { name: "reach_config_get", arguments: {} }, MCP_MARKER, 9);
    assert.ok(!JSON.stringify(get.body).includes(LEAK), `${name}: no MCP leak`);
  }
  assert.equal(sync.n, 0);
  assert.equal(rt.config.editableView().clients[0]?.projects[1]?.mode, "read_only", "config untouched");
  assert.equal(rt.config.mcpBearerDigest(), hashCredential(MCP_MARKER));
  assert.equal(rt.proposals.propose(edit(rt)).status, "pending", "a valid proposal replaces the unusable file");
  writeFileSync(proposalFile(rt), original);
  assert.equal(rt.proposals.pending()?.proposal_id, id, "the untampered file still loads");
  await rt.close();
});

test("MCP: reach_config_get reads redacted config and the pending summary; reach_config_propose only proposes", async () => {
  const rt = await startRuntime();
  const sync = spySync(rt);
  const tools = (await rt.rpc("tools/list", {})).body.result.tools as { name: string; annotations: Record<string, unknown>; inputSchema: { properties: Record<string, unknown> } }[];
  const get = tools.find((t) => t.name === "reach_config_get");
  const propose = tools.find((t) => t.name === "reach_config_propose");
  assert.deepEqual([get?.annotations.readOnlyHint, get?.annotations.idempotentHint], [true, true]);
  assert.deepEqual([propose?.annotations.readOnlyHint, propose?.annotations.destructiveHint, propose?.annotations.idempotentHint, propose?.annotations.openWorldHint], [false, false, false, false]);
  assert.deepEqual(Object.keys(propose?.inputSchema.properties ?? {}), ["clients"], "no secret field can be proposed");
  const before = await rt.rpc("tools/call", { name: "reach_config_get", arguments: {} }, MCP_MARKER, 2);
  assert.equal(before.body.result.structuredContent.pending, null);
  const text = JSON.stringify(before.body);
  for (const secret of [hashCredential(MCP_MARKER), hashCredential(CLIENT_MARKER), "sha256"]) assert.ok(!text.includes(secret));
  const made = await rt.rpc("tools/call", { name: "reach_config_propose", arguments: edit(rt) }, MCP_MARKER, 3);
  assert.equal(made.body.result.structuredContent.status, "pending");
  assert.equal(rt.config.editableView().clients[0]?.projects[1]?.mode, "read_only", "proposing never activates");
  assert.equal(sync.n, 0);
  const after = await rt.rpc("tools/call", { name: "reach_config_get", arguments: {} }, MCP_MARKER, 4);
  assert.equal(after.body.result.structuredContent.pending.diff.length, 1);
  await rt.close();
});

test("owner audit: MCP cannot activate; one edit schema owner; the proposal and admin adapters hold no second state", () => {
  const src = path.join(import.meta.dirname, "..", "src");
  const read = (f: string) => readFileSync(path.join(src, f), "utf8");
  assert.ok(!/applyEdit|activateCandidate|syncAllPolicies|\.approve\(|\.reject\(/.test(read("mcp.ts")), "MCP delegates only proposing and reading");
  assert.ok(!/from "zod"/.test(read("admin.ts")) && !/ClientEntry|EffectiveProjectPolicy|physical_root/.test(read("proposals.ts")), "no copied Client or project schema");
  assert.equal((read("config.ts").match(/AdminEdit = z\./g) ?? []).length, 1);
  assert.ok(!/new Map|new Set/.test(read("admin.ts")) && !/let pending|const pending/.test(read("admin.ts") + read("mcp.ts")), "no proposal state outside ProposalStore");
  assert.ok(!/writeFileSync|renameSync|openSync/.test(read("proposals.ts") + read("config.ts")), "one atomic write primitive");
});
