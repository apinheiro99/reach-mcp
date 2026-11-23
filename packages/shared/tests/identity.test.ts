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
  assert.equal(machineUuid(linux), id);
  assert.equal(machineUuid(`${linux.toUpperCase()}\n`), id, "case and trailing newline do not fork the identity");
  assert.equal(machineUuid("01234567-89AB-CDEF-0123-456789ABCDEF"), id, "a Windows SMBIOS spelling of the same bytes");
  assert.equal(machineUuid("{01234567-89ab-cdef-0123-456789abcdef}"), id);
  assert.notEqual(machineUuid("fedcba9876543210fedcba9876543210"), id);
  assert.ok(!id.replaceAll("-", "").includes(linux.slice(0, 8)), "the native id is not echoed");
  for (const bad of ["", "abc", "z".repeat(32), "0".repeat(31)]) assert.throws(() => machineUuid(bad), /32 hexadecimal digits/);
});
