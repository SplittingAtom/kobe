#!/usr/bin/env bash
# Gate 4 (KOBE-4, v1.0), the checks no earlier gate makes (KOBE-232). e2e/gate4.sh runs this
# beside e2e/gate1.sh, gate2.sh and gate3.sh and maps every check to its user story (spec §4):
#   U1   invite email → account with password and passkey; 2FA enforced when required; only the
#        invited teams are visible
#   U2   (with Gate 1) personal memory is per team
#   U5   Enter queues; Steer injects into the current run; Stop cancels; one active run per thread
#   U6   (with Gate 2) the approval card (tool, input, risk); the signed approval runs exactly that
#        input; a remember-rule is visible and revocable; an unanswered approval expires at 1 h and
#        the run ends visibly
#   U7   two users connect the same OAuth connector; neither token is in either sandbox; revoking
#        one leaves the other working; a drifted tool is disabled until re-approved
#   U8   (with Gate 3) export produces valid Orbit YAML; the pre-publish eval gate runs and blocks
#        above the team's threshold
#   U11  (with Gate 2) the 80 % warning; the dashboard by user, agent and model
#   U14  a schedule runs as its owner in auto mode; a write that would ask is skipped and reported;
#        the run is in Scheduled with a notification
#   U15  (with Gates 1 and 3) threads list and search from Postgres while the sandbox sleeps
#   U16  (with Gate 1 and e2e/gate4-restore.sh) the chart refuses a RuntimeClass that does not isolate
# docs/gates/gate-4.md records what each check proves and what it does not.
#
# k3d (CI shard `gate4`): after the gate1-prep install. A real install: KOBE_GATE4_NS, _RELEASE,
# _CONTEXT, _MODEL, _OWNER_EMAIL/_PASSWORD; U7 against a real OAuth MCP server with
# KOBE_GATE4_MCP_URL (see the doc). It creates users gate4-*@gate4.test, teams gate4-a and gate4-b
# and namespace kobe-gate4-infra (the fake OAuth MCP server and the Orbit test model). With
# KOBE_GATE4_FAKE_INFRA=1 (the k3d default) one `helm upgrade` lets the MCP proxy reach the fake
# server, re-probes connectors every 60 s and lets Bifrost reach the test model; on a real cluster
# it is undone on exit from the release's saved values.
set -euo pipefail
cd "$(dirname "$0")/../.."

KUBECTL="${KUBECTL:-kubectl}"
HELM="${HELM:-helm}"
NS="${KOBE_GATE4_NS:-kobe-dev}"
RELEASE="${KOBE_GATE4_RELEASE:-kobe}"
CHART="${KOBE_GATE4_CHART:-charts/kobe}"
STORIES=" ${KOBE_GATE4_STORIES:-U1 U2 U5 U6 U7 U8 U11 U14 U15 U16} "
MODEL_ALIAS="${KOBE_GATE4_MODEL:-fast}"
FAKE="${KOBE_GATE4_FAKE:-$([[ "$MODEL_ALIAS" == fast ]] && echo 1 || echo 0)}"
OWNER_EMAIL="${KOBE_GATE4_OWNER_EMAIL:-owner@e2e.test}"
OWNER_PASSWORD="${KOBE_GATE4_OWNER_PASSWORD:-e2e owner password}"
SBX_WAIT="${KOBE_GATE4_SANDBOX_WAIT:-180}"
MAILPIT="${KOBE_GATE4_MAILPIT:-http://mailpit.kobe-deps.svc.cluster.local:8025}"
INFRA_NS=kobe-gate4-infra
SERVER="deploy/$RELEASE-server"
BASE="http://$RELEASE-server.$NS.svc.cluster.local"
NONCE="$(date +%s)"
failed=0

context=$($KUBECTL config current-context)
if [[ "$context" != k3d-* && "$context" != "${KOBE_GATE4_CONTEXT:-}" ]]; then
  echo "refusing to run against context '$context' (expected k3d-*, or set KOBE_GATE4_CONTEXT=$context)" >&2
  exit 2
fi
K3D=$([[ "$context" == k3d-* ]] && echo 1 || echo 0)
FAKE_INFRA="${KOBE_GATE4_FAKE_INFRA:-$K3D}"
RESTORE_HELM="${KOBE_GATE4_RESTORE_HELM:-$((1 - K3D))}"
# Turning "require 2FA" on holds every user without TOTP for a moment: on k3d by default only.
TOTP_REQUIRE="${KOBE_GATE4_TOTP_REQUIRE:-$K3D}"
# Creates (and deletes) a cluster-scoped RuntimeClass with handler runc: on k3d by default only.
RUNC_CLASS="${KOBE_GATE4_RUNC_CLASS:-$K3D}"

# shellcheck source=../lib/gate-common.sh
source e2e/lib/gate-common.sh
# shellcheck source=../lib/gate-turns.sh
source e2e/lib/gate-turns.sh
# shellcheck source=../gate2/sandbox.sh
source e2e/gate2/sandbox.sh
# shellcheck source=../gate2/scan.sh
source e2e/gate2/scan.sh

# shellcheck disable=SC2034 # read by client() in gate-common.sh
CLIENT_JS="$(for f in e2e/gate1/client.mjs e2e/gate2/client.mjs e2e/gate3/client.mjs; do sed '/^const MODES = {/,$d' "$f"; done
  cat e2e/gate4/client.mjs e2e/gate4/connectors.mjs)"
WORK=$(mktemp -d)
chmod 700 "$WORK"
PODS=()
UNDO=()
cleanup() {
  local rc=$?
  local u
  for p in "${PODS[@]+"${PODS[@]}"}"; do $KUBECTL delete pod $p --ignore-not-found --wait=false >/dev/null 2>&1 || true; done
  for u in "${UNDO[@]+"${UNDO[@]}"}"; do eval "$u" >/dev/null 2>&1 || true; done
  rm -rf "$WORK"
  verdict_on_exit "$rc" "Gate 4 stories"
}
trap cleanup EXIT
want() { [[ "$STORIES" == *" $1 "* ]]; }
notrun() { echo "NOTRUN $1"; } # a part of a story that could not run here: the story is not proven

