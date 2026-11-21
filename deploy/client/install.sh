#!/bin/sh
# The public one-line REACH Client installer for Linux, served by the Server as /install.sh and declared in the release manifest.
#   curl -fsSL http://<server>/install.sh | sudo sh -s -- --server-origin http://<server>
# It never guesses the Server: the origin is the one argument. It reads the release manifest (schema v2) from that origin, selects the one
# client/linux/<arch> artifact, downloads it from the manifest's relative path, verifies size and SHA-256, and hands the archive to the
# low-level machine installer it carries (deploy/install-linux.sh, the sole owner of the swap and the systemd unit). It writes a bootstrap
# with only the endpoint and a root anchor. The Client generates its own id and private key on first start; nothing here makes or sees them.
# Prerequisites: curl, tar, systemd and Node >= 24 (the Client runtime itself needs it; the script also uses it to read the manifest).
set -eu

SERVICE_USER=reach-mcp
DEFAULT_STATE_DIR=/var/lib/reach-mcp-client
DEFAULT_INSTALL_DIR=/opt/reach-mcp-client
DEFAULT_UNIT_DIR=/etc/systemd/system

usage() {
  cat >&2 <<EOF
usage: install.sh --server-origin http://<host>[:<port>] [--root <abs-dir>] [--state-dir <abs-dir>] [--install-dir <abs-dir>] [--unit-dir <abs-dir>] [--allow-whole-disk] [--test-no-system]
  --root         the one physical root the Client may serve; default <state-dir>/root (any directory, including /)
  --allow-whole-disk  required to share / (the whole disk) as the root; without it the installer stops and shows the warning
  --test-no-system  tests only: no account, ownership or systemd change; the unit is written and not started
EOF
  exit 2
}

die() {
  echo "install.sh: $1" >&2
  exit 2
}

origin="" root="" root_given="" whole_disk="" state_dir="$DEFAULT_STATE_DIR" install_dir="$DEFAULT_INSTALL_DIR" unit_dir="$DEFAULT_UNIT_DIR" system=1
while [ $# -gt 0 ]; do
  case "$1" in
    --test-no-system) system=0; shift; continue ;;
    --allow-whole-disk) whole_disk=1; shift; continue ;;
    --server-origin | --root | --state-dir | --install-dir | --unit-dir) [ $# -ge 2 ] || usage ;;
    *) usage ;;
  esac
  case "$1" in
    --server-origin) origin="$2" ;;
    --root) root="$2"; root_given=1 ;;
    --state-dir) state_dir="$2" ;;
    --install-dir) install_dir="$2" ;;
    --unit-dir) unit_dir="$2" ;;
  esac
  shift 2
done
[ -n "$origin" ] || usage

# A plain http:// authority: host name, IPv4 or bracketed IPv6, an optional port, an optional trailing slash, nothing else.
origin="${origin%/}"
case "$origin" in
  http://*) authority="${origin#http://}" ;;
  *) die "--server-origin must be http://<host>[:<port>]" ;;
esac
[ -n "$authority" ] || die "--server-origin has no host"
case "$authority" in
  *[!A-Za-z0-9.:\[\]-]*) die "--server-origin must be a plain host[:port] with no credentials, path, query or fragment" ;;
  [-.:]* | *[-.]) die "--server-origin is not a valid host" ;;
esac
case "$authority" in
  *:*[!0-9]*) case "$authority" in \[*\]*) ;; *) die "--server-origin has a bad port" ;; esac ;;
esac

