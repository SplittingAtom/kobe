#!/usr/bin/env bash
# Gate 2 (KOBE-2, Safety) against an installed Kobe, five criteria end to end:
#   ac-1 budget    a team budget at 100% lets the run in flight finish its current model step, then
#                  stops it with run.budget_stopped (and refuses new runs)
#   ac-2 egress    a blocked domain gives egress.blocked + Request access; after team-admin
#                  enablement the same request succeeds
#   ac-3 mcp       a sandbox with a tampered kobe-policy extension cannot execute an MCP write
#                  without a valid signed approval: mcp-proxy refuses, nothing reaches the server
#   ac-4 break-glass  needs a second install admin's approval, notifies the team's admins, and
#                  audits every read
#   ac-5 scan      a running sandbox holds no provider API key, no connector token and no internal
#                  key of the install (its own Secrets and sealed provider keys, compared by value)
# docs/gates/gate-2.md records what each check proves and what it does not.
#
# Runs after the gate1-prep install in CI (k3d) and against a real cluster's throwaway install:
#   KOBE_GATE2_NS=<release namespace> KOBE_GATE2_RELEASE=<release> e2e/gate2.sh
# Non-destructive outside what it creates: users gate2-*@gate2.test, team gate2-a (its
# kobe-team-gate2-a namespace and the sandbox the server creates), namespace kobe-gate2-infra (a
# fake MCP server and a TLS upstream), one connector row, break-glass grants (revoked at the end).
# Temporary changes to the install, undone on exit: a price on the catalog model when it has none,
# the test upstream in the egress ceiling, and (the one that rolls pods) the egress and MCP proxy
# allow-lists for the two fake servers, restored from the release's saved values unless on k3d.
# It signs sandbox tokens with the install's keys, so it refuses anything but a k3d context unless
# KOBE_GATE2_CONTEXT names the context explicitly. Re-runnable: fixtures are reused.
set -euo pipefail
cd "$(dirname "$0")/.."

KUBECTL="${KUBECTL:-kubectl}"
HELM="${HELM:-helm}"
NS="${KOBE_GATE2_NS:-kobe-dev}"
RELEASE="${KOBE_GATE2_RELEASE:-kobe}"
CHART="${KOBE_GATE2_CHART:-charts/kobe}"
STEPS=" ${KOBE_GATE2_STEPS:-budget egress mcp break-glass scan} "
MODEL_ALIAS="${KOBE_GATE2_MODEL:-fast}"
OWNER_EMAIL="${KOBE_GATE2_OWNER_EMAIL:-owner@e2e.test}"
OWNER_PASSWORD="${KOBE_GATE2_OWNER_PASSWORD:-e2e owner password}"
INFRA_NS=kobe-gate2-infra
TEAM_SLUG=gate2-a
TNS="kobe-team-$TEAM_SLUG"
CONNECTOR_ID=7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d
SERVER="deploy/$RELEASE-server"
BASE="http://$RELEASE-server.$NS.svc.cluster.local"
NONCE="$(date +%s)"
failed=0

context=$($KUBECTL config current-context)
if [[ "$context" != k3d-* && "$context" != "${KOBE_GATE2_CONTEXT:-}" ]]; then
  echo "refusing to run against context '$context' (expected k3d-*, or set KOBE_GATE2_CONTEXT=$context)" >&2
  exit 2
fi
# Undo the proxy allow-lists on a real cluster; a k3d cluster is thrown away.
RESTORE_HELM="${KOBE_GATE2_RESTORE_HELM:-$([[ "$context" == k3d-* ]] && echo 0 || echo 1)}"

# shellcheck source=lib/gate-common.sh
source e2e/lib/gate-common.sh
# shellcheck source=gate2/scan.sh
source e2e/gate2/scan.sh

