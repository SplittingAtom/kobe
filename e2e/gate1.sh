#!/usr/bin/env bash
# Gate 1 (KOBE-1, Spine) against an installed Kobe: two teams of five users chat concurrently,
# the cross-team probe on the install's own data, refresh mid-run resumes gapless, killing a
# sandbox mid-run gives `interrupted` + Retry with history intact, and hibernated → first sandbox
# answer over 20 trials. docs/gates/gate-1.md records what each check proves and what it does not.
#
# Runs after e2e/run.sh in CI (k3d) and against a real cluster's throwaway install:
#   KOBE_GATE1_NS=<release namespace> KOBE_GATE1_RELEASE=<release> e2e/gate1.sh
# Non-destructive outside what it creates: users gate1-*@gate1.test, teams gate1-a/gate1-b (their
# kobe-team-* namespaces and sandboxes, created by the server) and its own pods. It signs sandbox
# wire tokens with the install's keys, so it refuses anything but a k3d context unless
# KOBE_GATE1_CONTEXT names the context explicitly. Re-runnable: fixtures are reused.
set -euo pipefail
cd "$(dirname "$0")/.."

KUBECTL="${KUBECTL:-kubectl}"
NS="${KOBE_GATE1_NS:-kobe-dev}"
RELEASE="${KOBE_GATE1_RELEASE:-kobe}"
STEPS=" ${KOBE_GATE1_STEPS:-chat-real chat-stream probe interrupt cold} "
TRIALS="${KOBE_GATE1_TRIALS:-20}"
P95_MAX="${KOBE_GATE1_P95_MS:-8000}"
COLD_KEY="${KOBE_GATE1_COLD_USER:-c1}"
# Model alias the fixtures make each team's default: CI's fake upstream (`fast`, set up by
# e2e/run.sh) or a real install's catalog model (KOBE_GATE1_MODEL).
MODEL_ALIAS="${KOBE_GATE1_MODEL:-fast}"
OWNER_EMAIL="${KOBE_GATE1_OWNER_EMAIL:-owner@e2e.test}"
OWNER_PASSWORD="${KOBE_GATE1_OWNER_PASSWORD:-e2e owner password}"
SERVER="deploy/$RELEASE-server"
BASE="http://$RELEASE-server.$NS.svc.cluster.local"
NONCE="$(date +%s)"
failed=0

context=$($KUBECTL config current-context)
if [[ "$context" != k3d-* && "$context" != "${KOBE_GATE1_CONTEXT:-}" ]]; then
  echo "refusing to run against context '$context' (expected k3d-*, or set KOBE_GATE1_CONTEXT=$context)" >&2
  exit 2
fi

# shellcheck source=lib/gate-common.sh
source e2e/lib/gate-common.sh

CLIENT_JS=$(cat e2e/gate1/client.mjs)
AGENT_JS=$(cat e2e/gate1/agent.mjs)
PODS=()
cleanup() {
  for p in "${PODS[@]+"${PODS[@]}"}"; do $KUBECTL delete pod $p --ignore-not-found --wait=false >/dev/null 2>&1 || true; done
}
trap cleanup EXIT

# Users: five per team (the first is its team admin) plus cold-start users in team a.
KEYS="a1 a2 a3 a4 a5 b1 b2 b3 b4 b5"
ip_of() { case "$1" in a*) echo "198.51.100.1${1#a}" ;; b*) echo "198.51.100.2${1#b}" ;; *) echo "198.51.100.3${1#c}" ;; esac; }
team_of() { case "$1" in b*) echo b ;; *) echo a ;; esac; }
user_json() { # key → fixture JSON of that user
  printf '{"key":"%s","email":"gate1-%s@gate1.test","name":"Gate1 %s","team":"%s","ip":"%s"}' \
    "$1" "$1" "$1" "$(team_of "$1")" "$(ip_of "$1")"
}
list_json() { # keys... → JSON array of user_json
  local out="" k
  for k in "$@"; do out+="${out:+,}$(user_json "$k")"; done
  echo "[$out]"
}