# ---- fixtures ----------------------------------------------------------------------------------------
user_json() { # key team ip-suffix
  printf '{"key":"%s","email":"gate4-%s@gate4.test","name":"Gate4 %s","team":"%s","ip":"198.51.100.%s"}' "$1" "$1" "$1" "$2" "$3"
}
echo "==> fixtures: teams gate4-a (admin, builder, four members) and gate4-b (admin)"
setup_token=$($KUBECTL -n "$NS" get secret "$RELEASE-auth" -o jsonpath='{.data.setup-token}' 2>/dev/null | base64 -d 2>/dev/null || true)
fx=$(client "$(printf '{"mode":"fixtures","base":"%s","modelAlias":"%s","owner":{"email":"%s","password":"%s"},"setupToken":"%s","users":[%s,%s,%s,%s,%s,%s,%s],"teams":[{"key":"a","slug":"gate4-a","name":"Gate 4 A"},{"key":"b","slug":"gate4-b","name":"Gate 4 B"}]}' \
  "$BASE" "$MODEL_ALIAS" "$OWNER_EMAIL" "$OWNER_PASSWORD" "$setup_token" \
  "$(user_json ga a 71)" "$(user_json gb a 72)" "$(user_json m1 a 73)" "$(user_json m2 a 74)" "$(user_json m3 a 75)" \
  "$(user_json mt a 76)" "$(user_json gz b 77)")")
printf '%s\n' "$fx" | sed 's/^/     /'
fixtures=$(field fixtures "$fx")
json_get() { printf '%s' "$fixtures" | sed -n "s/.*\"$1\":\"\([0-9a-f-]*\)\".*/\1/p"; }
TEAM=$(json_get a)
TEAM_B=$(json_get b)
n=70
for k in ga gb m1 m2 m3 mt gz; do # U_<KEY>: the client user JSON; ID_<KEY>: the user's id
  n=$((n + 1))
  team=$TEAM
  [[ "$k" == gz ]] && team=$TEAM_B
  printf -v "ID_${k^^}" '%s' "$(json_get "$k")"
  printf -v "U_${k^^}" '{"key":"%s","email":"gate4-%s@gate4.test","ip":"198.51.100.%s","teamId":"%s","userId":"%s"}' \
    "$k" "$k" "$n" "$team" "$(json_get "$k")"
done
if [[ ! "$TEAM $TEAM_B $ID_GA $ID_GB $ID_M1 $ID_M2 $ID_M3 $ID_MT $ID_GZ" =~ ^([0-9a-f-]{36}\ ){8}[0-9a-f-]{36}$ ]]; then
  fail "fixtures: two teams and their users"
  exit 1
fi
ok "fixtures: two teams and their users"
OWNER_JSON=$(printf '{"email":"%s","password":"%s"}' "$OWNER_EMAIL" "$OWNER_PASSWORD")
step() { client "$(printf '{"mode":"%s","base":"%s","owner":%s,%s}' "$1" "$BASE" "$OWNER_JSON" "$2")"; }
contains "gate4-gb has the builder role" '^role=200:builder$' "$(step role "\"admin\":$U_GA,\"userId\":\"$ID_GB\",\"role\":\"builder\"")"
MODELS=0
if [[ "$(field models_a "$fx")" == 200 ]]; then
  MODELS=1
  [[ "$MODEL_ALIAS" == fast ]] && ensure_fake_llm
else
  fail "no model catalog entry '$MODEL_ALIAS' enabled for team gate4-a: the stories need runs"
fi
KOBE_AGENT=$(field gallery_agent "$(step gallery-agent '"key":"kobe"')")

# A user's sandbox (T2 names the user for e2e/gate2/sandbox.sh and scan.sh).
TNS=kobe-team-gate4-a
use_sandbox_of() { # key → T2, SBX_WHO (and a fresh "is it down" state for that sandbox)
  T2=$(json_get "$1")
  SBX_WHO=$1
  SBX_DOWN=0
}
claim_uid() { $KUBECTL -n "$TNS" get sandboxclaim "u-$T2" -o jsonpath='{.metadata.uid}' 2>/dev/null || true; }
sbx_pod() {
  $KUBECTL -n "$TNS" get pods -l "agents.x-k8s.io/claim-uid=$(claim_uid)" --field-selector=status.phase=Running \
    -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null | head -1
}
in_sbx() {
  local pod
  pod=$(sbx_pod)
  [[ -z "$pod" ]] && { echo "in_sbx: ${SBX_WHO}'s sandbox has no Running pod"; return 0; }
  $KUBECTL -n "$TNS" exec "$pod" -c agent -- sh -c "$1" 2>&1 || true
}
user_of() { local v="U_${1^^}"; printf '%s' "${!v}"; } # key → client user JSON
chat() { turn "$(user_of "$SBX_WHO")" "$1"; } # scan.sh's Pi view runs through this

