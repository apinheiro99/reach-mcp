import { test } from "node:test";
import assert from "node:assert/strict";
import { currentMachineUuid, readNativeMachineId } from "../src/index.ts";
import { machineUuid } from "@reach-mcp/shared/identity";

test("currentMachineUuid derives from the injected native id and is independent of the hostname", () => {
  const native = "0123456789abcdef0123456789abcdef";
  assert.equal(currentMachineUuid(() => native), machineUuid(native));
  assert.equal(currentMachineUuid(() => native), currentMachineUuid(() => `${native}\n`));
});

test("readNativeMachineId has no source for other platforms and never falls back to a hostname", () => {
  assert.throws(() => readNativeMachineId("darwin"), /no native machine identifier source for platform darwin/);
});
