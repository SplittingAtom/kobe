#!/usr/bin/env bash
# Gate 5 (KOBE-227, v1.1 Conversation): user stories U17-U24 (Conversational Enhancements spec §5),
# one verdict per story. A story is proven by its browser checks (Playwright in a real Chromium,
# e2e/browser: the specs written for its tickets and e2e/browser/tests/gate5/ for the criteria they
# leave out) and, where the browser cannot see it, API checks in a server pod (e2e/gate5/client.mjs).
# docs/gates/gate-5.md lists each story's checks and what they prove.
#
#   e2e/gate5.sh                      every story (after the gate1-prep install on k3d)
#   KOBE_GATE5_STORIES="U19 U24" ...  some stories
#   KOBE_GATE5_BROWSER=0 ...          API checks only; prints the browser command to run elsewhere,
#                                     whose report KOBE_GATE5_RESULTS=<results.json> then judges
#
# A real install: KOBE_GATE5_NS, _RELEASE, _CONTEXT, _MODEL (the team default), _MODEL2 (a second
# model, for Regenerate with), _OWNER_EMAIL/_PASSWORD. It creates users gate5-{ad,m2}@gate5.test in
# team gate5-a (and their threads, an agent, workspace files the specs delete again). With the fake
# model (KOBE_GATE5_MODEL=fast, the k3d default) it adds catalog entry `g5ctx` (a 200,000-token
# window) as the team's default model.
set -euo pipefail
cd "$(dirname "$0")/.."

KUBECTL="${KUBECTL:-kubectl}"
NS="${KOBE_GATE5_NS:-kobe-dev}"
RELEASE="${KOBE_GATE5_RELEASE:-kobe}"
STORIES="${KOBE_GATE5_STORIES:-U17 U18 U19 U20 U21 U22 U23 U24}"
MODEL_ALIAS="${KOBE_GATE5_MODEL:-fast}"
FAKE="${KOBE_GATE5_FAKE:-$([[ "$MODEL_ALIAS" == fast ]] && echo 1 || echo 0)}"
MODEL2="${KOBE_GATE5_MODEL2:-$([[ "$FAKE" == 1 ]] && echo smart || true)}"
OWNER_EMAIL="${KOBE_GATE5_OWNER_EMAIL:-owner@e2e.test}"
OWNER_PASSWORD="${KOBE_GATE5_OWNER_PASSWORD:-e2e owner password}"
BROWSER="${KOBE_GATE5_BROWSER:-$([[ "${CI:-}" == true ]] && echo 1 || echo 0)}"
TEAM_SLUG=gate5-a
TNS="kobe-team-$TEAM_SLUG"
SERVER="deploy/$RELEASE-server"
BASE="http://$RELEASE-server.$NS.svc.cluster.local"
NONCE="$(date +%s)"
USER_PASSWORD="gate1 user password" # the fixtures' password (e2e/gate1/client.mjs)
CTX_ALIAS=g5ctx
CTX_WINDOW=200000
failed=0

context=$($KUBECTL config current-context)
if [[ "$context" != k3d-* && "$context" != "${KOBE_GATE5_CONTEXT:-}" ]]; then
  echo "refusing to run against context '$context' (expected k3d-*, or set KOBE_GATE5_CONTEXT=$context)" >&2
  exit 2
fi

# shellcheck source=lib/gate-common.sh
source e2e/lib/gate-common.sh
# shellcheck source=lib/gate-turns.sh
source e2e/lib/gate-turns.sh

# shellcheck disable=SC2034 # read by client() in gate-common.sh
CLIENT_JS="$(for f in e2e/gate1/client.mjs e2e/gate2/client.mjs e2e/gate3/client.mjs; do sed '/^const MODES = {/,$d' "$f"; done
  cat e2e/gate5/client.mjs)"
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
  verdict_on_exit "$rc" "Gate 5"
}
trap cleanup EXIT
want() { [[ " $STORIES " == *" $1 "* ]]; }
# A story's API section fails the story (not only the run): `failed` is a flag, so each section
# starts it afresh and ORs it back at its end.
API_FAILED=" "
failed_before=0
api_begin() { failed_before=$failed; failed=0; }
api_end() { # story
  ((failed)) && API_FAILED+="$1 "
  ((failed_before)) && failed=1
  return 0
}