# ---- test servers (k3d): the OAuth MCP server and the Orbit test model --------------------------------
if ((FAKE_INFRA)) && ((MODELS)); then
  echo "==> test servers in $INFRA_NS: an OAuth MCP server and the Orbit test model"
  SERVER_IMAGE=$($KUBECTL -n "$NS" get "$SERVER" -o jsonpath='{.spec.template.spec.containers[?(@.name=="server")].image}')
  SANDBOX_IMAGE="${KOBE_GATE4_SANDBOX_IMAGE:-${SERVER_IMAGE/kobe-server/kobe-sandbox}}"
  $KUBECTL create namespace "$INFRA_NS" --dry-run=client -o yaml | $KUBECTL apply -f - >/dev/null
  for svc in fake-oauth orbit-model; do
    $KUBECTL -n "$INFRA_NS" get svc "$svc" >/dev/null 2>&1 \
      || $KUBECTL -n "$INFRA_NS" create service clusterip "$svc" --tcp=80:8080 >/dev/null
  done
  OAUTH_IP=$($KUBECTL -n "$INFRA_NS" get svc fake-oauth -o jsonpath='{.spec.clusterIP}')
  ORBIT_IP=$($KUBECTL -n "$INFRA_NS" get svc orbit-model -o jsonpath='{.spec.clusterIP}')
  $KUBECTL -n "$INFRA_NS" delete pod fake-oauth orbit-model --ignore-not-found --wait=true >/dev/null 2>&1 || true
  $KUBECTL -n "$INFRA_NS" run fake-oauth --restart=Never --image="$SANDBOX_IMAGE" --image-pull-policy=IfNotPresent \
    --labels=app=fake-oauth --env="BASE=http://$OAUTH_IP" --command -- node -e "$(cat e2e/lib/fake-oauth-mcp.js)" >/dev/null
  $KUBECTL -n "$INFRA_NS" run orbit-model --restart=Never --image="$SANDBOX_IMAGE" --image-pull-policy=IfNotPresent \
    --labels=app=orbit-model --env="SERVER_B64=$(base64 <images/orbit-eval/testing/fake_model_server.py | tr -d '\n')" \
    --command -- python3 -c 'import base64, os; exec(base64.b64decode(os.environ["SERVER_B64"]))' 8080 >/dev/null
  for svc in fake-oauth orbit-model; do
    $KUBECTL -n "$INFRA_NS" patch svc "$svc" -p "{\"spec\":{\"selector\":{\"app\":\"$svc\"}}}" >/dev/null
    $KUBECTL -n "$INFRA_NS" wait --for=condition=Ready "pod/$svc" --timeout=180s >/dev/null 2>&1 || true
  done
  UNDO+=("$KUBECTL delete namespace $INFRA_NS --ignore-not-found --wait=false")
  contains "the fake OAuth MCP server and the Orbit test model run" '^Running Running$' \
    "$($KUBECTL -n "$INFRA_NS" get pod fake-oauth orbit-model -o jsonpath='{.items[0].status.phase} {.items[1].status.phase}' 2>/dev/null)"
  infra_rule=$(printf '{"to":[{"namespaceSelector":{"matchLabels":{"kubernetes.io/metadata.name":"%s"}}}]}' "$INFRA_NS")
  saved="$WORK/values.yaml"
  $HELM get values "$RELEASE" -n "$NS" -o yaml >"$saved"
  # Bifrost keeps what it may reach already (the e2e model provider) and gains the test model.
  values_json=$($HELM get values "$RELEASE" -n "$NS" -o json 2>/dev/null || echo '{}')
  # The release's own lists, each with the test servers added (merged by node in a server pod).
  merged() { # dotted path, JSON to add (an item, or a port number) → the list with it
    $KUBECTL -n "$NS" exec "$SERVER" -c server -- node -e '
      const [values, path, add, dflt] = process.argv.slice(1);
      let v = JSON.parse(values || "{}");
      for (const k of path.split(".")) v = v == null ? undefined : v[k];
      const list = Array.isArray(v) ? v : JSON.parse(dflt);
      const item = JSON.parse(add);
      if (!list.some((x) => JSON.stringify(x) === JSON.stringify(item))) list.push(item);
      console.log(JSON.stringify(list));' "$values_json" "$1" "$2" "${3:-[]}"
  }
  bifrost_egress=$(merged bifrost.networkPolicy.extraEgress "$infra_rule")
  mcp_egress=$(merged mcpProxy.networkPolicy.extraEgress "$infra_rule")
  cidrs=$(merged mcpProxy.allowedInternalCidrs "\"$OAUTH_IP/32\"")
  ports=$(merged mcpProxy.allowedPorts 80 '[443]')
  # The upgrade rolls the server (connectorRefreshSeconds): the steps below go through the Service,
  # so they wait until the old server pods are gone, not only until the new ones are ready.
  old_servers=$($KUBECTL -n "$NS" get pods -l app.kubernetes.io/component=server -o name 2>/dev/null || true)
  if out=$($HELM upgrade "$RELEASE" "$CHART" -n "$NS" -f "$saved" --reset-values --wait --timeout 8m \
      --set mcpProxy.allowInsecureHttp=true --set-json "mcpProxy.allowedPorts=$ports" \
      --set-json "mcpProxy.allowedInternalCidrs=$cidrs" --set-json "mcpProxy.networkPolicy.extraEgress=$mcp_egress" \
      --set-json "bifrost.networkPolicy.extraEgress=$bifrost_egress" --set server.connectorRefreshSeconds=60 2>&1); then
    ok "the MCP proxy may reach the fake OAuth server, connectors are re-probed every 60 s, Bifrost may reach the test model"
    # shellcheck disable=SC2086 # a list of pod/<name> words
    [[ -z "$old_servers" ]] || $KUBECTL -n "$NS" wait --for=delete $old_servers --timeout=180s >/dev/null 2>&1 || true
  else
    fail "the chart upgrade for the test servers: $(printf '%s' "$out" | tail -3)"
  fi
  ((RESTORE_HELM)) && UNDO+=("$HELM upgrade $RELEASE $CHART -n $NS -f $saved --reset-values --wait --timeout 8m")
fi

