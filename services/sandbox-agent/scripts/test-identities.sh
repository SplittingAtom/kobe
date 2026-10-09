#!/usr/bin/env bash
# KOBE-71: runs src/identities.real.test.ts against the real kobe-runas helper (Linux, needs sudo,
# gcc and setcap). Builds the helper for the current user (agent uid = this uid, workspace group =
# this user's group), installs it root-owned with cap_setuid,cap_setgid and executable by a
# dedicated group only, and runs the tests with that group and the Pi identity groups 2000-2003 and their partner groups 3000-3003 as
# supplementary groups, exactly as a sandbox pod gives them to the agent. CI runs it (ci.yml).
# KOBE-167: also runs the tool executor under the real helper (src/exec.real.test.ts) and the
# KOBE-165 provider-redirect cases with real Pi as a Pi identity and its tools in the executor as
# the partner uid (src/kobe-models.redirect.real-pi.test.ts, "KOBE-167" describe). Those need the
# build (`pnpm build`: the executor and the extensions run as compiled files) and the pinned Pi
# (`npm ci --prefix images/sandbox/pi`), and the identities' uids must be able to reach this
# checkout and node: in CI the directories on the way get "search" for others (below).
set -euo pipefail
cd "$(dirname "$0")/.."
uid=$(id -u)
gid=$(id -g)
# The tests kill every process of these uids: they must not belong to anything else here.
if ps -eo uid=,stat= | awk '(($1 >= 2000 && $1 <= 2003) || ($1 >= 3000 && $1 <= 3003)) && $2 !~ /^Z/ { found = 1 } END { exit !found }'; then
  echo "uids 2000-2003 or 3000-3003 have processes here: refusing to use them" >&2
  exit 1
fi
if [ ! -f dist/exec/executor/main.js ]; then
  echo "dist/ is not built: run pnpm build first (the executor runs as a compiled file)" >&2
  exit 1
fi
work=$(mktemp -d)
helper=/usr/local/libexec/kobe-runas-test
reclaim=/usr/local/libexec/kobe-reclaim
cleanup() {
  rm -rf "$work"
  # Nothing of the test may outlive it on the machine: helper, group, the identities' leftovers.
  for id in 2000 2001 2002 2003 3000 3001 3002 3003; do sudo pkill -KILL -u "$id" 2>/dev/null || true; done
  sudo rm -f "$helper" "$reclaim" /tmp/k71-secret-* 2>/dev/null || true
  sudo groupdel kobe-test-agent 2>/dev/null || true
}
trap cleanup EXIT
# CI only: let the identities' uids traverse (never read or write) the directories to the checkout and
# node. `a+x`, not `o+x`: the partner uids hold the workspace group, which is this user's group, and a
# group class without `x` denies even when `other` has it.
open_path() {
  local d
  d=$(cd "$1" && pwd -P)
  while [ "$d" != / ]; do
    sudo chmod a+x "$d"
    d=$(dirname "$d")
  done
}
if [ -n "${CI:-}" ]; then
  open_path "$PWD"
  open_path "$(dirname "$(command -v node)")"
fi
gcc -std=c11 -O2 -Wall -Wextra -Werror -D_FORTIFY_SOURCE=2 -fstack-protector-strong \
  -DKOBE_AGENT_UID="$uid" -DKOBE_WORKSPACE_GID="$gid" \
  -o "$work/kobe-runas" ../../images/sandbox/runas/kobe-runas.c
sudo groupadd -f kobe-test-agent
agent_gid=$(getent group kobe-test-agent | cut -d: -f3)
sudo install -d -m 0755 /usr/local/libexec
sudo install -o root -g "$agent_gid" -m 0750 "$work/kobe-runas" "$helper"
sudo install -o root -g root -m 0755 ../../images/sandbox/runas/kobe-reclaim.sh "$reclaim"
sudo setcap cap_setuid,cap_setgid=ep "$helper"
# One test file at a time: the suites share the identity pool and each kills the uids it used.
run_tests() {
  sudo env PATH="$PATH" HOME="$HOME" CI=true KOBE_TEST_PI_RUNAS="$helper" \
    setpriv --reuid="$uid" --regid="$gid" --groups="$gid,$agent_gid,2000,2001,2002,2003,3000,3001,3002,3003" \
    --inh-caps=-all -- "$(command -v node)" ../../node_modules/vitest/vitest.mjs run --no-file-parallelism "$@"
}
status=0
run_tests src/identities.real.test.ts src/identities.partner.real.test.ts src/exec.real.test.ts "$@" || status=$?
# Real Pi with its tools in the partner-uid executor; the raw-Pi cases of that file run in `pnpm test`.
run_tests src/kobe-models.redirect.real-pi.test.ts -t "KOBE-167" "$@" || status=$?
exit "$status"
