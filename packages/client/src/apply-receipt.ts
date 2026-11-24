// The Client's two touches of the apply files (Story #154). It writes the request that correlates an attempt before the handoff, and it reads the terminal result
// the privileged wrapper left. It never authors a result: `applied` and `failed` come from the wrapper only, and a result that is missing or invalid reads as nothing.
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import path from "node:path";
import { UPDATE_APPLY_REQUEST_FILE, UPDATE_APPLY_RESULT_FILE, UpdateApplyRequest, UpdateApplyResult } from "@reach-mcp/shared/wire";

/** Writes the canonical request durably (temp file, fsync, rename): the lifecycle owner is triggered only after this returns. Field order is the wrappers' strict one-line shape. */
export function writeApplyRequest(stateDir: string, request: UpdateApplyRequest): void {
  const file = path.join(stateDir, UPDATE_APPLY_REQUEST_FILE);
  const fd = openSync(`${file}.tmp`, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(UpdateApplyRequest.parse(request)));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(`${file}.tmp`, file);
}

/** The latest terminal result as the wrapper wrote it, or null when absent, unreadable or not the canonical schema. Never repaired and never inferred. */
export function readApplyReceipt(stateDir: string): UpdateApplyResult | null {
  try {
    return UpdateApplyResult.parse(JSON.parse(readFileSync(path.join(stateDir, UPDATE_APPLY_RESULT_FILE), "utf8")));
  } catch {
    return null;
  }
}