# ---- U1 --------------------------------------------------------------------------------------------
# A probe pod asks Mailpit for the newest mail to the address and prints it (the pod's script reads
# its URLs from the environment, so nothing here needs quoting twice).
MAIL_SCRIPT='i=0
while [ $i -lt 30 ]; do
  id=$(wget -qO- "$Q" | grep -o "\"ID\":\"[^\"]*\"" | head -1 | cut -d\" -f4)
  if [ -n "$id" ]; then wget -qO- "$M/api/v1/message/$id"; exit 0; fi
  i=$((i + 1)); sleep 2
done
echo no-mail'
mail_token() { # address → the invitation token from the newest mail to it
  local name="mail-$BASHPID-$RANDOM$RANDOM" q
  q="$MAILPIT/api/v1/search?query=to%3A$(printf '%s' "$1" | sed 's/@/%40/')&limit=5"
  $KUBECTL create namespace "$INFRA_NS" --dry-run=client -o yaml | $KUBECTL apply -f - >/dev/null
  UNDO+=("$KUBECTL delete namespace $INFRA_NS --ignore-not-found --wait=false")
  PODS+=("-n $INFRA_NS $name")
  $KUBECTL -n "$INFRA_NS" run "$name" --restart=Never --image=busybox:1.37 --env="Q=$q" --env="M=$MAILPIT" \
    --command -- sh -c "$MAIL_SCRIPT" >/dev/null
  $KUBECTL -n "$INFRA_NS" wait --for=jsonpath='{.status.phase}'=Succeeded "pod/$name" --timeout=120s >/dev/null 2>&1 || true
  # No mail is a failed check below, not the end of the gate (pipefail: grep finds nothing).
  $KUBECTL -n "$INFRA_NS" logs "$name" 2>/dev/null | grep -o 'invite#token=[A-Za-z0-9_-]*' | head -1 | sed 's/invite#token=//' || true
}
if want U1; then
  echo "==> U1: invite email → account with password and passkey; 2FA when required; only invited teams"
  INVITEE="gate4-invitee-$NONCE@gate4.test"
  contains "U1: the Owner invites a new person to the site (the invitation is mailed)" '^site_invite=20[0-9]:-$' \
    "$(step u1-invite "\"email\":\"$INVITEE\"")"
  token=$(mail_token "$INVITEE")
  contains "U1: the invitation email arrived with its link" '^[A-Za-z0-9_-]{16,}$' "${token:-none}"
  acc=$(step u1-account "\"email\":\"$INVITEE\",\"token\":\"$token\",\"admin\":$U_GA,\"teamId\":\"$TEAM\",\"otherTeamId\":\"$TEAM_B\"")
  show "U1 account" "$acc"
  contains "U1: the link creates the account with a password" '^accept=200:-$' "$acc"
  contains "U1: ...and the password signs in" '^password_signin=200$' "$acc"
  contains "U1: before any team invitation, no team is visible" '^teams_before_team_invite=200:-$' "$acc"
  contains "U1: the team admin invites them; they accept" '^team_accept=200$' "$acc"
  contains "U1: only the invited team is visible" '^teams=200:gate4-a$' "$acc"
  contains "U1: another team's data is refused (it can't be made the active team)" '^other_team=(403|404):' "$acc"
  contains "U1: ...nor named on a request" '^other_team_named=(403|404|409):' "$acc"
  contains "U1: their own team's data is served" '^own_team=200$' "$acc"
  contains "U1: they register a passkey (user verification required)" '^passkey_register=200:-$' "$acc"
  contains "U1: the passkey alone signs them in" '^passkey_signin=200:-$' "$acc"
  contains "U1: ...into their own session" "^passkey_session=200:$INVITEE\$" "$acc"
  if ((TOTP_REQUIRE)); then
    tt=$(step u1-totp "\"email\":\"$INVITEE\",\"teamId\":\"$TEAM\"")
    show "U1 2FA" "$tt"
    contains "U1: the Owner requires 2FA for the site" '^require_on=200:-$' "$tt"
    contains "U1: a user without TOTP is held until they enroll (403 two_factor_enrollment_required)" '^held=403:two_factor_enrollment_required$' "$tt"
    contains "U1: they enroll TOTP" '^verify=200$' "$tt"
    contains "U1: ...and are let in" '^after_enroll=200$' "$tt"
    contains "U1: signing in, the password alone asks for the code" '^password_only=200:two_factor_redirect=true$' "$tt"
    contains "U1: ...and gives no session without it" '^before_code=401$' "$tt"
    contains "U1: with the code they are in" '^after_code=200$' "$tt"
    contains "U1: the site setting is back as it was" '^require_restored=true$' "$tt"
  else
    notrun "U1: 2FA enforcement (KOBE_GATE4_TOTP_REQUIRE=0: turning it on would hold every user without TOTP)"
  fi
fi

# ---- U2 --------------------------------------------------------------------------------------------
if want U2; then
  echo "==> U2: personal memory is per team"
  u2=$(step u2-memory "\"adminB\":$U_GZ,\"user\":$U_MT,\"teamB\":\"$TEAM_B\",\"path\":\"notes/gate4-$NONCE.md\",\"content\":\"team A only $NONCE\"")
  show "U2" "$u2"
  contains "U2: a member of team A joins team B too" '^join_b=200$' "$u2"
  contains "U2: they write a personal memory doc in team A" '^write_a=200:-$' "$u2"
  contains "U2: team A lists it" '^list_a=200:present$' "$u2"
  contains "U2: team B never sees it (personal memory is per team)" '^list_b=200:absent$' "$u2"
fi

sbx_ready() { use_sandbox_of "$1"; sbx_await "$SBX_WAIT" "$2"; }
hello() { # key → wakes that user's sandbox
  local r
  r=$(turn "$(user_of "$1")" "gate4 hello $NONCE" '"title":"gate4 hello"')
  contains "$1's sandbox wakes and answers" '^terminal=run.completed$' "$r"
}

