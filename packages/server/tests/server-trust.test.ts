// The Server trust key (ADR-0005): one persistent key and epoch owner, the signed handshake proof on welcome and reject, the signed release
// envelope and the public trust-key route, and the downgrade guard. The private key never appears in anything observable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { followTrustRotations, newNonce, signClientAuth, verifyReleaseEnvelope, verifyServerAuth } from "@reach-mcp/shared/identity";
import { ClientConnectionRegistry, createReleaseHandler, hashCredential, ServerConfigStore, ServerTrustStore, type ArtifactSource } from "../src/index.ts";
import { MAX_RETAINED_ROTATIONS, ServerTrustError } from "../src/server-trust.ts";
import { parseServerArgs, startServer } from "../src/runtime.ts";
import { IDLE, LAPTOP, signedHello } from "./identity-fixture.ts";

const tmp = () => mkdtempSync(path.join(tmpdir(), "reach-trust-"));
const MANIFEST = Buffer.from('{"schema_version":2,"release":{"build_id":"b-1"}}\n');
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

test("the store creates one key once, keeps it across restarts, and the file is private", () => {
  const file = path.join(tmp(), "nested", "server-trust.json");
  const first = new ServerTrustStore(file);
  const key = first.publicKey();
  assert.match(key, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(statSync(file).mode & 0o077, 0, "mode 0600");
  assert.equal(new ServerTrustStore(file).publicKey(), key, "a restart does not regenerate the key");
});

test("a state file that exists but cannot be read is an error, never a reason to generate a new key", () => {
  const file = path.join(tmp(), "server-trust.json");
  const original = new ServerTrustStore(file);
  const text = readFileSync(file, "utf8");
  for (const bad of ["not json", "{}", JSON.stringify({ ...JSON.parse(text), release_epoch: -1 }), JSON.stringify({ ...JSON.parse(text), signing_key: "x" }), JSON.stringify({ ...JSON.parse(text), release_digest: "zz" })]) {
    writeFileSync(file, bad);
    assert.throws(() => new ServerTrustStore(file), ServerTrustError);
    assert.equal(readFileSync(file, "utf8"), bad, "the broken file is left exactly as it was");
  }
  writeFileSync(file, text);
  assert.equal(new ServerTrustStore(file).publicKey(), original.publicKey());
});

test("release epoch: the same bytes keep the epoch (repeated serving and restarts), changed bytes advance it, older bytes served again get a greater one", () => {
  const file = path.join(tmp(), "server-trust.json");
  const store = new ServerTrustStore(file);
  const a = store.envelope(MANIFEST);
  assert.equal(a.release_epoch, 1);
  assert.equal(store.envelope(MANIFEST).release_epoch, 1, "serving it again is not a new release");
  assert.equal(new ServerTrustStore(file).envelope(MANIFEST).release_epoch, 1, "a restart does not advance it");
  const other = Buffer.from('{"schema_version":2,"release":{"build_id":"b-2"}}\n');
  assert.equal(store.envelope(other).release_epoch, 2);
  const rollback = new ServerTrustStore(file).envelope(MANIFEST);
  assert.equal(rollback.release_epoch, 3, "an intentional rollback to older bytes is new metadata with a greater epoch, never a decrement");
  assert.equal(rollback.manifest, MANIFEST.toString("base64url"), "the manifest bytes inside are the ones given, untouched");
});

test("the envelope signature covers the epoch and the exact bytes and verifies with the public key only", () => {
  const store = new ServerTrustStore(path.join(tmp(), "server-trust.json"));
  const env = store.envelope(MANIFEST);
  const bytes = Buffer.from(env.manifest, "base64url");
  assert.deepEqual(bytes, MANIFEST);
  assert.equal(verifyReleaseEnvelope(store.publicKey(), env.release_epoch, bytes, env.signature), true);
  assert.equal(verifyReleaseEnvelope(store.publicKey(), env.release_epoch + 1, bytes, env.signature), false);
  assert.equal(verifyReleaseEnvelope(store.publicKey(), env.release_epoch, Buffer.from(`${MANIFEST}\n`), env.signature), false);
});

test("rotation: the old key signs the new one, the chain is retained and followed by a Client that pinned the first key, and it survives a restart", () => {
  const file = path.join(tmp(), "server-trust.json");
  const store = new ServerTrustStore(file);
  const first = store.publicKey();
  store.rotate();
  store.rotate();
  const reloaded = new ServerTrustStore(file);
  assert.notEqual(reloaded.publicKey(), first);
  const proof = reloaded.proof("welcome", newNonce(), newNonce());
  assert.equal(proof.server_rotations?.length, 2);
  assert.deepEqual(followTrustRotations(first, 0, proof.server_public_key, proof.server_rotations ?? []), { key: proof.server_public_key, generation: 2 });
  assert.equal(followTrustRotations(first, 0, proof.server_public_key, (proof.server_rotations ?? []).slice(1)), null, "a missing statement breaks the chain");
  for (let i = 0; i < MAX_RETAINED_ROTATIONS + 3; i++) reloaded.rotate();
  assert.equal(reloaded.proof("welcome", newNonce(), newNonce()).server_rotations?.length, MAX_RETAINED_ROTATIONS, "only the most recent statements are retained");
});

test("nothing observable carries the private key: proofs, envelopes and the public route never include it", () => {
  const file = path.join(tmp(), "server-trust.json");
  const store = new ServerTrustStore(file);
  const kept = JSON.parse(readFileSync(file, "utf8")) as { signing_key: string };
  const hidden = kept.signing_key;
  const observable = JSON.stringify([store.proof("welcome", newNonce(), newNonce()), store.envelope(MANIFEST), store.publicKey(), String(store), Object.keys(store)]);
  assert.ok(!observable.includes(hidden));
});

/** An artifact source holding only a manifest. */
const source = (manifest: Buffer | null): ArtifactSource => ({ manifest: () => manifest, artifact: () => null });
async function serveRelease(handler: ReturnType<typeof createReleaseHandler>) {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))) };
}

