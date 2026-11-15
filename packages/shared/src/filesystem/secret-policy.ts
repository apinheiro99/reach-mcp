// Content-level secret protection. Path rules are not enough on their own: a key can sit in a file named notes.txt.
// Two behaviours, both applied by every operation that returns file content:
//  - a file holding a PRIVATE KEY block is refused whole (never partially returned);
//  - credential-looking values are replaced with [REDACTED] in place, so source stays readable.
// Defence in depth, not a data-loss-prevention product: it targets common, high-confidence shapes.

export const REDACTED = "[REDACTED]";

const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/;
const PEM_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g;

/** Tokens whose shape alone identifies them. */
const KNOWN_SHAPES: RegExp[] = [
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g, // GitLab
  /\bxox[abeoprs]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
  /\bsk-[A-Za-z0-9_-]{20,}\b/g, // OpenAI / Anthropic style
  /\b[spr]k_(?:live|test)_[A-Za-z0-9]{10,}\b/g, // Stripe
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
];

/** scheme://user:password@host: keep everything but the password. */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+):([^\s@/]+)@/gi;

const SECRET_WORDS = ["password", "passwd", "pwd", "secret", "api[_-]?key", "access[_-]?key", "private[_-]?key", "auth[_-]?token", "token", "credential"].join("|");
/** Upper-case env-style variable names that name a secret. */
const ENV_SECRET_WORDS = ["PASSWORD", "PASSWD", "PWD", "SECRET", "API_?KEY", "ACCESS_?KEY", "PRIVATE_?KEY", "AUTH_?TOKEN", "TOKEN", "CREDENTIAL"].join("|");
// the optional [+- ] lets the same rule work on unified-diff lines
const ENV_ASSIGNMENT = new RegExp(`^([+\\- ]?\\s*(?:export\\s+)?[A-Z0-9_]*(?:${ENV_SECRET_WORDS})[A-Z0-9_]*\\s*[:=]\\s*)(["']?)([^\\s"'#]{6,})\\2`, "gm");
/** Any-case key naming a secret; the value must look random: 16+ chars mixing letters and digits, no code punctuation. */
const ANY_ASSIGNMENT = new RegExp(`(\\b[A-Za-z0-9_.-]*(?:${SECRET_WORDS})[A-Za-z0-9_.-]*["']?\\s*[:=]\\s*)(["'])([^\\s"'()\\[\\]{}<>$]{16,})\\2`, "gi");

const PLACEHOLDER = /^(?:change[-_]?me|your[-_a-z0-9]*|<.*>|x{3,}|\*+|todo|example.*|placeholder|dummy.*|\$\{.*\}|\[REDACTED\])$/i;

export function hasPrivateKey(text: string): boolean {
  return PEM_BEGIN.test(text);
}

export function redactText(text: string): { text: string; redactions: number } {
  let redactions = 0;
  const bump = <T>(value: T): T => {
    redactions++;
    return value;
  };
  let out = text.replace(PEM_BLOCK, () => bump("[REDACTED PRIVATE KEY BLOCK]"));
  for (const shape of KNOWN_SHAPES) out = out.replace(shape, () => bump(REDACTED));
  out = out.replace(URL_CREDENTIALS, (_m, head: string) => bump(`${head}:${REDACTED}@`));
  out = out.replace(ENV_ASSIGNMENT, (m, head: string, quote: string, value: string) => (PLACEHOLDER.test(value) ? m : bump(`${head}${quote}${REDACTED}${quote}`)));
  out = out.replace(ANY_ASSIGNMENT, (m, head: string, quote: string, value: string) => (PLACEHOLDER.test(value) || !/[A-Za-z]/.test(value) || !/\d/.test(value) ? m : bump(`${head}${quote}${REDACTED}${quote}`)));
  return { text: out, redactions };
}