# The Gate 1 client's helpers (everything above its MODES) plus the Gate 2 steps.
CLIENT_JS="$(sed '/^const MODES = {/,$d' e2e/gate1/client.mjs; cat e2e/gate2/client.mjs)"
WORK=$(mktemp -d)
chmod 700 "$WORK"
PODS=()
UNDO=()
cleanup() {
  local u
  for p in "${PODS[@]+"${PODS[@]}"}"; do $KUBECTL delete pod $p --ignore-not-found --wait=false >/dev/null 2>&1 || true; done
  for u in "${UNDO[@]+"${UNDO[@]}"}"; do eval "$u" >/dev/null 2>&1 || true; done
  rm -rf "$WORK"
}
trap cleanup EXIT

# Fixtures: team gate2-a with an admin (t1) and a member (t2) whose sandbox is the one under test,
# and a second install admin (ia) for break-glass (the install Owner is the first).
user_json() { # key team → fixture JSON
  printf '{"key":"%s","email":"gate2-%s@gate2.test","name":"Gate2 %s","team":"%s","ip":"198.51.100.%s"}' \
    "$1" "$1" "$1" "$2" "$3"
}
USERS="[$(user_json t1 a 41),$(user_json t2 a 42),$(user_json ia x 43)]"

echo "==> fixtures: team $TEAM_SLUG (admin, member), a second install admin"
setup_token=$($KUBECTL -n "$NS" get secret "$RELEASE-auth" -o jsonpath='{.data.setup-token}' 2>/dev/null | base64 -d 2>/dev/null || true)
fx=$(client "$(printf '{"mode":"fixtures","base":"%s","modelAlias":"%s","owner":{"email":"%s","password":"%s"},"setupToken":"%s","users":%s,"teams":[{"key":"a","slug":"%s","name":"Gate 2 A"}]}' \
  "$BASE" "$MODEL_ALIAS" "$OWNER_EMAIL" "$OWNER_PASSWORD" "$setup_token" "$USERS" "$TEAM_SLUG")")
printf '%s\n' "$fx" | sed 's/^/     /'
fixtures=$(field fixtures "$fx")
json_get() { printf '%s' "$fixtures" | sed -n "s/.*\"$1\":\"\([0-9a-f-]*\)\".*/\1/p"; } # key → uuid
TEAM=$(json_get a)
T1=$(json_get t1)
T2=$(json_get t2)
IA=$(json_get ia)
if [[ ! "$TEAM $T1 $T2 $IA" =~ ^([0-9a-f-]{36}\ ){3}[0-9a-f-]{36}$ ]]; then
  fail "fixtures: the team and its users"
  exit 1
fi
ok "fixtures: the team and its users"
contains "t2 is a member of the team" '^member_t2=200$' "$fx"
if [[ "$(field models_a "$fx")" == 200 ]]; then
  MODELS=1
  [[ "$MODEL_ALIAS" == fast ]] && ensure_fake_llm
else
  MODELS=0
  echo "     no model catalog entry '$MODEL_ALIAS' on this install: the budget and egress steps need one"
fi
ip_of() { case "$1" in t1) echo 198.51.100.41 ;; t2) echo 198.51.100.42 ;; *) echo 198.51.100.43 ;; esac; }
user_obj() { # key id [with team] → chat user JSON
  printf '{"key":"%s","email":"gate2-%s@gate2.test","ip":"%s","teamId":"%s","userId":"%s"}' "$1" "$1" "$(ip_of "$1")" "${3-$TEAM}" "$2"
}
U_T1=$(user_obj t1 "$T1")
U_T2=$(user_obj t2 "$T2")
U_IA=$(user_obj ia "$IA" "")
OWNER_JSON=$(printf '{"email":"%s","password":"%s"}' "$OWNER_EMAIL" "$OWNER_PASSWORD")
step() { client "$(printf '{"mode":"%s","base":"%s","owner":%s,%s}' "$1" "$BASE" "$OWNER_JSON" "$2")"; }
server_now() { $KUBECTL -n "$NS" exec "$SERVER" -c server -- date -u +%Y-%m-%dT%H:%M:%SZ; }
SERVER_IMAGE=$($KUBECTL -n "$NS" get "$SERVER" -o jsonpath='{.spec.template.spec.containers[?(@.name=="server")].image}')
SANDBOX_IMAGE="${KOBE_GATE2_SANDBOX_IMAGE:-${SERVER_IMAGE/kobe-server/kobe-sandbox}}"

