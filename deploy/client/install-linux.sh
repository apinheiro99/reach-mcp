#!/usr/bin/env bash
# Machine-level REACH Client install for Linux, from the release artifact (reach-client-linux-x64.tgz): one Client per machine,
# never per project. The install directory and the bootstrap file are separate: binaries go to the install directory, while the
# endpoint, Client id, private key and root anchors stay only in the operator's protected bootstrap file, which this script never
# reads or copies. Install and update are explicit operator actions; nothing here updates itself.
set -eu

DEFAULT_INSTALL_DIR=/opt/reach-mcp-client
UNIT_NAME=reach-mcp-client.service
TOP=reach-client

usage() {
  cat >&2 <<EOF
usage: install-linux.sh --archive <reach-client-linux-x64.tgz> --bootstrap <abs-file> --build <id>
                        [--install-dir <abs-dir>] [--unit-dir <abs-dir>] [--node <abs-file>] [--user <name>]
                        [--allow-insecure-ws] [--enable]
  --install-dir  default $DEFAULT_INSTALL_DIR (an explicit operator choice, never a Server setting)
  --unit-dir     default /etc/systemd/system; the unit is written there, systemd is only touched with --enable
  --enable       daemon-reload, then enable and start $UNIT_NAME
EOF
  exit 2
}

die() {
  echo "install-linux: $1" >&2
  exit 2
}

archive="" bootstrap="" build="" install_dir="$DEFAULT_INSTALL_DIR" unit_dir=/etc/systemd/system node_bin="" run_user="" insecure=0 enable=0
while [ $# -gt 0 ]; do
  case "$1" in
    --allow-insecure-ws) insecure=1; shift; continue ;;
    --enable) enable=1; shift; continue ;;
    --archive | --bootstrap | --build | --install-dir | --unit-dir | --node | --user) [ $# -ge 2 ] || usage ;;
    *) usage ;;
  esac
  case "$1" in
    --archive) archive="$2" ;;
    --bootstrap) bootstrap="$2" ;;
    --build) build="$2" ;;
    --install-dir) install_dir="$2" ;;
    --unit-dir) unit_dir="$2" ;;
    --node) node_bin="$2" ;;
    --user) run_user="$2" ;;
  esac
  shift 2
done
[ -n "$archive" ] && [ -n "$bootstrap" ] && [ -n "$build" ] || usage

# An absolute, plain path with at least two segments, so "/" and "/usr" are never an install target.
check_path() {
  case "$2" in
    /*) ;;
    *) die "$1 must be an absolute path" ;;
  esac
  case "$2" in
    *[!A-Za-z0-9._/\ -]*) die "$1 may contain only letters, digits, space and . _ / -" ;;
  esac
  case "$2/" in
    */../* | */./* | *//*) die "$1 must not contain empty, . or .. segments" ;;
  esac
  case "${2#/}" in
    */*) ;;
    *) die "$1 must be at least two segments deep" ;;
  esac
}

check_path --install-dir "$install_dir"
check_path --bootstrap "$bootstrap"
check_path --unit-dir "$unit_dir"
install_dir="${install_dir%/}"
case "$bootstrap/" in
  "$install_dir"/*) die "--bootstrap must live outside the install directory (the bootstrap is not part of the install)" ;;
esac
case "$build" in
  [A-Za-z0-9]*) ;;
  *) die "--build must start with a letter or digit" ;;
esac
case "$build" in
  *[!A-Za-z0-9._-]*) die "--build may contain only letters, digits and . _ -" ;;
esac
[ "${#build}" -le 128 ] || die "--build is longer than 128 characters"
[ -z "$run_user" ] || case "$run_user" in
  *[!a-z0-9_-]*) die "--user is not a plain account name" ;;
esac
[ -f "$archive" ] || die "--archive is not a file"
if [ -z "$node_bin" ]; then
  node_bin="$(command -v node)" || die "node was not found; pass --node <abs-file>"
fi
check_path --node "$node_bin"
[ -x "$node_bin" ] || die "--node is not executable"

# The archive must hold one top directory and only regular files and directories under it.
tar -tzf "$archive" | while IFS= read -r entry; do
  case "$entry" in
    "$TOP"/* | "$TOP"/) ;;
    *) die "archive entry outside $TOP/: refusing the archive" ;;
  esac
  case "/$entry" in
    */../*) die "archive entry with a .. segment: refusing the archive" ;;
  esac
done
if tar -tvzf "$archive" | grep -q '^[lh]'; then die "archive contains a link: refusing the archive"; fi

if [ -e "$install_dir" ] && [ -n "$(ls -A "$install_dir")" ] && [ ! -f "$install_dir/$TOP.mjs" ]; then
  die "$install_dir exists, is not empty and is not a REACH Client install: refusing to replace it"
fi

parent="$(dirname "$install_dir")"
mkdir -p "$parent" "$unit_dir"
stage="$install_dir.new.$$"
old="$install_dir.old.$$"
trap 'rm -rf "$stage" "$old"' EXIT
mkdir "$stage"
tar -xzf "$archive" -C "$stage" --no-same-owner
[ -f "$stage/$TOP/$TOP.mjs" ] || die "archive has no $TOP/$TOP.mjs launcher"

# Replace: a failure before the swap leaves the previous install untouched; the old tree is removed only after the new one is in place.
if [ -e "$install_dir" ]; then mv "$install_dir" "$old"; fi
if ! mv "$stage/$TOP" "$install_dir"; then
  if [ -e "$old" ]; then mv "$old" "$install_dir"; fi
  die "could not move the new install into place; the previous install was restored"
fi

unit="$unit_dir/$UNIT_NAME"
{
  echo "# REACH MCP Client, installed from a release artifact. The endpoint, Client id, private key and root anchors live only in the bootstrap file."
  echo "[Unit]"
  echo "Description=REACH MCP Client"
  echo "After=network-online.target"
  echo "Wants=network-online.target"
  echo
  echo "[Service]"
  echo "Type=simple"
  if [ -n "$run_user" ]; then echo "User=$run_user"; fi
  line="ExecStart=\"$node_bin\" \"$install_dir/$TOP.mjs\" --bootstrap \"$bootstrap\" --build $build"
  if [ "$insecure" = 1 ]; then line="$line --allow-insecure-ws"; fi
  echo "$line"
  echo "Restart=on-failure"
  echo "RestartSec=2"
  echo
  echo "[Install]"
  echo "WantedBy=multi-user.target"
} >"$unit.tmp"
chmod 0644 "$unit.tmp"
mv "$unit.tmp" "$unit"

if [ "$enable" = 1 ]; then
  systemctl daemon-reload
  systemctl enable --now "$UNIT_NAME"
fi
echo "installed $install_dir, unit $unit"