echo "==> fixtures: two teams × five users (invited, joined through the API)"
setup_token=$($KUBECTL -n "$NS" get secret "$RELEASE-auth" -o jsonpath='{.data.setup-token}' 2>/dev/null | base64 -d 2>/dev/null || true)
# shellcheck disable=SC2086
fx=$(client "$(printf '{"mode":"fixtures","base":"%s","modelAlias":"%s","owner":{"email":"%s","password":"%s"},"setupToken":"%s","users":%s,"teams":[{"key":"a","slug":"gate1-a","name":"Gate 1 A"},{"key":"b","slug":"gate1-b","name":"Gate 1 B"}]}' \
  "$BASE" "$MODEL_ALIAS" "$OWNER_EMAIL" "$OWNER_PASSWORD" "$setup_token" "$(list_json $KEYS "$COLD_KEY")")")
printf '%s\n' "$fx" | sed 's/^/     /'
fixtures=$(field fixtures "$fx")
json_get() { printf '%s' "$fixtures" | sed -n "s/.*\"$1\":\"\([0-9a-f-]*\)\".*/\1/p"; } # key → uuid
TEAM_A=$(json_get a)
TEAM_B=$(json_get b)
if [[ ! "$TEAM_A $TEAM_B" =~ ^[0-9a-f-]{36}\ [0-9a-f-]{36}$ ]]; then
  fail "fixtures: two teams and their users"
  exit 1
fi
ok "fixtures: two teams and their users"
for k in $KEYS; do contains "user $k is a member of team $(team_of "$k")" "^member_$k=200$" "$fx"; done
# KOBE-41: with a model enabled for both teams (the catalog e2e/run.sh set up against the fake
# upstream), runs are answered by that model; without one (404: no catalog on this install) the
# runs end as before a model existed and the cold step measures to Pi's refusal instead.
if [[ "$(printf '%s\n' "$fx" | grep -c '^models_[ab]=200$')" == 2 ]]; then
  MODELS=1
  ok "both teams enabled the install's model ($MODEL_ALIAS) as their default"
  [[ "$MODEL_ALIAS" == fast ]] && ensure_fake_llm
else
  MODELS=0
  echo "     no model catalog on this install: runs end without a model answer ($(printf '%s\n' "$fx" | grep '^models_' | tr '\n' ' '))"
fi
team_id() { if [[ "$(team_of "$1")" == b ]]; then echo "$TEAM_B"; else echo "$TEAM_A"; fi; }
team_ns() { echo "kobe-team-gate1-$(team_of "$1")"; }
member_json() { # keys... → chat users JSON (with ids)
  local out="" k
  for k in "$@"; do
    out+="${out:+,}$(printf '{"key":"%s","email":"gate1-%s@gate1.test","ip":"%s","teamId":"%s","userId":"%s"}' \
      "$k" "$k" "$(ip_of "$k")" "$(team_id "$k")" "$(json_get "$k")")"
  done
  echo "[$out]"
}
# shellcheck disable=SC2086
MEMBERS=$(member_json $KEYS)
connections() { client "$(printf '{"mode":"connections","base":"%s","users":%s}' "$BASE" "$MEMBERS")"; }

