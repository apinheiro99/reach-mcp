// The shared wire contract: strict frames, correlation, typed operations and results, compact errors and the build gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { FsError } from "../src/filesystem/index.ts";
import {
  BuildCompatibility,
  ClientHello,
  ClientRotated,
  ServerRotateKey,
  SessionMessage,
  ClientMessage,
  failureResponse,
  FS_ERROR_CODES,
  MUTATION_INDETERMINATE_ERROR,
  HandshakeReply,
  incompatibleBuildError,
  isMutation,
  MUTATING_OPERATIONS,
  Operation,
  OperationResult,
  parseWire,
  PolicySync,
  POLICY_SYNC_MAX_PROJECTS,
  PostWelcomeMessage,
  RequestEnvelope,
  ResponseEnvelope,
  ServerMessage,
  toWireError,
  WireError,
  WireFault,
  ServerChallenge,
} from "../src/wire/index.ts";

// A marker standing in for secret material that must never be echoed; not shaped like any real key.
const CRED = "cred-marker-" + "Qz81mVx";
const hello = { kind: "hello", client_id: "laptop-1", client_build: "build-2026.11.0001", public_key: "A".repeat(43), signature: "B".repeat(86) };
const request = (operation: unknown, extra: object = {}) => ({ kind: "request", request_id: "req-1", project_id: "proj-a", operation, ...extra });

test("handshake: a valid hello parses; empty identity or build, malformed key or signature, and unknown keys are rejected", () => {
  assert.ok(parseWire(ClientHello, hello).ok);
  for (const field of ["client_id", "client_build", "public_key", "signature"]) {
    for (const bad of ["", "x".repeat(2000), "a\nb", "a\u0000b", 42, undefined]) {
      assert.equal(ClientHello.safeParse({ ...hello, [field]: bad }).success, false, `${field}=${JSON.stringify(bad)?.slice(0, 20)}`);
    }
  }
  assert.equal(ClientHello.safeParse({ ...hello, extra: 1 }).success, false);
  assert.equal(ClientHello.safeParse({ ...hello, kind: "request" }).success, false);
  assert.equal(ClientHello.safeParse({ ...hello, credential: CRED }).success, false, "the shared Client credential no longer exists on the wire");
  assert.equal(ClientHello.safeParse({ ...hello, public_key: "A".repeat(44) }).success, false, "a public key is exactly 32 bytes");
  assert.equal(ClientHello.safeParse({ ...hello, signature: "B".repeat(85) }).success, false, "a signature is exactly 64 bytes");
  assert.equal(ClientHello.safeParse({ ...hello, display_name: "Work laptop" }).success, true);
  assert.equal(ServerChallenge.safeParse({ kind: "challenge", nonce: "N".repeat(43) }).success, true);
  for (const bad of [{ kind: "challenge" }, { kind: "challenge", nonce: "short" }, { kind: "challenge", nonce: "N".repeat(43), extra: 1 }]) assert.equal(ServerChallenge.safeParse(bad).success, false);
});

