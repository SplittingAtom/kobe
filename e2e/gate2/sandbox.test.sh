#!/usr/bin/env bash
# Self-test of e2e/gate2.sh's failure paths (KOBE-193), without a cluster: a fake kubectl plays t2's
# sandbox (Running and Ready, stuck in ContainerCreating, no pod, no claim) and the secret scan
# runs against a sandbox that yields nothing. Run: e2e/gate2/sandbox.test.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT

# The fake kubectl: FAKE_SBX selects the sandbox's state.
cat >"$T/kubectl" <<'EOF'
#!/usr/bin/env bash
args=" $* "
case "$FAKE_SBX:$args" in
  noclaim:*" get sandboxclaim "*) exit 1 ;;
  *:*" get sandboxclaim "*) echo "11111111-2222-3333-4444-555555555555" ;;
  ready:*" get pods "*) printf 'sbx-abc\tRunning\tTrue\tagent: \n' ;;
  stuck:*" get pods "*) printf 'sbx-abc\tPending\tFalse\tagent:ContainerCreating \n' ;;
  *:*" get pods "*) ;;
  stuck:*" get events "*"involvedObject.name=sbx-abc"*)
    echo "2026-10-09T16:33:01Z   Warning   FailedAttachVolume   sbx-abc   AttachVolume.Attach failed for volume \"pvc-1\""
    echo "2026-10-09T16:35:12Z   Warning   FailedMount          sbx-abc   Unable to attach or mount volumes: timed out" ;;
  *:*" get events "*) echo "2026-10-09T16:32:40Z   Normal   Scheduled   claim   created" ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$T/kubectl"

failed=0
KUBECTL="$T/kubectl"
TNS=kobe-team-gate2-a
T2=22222222-2222-2222-2222-222222222222
# shellcheck source=../lib/gate-common.sh
source e2e/lib/gate-common.sh
# shellcheck source=sandbox.sh
source e2e/gate2/sandbox.sh
# shellcheck source=scan.sh
source e2e/gate2/scan.sh
claim_uid() { $KUBECTL -n "$TNS" get sandboxclaim "u-$T2" -o jsonpath='{.metadata.uid}' 2>/dev/null || true; }

errors=0
check() { # name, regex, file: some line matches
  if grep -Eq -- "$2" "$3"; then echo "  pass $1"; else echo "  FAILED $1"; sed 's/^/    | /' "$3"; errors=$((errors + 1)); fi
}
check_not() { # name, regex, file: no line matches
  if grep -Eq -- "$2" "$3"; then echo "  FAILED $1"; sed 's/^/    | /' "$3"; errors=$((errors + 1)); else echo "  pass $1"; fi
}
check_val() { # name, regex, value
  printf '%s\n' "$3" >"$T/val"
  check "$1" "$2" "$T/val"
}
count() { grep -Ec -- "$1" "$2" || true; }

echo "sandbox Running and Ready"
FAKE_SBX=ready SBX_DOWN=0 failed=0
export FAKE_SBX
rc=0
sbx_await 2 "the steps" >"$T/out" || rc=$?
check_val "returns 0" '^0$' "$rc"
check_not "no FAIL" '^FAIL' "$T/out"

echo "sandbox stuck in ContainerCreating"
FAKE_SBX=stuck SBX_DOWN=0 failed=0
rc=0
sbx_await 2 "ac-1 (budget)" >"$T/out" || rc=$?
check_val "returns 1" '^1$' "$rc"
check_val "exactly one FAIL" '^1$' "$(count '^FAIL' "$T/out")"
check "the FAIL names the pod, its phase and the container's reason" \
  '^FAIL .*pod sbx-abc phase=Pending ready=False \(agent:ContainerCreating\)' "$T/out"
check "the pod's events follow" 'FailedAttachVolume.*AttachVolume.Attach failed' "$T/out"
check "and the latest one" 'FailedMount' "$T/out"
check_val "the run is marked failed" '^1$' "$failed"
check_val "SBX_DOWN is set" '^1$' "$SBX_DOWN"
rc=0
sbx_await 2 "ac-5 (scan)" >"$T/out" || rc=$?
check_val "a later step returns 1 at once" '^1$' "$rc"
check "and only says it is skipped" '^skip ac-5 \(scan\): ' "$T/out"
check_not "with no second FAIL" '^FAIL' "$T/out"

echo "claim without a pod"
FAKE_SBX=nopod SBX_DOWN=0 failed=0
sbx_await 2 "the steps" >"$T/out" || true
check "one FAIL saying the claim has no pod" '^FAIL .*claim 11111111-2222-3333-4444-555555555555 has no pod' "$T/out"
check "with the namespace's events" 'Scheduled' "$T/out"

echo "no claim"
FAKE_SBX=noclaim SBX_DOWN=0 failed=0
sbx_await 2 "the steps" >"$T/out" || true
check "one FAIL saying there is no claim" "^FAIL .*no SandboxClaim u-$T2 in $TNS" "$T/out"

echo "ac-5 with failing controls (the sandbox yields nothing)"
FAKE_SBX=ready failed=0
WORK="$T/work"
mkdir -p "$WORK"
NS=kobe-dev BASE=http://server TEAM=33333333-3333-3333-3333-333333333333 MODELS=0 MODEL_ALIAS=fast
sbx_pod() { echo sbx-abc; }
in_sbx() { :; }
client() { :; }
chat() { :; }
run_secret_scan >"$T/out" 2>&1
check "the failed controls are FAILs" '^FAIL control: a canary in a file is found' "$T/out"
check_val "one ac-5 INVALID verdict" '^1$' "$(count '^FAIL ac-5 INVALID: ' "$T/out")"
check "the 'no secret value' result is INVALID" '^INVALID no secret value of the install' "$T/out"
check "so is the JWT result" '^INVALID every JWT in the sandbox' "$T/out"
check "and the pod spec results" '^INVALID no Secret volume is mounted' "$T/out"
check_not "nothing negative prints ok" '^ok   (no |every JWT|the projected)' "$T/out"

echo "ac-5 without a running pod"
failed=0
sbx_pod() { :; }
run_secret_scan >"$T/out" 2>&1
check "one INVALID FAIL" '^FAIL ac-5 INVALID: t2.s sandbox has no Running pod to scan' "$T/out"
check_not "and no ok" '^ok ' "$T/out"

if ((errors)); then
  echo "gate2 sandbox self-test: $errors FAILED"
  exit 1
fi
echo "gate2 sandbox self-test: all passed"