# What each story's acceptance criteria are, and its browser specs (e2e/browser/tests/...).
STORY_TEXT=(
  "U17|Kobe is one workspace: the CE7 table holds at four widths; the conversation never under 400 px; rail state, divider and artifact width persist across two browsers."
  "U18|I never lose the conversation: artifacts, files, memory, settings open beside the thread; scrolled up mid-stream holds and the Jump pill counts; the composer is visible at every width."
  "U19|The steering panel walks idle, active, queued, waiting, interrupted; queued messages edited, deleted, reordered; Steer, Stop, Retry, Continue; zero height when idle."
  "U20|The gauge is the latest run_usage prompt over context_window; thresholds at 65% and 85%; Compact now with a focus makes a compaction marker with the summary."
  "U21|Reasoning, tool cards (over 64 KB on expand), hover footers and system markers render for a recorded thread; the Detail toggle expands all and persists per user."
  "U22|The first message is editable; fork markers at multi-child entries; Fork to a new thread with a working back-link; Regenerate with another model; hidden for a pinned agent."
  "U23|A title after the first run, a rename stops auto-titling; pin, archive, move to project in the rail; the palette finds threads and files; @file reaches the prompt as a sandbox path."
  "U24|Share and revoke are audited; a second member reads it read-only with the banner and forks it; Shared with me; a team admin sees only shared threads."
)
SPECS=(
  "U17|chat-layout.spec.ts rail-header.spec.ts rail-resize.spec.ts gate5/u17-workspace.spec.ts"
  "U18|scroll-follow.spec.ts gate5/u18-never-lose.spec.ts"
  "U19|steering-panel.spec.ts gate5/u19-steering.spec.ts"
  "U20|context-gauge.spec.ts compact-now.spec.ts gate5/u20-gauge.spec.ts"
  "U21|gate5/u21-history.spec.ts"
  "U22|root-edit.spec.ts fork.spec.ts regenerate-with.spec.ts gate5/u22-fork-compare.spec.ts"
  "U23|auto-title.spec.ts organize.spec.ts command-palette.spec.ts file-mentions.spec.ts gate5/u23-organize-find.spec.ts"
  "U24|share.spec.ts"
)
specs_of() { printf '%s\n' "${SPECS[@]}" | grep "^$1|" | cut -d'|' -f2; }
text_of() { printf '%s\n' "${STORY_TEXT[@]}" | grep "^$1|" | cut -d'|' -f2-; }

# ---- fixtures: team gate5-a, a team admin (the browser's member) and a second member ---------------
user_json() { # key ip-suffix → fixture JSON
  printf '{"key":"%s","email":"gate5-%s@gate5.test","name":"Gate5 %s","team":"a","ip":"198.51.100.%s"}' "$1" "$1" "$1" "$2"
}
echo "==> fixtures: team $TEAM_SLUG (a team admin and a member)"
setup_token=$($KUBECTL -n "$NS" get secret "$RELEASE-auth" -o jsonpath='{.data.setup-token}' 2>/dev/null | base64 -d 2>/dev/null || true)
fx=$(client "$(printf '{"mode":"fixtures","base":"%s","modelAlias":"%s","owner":{"email":"%s","password":"%s"},"setupToken":"%s","users":[%s,%s],"teams":[{"key":"a","slug":"%s","name":"Gate 5 A"}]}' \
  "$BASE" "$MODEL_ALIAS" "$OWNER_EMAIL" "$OWNER_PASSWORD" "$setup_token" "$(user_json ad 91)" "$(user_json m2 92)" "$TEAM_SLUG")")
printf '%s\n' "$fx" | sed 's/^/     /'
fixtures=$(field fixtures "$fx")
json_get() { printf '%s' "$fixtures" | sed -n "s/.*\"$1\":\"\([0-9a-f-]*\)\".*/\1/p"; }
TEAM=$(json_get a)
AD=$(json_get ad)
M2=$(json_get m2)
if [[ ! "$TEAM $AD $M2" =~ ^([0-9a-f-]{36}\ ){2}[0-9a-f-]{36}$ ]]; then
  fail "fixtures: the team and its users"
  exit 1