# 1. Concurrency on the real path: ten users send a message at once; each run starts that user's
# own sandbox (gVisor, its team's namespace), the real agent connects, the prompt reaches the real
# Pi, and (KOBE-41) Pi answers it with the team's model through the model gateway and Bifrost: a
# streamed chat answer and `run.completed`. Without a model on the install, Pi's refusal.
if [[ "$STEPS" == *" chat-real "* ]]; then
  echo "==> concurrency, real sandboxes and Pi: 2 teams × 5 users at once"
  real=$(client "$(printf '{"mode":"chat","kind":"real","base":"%s","nonce":"%s","users":%s,"timeoutMs":300000}' "$BASE" "$NONCE" "$MEMBERS")")
  printf '%s\n' "$real" | grep -v '^runs=' | sed 's/^/     /'
  contains "ten users chatted at once" '^users=10$' "$real"
  if ((MODELS)); then real_end='run.completed error=- .*text.delta'; else real_end='(run.completed error=-|run.failed error=(pi_rejected|model_not_configured))'; fi
  if ((MODELS)) && printf '%s\n' "$real" | grep -q "^chat user=.* terminal=run.failed"; then shim_refusals; fi
  for k in $KEYS; do
    contains "$k: the run reached the user's own Pi and ended$( ((MODELS)) && echo " with a streamed model answer")" \
      "^chat user=$k terminal=$real_end" "$(printf '%s\n' "$real" | grep "^chat user=$k ")"
    contains "$k: gapless, no duplicates, same as the log" \
      "^chat user=$k .*gapless=true duplicates=false same_as_log=true" "$(printf '%s\n' "$real" | grep "^chat user=$k ")"
  done
  contains "nobody can open a teammate's or another team's run or thread (all 404)" '^cross_leaks=0$' "$real"
  contains "every user tried every other user's run and thread (180 checks)" '^cross_checks=180$' "$real"
  conns=$(connections)
  printf '%s\n' "$conns" | sed 's/^/     /'
  for k in $KEYS; do
    contains "$k: one live wire connection from the user's own sandbox" "^conn $k open=1 sandbox=[0-9a-f-]{36}:running other_sandbox_open=0$" "$(printf '%s\n' "$conns" | grep "^conn $k ")"
  done
  contains "ten distinct sandboxes" '^10$' \
    "$(printf '%s\n' "$conns" | sed -n 's/.*sandbox=\([0-9a-f-]*\):.*/\1/p' | sort -u | grep -c .)"
  for t in a b; do
    pods=$($KUBECTL -n "kobe-team-gate1-$t" get pods -l agents.x-k8s.io/claim-uid \
      -o jsonpath='{range .items[*]}{.metadata.labels.agents\.x-k8s\.io/claim-uid}/{.spec.runtimeClassName}/{.status.phase}{"\n"}{end}' 2>&1)
    contains "team $t: five user sandboxes run under gVisor in kobe-team-gate1-$t" '^5$' \
      "$(printf '%s\n' "$pods" | grep -E '/gvisor/Running$' | cut -d/ -f1 | grep -cFf <(printf '%s\n' "$conns" | sed -n 's/.*sandbox=\([0-9a-f-]*\):.*/\1/p'))"
  done
fi

sandbox_of() { printf '%s\n' "$conns_all" | sed -n "s/^conn $1 open=[0-9]* sandbox=\([0-9a-f-]*\):.*/\1/p" | head -1; }
suspend() { # key → its Sandbox suspended (pod gone, claim and volume kept, row stays running)
  local ns name
  ns=$(team_ns "$1")
  name=$($KUBECTL -n "$ns" get sandboxclaim "u-$(json_get "$1")" -o jsonpath='{.status.sandbox.name}' 2>/dev/null || true)
  [[ -n "$name" ]] && $KUBECTL -n "$ns" patch sandbox "$name" --type merge -p '{"spec":{"operatingMode":"Suspended"}}' >/dev/null 2>&1 || true
}
all_closed() { [[ "$(connections | grep -c ' open=0 ')" == "$1" ]]; }
start_agent() { # pod name, namespace, settle, words, delta-ms, keys... → scripted agent pod for those identities
  local name="$1" ns="$2" settle="$3" words="$4" delta="$5" ids="" k tokens sid
  shift 5
  local idjson=""
  for k in "$@"; do
    sid=$(sandbox_of "$k")
    idjson+="${idjson:+,}$(printf '{"key":"%s","teamId":"%s","userId":"%s","sandboxId":"%s"}' "$k" "$(team_id "$k")" "$(json_get "$k")" "${sid:-00000000-0000-4000-8000-000000000000}")"
  done
  tokens=$(client "$(printf '{"mode":"mint","base":"%s","identities":[%s]}' "$BASE" "$idjson")")
  for k in "$@"; do
    ids+="${ids:+,}$(printf '{\\"key\\":\\"%s\\",\\"sandboxId\\":\\"%s\\",\\"token\\":\\"%s\\"}' "$k" "$(sandbox_of "$k")" \
      "$(printf '%s\n' "$tokens" | sed -n "s/^token $k //p")")"
  done
  PODS+=("-n $ns $name")
  $KUBECTL -n "$ns" delete pod "$name" --ignore-not-found --wait=true >/dev/null 2>&1 || true
  $KUBECTL apply -f - >/dev/null <<EOF
apiVersion: v1
kind: Pod
metadata: { name: $name, namespace: $ns }
spec:
  restartPolicy: Never
  runtimeClassName: gvisor
  automountServiceAccountToken: false
  securityContext: { runAsNonRoot: true, runAsUser: 1000, seccompProfile: { type: RuntimeDefault } }
  containers:
    - name: agent
      image: $SERVER_IMAGE
      imagePullPolicy: IfNotPresent
      securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } }
      resources: { requests: { cpu: 50m, memory: 64Mi }, limits: { cpu: 500m, memory: 256Mi } }
      env:
        - { name: KOBE_WIRE_URL, value: "ws://$SERVER_IP:8081/v1/sandbox/connect" }
        - { name: GATE1_IDENTITIES, value: "[$ids]" }
        - { name: GATE1_SETTLE, value: "$settle" }
        - { name: GATE1_WORDS, value: "$words" }
        - { name: GATE1_DELTA_MS, value: "$delta" }
      command: ["node", "--input-type=module", "-e"]
      args:
        - |