# ---- U5 --------------------------------------------------------------------------------------------
if want U5 && ((MODELS)); then
  echo "==> U5: Enter queues, Steer injects, Stop cancels, one active run per thread"
  hello m1
  if sbx_ready m1 "U5"; then
    long="$(bash_prompt "sleep 15; echo slept-$NONCE")"
    slow="$(if ((FAKE)); then echo "kobe-slow-start gate4 $NONCE"; else echo "Write a 2000-word essay about rivers."; fi)"
    u5=$(step u5 "\"user\":$U_M1,\"long\":$(json_str "$long"),\"queued\":\"gate4 queued $NONCE\",\"steer\":\"gate4 steered $NONCE\",\"slow\":$(json_str "$slow")")
    show "U5" "$u5"
    contains "U5: the first message starts a run" '^first=201:queued=false$' "$u5"
    contains "U5: Enter while it works queues the next message" '^second=201:queued=true$' "$u5"
    contains "U5: one active run in the thread" '^active_runs=1$' "$u5"
    contains "U5: the run is working (its first tool call) when the member steers" '^steer_during=tool.call$' "$u5"
    contains "U5: Steer is accepted for the running run" '^steer=200:-$' "$u5"
    grep -q '^steer=200:' <<<"$u5" || $KUBECTL -n "$NS" logs -l app.kubernetes.io/component=server -c server --since=10m --tail=-1 2>/dev/null \
      | grep -F 'steer not delivered' | tail -3 | sed 's/^/     server: /' || true
    contains "U5: ...and applied to it (steer.applied)" '^steer_applied=true$' "$u5"
    ((FAKE)) && contains "U5: ...the model got the steer in the same run" "^first_text=.*gate4 steered $NONCE" "$u5"
    contains "U5: the first run completes" '^first_terminal=run.completed$' "$u5"
    contains "U5: the queued message runs after it ends" '^second_terminal=run.completed$' "$u5"
    contains "U5: ...and only after it ended" '^second_started_after_first_ended=true$' "$u5"
    contains "U5: Stop cancels a run that is waiting for the model" '^stopped=run.interrupted:cancelled$' "$u5"
    contains "U5: ...within seconds" '^stopped_ms=[0-9]{1,5}$' "$u5"
  fi
fi

# ---- U6 --------------------------------------------------------------------------------------------
if want U6 && ((MODELS)) && sbx_ready m1 "U6"; then
  echo "==> U6: the approval card, the signed approval, a remember-rule, the 1 h expiry"
  # share_file asks in ask-on-write (a Kobe write); create_artifact never does (PROMPT_EXEMPT_KOBE_TOOLS,
  # Chris 2026-10-06). The three files are made first with bash, which asks only by policy rule.
  marker="gate4-u6-$NONCE"
  share() { tool_prompt share_file "$(printf '{"path":"%s-%s.txt","description":"Gate 4 U6 %s"}' "$marker" "$1" "$1")"; }
  files=$(turn "$U_M1" "$(bash_prompt "for n in 1 2 3; do echo \"gate4 U6 \$n $NONCE\" > /workspace/$marker-\$n.txt; done; ls /workspace/$marker-*.txt | wc -l")" '"title":"gate4 U6 files"')
  contains "U6: three files in m1's workspace to share" '^tool_output=.*"preview":" *3\\n' "$files"
  u6=$(step u6 "\"user\":$U_M1,\"marker\":\"$marker\",\"sharedName\":\"$marker-1.txt\",\"write\":$(json_str "$(share 1)"),\"write2\":$(json_str "$(share 2)"),\"write3\":$(json_str "$(share 3)")")
  show "U6" "$u6"
  contains "U6: the card names the tool, its risk and the exact input" '^card=share_file:write:input=true$' "$u6"
  contains "U6: it can be remembered" '^remember_scope=[a-z]+$' "$u6"
  contains "U6: the member allows it with a remember-rule" '^allow=200:-$' "$u6"
  contains "U6: the run completes" '^run1=run.completed$' "$u6"
  contains "U6: exactly the approved input ran" '^exact_input_ran=true$' "$u6"
  contains "U6: the approval is signed (HMAC over run, call and input)" '^approval_row=allowed:signed=true$' "$u6"
  contains "U6: the remember-rule is visible to its owner" '^rule_listed=yes$' "$u6"
  contains "U6: the same tool then runs without asking" '^run2=run.completed:asked=false$' "$u6"
  contains "U6: the rule is revocable" '^revoke=204$' "$u6"
  contains "U6: ...after which it asks again" '^asks_again=yes$' "$u6"
  contains "U6: an approval waits at most 1 h" '^ttl_seconds=(359[0-9]|360[0-9])$' "$u6"
  contains "U6: unanswered, it expires (cause ttl)" '^expired=expired:ttl$' "$u6"
  contains "U6: ...and the run ends visibly (run.failed approval_expired)" '^run3=run.failed:approval_expired$' "$u6"
  contains "U6: ...saying why" '^run3_message=The approval request expired after 1 hour' "$u6"
fi

