// Release manifest v2: its schema, its construction and the verification of a release directory against it.
// One owner of what a release declares. Build ids are opaque (never parsed); compatibility is exact equality.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { BuildId } from "@reach-mcp/shared/wire";

export const MANIFEST_SCHEMA_VERSION = 2;
export const MANIFEST_NAME = "manifest.json";
/** Release layout: the Client archives and the manifest are what the Server serves; the Server runtime sits beside it. */
export const SERVED_DIR = "artifacts";
export const SERVER_DIR = "server";
/** The Server route that serves the Client archives; the manifest declares relative paths under it, never an origin. */
export const PUBLIC_DOWNLOAD_PREFIX = "/release/artifacts/";
/** The canonical schema-v2 release composition: exactly one artifact per role and platform. The one owner of target metadata:
 *  os/arch are what an installer selects by (never parsed from platform); only Client archives are publicly downloadable. */
export const REQUIRED_ARTIFACTS = [
  { role: "server", platform: "linux-x64", os: "linux", arch: "x64" },
  { role: "client", platform: "linux-x64", os: "linux", arch: "x64" },
  { role: "client", platform: "win32-x64", os: "win32", arch: "x64" },
];
const isPublic = (role) => role === "client";
const targetOf = (role, platform) => REQUIRED_ARTIFACTS.find((t) => t.role === role && t.platform === platform);
const ROLES = new Set(REQUIRED_ARTIFACTS.map((r) => r.role));
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const artifactDir = (role) => (role === "server" ? SERVER_DIR : SERVED_DIR);

export function parseBuildId(value) {
  const parsed = BuildId.safeParse(value);
  if (!parsed.success) throw new Error("release: --build-id must be a non-empty printable identifier of at most 128 characters");
  return parsed.data;
}

export function parseCommit(value) {
  if (typeof value !== "string" || !COMMIT.test(value)) throw new Error("release: the repository commit must be a full 40-hex SHA");
  return value;
}

/** records: [{ role, platform, name, bytes }]; hash and size come from the final bytes. */
export function buildManifest({ buildId, repositoryCommit, records }) {
  return {
    schema_version: MANIFEST_SCHEMA_VERSION,
    release: { build_id: buildId, repository_commit: repositoryCommit },
    server: { build_id: buildId },
    client: { build_id: buildId },
    compatibility: { strategy: "exact", accepted_client_builds: [buildId] },
    artifacts: records.map(({ role, platform, name, bytes }) => ({
      role,
      platform,
      os: targetOf(role, platform)?.os,
      arch: targetOf(role, platform)?.arch,
      name,
      sha256: sha256(bytes),
      size_bytes: bytes.length,
      download_path: isPublic(role) ? `${PUBLIC_DOWNLOAD_PREFIX}${name}` : null,
    })),
  };
}

