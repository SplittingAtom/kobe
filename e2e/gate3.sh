#!/usr/bin/env bash
# Gate 3 (KOBE-3, Product) against an installed Kobe, the five criteria end to end (KOBE-231):
#   ac-1 versions  a Builder publishes agent v2 while a thread started on v1 stays pinned to v1; the
#                  thread shows v2 is available and switches in one call; rollback republishes v1 as
#                  a new version (KOBE-46)
#   ac-2 skills    a skill whose script makes a network call is flagged by the scanner and is not
#                  loaded into a run until a team admin approves it; a blocklisted hash never loads,
#                  not even in a live thread that had it (KOBE-79/80/81/82)
#   ac-3 projects  project files are read-only at /workspace/projects/<slug> in a member's sandbox;
#                  a project thread is invisible to another member until shared, then readable and
#                  forkable, not writable (KOBE-162/163)
#   ac-4 memory    a `remember` write emits memory.updated and Undo restores the previous version; a
#                  project-memory write waits for an approval and applies only once approved
#                  (KOBE-155..158)
#   ac-5 data      a CSV upload lands in S3 and in /workspace/uploads/<thread>/; the agent computes
#                  from it in the sandbox and makes an HTML chart artifact served under a strict CSP
#                  (a browser shows its fetch blocked); the sandbox pod and its volume are deleted,
#                  the next turn wakes a new one, Pi's session is rebuilt from Postgres and the
#                  history, artifact and shared file are intact (KOBE-27, KOBE-131, KOBE-143/144/152)
# docs/gates/gate-3.md records what each check proves and what it does not.
#
# Runs after the gate1-prep install in CI (k3d, shard `gate3`) and against a real cluster's install:
#   KOBE_GATE3_NS=<release namespace> KOBE_GATE3_RELEASE=<release> e2e/gate3.sh
# Non-destructive outside what it creates: users gate3-*@gate3.test, team gate3-a (namespace
# kobe-team-gate3-a and the sandbox the server makes for gate3-m1, whose pod and volume ac-5
# deletes), its agents, skills, project, memory docs and threads, and one site blocklist entry for
# a bundle only this run uploads (removed on exit). The memory switches of team gate3-a are turned
# on. It reads the database as the app role, so it refuses anything but a k3d context unless
# KOBE_GATE3_CONTEXT names the context explicitly. Re-runnable: users and team are reused, every
# other object is new per run (named with a nonce).
set -euo pipefail
cd "$(dirname "$0")/.."

KUBECTL="${KUBECTL:-kubectl}"
NS="${KOBE_GATE3_NS:-kobe-dev}"
RELEASE="${KOBE_GATE3_RELEASE:-kobe}"
STEPS=" ${KOBE_GATE3_STEPS:-versions skills projects memory data} "
SBX_WAIT="${KOBE_GATE3_SANDBOX_WAIT:-180}" # seconds m1's sandbox pod may take to be Running and Ready
MODEL_ALIAS="${KOBE_GATE3_MODEL:-fast}"
# The scripted model (CI) echoes prompts like `bash: <cmd>`, `tool: <name> <json>`, `system?` and
# `history?`; a real model gets plain instructions instead and the checks read side effects.
FAKE="${KOBE_GATE3_FAKE:-$([[ "$MODEL_ALIAS" == fast ]] && echo 1 || echo 0)}"
OWNER_EMAIL="${KOBE_GATE3_OWNER_EMAIL:-owner@e2e.test}"
OWNER_PASSWORD="${KOBE_GATE3_OWNER_PASSWORD:-e2e owner password}"
# The browser checks (e2e/browser/scripts/gate3-browser.mjs) need Node and Playwright's Chromium
# where this runs: on in CI, otherwise opt in (or run the printed command elsewhere).
BROWSER="${KOBE_GATE3_BROWSER:-$([[ "${CI:-}" == true ]] && echo 1 || echo 0)}"
TEAM_SLUG=gate3-a
TNS="kobe-team-$TEAM_SLUG"
SERVER="deploy/$RELEASE-server"
BASE="http://$RELEASE-server.$NS.svc.cluster.local"
NONCE="$(date +%s)"
USER_PASSWORD="gate1 user password" # the fixtures' password (e2e/gate1/client.mjs)
failed=0

context=$($KUBECTL config current-context)
if [[ "$context" != k3d-* && "$context" != "${KOBE_GATE3_CONTEXT:-}" ]]; then
  echo "refusing to run against context '$context' (expected k3d-*, or set KOBE_GATE3_CONTEXT=$context)" >&2
  exit 2
fi

# shellcheck source=lib/gate-common.sh
source e2e/lib/gate-common.sh
# shellcheck source=gate2/sandbox.sh
source e2e/gate2/sandbox.sh
# shellcheck source=lib/gate-turns.sh
source e2e/lib/gate-turns.sh

# The Gate 1 and Gate 2 clients' helpers (everything above their MODES) plus the Gate 3 steps.
# shellcheck disable=SC2034 # read by client() in gate-common.sh
CLIENT_JS="$(sed '/^const MODES = {/,$d' e2e/gate1/client.mjs; sed '/^const MODES = {/,$d' e2e/gate2/client.mjs; cat e2e/gate3/client.mjs)"
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
  verdict_on_exit "$rc" "Gate 3 suite"
}
trap cleanup EXIT

