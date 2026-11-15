// The operational log: one human-readable line per meaningful event, written through one RotatingTextWriter. Callers pass
// structured arguments, never payloads; the line never holds credentials, headers, file contents or config bodies.
import { oneLine, type RotatingTextWriter } from "./rotating-text.ts";

export type Level = "DEBUG" | "INFO" | "WARNING" | "ERROR" | "CRITICAL";
export type Logger = { log(level: Level, component: string, message: string, requestId?: string): void };

/** The default when an owner is built without a log (tests, tools). */
export const NO_LOGGER: Logger = { log: () => undefined };

/** `<ISO time> <LEVEL> <component> [request_id=<id>] <message>` */
export class OperationalLogger implements Logger {
  readonly #writer: Pick<RotatingTextWriter, "write">;
  readonly #now: () => Date;

  constructor(writer: Pick<RotatingTextWriter, "write">, now: () => Date = () => new Date()) {
    this.#writer = writer;
    this.#now = now;
  }

  log(level: Level, component: string, message: string, requestId?: string): void {
    const id = requestId === undefined ? "" : ` request_id=${oneLine(requestId, 128).replaceAll(" ", "_")}`;
    this.#writer.write(`${this.#now().toISOString()} ${level} ${oneLine(component, 40).replaceAll(" ", "_")}${id} ${oneLine(message)}`);
  }
}
