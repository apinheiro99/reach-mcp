// The audit trail: one compact line per security- or configuration-relevant action, separate from the operational log and
// written through its own RotatingTextWriter. It records who did what, where, when and with what result; never a
// credential, digest, request payload, file content or configuration body.
import { oneLine, type RotatingTextWriter } from "./rotating-text.ts";

export type AuditEvent = {
  /** Who acted: `chatgpt`, `admin` or `ai`. */
  actor: string;
  action: string;
  result: string;
  client_id?: string;
  project_id?: string;
  /** A path or an identifier the action was aimed at, never content. */
  target?: string;
  request_id?: string;
};
export type Audit = { record(event: AuditEvent): void };

export const NO_AUDIT: Audit = { record: () => undefined };

const FIELDS = ["actor", "action", "client_id", "project_id", "target", "request_id", "result"] as const;

/** `<ISO time>` then tab-separated `key=value` pairs for the fields that apply. */
export class AuditWriter implements Audit {
  readonly #writer: Pick<RotatingTextWriter, "write">;
  readonly #now: () => Date;

  constructor(writer: Pick<RotatingTextWriter, "write">, now: () => Date = () => new Date()) {
    this.#writer = writer;
    this.#now = now;
  }

  record(event: AuditEvent): void {
    const pairs = FIELDS.flatMap((key) => (event[key] === undefined ? [] : [`${key}=${oneLine(event[key], 300)}`]));
    this.#writer.write([this.#now().toISOString(), ...pairs].join("\t"));
  }
}