# ---- fixtures: team gate3-a with an admin, a Builder and two members ---------------------------------
user_json() { # key ip-suffix → fixture JSON
  printf '{"key":"%s","email":"gate3-%s@gate3.test","name":"Gate3 %s","team":"a","ip":"198.51.100.%s"}' "$1" "$1" "$1" "$2"
}
echo "==> fixtures: team $TEAM_SLUG (admin, builder, two members)"
setup_token=$($KUBECTL -n "$NS" get secret "$RELEASE-auth" -o jsonpath='{.data.setup-token}' 2>/dev/null | base64 -d 2>/dev/null || true)
fx=$(client "$(printf '{"mode":"fixtures","base":"%s","modelAlias":"%s","owner":{"email":"%s","password":"%s"},"setupToken":"%s","users":[%s,%s,%s,%s],"teams":[{"key":"a","slug":"%s","name":"Gate 3 A"}]}' \
  "$BASE" "$MODEL_ALIAS" "$OWNER_EMAIL" "$OWNER_PASSWORD" "$setup_token" \
  "$(user_json ad 61)" "$(user_json bd 62)" "$(user_json m1 63)" "$(user_json m2 64)" "$TEAM_SLUG")")
printf '%s\n' "$fx" | sed 's/^/     /'
fixtures=$(field fixtures "$fx")
json_get() { printf '%s' "$fixtures" | sed -n "s/.*\"$1\":\"\([0-9a-f-]*\)\".*/\1/p"; } # key → uuid
TEAM=$(json_get a)
AD=$(json_get ad)
BD=$(json_get bd)
M1=$(json_get m1)
M2=$(json_get m2)
if [[ ! "$TEAM $AD $BD $M1 $M2" =~ ^([0-9a-f-]{36}\ ){4}[0-9a-f-]{36}$ ]]; then
  fail "fixtures: the team and its users"
  exit 1
fi
ok "fixtures: the team and its users"
ip_of() { case "$1" in ad) echo 198.51.100.61 ;; bd) echo 198.51.100.62 ;; m1) echo 198.51.100.63 ;; *) echo 198.51.100.64 ;; esac; }
user_obj() { # key id → client user JSON
  printf '{"key":"%s","email":"gate3-%s@gate3.test","ip":"%s","teamId":"%s","userId":"%s"}' "$1" "$1" "$(ip_of "$1")" "$TEAM" "$2"
}
U_AD=$(user_obj ad "$AD")
U_BD=$(user_obj bd "$BD")
U_M1=$(user_obj m1 "$M1")
U_M2=$(user_obj m2 "$M2")
OWNER_JSON=$(printf '{"email":"%s","password":"%s"}' "$OWNER_EMAIL" "$OWNER_PASSWORD")
step() { client "$(printf '{"mode":"%s","base":"%s","owner":%s,%s}' "$1" "$BASE" "$OWNER_JSON" "$2")"; }
contains "the Builder has the builder role" '^role=200:builder$' \
  "$(step role "\"admin\":$U_AD,\"userId\":\"$BD\",\"role\":\"builder\"")"
if [[ "$(field models_a "$fx")" == 200 ]]; then
  MODELS=1
  [[ "$MODEL_ALIAS" == fast ]] && ensure_fake_llm
else
  MODELS=0
  fail "no model catalog entry '$MODEL_ALIAS' enabled for the team: every Gate 3 criterion needs runs"
fi

# ---- m1's sandbox: the one under test ----------------------------------------------------------------
T2=$M1 # e2e/gate2/sandbox.sh names the user T2
SBX_WHO=m1
claim_uid() { $KUBECTL -n "$TNS" get sandboxclaim "u-$M1" -o jsonpath='{.metadata.uid}' 2>/dev/null || true; }
sbx_pod() {
  $KUBECTL -n "$TNS" get pods -l "agents.x-k8s.io/claim-uid=$(claim_uid)" --field-selector=status.phase=Running \
    -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null | head -1
}
in_sbx() { # shell command → its output, run in m1's sandbox (agent container)
  local pod
  pod=$(sbx_pod)
  if [[ -z "$pod" ]]; then
    echo "in_sbx: m1's sandbox has no Running pod"
    return 0
  fi
  $KUBECTL -n "$TNS" exec "$pod" -c agent -- sh -c "$1" 2>&1 || true
}
if ((MODELS)); then
  hello=$(turn "$U_M1" "gate3 hello $NONCE" '"title":"gate3 hello"')
  show "hello" "$hello"
  contains "m1's first run completes (its sandbox woke)" '^terminal=run.completed$' "$hello"
  sbx_await "$SBX_WAIT" "the fixtures" || true
fi
sbx_need() { ((MODELS)) && sbx_await "$SBX_WAIT" "$1"; }

