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

PODS=()
cleanup() {
  for p in "${PODS[@]+"${PODS[@]}"}"; do $KUBECTL delete pod $p --ignore-not-found --wait=false >/dev/null 2>&1 || true; done
  $KUBECTL delete namespace "$SANDBOX_NS" --ignore-not-found --wait=false >/dev/null 2>&1 || true
}
trap cleanup EXIT

probe() { # namespace, shell command → prints its output (unique pod, cleaned up on exit)
  local ns="$1" name="probe-$RANDOM$RANDOM"
  PODS+=("-n $ns $name")
  $KUBECTL -n "$ns" run "$name" --restart=Never --image=busybox:1.37 --command -- sh -c "$2" >/dev/null
  local phase="" i
  for i in $(seq 1 60); do # until the pod finishes either way (a failed wget is a valid answer)
    phase=$($KUBECTL -n "$ns" get pod "$name" -o jsonpath='{.status.phase}' 2>/dev/null || true)
    [[ "$phase" == Succeeded || "$phase" == Failed ]] && break
    sleep 2
  done
  $KUBECTL -n "$ns" logs "$name" 2>/dev/null || true
}

echo "==> prerequisites"
$KUBECTL get runtimeclass gvisor >/dev/null 2>&1 || { echo "RuntimeClass gvisor missing: run scripts/dev-cluster.sh" >&2; exit 2; }
$KUBECTL get crd sandboxes.agents.x-k8s.io >/dev/null 2>&1 \
  || { echo "agent-sandbox CRDs missing: run scripts/install-agent-sandbox.sh" >&2; exit 2; }

echo "==> clean state"
$HELM uninstall kobe -n "$NS" --wait >/dev/null 2>&1 || true
$KUBECTL delete namespace "$NS" kobe-deps "$SANDBOX_NS" --ignore-not-found --wait=false >/dev/null
for ns in "$NS" kobe-deps "$SANDBOX_NS"; do
  $KUBECTL wait --for=delete "namespace/$ns" --timeout=180s >/dev/null 2>&1 || true
done

echo "==> deploying dependencies and Kobe ${TAG}"
$KUBECTL apply -f dev/postgres.yaml >/dev/null
$KUBECTL -n kobe-deps rollout status deploy/pg --timeout=180s >/dev/null
$KUBECTL apply -f dev/mailpit.yaml >/dev/null
$KUBECTL -n kobe-deps rollout status deploy/mailpit --timeout=180s >/dev/null
$HELM upgrade --install kobe charts/kobe -n "$NS" -f dev/values.yaml \
  --set global.imageTag="$TAG" --set global.imagePullPolicy=IfNotPresent --wait --timeout 10m

echo "==> checks"
psql_kobe() { $KUBECTL -n kobe-deps exec deploy/pg -- psql -U postgres -d kobe -tAc "$1" 2>&1; }

for d in web server scheduler mcp-proxy egress-proxy bifrost; do
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
contains "web answers through the Traefik ingress" '"service":"web"' \
  "$(probe "$NS" 'wget -qO- --header "Host: kobe.localtest.me" http://traefik.kube-system/api/healthz')"
contains "server answers" '"service":"server"' "$(probe "$NS" 'wget -qO- http://kobe-server/healthz')"
# KOBE-9: every server/scheduler process verified isolation itself (not disclosed by /readyz).
iso=""
for pod in $($KUBECTL -n "$NS" get pods -l "$gated_pods" --field-selector=status.phase=Running -o name); do
  if $KUBECTL -n "$NS" logs "$pod" 2>/dev/null | grep -q '"msg":"isolation verified: agents enabled"'; then iso+="verified "
  else iso+="$pod:unverified "; fi
done
contains "server and scheduler verified the gVisor RuntimeClass in process" '^verified verified verified $' "$iso"
contains "Bifrost is reachable from the release namespace" '"status":"ok"' \
  "$(probe "$NS" 'wget -qO- -T 5 http://kobe-bifrost:8080/health')"
np=$(probe default "wget -qO- -T 5 http://kobe-web.$NS/api/healthz >/dev/null 2>&1 && echo control=REACHED || echo control=BLOCKED; \
  wget -qO- -T 5 http://kobe-bifrost.$NS:8080/health >/dev/null 2>&1 && echo bifrost=REACHED || echo bifrost=BLOCKED")
contains "probe from another namespace can reach unrestricted services (control)" '^control=REACHED$' "$np"
contains "Bifrost is not reachable from other namespaces" '^bifrost=BLOCKED$' "$np"
# First-run setup through the ingress (KOBE-12): needs the install's setup token.
setup_token=$($KUBECTL -n "$NS" get secret kobe-auth -o jsonpath='{.data.setup-token}' | base64 -d)
ingress() { # method path [json]: full response (status line + body) via the Traefik ingress
  local data=""
  if [[ -n "${3:-}" ]]; then data="--post-data '$3'"; fi
  probe "$NS" "wget -qO- -S --header 'Host: kobe.localtest.me' --header 'Origin: http://kobe.localtest.me' \
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
mail=$(probe "$NS" 'for i in $(seq 1 15); do m=$(wget -qO- -T 5 http://mailpit.kobe-deps:8025/api/v1/messages); \
  echo "$m" | grep -q "Reset your Kobe password" && break; sleep 2; done; echo "$m"')
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
  sleep 2
  out=$($KUBECTL -n "$SANDBOX_NS" logs e2e 2>&1 || true)
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

exit "$failed"