test("release routes: the envelope wraps the exact manifest bytes, the manifest route is unchanged, the trust key is public, and without a trust key or manifest there is no envelope", async () => {
  const trust = new ServerTrustStore(path.join(tmp(), "server-trust.json"));
  const s = await serveRelease(createReleaseHandler({ artifacts: source(MANIFEST), trust }));
  try {
    const plain = Buffer.from(await (await fetch(`${s.base}/release/manifest`)).arrayBuffer());
    assert.deepEqual(plain, MANIFEST, "installers and pre-change Clients still read the exact bytes");
    const env = (await (await fetch(`${s.base}/release/envelope`)).json()) as { release_epoch: number; manifest: string; signature: string };
    assert.deepEqual(Object.keys(env).sort(), ["manifest", "release_epoch", "signature"]);
    assert.deepEqual(Buffer.from(env.manifest, "base64url"), MANIFEST);
    assert.equal(verifyReleaseEnvelope(trust.publicKey(), env.release_epoch, MANIFEST, env.signature), true);
    assert.equal(((await (await fetch(`${s.base}/release/trust-key`)).json()) as { public_key: string }).public_key, trust.publicKey());
    assert.equal((await fetch(`${s.base}/release/envelope`, { method: "POST" })).status, 405);
  } finally {
    await s.close();
  }
  for (const [name, deps] of [["no trust key", { artifacts: source(MANIFEST) }], ["no manifest", { artifacts: source(null), trust }], ["no artifacts", { trust }]] as const) {
    const r = await serveRelease(createReleaseHandler(deps));
    try {
      assert.equal((await fetch(`${r.base}/release/envelope`)).status, 404, `${name}: envelope`);
    } finally {
      await r.close();
    }
  }
});