$(printf '%s\n' "$AGENT_JS" | sed 's/^/          /')
EOF
}
agent_ready() { [[ "$($KUBECTL -n "$2" logs "$1" 2>/dev/null | grep -c ' ready$')" -ge "$3" ]]; }
SERVER_IMAGE=$($KUBECTL -n "$NS" get "$SERVER" -o jsonpath='{.spec.template.spec.containers[?(@.name=="server")].image}')
SERVER_IP=$($KUBECTL -n "$NS" get svc "$RELEASE-server" -o jsonpath='{.spec.clusterIP}')
conns_all=$(connections)

# 2. Streaming chat with a refresh mid-run. The sandbox side is scripted (no model yet): each
# user's sandbox identity is taken over by a scripted agent that streams a 40-word answer. Every
# user reloads after five deltas and resumes with Last-Event-ID; the events received must be the
# run's log exactly (1..n, no gap, no duplicate) and the answer text exact.
if [[ "$STEPS" == *" chat-stream "* ]]; then
  echo "==> concurrency with streamed answers, everyone refreshes mid-run"
  for k in $KEYS; do suspend "$k"; done
  if until_ok 180 all_closed 10; then ok "the real agents are down (claims live, identities free)"; else fail "the real agents are down"; fi
  start_agent gate1-agent kobe-team-gate1-a true 40 100 a1 a2 a3 a4 a5
  start_agent gate1-agent kobe-team-gate1-b true 40 100 b1 b2 b3 b4 b5
  for t in a b; do
    if until_ok 240 agent_ready gate1-agent "kobe-team-gate1-$t" 5; then ok "team $t: five sandbox identities connected over the wire"
    else
      fail "team $t: five sandbox identities connected over the wire"
      $KUBECTL -n "kobe-team-gate1-$t" logs gate1-agent 2>&1 | tail -10 | sed 's/^/     agent: /'
    fi
  done
  stream=$(client "$(printf '{"mode":"chat","kind":"stream","words":40,"refresh":true,"refreshAfter":5,"base":"%s","nonce":"%s","users":%s}' "$BASE" "$NONCE" "$MEMBERS")")
  printf '%s\n' "$stream" | grep -v '^runs=' | sed 's/^/     /'
  contains "ten users chatted at once" '^users=10$' "$stream"
  for k in $KEYS; do
    contains "$k: answer streamed, refreshed mid-run, resumed gapless (log = 1..n, no duplicates), text exact" \
      "^chat user=$k terminal=run.completed error=- events=[0-9]+ gapless=true duplicates=false same_as_log=true refreshed_at=[0-9]+ text=exact" "$(printf '%s\n' "$stream" | grep "^chat user=$k ")"
  done
  contains "nobody can open a teammate's or another team's run or thread (all 404)" '^cross_leaks=0$' "$stream"
  contains "every user tried every other user's run and thread (180 checks)" '^cross_checks=180$' "$stream"
  for t in a b; do $KUBECTL -n "kobe-team-gate1-$t" delete pod gate1-agent --ignore-not-found --wait=false >/dev/null 2>&1 || true; done
fi