test("there is no protocol field or version negotiation anywhere in the contract", () => {
  assert.equal(ClientHello.safeParse({ ...hello, protocol: 1 }).success, false);
  assert.equal(ClientHello.safeParse({ ...hello, protocol_version: "1.0.0" }).success, false);
  assert.equal(RequestEnvelope.safeParse(request({ op: "git_status" }, { protocol: 1 })).success, false);
  const dir = path.join(import.meta.dirname, "../src/wire");
  for (const file of readdirSync(dir)) {
    const text = readFileSync(path.join(dir, file), "utf8");
    assert.ok(!/protocol_version|protocolVersion|semver|negotiat.*\(/i.test(text.replace(/\/\/.*$/gm, "")), `${file} must not define version negotiation`);
  }
});

test("a submitted value is never echoed: validation errors name paths and codes only", () => {
  for (const bad of [{ ...hello, extra: CRED }, { ...hello, signature: CRED + "\n" }, { ...hello, client_id: "" }, { ...hello, public_key: CRED.repeat(100) }]) {
    const out = parseWire(ClientHello, bad);
    assert.equal(out.ok, false);
    if (!out.ok) {
      assert.equal(out.error.code, "BAD_REQUEST");
      assert.ok(!JSON.stringify(out.error).includes("cred-marker"), "the credential value must not appear");
    }
  }
  const stripped = toWireError(new Error(`connection failed for ${CRED}`));
  assert.ok(!JSON.stringify(stripped).includes("cred-marker"));
});

test("handshake replies: welcome or a compact rejection carrying the build identifiers", () => {
  assert.ok(HandshakeReply.safeParse({ kind: "welcome", server_build: "build-2026.11.0001", compatible: true }).success);
  assert.equal(HandshakeReply.safeParse({ kind: "welcome", server_build: "b", compatible: false }).success, false, "a welcome is always compatible");
  const reject = { kind: "reject", server_build: "build-2026.11.0009", error: incompatibleBuildError("build-2026.11.0001", "build-2026.11.0009") };
  assert.ok(HandshakeReply.safeParse(reject).success);
  assert.equal(reject.error.code, "INCOMPATIBLE_BUILD");
  assert.deepEqual(reject.error.details, { client_build: "build-2026.11.0001", server_build: "build-2026.11.0009" });
  assert.ok(BuildCompatibility.safeParse({ compatible: false, error: reject.error }).success);
  assert.equal(BuildCompatibility.safeParse({ compatible: false }).success, false);
  assert.equal(BuildCompatibility.safeParse({ compatible: true, range: ">=1" }).success, false, "no ranges or negotiation data");
});

test("request envelope: needs request_id, project_id and a known typed operation; strict", () => {
  assert.ok(RequestEnvelope.safeParse(request({ op: "fs_list" })).success);
  assert.equal(RequestEnvelope.safeParse({ kind: "request", project_id: "p", operation: { op: "fs_list" } }).success, false, "missing request_id");
  assert.equal(RequestEnvelope.safeParse({ kind: "request", request_id: "r", operation: { op: "fs_list" } }).success, false, "missing project_id");
  for (const bad of ["", "a\tb", "x".repeat(300)]) {
    assert.equal(RequestEnvelope.safeParse(request({ op: "fs_list" }, { request_id: bad })).success, false);
    assert.equal(RequestEnvelope.safeParse(request({ op: "fs_list" }, { project_id: bad })).success, false);
  }
  assert.equal(RequestEnvelope.safeParse(request({ op: "shell_exec", command: "ls" })).success, false, "unsupported operation");
  assert.equal(RequestEnvelope.safeParse(request({ op: "fs_list" }, { signature: CRED })).success, false, "nothing is signed or authenticated after the handshake");
  assert.equal(RequestEnvelope.safeParse(request({ op: "fs_list" }, { conversation_id: "c" })).success, false, "no conversation identity");
  assert.equal(RequestEnvelope.safeParse(request({ op: "fs_list", unknown: 1 })).success, false, "strict operation objects");
  assert.equal(RequestEnvelope.safeParse(request({ op: "git_commit" })).success, false, "no mutating Git operation exists");
  assert.equal(RequestEnvelope.safeParse(request({ op: "fs_list" })).success, true);
});

const policyFrame = { kind: "policy_sync", policies: [{ project_id: "p1", physical_root: "/srv/p1", mode: "read_only" }] };
const responseFrame = { kind: "response", request_id: "req-1", ok: true, result: { op: "fs_write", path: "a.txt", bytes: 3 } };

test("direction: the Client sends hello and responses, the Server sends challenge, welcome, reject, policy and requests", () => {
  assert.equal(ClientMessage.safeParse(hello).success, true);
  assert.equal(ClientMessage.safeParse(responseFrame).success, true);
  assert.equal(ClientMessage.safeParse(request({ op: "fs_list" })).success, false, "a request is never Client -> Server");
  assert.equal(ClientMessage.safeParse(policyFrame).success, false);
  for (const frame of [{ kind: "challenge", nonce: "N".repeat(43) }, { kind: "welcome", server_build: "b", compatible: true }, { kind: "reject", error: { code: "AUTH_FAILED", message: "m" } }, policyFrame, request({ op: "fs_list" })]) {
    assert.equal(ServerMessage.safeParse(frame).success, true, JSON.stringify(frame).slice(0, 40));
  }
  assert.equal(ServerMessage.safeParse(responseFrame).success, false, "a response is never Server -> Client");
  assert.equal(ServerMessage.safeParse(hello).success, false);
  assert.equal(PostWelcomeMessage.safeParse(policyFrame).success, true);
  assert.equal(PostWelcomeMessage.safeParse(request({ op: "fs_list" })).success, true);
  assert.equal(PostWelcomeMessage.safeParse({ kind: "welcome", server_build: "b", compatible: true }).success, false);
});

test("policy_sync: strict full snapshot, bounded, with absolute roots", () => {
  assert.equal(PolicySync.safeParse(policyFrame).success, true);
  assert.equal(PolicySync.safeParse({ kind: "policy_sync", policies: [] }).success, true, "an empty snapshot removes every project");
  assert.equal(PolicySync.safeParse({ ...policyFrame, extra: 1 }).success, false);
  assert.equal(PolicySync.safeParse({ kind: "policy_sync", policies: [{ project_id: "p", physical_root: "rel", mode: "read_only" }] }).success, false);
  const many = Array.from({ length: POLICY_SYNC_MAX_PROJECTS + 1 }, (_, i) => ({ project_id: `p${i}`, physical_root: "/r", mode: "read_only" }));
  assert.equal(PolicySync.safeParse({ kind: "policy_sync", policies: many }).success, false);
});

test("responses: success or error, each with exactly one request_id", () => {
  const ok = { kind: "response", request_id: "req-1", ok: true, result: { op: "fs_write", path: "a.txt", bytes: 3 } };
  const err = { kind: "response", request_id: "req-1", ok: false, error: { code: "DENIED", message: "blocked" } };
  assert.ok(ResponseEnvelope.safeParse(ok).success);
  assert.ok(ResponseEnvelope.safeParse(err).success);
  assert.equal(ResponseEnvelope.safeParse({ ...ok, correlation_id: "x" }).success, false, "no second correlation key");
  assert.equal(ResponseEnvelope.safeParse({ ...ok, request_id: undefined }).success, false);
  assert.equal(ResponseEnvelope.safeParse({ ...ok, error: err.error }).success, false, "not both result and error");
  assert.equal(ResponseEnvelope.safeParse({ kind: "response", request_id: "r", ok: false, error: { code: "NOPE", message: "x" } }).success, false);
  for (const frame of [ok, err]) assert.ok(ClientMessage.safeParse(frame).success);
});

test("every filesystem operation validates its arguments; mutations are distinct from reads", () => {
  const good: Record<string, object> = {
    fs_list: { op: "fs_list", path: "src", depth: 2 },
    fs_find: { op: "fs_find", pattern: "*.ts", path: "src", limit: 5 },
    fs_read: { op: "fs_read", path: "a.ts", start_line: 1, end_line: 20 },
    fs_search: { op: "fs_search", patterns: ["a", "b"], mode: "regex", case_sensitive: true, include: ["*.ts"], context_lines: 2, limit: 10 },
    fs_read_image: { op: "fs_read_image", path: "a.png" },
    fs_read_pdf: { op: "fs_read_pdf", path: "a.pdf", start_page: 2, max_pages: 3 },
    fs_write: { op: "fs_write", path: "a.txt", content: "x", encoding: "base64" },
    fs_edit: { op: "fs_edit", path: "a.txt", old_text: "a", new_text: "b", replace_all: true },
    fs_remove: { op: "fs_remove", path: "a.txt" },
  };
  for (const [name, op] of Object.entries(good)) assert.ok(Operation.safeParse(op).success, name);
  const bad: object[] = [
    { op: "fs_list", depth: 0 },
    { op: "fs_list", depth: 11 },
    { op: "fs_find", pattern: "" },
    { op: "fs_read", path: "a", start_line: 0 },
    { op: "fs_read" },
    { op: "fs_search", patterns: [] },
    { op: "fs_search", patterns: Array.from({ length: 11 }, (_, i) => `p${i}`) },
    { op: "fs_search", patterns: ["a"], mode: "glob" },
    { op: "fs_search", patterns: ["a"], context_lines: 4 },
    { op: "fs_read_pdf", path: "a.pdf", max_pages: 0 },
    { op: "fs_write", path: "a", content: 5 },
    { op: "fs_write", path: "a", content: "x", encoding: "latin1" },
    { op: "fs_edit", path: "a", old_text: "", new_text: "b" },
    { op: "fs_remove" },
    { op: "fs_read", path: "x".repeat(5000) },
  ];
  for (const op of bad) assert.equal(Operation.safeParse(op).success, false, JSON.stringify(op).slice(0, 60));
  assert.deepEqual([...MUTATING_OPERATIONS], ["fs_write", "fs_edit", "fs_remove"]);
  assert.equal(isMutation("fs_write"), true);
  assert.equal(isMutation("fs_read"), false);
  assert.equal(isMutation("git_diff"), false);
});

test("git operations are read-only and typed", () => {
  for (const op of [{ op: "git_status" }, { op: "git_diff", base: "HEAD~1", head: "HEAD", staged: false, paths: ["a"], stat: true }, { op: "git_log", rev: "main", count: 3 }, { op: "git_show", rev: "HEAD", stat: true }]) {
    assert.ok(Operation.safeParse(op).success, op.op);
  }
  assert.equal(Operation.safeParse({ op: "git_show" }).success, false, "show needs a rev");
  assert.equal(Operation.safeParse({ op: "git_log", count: 0 }).success, false);
  const names = Operation.options.map((o) => o.shape.op.value).filter((n) => n.startsWith("git_"));
  assert.deepEqual(names, ["git_status", "git_diff", "git_log", "git_show"]);
});

test("results: image bytes travel as base64 with metadata, never as a Buffer", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
  const image = { op: "fs_read_image", path: "a.png", mime_type: "image/png", bytes: 4, width: 1, height: 1, data_base64: png };
  assert.ok(OperationResult.safeParse(image).success);
  assert.equal(OperationResult.safeParse({ ...image, data_base64: "not base64!!" }).success, false);
  assert.equal(OperationResult.safeParse({ ...image, data_base64: Buffer.from([1, 2]) }).success, false);
  assert.equal(OperationResult.safeParse({ ...image, mime_type: "image/gif" }).success, false);
  assert.equal(OperationResult.safeParse({ ...image, data: png }).success, false, "no alternate field");
});

