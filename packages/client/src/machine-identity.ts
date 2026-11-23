// The only place that touches the OS to learn which machine this is. Hostname is never identity and there is no fallback:
// a machine whose native identifier cannot be read fails closed with a fixed message.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { machineUuid } from "@reach-mcp/shared/identity";

const WINDOWS_QUERY = "(Get-CimInstance -ClassName Win32_ComputerSystemProduct).UUID";

/** The raw native identifier: Linux /etc/machine-id, Windows SMBIOS system UUID. Throws a fixed message otherwise. */
export function readNativeMachineId(platform: NodeJS.Platform = process.platform): string {
  try {
    if (platform === "linux") return readFileSync("/etc/machine-id", "utf8");
    if (platform === "win32") return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_QUERY], { encoding: "utf8", timeout: 15_000 });
  } catch {
    throw new Error("could not read the native machine identifier");
  }
  throw new Error(`no native machine identifier source for platform ${platform}`);
}

/** This machine's stable Machine UUID; `readNative` is replaceable so tests never depend on the host. */
export const currentMachineUuid = (readNative: () => string = readNativeMachineId): string => machineUuid(readNative());
