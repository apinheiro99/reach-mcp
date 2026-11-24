#!/bin/sh
# The privileged half of an operator-triggered REACH Client update on Linux. Started by systemd as root (reach-mcp-client-update.service)
# when the unprivileged Client has staged a verified archive and created the marker. This script holds no install logic of its own: it
# reruns the public installer (install.sh, the one owner of manifest selection, verification, the swap, the unit and the restart) on the
# staged archive. The staged file is written by the Client's account, so it is trusted for nothing: the installer checks its size and
# SHA-256 against the Server's manifest before anything changes, and a failure leaves the current install and its bootstrap untouched.
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
# The request is consumed first, so a failure is never retried in a loop; the Client asks again on the next operator action.
rm -f "$state_dir/update/apply"
[ -f "$staged" ] || die "no staged archive"
url="$(sed -n 's/^REACH_SERVER_URL=//p' "$bootstrap" | head -n 1)"
case "$url" in
  ws://*/client) origin="http://${url#ws://}"; origin="${origin%/client}" ;;
  *) die "the bootstrap endpoint is not a ws://host:port/client URL" ;;
esac
trap 'rm -f "$staged"' EXIT
sh "$install_dir/deploy/install.sh" --server-origin "$origin" --state-dir "$state_dir" --install-dir "$install_dir" --unit-dir "$unit_dir" --staged "$staged"