# ---- ac-1: agent versions --------------------------------------------------------------------------
if [[ "$STEPS" == *" versions "* ]] && sbx_need "ac-1 (versions)"; then
  echo "==> ac-1: v2 published while a v1 thread stays pinned; one-click switch; rollback is a new version"
  agent() { step agent "\"user\":$U_BD,$1"; }
  code_of() { printf 'G3V%s-%s' "$1" "$NONCE"; } # the codeword in version N's prompt
  prompt_of() { printf 'You are the Gate 3 pinned agent. Your codeword is %s. When asked for your codeword, reply with the codeword only.' "$(code_of "$1")"; }
  front=$(printf '{"name":"Gate3 Pinned %s","description":"Gate 3 versions check"}' "$NONCE")
  ask_code() { if ((FAKE)); then echo "system?"; else echo "What is your codeword? Reply with the codeword only."; fi; }
  created=$(agent "\"action\":\"create\",\"frontmatter\":$front,\"prompt\":$(json_str "$(prompt_of 1)")")
  AGENT=$(field agent_id "$created")
  contains "the Builder creates a team agent (201)" '^agent_create=201:-$' "$created"
  contains "the Builder publishes it: version 1" '^version=1$' "$(agent "\"action\":\"publish\",\"agentId\":\"$AGENT\"")"
  v1=$(turn "$U_M1" "$(ask_code)" "\"agentId\":\"$AGENT\",\"title\":\"gate3 pinned v1\"")
  show "v1 thread" "$v1"
  T_V1=$(field thread "$v1")
  contains "a member's thread on the agent is pinned to v1" '^thread_agent_version=1$' "$v1"
  contains "its run uses v1" "^started_agent=$AGENT:1\$" "$v1"
  contains "the model got v1's prompt" "$(code_of 1)" "$(said "$v1")"
  contains "the Builder edits the prompt (draft)" '^agent_edit=200:-$' \
    "$(agent "\"action\":\"edit\",\"agentId\":\"$AGENT\",\"frontmatter\":$front,\"prompt\":$(json_str "$(prompt_of 2)")")"
  contains "the Builder publishes version 2" '^version=2$' "$(agent "\"action\":\"publish\",\"agentId\":\"$AGENT\"")"
  view=$(step thread "\"user\":$U_M1,\"threadId\":\"$T_V1\"")
  contains "the v1 thread stays pinned to v1 and reports v2 as available (the badge's data)" '^agent_pin=1:2$' "$view"
  again=$(turn "$U_M1" "$(ask_code)" "\"threadId\":\"$T_V1\"")
  show "v1 thread, after v2" "$again"
  contains "the v1 thread's next run still uses v1" "^started_agent=$AGENT:1\$" "$again"
  contains "...with v1's prompt" "$(code_of 1)" "$(said "$again")"
  if grep -q "$(code_of 2)" <<<"$(said "$again")"; then fail "...and not v2's"; else ok "...and not v2's"; fi
  v2=$(turn "$U_M1" "$(ask_code)" "\"agentId\":\"$AGENT\",\"title\":\"gate3 pinned v2\"")
  contains "a new thread on the agent gets v2" '^thread_agent_version=2$' "$v2"
  contains "...and v2's prompt" "$(code_of 2)" "$(said "$v2")"
  contains "one call switches the v1 thread to the current version" '^switch=200:2$' \
    "$(step thread "\"user\":$U_M1,\"threadId\":\"$T_V1\",\"switchTo\":null")"
  switched=$(turn "$U_M1" "$(ask_code)" "\"threadId\":\"$T_V1\"")
  contains "the switched thread's next run uses v2" "^started_agent=$AGENT:2\$" "$switched"
  contains "...with v2's prompt" "$(code_of 2)" "$(said "$switched")"
  rb=$(agent "\"action\":\"rollback\",\"agentId\":\"$AGENT\",\"version\":1")
  show "rollback" "$rb"
  contains "rollback to v1 publishes a new version 3" '^version=3$' "$rb"
  contains "...republished from version 1" '^republished_from=1$' "$rb"
  contains "...with v1's prompt" "$(code_of 1)" "$rb"
  contains "the history keeps every version (1, 2, 3 from 1)" '^versions=1:-,2:-,3:1$' \
    "$(agent "\"action\":\"versions\",\"agentId\":\"$AGENT\"")"
  contains "the switched thread stays on v2 and reports v3 as available" '^agent_pin=2:3$' \
    "$(step thread "\"user\":$U_M1,\"threadId\":\"$T_V1\"")"
  v3=$(turn "$U_M1" "$(ask_code)" "\"agentId\":\"$AGENT\",\"title\":\"gate3 pinned v3\"")
  contains "a new thread gets v3, which carries v1's prompt" "$(code_of 1)" "$(said "$v3")"
  PINNED_THREAD=$T_V1
fi

