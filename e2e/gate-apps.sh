#!/usr/bin/env bash
# The Kobe Explorer Gate (KOBE-441; MCP Apps host spec docs/specs/mcp-apps-host.md §11): an MCP App
# in the conversation first, then from the rail, with the negative checks. API checks run in a
# server pod (e2e/gate-apps/client.mjs); the browser checks are Playwright specs in a real Chromium
# (e2e/browser/tests/gate-apps/explorer.spec.ts and app-frame.spec.ts with KOBE_REQUIRE_APP=1).
# docs/gates/gate-apps.md says what each check proves.
#
#   e2e/gate-apps.sh                  on k3d after the gate1-prep install (CI): the fake MCP server
#                                     serves a `ui://` test app, the scripted model calls its tool
#   KOBE_GATEAPPS_BROWSER=0 ...       API checks only; prints the browser command to run elsewhere,
#                                     whose report KOBE_GATEAPPS_RESULTS=<results.json> then judges
#
# The gate install against Catalyst is the coordinator's run (docs/gates/gate-apps-runbook.md); it
# uses the browser spec with the gate install's own connector and accounts, never this script's
# k3d fixtures. This script refuses any context but k3d-* unless KOBE_GATEAPPS_CONTEXT names it.
set -euo pipefail
cd "$(dirname "$0")/.."

KUBECTL="${KUBECTL:-kubectl}"
HELM="${HELM:-helm}"
NS="${KOBE_GATEAPPS_NS:-kobe-dev}"
RELEASE="${KOBE_GATEAPPS_RELEASE:-kobe}"
CHART="${KOBE_GATEAPPS_CHART:-charts/kobe}"
OWNER_EMAIL="${KOBE_GATEAPPS_OWNER_EMAIL:-owner@e2e.test}"
OWNER_PASSWORD="${KOBE_GATEAPPS_OWNER_PASSWORD:-e2e owner password}"
MODEL_ALIAS="${KOBE_GATEAPPS_MODEL:-fast}"
BROWSER="${KOBE_GATEAPPS_BROWSER:-$([[ "${CI:-}" == true ]] && echo 1 || echo 0)}"
TEAM_SLUG=gate-apps-a
INFRA_NS=kobe-gate-apps-infra
SERVER="deploy/$RELEASE-server"
BASE="http://$RELEASE-server.$NS.svc.cluster.local"
NONCE="$(date +%s)"
USER_PASSWORD="gate1 user password" # the fixtures' password (e2e/gate1/client.mjs)
MEMBER_KEY="gate-apps-member-key-$NONCE"
APP_TOOL=mcp__e2e_apps__open_explorer
failed=0

context=$($KUBECTL config current-context)
if [[ "$context" != k3d-* && "$context" != "${KOBE_GATEAPPS_CONTEXT:-}" ]]; then
  echo "refusing to run against context '$context' (expected k3d-*, or set KOBE_GATEAPPS_CONTEXT=$context)" >&2
  exit 2
fi
RESTORE_HELM="${KOBE_GATEAPPS_RESTORE_HELM:-$([[ "$context" == k3d-* ]] && echo 0 || echo 1)}"

# shellcheck source=lib/gate-common.sh
source e2e/lib/gate-common.sh
# shellcheck source=lib/gate-turns.sh
source e2e/lib/gate-turns.sh
FAKE=1 # read by gate-turns.sh: the scripted model's grammar

# shellcheck disable=SC2034 # read by client() in gate-common.sh
CLIENT_JS="$(for f in e2e/gate1/client.mjs e2e/gate2/client.mjs e2e/gate3/client.mjs; do sed '/^const MODES = {/,$d' "$f"; done
  cat e2e/gate-apps/client.mjs)"