fi
ok "fixtures: the team and its users"
U_AD=$(printf '{"key":"ad","email":"gate5-ad@gate5.test","ip":"198.51.100.91","teamId":"%s","userId":"%s"}' "$TEAM" "$AD")
U_M2=$(printf '{"key":"m2","email":"gate5-m2@gate5.test","ip":"198.51.100.92","teamId":"%s","userId":"%s"}' "$TEAM" "$M2")
OWNER_JSON=$(printf '{"email":"%s","password":"%s"}' "$OWNER_EMAIL" "$OWNER_PASSWORD")
step() { client "$(printf '{"mode":"%s","base":"%s","owner":%s,%s}' "$1" "$BASE" "$OWNER_JSON" "$2")"; }
[[ "$FAKE" == 1 ]] && ensure_fake_llm
if [[ "$FAKE" == 1 ]]; then
  DEFAULT_ALIAS=$CTX_ALIAS
  models=$(step g5-models "\"admin\":$U_AD,\"alias\":\"$CTX_ALIAS\",\"providerId\":\"openai\",\"window\":$CTX_WINDOW${MODEL2:+,\"second\":\"$MODEL2\"}")
else
  DEFAULT_ALIAS=$MODEL_ALIAS
  models=$(step g5-models "\"admin\":$U_AD,\"alias\":\"$MODEL_ALIAS\"${MODEL2:+,\"second\":\"$MODEL2\"}")
fi
show "models" "$models"
contains "the team's default model is set ($DEFAULT_ALIAS)" '^team_default=200$' "$models"
[[ -n "$MODEL2" ]] && contains "...and a second model is enabled ($MODEL2)" '^team_second=200$' "$models"
contains "...and Bifrost has it (gateway in sync)" '^gateway_in_sync=true$' "$models"

# ---- API checks -----------------------------------------------------------------------------------
if want U20; then
  api_begin
  echo "==> U20 api: the gauge's reading is the latest run_usage prompt over the model's window"
  prompt=$([[ "$FAKE" == 1 ]] && echo "kobe-prompt-tokens=140000 gauge" || echo "No tools. Reply with the single word GAUGE.")
  g=$(turn "$U_AD" "$prompt" '"title":"gate5 gauge"')
  show "gauge turn" "$g"
  contains "U20: the turn completes" '^terminal=run.completed$' "$g"
  u=$(step g5-usage "\"user\":$U_AD,\"threadId\":\"$(field thread "$g")\",\"alias\":\"$DEFAULT_ALIAS\"")
  show "usage" "$u"
  latest=$(field usage_latest "$u" | cut -d: -f2)
  contains "U20: the usage read's latest call is the newest run_usage row" "^run_usage_latest=${latest:-none}\$" "$u"
  [[ "$FAKE" == 1 ]] && contains "U20: ...the prompt the call reported (140,000)" '^usage_latest=200:140000$' "$u"
  [[ "$FAKE" == 1 ]] && contains "U20: the window the gauge divides by is the catalog's" "^context_window=$CTX_WINDOW\$" "$u"
  api_end U20
fi
if want U23; then
  api_begin
  echo "==> U23 api: a title after the first run; a rename stops auto-titling"
  rn=$(step g5-title "\"user\":$U_M2,\"title\":\"Gate5 renamed $NONCE\"")
  show "titles" "$rn"
  contains "U23: the untitled thread's first run completes" '^run1=run.completed$' "$rn"
  contains "U23: a title appears after the first run" '^title_auto=set:locked=false$' "$rn"
  contains "U23: the rename is saved and locks the title" '^title_after_rename=true:locked=true$' "$rn"
  contains "U23: a later run completes" '^run2=run.completed$' "$rn"
  contains "U23: ...and the member's name stands (no auto-title over it)" '^title_kept=true:' "$rn"
  api_end U23