# ---- U7 --------------------------------------------------------------------------------------------
connect() { # key connector → connects that user (fake: automatically; real: a script or a person)
  local key=$1 cid=$2 out url cb var
  if [[ -z "${KOBE_GATE4_MCP_URL:-}" || "$cid" == "$FAKE_CONNECTOR" ]]; then
    step u7-connect "\"user\":$(user_of "$key"),\"connectorId\":\"$cid\""
    return
  fi
  var="KOBE_GATE4_MCP_AUTHORIZE_CMD_${key^^}"
  if [[ -n "${!var:-}" ]]; then
    out=$(step u7-start "\"user\":$(user_of "$key"),\"connectorId\":\"$cid\"")
    url=$(field authorization_url_b64 "$out" | base64 -d)
    cb=$(${!var} "$url" | tail -1)
    step u7-callback "\"user\":$(user_of "$key"),\"connectorId\":\"$cid\",\"callbackB64\":\"$(printf '%s' "$cb" | base64 | tr -d '\n')\""
  else
    echo "     U7: sign in at $PUBLIC_URL as gate4-$key@gate4.test and connect '$MCP_NAME' (waiting ${KOBE_GATE4_MCP_CONSENT_WAIT:-600} s)"
    granted() { [[ "$(field grant "$(step u7-grant "\"user\":$(user_of "$key"),\"connectorId\":\"$cid\"")")" == oauth ]]; }
    until_ok "${KOBE_GATE4_MCP_CONSENT_WAIT:-600}" granted || true
    step u7-grant "\"user\":$(user_of "$key"),\"connectorId\":\"$cid\""
  fi
}
# On the gallery agent Kobe (`connectors: all`): connectors reach a run only through its agent's
# list (resolver: agent list ∩ team-enabled ∩ user-connected); a thread without one gets none.
mcp_call() { # key connector-name-segment tool args → a turn calling that tool
  turn "$(user_of "$1")" "$(tool_prompt "mcp__$2__$3" "$4")" "\"title\":\"gate4 U7 $1\",\"agentId\":\"$KOBE_AGENT\""
}
if want U7 && ((MODELS)); then
  echo "==> U7: per-user grants of one OAuth connector; no token in a sandbox; revocation; drift"
  PUBLIC_URL=$($KUBECTL -n "$NS" exec "$SERVER" -c server -- printenv KOBE_PUBLIC_URL 2>/dev/null || true)
  FAKE_CONNECTOR=""
  if ((FAKE_INFRA)); then
    fk=$(step u7-setup "\"admin\":$U_GA,\"name\":\"gate4-oauth\",\"url\":\"http://$OAUTH_IP/mcp\"")
    show "U7 fake connector" "$fk"
    FAKE_CONNECTOR=$(field connector_id "$fk")
    contains "U7: the Owner registers the OAuth MCP server; its tools are pinned" '^tools=get_thing:pinned,create_thing:pinned$|^tools=create_thing:pinned,get_thing:pinned$' "$fk"
    contains "U7: the team admin enables it" '^team_enable=200:-$' "$fk"
  fi
  if [[ -n "${KOBE_GATE4_MCP_URL:-}" ]]; then
    MCP_NAME="${KOBE_GATE4_MCP_NAME:-gate4-real}"
    rk=$(step u7-setup "\"admin\":$U_GA,\"name\":\"$MCP_NAME\",\"url\":\"$KOBE_GATE4_MCP_URL\"")
    show "U7 connector" "$rk"
    CONNECTOR=$(field connector_id "$rk")
    contains "U7: the real OAuth MCP server is registered and enabled for the team" '^team_enable=200:-$' "$rk"
    SEG=$(field segment "$rk")
    TOOL="${KOBE_GATE4_MCP_TOOL:?set KOBE_GATE4_MCP_TOOL to a read-only tool of $KOBE_GATE4_MCP_URL}"
    ARGS="${KOBE_GATE4_MCP_ARGS:-}"
    [[ -z "$ARGS" ]] && ARGS='{}'
  else
    MCP_NAME=gate4-oauth
    CONNECTOR=$FAKE_CONNECTOR
    SEG=gate4_oauth
    TOOL=get_thing
    ARGS='{"id":"7"}'
  fi
  [[ -n "$CONNECTOR" ]] || fail "U7: no connector (set KOBE_GATE4_MCP_URL, or KOBE_GATE4_FAKE_INFRA=1)"
  for k in m1 m2; do
    hello "$k"
    c=$(connect "$k" "$CONNECTOR")
    show "U7 connect $k" "$c"
    contains "U7: $k connects their own account (an OAuth grant)" '^grant=oauth$' "$c"
  done
  r1=$(mcp_call m1 "$SEG" "$TOOL" "$ARGS")
  r2=$(mcp_call m2 "$SEG" "$TOOL" "$ARGS")
  show "U7 m1 call" "$r1"
  show "U7 m2 call" "$r2"
  for pair in "m1:$r1" "m2:$r2"; do
    k=${pair%%:*}
    contains "U7: $k's tool call completes through the MCP proxy" '^terminal=run.completed$' "${pair#*:}"
    # Pi's tool.result says "is_error"; an MCP result inside it says "isError".
    if grep -qE '"(isError|is_error)":true' <<<"$(said "${pair#*:}")"; then fail "U7: $k's call is not an error"; else ok "U7: $k's call is not an error"; fi
  done
  if [[ "$CONNECTOR" == "$FAKE_CONNECTOR" ]]; then
    s1=$(grep -o 'fake-oauth:get_thing:user-[0-9]*' <<<"$(said "$r1")" | head -1 || true)
    s2=$(grep -o 'fake-oauth:get_thing:user-[0-9]*' <<<"$(said "$r2")" | head -1 || true)
    if [[ -z "$s1" || -z "$s2" ]]; then
      printf '     m1 said: %s\n     m2 said: %s\n' "$(said "$r1" | tr '\n' ' ' | cut -c1-600)" "$(said "$r2" | tr '\n' ' ' | cut -c1-600)"
      $KUBECTL -n "$INFRA_NS" logs fake-oauth --tail=20 2>&1 | sed 's/^/     fake-oauth: /' || true
    fi
    contains "U7: each call carried its own user's token (two different grants)" '^fake-oauth:get_thing:user-[0-9]+ fake-oauth:get_thing:user-[0-9]+ different$' \
      "${s1:-none} ${s2:-none} $([[ -n "$s1" && "$s1" != "$s2" ]] && echo different || echo same)"
  fi
  toks=$(step u7-tokens "\"connectorId\":\"$CONNECTOR\",\"users\":[$U_M1,$U_M2]")
  contains "U7: both users' tokens were read from Kobe's sealed store (never printed)" '^grant_tokens=[2-9]$' "$toks"
  tokfile="$WORK/u7-tokens"
  grep '^granttoken ' <<<"$toks" | while read -r _ _ v; do printf '%s' "$v" | b64d; echo; done >"$tokfile"
  chmod 600 "$tokfile"
  for k in m1 m2; do
    use_sandbox_of "$k"
    SCAN_LABEL="U7 ($k's sandbox)" KOBE_GATE2_EXTRA_SECRETS_FILE="$tokfile" run_secret_scan
  done
  contains "U7: m1 revokes their grant" '^revoke=204$' "$(step u7-revoke "\"user\":$U_M1,\"connectorId\":\"$CONNECTOR\"")"
  r1=$(mcp_call m1 "$SEG" "$TOOL" "$ARGS")
  r2=$(mcp_call m2 "$SEG" "$TOOL" "$ARGS")
  show "U7 m1 after revoke" "$r1"
  if [[ "$CONNECTOR" == "$FAKE_CONNECTOR" ]]; then
    if grep -qE "${s1:-none}([^0-9]|\$)" <<<"$(said "$r1")"; then
      fail "U7: after revoking, m1's call no longer reaches the server with m1's token"
    else ok "U7: after revoking, m1's call no longer reaches the server with m1's token"; fi
    contains "U7: m2's call still works with m2's token" "${s2:-none}" "$(said "$r2")"
  else
    contains "U7: after revoking, m1's call fails or the connector is left out" '"(isError|is_error)":true|connector:'"$MCP_NAME"':not_user_connected|not connected' "$(said "$r1")$(field omitted "$r1")"
    contains "U7: m2's call still works" '^terminal=run.completed$' "$r2"
  fi
  if ((FAKE_INFRA)) && [[ -n "$FAKE_CONNECTOR" ]]; then
    contains "U7: the fake server changes create_thing's definition (drift)" '"drifted":true' \
      "$($KUBECTL -n "$INFRA_NS" exec fake-oauth -- node -e "fetch('http://127.0.0.1:8080/_drift',{method:'POST'}).then(r=>r.text()).then(console.log)" 2>&1)"
    drift_seen() { grep -q 'create_thing:drifted' <<<"$(step u7-review "\"connectorId\":\"$FAKE_CONNECTOR\"")"; }
    if until_ok 200 drift_seen; then ok "U7: the next re-probe marks create_thing drifted"; else fail "U7: the next re-probe marks create_thing drifted"; fi
    [[ "$CONNECTOR" != "$FAKE_CONNECTOR" ]] && c=$(connect m2 "$FAKE_CONNECTOR")
    if ((FAKE)); then
      t1=$(turn "$U_M2" "tools?" "\"title\":\"gate4 U7 drift\",\"agentId\":\"$KOBE_AGENT\"")
      contains "U7: a new run still offers the unchanged tool" '^text=.*mcp__gate4_oauth__get_thing' "$t1"
      if grep -q 'mcp__gate4_oauth__create_thing' <<<"$(said "$t1")"; then fail "U7: ...and not the drifted one (disabled until re-approved)"
      else ok "U7: ...and not the drifted one (disabled until re-approved)"; fi
    fi
    contains "U7: a site admin re-approves it" '^reapprove=200:1$' "$(step u7-review "\"connectorId\":\"$FAKE_CONNECTOR\",\"approve\":true")"
    if ((FAKE)); then
      contains "U7: after re-approval the tool is offered again" '^text=.*mcp__gate4_oauth__create_thing' \
        "$(turn "$U_M2" "tools?" "\"title\":\"gate4 U7 re-approved\",\"agentId\":\"$KOBE_AGENT\"")"
    fi
  else
    notrun "U7: drift (needs the fake OAuth MCP server: KOBE_GATE4_FAKE_INFRA=1)"
  fi