grant=$(step grant "\"userId\":\"$IA\"")
contains "ia is an install admin; the install has at least two (Owner + admins)" '^role_status=(200|204)$' "$grant"
contains "so a request has a second admin who can approve" '^install_admins=([2-9]|[1-9][0-9]+)$' "$grant"

# The sandbox of t2: pod, claim uid (= sandbox id) and exec.
claim_uid() { $KUBECTL -n "$TNS" get sandboxclaim "u-$T2" -o jsonpath='{.metadata.uid}' 2>/dev/null || true; }
sbx_pod() {
  $KUBECTL -n "$TNS" get pods -l "agents.x-k8s.io/claim-uid=$(claim_uid)" --field-selector=status.phase=Running \
    -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null | head -1
}
sbx_ready() { [[ -n "$(sbx_pod)" ]]; }
in_sbx() { $KUBECTL -n "$TNS" exec "$(sbx_pod)" -c agent -- sh -c "$1" 2>&1 || true; }
chat() { # content [thread] [ask] → the run step's key=value lines (t2 chats)
  local thread=null
  [[ -n "${2:-}" ]] && thread="\"$2\""
  client "$(printf '{"mode":"run","base":"%s","user":%s,"content":"%s","threadId":%s,"ask":%s,"domain":"%s","timeoutMs":300000}' \
    "$BASE" "$U_T2" "$1" "$thread" "${3:-false}" "${UP_HOST:-}")" | grep -E '^[a-z_]+=' || true
}
wake() { # a short chat wakes the sandbox and leaves a thread to read later
  local r
  r=$(chat "gate2 hello $NONCE")
  HELLO_THREAD=$(field thread "$r")
  until_ok 120 sbx_ready || true
}
wake
contains "t2's sandbox runs (gVisor, own namespace) and answers" '^[0-9a-f-]{36}$' "$(claim_uid)"
SBX_ID=$(claim_uid)
contains "the sandbox pod runs under gVisor" '^gvisor$' \
  "$($KUBECTL -n "$TNS" get pod "$(sbx_pod)" -o jsonpath='{.spec.runtimeClassName}' 2>/dev/null)"

