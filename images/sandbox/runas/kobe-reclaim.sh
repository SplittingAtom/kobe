#!/bin/sh
# kobe-reclaim (KOBE-71): run by kobe-sandbox-agent through kobe-runas, as a Pi identity whose
# processes are all gone, before that uid goes to another thread.
# Usage: kobe-reclaim <workspace gid> <dir>... [-- <purge dir>...]
#
# A recycled uid would otherwise own, and so be able to read, what the previous thread made
# owner-only. In the shared trees given (/workspace, $HOME, /tmp, /dev/shm; one filesystem each,
# -xdev) every file and directory this uid owns becomes the workspace group's, group-accessible
# like everything else there (D13), so the next holder of the uid gains nothing the other threads
# lack. Its System V IPC objects are removed (POSIX shared memory lives in /dev/shm, above).
# The purge dirs (the Pi runtime dir, a small sticky tmpfs) are different: nothing there is shared,
# so every top-level entry this uid owns is deleted (a leftover owner-only file would stay private
# to the uid's next holder, and a full tmpfs would keep any new Pi from starting).
# Owner-only directories (mode 000) are made traversable before find descends into them, so what
# is inside is reached. Exits 70 if anything this uid owns could not be reclaimed: the caller must
# then never hand the uid to another thread. Root-owned and read-only in the image.
set -u
gid=${1:?usage: kobe-reclaim <workspace gid> <dir>... [-- <purge dir>...]}
shift
case "$gid" in *[!0-9]*) echo "kobe-reclaim: bad gid" >&2; exit 64 ;; esac
uid=$(id -u)
failed=0
fail() { echo "kobe-reclaim: could not reclaim: $*" >&2; failed=1; }

# One pass per tree (a large workspace under gVisor is slow to walk): whatever this uid owns that
# is not yet the group's, or not group-rwx-accessible, gets both. Directories first become
# traversable (per directory, before find reads them: find tests an entry, then descends), files
# are batched. Links only change group (chmod would follow them). Each failing path is printed
# on stdout; find's own exit status is not used (it also fails on other threads' private dirs).
fix_tree() {
  find "$1" -xdev -user "$uid" \( ! -group "$gid" -o ! -perm -g=rw -o \( -type d ! -perm -u=rwx \) -o \( -type d ! -perm -g=x \) \) \
    \( \( -type d -exec sh -c 'g=$1; f=$2; chmod u+rwx,g+rwx "$f" && chgrp -h "$g" "$f" || echo "$f"' \
        kobe-reclaim "$gid" {} \; \) -o \
      \( ! -type d -exec sh -c 'g=$1; shift; for f; do chgrp -h "$g" "$f" || echo "$f"; [ -L "$f" ] || chmod g+rwX "$f" || echo "$f"; done' \
        kobe-reclaim "$gid" {} + \) \) 2>/dev/null
}

# Delete every top-level entry this uid owns (after making its directories traversable).
purge_dir() {
  for entry in "$1"/* "$1"/.[!.]* "$1"/..?*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    [ "$(stat -c %u "$entry" 2>/dev/null)" = "$uid" ] || continue
    [ -L "$entry" ] || [ ! -d "$entry" ] || find "$entry" -xdev -type d -exec chmod u+rwx {} \; 2>/dev/null
    rm -rf -- "$entry" 2>/dev/null
    if [ -e "$entry" ] || [ -L "$entry" ]; then echo "$entry"; fi
  done
}

while [ $# -gt 0 ] && [ "$1" != "--" ]; do
  if [ -d "$1" ]; then
    left=$(fix_tree "$1")
    [ -z "$left" ] || fail "$left"
  fi
  shift
done
[ $# -eq 0 ] || shift
for dir in "$@"; do
  [ -d "$dir" ] || continue
  left=$(purge_dir "$dir")
  [ -z "$left" ] || fail "$left"
done
# Only objects this uid owns can be removed by it; the rest are refused (ignored).
ipcrm --all 2>/dev/null
[ "$failed" -eq 0 ] || exit 70
exit 0
