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
  assert.deepEqual(Object.keys(JSON.parse(stored)).sort(), ["base", "created_at", "items", "proposal_id"]);
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
  assert.deepEqual(rt.proposals.approve(id), { status: "approved", remaining: 0 });
  assert.equal(sync.n, 1);
  assert.equal(rt.config.editableView().clients[0]?.projects[1]?.mode, "read_write");
  assert.equal(rt.config.admissionOf("laptop")?.publicKey, LAPTOP.publicKey, "public keys survive an approved edit");
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
  assert.deepEqual(rt.proposals.reject(id), { status: "rejected", remaining: 0 });
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
  assert.equal(restarted.unusable(), true, "an unreadable file is a visible state, not absence");
  assert.equal(restarted.propose(edit(rt)).status, "invalid", "the slot stays closed: the unusable file is never overwritten");
  assert.equal(readFileSync(proposalFile(rt), "utf8"), '{"proposal_id": "x", "edit": ');
  const elsewhere = new ProposalStore({ path: path.join(mkdtempSync(path.join(tmpdir(), "reach-prop-")), "none.json"), config: rt.config, connections: rt.connections });
  assert.equal(elsewhere.pending(), null);
  await rt.close();
});

test("a tampered proposal file cannot smuggle a secret through approval", async () => {
  const rt = await startRuntime();
  const id = (rt.proposals.propose(edit(rt)) as { proposal_id: string }).proposal_id;
  const stored = JSON.parse(readFileSync(proposalFile(rt), "utf8"));
  stored.items[0].mcp_bearer = "attacker-bearer-0123456789";
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
    ["item bearer", ["items", 0, "mcp_bearer"], LEAK],
    ["item key", ["items", 0, "change", "public_key"], LEAK],
    ["item change unknown", ["items", 0, "change", "surprise"], LEAK],
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
  assert.equal(rt.proposals.unusable(), true);
  assert.equal(rt.proposals.propose(edit(rt)).status, "invalid", "the unusable file keeps the slot closed");
  writeFileSync(proposalFile(rt), original);
  assert.equal(rt.proposals.unusable(), false);
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

/** A valid edit that proposes `count` new deny rules on the api project, one glob each. */
const ruleEdit = (rt: Rt, count: number, list: "deny_globs" | "allow_globs" = "deny_globs") => ({
  clients: rt.config.editableView().clients.map(plain).map((c) => ({ ...c, projects: c.projects.map((p) => (p.project_id === "api" ? { ...p, [list]: [...((p as unknown as Record<string, string[]>)[list] ?? []), ...Array.from({ length: count }, (_, i) => `rules/r${i}/**`)] } : p)) })),
});
const apiRules = (rt: Rt, list = "deny_globs") => (rt.config.editableView().clients[0]?.projects[1] as unknown as Record<string, string[] | undefined>)[list] ?? [];

test("granular review: ten proposed Access Rules are ten independent items; approving eight and rejecting two yields exactly eight effective rules", async () => {
  const rt = await startRuntime();
  const sync = spySync(rt);
  const id = (rt.proposals.propose(ruleEdit(rt, 10)) as { proposal_id: string }).proposal_id;
  const items = rt.proposals.pending()!.items;
  assert.equal(items.length, 10);
  assert.equal(new Set(items.map((i) => i.item_id)).size, 10, "stable distinct ids");
  assert.ok(items.every((i) => i.status === "pending"));
  for (const item of items.slice(0, 2)) assert.deepEqual(rt.proposals.rejectItem(id, item.item_id), { status: "rejected", remaining: 10 - items.indexOf(item) - 1 });
  assert.deepEqual(apiRules(rt), [], "rejecting changes nothing");
  assert.equal(sync.n, 0);
  for (const item of items.slice(2)) assert.equal(rt.proposals.approveItem(id, item.item_id).status, "approved");
  assert.deepEqual(apiRules(rt).sort(), items.slice(2).map((i) => i.path.match(/\[(rules[^\]]+)\]$/)![1]!).sort(), "exactly the eight approved rules are effective");
  assert.equal(sync.n, 8, "one durable change, one sync, per approved item");
  assert.equal(rt.proposals.pending(), null, "the proposal closes when every item is decided");
  await rt.close();
});

test("granular review: rejecting one item leaves the others pending and approve-all is only a convenience over the remaining items", async () => {
  const rt = await startRuntime();
  const sync = spySync(rt);
  const id = (rt.proposals.propose(ruleEdit(rt, 3)) as { proposal_id: string }).proposal_id;
  const [first] = rt.proposals.pending()!.items;
  assert.deepEqual(rt.proposals.rejectItem(id, first!.item_id), { status: "rejected", remaining: 2 });
  assert.equal(rt.proposals.rejectItem(id, first!.item_id).status, "not_found", "a decided item cannot be decided again");
  assert.equal(rt.proposals.approveItem(id, "nope").status, "not_found");
  assert.deepEqual(rt.proposals.pending()!.items.map((i) => i.status), ["rejected", "pending", "pending"]);
  assert.deepEqual(rt.proposals.approve(id), { status: "approved", remaining: 0 });
  assert.equal(sync.n, 1, "approve-all applies the remaining items in one durable change and one sync");
  assert.equal(apiRules(rt).length, 2);
  assert.ok(!apiRules(rt).includes("rules/r0/**"), "the rejected item never applied");
  await rt.close();
});

test("granular review is stale-safe: a human edit after the first approved item makes the remaining items stale and is never overwritten", async () => {
  const rt = await startRuntime();
  const id = (rt.proposals.propose(ruleEdit(rt, 3)) as { proposal_id: string }).proposal_id;
  const items = rt.proposals.pending()!.items;
  assert.equal(rt.proposals.approveItem(id, items[0]!.item_id).status, "approved");
  rt.config.applyEdit({ clients: rt.config.editableView().clients.map(plain).map((c) => ({ ...c, display_name: "edited by a human" })) });
  const sync = spySync(rt);
  assert.equal(rt.proposals.approveItem(id, items[1]!.item_id).status, "stale");
  assert.equal(rt.proposals.approve(id).status, "stale");
  assert.equal(sync.n, 0);
  assert.equal(rt.config.editableView().clients[0]?.display_name, "edited by a human", "the human change survives");
  assert.deepEqual(apiRules(rt), ["rules/r0/**"].filter((g) => items[0]!.path.includes(g)).length ? [items[0]!.path.match(/\[(rules[^\]]+)\]$/)![1]] : [], "only the item approved before the human edit is applied");
  assert.equal(rt.proposals.rejectItem(id, items[1]!.item_id).status, "rejected", "rejecting never needs a fresh base");
  await rt.close();
});

