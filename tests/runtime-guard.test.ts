// Hardcode guard: a runtime knob declared in shared/src/runtime-settings.ts has exactly one default owner. This fails when the default
// of such a knob reappears as a raw number in production code, on a line that is about that knob, outside the owner. It is deliberately
// NOT a ban on numeric literals: only declared knobs, only their own default value, only on a line that names the knob's concern.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { RUNTIME_KNOBS } from "../packages/shared/src/runtime-settings.ts";

const OWNER = path.join("packages", "shared", "src", "runtime-settings.ts");
const ALLOW = "runtime-guard: allow";

const asLiteral = (n: number): RegExp => {
  const digits = String(n).replace(/\B(?=(\d{3})+(?!\d))/g, "_?");
  return new RegExp(`(?<![\\w.])${n >= 1000 ? digits : String(n).replace(".", "\\.")}(?![\\w.])`);
};

/** Violations in one source text: `knob:line` for every declared default that is written as a literal on a line about that knob. */
export function hardcodedKnobs(source: string): string[] {
  const found: string[] = [];
  source.split("\n").forEach((line, index) => {
    const code = line.replace(/\/\/.*$/, "");
    if (line.includes(ALLOW) || code.trim() === "" || /^\s*(\*|\/\*)/.test(line)) return;
    for (const [key, knob] of Object.entries(RUNTIME_KNOBS)) {
      if (knob.guard.test(code) && asLiteral(knob.default).test(code)) found.push(`${key}:${index + 1}`);
    }
  });
  return found;
}

const sourcesUnder = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? sourcesUnder(full) : entry.name.endsWith(".ts") ? [full] : [];
  });

test("no declared runtime knob default is written as a raw literal in production code outside its owner", () => {
  const files = readdirSync("packages").filter((pkg) => existsSync(path.join("packages", pkg, "src"))).flatMap((pkg) => sourcesUnder(path.join("packages", pkg, "src"))).filter((file) => file !== OWNER);
  assert.ok(files.length > 20, "the guard actually scans the production sources");
  const violations = files.flatMap((file) => hardcodedKnobs(readFileSync(file, "utf8")).map((v) => `${file} ${v}`));
  assert.deepEqual(violations, []);
});

test("the guard catches a representative regression and ignores unrelated numbers, comments and the allow marker", () => {
  assert.deepEqual(hardcodedKnobs("const staleMs = options.staleMs ?? 90_000;"), ["stale_ms:1"]);
  assert.deepEqual(hardcodedKnobs("ui.timer = setTimeout(save, 500);"), ["admin_autosave_debounce_ms:1"]);
  assert.deepEqual(hardcodedKnobs("const heartbeat = { intervalMs: 30000 };"), ["heartbeat_interval_ms:1"]);
  assert.deepEqual(hardcodedKnobs("const DEFAULT_BACKOFF = { initialMs: 1000, jitter: 0.2 };").sort(), ["reconnect_initial_ms:1", "reconnect_jitter:1"]);
  assert.deepEqual(hardcodedKnobs("const maxFiles = 500;"), [], "the same number on an unrelated line is fine");
  assert.deepEqual(hardcodedKnobs("// stale after 90_000 ms by default"), [], "comments are not code");
  assert.deepEqual(hardcodedKnobs("const stale = 90_000; // runtime-guard: allow test fixture"), []);
  assert.deepEqual(hardcodedKnobs("const staleMs = options.staleMs ?? RUNTIME_DEFAULTS.stale_ms;"), []);
});