test("results: pdf pagination, read, search, list, find and git shapes validate and reject bad numbers", () => {
  const pdf = { op: "fs_read_pdf", path: "a.pdf", total_pages: 3, start_page: 1, end_page: 2, pages: [{ page: 1, text: "a", truncated: false }, { page: 2, text: "", truncated: false }], has_text: true, redactions: 0, truncated: true, next_page: 3 };
  assert.ok(OperationResult.safeParse(pdf).success);
  assert.ok(OperationResult.safeParse({ ...pdf, next_page: null, truncated: false }).success);
  for (const bad of [{ total_pages: 0 }, { next_page: 0 }, { start_page: -1 }, { pages: [{ page: 0, text: "", truncated: false }] }, { redactions: -1 }, { truncated: "yes" }]) {
    assert.equal(OperationResult.safeParse({ ...pdf, ...bad }).success, false, JSON.stringify(bad));
  }
  assert.ok(OperationResult.safeParse({ op: "fs_read", path: "a", start_line: 1, end_line: 3, total_lines: 3, truncated: false, next_start_line: null, redactions: 0, content: "1: a" }).success);
  assert.ok(OperationResult.safeParse({ op: "fs_list", path: ".", entries: [{ path: "a", type: "file", size: 1 }, { path: "d", type: "dir" }], truncated: false }).success);
  assert.equal(OperationResult.safeParse({ op: "fs_list", path: ".", entries: [{ path: "a", type: "symlink" }], truncated: false }).success, false);
  assert.ok(OperationResult.safeParse({ op: "fs_find", path: ".", pattern: "a", matches: [], truncated: false, scanned: 4 }).success);
  assert.ok(OperationResult.safeParse({ op: "fs_search", path: ".", mode: "text", summary: [{ pattern: "a", matches: 2 }], matches: [{ pattern: "a", path: "a", line: 1, text: "a" }], truncated: false, files_scanned: 1, files_skipped: { too_large: 0, binary: 0, secret_content: 0 }, stopped_by: null }).success);
  assert.ok(OperationResult.safeParse({ op: "git_status", branch: "main", clean: false, entries: [{ status: " M", path: "a" }], hidden_by_policy: 1 }).success);
  assert.ok(OperationResult.safeParse({ op: "git_log", commits: [{ hash: "a".repeat(40), author: "T", date: "2026-01-01T00:00:00Z", subject: "s" }], truncated: false }).success);
  assert.ok(OperationResult.safeParse({ op: "git_diff", output: "diff", truncated: false }).success);
  assert.ok(OperationResult.safeParse({ op: "fs_remove", path: "a", moved_to: ".lixeira/2026-11-15/a" }).success);
  assert.ok(OperationResult.safeParse({ op: "fs_edit", path: "a", bytes: 3, replacements: 1 }).success);
  assert.equal(OperationResult.safeParse({ op: "anything" }).success, false);
});