// ---- the handshake (ADR-0005 §3: challenge, then the Client's nonce only, then the Server proof, then the hello) ----
type Frame = { kind: string; nonce?: string; compatible?: boolean; error?: { code: string }; proof?: { server_public_key: string; server_signature: string } };
async function handshake(options: { trust: boolean; status?: "enabled" | "disabled" }) {
  const dir = tmp();
  const file = path.join(dir, "config.json");
  writeFileSync(file, JSON.stringify({ mcp_bearer_sha256: hashCredential("mcp-marker-" + "Kd40"), clients: [{ client_id: "laptop", enabled: options.status !== "disabled", public_key: LAPTOP.publicKey, projects: [{ project_id: "web", physical_root: "/srv/web", mode: "read_write" }] }] }));
  const config = new ServerConfigStore(file);
  config.loadInitial();
  const trust = new ServerTrustStore(path.join(dir, "server-trust.json"));
  const registry = new ClientConnectionRegistry({ config, serverBuild: "srv-1", isBuildCompatible: (b) => b.startsWith("ok-"), ...(options.trust ? { trust } : {}) });
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  wss.on("connection", (socket, req) => registry.accept(socket, req.socket.remoteAddress));
  await new Promise<void>((r) => wss.once("listening", () => r()));
  const url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
  const sockets: WebSocket[] = [];
  /**
   * Plays a Client: `steps(challenge)` returns the frames to send after the challenge, each either immediately or after the Server's next frame ("after_auth").
   * Resolves with every frame the Server sent once it admitted, refused or closed.
   */
  const connect = async (steps: (challenge: string) => { first: object; afterAuth?: object }) => {
    const ws = new WebSocket(url);
    sockets.push(ws);
    const frames: Frame[] = [];
    ws.on("error", () => undefined);
    let plan: ReturnType<typeof steps> | null = null;
    ws.on("message", (d) => {
      const f = JSON.parse(d.toString()) as Frame;
      frames.push(f);
      if (f.kind === "challenge") {
        plan = steps(f.nonce!);
        ws.send(JSON.stringify(plan.first));
      } else if (f.kind === "server_auth" && plan?.afterAuth) ws.send(JSON.stringify(plan.afterAuth));
    });
    // An admitted session stays open, so the answer is complete once a welcome or reject arrived (and the policy that follows a welcome had a moment to), or the socket closed.
    await new Promise<void>((resolve) => {
      ws.once("close", () => resolve());
      ws.on("message", (d) => (/"kind":"(welcome|reject)"/.test(d.toString()) ? setTimeout(resolve, 40) : undefined));
      setTimeout(resolve, 400);
    });
    return frames;
  };
  const stop = async () => {
    for (const ws of sockets) ws.terminate();
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>((r) => wss.close(() => r()));
  };
  return { connect, trust, stop };
}
/** A current Client's hello: its own nonce, and the signature over both nonces. */
const mutualHello = (nonce: string, clientNonce: string, extra: Record<string, unknown> = {}) => ({ ...signedHello(LAPTOP, "laptop", nonce, { client_build: "ok-1", client_nonce: clientNonce, ...extra }), signature: signClientAuth(LAPTOP.key, nonce, clientNonce, "laptop") });
const begin = (clientNonce: string) => ({ kind: "auth_begin", client_nonce: clientNonce });
/** The ordinary current flow: nonce only, then (after the Server proof) the hello. */
const current = (clientNonce: string, extra: Record<string, unknown> = {}) => (challenge: string) => ({ first: begin(clientNonce), afterAuth: mutualHello(challenge, clientNonce, extra) });

test("handshake: the Server proves itself over the Client's nonce BEFORE it learns who the Client is, and the admitted welcome carries a second, separate proof", async () => {
  const h = await handshake({ trust: true });
  try {
    const clientNonce = newNonce();
    let challenge = "";
    const frames = await h.connect((n) => ((challenge = n), current(clientNonce)(n)));
    assert.deepEqual(frames.map((f) => f.kind).slice(0, 3), ["challenge", "server_auth", "welcome"], "the order on the wire");
    const auth = frames.find((f) => f.kind === "server_auth")!;
    const welcome = frames.find((f) => f.kind === "welcome")!;
    assert.equal(auth.proof!.server_public_key, h.trust.publicKey());
    assert.equal(verifyServerAuth(auth.proof!.server_public_key, "auth", clientNonce, challenge, auth.proof!.server_signature), true);
    assert.equal(verifyServerAuth(auth.proof!.server_public_key, "welcome", clientNonce, challenge, auth.proof!.server_signature), false, "the auth signature is not a welcome");
    assert.equal(verifyServerAuth(welcome.proof!.server_public_key, "welcome", clientNonce, challenge, welcome.proof!.server_signature), true);
    assert.equal(verifyServerAuth(auth.proof!.server_public_key, "auth", newNonce(), challenge, auth.proof!.server_signature), false, "not valid for another client nonce");
  } finally {
    await h.stop();
  }
});

test("handshake: the Server answers a nonce-only frame with a proof and admits nobody on it", async () => {
  const h = await handshake({ trust: true });
  try {
    const frames = await h.connect(() => ({ first: begin(newNonce()) }));
    assert.deepEqual(frames.map((f) => f.kind), ["challenge", "server_auth"], "no welcome, no reject, no session: the Client has not identified itself");
  } finally {
    await h.stop();
  }
});

test("handshake: a refusal after the hello is signed too, as its own outcome", async () => {
  const h = await handshake({ trust: true, status: "disabled" });
  try {
    const clientNonce = newNonce();
    let challenge = "";
    const frames = await h.connect((n) => ((challenge = n), current(clientNonce)(n)));
    const reject = frames.find((f) => f.kind === "reject")!;
    assert.equal(reject.error?.code, "CLIENT_DISABLED");
    assert.equal(verifyServerAuth(reject.proof!.server_public_key, "reject:CLIENT_DISABLED", clientNonce, challenge, reject.proof!.server_signature), true);
  } finally {
    await h.stop();
  }
});