test("an approved explicit allow rule is an Access Rule item like any other, and a conflicting allow+deny edit is refused at proposal time", async () => {
  const rt = await startRuntime();
  assert.equal(rt.proposals.propose(ruleEdit(rt, 1, "allow_globs")).status, "pending");
  const [item] = rt.proposals.pending()!.items;
  assert.match(item!.path, /\.allow_globs\[rules\/r0\/\*\*\]$/);
  const id = rt.proposals.pending()!.proposal_id;
  assert.equal(rt.proposals.approveItem(id, item!.item_id).status, "approved");
  assert.deepEqual(apiRules(rt, "allow_globs"), ["rules/r0/**"]);
  const both = rt.config.editableView().clients.map(plain).map((c) => ({ ...c, projects: c.projects.map((p) => (p.project_id === "api" ? { ...p, deny_globs: ["rules/r0/**"] } : p)) }));
  const refused = rt.proposals.propose({ clients: both });
  assert.equal(refused.status, "invalid");
  assert.match(JSON.stringify(refused), /conflicting explicit rules/);
  await rt.close();
});

test("a proposal that changes nothing is refused instead of creating an undecidable proposal", async () => {
  const rt = await startRuntime();
  const same = { clients: rt.config.editableView().clients.map(plain) };
  assert.deepEqual(rt.proposals.propose(same), { status: "invalid", problems: ["the proposal changes nothing"] });
  assert.equal(rt.proposals.pending(), null);
  await rt.close();
});

