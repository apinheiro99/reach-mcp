import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FsError } from "@reach-mcp/shared/filesystem";
import { ClientDispatcher, buildRuntime, type ProjectRuntime } from "../src/index.ts";
import { OperationResult, ResponseEnvelope, type Operation, type PolicySync } from "@reach-mcp/shared/wire";
import { textPdf } from "@reach-mcp/shared/testing/pdf-fixture";

const base = realpathSync(mkdtempSync(path.join(tmpdir(), "reach-dispatch-")));
const anchor = path.join(base, "anchors");
const outside = path.join(base, "outside");
mkdirSync(anchor);
mkdirSync(outside);

const dir = (name: string): string => {
  const d = path.join(anchor, name);
  mkdirSync(d, { recursive: true });
  return d;
};
const pol = (project_id: string, physical_root: string, extra: object = {}) => ({ project_id, physical_root, mode: "read_write" as const, ...extra });
const snapshot = (...policies: object[]): PolicySync => ({ kind: "policy_sync", policies }) as PolicySync;
const req = (project_id: string, operation: Operation, request_id = "r1") => ({ kind: "request" as const, request_id, project_id, operation });
const fail = (response: ResponseEnvelope) => (response.ok ? "OK" : response.error.code);

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};
const tick = () => new Promise((r) => setTimeout(r, 5));

/** Manual timers for the mutation deadline. */
function timers() {
  const pending: (() => void)[] = [];
  return { schedule: (fn: () => void) => (pending.push(fn), () => void pending.splice(pending.indexOf(fn), 1)), fireOldest: () => pending.shift()?.(), count: () => pending.length };
}

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([0, 0, 0, 13]), Buffer.from("IHDR"), Buffer.from([0, 0, 0, 2, 0, 0, 0, 3, 8, 2, 0, 0, 0]), Buffer.alloc(4)]);

test("policy snapshots are atomic: a bad entry, a duplicate or an escaping root changes nothing; the next snapshot replaces", () => {
  const a = dir("snap-a");
  const b = dir("snap-b");
  const d = new ClientDispatcher({ anchors: [anchor] });
  d.applyPolicy(snapshot(pol("a", a), pol("b", b)));
  assert.deepEqual(d.projects(), ["a", "b"]);
  assert.throws(() => d.applyPolicy(snapshot(pol("c", a), pol("escape", outside))));
  assert.deepEqual(d.projects(), ["a", "b"], "one escaping root rejects the whole snapshot");
  assert.throws(() => d.applyPolicy(snapshot(pol("dup", a), pol("dup", b))));
  assert.throws(() => d.applyPolicy(snapshot(pol("rel", "relative/path"))));
  assert.deepEqual(d.projects(), ["a", "b"]);
  d.applyPolicy(snapshot(pol("b", b)));
  assert.deepEqual(d.projects(), ["b"], "a project missing from the next snapshot is gone");
  d.applyPolicy(snapshot());
  assert.deepEqual(d.projects(), []);
});

test("unknown project answers NOT_FOUND with the request id", async () => {
  const d = new ClientDispatcher({ anchors: [anchor] });
  const r = await d.handle(req("nope", { op: "fs_list" }, "abc"));
  assert.equal(fail(r), "NOT_FOUND");
  assert.equal(r.request_id, "abc");
});