# ---- ac-2: skills: scan, review, blocklist -------------------------------------------------------------
if [[ "$STEPS" == *" skills "* ]] && sbx_need "ac-2 (skills)"; then
  echo "==> ac-2: a skill with a network call waits for review; a blocklisted hash never loads"
  SKILL="g3net-$NONCE"
  MARK="Gate3 network skill $NONCE"
  upload_skill() { # user-json scope → the upload step's lines (the same bytes every time)
    step skill-upload "\"user\":$1,\"scope\":\"$2\",\"name\":\"$SKILL\",\"description\":\"$MARK\",\"url\":\"https://example.com/gate3-$NONCE\""
  }
  up=$(upload_skill "$U_BD" team)
  show "skill upload" "$up"
  SKILL_ID=$(field skill_id "$up")
  HASH=$(field content_hash "$up")
  contains "the Builder uploads a team skill whose script calls curl (201)" '^skill_upload=201:-$' "$up"
  contains "the scanner flags it; its review is pending" '^review=pending:flagged=true$' "$up"
  queue=$(step skill-review "\"admin\":$U_AD,\"skillId\":\"$SKILL_ID\"")
  contains "the team admin's review queue lists it" '^review_row=.*"flagged":true' "$queue"
  contains "...with a network finding in scripts/fetch.sh" '"category":"network".*scripts/fetch.sh|scripts/fetch.sh.*"category":"network"' "$queue"
  sfront=$(printf '{"name":"Gate3 Skilled %s","skills":["%s"]}' "$NONCE" "$SKILL")
  sk=$(step agent "\"user\":$U_BD,\"action\":\"create\",\"frontmatter\":$sfront,\"prompt\":\"You are the Gate 3 skills agent.\"")
  SK_AGENT=$(field agent_id "$sk")
  contains "an agent that lists the skill is published" '^version=1$' \
    "$(step agent "\"user\":$U_BD,\"action\":\"publish\",\"agentId\":\"$SK_AGENT\"")"
  ask_skills="$(if ((FAKE)); then echo "system?"; else echo "List the names of the skills you have, comma separated, nothing else."; fi)"
  bundles() { step run-bundles "\"teamId\":\"$TEAM\",\"runId\":\"$(field run "$1")\""; }
  skill_run() { # label output expected(loaded|omitted:<reason>)
    local b
    b=$(bundles "$2")
    contains "$1: the run started" '^run_start=1$' "$b"
    if [[ "$3" == loaded ]]; then
      contains "$1: run.start hands the sandbox the skill's bundle" "^bundles=.*$HASH" "$b"
      if grep -q "skill:$SKILL:" <<<"$(field omitted "$2")"; then fail "$1: nothing omitted it"; else ok "$1: nothing omitted it"; fi
      ((FAKE)) && contains "$1: Pi lists the skill to the model" "$SKILL|$MARK" "$(said "$2")"
    else
      if grep -q "$HASH" <<<"$b"; then fail "$1: run.start has no bundle with its hash"; else ok "$1: run.start has no bundle with its hash"; fi
      contains "$1: the run says why it left the skill out (context.omitted ${3#omitted:})" "^omitted=.*skill:$SKILL:${3#omitted:}" "$2"
      if grep -qE "$SKILL|$MARK" <<<"$(said "$2")"; then fail "$1: the model never sees the skill"; else ok "$1: the model never sees the skill"; fi
    fi
  }
  pending=$(turn "$U_M1" "$ask_skills" "\"agentId\":\"$SK_AGENT\",\"title\":\"gate3 skill pending\"")
  show "skill, pending" "$pending"
  skill_run "before review" "$pending" omitted:not_approved
  contains "the team admin approves it" '^decision=200:approved$' \
    "$(step skill-review "\"admin\":$U_AD,\"skillId\":\"$SKILL_ID\",\"version\":1,\"decision\":\"approved\"")"
  # A publish freezes the team skills' loadable versions (SK28, KOBE-318): v1 froze none, so the
  # Builder publishes again once the review approved it, and new threads start on v2.
  contains "the Builder republishes the agent, freezing the approved version (v2)" '^version=2$' \
    "$(step agent "\"user\":$U_BD,\"action\":\"publish\",\"agentId\":\"$SK_AGENT\"")"
  approved=$(turn "$U_M1" "$ask_skills" "\"agentId\":\"$SK_AGENT\",\"title\":\"gate3 skill approved\"")
  show "skill, approved" "$approved"
  skill_run "after approval" "$approved" loaded
  T_SKILL=$(field thread "$approved")
  contains "after approval its files are in m1's sandbox (read-only skills store)" '^present$' \
    "$(in_sbx "test -f /run/kobe-skills/store/sk-$HASH/scripts/fetch.sh && echo present || echo absent")"
  contains "the Owner blocklists the bundle's hash" '^block=201:-$' "$(step blocklist "\"hash\":\"$HASH\"")"
  UNDO+=("step blocklist '\"hash\":\"$HASH\",\"action\":\"remove\"'")
  blocked=$(turn "$U_M1" "$ask_skills" "\"agentId\":\"$SK_AGENT\",\"title\":\"gate3 skill blocked\"")
  show "skill, blocklisted" "$blocked"
  skill_run "blocklisted, new thread" "$blocked" omitted:blocklisted
  live=$(turn "$U_M1" "$ask_skills" "\"threadId\":\"$T_SKILL\"")
  show "skill, blocklisted, live thread" "$live"
  skill_run "blocklisted, the live thread that had it" "$live" omitted:blocklisted
  contains "the same bytes can't be uploaded again as a team skill (422 skill_blocklisted)" '^skill_upload=422:skill_blocklisted$' \
    "$(upload_skill "$U_BD" team)"
  contains "...nor by another member as a personal skill (422 skill_blocklisted)" '^skill_upload=422:skill_blocklisted$' \
    "$(upload_skill "$U_M2" personal)"
fi

# ---- ac-3: projects: read-only files, private until shared -------------------------------------------
if [[ "$STEPS" == *" projects "* || "$STEPS" == *" memory "* ]] && sbx_need "ac-3/ac-4 (projects)"; then
  echo "==> project: two members and a file (for ac-3 and ac-4)"
  PROJECT_TEXT="gate3 project brief $NONCE"
  pr=$(step project-setup "\"admin\":$U_AD,\"name\":\"Gate3 project $NONCE\",\"members\":[\"$M1\",\"$M2\"],\"fileText\":\"$PROJECT_TEXT\"")
  show "project" "$pr"
  PROJECT=$(field project_id "$pr")
  SLUG=$(field project_slug "$pr")
  contains "the team admin creates a project (201, its owner)" '^project_create=201:owner$' "$pr"
  contains "...adds both members" '^member_added=201$' "$pr"
  contains "...and uploads a project file" '^project_file=201:docs/brief.txt$' "$pr"
fi
if [[ "$STEPS" == *" projects "* ]] && sbx_need "ac-3 (projects)"; then
  echo "==> ac-3: project files read-only in the sandbox; a project thread is private until shared"
  P="/workspace/projects/$SLUG/docs/brief.txt"
  cmd="cat $P; (echo x >> $P) 2>/dev/null && echo APPEND=WRITTEN || echo APPEND=DENIED; (touch /workspace/projects/$SLUG/new.txt) 2>/dev/null && echo CREATE=WRITTEN || echo CREATE=DENIED; (rm -f $P) 2>/dev/null; test -f $P && echo REMOVE=DENIED || echo REMOVE=DONE; cat $P"
  ro=$(turn "$U_M1" "$(bash_prompt "$cmd")" "\"projectId\":\"$PROJECT\",\"title\":\"gate3 project\"")
  show "project files" "$ro"
  T_PROJECT=$(field thread "$ro")
  contains "a project thread's run completes" '^terminal=run.completed$' "$ro"
  contains "the project file is mounted at /workspace/projects/<slug>/" "$PROJECT_TEXT" "$(said "$ro")"
  contains "appending to it fails" 'APPEND=DENIED' "$(said "$ro")"
  contains "creating a file next to it fails" 'CREATE=DENIED' "$(said "$ro")"
  contains "removing it fails" 'REMOVE=DENIED' "$(said "$ro")"
  if grep -qE 'APPEND=WRITTEN|CREATE=WRITTEN|REMOVE=DONE' <<<"$(said "$ro")"; then
    fail "no write reached the project files"
  else ok "no write reached the project files"; fi
  sh=$(step project-share "\"author\":$U_M1,\"other\":$U_M2,\"threadId\":\"$T_PROJECT\",\"projectId\":\"$PROJECT\"")
  show "sharing" "$sh"
  contains "another project member can't open the unshared thread (404)" '^other_before=404:thread_not_found$' "$sh"
  contains "...nor sees it in the project's list" '^other_listed_before=false$' "$sh"
  contains "the author shares it with the project" '^share=200:project$' "$sh"
  contains "the member then reads it, read-only" '^other_after=200:read_only=true$' "$sh"
  contains "...with its history" '^other_entries=[1-9][0-9]*$' "$sh"
  contains "...and sees it in the project's list" '^other_listed_after=true$' "$sh"
  contains "the member can't post to it (403 read_only)" '^other_post=403:read_only$' "$sh"
  contains "...nor rename it (403 read_only)" '^other_rename=403:read_only$' "$sh"
  contains "the member forks it (201)" '^fork=201:-$' "$sh"
  contains "the fork is the member's own private, writable thread with the history" '^fork_get=200:read_only=false:private:entries=true$' "$sh"
  contains "the fork is invisible to the author (404)" '^fork_from_author=404:thread_not_found$' "$sh"
  contains "unsharing makes the thread private again" '^unshare=200:private$' "$sh"
  contains "...and the member loses it at once (404)" '^other_after_unshare=404:thread_not_found$' "$sh"
