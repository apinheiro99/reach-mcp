// Package-content proof: `npm pack --dry-run` of every workspace package may list only src/ plus npm's own metadata.
import { execFileSync } from "node:child_process";
import process from "node:process";

const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--workspaces"], { encoding: "utf8" });
const allowed = (p) => p.startsWith("src/") || ["package.json", "README.md", "LICENSE"].includes(p);
let total = 0;
let failed = false;
for (const pack of JSON.parse(out)) {
  for (const file of pack.files.map((f) => f.path)) {
    total += 1;
    if (!allowed(file)) {
      console.error(`package-contents: ${pack.name} has unexpected file ${file}`);
      failed = true;
    }
  }
}
if (failed) process.exit(1);
console.log(`package-contents: ${total} files in the workspace packages, only intended artifacts`);