/** The previous on-disk format: the whole proposed edit next to the base, no items. */
const legacyFile = (rt: Rt, extra: Record<string, unknown> = {}) => ({ proposal_id: "legacy-1", created_at: "2026-11-20T10:00:00.000Z", base: rt.config.editableView(), edit: edit(rt), ...extra });

test("legacy proposal: a valid previous-format file migrates once, keeps its id and time, derives pending items and applies nothing", async () => {
  const rt = await startRuntime();
  const sync = spySync(rt);
  const config = readFileSync(rt.file, "utf8");
  writeFileSync(proposalFile(rt), JSON.stringify(legacyFile(rt)));
  const first = rt.proposals.pending();
  assert.equal(first?.proposal_id, "legacy-1");
  assert.equal(first?.created_at, "2026-11-20T10:00:00.000Z");
  assert.deepEqual(first?.items.map((i) => [i.item_id, i.status]), [["i1", "pending"]]);
  assert.deepEqual(first?.diff, [{ path: "clients[laptop].projects[api].mode", before: '"read_only"', after: '"read_write"' }]);
  const migrated = JSON.parse(readFileSync(proposalFile(rt), "utf8"));
  assert.deepEqual(Object.keys(migrated).sort(), ["base", "created_at", "items", "proposal_id"], "the file is now the itemized format");
  assert.deepEqual(rt.proposals.pending(), first, "a second read is idempotent");
  assert.equal(readFileSync(rt.file, "utf8"), config, "the active config is byte-for-byte unchanged");
  assert.equal(sync.n, 0, "migration syncs nothing");
  assert.equal(rt.proposals.unusable(), false);
  await rt.close();
});

test("legacy proposal: after migration the slot stays closed and the item is decided like any other", async () => {
  const rt = await startRuntime();
  writeFileSync(proposalFile(rt), JSON.stringify(legacyFile(rt)));
  assert.deepEqual(rt.proposals.propose(edit(rt, "read_only")), { status: "already_pending", proposal_id: "legacy-1" });
  assert.equal(rt.proposals.approveItem("legacy-1", "i1").status, "approved");
  assert.equal(rt.config.editableView().clients[0]?.projects[1]?.mode, "read_write");
  await rt.close();
});

test("legacy proposal: a stale legacy base is still stale after migration", async () => {
  const rt = await startRuntime();
  writeFileSync(proposalFile(rt), JSON.stringify(legacyFile(rt)));
  rt.config.applyEdit({ clients: rt.config.editableView().clients.map(plain).map((c) => ({ ...c, display_name: "edited by a human" })) });
  assert.equal(rt.proposals.approve("legacy-1").status, "stale");
  assert.equal(rt.proposals.pending()?.proposal_id, "legacy-1", "still pending, not lost");
  await rt.close();
});

test("legacy proposal: a malformed or unmigratable previous-format file is an explicit unusable state that keeps the slot closed and is never rewritten", async () => {
  const rt = await startRuntime();
  const cases: [string, Record<string, unknown>][] = [
    ["secret in the edit", legacyFile(rt, { edit: { ...edit(rt), mcp_bearer: "attacker-bearer-0123456789" } })],
    ["unknown top-level field", legacyFile(rt, { surprise: 1 })],
    ["edit changes nothing", legacyFile(rt, { edit: { clients: rt.config.editableView().clients.map(plain) } })],
    ["bad time", legacyFile(rt, { created_at: "yesterday" })],
  ];
  for (const [name, file] of cases) {
    const text = JSON.stringify(file);
    writeFileSync(proposalFile(rt), text);
    assert.equal(rt.proposals.pending(), null, name);
    assert.equal(rt.proposals.unusable(), true, name);
    assert.equal(rt.proposals.propose(edit(rt)).status, "invalid", name);
    assert.equal(readFileSync(proposalFile(rt), "utf8"), text, `${name}: the file is left as found`);
  }
  assert.equal(rt.config.editableView().clients[0]?.projects[1]?.mode, "read_only");
  await rt.close();
});

test("no proposal file at all is plain absence, not an unusable state", async () => {
  const rt = await startRuntime();
  assert.equal(rt.proposals.unusable(), false);
  assert.equal(rt.proposals.pending(), null);
  await rt.close();
});