test("mode and policy: read_only never touches disk; writable_globs, deny_globs and limits reach the primitives", async () => {
  const ro = dir("mode-ro");
  const rw = dir("mode-rw");
  mkdirSync(path.join(rw, "docs"));
  mkdirSync(path.join(rw, "secret"));
  writeFileSync(path.join(rw, "secret", "x.txt"), "hidden\n");
  writeFileSync(path.join(rw, "lines.txt"), "1\n2\n3\n4\n5\n");
  const d = new ClientDispatcher({ anchors: [anchor] });
  d.applyPolicy(snapshot(pol("ro", ro, { mode: "read_only" }), pol("rw", rw, { writable_globs: ["docs/**"], deny_globs: ["secret/**"], limits: { maxReadLines: 2 } })));
  assert.equal(fail(await d.handle(req("ro", { op: "fs_write", path: "a.txt", content: "x" }))), "DENIED");
  assert.equal(fail(await d.handle(req("ro", { op: "fs_remove", path: "a.txt" }))), "DENIED");
  assert.throws(() => readFileSync(path.join(ro, "a.txt")), "nothing was written");
  assert.equal(fail(await d.handle(req("rw", { op: "fs_write", path: "docs/a.txt", content: "ok" }))), "OK");
  assert.equal(readFileSync(path.join(rw, "docs/a.txt"), "utf8"), "ok");
  assert.equal(fail(await d.handle(req("rw", { op: "fs_write", path: "src.txt", content: "no" }))), "DENIED", "outside writable_globs");
  assert.equal(fail(await d.handle(req("rw", { op: "fs_read", path: "secret/x.txt" }))), "DENIED", "Server deny glob");
  const read = await d.handle(req("rw", { op: "fs_read", path: "lines.txt" }));
  assert.ok(read.ok && read.result.op === "fs_read" && read.result.end_line === 2 && read.result.next_start_line === 3, "Server limit applied");
});

test("restricted write: temp/** and exact files are writable, an unlisted path is denied, deny beats the allowlist and delete moves to .lixeira", async () => {
  const root = dir("restricted");
  mkdirSync(path.join(root, "temp"));
  writeFileSync(path.join(root, "temp", "old.txt"), "old\n");
  const d = new ClientDispatcher({ anchors: [anchor] });
  d.applyPolicy(snapshot(pol("r", root, { writable_globs: ["temp/**", ".gitlab-ci.yml"], deny_globs: ["temp/private/**"] })));
  assert.equal(fail(await d.handle(req("r", { op: "fs_write", path: "temp/new.txt", content: "ok" }))), "OK");
  assert.equal(fail(await d.handle(req("r", { op: "fs_write", path: ".gitlab-ci.yml", content: "ok" }))), "OK", "an exact file is a rule");
  assert.equal(fail(await d.handle(req("r", { op: "fs_write", path: "src/app.ts", content: "no" }))), "DENIED", "unlisted path");
  assert.equal(fail(await d.handle(req("r", { op: "fs_write", path: "temp/private/k.txt", content: "no" }))), "DENIED", "deny wins over the allowlist");
  const removed = await d.handle(req("r", { op: "fs_remove", path: "temp/old.txt" }));
  assert.ok(removed.ok && removed.result.op === "fs_remove" && removed.result.moved_to.startsWith(".lixeira/"), "delete is move-to-trash");
  assert.throws(() => readFileSync(path.join(root, "temp", "old.txt")), "the original is gone from its place");
});

test("every operation maps to a wire-valid result with the request's id and op", async () => {
  const p = dir("ops");
  mkdirSync(path.join(p, "sub"));
  writeFileSync(path.join(p, "sub", "note.txt"), "needle here\nsecond\n");
  writeFileSync(path.join(p, "pic.png"), PNG);
  writeFileSync(path.join(p, "doc.pdf"), textPdf([["hello pdf"]]));
  const gitRun = (...args: string[]) => execFileSync("git", ["-C", p, "-c", "user.name=T", "-c", "user.email=t@example.com", ...args]);
  gitRun("init", "-q", "-b", "main");
  gitRun("add", "-A");
  gitRun("commit", "-q", "-m", "first");
  writeFileSync(path.join(p, "sub", "note.txt"), "needle changed\n");
  const d = new ClientDispatcher({ anchors: [anchor] });
  d.applyPolicy(snapshot(pol("ops", p)));
  const ops: Operation[] = [
    { op: "fs_list" },
    { op: "fs_find", pattern: "note" },
    { op: "fs_read", path: "sub/note.txt" },
    { op: "fs_search", patterns: ["needle"], context_lines: 1 },
    { op: "fs_read_image", path: "pic.png" },
    { op: "fs_read_pdf", path: "doc.pdf" },
    { op: "git_status" },
    { op: "git_diff" },
    { op: "git_log" },
    { op: "git_show", rev: "HEAD" },
    { op: "fs_write", path: "new.txt", content: "hello" },
    { op: "fs_edit", path: "new.txt", old_text: "hello", new_text: "bye" },
    { op: "fs_remove", path: "new.txt" },
  ];
  for (const [i, operation] of ops.entries()) {
    const response = await d.handle(req("ops", operation, `id-${i}`));
    assert.equal(response.request_id, `id-${i}`);
    assert.ok(response.ok, `${operation.op}: ${response.ok ? "" : response.error.code + " " + response.error.message}`);
    assert.equal(response.result.op, operation.op);
    assert.ok(ResponseEnvelope.safeParse(response).success && OperationResult.safeParse(response.result).success, operation.op);
  }
  const image = await d.handle(req("ops", { op: "fs_read_image", path: "pic.png" }));
  assert.ok(image.ok && image.result.op === "fs_read_image" && Buffer.from(image.result.data_base64, "base64").equals(PNG) && image.result.mime_type === "image/png");
  const notRepo = dir("not-a-repo");
  d.applyPolicy(snapshot(pol("plain", notRepo)));
  assert.equal(fail(await d.handle(req("plain", { op: "git_status" }))), "NOT_FOUND");
});

