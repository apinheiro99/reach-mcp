// The operational log: one human-readable line per meaningful event, written through one RotatingTextWriter. Callers pass
// structured arguments, never payloads; every text is redacted (redact.ts) immediately before it is written, at every level, and
// a line below the configured threshold is not written at all. The threshold is read at each call, so a live change applies at once.
import { redact } from "./redact.ts";
import { oneLine, type RotatingTextWriter } from "./rotating-text.ts";

/** Severity order, lowest first. RUNNING is the operator-facing lifecycle level between INFO and WARNING. */
export const LOG_LEVELS = ["DEBUG", "INFO", "RUNNING", "WARNING", "ERROR", "CRITICAL"] as const;
export type Level = (typeof LOG_LEVELS)[number];
export type Logger = { log(level: Level, component: string, message: string, requestId?: string): void };

/** The default when an owner is built without a log (tests, tools). */
export const NO_LOGGER: Logger = { log: () => undefined };

/** `<ISO time> <LEVEL> <component> [request_id=<id>] <message>`. Without a threshold nothing is filtered; the Server passes its configured one. */
export class OperationalLogger implements Logger {
  readonly #writer: Pick<RotatingTextWriter, "write">;
  readonly #now: () => Date;
  readonly #threshold: () => Level;

  constructor(writer: Pick<RotatingTextWriter, "write">, now: () => Date = () => new Date(), threshold: () => Level = () => "DEBUG") {
    this.#writer = writer;
    this.#now = now;
    this.#threshold = threshold;
  }

  log(level: Level, component: string, message: string, requestId?: string): void {
    if (LOG_LEVELS.indexOf(level) < LOG_LEVELS.indexOf(this.#threshold())) return;
    const id = requestId === undefined ? "" : ` request_id=${oneLine(redact(requestId), 128).replaceAll(" ", "_")}`;
    this.#writer.write(`${this.#now().toISOString()} ${level} ${oneLine(redact(component), 40).replaceAll(" ", "_")}${id} ${oneLine(redact(message))}`);
  }
}
