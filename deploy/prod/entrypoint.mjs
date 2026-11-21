// Deployment argument composition only: the build id and repository commit come from the baked canonical manifest, the layout is
// fixed by the image (everything the Server persists is under the one /reach-private mount) and the two ports plus the Admin allowlist (REACH_ADMIN_ALLOW_FROM, required while REACH_ADMIN_HOST is not
// loopback, which is the default) are the only settings. Then it hands over to the canonical Server launcher.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import process from "node:process";

export const LAYOUT = {
  server: "/opt/reach/server/reach-server.mjs",
  artifacts: "/opt/reach/artifacts",
  config: "/reach-private/config.json",
  proposal: "/reach-private/proposal.json",
  logs: "/reach-private/logs",
};

/** The Server command line for one container start. `layout` is overridable only so tests can run it outside an image. */
export function serverArgs(env, layout = LAYOUT) {
  const { release } = JSON.parse(readFileSync(path.join(layout.artifacts, "manifest.json"), "utf8"));
  return [
    layout.server,
    "--config", layout.config, "--proposal", layout.proposal, "--logs", layout.logs,
    "--host", env.REACH_HOST ?? "0.0.0.0", "--port", env.REACH_PORT ?? "8787",
    "--admin-host", env.REACH_ADMIN_HOST ?? "0.0.0.0", "--admin-port", env.REACH_ADMIN_PORT ?? "8788",
    // The Server refuses a non-loopback Admin host without an allowlist; the deployment supplies it, this file never picks one.
    ...(env.REACH_ADMIN_ALLOW_FROM ? ["--admin-allow-from", env.REACH_ADMIN_ALLOW_FROM] : []),
    "--build", release.build_id, "--repository-commit", release.repository_commit,
    "--artifacts", layout.artifacts,
  ];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const child = spawn(process.execPath, serverArgs(process.env), { stdio: "inherit" });
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
  child.on("exit", (code, signal) => process.exit(code ?? (signal === null ? 1 : 143)));
}
