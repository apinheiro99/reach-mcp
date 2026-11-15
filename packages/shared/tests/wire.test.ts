// The shared wire contract: strict frames, correlation, typed operations and results, compact errors and the build gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { FsError } from "../src/filesystem/index.ts";
import {
  BuildCompatibility,
  ClientHello,
  ClientMessage,
  FS_ERROR_CODES,
  HandshakeReply,
  incompatibleBuildError,
  isMutation,
  MUTATING_OPERATIONS,
  Operation,
  OperationResult,
  parseWire,
  RequestEnvelope,
  ResponseEnvelope,
  ServerMessage,
  toWireError,
  WireError,
  WireFault,
} from "../src/wire/index.ts";

// Opaque marker standing in for a credential; not shaped like any real secret.
const CRED = "cred-marker-" + "Qz81mVx";
const hello = { kind: "hello", client_id: "laptop-1", credential: CRED, client_build: "build-2026.11.0001" };
const request = (operation: unknown, extra: object = {}) => ({ kind: "request", request_id: "req-1", project_id: "proj-a", operation, ...extra });

test("handshake: a valid hello parses; empty identity, build or credential, and unknown keys are rejected", () => {
  assert.ok(parseWire(ClientHello, hello).ok);
  for (const field of ["client_id", "credential", "client_build"]) {
    for (const bad of ["", "x".repeat(2000), "a\nb", "a\u0000b", 42, undefined]) {
      assert.equal(ClientHello.safeParse({ ...hello, [field]: bad }).success, false, `${field}=${JSON.stringify(bad)?.slice(0, 20)}`);
    }
  }
  assert.equal(ClientHello.safeParse({ ...hello, extra: 1 }).success, false);
  assert.equal(ClientHello.safeParse({ ...hello, kind: "request" }).success, false);
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

test("a credential is never echoed: validation errors name paths and codes only", () => {
  for (const bad of [{ ...hello, extra: CRED }, { ...hello, credential: CRED + "\n" }, { ...hello, client_id: "" }, { ...hello, credential: CRED.repeat(100) }]) {
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
  assert.equal(RequestEnvelope.safeParse(request({ op: "fs_list" }, { credential: CRED })).success, false, "no credential after the handshake");
  assert.equal(RequestEnvelope.safeParse(request({ op: "fs_list" }, { conversation_id: "c" })).success, false, "no conversation identity");
  assert.equal(RequestEnvelope.safeParse(request({ op: "fs_list", unknown: 1 })).success, false, "strict operation objects");
  assert.equal(RequestEnvelope.safeParse(request({ op: "git_commit" })).success, false, "no mutating Git operation exists");
  assert.equal(ClientMessage.safeParse(hello).success, true);
  assert.equal(ClientMessage.safeParse(request({ op: "fs_list" })).success, true);
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
  for (const frame of [ok, err, { kind: "welcome", server_build: "b", compatible: true }]) assert.ok(ServerMessage.safeParse(frame).success);
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
  for (const code of ["AUTH_FAILED", "DUPLICATE_CLIENT", "INCOMPATIBLE_BUILD", "BAD_REQUEST", "INTERNAL"]) assert.ok(WireError.safeParse({ code, message: "m" }).success, code);
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
  const reply: ServerMessage = { kind: "response", request_id: "r", ok: false, error: { code: "DENIED", message: "m" } };
  // @ts-expect-error an operation outside the union does not type-check
  const bogus: Operation = { op: "shell_exec" };
  assert.equal(sample.operation.op, "fs_read");
  assert.equal(reply.kind, "response");
  assert.ok(bogus);
});