test("compact errors: stable codes, bounded message and details, no raw exception leakage", () => {
  assert.ok(WireError.safeParse({ code: "DENIED", message: "m", details: { a: "b", n: 1, f: true } }).success);
  assert.equal(WireError.safeParse({ code: "DENIED", message: "x".repeat(501) }).success, false);
  assert.equal(WireError.safeParse({ code: "DENIED", message: "m", stack: "at x" }).success, false, "no stack field");
  assert.equal(WireError.safeParse({ code: "DENIED", message: "m", details: { a: { nested: 1 } } }).success, false);
  assert.equal(WireError.safeParse({ code: "DENIED", message: "m", details: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, "v"])) }).success, false);

  assert.deepEqual(toWireError(new FsError("NOT_FOUND", "no such path: a.txt")), { code: "NOT_FOUND", message: "no such path: a.txt" });
  assert.deepEqual(toWireError(new WireFault("AUTH_FAILED", "authentication failed")), { code: "AUTH_FAILED", message: "authentication failed" });
  assert.equal(toWireError(new WireFault("INCOMPATIBLE_BUILD", "no", { client_build: "a" })).details?.client_build, "a");
  const unknown = new Error("ENOENT /home/someone/secret-path token=abc123");
  const mapped = toWireError(unknown);
  assert.deepEqual(mapped, { code: "INTERNAL", message: "internal error" });
  assert.ok(!JSON.stringify(mapped).includes("secret-path") && !JSON.stringify(mapped).includes(unknown.stack ?? "never"));
  for (const thrown of ["a string", 42, null, undefined, { code: "DENIED" }]) assert.equal(toWireError(thrown).code, "INTERNAL");
  assert.ok(WireError.safeParse(toWireError(new FsError("DENIED", "x".repeat(2000)))).success, "long messages are clipped to fit");
});