/** A runtime whose reads and writes wait on gates and record what ran. */
function gated() {
  const log: string[] = [];
  const gates = new Map<string, { promise: Promise<void>; resolve: () => void }>();
  const gate = (name: string) => {
    log.push(`start ${name}`);
    const g = deferred();
    gates.set(name, g);
    return g.promise.then(() => void log.push(`end ${name}`));
  };
  const open = async (name: string) => {
    for (let i = 0; i < 50 && !gates.has(name); i++) await tick();
    gates.get(name)?.resolve();
    await tick();
  };
  const runtime = (project: string): ProjectRuntime => ({
    reader: {
      list: async (p = "") => (await gate(`${project}:list:${p}`), { path: p, entries: [], truncated: false }),
      find: async () => ({ path: "", pattern: "", matches: [], truncated: false, scanned: 0 }),
      read: async () => { throw new Error("unused"); },
      search: async () => { throw new Error("unused"); },
      readImage: async () => { throw new Error("unused"); },
    },
    writer: {
      write: async (p: string) => (await gate(`${project}:write:${p}`), { path: p, bytes: 1 }),
      edit: async () => { throw new Error("unused"); },
      remove: async () => { throw new Error("unused"); },
    },
    git: null,
    pdf: async () => { throw new Error("unused"); },
  });
  return { log, open, runtime };
}

test("reads overlap: no read queue, not even behind a running mutation", async () => {
  const g = gated();
  const d = new ClientDispatcher({ anchors: [anchor], createRuntime: (p) => g.runtime(p.project_id) });
  d.applyPolicy(snapshot(pol("p", dir("conc-reads"))));
  const w = d.handle(req("p", { op: "fs_write", path: "w", content: "x" }, "w"));
  const r1 = d.handle(req("p", { op: "fs_list", path: "one" }, "r1"));
  const r2 = d.handle(req("p", { op: "fs_list", path: "two" }, "r2"));
  await tick();
  assert.deepEqual([...g.log].sort(), ["start p:list:one", "start p:list:two", "start p:write:w"], "all started before any finished");
  for (const n of ["p:list:two", "p:list:one", "p:write:w"]) await g.open(n);
  assert.deepEqual((await Promise.all([w, r1, r2])).map((r) => r.request_id), ["w", "r1", "r2"]);
});