test("handshake: phase skipping and nonce swapping are refused: a hello without the nonce-only phase, with another nonce, or in the legacy form after it", async () => {
  const h = await handshake({ trust: true });
  try {
    const cases: [string, (challenge: string) => { first: object; afterAuth?: object }][] = [
      ["a current hello with no auth_begin before it", (n) => ({ first: mutualHello(n, newNonce()) })],
      ["a hello carrying another nonce than the one begun", (n) => ({ first: begin(newNonce()), afterAuth: mutualHello(n, newNonce()) })],
      ["the legacy hello (no nonce) after a begun handshake", (n) => ({ first: begin(newNonce()), afterAuth: signedHello(LAPTOP, "laptop", n, { client_build: "ok-1" }) })],
      ["a hello whose signature does not cover both nonces", (n) => { const cn = newNonce(); return { first: begin(cn), afterAuth: { ...mutualHello(n, cn), signature: signedHello(LAPTOP, "laptop", n).signature } }; }],
    ];
    for (const [name, plan] of cases) {
      const frames = await h.connect(plan);
      assert.equal(frames.find((f) => f.kind === "reject")?.error?.code, "AUTH_FAILED", name);
      assert.equal(frames.some((f) => f.kind === "welcome"), false, `${name}: never admitted`);
    }
  } finally {
    await h.stop();
  }
});

test("handshake: a second auth_begin, or one to a Server with no trust key, is refused without a proof", async () => {
  const h = await handshake({ trust: true });
  const bare = await handshake({ trust: false });
  try {
    const twice = await h.connect(() => ({ first: begin(newNonce()), afterAuth: begin(newNonce()) }));
    assert.equal(twice.filter((f) => f.kind === "server_auth").length, 1);
    assert.equal(twice.find((f) => f.kind === "reject")?.error?.code, "BAD_REQUEST");
    const noTrust = await bare.connect(() => ({ first: begin(newNonce()) }));
    assert.equal(noTrust.some((f) => f.kind === "server_auth"), false, "a Server that cannot prove itself never pretends to");
    assert.equal(noTrust.find((f) => f.kind === "reject")?.proof, undefined);
  } finally {
    await h.stop();
    await bare.stop();
  }
});

test("handshake: downgrade guard: a compatible Client that skips the new flow (legacy hello) is refused when the Server has a trust key", async () => {
  const h = await handshake({ trust: true });
  try {
    const frames = await h.connect((n) => ({ first: signedHello(LAPTOP, "laptop", n, { client_build: "ok-1" }) }));
    assert.equal(frames.find((f) => f.kind === "reject")?.error?.code, "AUTH_FAILED");
    assert.equal(frames.some((f) => f.kind === "welcome"), false);
  } finally {
    await h.stop();
  }
});

test("handshake: a pre-change Client (legacy hello, incompatible build, known and Enabled) still gets the management-only welcome it can parse: no proof, no policy", async () => {
  const h = await handshake({ trust: true });
  try {
    const frames = await h.connect((n) => ({ first: signedHello(LAPTOP, "laptop", n, { client_build: "old-9" }) }));
    const welcome = frames.find((f) => f.kind === "welcome");
    assert.ok(welcome, "it is admitted so it can be updated");
    assert.equal(welcome.proof, undefined, "a pre-change Client's strict schema would refuse an added field");
    assert.equal(frames.some((f) => f.kind === "policy_sync" || f.kind === "server_auth"), false);
  } finally {
    await h.stop();
  }
});

test("handshake: without a trust key (setup, tests) no proof is sent and the one-way handshake is unchanged", async () => {
  const h = await handshake({ trust: false });
  try {
    const frames = await h.connect((n) => ({ first: signedHello(LAPTOP, "laptop", n, { client_build: "ok-1" }) }));
    assert.equal(frames.find((f) => f.kind === "welcome")?.proof, undefined);
  } finally {
    await h.stop();
  }
});

test("runtime: the Server creates its trust key next to its config on first start and serves the same key after a restart", async () => {
  const base = tmp();
  const argv = ["--config", path.join(base, "private", "config.json"), "--proposal", path.join(base, "private", "proposal.json"), "--logs", path.join(base, "logs"), "--port", "0", "--admin-port", "0", "--build", "dev-1"];
  const keyOf = async () => {
    const server = await startServer(parseServerArgs(argv));
    try {
      return ((await (await fetch(`http://127.0.0.1:${server.port}/release/trust-key`)).json()) as { public_key: string }).public_key;
    } finally {
      await server.stop();
    }
  };
  const first = await keyOf();
  assert.equal(statSync(path.join(base, "private", "server-trust.json")).mode & 0o077, 0);
  assert.equal(await keyOf(), first, "the same key after a restart");
  void [IDLE, sha];
});
