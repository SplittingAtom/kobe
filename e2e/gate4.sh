#!/usr/bin/env bash
# Gate 4 (KOBE-4, v1.0): the sixteen user stories (product spec §4, U1-U16), one verdict per story
# (KOBE-232). A story is proven by parts: sections of Gate 1-3's own runs (e2e/gate1.sh, gate2.sh,
# gate3.sh) where they prove it already, the checks no earlier gate makes (e2e/gate4/stories.sh) and,
# for U16's backup half, e2e/gate4-restore.sh (KOBE-233). Each part is a section of a run's output
# (from its `==> ` header to the next); it passes when it has checks and none failed. A story passes
# when every part does. docs/gates/gate-4.md lists the parts and what they prove.
#
#   e2e/gate4.sh                         run what the selected stories need, then the verdict
#   KOBE_GATE4_STORIES="U4 U7" ...       some stories only
#   KOBE_GATE4_LOGS=<dir> ...            reuse runs already made: <dir>/{gate1,gate2,gate3,gate4,restore}.log
#   KOBE_GATE4_VERDICT_ONLY=1 ...        no cluster: the verdict from KOBE_GATE4_LOGS (CI's `stories` job)
#
# The runs take KOBE_GATE4_NS, _RELEASE, _CONTEXT, _MODEL, _OWNER_EMAIL, _OWNER_PASSWORD and pass
# them on as each gate's own variables (KOBE_GATE1_NS, ...). A story with an expected failure
# (XFAIL, a filed product failure) prints XFAIL and fails only under KOBE_GATE_STRICT=1.
set -euo pipefail
cd "$(dirname "$0")/.."

STORIES="${KOBE_GATE4_STORIES:-U1 U2 U3 U4 U5 U6 U7 U8 U9 U10 U11 U12 U13 U14 U15 U16}"
LOGS="${KOBE_GATE4_LOGS:-}"
OUT="${KOBE_GATE4_OUT:-${LOGS:-$(mktemp -d)}}"
mkdir -p "$OUT"

# What each story's acceptance criteria are (spec §4), and the parts that prove them:
# story|log|section header (ERE, after "==> ")|line filter (ERE, optional)
STORY_TEXT=(
  "U1|Invite email → account; 2FA enforced if required; only invited teams visible."
  "U2|Cross-team probe returns zero rows; personal memory is per team; sandboxes are separate pods in separate namespaces."
  "U3|Upload lands in S3 then /workspace/uploads; the agent runs Python in the sandbox; an HTML artifact renders under a strict CSP."
  "U4|Run continues server-side; the client resumes from the last seq with no gaps or duplicates."
  "U5|Enter queues; Steer injects into the current run; Stop cancels; one active run per thread."
  "U6|Approval card with tool, input, risk; signed approval runs exactly that input; remember-rule visible and revocable; unanswered approval expires at 1 h and the run ends visibly."
  "U7|Per-user encrypted grants; tokens never present in any sandbox; revoking mine doesn't affect theirs; a changed tool is disabled until re-approved."
  "U8|Threads on v1 stay pinned; Orbit evaluation runs on publish when enabled and blocks above threshold; export produces valid Orbit YAML."
  "U9|Scan flags it; team admin approves before use; a blocklisted hash never loads anywhere."
  "U10|Project files are read-only in my sandbox; my threads are private until shared; project memory writes ask for approval."
  "U11|80% warning; at 100% the run finishes its step and stops; dashboard by user, agent, model."
  "U12|Blocked domain returns a clear error; Request access notifies the team admin; after enablement the install works."
  "U13|Break-glass needs a second admin's approval, is read-only and time-boxed, notifies team admins, and every read is audited."
  "U14|Runs as me in auto mode; a write that would ask is skipped and reported; result appears in Scheduled with a notification."
  "U15|Threads list and search from Postgres instantly; next turn shows waking, Pi JSONL rebuilt, conversation continues; shared files and artifacts intact."
  "U16|Chart refuses to run agents without gVisor; with it, first chat works; kobe backup/restore round-trips Postgres + S3."
)
PARTS=(
  "U1|gate4|U1:|"
  "U2|gate1|cross-team probe|"
  "U2|gate1|concurrency, real sandboxes|"
  "U2|gate4|U2:|"
  "U3|gate3|ac-5: CSV upload|"
  "U3|gate3|browser:|ac-5 browser"
  "U4|gate1|concurrency with streamed answers|"
  "U5|gate4|U5:|"
  "U6|gate2|ac-3: tampered kobe-policy|"
  "U6|gate4|U6:|"
  "U7|gate4|U7:|"
  "U8|gate3|ac-1: v2 published|"
  "U8|gate3|browser:|ac-1 browser"
  "U8|gate4|U8:|"
  "U9|gate3|ac-2: a skill|"
  "U10|gate3|project: two members|"
  "U10|gate3|ac-3: project files|"
  "U10|gate3|ac-4: remember|"
  "U10|gate3|browser:|ac-4 browser"
  "U11|gate2|ac-1: budget|"
  "U11|gate2|replicas:|"
  "U11|gate4|U11:|"
  "U12|gate2|ac-2: blocked domain|"
  "U13|gate2|ac-4: break-glass|"
  "U14|gate4|U14:|"
  "U15|gate1|killing a sandbox mid-run|"
  "U15|gate3|ac-5 \\(deleted\\)|"
  "U15|gate3|ac-5 \\(overnight\\)|"
  "U15|gate4|U15:|"
  "U16|gate4|U16:|"
  "U16|gate1|concurrency, real sandboxes|"
  "U16|restore|restore:|"
)
# The steps of each earlier gate a story needs (a gate is run once, with the union).
steps_for() { # gate story → its steps for that story
  case "$1:$2" in
    gate1:U2 | gate1:U16) echo "probe chat-real" ;;
    gate1:U4) echo chat-stream ;;
    gate1:U15) echo interrupt ;;
    gate2:U6) echo mcp ;;
    gate2:U11) echo "budget replicas" ;;
    gate2:U12) echo egress ;;
    gate2:U13) echo break-glass ;;
    gate3:U3 | gate3:U15) echo data ;;
    gate3:U8) echo versions ;;
    gate3:U9) echo skills ;;
    gate3:U10) echo "projects memory" ;;
  esac
}

