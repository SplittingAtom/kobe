#!/usr/bin/env bash
# t2's sandbox pod for e2e/gate2.sh (KOBE-193). Sourced; uses KUBECTL, TNS, T2, claim_uid and the
# helpers of e2e/lib/gate-common.sh (ok, fail, until_ok).
#
# Waits (bounded) for the pod to be Running and Ready. When it is not, it says so once, with the
# pod's phase, its containers' waiting reasons and its last events, and every later step that needs
# the sandbox is skipped instead of failing on an empty pod name (Gate 2's first real-cluster run:
# a pod stuck in ContainerCreating gave ~30 unrelated failures).

SBX_DOWN=0          # 1 once the sandbox was found not running: dependent steps are skipped
SBX_EVENTS="${KOBE_GATE2_SANDBOX_EVENTS:-8}" # how many of the pod's last events to print

# One line per pod of t2's claim: name, phase, Ready condition, "container:reason" for every
# container (init containers first) that is waiting or terminated.
SBX_STATE_JSONPATH='{range .items[*]}{.metadata.name}{"\t"}{.status.phase}{"\t"}{range .status.conditions[?(@.type=="Ready")]}{.status}{end}{"\t"}{range .status.initContainerStatuses[*]}{.name}:{.state.waiting.reason}{.state.terminated.reason} {end}{range .status.containerStatuses[*]}{.name}:{.state.waiting.reason}{.state.terminated.reason} {end}{"\n"}{end}'

sbx_state() {
  local uid
  uid=$(claim_uid)
  [[ -z "$uid" ]] && return 0
  $KUBECTL -n "$TNS" get pods -l "agents.x-k8s.io/claim-uid=$uid" -o jsonpath="$SBX_STATE_JSONPATH" 2>/dev/null || true
}

sbx_running_ready() {
  sbx_state | awk -F'\t' '$2 == "Running" && $3 == "True" { found = 1 } END { exit !found }'
}

# The pod's state in a few words, for the one FAIL line: "pod <name> phase=<phase> ready=<..>
# (<container:reason ...>)", or why there is no pod.
sbx_summary() {
  local uid state name phase ready reasons
  uid=$(claim_uid)
  if [[ -z "$uid" ]]; then
    echo "no SandboxClaim u-$T2 in $TNS"
    return
  fi
  state=$(sbx_state)
  if [[ -z "$state" ]]; then
    echo "claim $uid has no pod"
    return
  fi
  IFS=$'\t' read -r name phase ready reasons <<<"$(sed -n 1p <<<"$state")"
  reasons=$(printf '%s' "$reasons" | sed -E 's/[a-z0-9-]+: //g; s/ +$//')
  echo "pod $name phase=${phase:-unknown} ready=${ready:-False}${reasons:+ ($reasons)}"
}

sbx_events() { # [object name] → the last events of that object (or of the namespace), indented
  local sel=() out
  [[ -n "${1:-}" ]] && sel=(--field-selector "involvedObject.name=$1")
  out=$($KUBECTL -n "$TNS" get events ${sel[@]+"${sel[@]}"} --sort-by=.lastTimestamp --no-headers \
    -o custom-columns=LAST:.lastTimestamp,TYPE:.type,REASON:.reason,OBJECT:.involvedObject.name,MESSAGE:.message 2>/dev/null \
    | tail -n "$SBX_EVENTS" || true)
  if [[ -n "$out" ]]; then
    printf '%s\n' "$out" | cut -c1-300 | sed 's/^/       /'
  else
    echo "       (no events${1:+ for $1})"
  fi
}

sbx_diagnose() { # every pod of t2's claim: phase, container reasons, last events
  local state name phase ready reasons
  state=$(sbx_state)
  if [[ -z "$state" ]]; then
    echo "     last events in $TNS:"
    sbx_events
    return
  fi
  while IFS=$'\t' read -r name phase ready reasons; do
    echo "     pod $name: phase=${phase:-unknown} ready=${ready:-False} containers: ${reasons:-no status yet}"
    echo "     its last events:"
    sbx_events "$name"
  done <<<"$state"
}

# sbx_await seconds label → 0 once t2's sandbox pod is Running and Ready. Otherwise one FAIL with the
# pod's phase, then its events, and SBX_DOWN=1; called again after that, it prints a skip line
# for `label` (the step asking; no second FAIL) and returns 1 at once.
sbx_await() {
  local secs="$1" label="$2"
  if ((SBX_DOWN)); then
    echo "skip $label: t2's sandbox is not running (see the FAIL above)"
    return 1
  fi
  until_ok "$secs" sbx_running_ready && return 0
  SBX_DOWN=1
  fail "t2's sandbox pod is not Running and Ready after ${secs}s (at $label): $(sbx_summary); every step that needs the sandbox is skipped"
  sbx_diagnose
  return 1
}