WORK=$(mktemp -d)
chmod 700 "$WORK"
PODS=()
UNDO=()
cleanup() {
  local rc=$?
  local u p
  for p in "${PODS[@]+"${PODS[@]}"}"; do $KUBECTL delete pod $p --ignore-not-found --wait=false >/dev/null 2>&1 || true; done
  for u in "${UNDO[@]+"${UNDO[@]}"}"; do eval "$u" >/dev/null 2>&1 || true; done
  rm -rf "$WORK"
  verdict_on_exit "$rc" "Kobe Explorer Gate"
}
trap cleanup EXIT

# Each part of the gate: its checks set `failed`; `part_end` records which parts failed.
PARTS_FAILED=" "
failed_before=0
part_begin() { failed_before=$failed; failed=0; echo "==> $1"; }
part_end() { # part
  ((failed)) && PARTS_FAILED+="$1 "
  ((failed_before)) && failed=1
  return 0
}

# ---- fixtures: team gate-apps-a, a team admin (the browser's member) and a member -------------------
user_json() { # key ip-suffix → fixture JSON
  printf '{"key":"%s","email":"gate-apps-%s@gate-apps.test","name":"Apps %s","team":"a","ip":"198.51.100.%s"}' "$1" "$1" "$1" "$2"
}
echo "==> fixtures: team $TEAM_SLUG"
ensure_fake_llm
setup_token=$($KUBECTL -n "$NS" get secret "$RELEASE-auth" -o jsonpath='{.data.setup-token}' 2>/dev/null | base64 -d 2>/dev/null || true)
fx=$(client "$(printf '{"mode":"fixtures","base":"%s","modelAlias":"%s","owner":{"email":"%s","password":"%s"},"setupToken":"%s","users":[%s,%s],"teams":[{"key":"a","slug":"%s","name":"Gate Apps A"}]}' \
  "$BASE" "$MODEL_ALIAS" "$OWNER_EMAIL" "$OWNER_PASSWORD" "$setup_token" "$(user_json ad 81)" "$(user_json m2 82)" "$TEAM_SLUG")")
fixtures=$(field fixtures "$fx")
json_get() { printf '%s' "$fixtures" | sed -n "s/.*\"$1\":\"\([0-9a-f-]*\)\".*/\1/p"; }
TEAM=$(json_get a)
AD=$(json_get ad)
M2=$(json_get m2)
if [[ ! "$TEAM $AD $M2" =~ ^([0-9a-f-]{36}\ ){2}[0-9a-f-]{36}$ ]]; then
  printf '%s\n' "$fx" | sed 's/^/     /'
  fail "fixtures: the team and its users"
  exit 1
fi
ok "fixtures: the team and its users"
U_AD=$(printf '{"key":"ad","email":"gate-apps-ad@gate-apps.test","ip":"198.51.100.81","teamId":"%s","userId":"%s"}' "$TEAM" "$AD")
U_M2=$(printf '{"key":"m2","email":"gate-apps-m2@gate-apps.test","ip":"198.51.100.82","teamId":"%s","userId":"%s"}' "$TEAM" "$M2")
OWNER_JSON=$(printf '{"email":"%s","password":"%s"}' "$OWNER_EMAIL" "$OWNER_PASSWORD")
step() { client "$(printf '{"mode":"%s","base":"%s","owner":%s,%s}' "$1" "$BASE" "$OWNER_JSON" "$2")"; }
# Connectors reach a run only through its agent's list (resolver: agent list ∩ team-enabled ∩
# user-connected; a thread with no agent gets none): the turns use the gallery agent Kobe
# (`connectors: all`), as the chat preselects it for a new conversation (KOBE-124).
KOBE_AGENT=$(field gallery_agent "$(step gallery-agent '"key":"kobe"')")
[[ "$KOBE_AGENT" =~ ^[0-9a-f-]{36}$ ]] || { fail "the gallery agent Kobe exists"; exit 1; }
AGENT_FIELD="\"agentId\":\"$KOBE_AGENT\""