fi

# ---- ac-4: memory: Memory updated + Undo; project memory waits for an approval -------------------------
if [[ "$STEPS" == *" memory "* ]] && sbx_need "ac-4 (memory)"; then
  echo "==> ac-4: remember + Undo; a project-memory write applies only once approved"
  contains "the team's memory switches are on" '^memory_settings=200:.*"memory_enabled":true' \
    "$(step memory-settings "\"admin\":$U_AD")"
  MEM_PATH="notes/gate3-$NONCE.md"
  remember() { tool_prompt remember "$(printf '{"scope":"%s","path":"%s","content":"%s","mode":"replace"}' "$1" "$2" "$3")"; }
  m1=$(turn "$U_M1" "$(remember user "$MEM_PATH" "v1 $NONCE")" '"title":"gate3 memory"')
  show "remember v1" "$m1"
  T_MEMORY=$(field thread "$m1")
  # The browser's own remember turn in that thread (its chip is a notice of the live run).
  MEMORY_PROMPT=$(remember user "$MEM_PATH" "v-browser $NONCE")
  contains "remember creates the doc: memory.updated (version 1, nothing before)" "^memory_events=user:[0-9a-f-]{36}:$MEM_PATH:v1:none\$" "$m1"
  DOC=$(field memory_events "$m1" | cut -d: -f2)
  m2=$(turn "$U_M1" "$(remember user "$MEM_PATH" "v2 $NONCE")" "\"threadId\":\"$T_MEMORY\"")
  show "remember v2" "$m2"
  contains "a second write: memory.updated names version 1 as the one Undo restores" "^memory_events=user:$DOC:$MEM_PATH:v2:1\$" "$m2"
  contains "the doc holds the new content" "^doc_content=v2 $NONCE\$" "$(step memory-doc "\"user\":$U_M1,\"docId\":\"$DOC\"")"
  undo=$(step memory-doc "\"user\":$U_M1,\"docId\":\"$DOC\",\"restore\":1")
  contains "Undo (restore version 1) is accepted" '^restore=200:-$' "$undo"
  contains "...the doc is back to the previous content" "^doc_content=v1 $NONCE\$" "$undo"
  contains "...as a new version, history kept" '^doc_version=3$' "$undo"
  PROJ_PATH="notes/gate3-project-$NONCE.md"
  DENIED_PATH="notes/gate3-denied-$NONCE.md"
  held=$(turn "$U_M1" "$(remember project "$PROJ_PATH" "project fact $NONCE")" \
    "\"projectId\":\"$PROJECT\",\"title\":\"gate3 project memory\",\"hold\":\"remember\",\"holdProject\":\"$PROJECT\",\"holdPath\":\"$PROJ_PATH\"")
  show "project memory" "$held"
  contains "a project-memory write asks for an approval" '^approvals_requested=(.*,)?remember(,.*)?$' "$held"
  contains "...and is not applied while it waits" '^held=remember:doc_before_decision=absent$' "$held"
  contains "once approved it applies: memory.updated (project scope)" "^memory_events=project:[0-9a-f-]{36}:$PROJ_PATH:v1:none\$" "$held"
  denied=$(turn "$U_M1" "$(remember project "$DENIED_PATH" "denied fact $NONCE")" \
    "\"threadId\":\"$(field thread "$held")\",\"hold\":\"remember\",\"holdDecision\":\"deny\",\"holdProject\":\"$PROJECT\",\"holdPath\":\"$DENIED_PATH\"")
  show "project memory, denied" "$denied"
  contains "a second project-memory write is denied" '^decided=remember:deny:200$' "$denied"
  docs=$(step memory-project "\"user\":$U_M1,\"projectId\":\"$PROJECT\",\"paths\":[\"$PROJ_PATH\",\"$DENIED_PATH\"]")
  contains "the project's memory has the approved doc" "^project_doc $PROJ_PATH=present\$" "$docs"
  contains "...and not the denied one" "^project_doc $DENIED_PATH=absent\$" "$docs"
fi

