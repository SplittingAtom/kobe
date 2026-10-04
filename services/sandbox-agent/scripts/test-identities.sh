#!/usr/bin/env bash
# KOBE-71: runs src/identities.real.test.ts against the real kobe-runas helper (Linux, needs sudo,
# gcc and setcap). Builds the helper for the current user (agent uid = this uid, workspace group =
# this user's group), installs it root-owned with cap_setuid,cap_setgid and executable by a
# dedicated group only, and runs the tests with that group and the Pi identity groups 2000-2003 as
# supplementary groups, exactly as a sandbox pod gives them to the agent. CI runs it (ci.yml).
set -euo pipefail
cd "$(dirname "$0")/.."
uid=$(id -u)
gid=$(id -g)
# The tests kill every process of these uids: they must not belong to anything else here.
if ps -eo uid=,stat= | awk '$1 >= 2000 && $1 <= 2003 && $2 !~ /^Z/ { found = 1 } END { exit !found }'; then
  echo "uids 2000-2003 have processes here: refusing to use them" >&2
  exit 1
fi
work=$(mktemp -d)
helper=/usr/local/libexec/kobe-runas-test
reclaim=/usr/local/libexec/kobe-reclaim
cleanup() {
  rm -rf "$work"
  # Nothing of the test may outlive it on the machine: helper, group, the identities' leftovers.
  for id in 2000 2001 2002 2003; do sudo pkill -KILL -u "$id" 2>/dev/null || true; done
  sudo rm -f "$helper" "$reclaim" /tmp/k71-secret-* 2>/dev/null || true
  sudo groupdel kobe-test-agent 2>/dev/null || true
}
trap cleanup EXIT
gcc -std=c11 -O2 -Wall -Wextra -Werror -D_FORTIFY_SOURCE=2 -fstack-protector-strong \
  -DKOBE_AGENT_UID="$uid" -DKOBE_WORKSPACE_GID="$gid" \
  -o "$work/kobe-runas" ../../images/sandbox/runas/kobe-runas.c
sudo groupadd -f kobe-test-agent
agent_gid=$(getent group kobe-test-agent | cut -d: -f3)
sudo install -d -m 0755 /usr/local/libexec
sudo install -o root -g "$agent_gid" -m 0750 "$work/kobe-runas" "$helper"
sudo install -o root -g root -m 0755 ../../images/sandbox/runas/kobe-reclaim.sh "$reclaim"
sudo setcap cap_setuid,cap_setgid=ep "$helper"
sudo env PATH="$PATH" HOME="$HOME" KOBE_TEST_PI_RUNAS="$helper" \
  setpriv --reuid="$uid" --regid="$gid" --groups="$gid,$agent_gid,2000,2001,2002,2003" \
  --inh-caps=-all -- "$(command -v node)" ../../node_modules/vitest/vitest.mjs run src/identities.real.test.ts "$@"
