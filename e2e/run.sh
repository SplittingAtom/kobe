#!/usr/bin/env bash
# Kobe k3d end-to-end suite (KOBE-7). Expects a cluster from scripts/dev-cluster.sh and the Kobe
# images available to it under ghcr.io/splittingatom/kobe-*:${KOBE_IMAGE_TAG} (e.g. via
# `k3d image import`). Installs the chart with dev/values.yaml and a throwaway Postgres, then
# checks the platform invariants. Later tickets add their stories here.
set -euo pipefail
cd "$(dirname "$0")/.."

KUBECTL="${KUBECTL:-kubectl}"
HELM="${HELM:-helm}"
TAG="${KOBE_IMAGE_TAG:?set KOBE_IMAGE_TAG}"
NS=kobe
failed=0

ok() { echo "ok   $1"; }
fail() { echo "FAIL $1"; failed=1; }
check() { # name, command... (passes when the command succeeds)
  local name="$1"; shift
  if out=$("$@" 2>&1); then ok "$name"; else fail "$name: $(tail -3 <<<"$out")"; fi
}

probe() { # run a one-shot busybox command in a namespace and print its output
  local ns="$1" name="probe-$RANDOM"; shift
  $KUBECTL -n "$ns" run "$name" --restart=Never --image=busybox:1.37 --command -- sh -c "$*" >/dev/null
  $KUBECTL -n "$ns" wait --for=jsonpath='{.status.phase}'=Succeeded "pod/$name" --timeout=60s >/dev/null 2>&1 || true
  $KUBECTL -n "$ns" logs "$name" 2>/dev/null
  $KUBECTL -n "$ns" delete pod "$name" --wait=false >/dev/null 2>&1
}

echo "==> deploying dependencies and Kobe ${TAG}"
$KUBECTL apply -f dev/postgres.yaml >/dev/null
$KUBECTL -n kobe-deps rollout status deploy/pg --timeout=180s >/dev/null
$HELM upgrade --install kobe charts/kobe -n "$NS" -f dev/values.yaml \
  --set global.imageTag="$TAG" --set global.imagePullPolicy=IfNotPresent --wait --timeout 10m

echo "==> checks"
expect() { # name, regex, actual-output
  if grep -Eq "$2" <<<"$3"; then ok "$1"; else fail "$1: got '$(tail -2 <<<"$3")'"; fi
}
psql_kobe() { $KUBECTL -n kobe-deps exec deploy/pg -- psql -U postgres -d kobe -tAc "$1" 2>&1; }

for d in web server scheduler mcp-proxy egress-proxy bifrost; do
  check "deployment kobe-$d is available" $KUBECTL -n "$NS" rollout status "deploy/kobe-$d" --timeout=60s
done
expect "server/scheduler init gates (isolation, migrations) completed" '^Completed$' \
  "$($KUBECTL -n "$NS" get pods -l 'app.kubernetes.io/component in (server,scheduler)' \
      -o jsonpath='{.items[*].status.initContainerStatuses[*].state.terminated.reason}' | tr ' ' '\n' | sort -u)"
expect "migrations applied and app-role grants recorded" '^1$' "$(psql_kobe 'select count(*) from drizzle.kobe_grants_applied')"
expect "team table has FORCE ROW LEVEL SECURITY" '^t$' \
  "$(psql_kobe "select relforcerowsecurity from pg_class where relname='team_members'")"
expect "web answers through the Traefik ingress" '"service":"web"' \
  "$(probe "$NS" 'wget -qO- --header "Host: kobe.localtest.me" http://traefik.kube-system/api/healthz')"
expect "server answers" '"service":"server"' "$(probe "$NS" 'wget -qO- http://kobe-server/healthz')"
expect "Bifrost is reachable from the release namespace" 'status' \
  "$(probe "$NS" 'wget -qO- -T 5 http://kobe-bifrost:8080/health')"
expect "Bifrost is not reachable from other namespaces" '^BLOCKED$' \
  "$(probe default 'wget -qO- -T 5 http://kobe-bifrost.kobe:8080/health >/dev/null 2>&1 && echo REACHED || echo BLOCKED')"
expect "chart refuses a RuntimeClass that does not isolate" 'refuses to run agents' \
  "$($HELM upgrade kobe charts/kobe -n "$NS" --reuse-values --set isolation.runtimeClassName=does-not-exist 2>&1 || true)"

if [[ -n "${KOBE_SANDBOX_IMAGE:-}" ]]; then
  $KUBECTL -n default run sandbox-e2e --restart=Never --image="$KOBE_SANDBOX_IMAGE" --image-pull-policy=IfNotPresent \
    --overrides='{"spec":{"runtimeClassName":"gvisor","securityContext":{"runAsNonRoot":true}}}' \
    --command -- sh -c 'dmesg | head -1; id -u; pi --version' >/dev/null
  $KUBECTL -n default wait --for=jsonpath='{.status.phase}'=Succeeded pod/sandbox-e2e --timeout=180s >/dev/null 2>&1 || true
  out=$($KUBECTL -n default logs sandbox-e2e 2>&1)
  $KUBECTL -n default delete pod sandbox-e2e --wait=false >/dev/null 2>&1
  expect "sandbox image boots under gVisor" 'Starting gVisor' "$out"
  expect "sandbox runs as uid 1000" '^1000$' "$out"
  expect "sandbox has Pi 1.0.x" '^1\.0\.' "$out"
fi

exit "$failed"