# ---- the fake MCP Apps server and the proxies' allow-list ---------------------------------------------
part_begin "setup: the fake MCP server serves ui://e2e/explorer; the connectors are pinned and enabled"
SERVER_IMAGE=$($KUBECTL -n "$NS" get "$SERVER" -o jsonpath='{.spec.template.spec.containers[?(@.name=="server")].image}')
SANDBOX_IMAGE="${KOBE_GATEAPPS_SANDBOX_IMAGE:-${SERVER_IMAGE/kobe-server/kobe-sandbox}}"
$KUBECTL create namespace "$INFRA_NS" --dry-run=client -o yaml | $KUBECTL apply -f - >/dev/null
$KUBECTL -n "$INFRA_NS" delete pod fake-mcp --ignore-not-found >/dev/null
$KUBECTL -n "$INFRA_NS" run fake-mcp --restart=Never --image="$SANDBOX_IMAGE" --image-pull-policy=IfNotPresent \
  --labels=app=fake-mcp --env=FAKE_MCP_APPS=1 --command -- node -e "$(cat e2e/lib/fake-mcp.js)" >/dev/null
$KUBECTL -n "$INFRA_NS" get svc fake-mcp >/dev/null 2>&1 \
  || $KUBECTL -n "$INFRA_NS" expose pod fake-mcp --port=80 --target-port=8080 --name=fake-mcp >/dev/null
$KUBECTL -n "$INFRA_NS" wait --for=condition=Ready pod/fake-mcp --timeout=180s >/dev/null 2>&1 || true
MCP_IP=$($KUBECTL -n "$INFRA_NS" get svc fake-mcp -o jsonpath='{.spec.clusterIP}')
contains "the fake MCP Apps server runs" '^Running$' "$($KUBECTL -n "$INFRA_NS" get pod fake-mcp -o jsonpath='{.status.phase}' 2>/dev/null)"
infra_rule=$(printf '[{"to":[{"namespaceSelector":{"matchLabels":{"kubernetes.io/metadata.name":"%s"}}}]}]' "$INFRA_NS")
saved="$WORK/values.yaml"
# `--reuse-values` would keep the old chart's defaults; saved values + --reset-values do not.
$HELM get values "$RELEASE" -n "$NS" -o yaml >"$saved"
if out=$($HELM upgrade "$RELEASE" "$CHART" -n "$NS" -f "$saved" --reset-values --wait --timeout 8m \
    --set mcpProxy.allowInsecureHttp=true --set-json 'mcpProxy.allowedPorts=[80]' \
    --set-json "mcpProxy.allowedInternalCidrs=[\"$MCP_IP/32\"]" --set-json "mcpProxy.networkPolicy.extraEgress=$infra_rule" 2>&1); then
  ok "the MCP proxy allows exactly the fake server (chart upgraded, saved values kept)"
else
  fail "the MCP proxy allows the fake server: $(printf '%s' "$out" | tail -3)"
fi
((RESTORE_HELM)) && UNDO+=("$HELM upgrade $RELEASE $CHART -n $NS -f $saved --reset-values --wait --timeout 8m")
$KUBECTL -n "$NS" rollout status "$SERVER" --timeout=300s >/dev/null 2>&1 || true
CONNECTORS=$(printf '[{"key":"apps","name":"e2e-apps"},{"key":"key","name":"e2e-apps-key","authKind":"api_key","adminKey":"%s"}]' "$MEMBER_KEY")
setup=$(step apps-setup "\"admin\":$U_AD,\"url\":\"http://$MCP_IP/mcp\",\"connectors\":$CONNECTORS")
show "setup" "$setup"
contains "the app's connector is registered with its tools pinned" '^(register_apps=201:true|connector_apps=[0-9a-f-]{36})$' "$setup"
contains "...its template is pinned and approved" '^templates_apps=ui://e2e/explorer:pinned$' "$setup"
contains "...and the team enables it" '^enable_apps=200$' "$setup"
contains "the key connector's template is pinned too" '^templates_key=ui://e2e/explorer:pinned$' "$setup"
contains "...and the member's key is saved" '^admin_key_key=20[01]$' "$setup"
CONNECTOR=$(field connector_apps "$setup")
KEY_CONNECTOR=$(field connector_key "$setup")
APP=$(field app_apps "$setup")
KEY_APP=$(field app_key "$setup")
contains "the member has the app (MA8)" '^[0-9a-f]{64}$' "$APP"
part_end setup

