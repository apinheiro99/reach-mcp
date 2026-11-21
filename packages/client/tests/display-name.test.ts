import { test } from "node:test";
import assert from "node:assert/strict";
import { suggestClientDisplayName } from "../src/display-name.ts";

test("suggestClientDisplayName: the trimmed hostname, capped at 100, nothing when empty", () => {
  assert.equal(suggestClientDisplayName("  studio-pc  "), "studio-pc");
  assert.equal(suggestClientDisplayName("h".repeat(150)), "h".repeat(100));
  assert.equal(suggestClientDisplayName("   "), undefined);
  assert.equal(suggestClientDisplayName(""), undefined);
  assert.equal(suggestClientDisplayName("box"), suggestClientDisplayName("box"), "deterministic for the same input");
});
