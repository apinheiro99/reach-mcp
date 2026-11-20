import { test } from "node:test";
import assert from "node:assert/strict";
import { NO_TRUSTED_SOURCES, parseTrustedSources } from "../src/trusted-network.ts";

test("trusted sources: CIDRs and single addresses match the direct peer, IPv4-mapped addresses are unwrapped, everything else is refused", () => {
  const trusted = parseTrustedSources("198.51.100.0/24, 203.0.113.7 ,fd00::/8");
  for (const ok of ["198.51.100.3", "::ffff:198.51.100.200", "203.0.113.7", "fd12::1"]) assert.equal(trusted(ok), true, ok);
  for (const no of ["198.51.101.1", "203.0.113.8", "8.8.8.8", "::1", "not-an-ip", "", undefined]) assert.equal(trusted(no), false, String(no));
});

test("trusted sources: nothing is trusted by default and a malformed entry is refused without a built-in range", () => {
  assert.equal(NO_TRUSTED_SOURCES("127.0.0.1"), false);
  assert.equal(parseTrustedSources("")("127.0.0.1"), false, "an empty list admits nobody");
  for (const bad of ["203.0.113.0/33", "203.0.113.0/x", "hostname", "203.0.113.0/24/8", "fd00::/129"]) assert.throws(() => parseTrustedSources(bad), RangeError, bad);
});