# ---- infrastructure for ac-2 and ac-3: a TLS upstream and a plain-HTTP MCP server ------------------
if [[ "$STEPS" == *" egress "* || "$STEPS" == *" mcp "* ]]; then
  echo "==> test servers in $INFRA_NS and the proxies' allow-lists"
  $KUBECTL create namespace "$INFRA_NS" --dry-run=client -o yaml | $KUBECTL apply -f - >/dev/null
  if [[ "$($KUBECTL -n "$INFRA_NS" get pod upstream -o jsonpath='{.status.phase}' 2>/dev/null)" != Running ]]; then
    $KUBECTL -n "$INFRA_NS" delete pod upstream --ignore-not-found >/dev/null
    $KUBECTL -n "$INFRA_NS" run upstream --restart=Never --image="$SANDBOX_IMAGE" --image-pull-policy=IfNotPresent --labels=app=upstream \
      --command -- sh -c 'cd /tmp && openssl req -x509 -newkey rsa:2048 -nodes -keyout k.pem -out c.pem -days 1 \
        -subj /CN=upstream >/dev/null 2>&1 && exec openssl s_server -quiet -accept 8443 -cert c.pem -key k.pem -www' >/dev/null
  fi
  $KUBECTL -n "$INFRA_NS" get svc upstream >/dev/null 2>&1 \
    || $KUBECTL -n "$INFRA_NS" expose pod upstream --port=443 --target-port=8443 --name=upstream >/dev/null
  if [[ "$($KUBECTL -n "$INFRA_NS" get pod fake-mcp -o jsonpath='{.status.phase}' 2>/dev/null)" != Running ]]; then
    $KUBECTL -n "$INFRA_NS" delete pod fake-mcp --ignore-not-found >/dev/null
    $KUBECTL -n "$INFRA_NS" run fake-mcp --restart=Never --image="$SANDBOX_IMAGE" --image-pull-policy=IfNotPresent --labels=app=fake-mcp \
      --command -- node -e "$(cat e2e/lib/fake-mcp.js)" >/dev/null
  fi
  $KUBECTL -n "$INFRA_NS" get svc fake-mcp >/dev/null 2>&1 \
    || $KUBECTL -n "$INFRA_NS" expose pod fake-mcp --port=80 --target-port=8080 --name=fake-mcp >/dev/null
  for p in upstream fake-mcp; do
    $KUBECTL -n "$INFRA_NS" wait --for=condition=Ready "pod/$p" --timeout=180s >/dev/null 2>&1 || true
  done
  UP_HOST="upstream.$INFRA_NS.svc.cluster.local"
  UP_IP=$($KUBECTL -n "$INFRA_NS" get svc upstream -o jsonpath='{.spec.clusterIP}')
  MCP_IP=$($KUBECTL -n "$INFRA_NS" get svc fake-mcp -o jsonpath='{.spec.clusterIP}')
  contains "the TLS upstream and the fake MCP server run" '^Running Running$' \
    "$($KUBECTL -n "$INFRA_NS" get pod upstream fake-mcp -o jsonpath='{.items[0].status.phase} {.items[1].status.phase}' 2>/dev/null)"
  infra_rule=$(printf '[{"to":[{"namespaceSelector":{"matchLabels":{"kubernetes.io/metadata.name":"%s"}}}]}]' "$INFRA_NS")
  saved="$WORK/values.yaml"
  # `--reuse-values` would keep the old chart's defaults; saved values + --reset-values do not.
  $HELM get values "$RELEASE" -n "$NS" -o yaml >"$saved"
  roll_from=$(server_now)
  if out=$($HELM upgrade "$RELEASE" "$CHART" -n "$NS" -f "$saved" --reset-values --wait --timeout 8m \
      --set mcpProxy.allowInsecureHttp=true --set-json 'mcpProxy.allowedPorts=[80]' \
      --set-json "mcpProxy.allowedInternalCidrs=[\"$MCP_IP/32\"]" --set-json "mcpProxy.networkPolicy.extraEgress=$infra_rule" \
      --set-json "egressProxy.allowedInternalCidrs=[\"$UP_IP/32\"]" --set-json "egressProxy.networkPolicy.extraEgress=$infra_rule" \
      --set egressProxy.auditFlushSeconds=5 2>&1); then
    ok "the egress and MCP proxies allow exactly the two test servers (chart upgraded, saved values kept)"
  else
    fail "the proxies allow the two test servers: $(printf '%s' "$out" | tail -3)"
  fi
  if ((RESTORE_HELM)); then
    UNDO+=("$HELM upgrade $RELEASE $CHART -n $NS -f $saved --reset-values --wait --timeout 8m")
  fi
  # The upgrade rolls the server; wait for the sandbox to reconnect to the new one, so no hello
  # from the old connection can follow and interrupt the run leased for ac-3 (KOBE-132).
  wake
  reconnected() { [[ "$(field wire_open_since "$(step wire "\"teamId\":\"$TEAM\",\"userId\":\"$T2\",\"since\":\"$roll_from\"")")" =~ ^[1-9] ]]; }
  if until_ok 180 reconnected; then ok "the sandbox is connected to the rolled server"; else fail "the sandbox is connected to the rolled server"; fi
fi

