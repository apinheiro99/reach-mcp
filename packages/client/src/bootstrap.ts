// The Client's only local configuration: one private KEY=VALUE file with endpoint, client_id, Ed25519 private key and the
// physical root anchors. On first run the Client generates its own client_id and key pair and writes them back into this
// file; the private key never leaves it and the Server only ever learns the public key. The file is data, not shell: no interpolation, includes, multiline values or env fallback.
// Operational project policy (modes, allowlists, deny rules, limits) is owned by the Server and never read here.
// POSIX: a file readable or writable by group/others is refused, never auto-fixed. Windows: mode bits do not apply, so
// that check is skipped and the operator must protect the file with an ACL.
import { randomUUID, type KeyObject } from "node:crypto";
import { readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { generateIdentityKey, importPrivateKey, publicKeyFromPrivate, signChallenge } from "@reach-mcp/shared/identity";
import { ClientId } from "@reach-mcp/shared/wire";

export const BOOTSTRAP_KEYS = ["REACH_SERVER_URL", "REACH_CLIENT_ID", "REACH_CLIENT_IDENTITY_KEY", "REACH_ROOTS"] as const;
const IDENTITY_KEYS = ["REACH_CLIENT_ID", "REACH_CLIENT_IDENTITY_KEY"] as const;

export type BootstrapOptions = {
  /** Development and tests only: accept ws:// besides wss://. Never inferred from the host name. */
  allowInsecureWs?: boolean;
  /** First run: when the file holds no identity, generate one and write it back. Off by default so tests and tools never mutate a file. */
  createIdentity?: boolean;
  /** Overridable so the Windows branch is testable on any host. */
  platform?: NodeJS.Platform;
};

/** Every problem names a key or a line, never a value, so no message can carry the private key. */
export class BootstrapError extends Error {
  readonly problems: readonly string[];

  constructor(problems: string[]) {
    super(`invalid Client bootstrap: ${problems.join("; ")}`);
    this.problems = problems;
  }
}

export type PublicBootstrap = { endpoint: string; clientId: string; anchors: readonly string[] };

/** Holds the private key in a private field: JSON, inspect and spread of this object never show it. */
export class Bootstrap {
  readonly endpoint: string;
  readonly clientId: string;
  readonly anchors: readonly string[];
  #identityKey: KeyObject;
  readonly #file: string | undefined;

  constructor(endpoint: string, clientId: string, identityKey: KeyObject, anchors: readonly string[], file?: string) {
    this.endpoint = endpoint;
    this.clientId = clientId;
    this.#identityKey = identityKey;
    this.anchors = anchors;
    this.#file = file;
  }

  /**
   * Generates a candidate Ed25519 pair WITHOUT touching the active identity: the valid key keeps working until `commit` is called.
   * `publicKey` is all that may leave this process. `commit` writes the candidate to the bootstrap file (every other line kept,
   * mode 0600, temporary file and rename) and only then makes it the active key.
   */
  prepareRotation(): { publicKey: string; commit: () => void } {
    const file = this.#file;
    if (!file) throw new BootstrapError(["this bootstrap has no file to rotate the identity in"]);
    const generated = generateIdentityKey();
    const commit = () => {
      writeBootstrapText(file, readFileSync(file, "utf8").replace(/^(\s*REACH_CLIENT_IDENTITY_KEY\s*=).*$/m, (_, head: string) => `${head}${generated.privateKey}`));
      this.#identityKey = importPrivateKey(generated.privateKey);
    };
    return { publicKey: generated.publicKey, commit };
  }

  /** The public key the Server stores as this Client's identity (base64url). */
  publicKey(): string {
    return publicKeyFromPrivate(this.#identityKey);
  }

  /** Proves possession of the private key for one Server challenge; the key itself is never exposed. */
  sign(nonce: string): string {
    return signChallenge(this.#identityKey, nonce, this.clientId);
  }

  publicView(): PublicBootstrap {
    return { endpoint: this.endpoint, clientId: this.clientId, anchors: this.anchors };
  }
}

function parseLines(text: string, problems: string[]): Map<string, string> {
  const values = new Map<string, string>();
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const eq = line.indexOf("=");
    const key = eq > 0 ? line.slice(0, eq).trim() : "";
    if (!key) return void problems.push(`line ${index + 1}: expected KEY=VALUE`);
    if (!(BOOTSTRAP_KEYS as readonly string[]).includes(key)) return void problems.push(`line ${index + 1}: unknown key`);
    if (values.has(key)) return void problems.push(`duplicate key ${key}`);
    values.set(key, line.slice(eq + 1).trim());
  });
  return values;
}

function checkEndpoint(value: string, allowInsecureWs: boolean, problems: string[]): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return void problems.push("REACH_SERVER_URL is not an absolute URL");
  }
  const secure = url.protocol === "wss:";
  if (!secure && !(allowInsecureWs && url.protocol === "ws:")) problems.push("REACH_SERVER_URL must use wss://");
  if (url.username || url.password) problems.push("REACH_SERVER_URL must not carry credentials");
  if (url.search || url.hash) problems.push("REACH_SERVER_URL must not carry a query or fragment");
}