test("every FsError code is a valid wire error code", () => {
  for (const code of FS_ERROR_CODES) assert.ok(WireError.safeParse({ code, message: "m" }).success, code);
  for (const code of ["AUTH_FAILED", "DUPLICATE_CLIENT", "INCOMPATIBLE_BUILD", "BAD_REQUEST", "INTERNAL", "MUTATION_INDETERMINATE"]) assert.ok(WireError.safeParse({ code, message: "m" }).success, code);
});

test("the wire module is data only: no network, process or filesystem imports", () => {
  const dir = path.join(import.meta.dirname, "../src/wire");
  for (const file of readdirSync(dir)) {
    const text = readFileSync(path.join(dir, file), "utf8");
    assert.ok(!/node:(net|http|https|tls|dgram|child_process|fs)\b|\bws\b/.test(text), `${file} must not touch runtime I/O`);
  }
});

test("inferred types stay aligned with the schemas (checked by the typecheck)", () => {
  const sample: RequestEnvelope = { kind: "request", request_id: "r", project_id: "p", operation: { op: "fs_read", path: "a.ts", start_line: 1 } };
  const reply: ClientMessage = { kind: "response", request_id: "r", ok: false, error: { code: "DENIED", message: "m" } };
  // @ts-expect-error an operation outside the union does not type-check
  const bogus: Operation = { op: "shell_exec" };
  assert.equal(sample.operation.op, "fs_read");
  assert.equal(reply.kind, "response");
  assert.ok(bogus);
});