# ---- ac-1: a team budget at 100% ------------------------------------------------------------------
if [[ "$STEPS" == *" budget "* ]]; then
  echo "==> ac-1: budget used up mid-run: the step in flight finishes, then run.budget_stopped"
  if ((MODELS)); then
    started=$(server_now)
    priced=$(step price "\"alias\":\"$MODEL_ALIAS\",\"action\":\"set\"")
    contains "the catalog model has a price (set only when it had none)" '^price=(set:200|kept)$' "$priced"
    contains "the team budget is set to \$0.01 a month" '^budget_status=200$' \
      "$(step reset "\"admin\":$U_T1,\"budget\":0.01")"
    [[ "$priced" == *price=set* ]] && UNDO+=("client '$(printf '{"mode":"price","base":"%s","owner":%s,"alias":"%s","action":"restore"}' "$BASE" "$OWNER_JSON" "$MODEL_ALIAS")'")
    UNDO+=("client '$(printf '{"mode":"reset","base":"%s","admin":%s,"budget":null}' "$BASE" "$U_T1")'")
    prompt="${KOBE_GATE2_BUDGET_PROMPT:-kobe-tool-step budget-$NONCE}"
    b=$(chat "$prompt")
    printf '%s\n' "$b" | grep -v '^text=' | cut -c1-300 | sed 's/^/     /'
    brun=$(field run "$b")
    contains "the run ends budget_stopped" '^terminal=run.budget_stopped$' "$b"
    contains "with the budget's message" '^budget_message=.*used up' "$b"
    contains "the step in flight finished first (its tool result precedes the stop)" '^tool_result_before_terminal=true$' "$b"
    led=$(step ledger "\"teamId\":\"$TEAM\",\"runId\":\"${brun:-none}\"")
    contains "the step's model call is in the ledger" '^usage_ok_rows=1$' "$led"
    contains "no new model call started after the budget was used up" '^usage_rows=1$' "$led"
    contains "the stop is audited for that run (run.budget_stopped)" "\"runId\":\"${brun:-none}\"" \
      "$(step audit "\"admin\":$U_T1,\"action\":\"run.budget_stopped\",\"since\":\"$started\"")"
    contains "the budget reached is audited (models.budget.reached)" '^audit_count=[1-9]' \
      "$(step audit "\"admin\":$U_T1,\"action\":\"models.budget.reached\",\"since\":\"$started\"")"
    contains "new runs are refused while the budget is used up (429)" '^message=429' \
      "$(client "$(printf '{"mode":"send","base":"%s","user":%s,"content":"refused %s"}' "$BASE" "$U_T2" "$NONCE")")"
    contains "the budget is removed again" '^budget_status=200$' \
      "$(step reset "\"admin\":$U_T1,\"budget\":null")"
    [[ "$priced" == *price=set* ]] && step price "\"alias\":\"$MODEL_ALIAS\",\"action\":\"restore\"" >/dev/null
  else
    fail "ac-1 needs a model on the install (catalog entry '$MODEL_ALIAS' enabled for the team)"
  fi
fi