test("same-project mutations run strictly FIFO; another project is independent", async () => {
  const g = gated();
  const d = new ClientDispatcher({ anchors: [anchor], createRuntime: (p) => g.runtime(p.project_id) });
  d.applyPolicy(snapshot(pol("a", dir("fifo-a")), pol("b", dir("fifo-b"))));
  const a1 = d.handle(req("a", { op: "fs_write", path: "1", content: "x" }, "a1"));
  const a2 = d.handle(req("a", { op: "fs_write", path: "2", content: "x" }, "a2"));
  const a3 = d.handle(req("a", { op: "fs_write", path: "3", content: "x" }, "a3"));
  const b1 = d.handle(req("b", { op: "fs_write", path: "1", content: "x" }, "b1"));
  await tick();
  assert.deepEqual(g.log, ["start a:write:1", "start b:write:1"], "A's second waits; B starts while A runs");
  await g.open("b:write:1");
  assert.equal((await b1).request_id, "b1");
  await g.open("a:write:1");
  await g.open("a:write:2");
  await g.open("a:write:3");
  await Promise.all([a1, a2, a3]);
  assert.deepEqual(g.log.filter((l) => l.includes("a:")), ["start a:write:1", "end a:write:1", "start a:write:2", "end a:write:2", "start a:write:3", "end a:write:3"]);
});

test("a timed-out mutation is reported indeterminate once, keeps its slot until it really settles, and is never replayed", async () => {
  const g = gated();
  const t = timers();
  let writes = 0;
  const d = new ClientDispatcher({
    anchors: [anchor],
    schedule: t.schedule,
    createRuntime: (p) => {
      const rt = g.runtime(p.project_id);
      const write = rt.writer!.write;
      rt.writer!.write = (...args: Parameters<typeof write>) => (writes++, write(...args));
      return rt;
    },
  });
  d.applyPolicy(snapshot(pol("p", dir("timeout"))));
  const first = d.handle(req("p", { op: "fs_write", path: "slow", content: "x" }, "m1"));
  const second = d.handle(req("p", { op: "fs_write", path: "next", content: "x" }, "m2"));
  await tick();
  t.fireOldest();
  const late = await first;
  assert.equal(fail(late), "MUTATION_INDETERMINATE");
  assert.equal(late.request_id, "m1");
  await tick();
  assert.equal(writes, 1, "the second mutation did not overtake the unsettled first");
  assert.deepEqual(g.log, ["start p:write:slow"]);
  await g.open("p:write:slow");
  await g.open("p:write:next");
  assert.equal(fail(await second), "OK");
  assert.equal(writes, 2, "each mutation ran exactly once: no replay");
  assert.deepEqual(g.log, ["start p:write:slow", "end p:write:slow", "start p:write:next", "end p:write:next"]);
});

test("the overwrite guard runs when a queued mutation executes, not when it is queued", async () => {
  const p = dir("guard");
  writeFileSync(path.join(p, "a.txt"), "plain\n");
  const gate = deferred();
  const d = new ClientDispatcher({
    anchors: [anchor],
    createRuntime: (policy) => {
      const rt = buildRuntime(policy);
      const write = rt.writer!.write.bind(rt.writer);
      let first = true;
      rt.writer!.write = async (...args: Parameters<typeof write>) => {
        if (first) {
          first = false;
          await gate.promise;
        }
        return write(...args);
      };
      return rt;
    },
  });
  d.applyPolicy(snapshot(pol("p", p)));
  const one = d.handle(req("p", { op: "fs_write", path: "b.txt", content: "one" }, "w1"));
  const two = d.handle(req("p", { op: "fs_write", path: "a.txt", content: "overwrite" }, "w2"));
  await tick();
  const key = "-----BEGIN " + "PRIVATE KEY" + "-----\nabc\n-----END " + "PRIVATE KEY" + "-----\n";
  writeFileSync(path.join(p, "a.txt"), key);
  gate.resolve();
  assert.equal(fail(await one), "OK");
  assert.equal(fail(await two), "DENIED", "the second write saw the bytes present when it ran");
  assert.equal(readFileSync(path.join(p, "a.txt"), "utf8"), key, "the protected file was not overwritten");
});

test("an operation error becomes a compact response without a stack or raw message", async () => {
  const p = dir("errors");
  const d = new ClientDispatcher({
    anchors: [anchor],
    createRuntime: (policy) => ({ ...buildRuntime(policy), reader: { ...buildRuntime(policy).reader, list: () => { throw new Error("boom " + p); } } }),
  });
  d.applyPolicy(snapshot(pol("p", p)));
  const r = await d.handle(req("p", { op: "fs_list" }));
  assert.ok(!r.ok);
  assert.equal(r.error.code, "INTERNAL");
  assert.ok(!JSON.stringify(r).includes(p));
});