fi

# ---- U8 --------------------------------------------------------------------------------------------
if want U8 && ((MODELS)); then
  echo "==> U8: Orbit export is valid; the pre-publish eval gate blocks above the team's threshold"
  marker="gate4-orbit-$NONCE"
  front=$(printf '{"name":"Gate4 Orbit %s","description":"Gate 4 Orbit export"}' "$NONCE")
  made=$(step agent "\"user\":$U_GB,\"action\":\"create\",\"frontmatter\":$front,\"prompt\":\"You are the Gate 4 agent. $marker\"")
  OAGENT=$(field agent_id "$made")
  contains "U8: the Builder publishes an agent (version 1)" '^version=1$' "$(step agent "\"user\":$U_GB,\"action\":\"publish\",\"agentId\":\"$OAGENT\"")"
  ex=$(step u8-export "\"user\":$U_GB,\"agentId\":\"$OAGENT\",\"version\":1,\"marker\":\"$marker\"")
  show "U8 export" "$ex"
  contains "U8: the version exports as YAML" '^export=200:(application|text)/(x-)?yaml$' "$ex"
  contains "U8: ...valid against Orbit's experiment schema (pinned release)" '^orbit_schema=valid$' "$ex"
  contains "U8: ...with the agent's prompt" '^orbit_prompt=true$' "$ex"
  if ((FAKE_INFRA)); then
    md=$(step u8-model "\"admin\":$U_GA,\"url\":\"http://$ORBIT_IP\",\"alias\":\"orbitvuln\"")
    show "U8 test model" "$md"
    contains "U8: the Orbit test model is in the catalog and enabled for the team" '^team_model=200$' "$md"
    THRESHOLD="${KOBE_GATE4_EVAL_MAX_ASR:-0.5}"
    gate() { # model-alias label → the gate step for a new agent on that model
      step u8-gate "\"admin\":$U_GA,\"user\":$U_GB,\"threshold\":$THRESHOLD,\"timeoutS\":600,\"frontmatter\":{\"name\":\"Gate4 Eval $2 $NONCE\",\"model\":\"$1\"},\"prompt\":\"You are the Gate 4 $2 agent. Use your tools.\""
    }
    vg=$(gate orbitvuln vulnerable)
    show "U8 eval (an agent on a model that obeys injected instructions)" "$vg"
    contains "U8: with the team's gate on, Publish starts an eval instead (202)" '^publish=202:' "$vg"
    contains "U8: the eval runs and scores attacks above the threshold: blocked" "^eval=blocked:asr=(0\\.[6-9][0-9]*|1):threshold=$THRESHOLD\$" "$vg"
    contains "U8: ...and no version is published" '^published_version=none$' "$vg"
    contains "U8: the gate is turned off again" '^gate_off=200$' "$vg"
  else
    notrun "U8: the eval gate's block (needs the Orbit test model: KOBE_GATE4_FAKE_INFRA=1)"
  fi
fi

