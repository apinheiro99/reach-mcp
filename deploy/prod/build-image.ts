// Wraps one canonical release (scripts/release.ts) into the production Server image. The release is verified first; the Docker
// context is a temporary directory holding only the Server archive, the exact artifacts/ tree and the deployment files, and the
// image build id and commit are read from the manifest.
//   node deploy/prod/build-image.ts --release <dir> --tag <image-tag> [--docker <bin>]
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { SERVED_DIR, SERVER_DIR, MANIFEST_NAME, verifyRelease, type Untrusted } from "../../scripts/release/manifest.ts";

const HERE = import.meta.dirname;
// The one name this helper owns: the Server archive inside the ephemeral Docker context, never a release contract.
const CONTEXT_RUNTIME = "runtime.tgz";

/** Verify the release, then fill `context` with exactly what the Dockerfile copies. Returns the manifest's release identity. */
export function stageContext(releaseDir: string, context: string) {
  const problems = verifyRelease(releaseDir);
  if (problems.length > 0) throw new Error(`release is not verified, no image is built:\n${problems.join("\n")}`);
  const manifest: Untrusted = JSON.parse(readFileSync(path.join(releaseDir, SERVED_DIR, MANIFEST_NAME), "utf8"));
  const servers = manifest.artifacts.filter((a: Untrusted) => a.role === "server" && a.platform === "linux-x64");
  if (servers.length !== 1) throw new Error(`release is not verified, no image is built:\nthe manifest must declare exactly one linux-x64 server artifact, found ${servers.length}`);
  mkdirSync(path.join(context, SERVER_DIR));
  cpSync(path.join(releaseDir, SERVER_DIR, servers[0]?.name ?? ""), path.join(context, SERVER_DIR, CONTEXT_RUNTIME));
  cpSync(path.join(releaseDir, SERVED_DIR), path.join(context, SERVED_DIR), { recursive: true });
  for (const file of ["Dockerfile", "entrypoint.ts", "healthcheck.ts"]) cpSync(path.join(HERE, file), path.join(context, file));
  return manifest.release;
}

export function buildImage({ releaseDir, tag, docker = "docker" }: { releaseDir: string; tag: string; docker?: string }) {
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
  const flags: Record<string, string | undefined> = Object.fromEntries(process.argv.slice(2).reduce<[string, string | undefined][]>((pairs, v, i, all) => (i % 2 === 0 ? [...pairs, [v.replace(/^--/, ""), all[i + 1]]] : pairs), []));
  if (!flags.release || !flags.tag) {
    process.stderr.write("usage: node deploy/prod/build-image.ts --release <dir> --tag <image-tag> [--docker <bin>]\n");
    process.exit(2);
  }
  try {
    const release = buildImage({ releaseDir: path.resolve(flags.release), tag: flags.tag, docker: flags.docker });
    process.stdout.write(`built ${flags.tag} for build ${release.build_id}\n`);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exit(1);
  }
}
