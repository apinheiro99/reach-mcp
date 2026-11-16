// Wraps one canonical release (scripts/release.mjs) into the production Server image. The release is verified first; the Docker
// context is a temporary directory holding only the Server archive, the exact artifacts/ tree and the deployment files, and the
// image build id and commit are read from the manifest.
//   node deploy/prod/build-image.mjs --release <dir> --tag <image-tag> [--docker <bin>]
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { SERVED_DIR, SERVER_DIR, MANIFEST_NAME, verifyRelease } from "../../scripts/release/manifest.mjs";

const HERE = import.meta.dirname;
const SERVER_ARCHIVE = "reach-server-linux-x64.tgz";

/** Verify the release, then fill `context` with exactly what the Dockerfile copies. Returns the manifest's release identity. */
export function stageContext(releaseDir, context) {
  const problems = verifyRelease(releaseDir);
  if (problems.length > 0) throw new Error(`release is not verified, no image is built:\n${problems.join("\n")}`);
  const { release } = JSON.parse(readFileSync(path.join(releaseDir, SERVED_DIR, MANIFEST_NAME), "utf8"));
  mkdirSync(path.join(context, SERVER_DIR));
  cpSync(path.join(releaseDir, SERVER_DIR, SERVER_ARCHIVE), path.join(context, SERVER_DIR, SERVER_ARCHIVE));
  cpSync(path.join(releaseDir, SERVED_DIR), path.join(context, SERVED_DIR), { recursive: true });
  for (const file of ["Dockerfile", "entrypoint.mjs", "healthcheck.mjs"]) cpSync(path.join(HERE, file), path.join(context, file));
  return release;
}

export function buildImage({ releaseDir, tag, docker = "docker" }) {
  const context = mkdtempSync(path.join(tmpdir(), "reach-image-"));
  try {
    const release = stageContext(releaseDir, context);
    execFileSync(docker, ["build", "--build-arg", `REACH_BUILD_ID=${release.build_id}`, "--build-arg", `REACH_REPOSITORY_COMMIT=${release.repository_commit}`, "-t", tag, context], { stdio: "inherit" });
    return release;
  } finally {
    rmSync(context, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const flags = Object.fromEntries(process.argv.slice(2).reduce((pairs, v, i, all) => (i % 2 === 0 ? [...pairs, [v.replace(/^--/, ""), all[i + 1]]] : pairs), []));
  if (!flags.release || !flags.tag) {
    process.stderr.write("usage: node deploy/prod/build-image.mjs --release <dir> --tag <image-tag> [--docker <bin>]\n");
    process.exit(2);
  }
  try {
    const release = buildImage({ releaseDir: path.resolve(flags.release), tag: flags.tag, docker: flags.docker });
    process.stdout.write(`built ${flags.tag} for build ${release.build_id}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