# ---- ac-2: blocked domain -> Request access -> enablement ------------------------------------------
if [[ "$STEPS" == *" egress "* ]]; then
  echo "==> ac-2: blocked domain, Request access, team-admin enablement, then the same request works"
  if ((MODELS)); then
    started=$(server_now)
    ceil=$(step ceiling "\"domain\":\"$UP_HOST\",\"action\":\"add\"")
    contains "the test upstream is in the install's egress ceiling (not yet enabled for the team)" '^ceiling=(added|present)' "$ceil"
    [[ "$ceil" == *ceiling=added* ]] && UNDO+=("client '$(printf '{"mode":"ceiling","base":"%s","owner":%s,"domain":"%s","action":"remove"}' "$BASE" "$OWNER_JSON" "$UP_HOST")'")
    step reset "\"admin\":$U_T1,\"domain\":\"$UP_HOST\"" >/dev/null
    UNDO+=("client '$(printf '{"mode":"reset","base":"%s","admin":%s,"domain":"%s"}' "$BASE" "$U_T1" "$UP_HOST")'")
    tool="${KOBE_GATE2_EGRESS_PROMPT:-bash: curl -sSk -m 20 https://$UP_HOST/ 2>&1 | head -c 300}"
    first=$(chat "$tool" "" true)
    printf '%s\n' "$first" | cut -c1-300 | sed 's/^/     /'
    contains "the run completed (the sandbox's tool ran curl)" '^terminal=run.completed$' "$first"
    contains "the request was blocked by the egress proxy" '^text=.*(403|Kobe egress)|^tool_output=.*(403|Kobe egress)' "$first"
    contains "the blocked request reached the run as egress.blocked with request access" "^blocked=.*$UP_HOST:true" "$first"
    contains "the member asked for access from the thread (pending)" '^request=201:pending$' "$first"
    e_thread=$(field thread "$first")
    decided=$(step decide "\"admin\":$U_T1,\"requestId\":\"$(field request_id "$first")\"")
    contains "the team admin sees the request with its thread" "^admin_sees_request=thread=$e_thread\$" "$decided"
    contains "the team admin approves it" '^decision=200:approved$' "$decided"
    second=""
    for _ in 1 2 3; do
      second=$(chat "$tool" "$e_thread")
      [[ "$second" == *s_server* ]] && break
      sleep 5
    done
    printf '%s\n' "$second" | cut -c1-300 | sed 's/^/     /'
    contains "the same request succeeds after the approval (the upstream answers)" 's_server' "$second"
    contains "request access is audited (created)" '^audit_count=[1-9]' \
      "$(step audit "\"admin\":$U_T1,\"action\":\"egress.request.created\",\"since\":\"$started\"")"
    contains "request access is audited (decided)" '^audit_count=[1-9]' \
      "$(step audit "\"admin\":$U_T1,\"action\":\"egress.request.decided\",\"since\":\"$started\"")"
    step reset "\"admin\":$U_T1,\"domain\":\"$UP_HOST\"" >/dev/null
    step ceiling "\"domain\":\"$UP_HOST\",\"action\":\"remove\"" >/dev/null 2>&1 || true
  else
    fail "ac-2 needs a model on the install (catalog entry '$MODEL_ALIAS' enabled for the team)"
  fi
fi

