// Throwaway repository tree with ordinary files, secrets, a binary, a big file and symlinks.
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FsError, type FsLimits } from "../src/filesystem/index.ts";

export function makeFixture(): { root: string; outside: string } {
  const base = mkdtempSync(path.join(tmpdir(), "reach-fs-fixture-"));
  const root = path.join(base, "repo");
  const outside = path.join(base, "outside");
  for (const dir of ["src/lib", "docs", "node_modules/pkg", ".git/objects", ".ssh", "config"]) mkdirSync(path.join(root, dir), { recursive: true });
  mkdirSync(outside);
  const files: Record<string, string> = {
    "README.md": "# Fixture\nhello world\n",
    "src/app.ts": "export const answer = 42;\nexport function greet(name: string) {\n  return `hi ${name}`;\n}\n",
    "src/lib/util.ts": "export const util = 1;\n",
    "src/lib/server.test.ts": "// test\n",
    "docs/Guide.md": "Guide for the TOKEN_FLOW concept\n",
    "node_modules/pkg/index.js": "module.exports = 1;\n",
    ".git/config": "[remote]\nurl = placeholder\n",
    ".env": "FIXTURE_VALUE=not-a-real-value\n",
    ".env.staging": "FIXTURE_VALUE=other-value\n",
    "config/server.pem": "pem placeholder\n",
    "config/id_rsa": "key placeholder\n",
    ".ssh/known_hosts": "host entry\n",
    "config/settings.json": '{"ok": true}\n',
    "big.txt": "x".repeat(2000),
    "lines.txt": Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n") + "\n",
  };
  for (const [rel, content] of Object.entries(files)) writeFileSync(path.join(root, rel), content);
  writeFileSync(path.join(root, "blob.bin"), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]));
  writeFileSync(path.join(outside, "notes.txt"), "outside data\n");
  symlinkSync(outside, path.join(root, "escape-dir"));
  symlinkSync(path.join(outside, "notes.txt"), path.join(root, "escape-file.txt"));
  symlinkSync(path.join(root, ".env"), path.join(root, "env-link.txt"));
  symlinkSync(path.join(root, "src/app.ts"), path.join(root, "app-link.ts"));
  return { root, outside };
}

export const LIMITS: Partial<FsLimits> = { maxFileBytes: 1000, maxReadLines: 10, maxSearchResults: 5, maxDirEntries: 50 };

/** The refusal code of a call, or NO_ERROR. */
export function code(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof FsError) return err.code;
    throw err;
  }
  return "NO_ERROR";
}
