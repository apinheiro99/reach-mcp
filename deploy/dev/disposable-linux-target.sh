#!/usr/bin/env bash
# Disposable Linux target for developing and proving machine-level Client installs without touching a real machine.
# Test/development tooling only: nothing in the product, the release or the public architecture depends on it.
#
# A target is a private temporary directory plus Linux user, mount and PID namespaces (util-linux `unshare`, no root, no Docker).
# Inside a target the canonical paths work unchanged, so the real installer runs with its defaults:
#   /opt                   -> <target>/opt            (the default install directory /opt/reach-mcp-client lands here)
#   /etc/systemd/system    -> <target>/units          (the installer writes the unit here; systemd itself is NOT running)
#   /mnt                   -> <target>/stage          (artifacts put in from the host, and the bootstrap file)
#   /tmp                   -> <target>/tmp
#   /usr/local             -> the host's Node.js prefix, read-only (a Client machine needs Node >= 24; override with REACH_TARGET_NODE_PREFIX)
#   /home, /root, /scope, /reach are empty tmpfs mounts: no host home, key, checkout or share is visible. $HOME=/home/reach.
# Everything a Client generates (its identity key in the bootstrap file) lives only under <target>, and destroy removes it.
#
# Limits that Task #74 must account for: there is no init system, so systemctl/systemd behavior (enable, restart on failure,
# boot start) cannot be proven here and needs a different proof; the network namespace is the host's (the Server's service plane
# is reached as the host reaches it, and the Server sees the peer as the host's address); the host filesystem outside the paths
# above stays readable (read-only use is not enforced), which is why no host secret may be passed in.
set -eu

PREFIX=reach-target
BASE="${REACH_TARGET_ROOT:-${TMPDIR:-/tmp}}"

usage() {
  cat >&2 <<'EOF'
usage: disposable-linux-target.sh create
       disposable-linux-target.sh put <name> <abs-file> [<file-name>]   copy a host file into the target at /mnt/<file-name>
       disposable-linux-target.sh run <name> [--detach] -- <command> [args...]
       disposable-linux-target.sh status [<name>]
       disposable-linux-target.sh destroy <name>
EOF
  exit 2
}

die() {
  echo "disposable-linux-target: $1" >&2
  exit 2
}

[ "${BASE#/}" != "$BASE" ] || die "REACH_TARGET_ROOT/TMPDIR must be an absolute path"

# A name is the fixed prefix plus six characters; nothing else ever reaches a path or a kill.
target_dir() {
  case "$1" in
    "$PREFIX"-[A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9]) ;;
    *) die "not a target name" ;;
  esac
  dir="$BASE/$1"
  [ -d "$dir" ] && [ -f "$dir/.target" ] || die "no such target: $1"
  echo "$dir"
}

alive() { kill -0 "$1" 2>/dev/null; }

cmd_create() {
  command -v unshare >/dev/null || die "unshare (util-linux) is required"
  unshare --map-root-user --mount --pid --fork true 2>/dev/null || die "unprivileged user/mount/PID namespaces are not available on this host"
  dir="$(mktemp -d "$BASE/$PREFIX-XXXXXX")"
  chmod 700 "$dir"
  mkdir "$dir/opt" "$dir/units" "$dir/stage" "$dir/tmp" "$dir/pids"
  : >"$dir/.target"
  basename "$dir"
}

cmd_put() {
  [ $# -ge 2 ] || usage
  dir="$(target_dir "$1")"
  case "$2" in /*) ;; *) die "the file must be an absolute path" ;; esac
  [ -f "$2" ] || die "not a file"
  dest="${3:-$(basename "$2")}"
  case "$dest" in "" | */* | .*) die "the target file name must be a plain name" ;; esac
  cp "$2" "$dir/stage/$dest"
}

# The setup that runs inside the namespaces, then replaces itself with the command.
INSIDE='
set -eu
d="$1"; node_prefix="$2"; shift 2
mount --bind "$node_prefix" /usr/local
mount -o remount,bind,ro /usr/local
mount --bind "$d/opt" /opt
mount --bind "$d/units" /etc/systemd/system
mount --bind "$d/stage" /mnt
mount --bind "$d/tmp" /tmp
for hidden in /home /root /scope /reach; do
  if [ -d "$hidden" ]; then mount -t tmpfs tmpfs "$hidden"; fi
done
mkdir -p /home/reach
exec env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/home/reach TMPDIR=/tmp LANG=C "$@"
'

node_prefix() {
  if [ -n "${REACH_TARGET_NODE_PREFIX:-}" ]; then echo "$REACH_TARGET_NODE_PREFIX"; return; fi
  node_path="$(command -v node)" || die "node was not found; set REACH_TARGET_NODE_PREFIX"
  dirname "$(dirname "$(readlink -f "$node_path")")"
}

cmd_run() {
  [ $# -ge 3 ] || usage
  dir="$(target_dir "$1")"
  shift
  detach=0
  if [ "$1" = "--detach" ]; then detach=1; shift; fi
  [ "$1" = "--" ] || usage
  shift
  [ $# -ge 1 ] || usage
  prefix="$(node_prefix)"
  [ -x "$prefix/bin/node" ] || die "the Node.js prefix has no bin/node"
  if [ "$detach" = 1 ]; then
    unshare --map-root-user --mount --pid --fork --kill-child --mount-proc bash -c "$INSIDE" inside "$dir" "$prefix" "$@" >"$dir/tmp/detached.log" 2>&1 &
    echo "$!" >"$dir/pids/$!"
    echo "$!"
  else
    unshare --map-root-user --mount --pid --fork --kill-child --mount-proc bash -c "$INSIDE" inside "$dir" "$prefix" "$@"
  fi
}

cmd_status() {
  if [ $# -ge 1 ]; then
    dir="$(target_dir "$1")"
    running=0
    for f in "$dir"/pids/*; do [ -e "$f" ] && alive "${f##*/}" && running=$((running + 1)); done
    echo "$1 running=$running"
    return
  fi
  for d in "$BASE/$PREFIX"-*; do
    if [ -f "$d/.target" ]; then basename "$d"; fi
  done
}

cmd_destroy() {
  [ $# -eq 1 ] || usage
  dir="$(target_dir "$1")"
  for f in "$dir"/pids/*; do
    [ -e "$f" ] || continue
    pid="${f##*/}"
    if alive "$pid"; then
      kill "$pid" 2>/dev/null || true
      for _ in 1 2 3 4 5 6 7 8 9 10; do alive "$pid" || break; sleep 0.2; done
      if alive "$pid"; then kill -9 "$pid" 2>/dev/null || true; fi
    fi
  done
  rm -rf "$dir"
  [ ! -e "$dir" ] || die "could not remove the target directory"
  echo "destroyed $1"
}

[ $# -ge 1 ] || usage
sub="$1"
shift
case "$sub" in
  create) cmd_create "$@" ;;
  put) cmd_put "$@" ;;
  run) cmd_run "$@" ;;
  status) cmd_status "$@" ;;
  destroy) cmd_destroy "$@" ;;
  *) usage ;;
esac
