#!/bin/sh
# The privileged half of an operator-triggered REACH Client update on Linux. Started by systemd as root (reach-mcp-client-update.service)
# when the unprivileged Client has staged a verified archive and created the marker. This script holds no install logic of its own: it
# reruns the public installer (install.sh, the one owner of manifest selection, verification, the swap, the unit and the restart) on the
# staged archive. The staged file is written by the Client's account, so it is trusted for nothing: the installer checks its size and
# SHA-256 against the Server's manifest before anything changes, and a failure leaves the current install and its bootstrap untouched.
# It is also the ONLY author of the terminal result (update/apply-result.json): the Client's apply-request.json is copied verbatim and closed with
# the outcome, so the Windows wrapper produces the same bytes. The request is correlation only, never an authority over the installer.
set -eu

die() {
  echo "apply-update-linux: $1" >&2
  exit 2
}

bootstrap="" install_dir="" unit_dir=""
while [ $# -ge 2 ]; do
  case "$1" in
    --bootstrap) bootstrap="$2" ;;
    --install-dir) install_dir="$2" ;;
    --unit-dir) unit_dir="$2" ;;
    *) die "unknown option $1" ;;
  esac
  shift 2
done
[ -n "$bootstrap" ] && [ -n "$install_dir" ] && [ -n "$unit_dir" ] || die "usage: apply-update-linux.sh --bootstrap <file> --install-dir <dir> --unit-dir <dir>"

state_dir="$(dirname "$bootstrap")"
staged="$state_dir/update/client.tgz"
request_file="$state_dir/update/apply-request.json"
result_file="$state_dir/update/apply-result.json"
# The request is consumed first, so a failure is never retried in a loop; the Client asks again on the next operator action.
rm -f "$state_dir/update/apply"
# Without a valid request there is nothing to correlate a result to, and a result is never invented: stop here.
[ -f "$request_file" ] || die "no apply request"
request="$(cat "$request_file")"
case "$request" in *[[:cntrl:]]*) die "the apply request is not one line" ;; esac
printf '%s\n' "$request" | grep -Eq '^\{"schema_version":1,"update_id":"[^"\\]+","from_build":"[^"\\]+","target_build":"[^"\\]+","artifact_sha256":"[0-9a-f]{64}"\}$' || die "the apply request is not the canonical shape"

# Commits the terminal result atomically (temp file, fsync, rename) and only then drops the request; a write that fails exits nonzero and leaves no half result.
write_result() {
  umask 022
  printf '%s,"state":"%s"%s}\n' "${request%\}}" "$1" "$2" >"$result_file.tmp"
  sync "$result_file.tmp"
  mv -f "$result_file.tmp" "$result_file"
  rm -f "$request_file"
}
fail() {
  echo "apply-update-linux: $1" >&2
  write_result failed ',"reason":"apply"'
  exit 2
}

[ -f "$staged" ] || fail "no staged archive"
url="$(sed -n 's/^REACH_SERVER_URL=//p' "$bootstrap" | head -n 1)"
case "$url" in
  ws://*/client) origin="http://${url#ws://}"; origin="${origin%/client}" ;;
  *) fail "the bootstrap endpoint is not a ws://host:port/client URL" ;;
esac
trap 'rm -f "$staged"' EXIT
code=0
sh "$install_dir/deploy/install.sh" --server-origin "$origin" --state-dir "$state_dir" --install-dir "$install_dir" --unit-dir "$unit_dir" --staged "$staged" || code=$?
if [ "$code" -ne 0 ]; then
  write_result failed ',"reason":"apply"'
  exit "$code"
fi
write_result applied ""
