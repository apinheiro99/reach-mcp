// The one log-safe redaction function. Both the operational logger and the audit writer call it on every text immediately before it
// is written, at every level (DEBUG included), so a secret never reaches a log file whichever caller produced it. A secret becomes
// the visible marker `[REDACTED]` and the text around it is kept, because "a credential was here" is more useful than a silent gap.
// It is idempotent: redacting an already redacted text changes nothing.
export const REDACTED = "[REDACTED]";

const PEM_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;
const AUTH_SCHEME = /\b(Bearer|Basic)\s+(?!\[REDACTED\])[A-Za-z0-9._~+/=-]{8,}/gi;
const URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)[^/\s@]+@/gi;
/** `name=value` / `name: value` where the name says it holds a secret (password, token, secret, api key, private key, credential...). */
const NAMED_VALUE = /\b([A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|private[_-]?key|credential|authorization)[A-Za-z0-9_.-]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s&;,"']+)/gi;
/** Well-known credential shapes that carry no name: provider key prefixes and AWS access key ids. */
const KNOWN_SHAPE = /\b(?:(?:sk|pk|rk|ghp|gho|ghs|xox[abp])[-_][A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16})\b/g;

export function redact(text: string): string {
  return text
    .replace(PEM_BLOCK, REDACTED)
    .replace(AUTH_SCHEME, `$1 ${REDACTED}`)
    .replace(URL_CREDENTIALS, `$1${REDACTED}@`)
    .replace(NAMED_VALUE, `$1$2${REDACTED}`)
    .replace(KNOWN_SHAPE, REDACTED);
}
