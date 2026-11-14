import assert from "node:assert/strict";
import { test } from "node:test";
import { scanFiles, scanText } from "../scripts/public-surface.mjs";

const fake = (prefix, body) => prefix + body; // assembled at runtime: no secret-shaped literal in source

test("detects a private key block without echoing it", () => {
  const hits = scanText(fake("-----BEGIN RSA PRIV", "ATE KEY-----"));
  assert.deepEqual(hits, [{ line: 1, category: "private-key-block" }]);
});

test("detects a real-looking secret assignment", () => {
  const hits = scanText(fake("REACH_CLIENT_SECRET=", "a1b2c3d4e5f6a7b8"));
  assert.equal(hits[0].category, "secret-assignment");
});

test("detects private network and hostnames", () => {
  assert.equal(scanText(fake("host 192.168.", "1.10"))[0].category, "private-network-address");
  assert.equal(scanText(fake("nfs truenas", ".lab"))[0].category, "private-hostname");
});

test("accepts documented placeholders", () => {
  const placeholders = ["REACH_CLIENT_SECRET=", "REACH_SERVER_URL=", "REACH_SERVER_PORT=0", "REACH_ROLE=server"].join("\n");
  assert.deepEqual(scanText(placeholders), []);
});

test("flags forbidden paths but allows .env.example", () => {
  const read = () => "";
  assert.equal(scanFiles([".env"], read)[0].category, "forbidden-path");
  assert.equal(scanFiles(["server.pem"], read)[0].category, "forbidden-path");
  assert.deepEqual(scanFiles([".env.example"], read), []);
});

test("detects a quoted JSON secret key and accepts its empty placeholder", () => {
  const hit = scanText(fake('"REACH_CLIENT_SECRET": "', 'a1b2c3d4e5f6a7b8"'));
  assert.equal(hit[0].category, "secret-assignment");
  assert.deepEqual(scanText('"REACH_CLIENT_SECRET": ""'), []);
});

test("scans package-lock.json like any other tracked file", () => {
  const lock = fake('{"resolved": "https://registry.example/x", "note": "host truenas', '.lab"}');
  const findings = scanFiles(["package-lock.json"], () => lock);
  assert.equal(findings[0].category, "private-hostname");
  assert.equal(findings[0].file, "package-lock.json");
});