# ---- (a) in the conversation ----------------------------------------------------------------------
part_begin "conversation: real Pi passes MCP arguments unchanged (a default; \"5\" for an integer)"
coerced=$(turn "$U_AD" "tool: $APP_TOOL {\"depth\":\"5\"}" "\"title\":\"apps coerced\",$AGENT_FIELD")
show "coerced turn" "$coerced"
contains "the turn that calls the opening tool with \"5\" completes" '^terminal=run.completed$' "$coerced"
COERCED_THREAD=$(field thread "$coerced")
r1=$(step apps-results "\"user\":$U_AD,\"threadId\":\"$COERCED_THREAD\"")
show "results" "$r1"
contains "...its tool card gets the app (the claim matched Pi's input)" '^result=tool:app:-:in$' "$r1"
contains "...the tool.result carries the server's app marker" "^app_marker=$APP_TOOL:yes\$" "$r1"
defaulted=$(turn "$U_AD" "tool: $APP_TOOL {}" "\"title\":\"apps default\",$AGENT_FIELD")
contains "the turn that leaves the default out completes" '^terminal=run.completed$' "$defaulted"
r2=$(step apps-results "\"user\":$U_AD,\"threadId\":\"$(field thread "$defaulted")\"")
show "results" "$r2"
contains "...its tool card gets the app too" '^result=tool:app:-:in$' "$r2"
upstream=$($KUBECTL -n "$INFRA_NS" logs fake-mcp 2>&1 | grep '^CALL open_explorer' | tail -2 | tr '\n' ' ')
printf '     upstream saw: %s\n' "$upstream"
# What Pi recorded is the model's raw arguments; what reached the upstream is Pi's conversion.
contains "the upstream received Pi's converted arguments (5, not \"5\")" 'CALL open_explorer \{"depth":5\}' "$upstream"
part_end args

part_begin "conversation: the app's own calls are the member's, read-only and audited"
c1=$(step apps-call "\"user\":$U_AD,\"appId\":\"$APP\",\"tool\":\"list_items\",\"args\":{\"parent\":\"c\"}")
contains "expanding a node: one read call, allowed" '^call=200:ok$' "$c1"
contains "...audited as mcp.app_call with the member" '^audit_last=list_items:allowed:allowed$' "$c1"
c2=$(step apps-call "\"user\":$U_AD,\"appId\":\"$APP\",\"tool\":\"create_thing\",\"args\":{\"title\":\"x\"}")
contains "the app's write tool is refused" '^call=403:' "$c2"
contains "...and the refusal is audited" '^audit_last=create_thing:denied:' "$c2"
part_end bridge

part_begin "conversation: the sandbox cannot forge a result"
fg=$(step apps-forged "\"connectorId\":\"$CONNECTOR\"")
contains "a report without the internal key is refused" '^forged_no_key=401$' "$fg"
contains "a report with a forged sandbox token is refused" '^forged_token=401$' "$fg"
part_end forged

# ---- (b) from the rail --------------------------------------------------------------------------
part_begin "rail: a launch inserts an app card with no run; the next run's prompt has the fenced card"
l1=$(step apps-launch "\"user\":$U_AD,\"appId\":\"$APP\"")
show "launch" "$l1"
contains "the launch into a new thread inserts a card" '^launch=201:false$' "$l1"
contains "...and starts no run" '^runs=0$' "$l1"
RAIL_THREAD=$(field thread "$l1")
h=$(turn "$U_AD" "history?" "\"threadId\":\"$RAIL_THREAD\"")
contains "the next run completes" '^terminal=run.completed$' "$h"
contains "...and the model was given the card, fenced, untrusted, opened by the member" \
  'app-card source="connector:e2e-apps" tool="open_explorer" opened_by_member="true" untrusted="true"' "$(said "$h")"
