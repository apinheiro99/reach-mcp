import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ci = readFileSync(new URL("../.gitlab-ci.yml", import.meta.url), "utf8");

// Top-level block of a job/template: from its header line to the next top-level key.
function block(name: string): string {
  const lines = ci.split("\n");
  const start = lines.findIndex((l) => l === `${name}:` || l === `"${name}":`);
  assert.ok(start >= 0, `missing block ${name}`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^[^\s#]/.test(lines[i]!)) { end = i; break; }
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
    assert.match(b, /node scripts\/validation-summary\.ts "/, `${job} must run through the summary wrapper`);
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

test("production delivery: the release job needs every validation job; the default branch deploys automatically and a Task branch through Deploy Candidate, also without a button", () => {
  const release = block("Build Release");
  for (const job of validationJobs) assert.match(release, new RegExp(`- "${job}"`), `Build Release must need ${job}`);
  assert.match(release, /stage: release/);
  assert.match(release, /VERSION="v\$\(date -u -d "\$CI_PIPELINE_CREATED_AT" \+%Y\.%m\)\.\$\(printf "%06d" "\$CI_PIPELINE_IID"\)"/, "the release version is the tag grammar of the green tag job");
  assert.match(release, /--build-id "\$VERSION" --repository-commit "\$CI_COMMIT_SHA"/, "the release identity is the Git tag version");
  assert.match(release, /extends: \.release-push/);
  const rules = block(".release-push");
  assert.match(rules, /\$CI_COMMIT_TAG'\n\s+when: never/, "no release for tag pipelines");
  assert.match(rules, /\$CI_COMMIT_BRANCH == \$CI_DEFAULT_BRANCH'\n/);
  assert.match(rules, /\$CI_COMMIT_BRANCH =~ \/\^feature\\\/task-\//, "Task branches get a release");
  assert.doesNotMatch(ci, /task-37|task-\d+/, "no per-Task branch exception");
  const shared = block(".deploy-release");
  assert.match(shared, /- job: "Build Release"\n\s+artifacts: true/, "deploy consumes the release of the same pipeline");
  assert.match(shared, /node deploy\/prod\/deploy\.ts deploy --release release /, "deploy calls the controller locally with the Build Release artifacts");
  const production = block("Deploy Production");
  assert.match(production, /extends: \.deploy-release/);
  assert.match(production, /\$CI_COMMIT_TAG'\n\s+when: never/);
  assert.match(production, /\$CI_COMMIT_BRANCH == \$CI_DEFAULT_BRANCH'\n/);
  assert.doesNotMatch(production, /when: manual|feature\//, "Deploy Production runs by itself on the default branch only");
  const candidate = block("Deploy Candidate");
  assert.match(candidate, /extends: \.deploy-release/, "one deployment script, no copy");
  assert.match(candidate, /\$CI_COMMIT_TAG'\n\s+when: never/, "never for a tag pipeline");
  assert.match(candidate, /\$CI_COMMIT_BRANCH =~ \/\^feature\\\/task-\/'\n/, "Task branches only");
  assert.doesNotMatch(candidate, /when: manual|allow_failure/, "PO order: no button, it runs after Build Release passes");
  assert.doesNotMatch(candidate, /\$CI_DEFAULT_BRANCH/, "never the default branch");
  assert.match(block("Rollback Production"), /\$CI_COMMIT_BRANCH == \$CI_DEFAULT_BRANCH'\n\s+when: manual\n\s+allow_failure: true/);
  // PO order (2026-11-20): a deployment never waits for a click. The only manual job is Rollback, and it must never block the pipeline.
  const manual = ci.match(/when: manual/g) ?? [];
  assert.equal(manual.length, ci.match(/when: manual\n\s+allow_failure: true/g)?.length, "every manual job is allow_failure: true, so no pipeline is left blocked in manual");
  assert.equal(manual.length, 1, "Rollback Production is the only manual job");
  assert.ok(ci.indexOf("  - validate\n") < ci.indexOf("  - release\n") && ci.indexOf("  - release\n") < ci.indexOf("  - deploy\n"), "stage order: validate, release, deploy");
});

test("production delivery: jobs run on the docker-prod runner, call the controller locally, serialize, keep evidence and need no SSH or target variables", () => {
  const shared = block(".deploy-job");
  assert.match(shared, /resource_group: production/);
  assert.match(shared, /artifacts:\n\s+when: always[\s\S]*- deploy-evidence\//);
  assert.match(shared, /tags:\n\s+- docker-prod/, "deploy and rollback run only on the docker-prod runner");
  assert.match(block(".deploy-release"), /extends: \.deploy-job/, "deploy jobs share the production lock, runner and evidence");
  assert.match(block("Rollback Production"), /node deploy\/prod\/deploy\.ts rollback /, "rollback calls the controller locally");
  for (const [name, job] of [["deploy", block(".deploy-release")], ["rollback", block("Rollback Production")]] as [string, string][]) {
    assert.match(job, /--admin-bind "\$REACH_ADMIN_BIND" --admin-allow-from "\$REACH_ADMIN_ALLOW_FROM"/, `${name} passes the Admin exposure variables from GitLab`);
    assert.match(job, /--private-path "\$REACH_PRIVATE_PATH"/, `${name} passes the one private root from GitLab`);
    assert.doesNotMatch(job, /--(config|proposal|logs) /, `${name} no longer builds separate Server storage paths`);
  }
  assert.doesNotMatch(ci, new RegExp(["192", "168"].join("\\.") + "\\.|\\b10\\.\\d+\\.\\d+\\.\\d+|\\b172\\.(1[6-9]|2\\d|3[01])\\."), "no private network literal in the pipeline");
  assert.doesNotMatch(ci, /DEPLOY_[A-Z_]+|remote-deploy|SSH_KEY|known_hosts/, "no SSH transport or DEPLOY_* target variable in the production path");
  assert.doesNotMatch(ci, /docker (build|compose|push|run)|ssh |scp /, "no deployment logic in the YAML");
});

const gitgateConfig = JSON.parse(readFileSync(new URL("../.gitgate.json", import.meta.url), "utf8")) as Record<string, unknown>;
const publishScript = readFileSync(new URL("../scripts/git-ci/publish-github.ts", import.meta.url), "utf8");

test("GitHub publication is CI-owned: a publish stage between release and deploy, default-branch push only", () => {
  const stages = ci.slice(ci.indexOf("stages:"), ci.indexOf("default:"));
  assert.deepEqual([...stages.matchAll(/^ {2}- (\w+)$/gm)].map((m) => m[1]), ["validate", "tag", "release", "publish", "deploy"]);
  const b = block("Publish GitHub");
  assert.match(b, /stage: publish/);
  assert.match(b, /\$CI_COMMIT_TAG'\n\s+when: never/, "never for a tag pipeline");
  assert.match(b, /\$CI_PIPELINE_SOURCE == "push" && \$CI_COMMIT_BRANCH == \$CI_DEFAULT_BRANCH'\n/);
  assert.doesNotMatch(b, /feature\/|when: manual|allow_failure/, "no Task branch, no button, always blocking");
  assert.match(b, /tags:\n\s+- docker-prod/, "runs on the private production runner that holds the host-local credentials");
  assert.match(b, /GIT_DEPTH: "0"/, "a full clone so the whole history can be pushed");
  assert.match(b, /node scripts\/git-ci\/publish-github\.ts/, "one repository-owned implementation");
  assert.match(b, /before_script: \[\]/);
});

test("publication consumes the exact validated identity: green tag job plus the same-pipeline release, no artifacts", () => {
  const b = block("Publish GitHub");
  assert.match(b, /- "ci-tag-green"/);
  assert.match(b, /- job: "Build Release"\n\s+artifacts: false/);
  assert.doesNotMatch(b, /ci-tag-red/, "a red result never publishes");
});

test("a failed publication blocks Deploy Production; Deploy Candidate stays independent of GitHub", () => {
  const production = block("Deploy Production");
  assert.match(production, /needs:\n\s+- job: "Build Release"\n\s+artifacts: true\n\s+- job: "Publish GitHub"\n\s+artifacts: false/);
  assert.doesNotMatch(block(".deploy-release"), /Publish GitHub/, "the shared template must not reference a job Task branches do not have");
  assert.doesNotMatch(block("Deploy Candidate"), /Publish GitHub/);
  assert.doesNotMatch(block("Rollback Production"), /Publish GitHub/);
});

test("the publish script: exact SHA and tag, lease-protected main, private-root credentials, nothing hardcoded", () => {
  assert.match(publishScript, /--force-with-lease=\$\{lease\}/);
  assert.doesNotMatch(publishScript, /"--force"|"-f"|--force(?!-with-lease)/, "never a plain force");
  assert.match(publishScript, /\$\{sha\}:\$\{MAIN\}/, "the tested commit goes to main");
  assert.match(publishScript, /refs\/tags\/\$\{tag\}:refs\/tags\/\$\{tag\}/, "the green tag goes to the same tag ref");
  assert.match(publishScript, /GREEN_TAG = \/\^v\\d\{4\}\\\.\\d\{2\}\\\.\\d\{6\}\$\//, "only the green grammar, never -fail");
  assert.match(publishScript, /REACH_PRIVATE_PATH/);
  assert.match(publishScript, /IdentitiesOnly=yes/);
  assert.doesNotMatch(publishScript, /StrictHostKeyChecking=no|UserKnownHostsFile|sslVerify|GIT_SSL_NO_VERIFY|--insecure/i, "verification is never turned off");
  assert.doesNotMatch(publishScript, /github\.com[:/][A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\.git/, "no owner/repository literal");
  assert.doesNotMatch(publishScript, new RegExp(["192", "168"].join("\\.") + "\\.|-----BEGIN"), "no private network literal or key material");
  assert.doesNotMatch(publishScript, /console\.(log|error)\([^)]*(key|repository)/i, "key and remote coordinates are never printed");
  assert.doesNotMatch(ci, /github\.com|REACH_GITHUB_|credentials\/github/i, "the YAML carries no GitHub coordinate");
});

test("GitGate is governance-only for REACH: no mirror or publication, branch and CI governance kept", () => {
  assert.equal("mirror_remotes" in gitgateConfig, false);
  assert.deepEqual(gitgateConfig["publish_on"], ["story-done"], "GitGate still publishes the Sprint branch to GitLab on story-done; with no mirror_remotes it never touches GitHub");
  assert.equal(gitgateConfig["integration_branch"], "main");
  assert.deepEqual(gitgateConfig["levels"], ["sprint", "story", "task"]);
  assert.deepEqual(gitgateConfig["ci_gate"], { enabled: true });
  assert.ok(gitgateConfig["branch_prefix"]);
});

test("jobs that run a real Client get the CI-only machine id prerequisite from one shared template, and no other job does", () => {
  const tpl = block(".real-client-tests");
  assert.match(tpl, /- npm ci\n\s+- node scripts\/git-ci\/ensure-machine-id\.ts/);
  for (const job of ["Automated Tests", "Release Check"]) assert.match(block(job), /- \.real-client-tests/, `${job} runs real Clients`);
  for (const job of ["Public Release Check", "Lint", "Type Check", "Package Check"]) assert.doesNotMatch(block(job), /real-client-tests/);
  assert.doesNotMatch(ci, /machine-id\.ts[\s\S]*machine-id\.ts/, "the prerequisite is wired once, not copied per job");
  const prod = readFileSync(new URL("../packages/client/src/machine-identity.ts", import.meta.url), "utf8");
  assert.doesNotMatch(prod, /process\.env|hostname|randomUUID|CI_MACHINE_ID/, "production resolution has no environment, hostname or CI fallback");
});