function checkSchema(key: string, schema: { safeParse(v: unknown): { success: boolean } }, value: string, problems: string[]): void {
  if (!schema.safeParse(value).success) problems.push(`${key} is invalid`);
}

function canonicalAnchors(value: string, problems: string[]): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return void problems.push("REACH_ROOTS is not valid JSON"), [];
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((r) => typeof r === "string" && r !== "")) {
    return void problems.push("REACH_ROOTS must be a non-empty JSON array of path strings"), [];
  }
  const anchors: string[] = [];
  for (const root of parsed as string[]) {
    if (!path.isAbsolute(root)) {
      problems.push("REACH_ROOTS entry is not an absolute path");
      continue;
    }
    try {
      const real = realpathSync(root);
      if (!statSync(real).isDirectory()) throw new Error("not a directory");
      if (anchors.includes(real)) problems.push("REACH_ROOTS has duplicate anchors");
      else anchors.push(real);
    } catch {
      problems.push("REACH_ROOTS entry is not an existing directory");
    }
  }
  return anchors;
}

/** Parses bootstrap text; `permissionProblem` is the result of the file-mode check, folded into the same report. */
export function parseBootstrap(text: string, options: BootstrapOptions = {}, permissionProblem?: string, file?: string): Bootstrap {
  const problems: string[] = permissionProblem ? [permissionProblem] : [];
  const values = parseLines(text, problems);
  for (const key of BOOTSTRAP_KEYS) if (!values.has(key)) problems.push(`missing ${key}`);
  const get = (key: (typeof BOOTSTRAP_KEYS)[number]) => values.get(key) ?? "";
  if (values.has("REACH_SERVER_URL")) checkEndpoint(get("REACH_SERVER_URL"), options.allowInsecureWs === true, problems);
  if (values.has("REACH_CLIENT_ID")) checkSchema("REACH_CLIENT_ID", ClientId, get("REACH_CLIENT_ID"), problems);
  let identityKey: KeyObject | undefined;
  if (values.has("REACH_CLIENT_IDENTITY_KEY")) {
    try {
      identityKey = importPrivateKey(get("REACH_CLIENT_IDENTITY_KEY"));
    } catch {
      problems.push("REACH_CLIENT_IDENTITY_KEY is invalid");
    }
  }
  const anchors = values.has("REACH_ROOTS") ? canonicalAnchors(get("REACH_ROOTS"), problems) : [];
  if (problems.length > 0 || !identityKey) throw new BootstrapError(problems);
  return new Bootstrap(get("REACH_SERVER_URL"), get("REACH_CLIENT_ID"), identityKey, anchors, file);
}

export function loadBootstrap(file: string, options: BootstrapOptions = {}): Bootstrap {
  let permissionProblem: string | undefined;
  let text: string;
  try {
    const stat = statSync(file);
    if (!stat.isFile()) throw new Error("not a file");
    if ((options.platform ?? process.platform) !== "win32" && (stat.mode & 0o077) !== 0) permissionProblem = "bootstrap file must not be accessible by group or others";
    text = readFileSync(file, "utf8");
  } catch {
    throw new BootstrapError(["bootstrap file is missing or unreadable"]);
  }
  if (options.createIdentity && !permissionProblem && !IDENTITY_KEYS.some((key) => new RegExp(`^\\s*${key}\\s*=`, "m").test(text))) text = writeNewIdentity(file, text);
  return parseBootstrap(text, options, permissionProblem, file);
}

/** Generates this Client's id and key pair and appends them to the bootstrap file. Returns the new text. */
function writeNewIdentity(file: string, text: string): string {
  const generated = generateIdentityKey();
  return writeBootstrapText(file, `${text.endsWith("\n") || text === "" ? text : `${text}\n`}REACH_CLIENT_ID=${randomUUID()}\nREACH_CLIENT_IDENTITY_KEY=${generated.privateKey}\n`);
}

/** The one writer of the bootstrap file: temporary file with mode 0600, then rename. Returns the text it wrote. */
function writeBootstrapText(file: string, text: string): string {
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, text, { mode: 0o600 });
    renameSync(temporary, file);
  } catch {
    throw new BootstrapError(["could not write the Client identity to the bootstrap file"]);
  }
  return text;
}
