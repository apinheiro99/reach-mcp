#!/usr/bin/env node
// Run one CI validation command and always leave a compact artifact summary.
// The summary records command identity/result only; raw command output remains in the GitLab job trace.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const [name, ...command] = process.argv.slice(2);
if (!name || command.length === 0) {
  console.error("usage: validation-summary.mjs <gate-name> <command> [args...]");
  process.exit(2);
}

const started = new Date();
const result = spawnSync(command[0], command.slice(1), {
  stdio: "inherit",
  shell: false,
  env: process.env,
});
const finished = new Date();
const exitCode = result.status ?? 1;
const status = exitCode === 0 ? "PASS" : "FAIL";
const outDir = path.resolve("ci-summary");
mkdirSync(outDir, { recursive: true });

const safe = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "validation";
const summary = {
  gate: name,
  status,
  exit_code: exitCode,
  command: command.join(" "),
  pipeline_id: process.env.CI_PIPELINE_ID ?? null,
  pipeline_iid: process.env.CI_PIPELINE_IID ?? null,
  job_id: process.env.CI_JOB_ID ?? null,
  job_name: process.env.CI_JOB_NAME ?? name,
  ref: process.env.CI_COMMIT_REF_NAME ?? null,
  commit_sha: process.env.CI_COMMIT_SHA ?? null,
  started_at: started.toISOString(),
  finished_at: finished.toISOString(),
  duration_seconds: Math.max(0, Math.round((finished.getTime() - started.getTime()) / 1000)),
};

writeFileSync(path.join(outDir, `${safe}.json`), JSON.stringify(summary, null, 2) + "\n");
writeFileSync(
  path.join(outDir, `${safe}.txt`),
  [
    `Gate: ${summary.gate}`,
    `Status: ${summary.status}`,
    `Exit code: ${summary.exit_code}`,
    `Command: ${summary.command}`,
    `Pipeline: ${summary.pipeline_id ?? "-"}`,
    `Job: ${summary.job_id ?? "-"}`,
    `Ref: ${summary.ref ?? "-"}`,
    `Commit: ${summary.commit_sha ?? "-"}`,
    `Duration: ${summary.duration_seconds}s`,
    "",
  ].join("\n"),
);

process.exit(exitCode);
