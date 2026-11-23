// CI-only prerequisite: test jobs that run a real Client need a native Linux machine id, which a bare CI container may not have.
// This never ships or runs in production, and the Client's own resolution (packages/client/src/machine-identity.ts) is unchanged and still fails closed.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

const MACHINE_ID_FILE = "/etc/machine-id";
const CANONICAL = /^[0-9a-f]{32}$/;
/** The one deterministic, non-secret test value (32 lowercase hex digits). */
export const CI_MACHINE_ID = createHash("sha256").update("reach-ci-test-machine").digest("hex").slice(0, 32);

/** Keeps a valid machine id; provisions CI_MACHINE_ID when the file is missing or not a canonical 32-hex id. */
export function ensureMachineId(file: string = MACHINE_ID_FILE, platform: NodeJS.Platform = process.platform): "kept" | "provisioned" {
  if (platform !== "linux") throw new Error("the machine-id prerequisite is for Linux CI only");
  if (existsSync(file) && CANONICAL.test(readFileSync(file, "utf8").trim())) return "kept";
  try {
    writeFileSync(file, `${CI_MACHINE_ID}\n`);
  } catch {
    throw new Error("cannot provision the CI machine id: the machine-id location is not writable by this job");
  }
  return "provisioned";
}

if (import.meta.main) {
  try {
    console.log(`machine id ${ensureMachineId()}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
