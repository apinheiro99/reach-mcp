import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ci = readFileSync(new URL("../.gitlab-ci.yml", import.meta.url), "utf8");

// Top-level block of a job/template: from its header line to the next top-level key.
function block(name) {
  const lines = ci.split("\n");
  const start = lines.findIndex((l) => l === `${name}:`);
  assert.ok(start >= 0, `missing block ${name}`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^[^\s#]/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join("\n");
}

const validationJobs = ["public-surface", "lint", "typecheck", "test", "build-package"];

test("validation jobs are blocking and never run for tag pipelines", () => {
  const rules = block(".branch-push-only");
  assert.match(rules, /\$CI_COMMIT_TAG'\n\s+when: never/);
  assert.match(rules, /\$CI_PIPELINE_SOURCE == "push"'/);
  for (const job of validationJobs) {
    const b = block(job);
    assert.match(b, /extends: \.branch-push-only/, `${job} must reuse the branch-push rules`);
    assert.doesNotMatch(b, /allow_failure/, `${job} must stay blocking`);
    assert.match(b, /stage: validate/);
  }
});

test("green tag job: branch push on_success only, tag pipeline never", () => {
  const b = block("ci-tag-green");
  assert.match(b, /CI_TAG_RESULT: pass/);
  assert.match(b, /\$CI_COMMIT_TAG'\n\s+when: never/);
  assert.match(b, /\$CI_PIPELINE_SOURCE == "push"'\n\s+when: on_success/);
});

test("red tag job: branch push on_failure only, tag pipeline never", () => {
  const b = block("ci-tag-red");
  assert.match(b, /CI_TAG_RESULT: fail/);
  assert.match(b, /\$CI_COMMIT_TAG'\n\s+when: never/);
  assert.match(b, /\$CI_PIPELINE_SOURCE == "push"'\n\s+when: on_failure/);
});

test("tag jobs invoke the canonical GitGate ci-tag with exact provider metadata", () => {
  const b = block(".ci-tag");
  assert.match(b, /gitgate\.ts" ci-tag --result "\$CI_TAG_RESULT" --sha "\$CI_COMMIT_SHA" --pipeline-iid "\$CI_PIPELINE_IID" --pipeline-created-at "\$CI_PIPELINE_CREATED_AT"/);
  assert.match(b, /GIT_DEPTH: "0"/);
  assert.match(b, /before_script: \[\]/, "tag jobs must not run npm ci");
  assert.match(b, /image: node:24-bookworm\n/, "tag jobs need git, absent from the slim image");
});

test("GitGate is fetched at runtime from a GitLab variable with the job token only", () => {
  const b = block(".ci-tag");
  assert.match(b, /git clone .*\$\{CI_JOB_TOKEN\}@\$\{CI_SERVER_HOST\}\/\$\{GITGATE_PROJECT_PATH\}\.git/);
  assert.doesNotMatch(ci, /echo[^\n]*CI_JOB_TOKEN/);
  assert.doesNotMatch(ci, /sslVerify|GIT_SSL_NO_VERIFY|--insecure/i);
});

test("tag logic is not duplicated in REACH CI", () => {
  assert.doesNotMatch(ci, /git tag\b|git push\b|date \+|v\$\{?YEAR/);
});
