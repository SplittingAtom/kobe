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
  $KUBECTL delete namespace "$TEAM_NS" "$TEAM2_NS" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  $KUBECTL delete runtimeclass kobe-e2e-runc --ignore-not-found >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Shell snippet for a probe pod: wait (up to ~90 s) until URL answers. A new pod joins the CNI's
# policy ipsets on kube-router's next sync, so policy-guarded targets refuse it for its first
# seconds (docs/ledger/KOBE-22.md); positive checks wait that out, then assert.
until_answers() { echo "for i in \$(seq 1 30); do wget -qO- -T 2 $1 >/dev/null 2>&1 && break; sleep 1; done;"; }
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
$KUBECTL delete namespace "$NS" kobe-deps "$SANDBOX_NS" "$TEAM_NS" "$TEAM2_NS" --ignore-not-found --wait=false >/dev/null
for ns in "$NS" kobe-deps "$SANDBOX_NS" "$TEAM_NS" "$TEAM2_NS"; do
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
contains "server answers" '"service":"server"' \
  "$(probe "$NS" "$(until_answers http://kobe-server/healthz) wget -qO- http://kobe-server/healthz")"
# KOBE-9: every server/scheduler process verified isolation itself (not disclosed by /readyz).
iso=""
for pod in $($KUBECTL -n "$NS" get pods -l "$gated_pods" --field-selector=status.phase=Running -o name); do
  if $KUBECTL -n "$NS" logs "$pod" 2>/dev/null | grep -q '"msg":"isolation verified: agents enabled"'; then iso+="verified "
  else iso+="$pod:unverified "; fi
done
contains "server and scheduler verified the gVisor RuntimeClass in process" '^verified verified verified $' "$iso"
bifrost=$(probe "$NS" "$(until_answers http://kobe-bifrost:8080/health) wget -qO- -T 5 http://kobe-bifrost:8080/health")
contains "Bifrost is reachable from the release namespace" '"status":"ok"' "$bifrost restarts=$($KUBECTL \
  -n "$NS" get pods -l app.kubernetes.io/component=bifrost -o jsonpath='{.items[*].status.containerStatuses[*].restartCount}' 2>/dev/null)"
# Once the control answers, the probe pod is in the policy ipsets: BLOCKED below is the policy.
np=$(probe default "$(until_answers http://kobe-web.$NS/api/healthz) \
  wget -qO- -T 5 http://kobe-web.$NS/api/healthz >/dev/null 2>&1 && echo control=REACHED || echo control=BLOCKED; \
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


# KOBE-22: the server's sandbox provider creates a team namespace (default-deny NetworkPolicy,
# quota, warm pool) and a (user, team) sandbox under gVisor; admission policies pin isolation.
echo "==> sandbox provider (KOBE-22)"
E2E_TEAM_ID=6f1d1a2b-0c3d-4e5f-8a9b-0c1d2e3f4a5b
E2E_USER_ID=7a2e2b3c-1d4e-4f6a-9b0c-1d2e3f4a5b6c
ensure_sandbox() { # [team-id slug]: defaults to the e2e team
  $KUBECTL -n "$NS" exec deploy/kobe-server -c server -- node dist/cli/sandbox.js ensure \
    --team-id "${1:-$E2E_TEAM_ID}" --team-slug "${2:-e2e}" --user-id "$E2E_USER_ID" 2>&1
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
contains "team namespace enforces Pod Security 'restricted'" '^restricted$' \
  "$($KUBECTL get namespace "$TEAM_NS" -o jsonpath='{.metadata.labels.pod-security\.kubernetes\.io/enforce}')"
np_spec() { $KUBECTL -n "$TEAM_NS" get networkpolicy kobe-sandbox-isolation -o jsonpath="$1"; }
contains "team NetworkPolicy selects every pod in the namespace" '^\{\}$' "$(np_spec '{.spec.podSelector}')"
contains "team NetworkPolicy governs ingress and egress" '^\["Ingress","Egress"\]$' "$(np_spec '{.spec.policyTypes}')"
contains "team NetworkPolicy allows no ingress at all" '^(\[\])?$' "$(np_spec '{.spec.ingress}')"
contains "team namespace has the only NetworkPolicy in it (controller policy unmanaged)" '^kobe-sandbox-isolation$' \
  "$($KUBECTL -n "$TEAM_NS" get networkpolicy -o name | sed 's|.*/||')"
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
  for i in $(seq 1 90); do
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
# A new pod joins the CNI's policy ipsets after a short delay: wait until the sandbox port answers
# (up to 60 s) before probing, so BLOCKED results are the policy and not the warm-up.
egress=$(team_probe "for i in \$(seq 1 60); do wget -qO- -T 2 http://$server_ip:8081/healthz >/dev/null 2>&1 && break; sleep 1; done; \
  wget -qO- -T 5 http://${diag_ip:-0.0.0.0}:8080/ >/dev/null 2>&1 && echo diag-8080=REACHED || echo diag-8080=BLOCKED; \
  wget -qO- -T 5 http://${diag_ip:-0.0.0.0}:9090/ >/dev/null 2>&1 && echo diag-9090=REACHED || echo diag-9090=BLOCKED; \
  wget -qO- -T 5 http://${web_pod_ip:-0.0.0.0}:8080/api/healthz >/dev/null 2>&1 && echo web-pod=REACHED || echo web-pod=BLOCKED; \
  wget -qO- -T 5 http://$server_ip:8081/healthz >/dev/null 2>&1 && echo sandbox-port=REACHED || echo sandbox-port=BLOCKED; \
  wget -qO- -T 5 http://$server_ip/healthz >/dev/null 2>&1 && echo user-api=REACHED || echo user-api=BLOCKED; \
  wget -qO- -T 5 http://$bifrost_ip:8080/health >/dev/null 2>&1 && echo bifrost=REACHED || echo bifrost=BLOCKED; \
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
contains "sandboxes cannot reach Bifrost while it does not verify tokens (modelGatewayAccess off)" '^bifrost=BLOCKED$' "$egress"
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
# Controls: the same destinations are reachable from the release namespace, so BLOCKED above is
# the sandbox policy, not a dead target.
# (The probe pod also waits out the CNI warm-up: web/server/scheduler admit it by namespace label.)
controls=$(probe "$NS" "for i in \$(seq 1 60); do wget -qO- -T 2 http://$server_ip/healthz >/dev/null 2>&1 && break; sleep 1; done; \
  $(tcp api "$api_ip" 443) $(tcp kubelet "$node_ip" 10250) \
  wget -qO- -T 5 http://$server_ip/healthz >/dev/null 2>&1 && echo user-api=REACHED || echo user-api=BLOCKED")
contains "control: the API Service is reachable from the release namespace" '^api=REACHED$' "$controls"
contains "control: the kubelet is reachable from the release namespace" '^kubelet=REACHED$' "$controls"
contains "control: the user API is reachable from the release namespace" '^user-api=REACHED$' "$controls"
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
inbound=$(probe "$NS" "wget -qO- -T 5 http://${control_ip:-0.0.0.0}:8080/ >/dev/null 2>&1 && echo control=REACHED || echo control=BLOCKED; \
  wget -qO- -T 5 http://${team_ip:-0.0.0.0}:8080/ >/dev/null 2>&1 && echo sandbox=REACHED || echo sandbox=BLOCKED")
contains "the team listener is up (so BLOCKED below means the policy)" '^Running$' \
  "$($KUBECTL -n "$TEAM_NS" get pod "$team_listener" -o jsonpath='{.status.phase}')"
contains "a listener outside team namespaces is reachable (control)" '^control=REACHED$' "$inbound"
contains "nothing can connect into a sandbox (no inbound)" '^sandbox=BLOCKED$' "$inbound"

exit "$failed"
