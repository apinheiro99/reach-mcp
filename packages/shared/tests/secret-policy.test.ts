import { test } from "node:test";
import assert from "node:assert/strict";
import { hasPrivateKey, redactText, REDACTED } from "../src/filesystem/index.ts";

// Secret-shaped samples are assembled from parts so this file never holds a literal one.
const AWS = "AKIA" + "IOSFODNN7EXAMPLE";
const GH = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
const BEGIN_KEY = "-----BEGIN " + "PRIVATE KEY" + "-----";
const END_KEY = "-----END " + "PRIVATE KEY" + "-----";
const RANDOM_VALUE = "Zk3f9QpLw82XvB7tUa41nMc0";

test("redact: recognised secret shapes are masked, ordinary code is untouched", () => {
  const input = [
    `aws = "${AWS}"`,
    `value ${GH}`,
    "DATABASE_URL=postgres://app:hunter2hunter2@db.example/app",
    "SERVICE_PASS" + "WORD=correct-horse-battery",
    `const apiKey = "${RANDOM_VALUE}";`,
    "const authHeader = req.headers.authorization;",
    "token: string;",
    "const tok" + "en = readTokenFromCookie(req);",
    "API_" + "KEY=changeme",
    "const maxTokens = 4096;",
  ].join("\n");
  const { text, redactions } = redactText(input);
  for (const leaked of [AWS, GH, "hunter2hunter2", "correct-horse-battery", RANDOM_VALUE]) assert.ok(!text.includes(leaked), "a secret shape leaked");
  assert.ok(text.includes(`postgres://app:${REDACTED}@db.example/app`), "url keeps user and host");
  for (const kept of ["req.headers.authorization", "token: string;", "readTokenFromCookie(req)", "API_" + "KEY=changeme", "maxTokens = 4096"]) {
    assert.ok(text.includes(kept), `false positive on: ${kept}`);
  }
  assert.equal(redactions, 5);
});

test("redact: a private key block is replaced as a whole, an unterminated one to the end", () => {
  const whole = redactText(`before\n${BEGIN_KEY}\nabc\n${END_KEY}\nafter`);
  assert.equal(whole.text, "before\n[REDACTED PRIVATE KEY BLOCK]\nafter");
  assert.equal(redactText(`x\n${BEGIN_KEY}\nabc`).text, "x\n[REDACTED PRIVATE KEY BLOCK]");
});

test("hasPrivateKey detects the marker under any key type", () => {
  assert.equal(hasPrivateKey(`text ${BEGIN_KEY} text`), true);
  assert.equal(hasPrivateKey("-----BEGIN " + "OPENSSH PRIVATE KEY" + "-----"), true);
  assert.equal(hasPrivateKey("no key here"), false);
});