test("canonical helpers: one failure-response constructor and one mutation-indeterminate error", () => {
  const response = failureResponse("req-9", { code: "DENIED", message: "blocked" });
  assert.deepEqual(response, { kind: "response", request_id: "req-9", ok: false, error: { code: "DENIED", message: "blocked" } });
  assert.equal(ResponseEnvelope.safeParse(response).success, true);
  assert.deepEqual(MUTATION_INDETERMINATE_ERROR, { code: "MUTATION_INDETERMINATE", message: "mutation outcome is unknown; it is not retried" });
  assert.equal(WireError.safeParse(MUTATION_INDETERMINATE_ERROR).success, true);
});

test("rotation frames: the Server asks with a rotation_id, the Client answers with only a public key; both are strict and directional", () => {
  const ask = { kind: "rotate_key", rotation_id: "rot-1" };
  const answer = { kind: "rotated", rotation_id: "rot-1", public_key: "A".repeat(43) };
  assert.equal(ServerMessage.safeParse(ask).success, true);
  assert.equal(PostWelcomeMessage.safeParse(ask).success, true);
  assert.equal(ClientMessage.safeParse(ask).success, false, "the Client never asks");
  assert.equal(ClientMessage.safeParse(answer).success, true);
  assert.equal(ServerMessage.safeParse(answer).success, false, "the Server never answers");
  assert.equal(ClientRotated.safeParse({ ...answer, private_key: "x" }).success, false, "no extra field, so no private key can ride along");
  assert.equal(ClientRotated.safeParse({ ...answer, public_key: "short" }).success, false);
  assert.equal(ServerRotateKey.safeParse({ ...ask, public_key: answer.public_key }).success, false);
  assert.equal(SessionMessage.safeParse(answer).success, true);
  const commit = { kind: "rotate_committed", rotation_id: "rot-1" };
  assert.equal(PostWelcomeMessage.safeParse(commit).success, true, "the Server commits the staged key");
  assert.equal(ClientMessage.safeParse(commit).success, false, "the Client never commits");
  assert.equal(PostWelcomeMessage.safeParse({ ...commit, public_key: answer.public_key }).success, false);
  for (const code of ["PENDING_APPROVAL", "CLIENT_DISABLED"]) assert.equal(WireError.safeParse({ code, message: "m" }).success, true, code);
});