fi
if want U24; then
  api_begin
  echo "==> U24 api: a team admin sees a member's thread only while it is shared; share and revoke are audited"
  s1=$(turn "$U_M2" "No tools. Reply with the single word PRIVATE." '"title":"gate5 share"')
  contains "U24: the member's thread exists" '^terminal=run.completed$' "$s1"
  sh=$(step g5-share "\"author\":$U_M2,\"admin\":$U_AD,\"threadId\":\"$(field thread "$s1")\"")
  show "share" "$sh"
  contains "U24: the team admin can't open the private thread (404)" '^admin_private=404:' "$sh"
  contains "U24: ...nor sees it listed" '^admin_listed_private=false$' "$sh"
  contains "U24: the member shares it with the team" '^share=200:team$' "$sh"
  contains "U24: the team admin then reads it, read-only" '^admin_shared=200:read_only=true$' "$sh"
  contains "U24: the member revokes it" '^revoke=200:private$' "$sh"
  contains "U24: the team admin loses it again (404)" '^admin_after_revoke=404:' "$sh"
  contains "U24: share and revoke are audited, as the member" '^audit=private>team:author,team>private:author$' "$sh"
  api_end U24
fi

# A thread on an agent that pins its model, for U22 (Regenerate with is hidden there).
PINNED_THREAD=""
if want U22; then
  api_begin
  echo "==> U22 api: a thread on an agent that pins its model (for the browser check)"
  front=$(printf '{"name":"Gate5 Pinned %s","description":"Gate 5 pinned model","model":"%s"}' "$NONCE" "$DEFAULT_ALIAS")
  made=$(step agent "\"user\":$U_AD,\"action\":\"create\",\"frontmatter\":$front,\"prompt\":\"You are the Gate 5 pinned agent.\"")
  AGENT=$(field agent_id "$made")
  contains "U22: a team agent that pins its model is created" '^agent_create=201:' "$made"
  contains "U22: ...and published" '^publish=20[01]:' "$(step agent "\"user\":$U_AD,\"action\":\"publish\",\"agentId\":\"$AGENT\"")"
  pt=$(turn "$U_AD" "No tools. Reply with the single word PINNED." "\"agentId\":\"$AGENT\",\"title\":\"gate5 pinned\"")
  contains "U22: the admin's thread on it has an answer" '^terminal=run.completed$' "$pt"
  PINNED_THREAD=$(field thread "$pt")
  api_end U22
fi

# ---- the browser checks -----------------------------------------------------------------------------
files=()
for s in $STORIES; do
  # shellcheck disable=SC2207 # space-separated file names
  files+=($(specs_of "$s"))
done
PUBLIC_URL=$($KUBECTL -n "$NS" exec "$SERVER" -c server -- printenv KOBE_PUBLIC_URL 2>/dev/null || true)
# U19's interrupt deletes the member's sandbox pod mid-run; its agent log (Pi starts, exits,
# refusals) goes with it, so the command keeps a copy first (printed below when U19 fails).
SBX_SELECTOR="agents.x-k8s.io/claim-uid=\$($KUBECTL -n $TNS get sandboxclaim u-$AD -o jsonpath='{.metadata.uid}')"
KILL_CMD="$KUBECTL -n $TNS logs -l $SBX_SELECTOR --all-containers --tail=-1 >\"$WORK/sandbox-killed-\$(date +%s).log\" 2>&1; $KUBECTL -n $TNS delete pod -l $SBX_SELECTOR --wait=false"
browser_env() { # the variables the specs read, except the passwords
  printf 'KOBE_BASE_URL=%s KOBE_USER=gate5-ad@gate5.test KOBE_USER2=gate5-m2@gate5.test KOBE_FAKE_MODEL=%s KOBE_GATE5_PINNED_THREAD=%s KOBE_GATE5_MODEL2=%s' \
    "$PUBLIC_URL" "$FAKE" "${PINNED_THREAD:-}" "${MODEL2:-}"
}
RESULTS="${KOBE_GATE5_RESULTS:-}"
if [[ "$BROWSER" == 1 ]]; then
  echo "==> browser: ${#files[@]} spec files in Chromium against $PUBLIC_URL"
  map="${KOBE_GATE5_BROWSER_MAP:-}"
  if [[ -z "$map" && "$context" == k3d-* ]]; then
    # Chromium beside kubectl reaches the ingress through a port-forward, under the site's own origin.
    $KUBECTL -n kube-system port-forward svc/traefik 18080:80 >"$WORK/port-forward.log" 2>&1 &
    pf=$!
    UNDO+=("kill $pf")
    map=127.0.0.1:18080
    ingress_up() { curl -s -o /dev/null -m 3 -H "Host: ${PUBLIC_URL#*://}" "http://$map/v1/setup"; }
    until_ok 30 ingress_up || echo "     the port-forward to the ingress did not answer: $(tail -2 "$WORK/port-forward.log")"
  fi
  RESULTS="$WORK/results.json"
  # shellcheck disable=SC2046 # browser_env is a list of NAME=value words
  (cd e2e/browser && env $(browser_env) KOBE_PW="$USER_PASSWORD" KOBE_PW2="$USER_PASSWORD" \
    KOBE_BROWSER_MAP="$map" KOBE_BROWSER_RESULTS="$RESULTS" KOBE_GATE5_KILL_SANDBOX="$KILL_CMD" \
    npx playwright test "${files[@]}" >"$WORK/playwright.log" 2>&1) || true
  grep -E '✓|✘|-  |passed|failed|skipped|flaky' "$WORK/playwright.log" | tail -60 | sed 's/^/     /' || true