# ---- U11 -------------------------------------------------------------------------------------------
if want U11 && ((MODELS)); then
  echo "==> U11: the 80 % warning; the dashboard by user, agent and model"
  hello m3
  content="$(if ((FAKE)); then echo "kobe-tool-step gate4 $NONCE"; else echo "Write a short paragraph about budgets."; fi)"
  daily="${KOBE_GATE4_U11_DAILY_TOKENS:-1200000}" # the scripted tool step reports a 1,000,000-token prompt
  u11=$(step u11 "\"admin\":$U_GA,\"user\":$U_M3,\"dailyTokens\":$daily,\"content\":$(json_str "$content")")
  show "U11" "$u11"
  contains "U11: the team admin sets the member's daily token budget" '^budget=200$' "$u11"
  contains "U11: the member's run completes (under 100 %)" '^run=run.completed$' "$u11"
  contains "U11: the member sees the 80 % warning" '^status=warning:(8[0-9]|9[0-9])$' "$u11"
  contains "U11: the dashboard has the member's row" '^by_user=true$' "$u11"
  contains "U11: ...rows by agent" '^by_agent=[1-9][0-9]*$' "$u11"
  contains "U11: ...and by model" '^by_model=[^-]' "$u11"
  contains "U11: the budget is removed again" '^budget_cleared=(200|204)$' "$u11"
fi

# ---- U14 -------------------------------------------------------------------------------------------
if want U14 && ((MODELS)); then
  echo "==> U14: a schedule runs as its owner in auto mode; a write that would ask is skipped and reported"
  hello m1
  u14=$(step u14 "\"user\":$U_M1,\"agentId\":\"$KOBE_AGENT\",\"prompt\":$(json_str "$(bash_prompt "echo gate4-$NONCE > /workspace/gate4-u14.txt")")")
  show "U14" "$u14"
  contains "U14: the member creates a daily schedule" '^schedule=201:' "$u14"
  contains "U14: it fires (its next run pulled forward)" '^fired=yes$' "$u14"
  contains "U14: the run completes" '^terminal=run.completed$' "$u14"
  contains "U14: it ran as the member, in auto mode, triggered by the schedule" '^run=schedule:auto:owner=true$' "$u14"
  contains "U14: the thread is in Scheduled (marked with its schedule)" '^in_scheduled=true$' "$u14"
  contains "U14: the write that would ask was skipped, not run" '^skipped=bash:scheduled_run_no_prompt$' "$u14"
  contains "U14: ...and reported with the run's end" '^reported=bash$' "$u14"
  contains "U14: the member is notified" '^notification=schedule\.run\.' "$u14"
fi

# ---- U15 -------------------------------------------------------------------------------------------
if want U15 && ((MODELS)); then
  echo "==> U15: threads list and search come from Postgres while the sandbox sleeps"
  marker="gate4-search-$NONCE"
  hello m2
  r=$(turn "$U_M2" "remember the word $marker" '"title":"gate4 U15"')
  T15=$(field thread "$r")
  contains "U15: hibernate m2's sandbox" '"hibernated":true' \
    "$($KUBECTL -n "$NS" exec "$SERVER" -c server -- node dist/cli/lifecycle.js hibernate --team-id "$TEAM" --user-id "$ID_M2" 2>&1 || true)"
  use_sandbox_of m2
  asleep() { [[ -z "$($KUBECTL -n "$TNS" get pods -l "agents.x-k8s.io/claim-uid=$(claim_uid)" -o name 2>/dev/null)" ]]; }
  until_ok 120 asleep || true
  u15=$(step u15 "\"user\":$U_M2,\"threadId\":\"$T15\",\"marker\":\"$marker\"")
  show "U15" "$u15"
  contains "U15: the thread list has the thread" '^list=200:true$' "$u15"
  contains "U15: search finds it by a word from the conversation" '^search=200:true$' "$u15"
  contains "U15: ...at once (both under 3 s)" '^elapsed_ms=([0-9]{1,3}|[12][0-9]{3})$' "$u15"
  if asleep; then ok "U15: ...without waking the sandbox"; else fail "U15: ...without waking the sandbox"; fi
fi

# ---- U16 -------------------------------------------------------------------------------------------
if want U16; then
  echo "==> U16: the chart refuses to run agents without gVisor or Kata"
  $HELM get values "$RELEASE" -n "$NS" -o yaml >"$WORK/u16-values.yaml"
  dry() { # the chart rendered against the cluster (lookups run; nothing is applied)
    $HELM upgrade "$RELEASE" "$CHART" -n "$NS" -f "$WORK/u16-values.yaml" --reset-values --dry-run=server \
      --set "isolation.runtimeClassName=$1" 2>&1 || true
  }
  contains "U16: a RuntimeClass that does not exist is refused" 'refuses to run agents' "$(dry gate4-no-such-class)"
  if ((RUNC_CLASS)); then
    printf 'apiVersion: node.k8s.io/v1\nkind: RuntimeClass\nmetadata: {name: kobe-gate4-runc}\nhandler: runc\n' | $KUBECTL apply -f - >/dev/null
    UNDO+=("$KUBECTL delete runtimeclass kobe-gate4-runc --ignore-not-found")
    contains "U16: a RuntimeClass whose handler is runc is refused (the handler is checked, not the name)" 'refuses to run agents' "$(dry kobe-gate4-runc)"
    $KUBECTL delete runtimeclass kobe-gate4-runc --ignore-not-found >/dev/null 2>&1 || true
  else
    notrun "U16: a runc-handler RuntimeClass (KOBE_GATE4_RUNC_CLASS=0: it is cluster-scoped)"
  fi
  contains "U16: the running sandboxes use the isolating RuntimeClass" '^(gvisor|kata[a-z0-9-]*)( (gvisor|kata[a-z0-9-]*))*$' \
    "$($KUBECTL -n "$TNS" get pods -l agents.x-k8s.io/claim-uid -o jsonpath='{range .items[*]}{.spec.runtimeClassName}{" "}{end}' 2>/dev/null | sed 's/ $//')"
fi

if ((failed)); then
  verdict "Gate 4 stories: FAILED"
  exit 1
fi
verdict "Gate 4 stories: all checks passed"
