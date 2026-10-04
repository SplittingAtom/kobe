#!/bin/sh
# kobe-reclaim (KOBE-71): run by kobe-sandbox-agent through kobe-runas, as a Pi identity whose
# processes are all gone, before that uid goes to another thread.
# Usage: kobe-reclaim <workspace gid> <dir>...
#
# A recycled uid would otherwise own, and so be able to read, what the previous thread made
# owner-only. In the shared trees given (/workspace, $HOME, /tmp, /dev/shm; one filesystem each,
# -xdev) every file and directory this uid owns becomes the workspace group's, group-accessible
# like everything else there (D13), so the next holder of the uid gains nothing the other threads
# lack. Its System V IPC objects are removed (POSIX shared memory lives in /dev/shm, above).
# Root-owned and read-only in the image; never fails the reclaim on an unreadable corner.
set -u
gid=${1:?usage: kobe-reclaim <workspace gid> <dir>...}
shift
case "$gid" in *[!0-9]*) echo "kobe-reclaim: bad gid" >&2; exit 64 ;; esac
uid=$(id -u)
for dir in "$@"; do
  [ -d "$dir" ] || continue
  find "$dir" -xdev -user "$uid" ! -group "$gid" -exec chgrp -h "$gid" {} + 2>/dev/null
  find "$dir" -xdev -user "$uid" -type d ! -perm -g=rwx -exec chmod g+rwx {} + 2>/dev/null
  find "$dir" -xdev -user "$uid" -type f ! -perm -g=rw -exec chmod g+rw {} + 2>/dev/null
done
# Only objects this uid owns can be removed by it; the rest are refused (ignored).
ipcrm --all 2>/dev/null
exit 0
