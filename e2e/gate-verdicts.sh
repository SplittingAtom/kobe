#!/usr/bin/env bash
# Every gate run's own verdict (KOBE-232): each log in <dir> (CI's gate-log-* artifacts: gate1..3,
# gate4, restore, gate5-a/b) must end its run with a verdict line, and none may say FAILED. A run
# that stopped before its verdict (its log has none) fails too. CI's `stories` job runs this before
# the per-story verdict (e2e/gate4.sh), so a gate's FAILED can never pass unseen again.
#   e2e/gate-verdicts.sh <dir>
set -euo pipefail

dir="${1:?usage: e2e/gate-verdicts.sh <dir of gate logs>}"
shopt -s nullglob
logs=("$dir"/*.log)
if ((${#logs[@]} == 0)); then
  echo "FAIL no gate logs in $dir"
  exit 1
fi
# The verdict lines the harnesses print (e2e/lib/gate-common.sh `verdict`).
VERDICT='^Gate [0-9]( suite| stories| restore)?: '
bad=0
for log in "${logs[@]}"; do
  name=$(basename "$log" .log)
  line=$(grep -E "$VERDICT" "$log" | tail -1 || true)
  if [[ -z "$line" ]]; then
    echo "FAIL $name: no verdict line (the run stopped before it); last lines:"
    tail -5 "$log" | sed 's/^/       /'
    bad=1
  elif [[ "$line" == *": FAILED"* ]]; then
    echo "FAIL $name: $line"
    grep -E '^(FAIL|XPASS|INVALID|NOTRUN) ' "$log" | head -20 | cut -c1-240 | sed 's/^/       /' || true
    bad=1
  else
    echo "ok   $name: $line"
  fi
done
exit "$bad"
