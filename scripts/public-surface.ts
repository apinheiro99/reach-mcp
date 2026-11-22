// Public-surface guard: fails when tracked files contain private material.
// Reports file, line and category only; matched values are never printed.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

const FORBIDDEN_PATHS = [/(^|\/)\.env(?!\.example$)(\.[^/]*)?$/, /\.(pem|key|p12|pfx|crt|cer)$/i];

// The checker and its test necessarily contain the patterns they detect.
const PATTERN_FILES = new Set(["scripts/public-surface.ts", "tests/public-surface.test.ts"]);

const CONTENT_RULES = [
  { category: "private-key-block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { category: "certificate-block", re: /-----BEGIN CERTIFICATE-----/ },
  { category: "token-format", re: /\b(ghp_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/ },
  {
    category: "secret-assignment",
    re: /\b[A-Z0-9_]*(SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY)[A-Z0-9_]*["']?\s*[=:]\s*["']?(?!\s|["']|<|\$|\.\.\.|changeme|example|placeholder)[^\s"']{8,}/i,
  },
  { category: "private-network-address", re: /(?<![\d.])(192\.168|10\.\d{1,3}|172\.(1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}(?![\d.])/ },
  { category: "private-hostname", re: /\b[a-z0-9-]+\.(lab|internal|local)\b|\btruenas\b/i },
];

export type Hit = { line: number; category: string };

export function scanText(text: string): Hit[] {
  const hits: Hit[] = [];
  text.split("\n").forEach((line, i) => {
    for (const { category, re } of CONTENT_RULES) {
      if (re.test(line)) hits.push({ line: i + 1, category });
    }
  });
  return hits;
}

export function scanFiles(files: string[], read = (f: string) => readFileSync(f, "utf8")) {
  const findings: (Hit & { file: string })[] = [];
  for (const file of files) {
    if (FORBIDDEN_PATHS.some((re) => re.test(file))) findings.push({ file, line: 0, category: "forbidden-path" });
    if (PATTERN_FILES.has(file)) continue;
    for (const hit of scanText(read(file))) findings.push({ file, ...hit });
  }
  return findings;
}

function main() {
  const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
  const findings = scanFiles(files);
  for (const f of findings) console.error(`public-surface: ${f.file}:${f.line} ${f.category}`);
  if (findings.length > 0) process.exit(1);
  console.log(`public-surface: ${files.length} tracked files clean`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