contains "...never its structured result" '^0$' "$(grep -c 'e2e-structured-only' <<<"$(said "$h")" || true)"
e1=$(step apps-entries "\"user\":$U_AD,\"threadId\":\"$RAIL_THREAD\"")
show "entries" "$e1"
contains "the card is a server entry with the fenced text and no structured result" '^card=true:true:false$' "$e1"
contains "...and the member's prompt hangs below it" '^below_card=(user|custom)$' "$e1"
part_end rail

part_begin "rail: a launch during a run waits and goes in when it ends, before the next message"
q0=$(turn "$U_AD" "No tools. Reply OK." '"title":"apps queue"')
QUEUE_THREAD=$(field thread "$q0")
turn "$U_AD" "kobe-long-answer=400 a long answer" "\"threadId\":\"$QUEUE_THREAD\"" >"$WORK/long.out" 2>&1 &
long=$!
sleep 6
q1=$(step apps-launch "\"user\":$U_AD,\"threadId\":\"$QUEUE_THREAD\",\"appId\":\"$APP\"")
contains "the launch during the run is queued" '^launch=201:true$' "$q1"
wait "$long" || true
contains "the long run completes" '^terminal=run.completed$' "$(cat "$WORK/long.out")"
q2=$(turn "$U_AD" "No tools. Reply DONE." "\"threadId\":\"$QUEUE_THREAD\"")
contains "the next message runs" '^terminal=run.completed$' "$q2"
e2=$(step apps-entries "\"user\":$U_AD,\"threadId\":\"$QUEUE_THREAD\"")
show "entries" "$e2"
contains "the card went in once" '^cards=1$' "$e2"
contains "...before the next message" '^card_before_last_prompt=true$' "$e2"
part_end queue

part_begin "negative: a member without a key gets text cards and no rail app"
m=$(step apps-member "\"user\":$U_M2")
show "member" "$m"
contains "the member's rail lacks the key connector's app" '^apps=e2e-apps$' "$m"
contains "...and says Add your key for it" '^needs_key=e2e-apps-key$' "$m"
k1=$(step apps-launch "\"user\":$U_AD,\"appId\":\"$KEY_APP\"")
KEY_THREAD=$(field thread "$k1")
contains "the admin (with a key) launches the key connector's app" '^launch=201:false$' "$k1"
contains "...and shares the thread with the team" '^share=200$' "$(step apps-share "\"user\":$U_AD,\"threadId\":\"$KEY_THREAD\"")"
contains "the member without a key sees the card as text" '^result=card:text:no_access:in$' \
  "$(step apps-results "\"user\":$U_M2,\"threadId\":\"$KEY_THREAD\"")"
part_end nokey