test("an invalid mutation timeout is refused", () => {
  for (const bad of [0, -1, Number.NaN]) assert.throws(() => new ClientDispatcher({ anchors: [anchor], mutationTimeoutMs: bad }), RangeError);
});

test("a queued mutation runs under the policy active when it starts: read_only, removal and a tighter glob all stop it", async () => {
  for (const change of ["read_only", "removed", "tighter"] as const) {
    const root = dir(`requeue-${change}`);
    const g = gated();
    const writes: string[] = [];
    const d = new ClientDispatcher({
      anchors: [anchor],
      createRuntime: (policy) => {
        const rt = g.runtime(policy.project_id);
        const write = rt.writer!.write;
        const allow = policy.writable_globs;
        rt.writer!.write = (p: string) => {
          if (allow && !allow.some((glob) => p.startsWith(glob.replace("/**", "/")))) throw new FsError("DENIED", "outside writable globs");
          writes.push(p);
          return write(p, "");
        };
        return rt;
      },
    });
    d.applyPolicy(snapshot(pol("p", root)));
    const running = d.handle(req("p", { op: "fs_write", path: "first", content: "x" }, "A"));
    const queued = d.handle(req("p", { op: "fs_write", path: "docs/second", content: "x" }, "B"));
    await tick();
    assert.deepEqual(g.log, ["start p:write:first"], "B is queued behind A");
    if (change === "read_only") d.applyPolicy(snapshot(pol("p", root, { mode: "read_only" })));
    if (change === "removed") d.applyPolicy(snapshot());
    if (change === "tighter") d.applyPolicy(snapshot(pol("p", root, { writable_globs: ["other/**"] })));
    await g.open("p:write:first");
    assert.equal(fail(await running), "OK", "the running mutation finishes under the runtime it started with");
    assert.equal(fail(await queued), change === "removed" ? "NOT_FOUND" : "DENIED", change);
    assert.deepEqual(writes, ["first"], "the queued writer was never called");
  }
});

test("one Client, several Effective Project Configurations: both are active at once, requests reach the right root, and an out-of-anchor snapshot changes nothing", async () => {
  const web = dir("multi-web");
  const api = dir("multi-api");
  writeFileSync(path.join(web, "who.txt"), "web\n");
  writeFileSync(path.join(api, "who.txt"), "api\n");
  const d = new ClientDispatcher({ anchors: [anchor] });
  const two = snapshot(pol("web", web), pol("api", api, { mode: "read_only" }));
  d.applyPolicy(two);
  assert.deepEqual(d.projects(), ["web", "api"], "both logical projects are active in the one dispatcher");
  const who = async (project: string) => {
    const r = await d.handle(req(project, { op: "fs_read", path: "who.txt" }));
    return r.ok && r.result.op === "fs_read" ? r.result.content : fail(r);
  };
  assert.match(String(await who("web")), /web/);
  assert.match(String(await who("api")), /api/);
  assert.equal(fail(await d.handle(req("api", { op: "fs_write", path: "x.txt", content: "no" }))), "DENIED", "each project keeps its own mode");
  assert.equal(fail(await d.handle(req("web", { op: "fs_write", path: "x.txt", content: "yes" }))), "OK");
  assert.throws(() => readFileSync(path.join(api, "x.txt")), "a write for one project never lands in the other");
  assert.throws(() => d.applyPolicy(snapshot(pol("web", web), pol("api", api), pol("third", outside))));
  assert.deepEqual(d.projects(), ["web", "api"], "the third project outside the local anchors rejects the whole snapshot");
  assert.match(String(await who("web")), /web/, "the previous valid snapshot stays active and working");
  assert.equal(fail(await d.handle(req("third", { op: "fs_list" }))), "NOT_FOUND");
});
