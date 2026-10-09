# Helpers shared by the gate harnesses (e2e/gate1.sh, e2e/gate2.sh); sourced, not run.
# Expects: KUBECTL, NS, RELEASE, SERVER, CLIENT_JS (the harness client's source), `failed` and PODS.
ok() { echo "ok   $1"; }
fail() { echo "FAIL $1"; failed=1; }
contains() { # name, regex, actual output: passes when some line matches regex
  if printf '%s\n' "$3" | grep -Eq "$2"; then ok "$1"; else fail "$1: got [$(printf '%s\n' "$3" | tail -3)]"; fi
}
field() { printf '%s\n' "$2" | sed -n "s/^$1=//p" | head -1; } # key, output → value
until_ok() { # seconds command... → succeeds as soon as the command does, fails after `seconds`
  local deadline=$((SECONDS + $1))
  shift
  until "$@"; do
    ((SECONDS >= deadline)) && return 1
    sleep 2
  done
}

# The fake model upstream e2e/run.sh deployed (and removed on exit): the catalog's providers point
# at llm.kobe-e2e-llm.svc, so recreate it from the installed model-gateway image when it is gone.
ensure_fake_llm() {
  local ns=kobe-e2e-llm image phase
  # e2e/run.sh deletes the namespace on exit (`--wait=false`): it may still be terminating here,
  # with its Service listed but its pod on the way out. Wait for it to go, then recreate.
  phase=$($KUBECTL get namespace "$ns" -o jsonpath='{.status.phase}' 2>/dev/null || true)
  if [[ "$phase" == Terminating ]]; then
    $KUBECTL wait --for=delete "namespace/$ns" --timeout=240s >/dev/null 2>&1 || true
    phase=""
  fi
  if [[ "$phase" == Active && "$($KUBECTL -n "$ns" get pod llm -o jsonpath='{.status.phase}' 2>/dev/null)" == Running ]]; then
    return
  fi
  image=$($KUBECTL -n "$NS" get "$SERVER" -o jsonpath='{.spec.template.spec.containers[?(@.name=="server")].image}' | sed 's/kobe-server/kobe-model-gateway/')
  $KUBECTL delete pod llm -n "$ns" --ignore-not-found --wait=true >/dev/null 2>&1 || true
  $KUBECTL create namespace "$ns" --dry-run=client -o yaml | $KUBECTL apply -f - >/dev/null
  $KUBECTL -n "$ns" run llm --restart=Never --image="$image" --image-pull-policy=IfNotPresent --labels=app=llm \
    --command -- node dist/testing/fake-llm-main.js >/dev/null
  $KUBECTL -n "$ns" get svc llm -o name >/dev/null 2>&1 \
    || $KUBECTL -n "$ns" expose pod llm --port=80 --target-port=8080 --name=llm >/dev/null
  $KUBECTL -n "$ns" wait --for=condition=Ready pod/llm --timeout=180s >/dev/null 2>&1 || true
  PODS+=("-n $ns llm")
}
# What the model-gateway shim refused lately (status, error type, run): printed when a chat failed.
shim_refusals() {
  $KUBECTL -n "$NS" logs -l app.kubernetes.io/component=model-gateway --tail=-1 --since=15m 2>/dev/null \
    | grep -E '"status":(4|5)[0-9][0-9]' | sed -E 's/.*"call":(\{[^}]*\}).*/     shim: \1/' | tail -12
}
client() { # json config → the harness step's output (inside a server pod, through the Service)
  $KUBECTL -n "$NS" exec "$SERVER" -c server -- node --input-type=module -e "$CLIENT_JS" "$1" 2>&1 || true
}

