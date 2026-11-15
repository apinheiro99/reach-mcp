// The one command-line flag parser of the project. A process declares the flags it accepts and nothing else: unknown,
// duplicate, missing and valueless flags are refused. Errors name a flag, never a value, so a mistyped secret cannot
// reach a terminal or a journal through a usage message.

export class CliError extends Error {}

export type FlagSpec = { [flag: string]: { required?: boolean; boolean?: boolean } };

/** `--flag value` pairs and bare `--flag` switches, as declared by the spec. */
export function parseFlags(argv: readonly string[], spec: FlagSpec): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    const name = token.startsWith("--") ? token.slice(2) : null;
    const flag = name === null ? undefined : spec[name];
    if (name === null || !flag) throw new CliError(name === null ? "unexpected argument" : `unknown flag --${name}`);
    if (name in out) throw new CliError(`duplicate flag --${name}`);
    if (flag.boolean) {
      out[name] = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) throw new CliError(`flag --${name} needs a value`);
    out[name] = value;
  }
  for (const [name, flag] of Object.entries(spec)) if (flag.required && !(name in out)) throw new CliError(`missing flag --${name}`);
  return out;
}

/** A TCP port from a flag value: 0 to 65535, where 0 asks the system for a free one. */
export function parsePort(flag: string, value: string): number {
  const port = /^\d{1,5}$/.test(value) ? Number(value) : NaN;
  if (!(port >= 0 && port <= 65535)) throw new CliError(`flag --${flag} must be a port from 0 to 65535`);
  return port;
}