# ---- ac-5: CSV → S3 → sandbox → chart artifact under CSP; the sandbox is lost and nothing is ---------
if [[ "$STEPS" == *" data "* ]] && sbx_need "ac-5 (data)"; then
  echo "==> ac-5: CSV upload, a computed chart artifact under a strict CSP, then the sandbox is deleted"
  KOBE_AGENT=$(field gallery_agent "$(step gallery-agent '"key":"kobe"')")
  contains "the gallery agent Kobe (data-analysis and charts skills) exists" '^[0-9a-f-]{36}$' "$KOBE_AGENT"
  CSV=$'region,amount\nnorth,120.5\nsouth,80\nnorth,30\neast,50.25\n'
  start=$(turn "$U_M1" "gate3 data $NONCE" "\"agentId\":\"$KOBE_AGENT\",\"title\":\"gate3 data\"")
  T_DATA=$(field thread "$start")
  contains "a thread with Kobe starts" '^terminal=run.completed$' "$start"
  up=$(step upload "\"user\":$U_M1,\"threadId\":\"$T_DATA\",\"name\":\"sales.csv\",\"text\":$(json_str "$CSV")")
  show "upload" "$up"
  UPLOAD=$(field file_id "$up")
  contains "the member uploads the CSV into the thread (201, its size)" "^upload=201:${#CSV}:sales.csv\$" "$up"
  contains "the upload is in S3, under the thread's own tree" "^object_key=([^ ]*/)?teams/$TEAM/threads/$T_DATA/" "$up"
  contains "...and the object store holds it, whole" "^object=present:${#CSV}\$" "$up"
  py="import csv,json,collections; t=collections.Counter(); [t.update({r['region']: float(r['amount'])}) for r in csv.DictReader(open('/workspace/uploads/$T_DATA/sales.csv'))]; print('G3TOTALS', json.dumps(dict(sorted(t.items()))))"
  calc=$(turn "$U_M1" "$(bash_prompt "head -1 /workspace/uploads/$T_DATA/sales.csv; python3 -c \"$py\"")" \
    "\"threadId\":\"$T_DATA\",\"fileIds\":[\"$UPLOAD\"]")
  show "compute" "$calc"
  contains "the message with the file runs" '^terminal=run.completed$' "$calc"
  contains "the file is in the sandbox at /workspace/uploads/<thread>/" 'region,amount' "$(said "$calc")"
  contains "Python in the sandbox computed the totals from it" 'G3TOTALS .*east.{1,4}: 50\.25.*north.{1,4}: 150\.5.*south.{1,4}: 80\.0' "$(said "$calc")"
  bars=""
  x=10
  for kv in east:50 north:150 south:80; do # the totals' whole parts as bar heights
    bars+="<rect x='$x' y='$((160 - ${kv#*:}))' width='60' height='${kv#*:}'><title>${kv%%:*}</title></rect>"
    x=$((x + 80))
  done
  html="<!doctype html><html><head><title>Gate 3 sales $NONCE</title></head><body><h1>Sales by region</h1>"
  html+="<p id='scripts'>no</p><p id='fetch'>pending</p><p id='csp'>none</p><svg width='260' height='170'>$bars</svg>"
  html+="<script>document.getElementById('scripts').textContent='ran';"
  html+="document.addEventListener('securitypolicyviolation',function(e){document.getElementById('csp').textContent=e.violatedDirective;});"
  html+="fetch('https://gate3-beacon.invalid/$NONCE').then(function(){document.getElementById('fetch').textContent='allowed';},function(){document.getElementById('fetch').textContent='blocked';});</script></body></html>"
  art=$(turn "$U_M1" "$(tool_prompt create_artifact "$(printf '{"kind":"html","title":"Gate 3 sales %s","content":%s}' "$NONCE" "$(json_str "$html")")")" \
    "\"threadId\":\"$T_DATA\"")
  show "artifact" "$art"
  contains "the agent creates the chart as an HTML artifact (artifact.created, v1)" '^artifact_events=artifact.created:[0-9a-f-]{36}:v1$' "$art"
  ARTIFACT=$(field artifact_events "$art" | cut -d: -f2)
  fr=$(step artifact "\"user\":$U_M1,\"artifactId\":\"$ARTIFACT\",\"version\":1")
  show "frame" "$(grep -v '^frame_csp=' <<<"$fr")"
  printf '     frame CSP: %s\n' "$(field frame_csp "$fr")"
  csp=$(field frame_csp "$fr")
  contains "the frame the chat embeds is served (200)" '^frame=200$' "$fr"
  contains "its CSP sandboxes the page: scripts yes, same origin no" '^sandbox allow-scripts allow-forms;' "$csp"
  if grep -q 'allow-same-origin' <<<"$csp"; then fail "...never allow-same-origin"; else ok "...never allow-same-origin"; fi
  contains "...loads nothing by default (default-src 'none')" "default-src 'none'" "$csp"
  contains "...and allows no network access from the page (connect-src 'none')" "connect-src 'none'" "$csp"
  contains "...and only the deployment may frame it (frame-ancestors 'self')" "frame-ancestors 'self'" "$csp"
  contains "the frame sends X-Frame-Options SAMEORIGIN" '^frame_xfo=SAMEORIGIN$' "$fr"
  share_cmd="cp /workspace/uploads/$T_DATA/sales.csv /workspace/gate3-report-$NONCE.csv && echo copied"
  contains "the agent copies the CSV into its workspace" '^terminal=run.completed$' \
    "$(turn "$U_M1" "$(bash_prompt "$share_cmd")" "\"threadId\":\"$T_DATA\"")"
  sf=$(turn "$U_M1" "$(tool_prompt share_file "$(printf '{"path":"gate3-report-%s.csv","description":"Gate 3 report"}' "$NONCE")")" "\"threadId\":\"$T_DATA\"")
  show "share_file" "$sf"
  contains "the agent shares a file from its workspace (file.shared)" "^file_events=[0-9a-f-]{36}:gate3-report-$NONCE.csv:${#CSV}\$" "$sf"
  SHARED=$(field file_events "$sf" | cut -d: -f1)
  state_of() { step state "\"user\":$U_M1,\"threadId\":\"$T_DATA\",\"artifacts\":[\"$ARTIFACT\"],\"files\":[\"$SHARED\"],\"uploads\":[\"$UPLOAD\"]"; }
  ask_history="$(if ((FAKE)); then echo "history?"; else echo "What did my earlier messages in this conversation ask you to do? One sentence."; fi)"
  pvc_uid() { $KUBECTL -n "$TNS" get pvc "$1" -o jsonpath='{.metadata.uid}' 2>/dev/null || true; }
  pod_uid() { $KUBECTL -n "$TNS" get pod "$1" -o jsonpath='{.metadata.uid}' 2>/dev/null || true; }
  claim_pods() { $KUBECTL -n "$TNS" get pods -l "agents.x-k8s.io/claim-uid=$(claim_uid)" -o name 2>/dev/null || true; }
  # U15: the sandbox is lost, and the next turn loses nothing. `deleted`: its pod and /workspace volume
  # are deleted while it runs (a node lost); `overnight`: it hibernated (idle) and its volume is gone.
  lose_sandbox() { # deleted|overnight
    local how=$1 before after sbx_name pvc old_pvc old_pod old_pod_uid lost_at next new_pod new_pod_uid missing
    echo "==> ac-5 ($how): the sandbox's pod and volume are lost; the next turn loses nothing"
    before=$(state_of)
    show "before the loss" "$(grep -v '^entries=' <<<"$before")"
    sbx_name=$($KUBECTL -n "$TNS" get sandboxclaim "u-$M1" -o jsonpath='{.status.sandbox.name}' 2>/dev/null || true)
    pvc="workspace-${sbx_name:-none}"
    old_pvc=$(pvc_uid "$pvc")
    old_pod=$(sbx_pod)
    # The pod's name is the claim's (u-<user>), the same for its replacement: compare pod UIDs.
    old_pod_uid=$(pod_uid "${old_pod:-none}")
    contains "$how: the sandbox has a pod and a workspace volume" '^[^ ]+ [0-9a-f-]{36}$' "${old_pod:-none} ${old_pvc:-none}"
    lost_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    if [[ "$how" == deleted ]]; then
      $KUBECTL -n "$TNS" delete pvc "$pvc" --wait=false >/dev/null 2>&1 || true
      $KUBECTL -n "$TNS" delete pod "${old_pod:-none}" --wait=true --timeout=120s >/dev/null 2>&1 || true
    else
      contains "$how: the idle sandbox hibernates" '"hibernated":true' \
        "$($KUBECTL -n "$NS" exec "$SERVER" -c server -- node dist/cli/lifecycle.js hibernate --team-id "$TEAM" --user-id "$M1" 2>&1 || true)"
      pods_gone() { [[ -z "$(claim_pods)" ]]; }
      if until_ok 120 pods_gone; then ok "$how: its pod is gone"; else fail "$how: its pod is gone"; fi
      $KUBECTL -n "$TNS" delete pvc "$pvc" --wait=true --timeout=120s >/dev/null 2>&1 || true
    fi
    pvc_replaced() { [[ "$(pvc_uid "$pvc")" != "$old_pvc" ]]; }
    if until_ok 120 pvc_replaced; then ok "$how: the sandbox's volume is deleted"; else
      fail "$how: the sandbox's volume is deleted (pvc $old_pvc still there: $($KUBECTL -n "$TNS" get pvc "$pvc" --no-headers 2>&1 | tr -s ' '))"
      sbx_diagnose
    fi
    next=$(turn "$U_M1" "$ask_history" "\"threadId\":\"$T_DATA\"")
    show "$how: the next turn" "$next"
    contains "$how: the next turn completes" '^terminal=run.completed$' "$next"
    grep -q '^terminal=run.completed$' <<<"$next" || sbx_diagnose
    if [[ "$how" == overnight ]]; then
      contains "$how: ...showing the sandbox waking (sandbox.waking)" '^waking=[a-z_]+' "$next"
    fi
    ((FAKE)) && contains "$how: Pi continued the conversation (the model got the earlier turns)" \
      'history said: .*(G3TOTALS|sales\.csv)' "$(said "$next")"
    new_pod=$(sbx_pod)
    new_pod_uid=$(pod_uid "${new_pod:-none}")
    if [[ -n "$new_pod_uid" && "$new_pod_uid" != "$old_pod_uid" ]]; then ok "$how: a new sandbox pod answered ($new_pod, uid $new_pod_uid)"
    else fail "$how: a new sandbox pod answered (got ${new_pod:-none}, uid ${new_pod_uid:-none}; before: uid ${old_pod_uid:-none})"; fi
    contains "$how: ...on a new, empty volume" '^[0-9a-f-]{36}$' "$(pvc_uid "$pvc" | grep -vx "$old_pvc" || true)"
    contains "$how: Pi's session file was rebuilt in the new sandbox" '^jsonl=[1-9][0-9]*$' \
      "$(in_sbx "f=/workspace/.kobe/sessions/$T_DATA.jsonl; if test -s \$f; then echo jsonl=\$(wc -l < \$f); else echo jsonl=missing; fi")"
    contains "$how: ...from Postgres (the server restored the lost session)" '^[1-9]' \
      "$($KUBECTL -n "$NS" logs -l app.kubernetes.io/component=server -c server --since-time="$lost_at" --tail=-1 2>/dev/null \
        | grep -F "\"thread_id\":\"$T_DATA\"" | grep -c 'Pi session lost; restoring from Postgres' || true)"
    after=$(state_of)
    missing=$(comm -23 <(field entries "$before" | tr ',' '\n' | sort) <(field entries "$after" | tr ',' '\n' | sort) | grep -c . || true)
    contains "$how: the thread had history to keep" '^[1-9][0-9]*$' "$(field entries "$before" | tr ',' '\n' | grep -c .)"
    contains "$how: ...and every entry is still there" '^0$' "$missing"
    contains "$how: the artifacts are intact" "^artifacts=$(field artifacts "$before")\$" "$after"
    contains "$how: ...with the same content" "^artifact_content $ARTIFACT=$(sed -n "s/^artifact_content $ARTIFACT=//p" <<<"$before" | grep '^200:')\$" "$after"
    contains "$how: the shared file is intact (same bytes)" "^file_content $SHARED=$(sed -n "s/^file_content $SHARED=//p" <<<"$before" | grep '^200:')\$" "$after"
    contains "$how: the upload is still in S3" "^upload_object $UPLOAD=present:${#CSV}\$" "$after"
  }
  lose_sandbox deleted
  lose_sandbox overnight
