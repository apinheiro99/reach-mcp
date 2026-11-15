import { test } from "node:test";
import assert from "node:assert/strict";
import { CliError, parseFlags, parsePort } from "../src/cli.ts";

const SPEC = { config: { required: true }, mode: {}, verbose: { boolean: true } };
const SECRET = "secret-" + "value-Hv27";

test("flags: declared values and switches parse; optional ones may be absent", () => {
  assert.deepEqual(parseFlags(["--config", "a.json", "--verbose"], SPEC), { config: "a.json", verbose: true });
  assert.deepEqual(parseFlags(["--mode", "x", "--config", "b"], SPEC), { mode: "x", config: "b" });
});

test("flags: unknown, duplicate, missing, valueless and positional input are refused without echoing any value", () => {
  const bad: string[][] = [["--config", "a", "--nope", SECRET], ["--config", "a", "--config", SECRET], ["--mode", SECRET], ["--config"], ["--config", "--mode", SECRET], [SECRET, "--config", "a"], ["--verbose", SECRET]];
  for (const argv of bad) {
    assert.throws(() => parseFlags(argv, SPEC), (e: unknown) => e instanceof CliError && !e.message.includes(SECRET), argv.join(" ").replace(SECRET, "<secret>"));
  }
});

test("ports: 0 to 65535 only", () => {
  assert.equal(parsePort("p", "0"), 0);
  assert.equal(parsePort("p", "65535"), 65535);
  for (const bad of ["65536", "-1", "80.5", "abc", "", "1e3", "08080808"]) assert.throws(() => parsePort("p", bad), CliError, bad);
});