# ---- runs ------------------------------------------------------------------------------------------
run_gate() { # log steps → runs that gate into $OUT/<log>.log (its exit status is kept in the log)
  local log=$1 steps=$2 rc=0 n=${1#gate}
  if [[ "$log" == restore && "$(${KUBECTL:-kubectl} config current-context)" != k3d-* ]]; then
    # On a real cluster e2e/gate4-restore.sh is its own run (it needs other Kobe servers stopped):
    # give its log as KOBE_GATE4_LOGS/restore.log (docs/gates/gate-4.md).
    echo "==> restore: not run here (e2e/gate4-restore.sh is run on its own on a real cluster)"
    return 0
  fi
  echo "==> running $log${steps:+ (steps: $steps)} → $OUT/$log.log"
  local env=(
    "KOBE_GATE${n}_NS=${KOBE_GATE4_NS:-kobe-dev}" "KOBE_GATE${n}_RELEASE=${KOBE_GATE4_RELEASE:-kobe}"
    "KOBE_GATE${n}_MODEL=${KOBE_GATE4_MODEL:-fast}"
    "KOBE_GATE${n}_OWNER_EMAIL=${KOBE_GATE4_OWNER_EMAIL:-owner@e2e.test}"
    "KOBE_GATE${n}_OWNER_PASSWORD=${KOBE_GATE4_OWNER_PASSWORD:-e2e owner password}"
  )
  [[ -n "${KOBE_GATE4_CONTEXT:-}" ]] && env+=("KOBE_GATE${n}_CONTEXT=$KOBE_GATE4_CONTEXT")
  [[ -n "${KOBE_GATE4_CHART:-}" ]] && env+=("KOBE_GATE${n}_CHART=$KOBE_GATE4_CHART")
  [[ -n "$steps" ]] && env+=("KOBE_GATE${n}_STEPS=$steps")
  if [[ "$log" == gate4 ]]; then
    env "${env[@]}" KOBE_GATE4_STORIES="$steps" e2e/gate4/stories.sh >"$OUT/$log.log" 2>&1 || rc=$?
  elif [[ "$log" == restore ]]; then
    # k3d: last, because it deletes this cluster and leaves a new one with the restored site.
    e2e/gate4-restore.sh >"$OUT/$log.log" 2>&1 || rc=$?
  else
    env "${env[@]}" "e2e/$log.sh" >"$OUT/$log.log" 2>&1 || rc=$?
  fi
  echo "     $log exited $rc"
}
if [[ "${KOBE_GATE4_VERDICT_ONLY:-0}" != 1 ]]; then
  for log in gate1 gate2 gate3 gate4 restore; do
    [[ -n "$LOGS" && -s "$LOGS/$log.log" ]] && continue
    steps=""
    for s in $STORIES; do
      if [[ "$log" == gate4 || "$log" == restore ]]; then
        printf '%s\n' "${PARTS[@]}" | grep -q "^$s|$log|" && steps+="$s "
      else
        steps+="$(steps_for "$log" "$s") "
      fi
    done
    steps=$(tr ' ' '\n' <<<"$steps" | grep . | awk '!seen[$0]++' | tr '\n' ' ' | sed 's/ $//')
    [[ -n "$steps" ]] && run_gate "$log" "$steps"
  done
fi

# ---- verdict ---------------------------------------------------------------------------------------
section() { # log header-regex [line-filter] → that section's check lines
  local file="$OUT/$1.log"
  [[ -s "$file" ]] || file="${LOGS:-/nonexistent}/$1.log"
  [[ -s "$file" ]] || return 0
  # The header pattern comes through the environment: awk -v would eat its backslashes.
  H="^==> $2" awk '/^==> /{on = ($0 ~ ENVIRON["H"])} on' "$file" \
    | { grep -E '^(ok   |FAIL |XFAIL |XPASS |INVALID |NOTRUN )' || true; } \
    | { if [[ -n "${3:-}" ]]; then grep -E "$3" || true; else cat; fi; }
}
failed=0
xfailed=0
proven=0
echo "==> Gate 4: user stories U1-U16"
for s in $STORIES; do
  text=$(printf '%s\n' "${STORY_TEXT[@]}" | grep "^$s|" | cut -d'|' -f2-)
  verdict=ok
  why=()
  while IFS='|' read -r story log header filter; do
    [[ "$story" == "$s" ]] || continue
    lines=$(section "$log" "$header" "$filter")
    label="$log: ${header//\\/}"; label="${label%:}${filter:+ ($filter)}"
    if [[ -z "$lines" ]]; then
      verdict=FAIL
      why+=("$label: not run (no such section in $log.log)")
      continue
    fi
    bad=$(grep -E '^(FAIL|XPASS|INVALID|NOTRUN) ' <<<"$lines" | head -2 | cut -c1-200 || true)
    xf=$(grep -c '^XFAIL ' <<<"$lines" || true)
    oks=$(grep -c '^ok   ' <<<"$lines" || true)
    if [[ -n "$bad" ]]; then
      verdict=FAIL
      why+=("$label: $(tr '\n' ';' <<<"$bad")")
    elif ((oks == 0 && xf == 0)); then
      verdict=FAIL
      why+=("$label: no checks passed")
    elif ((xf > 0)); then
      [[ "$verdict" == ok ]] && verdict=XFAIL
      why+=("$label: $oks ok, $xf expected failures")
    else
      why+=("$label: $oks ok")
    fi
  done < <(printf '%s\n' "${PARTS[@]}")
  if [[ "$verdict" == XFAIL && "${KOBE_GATE_STRICT:-0}" == 1 ]]; then verdict=FAIL; fi
  case "$verdict" in
    ok) echo "ok   $s $text"; proven=$((proven + 1)) ;;
    XFAIL) echo "XFAIL $s $text"; xfailed=$((xfailed + 1)) ;;
    *) echo "FAIL $s $text"; failed=1 ;;
  esac
  for w in "${why[@]}"; do echo "       $w"; done
done
n=$(wc -w <<<"$STORIES" | tr -d ' ')
if ((failed)); then
  echo "Gate 4: FAILED ($proven of $n stories proven; logs in $OUT)"
  exit 1
fi
if ((xfailed)); then
  echo "Gate 4: $proven of $n stories proven, $xfailed with expected failures (filed; KOBE_GATE_STRICT=1 fails them)"
else
  echo "Gate 4: all $n stories proven"
fi