# 3. The cross-team probe on this install's own data (the CI db job runs the full suite).
if [[ "$STEPS" == *" probe "* ]]; then
  echo "==> cross-team probe on the live install"
  probe=$(client "$(printf '{"mode":"probe","base":"%s","teams":["%s","%s"]}' "$BASE" "$TEAM_A" "$TEAM_B")")
  printf '%s\n' "$probe" | sed 's/^/     /'
  contains "every team table is probed" '^probe_tables=[1-9][0-9]*$' "$probe"
  contains "no team table returns rows outside withTeam" '^probe_outside_rows=0$' "$probe"
  contains "no team table returns the other team's rows (zero rows)" '^probe_cross_team_rows=0$' "$probe"
  contains "the probe saw real data (threads, runs, events, sandboxes)" '^probe_team_a_tables=.*thread_entries.*' "$probe"
fi

# 4. Kill the sandbox mid-run (scripted agent: no model to keep real Pi busy), then Retry. The
# retry goes to the user's real sandbox, woken, with the thread restored from Postgres.
if [[ "$STEPS" == *" interrupt "* ]]; then
  echo "==> killing a sandbox mid-run: interrupted + Retry, history intact"
  VICTIM=b5
  victim_json=$(member_json "$VICTIM" | sed 's/^\[//; s/\]$//')
  suspend "$VICTIM"
  until_ok 180 all_closed 10 || true
  start_agent gate1-victim kobe-team-gate1-b false 600 500 "$VICTIM"
  if until_ok 240 agent_ready gate1-victim kobe-team-gate1-b 1; then ok "the victim's sandbox identity is connected"; else fail "the victim's sandbox identity is connected"; fi
  started=$(client "$(printf '{"mode":"interrupt-start","base":"%s","nonce":"%s","user":%s}' "$BASE" "$NONCE" "$victim_json")")
  printf '%s\n' "$started" | sed 's/^/     /'
  contains "a message starts a run at once" '^message=201:false$' "$started"
  contains "the partial answer is mirrored (root, prompt, answer)" '^entries_before=[^,]+,[^,]+,[^,]+$' "$started"
  contains "the run is running before the kill" '^status_before=running$' "$started"
  $KUBECTL -n kobe-team-gate1-b delete pod gate1-victim --grace-period=1 --wait=true >/dev/null 2>&1 || true
  retried=$(client "$(printf '{"mode":"interrupt-retry","base":"%s","user":%s,"threadId":"%s","runId":"%s","entriesBefore":"%s"}' \
    "$BASE" "$victim_json" "$(field thread "$started")" "$(field run "$started")" "$(field entries_before "$started")")")
  printf '%s\n' "$retried" | sed 's/^/     /'
  contains "killing the sandbox mid-run ends the run interrupted" '^terminal=run.interrupted$' "$retried"
  contains "run.interrupted says sandbox_lost, retryable" '^interrupted_payload=sandbox_lost:true$' "$retried"
  contains "the thread is interrupted (queue held)" '^thread_status=interrupted$' "$retried"
  contains "the thread names the run to retry" '^interrupted_run=this$' "$retried"
  contains "history survives the kill" '^history_after_kill=intact$' "$retried"
  contains "Retry starts a new run at once" '^retry=201:false$' "$retried"
  contains "Retry is once per run" '^retry_again=same$' "$retried"
  contains "the retry links the interrupted run" '^retry_links=true$' "$retried"
  if ((MODELS)); then retry_end='run.completed:-'; else retry_end='(run.completed:-|run.failed:(pi_rejected|model_not_configured))'; fi
  contains "the retry reaches the user's real sandbox, woken$( ((MODELS)) && echo ", and the model answers")" \
    "^retry_terminal=$retry_end\$" "$retried"
  contains "history survives the retry" '^history_after_retry=intact$' "$retried"
fi