fi

# ---- the browser checks: frame CSP (ac-5), Memory updated chip (ac-4), version badge (ac-1) ------------
browser_env() { # the variables gate3-browser.mjs reads, except the password
  printf 'KOBE_BROWSER_BASE=%s KOBE_BROWSER_EMAIL=gate3-m1@gate3.test KOBE_BROWSER_TEAM=%s KOBE_BROWSER_ARTIFACT=%s:1 KOBE_BROWSER_MEMORY_THREAD=%s KOBE_BROWSER_PINNED_THREAD=%s' \
    "$PUBLIC_URL" "$TEAM" "${ARTIFACT:-none}" "${T_MEMORY:-none}" "${PINNED_THREAD:-none}"
}
if ((MODELS)) && [[ -n "${ARTIFACT:-}${T_MEMORY:-}${PINNED_THREAD:-}" ]]; then
  PUBLIC_URL=$($KUBECTL -n "$NS" exec "$SERVER" -c server -- printenv KOBE_PUBLIC_URL 2>/dev/null || true)
  if [[ "$BROWSER" != 1 ]]; then
    echo "skip browser checks (KOBE_GATE3_BROWSER=$BROWSER); run them where Chromium reaches $PUBLIC_URL:"
    echo "     cd e2e/browser && npm ci && npx playwright install chromium && $(browser_env) KOBE_BROWSER_MEMORY_PROMPT='<a remember turn>' KOBE_BROWSER_PASSWORD=<the fixtures' password> node scripts/gate3-browser.mjs"
  else
    echo "==> browser: the chart frame's CSP, the Memory updated chip, the version badge"
    map="${KOBE_GATE3_BROWSER_MAP:-}"
    if [[ -z "$map" && "$context" == k3d-* ]]; then
      # The browser runs beside kubectl: it reaches the ingress through a port-forward and resolves
      # the public host to it, so it talks to Kobe under its own origin.
      $KUBECTL -n kube-system port-forward svc/traefik 18080:80 >"$WORK/port-forward.log" 2>&1 &
      pf=$!
      UNDO+=("kill $pf")
      map=127.0.0.1:18080
      ingress_up() { curl -s -o /dev/null -m 3 -H "Host: ${PUBLIC_URL#*://}" "http://$map/v1/setup"; }
      until_ok 30 ingress_up || echo "     the port-forward to the ingress did not answer: $(tail -2 "$WORK/port-forward.log")"
    fi
    # shellcheck disable=SC2046 # browser_env is a list of NAME=value words
    br=$(env $(browser_env) KOBE_BROWSER_MAP="$map" KOBE_BROWSER_PASSWORD="$USER_PASSWORD" KOBE_BROWSER_MEMORY_PROMPT="${MEMORY_PROMPT:-}" \
      node e2e/browser/scripts/gate3-browser.mjs 2>&1 || true)
    printf '%s\n' "$br" | sed 's/^/     /'
    contains "browser: m1 signs in" '^signin=ok$' "$br"
    contains "browser: ...into the Gate 3 team (active team set)" '^active_team=200$' "$br"
    if [[ -n "${ARTIFACT:-}" ]]; then
      contains "ac-5 browser: the chart frame loads in a same-origin iframe (200)" '^frame_status=200$' "$br"
      contains "ac-5 browser: its inline script runs" '^frame_scripts=ran$' "$br"
      contains "ac-5 browser: the chart renders its three bars" '^frame_bars=3$' "$br"
      contains "ac-5 browser: the page's origin is opaque (no same-origin access)" '^frame_origin=null$' "$br"
      contains "ac-5 browser: its fetch() to an outside address is blocked" '^frame_fetch=blocked$' "$br"
      contains "ac-5 browser: ...by the CSP (connect-src violation)" '^frame_csp_violation=connect-src$' "$br"
      contains "ac-5 browser: ...and no request left the page" '^beacon_hits=0$' "$br"
    fi
    if [[ -n "${T_MEMORY:-}" ]]; then
      contains "ac-4 browser: the thread shows the Memory updated chip" '^memory_chip=visible$' "$br"
      contains "ac-4 browser: ...with Undo" '^memory_undo=present$' "$br"
      contains "ac-4 browser: one click on Undo undoes it" '^memory_undone=yes$' "$br"
      show "memory doc after the browser's turn" "$(step memory-doc "\"user\":$U_M1,\"docId\":\"$DOC\"")"
    fi
    if [[ -n "${PINNED_THREAD:-}" ]]; then
      contains "ac-1 browser: the pinned thread shows 'v3 available'" '^version_badge=visible:.*v3 available' "$br"
      contains "ac-1 browser: ...with a one-click switch" '^version_switch=present$' "$br"
      contains "ac-1 browser: one click on Switch moves the thread to v3" '^version_switched=3$' "$br"
      after=$(turn "$U_M1" "$(ask_code)" "\"threadId\":\"$PINNED_THREAD\"")
      contains "ac-1: the thread's next run after the click uses v3" "^started_agent=$AGENT:3\$" "$after"
      contains "...with v3's prompt (v1's, rolled back)" "$(code_of 1)" "$(said "$after")"
    fi
  fi
fi

if ((failed)); then
  verdict "Gate 3 suite: FAILED"
  exit 1
fi
if ((xfailed)); then
  verdict "Gate 3 suite: passed with $xfailed expected failures (filed product failures; KOBE_GATE_STRICT=1 fails them)"
else
  verdict "Gate 3 suite: all checks passed"
fi