test("update frames: the command carries only the Server-minted id, a state is one of three, a failure has only a closed pre-handoff reason, and the hello capability is only `true`", async () => {
  const { ServerUpdate, ClientUpdateState, PreHandoffFailure, UPDATE_FAILURES } = await import("../src/wire/index.ts");
  assert.equal(ServerUpdate.safeParse({ kind: "update", update_id: "update-1" }).success, true);
  for (const bad of [{ kind: "update" }, { kind: "update", update_id: "" }, { kind: "update", update_id: "u", url: "http://x" }, { kind: "update", update_id: "u", command: "anything" }, { kind: "update", update_id: "u", build: "b" }]) assert.equal(ServerUpdate.safeParse(bad).success, false, "no URL, command or build can ride on it, and the id is required");
  for (const state of ["staging", "restarting"]) assert.equal(ClientUpdateState.safeParse({ kind: "update_state", update_id: "u", state }).success, true);
  for (const reason of PreHandoffFailure.options) assert.equal(ClientUpdateState.safeParse({ kind: "update_state", update_id: "u", state: "failed", reason }).success, true);
  assert.deepEqual(PreHandoffFailure.options, UPDATE_FAILURES.filter((r) => r !== "apply"), "`apply` is the wrapper's reason and the Client never reports it as a state");
  for (const bad of [{ kind: "update_state", state: "staging" }, { kind: "update_state", update_id: "u", state: "failed" }, { kind: "update_state", update_id: "u", state: "failed", reason: "apply" }, { kind: "update_state", update_id: "u", state: "failed", reason: "C:\\some\\path" }, { kind: "update_state", update_id: "u", state: "restarting", reason: "manifest" }, { kind: "update_state", update_id: "u", state: "applied" }, { kind: "update_state", update_id: "u", state: "done" }]) assert.equal(ClientUpdateState.safeParse(bad).success, false);
  assert.equal(SessionMessage.safeParse({ kind: "update_state", update_id: "u", state: "staging" }).success, true);
  // The first generation (Client 000061, commit a5c5b507) has no update_id: its exact grammar is a separate strict pair, never a relaxed v2 schema.
  const { LegacyServerUpdate, LegacyClientUpdateState } = await import("../src/wire/index.ts");
  assert.equal(ClientUpdateState.safeParse({ kind: "update_state", state: "staging" }).success, false, "v2 still requires update_id");
  assert.equal(LegacyServerUpdate.safeParse({ kind: "update" }).success, true);
  assert.equal(LegacyServerUpdate.safeParse({ kind: "update", update_id: "u" }).success, false, "the legacy parser is strict: the v2 command is a violation for it");
  assert.equal(LegacyClientUpdateState.safeParse({ kind: "update_state", state: "staging" }).success, true);
  assert.equal(LegacyClientUpdateState.safeParse({ kind: "update_state", update_id: "u", state: "staging" }).success, false);
  assert.equal(LegacyClientUpdateState.safeParse({ kind: "update_state", state: "failed", reason: "apply" }).success, false);
  assert.equal(PostWelcomeMessage.safeParse({ kind: "update" }).success, false, "a current Client never accepts the legacy command");
  const hello = { kind: "hello", client_id: "laptop-1", client_build: "b1", public_key: "A".repeat(43), signature: "B".repeat(86) };
  assert.equal(ClientHello.safeParse(hello).success, ClientHello.safeParse({ ...hello, update_capable: true }).success, "the field is optional, so a pre-change hello still parses");
  assert.equal(ClientHello.safeParse({ ...hello, update_capable: false }).success, false);
  assert.equal(ClientHello.safeParse({ ...hello, update_capable: true, update_protocol: 2 }).success, true, "the current protocol is announced explicitly");
  assert.equal(ClientHello.safeParse({ ...hello, update_capable: true, update_protocol: 3 }).success, false);
  assert.equal(ClientHello.safeParse({ ...hello, update_capable: true, update_protocol: 1 }).success, false, "legacy is the absence of the capability, never announced");
});

test("update apply request and receipt: one closed logical schema for Linux and Windows, applied or failed/apply only, no secret, path or timestamp", async () => {
  const { UpdateApplyRequest, UpdateApplyResult, ClientUpdateReceipt, UPDATE_APPLY_REQUEST_FILE, UPDATE_APPLY_RESULT_FILE } = await import("../src/wire/index.ts");
  const base = { schema_version: 1, update_id: "update-1", from_build: "b1", target_build: "b2", artifact_sha256: "a".repeat(64) };
  assert.equal(UpdateApplyRequest.safeParse(base).success, true);
  assert.equal(UpdateApplyRequest.safeParse({ ...base, state: "applied" }).success, false, "the request is intent only: it has no outcome");
  assert.equal(UpdateApplyResult.safeParse({ ...base, state: "applied" }).success, true);
  assert.equal(UpdateApplyResult.safeParse({ ...base, state: "failed", reason: "apply" }).success, true);
  for (const bad of [{ ...base, state: "failed" }, { ...base, state: "failed", reason: "staging" }, { ...base, state: "applied", reason: "apply" }, { ...base, state: "restarting" }, { ...base, state: "applied", at: "2026-11-24T00:00:00Z" }, { ...base, state: "applied", path: "/opt/x" }, { ...base, artifact_sha256: "A".repeat(64), state: "applied" }, { ...base, schema_version: 2, state: "applied" }]) assert.equal(UpdateApplyResult.safeParse(bad).success, false, JSON.stringify(bad));
  assert.equal(ClientUpdateReceipt.safeParse({ kind: "update_receipt", receipt: { ...base, state: "applied" } }).success, true);
  assert.equal(SessionMessage.safeParse({ kind: "update_receipt", receipt: { ...base, state: "applied" } }).success, true);
  assert.deepEqual([UPDATE_APPLY_REQUEST_FILE, UPDATE_APPLY_RESULT_FILE], ["update/apply-request.json", "update/apply-result.json"]);
});