# ---- ac-3: tampered kobe-policy cannot execute an MCP write ------------------------------------------
if [[ "$STEPS" == *" mcp "* ]]; then
  echo "==> ac-3: tampered kobe-policy: an MCP write needs a valid signed approval"
  sbx_ready || wake
  POLICY=/opt/kobe/pi-extensions/kobe-policy
  tamper=$(in_sbx "f=$POLICY/index.js
    echo before=\$(sha256sum \$f | cut -d' ' -f1)
    ( echo '// tampered' >> \$f ) 2>/dev/null && echo append=WRITTEN || echo append=DENIED
    ( printf x > $POLICY/extra.js ) 2>/dev/null && echo create=WRITTEN || echo create=DENIED
    ( chmod u+w \$f ) 2>/dev/null && echo chmod=DONE || echo chmod=DENIED
    ( rm -f \$f ) 2>/dev/null; [ -f \$f ] && echo remove=DENIED || echo remove=REMOVED
    ( mv $POLICY $POLICY.off ) 2>/dev/null && echo move=DONE || echo move=DENIED
    echo after=\$(sha256sum \$f | cut -d' ' -f1)")
  contains "in the sandbox the extension cannot be appended to" '^append=DENIED$' "$tamper"
  contains "nor can a file be added next to it" '^create=DENIED$' "$tamper"
  contains "nor made writable" '^chmod=DENIED$' "$tamper"
  contains "nor removed" '^remove=DENIED$' "$tamper"
  contains "nor its directory moved aside" '^move=DENIED$' "$tamper"
  contains "its content is unchanged after every attempt" "^after=$(printf '%s' "$tamper" | sed -n 's/^before=//p' | head -1)\$" "$tamper"
  # Where a tampered extension is concerned the sandbox may do worse than editing the file: an
  # extension that never asks policy.check is a client calling the MCP proxy directly. This one
  # does, from inside the real sandbox container, with a valid session token for it.
  mint=$(client "$(printf '{"mode":"mint2","base":"%s","audiences":["kobe.mcp-proxy"],"sandboxId":"%s","teamId":"%s","userId":"%s"}' "$BASE" "$SBX_ID" "$TEAM" "$T2")")
  mcp_token=$(printf '%s\n' "$mint" | sed -n 's/^token kobe.mcp-proxy //p')
  contains "an mcp-proxy session token for the sandbox was minted" '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' "$mcp_token"
  fixture=$(client "$(printf '{"mode":"mcp-fixture","base":"%s","teamId":"%s","userId":"%s","sandboxId":"%s","connectorId":"%s","url":"http://%s/mcp"}' \
    "$BASE" "$TEAM" "$T2" "$SBX_ID" "$CONNECTOR_ID" "$MCP_IP")")
  MCP_THREAD=$(field mcp_thread "$fixture")
  MCP_RUN=$(field mcp_run "$fixture")
  contains "a connector, the team's enablement and a run leased to the sandbox are in place" '^[0-9a-f-]{36}$' "$MCP_RUN"
  UNDO+=("client '$(printf '{"mode":"mcp-clean","base":"%s","teamId":"%s","runId":"%s","connectorId":"%s"}' "$BASE" "$TEAM" "$MCP_RUN" "$CONNECTOR_ID")'")
  proxy_ip=$($KUBECTL -n "$NS" get svc "$RELEASE-mcp-proxy" -o jsonpath='{.spec.clusterIP}')
  mcp_rpc() { # token json-body → the answer body, then "status=<http status>"
    in_sbx "curl -s -m 30 --noproxy '*' -w '\nstatus=%{http_code}\n' -H 'authorization: Bearer $1' -H 'content-type: application/json' \
      -H 'accept: application/json, text/event-stream' -H 'kobe-thread-id: $MCP_THREAD' --data-raw '$2' http://$proxy_ip:80/v1/mcp/$CONNECTOR_ID"
  }
  fake_calls() { $KUBECTL -n "$INFRA_NS" logs fake-mcp 2>&1 | grep -c "^CALL $1 " || true; }
  fake_auth() { $KUBECTL -n "$INFRA_NS" logs fake-mcp 2>&1 | grep -c AUTH-HEADER-PRESENT || true; }
  up=$(in_sbx "if { n=0; while [ \$n -lt 60 ]; do curl -s -o /dev/null -m 5 -X POST --noproxy '*' http://$proxy_ip:80/v1/mcp/$CONNECTOR_ID && break; n=\$((n+1)); sleep 2; done; [ \$n -lt 60 ]; }; then echo mcp=ANSWERS; else echo mcp=SILENT; fi")
  contains "control: the MCP proxy answers from inside the sandbox" '^mcp=ANSWERS$' "$up"
  contains "the proxy refuses a forged session token (401)" '^status=401$' "$(mcp_rpc forged.token.value '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')"
  contains "tools/list serves the connector's pinned tools" '"name":"get_thing".*"name":"create_thing"' \
    "$(mcp_rpc "$mcp_token" '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')"
  reads0=$(fake_calls get_thing); writes0=$(fake_calls create_thing); auth0=$(fake_auth)
  contains "a read-only tool call goes through the proxy to the remote server" 'fake:get_thing' \
    "$(mcp_rpc "$mcp_token" '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_thing","arguments":{"id":"7"}}}')"
  write=$(mcp_rpc "$mcp_token" '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"create_thing","arguments":{"title":"x"}}}')
  printf '     MCP write without approval: %s\n' "$(printf '%s' "$write" | tr '\n' ' ' | cut -c1-200)"
  contains "an MCP write without a signed approval is refused at the proxy" '"isError":true' "$write"
  contains "the refusal is the server's policy decision" 'Kobe denied this call' "$write"
  contains "the remote server received the read (and only the read)" "^$((reads0 + 1))\$" "$(fake_calls get_thing)"
  contains "the remote server never received the unapproved write" "^$writes0\$" "$(fake_calls create_thing)"
  contains "the sandbox's session token never reaches the remote server" "^$auth0\$" "$(fake_auth)"
  decisions=$(step audit "\"admin\":$U_T1,\"action\":\"mcp.tool_call\"")
  contains "the denied write is audited with why its approval was missing" '"decision":"denied".*"approvalFailure":"no_approval"|"approvalFailure":"no_approval".*"decision":"denied"' "$decisions"
  client "$(printf '{"mode":"approve","base":"%s","teamId":"%s","userId":"%s","runId":"%s","threadId":"%s","toolCallId":"toolu_gate2_%s","tool":"mcp__gate2_fake__create_thing","input":{"title":"x"}}' \
    "$BASE" "$TEAM" "$T2" "$MCP_RUN" "$MCP_THREAD" "$NONCE")" >/dev/null
  contains "with a valid signed approval the same write runs" 'fake:create_thing' \
    "$(mcp_rpc "$mcp_token" '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"create_thing","arguments":{"title":"x"}}}')"
  contains "the approval is used once (a replay is refused)" '"isError":true' \
    "$(mcp_rpc "$mcp_token" '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"create_thing","arguments":{"title":"x"}}}')"
  contains "the remote server received the approved write exactly once" "^$((writes0 + 1))\$" "$(fake_calls create_thing)"
  contains "the approval was consumed and audited (approval.consumed)" '^audit_count=[1-9]' \
    "$(step audit "\"admin\":$U_T1,\"action\":\"approval.consumed\"" | grep '^audit_count=')"
