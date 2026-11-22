// The CI summary wrapper must record the result and never change the wrapped command's exit status.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const WRAPPER = path.join(import.meta.dirname, "..", "scripts", "validation-summary.ts");
const run = (gate: string, code: number, cwd: string) =>
  spawnSync(process.execPath, [WRAPPER, gate, process.execPath, "-e", `console.log("raw-child-" + "output"); process.exit(${code})`], { cwd, encoding: "utf8" });

test("a passing command writes a PASS summary and exits 0", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "reach-summary-"));
  const r = run("Lint", 0, cwd);
  assert.equal(r.status, 0);
  const json = JSON.parse(readFileSync(path.join(cwd, "ci-summary", "lint.json"), "utf8"));
  assert.equal(json.status, "PASS");
  assert.equal(json.exit_code, 0);
  assert.ok(existsSync(path.join(cwd, "ci-summary", "lint.txt")));
});

test("a failing command writes a FAIL summary and exits with the same status", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "reach-summary-"));
  const r = run("Public Release Check", 7, cwd);
  assert.equal(r.status, 7);
  const json = JSON.parse(readFileSync(path.join(cwd, "ci-summary", "public-release-check.json"), "utf8"));
  assert.equal(json.status, "FAIL");
  assert.equal(json.exit_code, 7);
});

test("summaries hold metadata only, never the child's output", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "reach-summary-"));
  run("Type Check", 1, cwd);
  for (const ext of ["json", "txt"]) assert.ok(!readFileSync(path.join(cwd, "ci-summary", `type-check.${ext}`), "utf8").includes("raw-child-output"));
});

test("a command that cannot start fails the gate instead of passing", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "reach-summary-"));
  const r = spawnSync(process.execPath, [WRAPPER, "Missing", "definitely-not-a-command-xyz"], { cwd, encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.equal(JSON.parse(readFileSync(path.join(cwd, "ci-summary", "missing.json"), "utf8")).status, "FAIL");
});
