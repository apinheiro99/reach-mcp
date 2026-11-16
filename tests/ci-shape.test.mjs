import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ci = readFileSync(new URL("../.gitlab-ci.yml", import.meta.url), "utf8");

// Top-level block of a job/template: from its header line to the next top-level key.
function block(name) {
  const lines = ci.split("\n");
  const start = lines.findIndex((l) => l === `${name}:` || l === `"${name}":`);
  assert.ok(start >= 0, `missing block ${name}`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^[^\s#]/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join("\n");
}

const validationJobs = ["Public Release Check", "Lint", "Type Check", "Automated Tests", "Package Check", "Release Check"];

test("validation jobs are blocking and never run for tag pipelines", () => {
  const rules = block(".branch-push-only");
  assert.match(rules, /\$CI_COMMIT_TAG'\n\s+when: never/);
  assert.match(rules, /\$CI_PIPELINE_SOURCE == "push"'/);
  for (const job of validationJobs) {
    const b = block(job);
    assert.match(b, /- \.branch-push-only/, `${job} must reuse the branch-push rules`);
    assert.match(b, /- \.validation-summary/, `${job} must publish the always-on summary artifact`);
    assert.match(b, /node scripts\/validation-summary\.mjs "/, `${job} must run through the summary wrapper`);
    assert.doesNotMatch(b, /allow_failure/, `${job} must stay blocking`);
    assert.match(b, /stage: validate/);
  }
});

test("the shared summary template publishes ci-summary on success and failure", () => {
  const b = block(".validation-summary");
  assert.match(b, /when: always/);
  assert.match(b, /expire_in: 14 days/);
  assert.match(b, /- ci-summary\//);
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

test("tagging is self-contained: PASS and FAIL grammar, tag on the tested SHA", () => {
  const b = block(".ci-tag");
  // PASS vYYYY.MM.NNNNNN, FAIL the same identity plus -fail
  assert.match(b, /TAG="v\$\(date -u -d "\$CI_PIPELINE_CREATED_AT" \+%Y\.%m\)\.\$\(printf "%06d" "\$CI_PIPELINE_IID"\)"/);
  assert.match(b, /if \[ "\$CI_TAG_RESULT" = "fail" \]; then TAG="\$\{TAG\}-fail"; fi/);
  assert.match(b, /git tag "\$TAG" "\$CI_COMMIT_SHA"/);
  assert.match(b, /git push origin "refs\/tags\/\$TAG"/);
  assert.match(b, /GIT_DEPTH: "0"/);
  assert.match(b, /before_script: \[\]/, "tag jobs must not run npm ci");
  assert.match(b, /image: node:24-bookworm\n/, "tag jobs need git, absent from slim images");
});

test("tag push uses only CI_JOB_TOKEN against the same repository", () => {
  const b = block(".ci-tag");
  assert.match(b, /git remote set-url origin /);
  assert.match(b, /\$\{CI_JOB_TOKEN\}@\$\{CI_SERVER_HOST\}\/\$\{CI_PROJECT_PATH\}\.git/);
  assert.doesNotMatch(ci, /echo[^\n]*CI_JOB_TOKEN/);
  assert.doesNotMatch(ci, /sslVerify|GIT_SSL_NO_VERIFY|--insecure/i);
});

test("CI has no dependency on any external project", () => {
  assert.doesNotMatch(ci, /git clone/);
  assert.doesNotMatch(ci, /GITGATE_PROJECT_PATH/);
  assert.doesNotMatch(ci, /gitgate/i);
});
