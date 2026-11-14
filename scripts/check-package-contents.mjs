// Package-content proof: `npm pack --dry-run` may list only dist/ plus npm's own metadata.
import { execFileSync } from "node:child_process";
import process from "node:process";

const out = execFileSync("npm", ["pack", "--dry-run", "--json"], { encoding: "utf8" });
const files = JSON.parse(out)[0].files.map((f) => f.path);
const allowed = (p) => p.startsWith("dist/") || ["package.json", "README.md", "LICENSE"].includes(p);
const bad = files.filter((p) => !allowed(p));
if (bad.length > 0) {
  for (const p of bad) console.error(`package-contents: unexpected file ${p}`);
  process.exit(1);
}
console.log(`package-contents: ${files.length} files, only intended public artifacts`);
