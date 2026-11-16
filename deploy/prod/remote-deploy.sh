#!/usr/bin/env bash
# Thin CI transport for deploy.mjs: ships the verified release and the deployment files to the deployment host over SSH, runs the
# controller there and brings its evidence back. Every target value comes from the environment (GitLab protected variables); this
# repository has no default host, user, key or path.
#   remote-deploy.sh deploy <release-dir> | rollback
set -eu

die() { echo "remote-deploy: $1" >&2; exit 2; }
mode="${1:-}"
case "$mode" in deploy | rollback) ;; *) die "usage: remote-deploy.sh deploy <release-dir> | rollback" ;; esac

host="${DEPLOY_HOST:?set DEPLOY_HOST}"
user="${DEPLOY_USER:?set DEPLOY_USER}"
key="${DEPLOY_SSH_KEY:?set DEPLOY_SSH_KEY to a private key file}"
known_hosts="${DEPLOY_KNOWN_HOSTS:?set DEPLOY_KNOWN_HOSTS to a known_hosts file}"
dir="${DEPLOY_DIR:?set DEPLOY_DIR}"
logs="${DEPLOY_LOGS:?set DEPLOY_LOGS}"
for v in "$host" "$user" "$dir" "$logs"; do
  case "$v" in *[!A-Za-z0-9._/-]*) die "a DEPLOY_* value contains a character outside letters, digits and . _ / -" ;; esac
done

ssh_opts=(-i "$key" -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$known_hosts" -o BatchMode=yes)
remote() { ssh "${ssh_opts[@]}" "$user@$host" "$@"; }
mkdir -p deploy-evidence
trap 'scp "${ssh_opts[@]}" "$user@$host:$dir/state/evidence.json" deploy-evidence/evidence.json 2>/dev/null || true' EXIT

if [ "$mode" = deploy ]; then
  release="${2:?usage: remote-deploy.sh deploy <release-dir>}"
  config="${DEPLOY_CONFIG:?set DEPLOY_CONFIG}"
  proposal="${DEPLOY_PROPOSAL:?set DEPLOY_PROPOSAL}"
  for v in "$config" "$proposal"; do
    case "$v" in *[!A-Za-z0-9._/-]*) die "a DEPLOY_* path contains a character outside letters, digits and . _ / -" ;; esac
  done
  remote "mkdir -p '$dir/work' '$dir/state' && rm -rf '$dir/work/release' '$dir/work/deploy' '$dir/work/scripts'"
  tar -czf - -C "$release/.." "$(basename "$release")" | remote "tar -xzf - -C '$dir/work' && mv '$dir/work/$(basename "$release")' '$dir/work/release'"
  tar -czf - deploy/prod scripts/release | remote "tar -xzf - -C '$dir/work'"
  remote "node '$dir/work/deploy/prod/deploy.mjs' deploy --release '$dir/work/release' --state '$dir/state' --config '$config' --proposal '$proposal' --logs '$logs' --evidence '$dir/state/evidence.json'"
else
  remote "node '$dir/work/deploy/prod/deploy.mjs' rollback --state '$dir/state' --logs '$logs' --evidence '$dir/state/evidence.json'"
fi