/** Every structural and coherence problem of a parsed manifest, as strings (empty = valid). */
export function validateManifest(m) {
  const problems = [];
  const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!isObject(m)) return ["manifest is not an object"];
  if (m.schema_version !== MANIFEST_SCHEMA_VERSION) problems.push(`schema_version must be ${MANIFEST_SCHEMA_VERSION}`);
  const build = (value, label) => {
    if (!BuildId.safeParse(value).success) {
      problems.push(`${label} is not a valid build id`);
      return null;
    }
    return value;
  };
  const releaseBuild = build(m.release?.build_id, "release.build_id");
  if (!COMMIT.test(m.release?.repository_commit ?? "")) problems.push("release.repository_commit must be a 40-hex SHA");
  const serverBuild = build(m.server?.build_id, "server.build_id");
  const clientBuild = build(m.client?.build_id, "client.build_id");
  if (releaseBuild !== null && (serverBuild !== releaseBuild || clientBuild !== releaseBuild)) problems.push("release, server and client build ids must be the same single build id");
  const c = m.compatibility;
  if (c?.strategy !== "exact") problems.push('compatibility.strategy must be "exact"');
  if (!Array.isArray(c?.accepted_client_builds) || c.accepted_client_builds.length !== 1 || c.accepted_client_builds[0] !== serverBuild) problems.push("compatibility.accepted_client_builds must be exactly the server build id");
  if (!Array.isArray(m.artifacts) || m.artifacts.length === 0) {
    problems.push("artifacts must be a non-empty array");
    return problems;
  }
  const names = new Set();
  const pairs = new Map();
  const selectors = new Set();
  m.artifacts.forEach((a, i) => {
    const at = `artifacts[${i}]`;
    if (!ROLES.has(a?.role)) problems.push(`${at}.role must be server or client`);
    if (typeof a?.platform !== "string" || a.platform === "") problems.push(`${at}.platform must be a non-empty string`);
    if (typeof a?.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(a.name) || a.name === MANIFEST_NAME) problems.push(`${at}.name is not a servable artifact name`);
    else if (names.has(a.name)) problems.push(`${at}.name is duplicated`);
    else names.add(a.name);
    const target = targetOf(a?.role, a?.platform);
    if (target && (a.os !== target.os || a.arch !== target.arch)) problems.push(`${at}.os/arch must be ${target.os}/${target.arch} for ${a.role}/${a.platform}`);
    if (target && isPublic(a.role)) {
      const selector = `${a.role}/${a.os}/${a.arch}`;
      if (selectors.has(selector)) problems.push(`${at}: selector ${selector} is not unique`);
      selectors.add(selector);
    }
    const expectedPath = target && typeof a.name === "string" ? (isPublic(a.role) ? `${PUBLIC_DOWNLOAD_PREFIX}${a.name}` : null) : undefined;
    if (expectedPath !== undefined && a.download_path !== expectedPath) problems.push(`${at}.download_path must be ${expectedPath === null ? "null (not publicly served)" : expectedPath}`);
    const pair = `${a?.role}/${a?.platform}`;
    pairs.set(pair, (pairs.get(pair) ?? 0) + 1);
    if (!SHA256.test(a?.sha256 ?? "")) problems.push(`${at}.sha256 must be 64 lowercase hex`);
    if (!Number.isSafeInteger(a?.size_bytes) || a.size_bytes <= 0) problems.push(`${at}.size_bytes must be a positive integer`);
  });
  const required = new Set(REQUIRED_ARTIFACTS.map((r) => `${r.role}/${r.platform}`));
  for (const pair of required) if (!pairs.has(pair)) problems.push(`artifacts: required ${pair} is missing`);
  for (const [pair, count] of pairs) {
    if (!required.has(pair)) problems.push(`artifacts: ${pair} is not part of manifest schema v2`);
    else if (count > 1) problems.push(`artifacts: ${pair} appears ${count} times`);
  }
  return problems;
}

/** Verify a release directory: manifest valid, every declared file present with exact size and hash, nothing undeclared. */
export function verifyRelease(dir) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path.join(dir, SERVED_DIR, MANIFEST_NAME), "utf8"));
  } catch (error) {
    return [`cannot read ${SERVED_DIR}/${MANIFEST_NAME}: ${error.message}`];
  }
  const problems = validateManifest(manifest);
  if (problems.length > 0) return problems;
  const declared = { [SERVED_DIR]: new Set([MANIFEST_NAME]), [SERVER_DIR]: new Set() };
  for (const a of manifest.artifacts) {
    declared[artifactDir(a.role)].add(a.name);
    let bytes;
    try {
      bytes = readFileSync(path.join(dir, artifactDir(a.role), a.name));
    } catch {
      problems.push(`${a.name}: declared but missing`);
      continue;
    }
    if (bytes.length !== a.size_bytes) problems.push(`${a.name}: size ${bytes.length} differs from the manifest ${a.size_bytes}`);
    if (sha256(bytes) !== a.sha256) problems.push(`${a.name}: sha256 differs from the manifest`);
  }
  for (const sub of [SERVED_DIR, SERVER_DIR]) {
    for (const file of readdirSync(path.join(dir, sub))) if (!declared[sub].has(file)) problems.push(`${sub}/${file}: present but not declared`);
  }
  return problems;
}