# 5. Cold start (Gate 1, D14): hibernated → the first model token for a new message, through the
# real API, orchestrator, router, wake, agent, Pi, the model gateway, Bifrost and the (fake) model.
# Without a model on the install it is Pi's refusal of the prompt (the point where Pi would call
# the model), honestly labelled.
if [[ "$STEPS" == *" cold "* ]]; then
  if ((MODELS)); then cold_label="first token"; else cold_label="first sandbox answer (no model)"; fi
  echo "==> cold start: hibernated → $cold_label ($TRIALS trials, user $COLD_KEY)"
  cold_json=$(member_json "$COLD_KEY" | sed 's/^\[//; s/\]$//')
  cold_id=$(json_get "$COLD_KEY")
  warm=$(client "$(printf '{"mode":"trial","trial":0,"base":"%s","nonce":"%s","user":%s}' "$BASE" "$NONCE" "$cold_json")")
  printf '     warm-up: %s\n' "$warm"
  thread=$(printf '%s' "$warm" | sed -n 's/.*"threadId":"\([0-9a-f-]*\)".*/\1/p' | head -1)
  claim_uid=$($KUBECTL -n kobe-team-gate1-a get sandboxclaim "u-$cold_id" -o jsonpath='{.metadata.uid}' 2>/dev/null || true)
  pod_gone() { [[ -z "$($KUBECTL -n kobe-team-gate1-a get pods -l "agents.x-k8s.io/claim-uid=${claim_uid:-none}" -o name 2>/dev/null)" ]]; }
  cold_sbx=$($KUBECTL -n kobe-team-gate1-a get sandboxclaim "u-$cold_id" -o jsonpath='{.status.sandbox.name}' 2>/dev/null || true)
  pvc_class=$($KUBECTL -n kobe-team-gate1-a get pvc -o jsonpath='{range .items[*]}{.metadata.name} {.spec.storageClassName}{"\n"}{end}' 2>/dev/null \
    | grep -E "${cold_sbx:-none}|$cold_id" | awk '{print $2}' | head -1 || true)
  echo "     workspace storage class: ${pvc_class:-unknown}"
  values=""
  for i in $(seq 1 "$TRIALS"); do
    hib=""
    [[ -z "${KOBE_GATE1_WARM:-}" ]] && hib=$($KUBECTL -n "$NS" exec "$SERVER" -c server -- node dist/cli/lifecycle.js hibernate \
      --team-id "$TEAM_A" --user-id "$cold_id" 2>&1 | grep -E '^\{"hibernated"' || true)
    if [[ -n "${KOBE_GATE1_WARM:-}" ]]; then
      : # warm trials: the sandbox stays awake
    elif [[ "$hib" != '{"hibernated":true}' ]] || ! until_ok 120 pod_gone; then
      echo "     trial $i: could not hibernate ($hib)"
      continue
    fi
    sleep "${KOBE_GATE1_SPACING_S:-0}"
    t=$(client "$(printf '{"mode":"trial","trial":%s,"threadId":"%s","base":"%s","nonce":"%s-%s","user":%s}' "$i" "$thread" "$BASE" "$NONCE" "$i" "$cold_json")")
    printf '     cold-start: %s\n' "$t"
    ms=$(printf '%s' "$t" | sed -n 's/.*"ms":\([0-9]*\).*/\1/p' | head -1)
    first=$(printf '%s' "$t" | sed -n 's/.*"first":"\([^"]*\)","code":\("[^"]*"\|null\).*/\1:\2/p' | head -1)
    if ((MODELS)); then accepted='text.delta|reasoning.delta'; else accepted='run.failed:"(pi_rejected|model_not_configured)"'; fi
    if [[ -n "$ms" && ( "$first" == text.delta:* || "$first" == reasoning.delta:* || ( ! ((MODELS)) && "$first" =~ ^run\.failed:\"(pi_rejected|model_not_configured)\"$ ) ) ]]; then values+="${values:+,}$ms"
    else echo "     trial $i: no $cold_label ($first; accepted: $accepted)"; ((MODELS)) && [[ "$i" == 1 ]] && shim_refusals; fi
  done
  if ((MODELS)); then cold_tag=hibernated-to-first-token; else cold_tag=hibernated-to-first-sandbox-answer; fi
  summary=$(client "$(printf '{"mode":"summary","base":"%s","label":"%s","values":[%s],"expected":%s,"p95Max":%s}' "$BASE" "$cold_tag" "$values" "$TRIALS" "$P95_MAX")")
  printf '     cold-start: %s\n' "$summary"
  contains "$TRIALS trials, hibernated → $cold_label p95 ≤ $P95_MAX ms" '"pass":true' "$summary"
fi

if ((failed)); then
  echo "Gate 1 suite: FAILED"
  exit 1
fi
echo "Gate 1 suite: all checks passed"