# ---- the browser checks -----------------------------------------------------------------------------
SPECS=(gate-apps/explorer.spec.ts app-frame.spec.ts)
PUBLIC_URL=$($KUBECTL -n "$NS" exec "$SERVER" -c server -- printenv KOBE_PUBLIC_URL 2>/dev/null || true)
browser_env() { # the variables the specs read, except the password
  printf 'KOBE_BASE_URL=%s KOBE_USER=gate-apps-ad@gate-apps.test KOBE_FAKE_MODEL=1 KOBE_APPS_CONNECTOR=e2e-apps KOBE_APPS_PROBES=1 KOBE_APPS_SECRET=%s KOBE_REQUIRE_APP=1 KOBE_APP_ID=%s' \
    "$PUBLIC_URL" "$MEMBER_KEY" "$APP"
}
RESULTS="${KOBE_GATEAPPS_RESULTS:-}"
if [[ "$BROWSER" == 1 ]]; then
  echo "==> browser: ${SPECS[*]} in Chromium against $PUBLIC_URL"
  map="${KOBE_GATEAPPS_BROWSER_MAP:-}"
  if [[ -z "$map" && "$context" == k3d-* ]]; then
    $KUBECTL -n kube-system port-forward svc/traefik 18081:80 >"$WORK/port-forward.log" 2>&1 &
    pf=$!
    UNDO+=("kill $pf")
    map=127.0.0.1:18081
    ingress_up() { curl -s -o /dev/null -m 3 -H "Host: ${PUBLIC_URL#*://}" "http://$map/v1/setup"; }
    until_ok 30 ingress_up || echo "     the port-forward to the ingress did not answer: $(tail -2 "$WORK/port-forward.log")"
  fi
  RESULTS="$WORK/results.json"
  # shellcheck disable=SC2046 # browser_env is a list of NAME=value words
  (cd e2e/browser && env $(browser_env) KOBE_PW="$USER_PASSWORD" KOBE_BROWSER_MAP="$map" \
    KOBE_BROWSER_RESULTS="$RESULTS" npx playwright test "${SPECS[@]}" >"$WORK/playwright.log" 2>&1) || true
  grep -E '✓|✘|-  |passed|failed|skipped|flaky' "$WORK/playwright.log" | tail -40 | sed 's/^/     /' || true
elif [[ -z "$RESULTS" ]]; then
  echo "skip browser checks (KOBE_GATEAPPS_BROWSER=$BROWSER); run them where Chromium reaches $PUBLIC_URL, then judge with KOBE_GATEAPPS_RESULTS=<results.json>:"
  echo "     cd e2e/browser && npm ci && npx playwright install chromium && $(browser_env) KOBE_PW=<the fixtures' password> KOBE_BROWSER_RESULTS=<results.json> npx playwright test ${SPECS[*]}"
fi

# ---- after the browser: drift and export ------------------------------------------------------------
part_begin "negative: a changed template drifts; cards fall back to text and the rail hides the app"
d=$(step apps-drift "\"connectorId\":\"$CONNECTOR\",\"fakeUrl\":\"http://$MCP_IP\"")
show "drift" "$d"
contains "the refresh sees the changed template" '^refresh=drifted$' "$d"
contains "the rail no longer lists the app" '^apps=(e2e-apps-key|-)$' "$(step apps-member "\"user\":$U_AD")"
contains "the earlier tool card is text now, saying why" '^result=tool:text:template_changed:in$' \
  "$(step apps-results "\"user\":$U_AD,\"threadId\":\"$COERCED_THREAD\"")"
part_end drift

part_begin "negative: an export carries text only"
x=$(step apps-export "\"user\":$U_AD,\"threadId\":\"$RAIL_THREAD\"")
show "export" "$x"
contains "the export answers" '^export_status=200$' "$x"
contains "...with the card's text" '^export_card_text=true$' "$x"
contains "...never the structured result" '^export_structured=false$' "$x"
contains "...never the template" '^export_template=false$' "$x"
part_end export

# ---- verdict -----------------------------------------------------------------------------------------
echo "==> browser"
browser_failed=0
if [[ -n "$RESULTS" ]]; then
  lines=$(node e2e/gate5/verdict.mjs "$RESULTS" "${SPECS[@]}")
else
  lines="NOTRUN browser checks: not run here"
fi
printf '%s\n' "$lines"
grep -qE '^(FAIL|XPASS|INVALID|NOTRUN) ' <<<"$lines" && browser_failed=1
if [[ "$PARTS_FAILED" != " " || "$browser_failed" == 1 ]]; then
  browser_said=ok
  [[ "$browser_failed" == 1 ]] && browser_said=failed
  verdict "Kobe Explorer Gate: FAILED (API parts failed:${PARTS_FAILED% }; browser: $browser_said)"
  exit 1
fi
verdict "Kobe Explorer Gate (k3d): proven"
