// The CI-only prerequisite that gives a container a native Linux machine id; production Machine UUID semantics are untouched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CI_MACHINE_ID, ensureMachineId } from "../scripts/git-ci/ensure-machine-id.ts";

const target = () => path.join(mkdtempSync(path.join(tmpdir(), "reach-machine-id-")), "machine-id");
const VALID = "0123456789abcdef0123456789abcdef";

test("a valid existing machine id is preserved byte for byte", () => {
  const file = target();
  writeFileSync(file, `${VALID}\n`);
  assert.equal(ensureMachineId(file, "linux"), "kept");
  assert.equal(readFileSync(file, "utf8"), `${VALID}\n`);
});

test("a missing, empty or malformed machine id is provisioned with the one deterministic CI value", () => {
  assert.match(CI_MACHINE_ID, /^[0-9a-f]{32}$/);
  const missing = target();
  assert.equal(ensureMachineId(missing, "linux"), "provisioned");
  assert.equal(readFileSync(missing, "utf8"), `${CI_MACHINE_ID}\n`);
  for (const bad of ["", "not-hex-at-all", "0123"]) {
    const file = target();
    writeFileSync(file, bad);
    assert.equal(ensureMachineId(file, "linux"), "provisioned", JSON.stringify(bad));
    assert.equal(readFileSync(file, "utf8"), `${CI_MACHINE_ID}\n`);
  }
});

test("anything but Linux, or a location that cannot be written, fails with a clear prerequisite message", () => {
  assert.throws(() => ensureMachineId(target(), "win32"), /Linux CI/);
  assert.throws(() => ensureMachineId(path.join(target(), "no-such-dir", "machine-id"), "linux"), /cannot provision/);
});
