import { test } from "node:test";
import assert from "node:assert/strict";
import { generateIdentityKey, machineUuid, importPrivateKey, newNonce, publicKeyFingerprint, publicKeyFromPrivate, signChallenge, verifyChallenge } from "../src/identity.ts";

test("a generated key pair round-trips: the private key re-imports and derives the same public key; keys are canonical base64url", () => {
  const { privateKey, publicKey } = generateIdentityKey();
  assert.match(publicKey, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(publicKeyFromPrivate(importPrivateKey(privateKey)), publicKey);
  assert.notEqual(generateIdentityKey().publicKey, publicKey);
});

test("a signature is valid only for its own challenge, client_id and key; malformed inputs fail closed without throwing", () => {
  const a = generateIdentityKey();
  const b = generateIdentityKey();
  const nonce = newNonce();
  const sig = signChallenge(importPrivateKey(a.privateKey), nonce, "laptop");
  assert.equal(verifyChallenge(a.publicKey, nonce, "laptop", sig), true);
  assert.equal(verifyChallenge(a.publicKey, newNonce(), "laptop", sig), false, "another connection's challenge");
  assert.equal(verifyChallenge(a.publicKey, nonce, "desktop", sig), false, "another client_id");
  assert.equal(verifyChallenge(b.publicKey, nonce, "laptop", sig), false, "another key");
  for (const bad of ["", "A".repeat(86), sig.slice(1), sig + "A", "!!!"]) assert.equal(verifyChallenge(a.publicKey, nonce, "laptop", bad), false);
  for (const bad of ["", "short", a.publicKey + "A", "A".repeat(43)]) assert.equal(verifyChallenge(bad, nonce, "laptop", sig), false);
});

test("nonces are 32 random bytes and never repeat; a bad private key errors with a fixed message that never echoes it", () => {
  assert.equal(new Set(Array.from({ length: 50 }, newNonce)).size, 50);
  const leak = "leak-marker-" + "Zq41";
  assert.throws(() => importPrivateKey(leak), (e: unknown) => e instanceof Error && e.message === "invalid Ed25519 private key" && !e.message.includes(leak));
  assert.throws(() => importPrivateKey("A".repeat(64)), /invalid Ed25519 private key/);
});

test("the fingerprint is a canonical, non-secret digest of the public key only", () => {
  const a = generateIdentityKey();
  const b = generateIdentityKey();
  assert.match(publicKeyFingerprint(a.publicKey), /^ed25519:[0-9a-f]{64}$/);
  assert.equal(publicKeyFingerprint(a.publicKey), publicKeyFingerprint(a.publicKey), "stable");
  assert.notEqual(publicKeyFingerprint(a.publicKey), publicKeyFingerprint(b.publicKey));
  assert.ok(!publicKeyFingerprint(a.publicKey).includes(a.publicKey) && !publicKeyFingerprint(a.publicKey).includes(a.privateKey));
});

test("machineUuid: deterministic, 8-4-4-4-12, equal across native id spellings, different for another machine, and it rejects non-ids", () => {
  const linux = "0123456789abcdef0123456789abcdef";
  const id = machineUuid(linux);
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(id, "3eb1bd43-9947-eb76-2998-e566ccc2e099", "published test vector of the application-neutral algorithm: SHA-256 of the canonical 32 ASCII hex digits, first 16 bytes");
  assert.equal(machineUuid(linux), id);
  assert.equal(machineUuid(`${linux.toUpperCase()}\n`), id, "case and trailing newline do not fork the identity");
  assert.equal(machineUuid("01234567-89AB-CDEF-0123-456789ABCDEF"), id, "a Windows SMBIOS spelling of the same bytes");
  assert.equal(machineUuid("{01234567-89ab-cdef-0123-456789abcdef}"), id);
  assert.notEqual(machineUuid("fedcba9876543210fedcba9876543210"), id);
  assert.ok(!id.replaceAll("-", "").includes(linux.slice(0, 8)), "the native id is not echoed");
  for (const bad of ["", "abc", "z".repeat(32), "0".repeat(31)]) assert.throws(() => machineUuid(bad), /32 hexadecimal digits/);
});

// ---- Server trust chain (ADR-0005): domain-separated signatures, one deterministic byte layout each ----
import { followTrustRotations, layout, signClientAuth, signReleaseEnvelope, signServerAuth, signTrustRotation, verifyClientAuth, verifyReleaseEnvelope, verifyServerAuth } from "../src/identity.ts";

const pair = () => {
  const g = generateIdentityKey();
  return { ...g, key: importPrivateKey(g.privateKey) };
};
const N1 = "a".repeat(43);
const N2 = "b".repeat(43);

test("the canonical layout is length-prefixed fields, label first, so no two field splits can collide", () => {
  assert.equal(layout("L", ["ab", "c"]).toString("hex"), "00000001" + "4c" + "00000002" + "6162" + "00000001" + "63", "label then each field as 4-byte big-endian length and bytes");
  assert.notDeepEqual(layout("L", ["ab", "c"]), layout("L", ["a", "bc"]));
  assert.equal(layout("L", [Buffer.from([1, 2])]).toString("hex"), "000000014c" + "000000020102");
});

test("server auth: valid only for its own outcome, both nonces, key and protocol; every change fails closed", () => {
  const s = pair();
  const sig = signServerAuth(s.key, "welcome", N1, N2);
  assert.equal(verifyServerAuth(s.publicKey, "welcome", N1, N2, sig), true);
  assert.equal(verifyServerAuth(s.publicKey, "reject:AUTH_FAILED", N1, N2, sig), false, "another outcome");
  assert.equal(verifyServerAuth(s.publicKey, "welcome", N2, N1, sig), false, "swapped nonces");
  assert.equal(verifyServerAuth(s.publicKey, "welcome", "c".repeat(43), N2, sig), false, "another client nonce (replay on another connection)");
  assert.equal(verifyServerAuth(pair().publicKey, "welcome", N1, N2, sig), false, "another key");
  assert.equal(verifyServerAuth(s.publicKey, "welcome", N1, N2, "x"), false);
  assert.equal(verifyServerAuth("not-a-key", "welcome", N1, N2, sig), false);
});

test("labels separate purposes: a server-auth, client-auth, envelope or rotation signature is never valid as another", () => {
  const s = pair();
  const manifest = Buffer.from("{}");
  const server = signServerAuth(s.key, "welcome", N1, N2);
  const client = signClientAuth(s.key, N1, N2, "laptop");
  const envelope = signReleaseEnvelope(s.key, 1, manifest);
  assert.equal(verifyClientAuth(s.publicKey, N1, N2, "laptop", client), true);
  assert.equal(verifyClientAuth(s.publicKey, N1, N2, "laptop", server), false);
  assert.equal(verifyClientAuth(s.publicKey, N2, N1, "laptop", client), false, "nonce order is part of the layout");
  assert.equal(verifyClientAuth(s.publicKey, N1, N2, "desktop", client), false, "bound to the client_id");
  assert.equal(verifyReleaseEnvelope(s.publicKey, 1, manifest, envelope), true);
  assert.equal(verifyReleaseEnvelope(s.publicKey, 1, manifest, server), false);
  assert.equal(verifyReleaseEnvelope(s.publicKey, 1, manifest, client), false);
});

test("release envelope: the signature covers the epoch and the EXACT manifest bytes", () => {
  const s = pair();
  const bytes = Buffer.from('{"schema_version":2}\n');
  const sig = signReleaseEnvelope(s.key, 7, bytes);
  assert.equal(verifyReleaseEnvelope(s.publicKey, 7, bytes, sig), true);
  assert.equal(verifyReleaseEnvelope(s.publicKey, 8, bytes, sig), false, "another epoch");
  assert.equal(verifyReleaseEnvelope(s.publicKey, 7, Buffer.from('{"schema_version":2}'), sig), false, "one byte less");
  assert.equal(verifyReleaseEnvelope(s.publicKey, 7, Buffer.from('{ "schema_version": 2 }\n'), sig), false, "a re-serialization is another message");
  assert.equal(verifyReleaseEnvelope(s.publicKey, 0, bytes, sig), false, "epoch 0 never verifies and never throws");
  assert.equal(verifyReleaseEnvelope(pair().publicKey, 7, bytes, sig), false);
});

test("rotation: a chain from the pin, signed key by key with the next generation, is followed; anything else is refused", () => {
  const a = pair();
  const b = pair();
  const c = pair();
  const ab = signTrustRotation(a.key, 1, b.publicKey);
  const bc = signTrustRotation(b.key, 2, c.publicKey);
  assert.deepEqual(followTrustRotations(a.publicKey, 0, a.publicKey, []), { key: a.publicKey, generation: 0 }, "the pinned key itself");
  assert.deepEqual(followTrustRotations(a.publicKey, 0, b.publicKey, [ab]), { key: b.publicKey, generation: 1 });
  assert.deepEqual(followTrustRotations(a.publicKey, 0, c.publicKey, [bc, ab]), { key: c.publicKey, generation: 2 }, "statements are followed in generation order whatever the order given");
  assert.deepEqual(followTrustRotations(b.publicKey, 1, c.publicKey, [ab, bc]), { key: c.publicKey, generation: 2 }, "already-applied generations are skipped");
  assert.equal(followTrustRotations(a.publicKey, 0, c.publicKey, [bc]), null, "a gap in the chain");
  assert.equal(followTrustRotations(a.publicKey, 0, b.publicKey, []), null, "no statement at all");
  const forged = signTrustRotation(pair().key, 1, b.publicKey);
  assert.equal(followTrustRotations(a.publicKey, 0, b.publicKey, [forged]), null, "a statement not signed by the pinned key");
  assert.equal(followTrustRotations(b.publicKey, 1, a.publicKey, [{ ...ab, generation: 1 }]), null, "the same or a lower generation never moves the pin");
  assert.equal(followTrustRotations(a.publicKey, 0, c.publicKey, [ab]), null, "the chain must END at the presented key");
});