fi

# ---- ac-4: break-glass ---------------------------------------------------------------------------------
if [[ "$STEPS" == *" break-glass "* ]]; then
  echo "==> ac-4: break-glass: second admin approves, the team is told, every read is audited"
  bg=$(client "$(printf '{"mode":"break-glass","base":"%s","owner":%s,"requester":%s,"teamAdmin":%s,"teamId":"%s","threadId":"%s"}' \
    "$BASE" "$OWNER_JSON" "$U_IA" "$U_T1" "$TEAM" "${HELLO_THREAD:-none}")")
  printf '%s\n' "$bg" | sed 's/^/     /'
  contains "an install admin requests access to the team (pending)" '^request=201:pending$' "$bg"
  contains "the requester can't approve their own request (second admin required)" '^self_approve=403:self_approval_forbidden$' "$bg"
  contains "nothing can be read before approval" '^read_before_approval=403:grant_not_active$' "$bg"
  contains "the other install admin approves it" '^approve=200:active$' "$bg"
  contains "it is a two-person approval, not a self-approval" '^approve_self_approved=false$' "$bg"
  contains "the team's admins are queued for the notification" '^approve_team_admins_queued=[1-9]' "$bg"
  contains "the notification is durable in the outbox (delivery depends on the install's mail)" '^notification=team_admin/approved/(sent|pending|failed)=[1-9]' "$bg"
  contains "the team admin sees the active grant in the team's banner" '^team_banner=active:' "$bg"
  contains "the three reads under the grant succeed" '^reads=200,200,200$' "$bg"
  contains "the grant is not honored by normal team routes" '^normal_route_with_grant=(403|404|409)$' "$bg"
  contains "every read is in the team's audit log (3 reads, 3 events)" '^audited_reads=3$' "$bg"
  contains "each audit event names the grant" '^audited_reads_have_target=true$' "$bg"
  contains "revoking ends access at once" '^revoke=200:revoked$' "$bg"
  contains "a read after the revocation is refused" '^read_after_revoke=403:grant_not_active$' "$bg"
  for a in requested approved revoked; do contains "the team's audit log has governance.break_glass.$a" "^team_audit_$a=[1-9]" "$bg"; done
fi

# ---- ac-5: secret scan of the running sandbox -------------------------------------------------------------
if [[ "$STEPS" == *" scan "* ]]; then
  echo "==> ac-5: secret scan of t2's running sandbox"
  sbx_ready || wake
  run_secret_scan
fi

if ((failed)); then
  echo "Gate 2 suite: FAILED"
  exit 1
fi
echo "Gate 2 suite: all checks passed"