abs_path() {
  case "$2" in
    /*) ;;
    *) die "$1 must be an absolute path" ;;
  esac
  [ "$2" != / ] || die "$1 must not be /"
  case "$2" in
    *[!A-Za-z0-9._/-]*) die "$1 may contain only letters, digits and . _ / -" ;;
  esac
  case "$2/" in
    */../* | */./* | *//*) die "$1 must not contain empty, . or .. segments" ;;
  esac
  # Depth is not a safety property: /scope, /data or /projects are valid. Only / itself is refused. Protection against replacing a
  # directory that is not REACH's is by ownership below (state directory here, install directory and unit file in install-linux.sh).
}
abs_path --state-dir "$state_dir"
abs_path --install-dir "$install_dir"
abs_path --unit-dir "$unit_dir"
state_dir="${state_dir%/}"
if [ -d "$state_dir" ] && [ -n "$(ls -A "$state_dir")" ] && [ ! -f "$state_dir/install-receipt.json" ] && [ ! -f "$state_dir/bootstrap.env" ]; then
  die "$state_dir exists, is not empty and is not a REACH Client state directory: refusing to use it"
fi
[ -n "$root" ] || root="$state_dir/root"
if [ "$root" = / ]; then
  echo "install.sh: WARNING: --root / shares the WHOLE DISK of this machine with the REACH Server (as C:\\ would on Windows)." >&2
  [ -n "$whole_disk" ] || die "to confirm it, run again with --allow-whole-disk"
else
  abs_path --root "$root"
  root="${root%/}"
fi

[ "$(uname -s)" = Linux ] || die "this installer supports Linux only"
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  *) die "unsupported architecture $(uname -m): only x86_64 is supported" ;;
esac
command -v curl >/dev/null 2>&1 || die "curl was not found"
command -v tar >/dev/null 2>&1 || die "tar was not found"
node_bin="$(command -v node)" || die "Node >= 24 was not found on PATH (sudo may reset PATH: pass it through or install a system Node)"
[ "$("$node_bin" -p 'process.versions.node.split(".")[0]')" -ge 24 ] 2>/dev/null || die "Node >= 24 is required, found $("$node_bin" -v)"
[ "$system" = 0 ] || [ "$(id -u)" = 0 ] || die "run as root (sudo sh)"

# Ownership is decided before the first change: what this installer creates is recorded as owned, anything that already existed is never claimed.
# A rerun keeps the original flags and the root of the first install; a different --root has to wait for an uninstall.
receipt="$state_dir/install-receipt.json"
own_state=0 own_root=0 own_user=0
if [ -f "$receipt" ]; then
  READ_RECEIPT='
const fs = require("node:fs");
let r;
try { r = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { process.exit(2); }
if (r.schema_version !== 1 || r.platform !== "linux" || typeof r.root !== "string" || !r.owned) process.exit(2);
for (const k of ["install_dir", "state_dir", "bootstrap", "unit_dir"]) if (typeof r[k] !== "string") process.exit(2);
if (r.unit_name !== "reach-mcp-client.service" || r.bootstrap !== r.state_dir + "/bootstrap.env") process.exit(2);
process.stdout.write([r.root, r.owned.state_dir ? 1 : 0, r.owned.root ? 1 : 0, r.owned.service_user ? 1 : 0, r.install_dir, r.unit_dir, r.state_dir].join("\n") + "\n");
'
  prior="$("$node_bin" -e "$READ_RECEIPT" "$receipt")" || die "the install receipt $receipt is unreadable"
  prior_root="$(printf '%s\n' "$prior" | sed -n 1p)"
  own_state="$(printf '%s\n' "$prior" | sed -n 2p)" own_root="$(printf '%s\n' "$prior" | sed -n 3p)" own_user="$(printf '%s\n' "$prior" | sed -n 4p)"
  # The receipt is the identity of one installation: its runtime and unit coordinates cannot be redefined by a rerun.
  prior_install="$(printf '%s\n' "$prior" | sed -n 5p)" prior_unit_dir="$(printf '%s\n' "$prior" | sed -n 6p)" prior_state="$(printf '%s\n' "$prior" | sed -n 7p)"
  [ "$prior_state" = "${state_dir%/}" ] || die "the install receipt $receipt belongs to another state directory"
  if [ "${install_dir%/}" != "$prior_install" ]; then die "this machine is already installed in $prior_install: uninstall first to change --install-dir"; fi
  if [ "${unit_dir%/}" != "$prior_unit_dir" ]; then die "this machine is already installed with units in $prior_unit_dir: uninstall first to change --unit-dir"; fi
  if [ -n "$root_given" ] && [ "$root" != "$prior_root" ]; then die "this machine is already installed with root $prior_root: uninstall first to change it"; fi
  root="$prior_root"
else
  [ -d "$state_dir" ] || own_state=1
  [ -d "$root" ] || own_root=1
  if [ "$system" = 1 ] && ! id "$SERVICE_USER" >/dev/null 2>&1; then own_user=1; fi
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
chmod 700 "$work"

# One fetch policy: plain http to the given origin only, no redirect at all, so the origin can never be switched silently.
fetch() {
  curl -g --fail --silent --show-error --proto '=http' --max-redirs 0 --max-time 600 -o "$2" "$origin$1" || die "could not download $origin$1"
}

fetch /release/manifest "$work/manifest.json"

# Read and validate the manifest, select the one client/linux/<arch> entry. Prints: relative path, sha256, size, build id.
SELECT='
const fs = require("node:fs");
const fail = (m) => { process.stderr.write("install.sh: " + m + "\n"); process.exit(2); };
let m;
try { m = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { fail("the release manifest is not valid JSON"); }
if (m.schema_version !== 2) fail("unsupported release manifest schema_version " + m.schema_version + " (need 2)");
const hits = (Array.isArray(m.artifacts) ? m.artifacts : []).filter((a) => a && a.role === "client" && a.os === "linux" && a.arch === process.argv[2]);
if (hits.length !== 1) fail("the manifest must list exactly one client artifact for linux/" + process.argv[2] + ", found " + hits.length);
const a = hits[0];
const build = m.client && m.client.build_id;
if (typeof a.download_path !== "string" || !/^\/release\/artifacts\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(a.download_path)) fail("the manifest download_path is not a relative /release/artifacts/<name> path");
if (typeof a.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(a.sha256)) fail("the manifest sha256 is not 64 lowercase hex");
if (!Number.isSafeInteger(a.size_bytes) || a.size_bytes <= 0) fail("the manifest size_bytes is not a positive integer");
if (typeof build !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(build)) fail("the manifest client build id is not a plain identifier");
process.stdout.write([a.download_path, a.sha256, a.size_bytes, build].join("\n") + "\n");
'
selection="$("$node_bin" -e "$SELECT" "$work/manifest.json" "$arch")" || exit 2
download_path="$(printf '%s\n' "$selection" | sed -n 1p)"
want_sha="$(printf '%s\n' "$selection" | sed -n 2p)"
want_size="$(printf '%s\n' "$selection" | sed -n 3p)"
build="$(printf '%s\n' "$selection" | sed -n 4p)"

fetch "$download_path" "$work/client.tgz"
CHECK='
const fs = require("node:fs");
const { createHash } = require("node:crypto");
const bytes = fs.readFileSync(process.argv[1]);
if (bytes.length !== Number(process.argv[3])) { process.stderr.write("install.sh: the downloaded size " + bytes.length + " differs from the manifest " + process.argv[3] + "\n"); process.exit(2); }
if (createHash("sha256").update(bytes).digest("hex") !== process.argv[2]) { process.stderr.write("install.sh: the downloaded SHA-256 differs from the manifest\n"); process.exit(2); }
'
"$node_bin" -e "$CHECK" "$work/client.tgz" "$want_sha" "$want_size" || exit 2

# The verified archive carries the low-level installer: the one owner of the atomic swap and the unit.
tar -xzf "$work/client.tgz" -C "$work" --no-same-owner reach-client/deploy/install-linux.sh || die "the archive has no reach-client/deploy/install-linux.sh"

# A unit of that name that does not run the REACH launcher is someone else's: refuse before the first change (the low-level installer checks again).
if [ -e "$unit_dir/reach-mcp-client.service" ] && ! grep '^ExecStart=' "$unit_dir/reach-mcp-client.service" | grep -Fq "\"${install_dir%/}/reach-client.mjs\""; then
  die "$unit_dir/reach-mcp-client.service exists and is not a REACH Client unit: refusing to overwrite it"
fi

# Machine changes start here, after everything above was validated.
bootstrap="$state_dir/bootstrap.env"
if [ "$system" = 1 ] && ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$state_dir" --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi
# An older install without a receipt keeps its bootstrap and its root untouched: no new path is created for it.
if [ ! -f "$bootstrap" ] || [ -f "$receipt" ]; then
  mkdir -p "$state_dir" "$root"
  chmod 700 "$state_dir"
  # Only a root this install created is restricted; an existing root (for example a shared project tree) keeps its owner and mode.
  if [ "$own_root" = 1 ]; then chmod 700 "$root"; fi
fi
ws="ws://$authority/client"
if [ -f "$bootstrap" ]; then
  # A rerun keeps the identity and the root; only the endpoint follows the origin given now.
  if ! grep -qx "REACH_SERVER_URL=$ws" "$bootstrap"; then
    sed "s|^REACH_SERVER_URL=.*|REACH_SERVER_URL=$ws|" "$bootstrap" >"$bootstrap.tmp.$$"
    chmod 600 "$bootstrap.tmp.$$"
    mv "$bootstrap.tmp.$$" "$bootstrap"
  fi
else
  # The restrictive umask is only for the bootstrap: it must not leak into the low-level installer, whose extracted tree the service user has to read.
  (umask 077; printf 'REACH_SERVER_URL=%s\nREACH_ROOTS=["%s"]\n' "$ws" "$root" >"$bootstrap")
fi
if [ "$system" = 1 ]; then chown -R "$SERVICE_USER:$SERVICE_USER" "$state_dir"; fi

set -- --archive "$work/client.tgz" --bootstrap "$bootstrap" --build "$build" --install-dir "$install_dir" --unit-dir "$unit_dir" --node "$node_bin" --allow-insecure-ws
if [ "$system" = 1 ]; then set -- "$@" --user "$SERVICE_USER" --enable; fi
sh "$work/reach-client/deploy/install-linux.sh" "$@"

# The receipt is written only after a successful install and holds no identity or secret: it is what the uninstaller trusts.
WRITE_RECEIPT='
const fs = require("node:fs");
const [file, installDir, stateDir, bootstrap, root, unitDir, user, ownState, ownRoot, ownUser] = process.argv.slice(1);
const receipt = { schema_version: 1, platform: "linux", install_dir: installDir, state_dir: stateDir, bootstrap, root, unit_dir: unitDir, unit_name: "reach-mcp-client.service", service_user: user === "" ? null : user, owned: { state_dir: ownState === "1", root: ownRoot === "1", service_user: ownUser === "1" } };
fs.writeFileSync(file + ".tmp", JSON.stringify(receipt, null, 2) + "\n");
fs.renameSync(file + ".tmp", file);
'
if [ "$system" = 1 ]; then receipt_user="$SERVICE_USER"; else receipt_user=""; fi
"$node_bin" -e "$WRITE_RECEIPT" "$receipt" "$install_dir" "$state_dir" "$bootstrap" "$root" "$unit_dir" "$receipt_user" "$own_state" "$own_root" "$own_user"
echo "To remove it later: sudo sh \"$install_dir/deploy/uninstall-linux.sh\" --state-dir \"$state_dir\""
echo "REACH Client installed. It registers with $origin as Pending; an administrator must Enable it in the Admin UI."