elif [[ -z "$RESULTS" ]]; then
  echo "skip browser checks (KOBE_GATE5_BROWSER=$BROWSER); run them where Chromium reaches $PUBLIC_URL, then judge with KOBE_GATE5_RESULTS=<results.json>:"
  echo "     cd e2e/browser && npm ci && npx playwright install chromium && $(browser_env) KOBE_PW=<the fixtures' password> KOBE_PW2=<same> KOBE_BROWSER_RESULTS=<results.json> npx playwright test ${files[*]}"
fi

# ---- verdict -----------------------------------------------------------------------------------------
proven=0
xfailed_stories=0
echo "==> Gate 5: user stories $STORIES"
for s in $STORIES; do
  lines=""
  if [[ -n "$RESULTS" ]]; then
    # shellcheck disable=SC2046 # the story's spec files
    lines=$(node e2e/gate5/verdict.mjs "$RESULTS" $(specs_of "$s"))
  else
    lines="NOTRUN $s browser checks: not run here"
  fi
  echo "==> $s: browser"
  printf '%s\n' "$lines"
  verdict=ok
  [[ "$API_FAILED" == *" $s "* ]] && verdict=FAIL && echo "       its API checks failed (above)"
  grep -qE '^(FAIL|XPASS|INVALID|NOTRUN) ' <<<"$lines" && verdict=FAIL
  [[ "$verdict" == ok ]] && grep -q '^XFAIL ' <<<"$lines" && verdict=XFAIL
  [[ "$verdict" == XFAIL && "${KOBE_GATE_STRICT:-0}" == 1 ]] && verdict=FAIL
  case "$verdict" in
    ok) echo "ok   $s $(text_of "$s")"; proven=$((proven + 1)) ;;
    XFAIL) echo "XFAIL $s $(text_of "$s")"; xfailed_stories=$((xfailed_stories + 1)) ;;
    *) echo "FAIL $s $(text_of "$s")"; failed=1 ;;
  esac
done
n=$(wc -w <<<"$STORIES" | tr -d ' ')
# Evidence for a failed U19: what the killed sandboxes' agents logged before the pod went.
for f in "$WORK"/sandbox-killed-*.log; do
  [[ -f "$f" && "$failed" == 1 ]] || continue
  echo "     --- the sandbox agent's log before U19 deleted its pod ($(basename "$f")):"
  tail -150 "$f" | cut -c1-500 | sed 's/^/     /' || true
done
if ((failed)); then
  verdict "Gate 5: FAILED ($proven of $n stories proven; the API checks above count too)"
  exit 1
fi
if ((xfailed_stories)); then
  verdict "Gate 5: $proven of $n stories proven, $xfailed_stories with expected failures (filed; KOBE_GATE_STRICT=1 fails them)"
else
  verdict "Gate 5: all $n stories proven"
fi