// ---- ADR-0005: the client nonce and the Server proof are strict, fail-closed shapes ----
import { ClientHello as NonceHello, HandshakeReply as NonceReply, ServerProof, parseWire as parseNonceWire } from "../src/wire/index.ts";

const K43 = "A".repeat(43);
const S86 = "B".repeat(86);
const helloBase = { kind: "hello", client_id: "laptop", client_build: "b-1", public_key: K43, signature: S86 };

test("hello: client_nonce is a 32-byte base64url nonce; a malformed one is refused and the legacy hello without it still parses", () => {
  assert.equal(parseNonceWire(NonceHello, { ...helloBase, client_nonce: K43 }).ok, true);
  assert.equal(parseNonceWire(NonceHello, helloBase).ok, true, "the pre-change hello (an incompatible, management-only Client)");
  for (const bad of ["short", `${K43}=`, 7, null]) assert.equal(parseNonceWire(NonceHello, { ...helloBase, client_nonce: bad }).ok, false);
});

test("welcome and reject carry an optional strict proof: key, signature and bounded rotation statements, no extra field", () => {
  const proof = { server_public_key: K43, server_signature: S86 };
  const welcome = { kind: "welcome", server_build: "b-1", compatible: true };
  assert.equal(parseNonceWire(NonceReply, { ...welcome, proof }).ok, true);
  assert.equal(parseNonceWire(NonceReply, welcome).ok, true, "the proof is absent for a pre-change Client");
  assert.equal(parseNonceWire(NonceReply, { kind: "reject", error: { code: "AUTH_FAILED", message: "no" }, proof }).ok, true);
  assert.equal(parseNonceWire(ServerProof, { ...proof, server_rotations: [{ generation: 1, new_public_key: K43, signature: S86 }] }).ok, true);
  const bad = [{ ...proof, extra: 1 }, { server_public_key: K43 }, { server_signature: S86 }, { ...proof, server_public_key: "short" }, { ...proof, server_signature: "short" }, { ...proof, server_rotations: [{ generation: 0, new_public_key: K43, signature: S86 }] }, { ...proof, server_rotations: [{ generation: 1.5, new_public_key: K43, signature: S86 }] }, { ...proof, server_rotations: Array.from({ length: 33 }, (_, i) => ({ generation: i + 1, new_public_key: K43, signature: S86 })) }];
  for (const b of bad) assert.equal(parseNonceWire(ServerProof, b).ok, false, JSON.stringify(b).slice(0, 60));
  assert.equal(parseNonceWire(NonceReply, { ...welcome, proof: { server_public_key: K43 } }).ok, false, "a partial proof is no proof");
});

// ---- ADR-0005 §3: the nonce-only first answer and the Server's auth frame ----
import { ClientAuthBegin, ServerAuth } from "../src/wire/index.ts";

test("auth_begin holds only a nonce and server_auth only a proof; extra or identifying fields are refused", () => {
  assert.equal(parseNonceWire(ClientAuthBegin, { kind: "auth_begin", client_nonce: K43 }).ok, true);
  for (const bad of [{ kind: "auth_begin" }, { kind: "auth_begin", client_nonce: "short" }, { kind: "auth_begin", client_nonce: K43, client_id: "laptop" }, { kind: "auth_begin", client_nonce: K43, public_key: K43 }, { kind: "auth_begin", client_nonce: K43, signature: S86 }]) {
    assert.equal(parseNonceWire(ClientAuthBegin, bad).ok, false, JSON.stringify(bad).slice(0, 70));
  }
  const proof = { server_public_key: K43, server_signature: S86 };
  assert.equal(parseNonceWire(ServerAuth, { kind: "server_auth", proof }).ok, true);
  assert.equal(parseNonceWire(NonceReply, { kind: "server_auth", proof }).ok, true, "the Client reads it as a handshake reply");
  for (const bad of [{ kind: "server_auth" }, { kind: "server_auth", proof: { server_public_key: K43 } }, { kind: "server_auth", proof, extra: 1 }]) assert.equal(parseNonceWire(ServerAuth, bad).ok, false);
});
