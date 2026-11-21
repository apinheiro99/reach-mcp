#!/bin/sh
# Machine-level REACH Client uninstall for Linux, shipped inside the verified Linux Client archive next to install-linux.sh.
#   sudo sh <install-dir>/deploy/uninstall-linux.sh [--state-dir <abs-dir>]
# It trusts only the install receipt written by the installer (<state-dir>/install-receipt.json) and removes only what that receipt proves REACH
# owns: the REACH unit, the runtime, the bootstrap (and with it the Client's private key), the receipt, and the state directory, the root and the
# service account only when the installer created them. A custom root, a directory that is not empty and an account that existed before are left alone.
# Safe to run again. It never touches the Server: the Client record there stays until an administrator removes it.
set -eu

DEFAULT_STATE_DIR=/var/lib/reach-mcp-client
DEFAULT_INSTALL_DIR=/opt/reach-mcp-client
DEFAULT_UNIT=/etc/systemd/system/reach-mcp-client.service

usage() {
  cat >&2 <<EOF
usage: uninstall-linux.sh [--state-dir <abs-dir>] [--test-no-system]
  --state-dir       the state directory of the install, default $DEFAULT_STATE_DIR
  --test-no-system  tests only: no systemd and no account change
EOF
  exit 2
}

die() {
  echo "uninstall-linux: $1" >&2
  exit 2
}

state_dir="$DEFAULT_STATE_DIR" system=1
while [ $# -gt 0 ]; do
  case "$1" in
    --test-no-system) system=0; shift ;;
    --state-dir) [ $# -ge 2 ] || usage; state_dir="$2"; shift 2 ;;
    *) usage ;;
  esac
done
[ "$(uname -s)" = Linux ] || die "this uninstaller supports Linux only"
[ "$system" = 0 ] || [ "$(id -u)" = 0 ] || die "run as root (sudo sh)"
state_dir="${state_dir%/}"
receipt="$state_dir/install-receipt.json"

if [ ! -f "$receipt" ]; then
  # No receipt means no proof of what is REACH's: an install that still exists is refused, a clean machine is already done.
  for leftover in "$DEFAULT_INSTALL_DIR" "$DEFAULT_UNIT"; do
    [ ! -e "$leftover" ] || die "no install receipt at $receipt, but $leftover exists: refusing to guess what is REACH's"
  done
  echo "Nothing to uninstall: no REACH Client receipt at $receipt."
  exit 0
fi
node_bin="$(command -v node)" || die "node was not found on PATH (it reads the receipt)"

# Read and validate the receipt; one value per line: install dir, bootstrap, root, unit dir, unit name, service user, then the three ownership flags.
READ='
const fs = require("node:fs");
const fail = (m) => { process.stderr.write("uninstall-linux: " + m + "\n"); process.exit(2); };
let r;
try { r = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { fail("the install receipt is not valid JSON"); }
const plain = (v) => typeof v === "string" && /^\/[A-Za-z0-9._ \/-]+$/.test(v) && !/(^|\/)\.\.?(\/|$)|\/\// .test(v);
if (r.schema_version !== 1 || r.platform !== "linux") fail("unsupported install receipt");
for (const k of ["install_dir", "state_dir", "bootstrap", "root", "unit_dir"]) if (!plain(r[k])) fail("the receipt has a bad " + k);
if (r.state_dir.replace(/\/$/, "") !== process.argv[2]) fail("the receipt belongs to another state directory");
if (r.bootstrap !== process.argv[2] + "/bootstrap.env") fail("the receipt bootstrap is not inside its state directory");
if (r.unit_name !== "reach-mcp-client.service") fail("the receipt names a unit that is not the REACH unit");
if (r.service_user !== null && !(typeof r.service_user === "string" && /^[a-z0-9_-]+$/.test(r.service_user))) fail("the receipt has a bad service user");
if (!r.owned || typeof r.owned !== "object") fail("the receipt has no ownership flags");
process.stdout.write([r.install_dir, r.bootstrap, r.root, r.unit_dir, r.unit_name, r.service_user ?? "", r.owned.state_dir ? 1 : 0, r.owned.root ? 1 : 0, r.owned.service_user ? 1 : 0].join("\n") + "\n");
'
read_receipt="$("$node_bin" -e "$READ" "$receipt" "$state_dir")" || exit 2
field() { printf '%s\n' "$read_receipt" | sed -n "$1p"; }
install_dir="$(field 1)" bootstrap="$(field 2)" root="$(field 3)" unit_dir="$(field 4)" unit_name="$(field 5)" service_user="$(field 6)"
own_state="$(field 7)" own_root="$(field 8)" own_user="$(field 9)"
root="${root%/}"
[ "$root" != "${install_dir%/}" ] || die "the receipt root is the install directory"

# The service: only a unit that runs the REACH launcher from the recorded install directory is stopped and removed.
unit="$unit_dir/$unit_name"
if [ -e "$unit" ]; then
  grep '^ExecStart=' "$unit" | grep -Fq "\"${install_dir%/}/reach-client.mjs\"" || die "$unit does not run the REACH Client from $install_dir: refusing to remove it"
  if [ "$system" = 1 ]; then systemctl disable --now "$unit_name" >/dev/null 2>&1 || true; fi
  rm -f "$unit"
  if [ "$system" = 1 ]; then systemctl daemon-reload; fi
fi

# The runtime: only a directory that holds the REACH launcher.
if [ -e "$install_dir" ]; then
  [ -f "${install_dir%/}/reach-client.mjs" ] || die "$install_dir is not a REACH Client install: refusing to remove it"
  rm -rf "$install_dir"
fi

# The bootstrap carries the Client's id and private key: it goes with the install. The root is removed only when REACH created it and it is empty.
rm -f "$bootstrap"
kept=""
if [ "$own_root" = 1 ] && [ -d "$root" ]; then rmdir "$root" 2>/dev/null || kept="$kept $root"; fi
if [ "$own_user" = 1 ] && [ -n "$service_user" ] && [ "$system" = 1 ] && id "$service_user" >/dev/null 2>&1; then userdel "$service_user" >/dev/null 2>&1 || kept="$kept account:$service_user"; fi
rm -f "$receipt"
if [ "$own_state" = 1 ] && [ -d "$state_dir" ]; then rmdir "$state_dir" 2>/dev/null || kept="$kept $state_dir"; fi
echo "REACH Client uninstalled.${kept:+ Left in place (not empty or not removable):$kept}"
echo "The Server still lists this Client until an administrator removes it there."
