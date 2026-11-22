// Package-content proof: `npm pack --dry-run` of every workspace package may list only src/ plus npm's own metadata,
// and every local file its manifest exports must be in that pack list (an export cannot point at a file that is not shipped).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";
import type { Untrusted } from "./release/manifest.ts";

const root = JSON.parse(readFileSync("package.json", "utf8"));
const manifests = new Map((root.workspaces as string[]).map((dir) => JSON.parse(readFileSync(`${dir}/package.json`, "utf8")) as Untrusted).map((m): [string, Untrusted] => [m.name, m]));

/** Every local file target ("./...") of an exports value: a string, or conditions nested in objects. */
const localTargets = (value: Untrusted): string[] => (typeof value === "string" ? (value.startsWith("./") ? [value.slice(2)] : []) : Object.values(value ?? {}).flatMap(localTargets));

const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--workspaces"], { encoding: "utf8" });
const allowed = (p: string) => p.startsWith("src/") || ["package.json", "README.md", "LICENSE"].includes(p);
let total = 0;
let failed = false;
for (const pack of JSON.parse(out)) {
  const files = pack.files.map((f: { path: string }) => f.path);
  for (const file of files) {
    total += 1;
    if (!allowed(file)) {
      console.error(`package-contents: ${pack.name} has unexpected file ${file}`);
      failed = true;
    }
  }
  for (const target of localTargets(manifests.get(pack.name)?.exports)) {
    if (!files.includes(target)) {
      console.error(`package-contents: ${pack.name} exports ${target} but it is not in the packed files`);
      failed = true;
    }
  }
}
if (failed) process.exit(1);
console.log(`package-contents: ${total} files in the workspace packages, only intended artifacts, every export packed`);
