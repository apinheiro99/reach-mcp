// Thin release launcher, copied beside each runtime as reach-client.mjs / reach-server.mjs. Node does not strip types inside a
// node_modules path, so the REACH packages live in ./lib as ordinary directories; this hook maps "@reach-mcp/<pkg>[/sub]" to
// them (honoring each package.json exports map) and then runs the unchanged package entrypoint. No runtime logic lives here.
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const ENTRIES = { "reach-client.mjs": "client", "reach-server.mjs": "server" };
const entry = (ENTRIES as Record<string, string | undefined>)[path.basename(fileURLToPath(import.meta.url))];
if (entry === undefined) throw new Error("reach launcher: run it as reach-client.mjs or reach-server.mjs");

const libDir = (name: string) => path.join(root, "lib", name.replace(/^@reach-mcp\//, ""));
registerHooks({
  resolve(specifier, context, nextResolve) {
    const match = /^(@reach-mcp\/[^/]+)(\/.*)?$/.exec(specifier);
    if (match === null) return nextResolve(specifier, context);
    const dir = libDir(match[1] as string);
    const exportsMap = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).exports;
    const key = match[2] === undefined ? "." : `.${match[2]}`;
    const target = exportsMap === undefined ? (key === "." ? null : key) : exportsMap[key];
    if (typeof target !== "string") throw new Error(`reach launcher: ${specifier} is not exported`);
    return { url: pathToFileURL(path.join(dir, target)).href, shortCircuit: true };
  },
});
await import(pathToFileURL(path.join(root, "lib", entry, "src", "main.ts")).href);
