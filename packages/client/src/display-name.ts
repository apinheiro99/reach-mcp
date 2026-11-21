import { hostname } from "node:os";

const MAX_DISPLAY_NAME = 100;

/** A human suggestion for this Client's name, taken from the machine hostname. Only a suggestion: the Server keeps it for a new Pending Client, an operator can rename it, and it is never identity. */
export function suggestClientDisplayName(host: string = hostname()): string | undefined {
  const name = host.trim().slice(0, MAX_DISPLAY_NAME).trim();
  return name === "" ? undefined : name;
}
