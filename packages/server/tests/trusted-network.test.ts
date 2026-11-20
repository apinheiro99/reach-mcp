import { test } from "node:test";
import assert from "node:assert/strict";
import { NO_TRUSTED_SOURCES, parseTrustedSources } from "../src/trusted-network.ts";

test("trusted sources: CIDRs and single addresses match the direct peer, IPv4-mapped addresses are unwrapped, everything else is refused", () => {
  const trusted = parseTrustedSources("10.1.0.0/16, 192.168.5.7 ,fd00::/8");
  for (const ok of ["10.1.2.3", "::ffff:10.1.200.9", "192.168.5.7", "fd12::1"]) assert.equal(trusted(ok), true, ok);
  for (const no of ["10.2.0.1", "192.168.5.8", "8.8.8.8", "::1", "not-an-ip", "", undefined]) assert.equal(trusted(no), false, String(no));
});

test("trusted sources: nothing is trusted by default and a malformed entry is refused without a built-in range", () => {
  assert.equal(NO_TRUSTED_SOURCES("127.0.0.1"), false);
  assert.equal(parseTrustedSources("")("127.0.0.1"), false, "an empty list admits nobody");
  for (const bad of ["10.0.0.0/33", "10.0.0.0/x", "hostname", "10.0.0.0/8/8", "fd00::/129"]) assert.throws(() => parseTrustedSources(bad), RangeError, bad);
});
