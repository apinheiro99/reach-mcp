// Deployment argument composition only: the build id and repository commit come from the baked canonical manifest, the layout is
// fixed by the image and the ports are the only settings. Then it hands over to the canonical Server launcher.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import process from "node:process";

export const LAYOUT = {
  server: "/opt/reach/server/reach-server.mjs",
  artifacts: "/opt/reach/artifacts",
  config: "/run/reach/config.json",
  proposal: "/run/reach/proposal.json",
  logs: "/var/log/reach",
};

/** The Server command line for one container start. `layout` is overridable only so tests can run it outside an image. */
export function serverArgs(env, layout = LAYOUT) {
  const { release } = JSON.parse(readFileSync(path.join(layout.artifacts, "manifest.json"), "utf8"));
  return [
    layout.server,
    "--config", layout.config, "--proposal", layout.proposal, "--logs", layout.logs,
    "--data-host", env.REACH_DATA_HOST ?? "0.0.0.0", "--data-port", env.REACH_DATA_PORT ?? "8787",
    "--admin-host", env.REACH_ADMIN_HOST ?? "0.0.0.0", "--admin-port", env.REACH_ADMIN_PORT ?? "8788",
    "--build", release.build_id, "--repository-commit", release.repository_commit,
    "--artifacts", layout.artifacts,
  ];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const child = spawn(process.execPath, serverArgs(process.env), { stdio: "inherit" });
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
  child.on("exit", (code, signal) => process.exit(code ?? (signal === null ? 1 : 143)));
}
