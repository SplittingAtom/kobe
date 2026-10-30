#!/usr/bin/env bash
# Gate 4, U16's backup half (KOBE-233): `kobe backup` → a fresh site → `kobe restore`, with the
# integrity checks, and the timed clean install (helm install → first assistant token).
#
#   install   a throwaway source site is installed as docs/install.md describes (chart, first-run
#             setup, a model provider and catalog entry, a team), timed to the first assistant token
#   restore   it gets threads, artifacts, an upload, a shared file, a workspace file, a skill, a
#             memory doc, a project file and an API-key connector grant; its writers stop; `kobe
#             backup` (docs/backup-restore.md, the operator CLI on this machine through a port-
#             forward); the site is deleted; a fresh one is installed with the saved Secrets
#             that hold key material (docs/backup-restore.md "Secrets"); `kobe restore`; then: every team table's row count matches the
#             source and the signed manifest, every object key the database references resolves,
#             the audit chain verifies (and contains the source's head), the grant opens with the
#             install's envelope key (and not with another), artifacts, files, the memory doc, the
#             skill bundle and the project files are the same bytes, and the restored thread
#             continues in a new sandbox with Pi's session rebuilt from Postgres
#
# Targets (KOBE_GATE4_RESTORE_TARGET):
#   k3d        (default on a k3d context; CI shard `restore`) the source is installed into this
#              cluster; after the backup the whole k3d cluster is deleted and a new one created
#              (scripts/dev-cluster.sh, e2e/load-images.sh with KOBE_IMAGE_ARCHIVES or a build); its
#              S3 fixture goes with the cluster, so the bucket's objects are copied out and into the
#              new one first (e2e/lib/s3-mirror.mjs: "a bucket that holds a copy of its objects")
#   namespace  (a real cluster) source `<ns>-src` and target `<ns>`, each its own release with its
#              own new database on an existing Postgres and the same bucket under a per-run prefix;
#              the source release, namespace and team namespaces are deleted before the target is
#              installed. Refuses while any other Kobe server runs in the cluster: every Kobe server
#              converges every team namespace of the cluster (docs/gates/gate-4.md).
# docs/gates/gate-4.md ("Backup → fresh site → restore") lists the variables and what this proves.
set -euo pipefail
cd "$(dirname "$0")/.."

KUBECTL="${KUBECTL:-kubectl}"
HELM="${HELM:-helm}"
K3D="${K3D:-k3d}"
context=$($KUBECTL config current-context)
TARGET="${KOBE_GATE4_RESTORE_TARGET:-$([[ "$context" == k3d-* ]] && echo k3d || echo namespace)}"
NS="${KOBE_GATE4_RESTORE_NS:-kobe-dev}"
RELEASE="${KOBE_GATE4_RESTORE_RELEASE:-kobe}"
CHART="${KOBE_GATE4_RESTORE_CHART:-charts/kobe}"
VALUES="${KOBE_GATE4_RESTORE_VALUES:-dev/values.yaml}"
TAG="${KOBE_IMAGE_TAG:-}"
DEPS_NS="${KOBE_GATE4_RESTORE_DEPS_NS:-kobe-deps}" # where `deploy/pg` (superuser `postgres`) runs
MODEL_ALIAS=fast
# shellcheck disable=SC2034 # read by e2e/lib/gate-turns.sh
FAKE=1 # the scripted model (e2e/gate1's fake upstream): `bash: ...`, `tool: ...`, `history?`
OWNER_EMAIL="${KOBE_GATE4_RESTORE_OWNER_EMAIL:-owner@gate4r.test}"
OWNER_PASSWORD="${KOBE_GATE4_RESTORE_OWNER_PASSWORD:-gate4 restore owner password}"
CLI="${KOBE_GATE4_RESTORE_CLI:-node packages/cli/dist/cli.js}"
SETUP_BUDGET="${KOBE_GATE4_SETUP_BUDGET:-1200}" # spec §8: clean install → first chat ≤ 20 min
SBX_WAIT="${KOBE_GATE4_RESTORE_SANDBOX_WAIT:-240}"
LLM_NS=kobe-e2e-llm
LLM="http://llm.$LLM_NS.svc.cluster.local"
TEAM_SLUG=gate4-r
TNS="kobe-team-$TEAM_SLUG"
NONCE="$(date +%s)"
failed=0

case "$TARGET" in
  k3d)
    [[ "$context" == k3d-* ]] || { echo "target k3d needs a k3d context (got '$context')" >&2; exit 2; }
    [[ -n "$TAG" ]] || { echo "set KOBE_IMAGE_TAG (the images loaded into the cluster)" >&2; exit 2; }
    CLUSTER="${context#k3d-}"
    SRC_NS=$NS
    SRC_DB=kobe TGT_DB=kobe # dev/postgres.yaml's database, on each cluster's own Postgres
    ;;
  namespace)
    [[ "$context" == "${KOBE_GATE4_RESTORE_CONTEXT:-}" ]] \
      || { echo "refusing context '$context' (set KOBE_GATE4_RESTORE_CONTEXT=$context)" >&2; exit 2; }
    [[ "$NS" != kobe-dev && -n "${KOBE_GATE4_RESTORE_NS:-}" ]] \
      || { echo "target namespace needs KOBE_GATE4_RESTORE_NS (a new namespace)" >&2; exit 2; }
    DB_SECRET="${KOBE_GATE4_RESTORE_DB_SECRET:?set KOBE_GATE4_RESTORE_DB_SECRET=<namespace>/<secret> with app-url and migrate-url}"
    SRC_NS="$NS-src"
    SRC_DB="${NS//-/_}_src" TGT_DB="${NS//-/_}"
    S3_PREFIX="gate4-restore-$NONCE/"
    ;;
  *) echo "KOBE_GATE4_RESTORE_TARGET: k3d or namespace (got '$TARGET')" >&2; exit 2 ;;
esac

# shellcheck source=lib/gate-common.sh
source e2e/lib/gate-common.sh
# shellcheck source=lib/gate-turns.sh
source e2e/lib/gate-turns.sh
# shellcheck source=gate2/sandbox.sh
source e2e/gate2/sandbox.sh

# shellcheck disable=SC2034 # read by client() in gate-common.sh
CLIENT_JS="$(for f in e2e/gate1/client.mjs e2e/gate2/client.mjs e2e/gate3/client.mjs; do sed '/^const MODES = {/,$d' "$f"; done
  cat e2e/gate4/restore.mjs)"
WORK=$(mktemp -d)
chmod 700 "$WORK"
PODS=()
UNDO=()
PF_PIDS=()
stop_forwards() {
  local p
  for p in "${PF_PIDS[@]+"${PF_PIDS[@]}"}"; do kill "$p" 2>/dev/null || true; done
  PF_PIDS=()
}
cleanup() {
  local rc=$?
  local u p
  stop_forwards
  for p in "${PODS[@]+"${PODS[@]}"}"; do $KUBECTL delete pod $p --ignore-not-found --wait=false >/dev/null 2>&1 || true; done
  for u in "${UNDO[@]+"${UNDO[@]}"}"; do eval "$u" >/dev/null 2>&1 || true; done
  rm -rf "$WORK"
  verdict_on_exit "$rc" "Gate 4 restore"
}
trap cleanup EXIT
use_site() { # namespace → NS, SERVER and BASE name that release (the client runs in its server pod)
  NS=$1
  SERVER="deploy/$RELEASE-server"
  BASE="http://$RELEASE-server.$NS.svc.cluster.local"
}
psql_super() { # database sql → rows (superuser in the Postgres pod; RLS does not apply)
  $KUBECTL -n "$DEPS_NS" exec deploy/pg -- psql -U postgres -d "$1" -XtAc "$2" 2>&1
}
url_with() { # url host port db → the URL with them swapped in (never printed)
  node -e 'const u = new URL(process.argv[1]); if (process.argv[2]) { u.hostname = process.argv[2]; u.port = process.argv[3]; } if (process.argv[4]) u.pathname = "/" + process.argv[4]; console.log(u.href)' "$@"
}
url_user() { node -e 'console.log(decodeURIComponent(new URL(process.argv[1]).username))' "$1"; }
secret_key() { # namespace secret key → its decoded value
  $KUBECTL -n "$1" get secret "$2" -o jsonpath="{.data.$3}" 2>/dev/null | base64 -d 2>/dev/null || true
}
PF_PORT=""
port_forward() { # namespace target remote-port → PF_PORT, a local port forwarded to it (in the background)
  local log
  PF_PORT=$((20000 + RANDOM % 20000))
  log="$WORK/pf-$PF_PORT.log"
  $KUBECTL -n "$1" port-forward "$2" "$PF_PORT:$3" >"$log" 2>&1 &
  PF_PIDS+=($!)
  if ! until_ok 30 grep -q 'Forwarding from' "$log"; then
    echo "port-forward to $1/$2 did not start: $(tail -2 "$log")" >&2
    return 1
  fi
}
writers() { # scale replicas: the server and the scheduler of the release in NS
  $KUBECTL -n "$NS" scale "deploy/$RELEASE-server" "deploy/$RELEASE-scheduler" --replicas="$1" >/dev/null
}
replicas_of() { $KUBECTL -n "$NS" get "deploy/$RELEASE-$1" -o jsonpath='{.spec.replicas}'; }
writers_gone() {
  [[ -z "$($KUBECTL -n "$NS" get pods -l 'app.kubernetes.io/component in (server,scheduler)' -o name 2>/dev/null)" ]]
}

# Every team table (team_id NOT NULL, row-level security) and its row count, one `name=n` per line,
# except the tables a backup leaves out by design (packages/cli/src/excluded.ts).
TEAM_COUNTS_SQL="SELECT c.relname || '=' || (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM public.%I', c.relname), false, true, '')))[1]::text
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relrowsecurity
   AND c.relname NOT IN ('sessions', 'session_active_teams', 'verifications', 'jwks', 'rate_limits')
   AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'team_id' AND a.attnotnull AND NOT a.attisdropped)
 ORDER BY 1"

if [[ "$TARGET" == namespace ]]; then
  others=$($KUBECTL get deploy -A -l 'app.kubernetes.io/component=server' \
    -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name} {.spec.replicas}{"\n"}{end}' 2>/dev/null \
    | awk -v a="$SRC_NS" -v b="$NS" '{ split($1, p, "/") } p[1] != a && p[1] != b && $2 > 0 { print $1 }')
  if [[ -n "$others" ]]; then
    echo "refusing: other Kobe servers run in this cluster ($(tr '\n' ' ' <<<"$others")). Every Kobe server converges" >&2
    echo "every team namespace of the cluster, so a second site would rewrite their sandbox policies. Scale them to 0 first." >&2
    exit 2
  fi
  DB_SECRET_NS=${DB_SECRET%%/*} DB_SECRET_NAME=${DB_SECRET#*/}
  BASE_APP_URL=$(secret_key "$DB_SECRET_NS" "$DB_SECRET_NAME" app-url)
  BASE_MIGRATE_URL=$(secret_key "$DB_SECRET_NS" "$DB_SECRET_NAME" migrate-url)
  [[ -n "$BASE_APP_URL" && -n "$BASE_MIGRATE_URL" ]] || { echo "no app-url/migrate-url in $DB_SECRET" >&2; exit 2; }
fi
[[ -f packages/cli/dist/cli.js || -n "${KOBE_GATE4_RESTORE_CLI:-}" ]] \
  || { echo "the kobe CLI is not built: pnpm --filter @kobe/cli... build" >&2; exit 2; }

# ---- a site: Postgres database, Secrets, the chart ---------------------------------------------------
LLM_RULE=$(printf '[{"to":[{"namespaceSelector":{"matchLabels":{"kubernetes.io/metadata.name":"%s"}}}],"ports":[{"protocol":"TCP","port":8080}]}]' "$LLM_NS")
site_database() { # namespace database → the namespace, its database and the Secret `<release>-gate4-db`
  local ns=$1 db=$2 owner
  if [[ "$TARGET" == k3d ]]; then
    $KUBECTL apply -f dev/postgres.yaml >/dev/null
    $KUBECTL -n "$DEPS_NS" rollout status deploy/pg --timeout=180s >/dev/null
    $KUBECTL apply -f dev/mailpit.yaml >/dev/null
    $KUBECTL apply -f dev/s3.yaml >/dev/null
    $KUBECTL -n "$DEPS_NS" rollout status deploy/s3 --timeout=300s >/dev/null
    DB_SECRET_OF_SITE=kobe-dev-db
    return
  fi
  $KUBECTL create namespace "$ns" --dry-run=client -o yaml | $KUBECTL apply -f - >/dev/null
  owner=$(url_user "$BASE_MIGRATE_URL")
  psql_super postgres "CREATE DATABASE \"$db\" OWNER \"$owner\"" >/dev/null
  UNDO+=("psql_super postgres 'DROP DATABASE IF EXISTS \"$db\" WITH (FORCE)'")
  $KUBECTL -n "$ns" create secret generic "$RELEASE-gate4-db" \
    --from-literal=app-url="$(url_with "$BASE_APP_URL" "" "" "$db")" \
    --from-literal=migrate-url="$(url_with "$BASE_MIGRATE_URL" "" "" "$db")" >/dev/null
  DB_SECRET_OF_SITE="$RELEASE-gate4-db"
  copy_secrets "$ns"
}
copy_secrets() { # namespace → copies of the Secrets the values file names (KOBE_GATE4_RESTORE_COPY_SECRETS)
  local ref
  for ref in ${KOBE_GATE4_RESTORE_COPY_SECRETS:-}; do
    $KUBECTL -n "${ref%%/*}" get secret "${ref#*/}" -o json \
      | node -e 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
          const x = JSON.parse(s);
          x.metadata = { name: x.metadata.name, namespace: process.argv[1] };
          console.log(JSON.stringify(x));
        })' "$1" | $KUBECTL apply -f - >/dev/null
  done
}
SITE_ARGS=() # the target's extra helm arguments (its restored Secrets), for its migration Job too
# The chart's generated Secrets and the values key that reuses each (docs/backup-restore.md
# "Secrets"; charts/kobe/tests/backup-secrets.test.ts keeps that table complete). The bundled
# database's credentials are this harness's own (dev/postgres.yaml or the namespace's database).
KEPT_SECRETS=(
  auth:auth.existingSecret envelope-key:envelope.keySecret model-keys:bifrost.keysSecret
  egress-headers:egressProxy.headerSecret sandbox-session-keys:sandbox.sessionKeysSecret
  mcp-proxy-internal:mcpProxy.internalKeySecret
)
chart_args() { # → the helm arguments every site installs with (after -n <namespace>)
  local extra=()
  [[ -n "$TAG" ]] && extra+=(--set "global.imageTag=$TAG" --set global.imagePullPolicy=IfNotPresent)
  if [[ "$TARGET" == namespace ]]; then
    extra+=(--set "postgres.external.existingSecret=$DB_SECRET_OF_SITE" --set "s3.prefix=$S3_PREFIX")
    [[ -n "${KOBE_GATE4_RESTORE_HOST:-}" ]] && extra+=(--set "ingress.host=$KOBE_GATE4_RESTORE_HOST")
  fi
  # Bifrost may reach the fake model upstream (a private address), as e2e/run.sh allows it.
  printf '%s\n' -f "$VALUES" "${extra[@]}" --set-json "bifrost.networkPolicy.extraEgress=$LLM_RULE" \
    --set bifrost.allowUnsafeProviderEndpoints=true "${SITE_ARGS[@]+"${SITE_ARGS[@]}"}"
}
helm_install() { # namespace → installs the release there and waits
  local args=()
  mapfile -t args < <(chart_args)
  $HELM upgrade --install "$RELEASE" "$CHART" -n "$1" "${args[@]}" --wait --timeout 10m
}
# An empty database migrated by the chart's own migration Job (rendered with the site's values),
# with the server never started: what a restore needs when the server's start leaves rows behind.
migrated_empty_db() { # → 0 when the target's database is new and migrated
  local args=() owner job
  mapfile -t args < <(chart_args)
  owner=$(url_user "$(secret_key "$NS" "$DB_SECRET_OF_SITE" migrate-url)")
  psql_super postgres "DROP DATABASE IF EXISTS \"$TGT_DB\" WITH (FORCE)" >/dev/null
  psql_super postgres "CREATE DATABASE \"$TGT_DB\" OWNER \"$owner\"" >/dev/null
  $HELM template "$RELEASE" "$CHART" -n "$NS" "${args[@]}" --dry-run=server --show-only templates/migrate-job.yaml \
    >"$WORK/migrate-job.yaml" || return 1
  job=$(sed -n 's/^  name: //p' "$WORK/migrate-job.yaml" | head -1)
  $KUBECTL -n "$NS" delete job "$job" --ignore-not-found --wait=true >/dev/null 2>&1 || true
  $KUBECTL -n "$NS" apply -f "$WORK/migrate-job.yaml" >/dev/null || return 1
  $KUBECTL -n "$NS" wait --for=condition=complete "job/$job" --timeout=600s >/dev/null || return 1
  $KUBECTL -n "$NS" delete job "$job" --wait=false >/dev/null 2>&1 || true
}

# ---- install: the source site, timed to the first assistant token ------------------------------------
echo "==> install: a clean install of the chart, timed from helm install to the first assistant token"
site_database "$SRC_NS" "$SRC_DB"
use_site "$SRC_NS"
install_start=$(date +%s)
if out=$(helm_install "$SRC_NS" 2>&1); then ok "helm install of the source site ($(($(date +%s) - install_start)) s)"
else
  fail "helm install of the source site: $(tail -5 <<<"$out")"
  exit 1
fi
ensure_fake_llm
setup_token=$(secret_key "$NS" "$RELEASE-auth" setup-token)
user_json() { # key ip-suffix → fixture JSON
  printf '{"key":"%s","email":"gate4r-%s@gate4r.test","name":"Gate4r %s","team":"a","ip":"198.51.100.%s"}' "$1" "$1" "$1" "$2"
}
OWNER_JSON=$(printf '{"email":"%s","password":"%s"}' "$OWNER_EMAIL" "$OWNER_PASSWORD")
fx=$(client "$(printf '{"mode":"fixtures","base":"%s","modelAlias":"%s","owner":%s,"setupToken":"%s","users":[%s,%s],"teams":[{"key":"a","slug":"%s","name":"Gate 4 restore"}]}' \
  "$BASE" "$MODEL_ALIAS" "$OWNER_JSON" "$setup_token" "$(user_json ad 81)" "$(user_json m1 82)" "$TEAM_SLUG")")
printf '%s\n' "$fx" | sed 's/^/     /'
contains "first-run setup creates the Owner with the setup token" '^setup=20[01]$' "$fx"
fixtures=$(field fixtures "$fx")
json_get() { printf '%s' "$fixtures" | sed -n "s/.*\"$1\":\"\([0-9a-f-]*\)\".*/\1/p"; }
TEAM=$(json_get a)
AD=$(json_get ad)
M1=$(json_get m1)
if [[ ! "$TEAM $AD $M1" =~ ^([0-9a-f-]{36}\ ){2}[0-9a-f-]{36}$ ]]; then
  fail "fixtures: a team with an admin and a member"
  exit 1
fi
ok "fixtures: a team with an admin and a member"
U_AD=$(printf '{"key":"ad","email":"gate4r-ad@gate4r.test","ip":"198.51.100.81","teamId":"%s","userId":"%s"}' "$TEAM" "$AD")
U_M1=$(printf '{"key":"m1","email":"gate4r-m1@gate4r.test","ip":"198.51.100.82","teamId":"%s","userId":"%s"}' "$TEAM" "$M1")
step() { client "$(printf '{"mode":"%s","base":"%s","owner":%s,%s}' "$1" "$BASE" "$OWNER_JSON" "$2")"; }
md=$(step models "\"alias\":\"$MODEL_ALIAS\",\"llm\":\"$LLM\",\"providerKey\":\"gate4r-provider-key-$NONCE\"")
show "models" "$md"
contains "the Owner adds a provider and the '$MODEL_ALIAS' catalog entry" '^(catalog=201|models=present)' "$md"
fx2=$(client "$(printf '{"mode":"fixtures","base":"%s","modelAlias":"%s","owner":%s,"setupToken":"%s","users":[%s,%s],"teams":[{"key":"a","slug":"%s","name":"Gate 4 restore"}]}' \
  "$BASE" "$MODEL_ALIAS" "$OWNER_JSON" "$setup_token" "$(user_json ad 81)" "$(user_json m1 82)" "$TEAM_SLUG")")
contains "the team admin enables it as the team's default" '^models_a=200$' "$fx2"
gateway_synced() { [[ "$(psql_super "$SRC_DB" "SELECT synced_version >= desired_version AND last_error IS NULL FROM model_gateway_state")" == t ]]; }
if until_ok 120 gateway_synced; then ok "Bifrost has the configuration (gateway in sync)"; else fail "Bifrost has the configuration (gateway in sync)"; fi
first=$(client "$(printf '{"mode":"first-token","base":"%s","user":%s,"title":"gate4r first chat","content":"gate4 restore hello %s","timeoutMs":600000}' "$BASE" "$U_M1" "$NONCE")")
show "first chat" "$first"
T_DATA=$(field thread "$first")
first_at=$(field first_token_at "$first")
contains "the member's first chat completes (a new sandbox under gVisor)" '^terminal=run.completed$' "$first"
if [[ "$first_at" =~ ^[0-9]{13}$ ]]; then
  took=$((first_at / 1000 - install_start))
  echo "     helm install → first assistant token: ${took} s (budget ${SETUP_BUDGET} s)"
  if ((took <= SETUP_BUDGET)); then ok "helm install → first assistant token in ${took} s (≤ ${SETUP_BUDGET} s)"
  else fail "helm install → first assistant token in ${took} s (> ${SETUP_BUDGET} s)"; fi
else
  fail "the first chat produced an assistant token (got [$first_at])"
fi

# ---- restore: what the source site holds -------------------------------------------------------------
claim_uid() { $KUBECTL -n "$TNS" get sandboxclaim "u-$M1" -o jsonpath='{.metadata.uid}' 2>/dev/null || true; }
sbx_pod() {
  $KUBECTL -n "$TNS" get pods -l "agents.x-k8s.io/claim-uid=$(claim_uid)" --field-selector=status.phase=Running \
    -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null | head -1
}
in_sbx() { # shell command → its output in m1's sandbox (agent container)
  local pod
  pod=$(sbx_pod)
  if [[ -z "$pod" ]]; then echo "in_sbx: m1's sandbox has no Running pod"; return 0; fi
  $KUBECTL -n "$TNS" exec "$pod" -c agent -- sh -c "$1" 2>&1 || true
}
# shellcheck disable=SC2034 # T2 and SBX_WHO name the user for e2e/gate2/sandbox.sh
T2=$M1 SBX_WHO=m1
echo "==> restore: the source site gets threads, files, a skill, memory, a project and a connector grant"
sbx_await "$SBX_WAIT" "seeding" || true
contains "the team's memory switches are on" '^memory_settings=200:' "$(step memory-settings "\"admin\":$U_AD")"
MEM_PATH="notes/gate4r-$NONCE.md"
MEM_TEXT="gate4 restore memory $NONCE"
mem=$(turn "$U_M1" "$(tool_prompt remember "$(printf '{"scope":"user","path":"%s","content":"%s","mode":"replace"}' "$MEM_PATH" "$MEM_TEXT")")" '"title":"gate4r memory"')
show "remember" "$mem"
contains "a memory doc is written (memory.updated)" "^memory_events=user:[0-9a-f-]{36}:$MEM_PATH:v1:none\$" "$mem"
DOC=$(field memory_events "$mem" | cut -d: -f2)
PROJECT_TEXT="gate4 restore project brief $NONCE"
pr=$(step project-setup "\"admin\":$U_AD,\"name\":\"Gate4r project $NONCE\",\"members\":[\"$M1\"],\"fileText\":\"$PROJECT_TEXT\"")
show "project" "$pr"
PROJECT=$(field project_id "$pr")
SLUG=$(field project_slug "$pr")
contains "a project with a file" '^project_file=201:docs/brief.txt$' "$pr"
sk=$(step skill-upload "\"user\":$U_AD,\"scope\":\"team\",\"name\":\"g4rskill-$NONCE\",\"description\":\"Gate4 restore skill $NONCE\",\"url\":\"https://example.com/gate4r-$NONCE\"")
show "skill" "$sk"
SKILL_ID=$(field skill_id "$sk")
SKILL_HASH=$(field content_hash "$sk")
contains "a team skill is uploaded (201)" '^skill_upload=201:-$' "$sk"
CSV=$'region,amount\nnorth,120.5\nsouth,80\n'
up=$(step upload "\"user\":$U_M1,\"threadId\":\"$T_DATA\",\"name\":\"sales.csv\",\"text\":$(json_str "$CSV")")
show "upload" "$up"
UPLOAD=$(field file_id "$up")
contains "a CSV is uploaded into the thread (in S3)" "^object=present:${#CSV}\$" "$up"
html="<!doctype html><html><head><title>Gate 4 restore $NONCE</title></head><body><h1>Restored $NONCE</h1></body></html>"
art=$(turn "$U_M1" "$(tool_prompt create_artifact "$(printf '{"kind":"html","title":"Gate 4 restore %s","content":%s}' "$NONCE" "$(json_str "$html")")")" "\"threadId\":\"$T_DATA\"")
show "artifact" "$art"
contains "the agent makes an HTML artifact (artifact.created)" '^artifact_events=artifact.created:[0-9a-f-]{36}:v1$' "$art"
ARTIFACT=$(field artifact_events "$art" | cut -d: -f2)
REPORT="gate4r-report-$NONCE.csv"
# The message carries the upload (fileIds), which puts it at /workspace/uploads/<thread>/ (U3).
cp_turn=$(turn "$U_M1" "$(bash_prompt "cp /workspace/uploads/$T_DATA/sales.csv /workspace/$REPORT && echo copied")" "\"threadId\":\"$T_DATA\",\"fileIds\":[\"$UPLOAD\"]")
contains "the agent copies the CSV into its workspace" '^tool_output=.*"preview":"copied' "$cp_turn"
sf=$(turn "$U_M1" "$(tool_prompt share_file "$(printf '{"path":"%s","description":"Gate 4 restore report"}' "$REPORT")")" "\"threadId\":\"$T_DATA\"")
show "share_file" "$sf"
contains "the agent shares it (file.shared)" "^file_events=[0-9a-f-]{36}:$REPORT:${#CSV}\$" "$sf"
SHARED=$(field file_events "$sf" | cut -d: -f1)
ws_synced() { [[ "$(psql_super "$SRC_DB" "SELECT count(*) FROM workspace_files WHERE team_id = '$TEAM' AND user_id = '$M1' AND path = '$REPORT' AND NOT deleted")" == 1 ]]; }
if until_ok 90 ws_synced; then ok "the workspace file is synced to S3 (workspace_files)"; else fail "the workspace file is synced to S3 (workspace_files)"; fi
CONNECTOR_ID=$(node -e 'console.log(require("node:crypto").randomUUID())')
API_KEY="gate4r-api-key-$NONCE-$(od -An -tx1 -N8 /dev/urandom | tr -d ' \n')"
API_KEY_SHA=$(node -e 'console.log(require("node:crypto").createHash("sha256").update(process.argv[1]).digest("hex"))' "$API_KEY")
contains "the member stores an API key for a connector (sealed grant)" '^grant=20[01]:' \
  "$(step connector "\"user\":$U_M1,\"connectorId\":\"$CONNECTOR_ID\",\"name\":\"gate4r-$NONCE\",\"url\":\"http://gate4r.invalid/mcp\",\"apiKey\":\"$API_KEY\"")"

snapshot() { # → the evidence a restore must reproduce, as key=value lines
  step state "\"user\":$U_M1,\"threadId\":\"$T_DATA\",\"artifacts\":[\"$ARTIFACT\"],\"files\":[\"$SHARED\"],\"uploads\":[\"$UPLOAD\"]"
  step memory-doc "\"user\":$U_M1,\"docId\":\"$DOC\"" | grep '^doc_content='
  step project-files "\"user\":$U_M1,\"projectId\":\"$PROJECT\""
  step skill-bundle "\"user\":$U_AD,\"skillId\":\"$SKILL_ID\",\"version\":1"
  step grant-open "\"user\":$U_M1,\"connectorId\":\"$CONNECTOR_ID\""
}
before=$(snapshot)
show "before" "$(grep -v '^entries=' <<<"$before")"
contains "the source thread has history (entries)" '^entries=[^,-][^,]*,[^,]+' "$before"
contains "the skill bundle is served (its bytes hash to the recorded content hash)" "^bundle=200:$SKILL_HASH\$" "$before"
contains "the grant opens with the source's envelope key" "^grant_sha=$API_KEY_SHA\$" "$before"
src_integrity=$(step integrity '"check":1')
show "audit chain (source)" "$src_integrity"
contains "the source's audit chain verifies" '^integrity=200:ok=true:' "$src_integrity"
SRC_HEAD=$(field head "$src_integrity")

# ---- restore: kobe backup ------------------------------------------------------------------------------
echo "==> restore: the source's writers stop; kobe backup (Postgres + the object listing, encrypted and signed)"
SERVER_REPLICAS=$(replicas_of server)
SCHEDULER_REPLICAS=$(replicas_of scheduler)
umask 077
# Every Secret of docs/backup-restore.md's "Secrets" table (KOBE-425), saved whole (its data only),
# as the docs say: the backup never holds them.
saved=""
for kept in "${KEPT_SECRETS[@]}"; do
  s=${kept%%:*}
  $KUBECTL -n "$NS" get secret "$RELEASE-$s" -o json 2>/dev/null \
    | node -e 'let t="";process.stdin.on("data",(c)=>(t+=c)).on("end",()=>{const j=JSON.parse(t);if(!j.data||!Object.keys(j.data).length)process.exit(1);console.log(JSON.stringify({apiVersion:"v1",kind:"Secret",type:j.type,data:j.data}))})' \
      >"$WORK/secret-$s.json" && saved+="$s "
done
contains "the Secrets holding key material are saved (the backup never holds them)" "^${KEPT_SECRETS[*]%%:*} \$" "$saved"
writers 0
if until_ok 120 writers_gone; then ok "server and scheduler stopped"; else fail "server and scheduler stopped"; fi
psql_super "$SRC_DB" "$TEAM_COUNTS_SQL" >"$WORK/counts-source"
contains "the source has team rows to back up" '^thread_entries=[1-9]' "$(cat "$WORK/counts-source")"
openssl rand -base64 32 >"$WORK/backup.key"
BACKUP_PW=$(od -An -tx1 -N16 /dev/urandom | tr -d ' \n')
psql_super "$SRC_DB" "DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kobe_gate4_backup') THEN
    CREATE ROLE kobe_gate4_backup LOGIN NOSUPERUSER BYPASSRLS IN ROLE pg_read_all_data;
  END IF;
  ALTER ROLE kobe_gate4_backup PASSWORD '$BACKUP_PW';
END \$\$" >/dev/null
[[ "$TARGET" == namespace ]] && UNDO+=("psql_super postgres 'DROP ROLE IF EXISTS kobe_gate4_backup'")
port_forward "$DEPS_NS" deploy/pg 5432
pg_port=$PF_PORT
s3_env=()
if [[ "$TARGET" == k3d ]]; then
  port_forward "$DEPS_NS" deploy/s3 8333
  s3_port=$PF_PORT
  s3_env=(KOBE_S3_ENDPOINT="http://127.0.0.1:$s3_port" KOBE_S3_BUCKET=kobe KOBE_S3_ACCESS_KEY_ID=dev KOBE_S3_SECRET_ACCESS_KEY=dev)
else
  # KOBE_S3_ENDPOINT, _BUCKET, _REGION, _ACCESS_KEY_ID, _SECRET_ACCESS_KEY come from the caller's environment.
  s3_env=("KOBE_S3_PREFIX=$S3_PREFIX")
fi
BACKUP_DIR="$WORK/backup-$NONCE"
backup_out=$(env KOBE_BACKUP_KEY_FILE="$WORK/backup.key" \
  KOBE_BACKUP_DATABASE_URL="postgres://kobe_gate4_backup:$BACKUP_PW@127.0.0.1:$pg_port/$SRC_DB" \
  "${s3_env[@]}" $CLI backup --out "$BACKUP_DIR" 2>&1) || true
sed 's/^/     /' <<<"$backup_out"
contains "kobe backup writes an encrypted, signed backup" 'manifest fingerprint sha256:[0-9a-f]{64}' "$backup_out"
FINGERPRINT=$(sed -nE 's/.*manifest fingerprint (sha256:[0-9a-f]{64}).*/\1/p' <<<"$backup_out" | head -1)
contains "...with its files (dump, object listing, manifest, signature)" '^database.dump.enc manifest.json manifest.json.sig objects.jsonl.enc $' \
  "$(ls "$BACKUP_DIR" 2>/dev/null | sort | tr '\n' ' ')"
manifest_rows() { # → name=rows of every table in the signed manifest
  node -e 'const m = require(process.argv[1]); for (const t of m.tables) console.log(`${t.name}=${t.rows}`)' "$BACKUP_DIR/manifest.json" 2>/dev/null | sort
}
manifest_rows >"$WORK/counts-manifest"
stop_forwards
if [[ "$TARGET" == k3d ]]; then
  # The cluster's S3 fixture goes with it: copy the objects out (the writers are stopped).
  server_image=$($KUBECTL -n "$NS" get "$SERVER" -o jsonpath='{.spec.template.spec.containers[?(@.name=="server")].image}')
  s3_pod() { # name → a pod with the server image and the k3d S3 fixture's settings
    $KUBECTL -n "$NS" run "$1" --restart=Never --image="$server_image" --image-pull-policy=IfNotPresent \
      --env=KOBE_S3_ENDPOINT=http://s3.kobe-deps.svc.cluster.local:8333 --env=KOBE_S3_BUCKET=kobe \
      --env=KOBE_S3_ACCESS_KEY_ID=dev --env=KOBE_S3_SECRET_ACCESS_KEY=dev --command -- sleep 900 >/dev/null
    PODS+=("-n $NS $1")
    $KUBECTL -n "$NS" wait --for=condition=Ready "pod/$1" --timeout=120s >/dev/null
  }
  s3_pod "gate4r-s3-out-$NONCE"
  $KUBECTL -n "$NS" exec "gate4r-s3-out-$NONCE" -- node --input-type=module -e "$(cat e2e/lib/s3-mirror.mjs)" export \
    >"$WORK/objects.lines" 2>"$WORK/objects.err" || true
  contains "the bucket's objects are copied out ($(grep -c '^obj ' "$WORK/objects.lines" || true) objects)" '^exported objects=[1-9]' "$(cat "$WORK/objects.err")"
fi

# ---- restore: the old site is gone; a fresh one ----------------------------------------------------------
echo "==> restore: the source site is deleted; a fresh site is installed with the saved Secrets"
if [[ "$TARGET" == k3d ]]; then
  $K3D cluster delete "$CLUSTER" >/dev/null 2>&1 || true
  t0=$SECONDS
  if out=$(scripts/dev-cluster.sh 2>&1); then ok "a new k3d cluster with gVisor and agent-sandbox ($((SECONDS - t0)) s)"
  else fail "a new k3d cluster: $(tail -5 <<<"$out")"; exit 1; fi
  CLUSTER_SECONDS=$((SECONDS - t0))
  if out=$(e2e/load-images.sh "$CLUSTER" "$TAG" 2>&1); then ok "the images are loaded into it"
  else fail "the images are loaded into it: $(tail -5 <<<"$out")"; exit 1; fi
  contains "the new cluster has no Kobe namespaces" '^none$' \
    "$($KUBECTL get namespaces -o name | grep -E "namespace/($NS|$TNS)$" || echo none)"
else
  $HELM uninstall "$RELEASE" -n "$SRC_NS" --wait >/dev/null 2>&1 || true
  $KUBECTL delete namespace "$SRC_NS" --wait=true --timeout=300s >/dev/null 2>&1 || true
  $KUBECTL delete namespace -l "kobe.splittingatom.io/team-id=$TEAM" --wait=true --timeout=300s >/dev/null 2>&1 || true
  $KUBECTL delete namespace "$TNS" --ignore-not-found --wait=true --timeout=300s >/dev/null 2>&1 || true
  contains "the source release, its namespace and its team namespace are gone" '^none$' \
    "$($KUBECTL get namespaces -o name | grep -E "namespace/($SRC_NS|$TNS)$" || echo none)"
fi
site_database "$NS" "$TGT_DB"
use_site "$NS"
$KUBECTL create namespace "$NS" --dry-run=client -o yaml | $KUBECTL apply -f - >/dev/null
# docs/backup-restore.md "Restore onto a fresh cluster", steps 1-2: each Secret under a new name,
# its values key pointing at it.
SITE_ARGS=()
for kept in "${KEPT_SECRETS[@]}"; do
  s=${kept%%:*}
  node -e 'const j=require(process.argv[1]);j.metadata={name:process.argv[2]};console.log(JSON.stringify(j))' \
    "$WORK/secret-$s.json" "$RELEASE-$s-restored" | $KUBECTL -n "$NS" apply -f - >/dev/null
  SITE_ARGS+=(--set "${kept#*:}=$RELEASE-$s-restored")
done
# The session tokens' public keys go with their Secret (KOBE-513): a ConfigMap of its `.pub` entries.
node -e 'const j=require(process.argv[1]);const d={};for(const [k,v] of Object.entries(j.data))if(k.endsWith(".pub"))d[k.slice(0,-4)]=Buffer.from(v,"base64").toString();console.log(JSON.stringify({apiVersion:"v1",kind:"ConfigMap",metadata:{name:process.argv[2]},data:d}))' \
  "$WORK/secret-sandbox-session-keys.json" "$RELEASE-sandbox-session-verify-keys-restored" \
  | $KUBECTL -n "$NS" apply -f - >/dev/null
SITE_ARGS+=(--set "sandbox.sessionVerifyKeysConfigMap=$RELEASE-sandbox-session-verify-keys-restored")
if out=$(helm_install "$NS" 2>&1); then ok "the fresh site is installed (its key-material Secrets restored)"
else
  fail "the fresh site is installed: $(tail -5 <<<"$out")"
  exit 1
fi
ensure_fake_llm
contains "the fresh site is empty (no users)" '^0$' "$(psql_super "$TGT_DB" 'SELECT count(*) FROM users')"
if [[ "$TARGET" == k3d ]]; then
  s3_pod "gate4r-s3-in-$NONCE"
  imported=$($KUBECTL -n "$NS" exec -i "gate4r-s3-in-$NONCE" -- node --input-type=module -e "$(cat e2e/lib/s3-mirror.mjs)" import \
    <"$WORK/objects.lines" 2>&1 || true)
  contains "the new bucket holds a copy of the objects (same keys, sizes and ETags)" \
    "^objects=$(grep -c '^obj ' "$WORK/objects.lines" || true) bytes=[0-9]+ etag_mismatch=0\$" "$imported"
fi

# ---- restore: kobe restore ---------------------------------------------------------------------------------
echo "==> restore: kobe restore into the fresh site (as the owner role, writers stopped)"
writers 0
until_ok 120 writers_gone || true
port_forward "$DEPS_NS" deploy/pg 5432
pg_port=$PF_PORT
if [[ "$TARGET" == k3d ]]; then
  port_forward "$DEPS_NS" deploy/s3 8333
  s3_env=(KOBE_S3_ENDPOINT="http://127.0.0.1:$PF_PORT" KOBE_S3_BUCKET=kobe KOBE_S3_ACCESS_KEY_ID=dev KOBE_S3_SECRET_ACCESS_KEY=dev)
fi
migrate_url=$(url_with "$(secret_key "$NS" "$DB_SECRET_OF_SITE" migrate-url)" 127.0.0.1 "$pg_port" "")
mkdir -p "$WORK/tmp"
head_args=()
[[ "$SRC_HEAD" =~ ^[0-9]+:[0-9a-f]{64}$ ]] && head_args=(--expect-audit-head "$SRC_HEAD")
kobe_restore() { # → the CLI's output (docs/backup-restore.md "Restore onto a fresh cluster", step 4)
  env KOBE_BACKUP_KEY_FILE="$WORK/backup.key" KOBE_DB_MIGRATE_URL="$migrate_url" KOBE_TMPDIR="$WORK/tmp" \
    "${s3_env[@]}" $CLI restore --from "$BACKUP_DIR" --operator gate4-restore ${head_args[@]+"${head_args[@]}"} 2>&1 || true
}
restore_out=$(kobe_restore)
sed 's/^/     /' <<<"$restore_out"
# The server's start seeds the gallery agents (with their audit events) and the jobs' bookkeeping;
# the restore replaces those rows (KOBE-422, @kobe/db STARTUP_SEEDED_ROWS) and refuses anything else.
contains "kobe restore accepts the freshly installed site once its writers are stopped (docs steps 2-4)" \
  "restored backup ${FINGERPRINT:-none}" "$restore_out"
if ! grep -q "restored backup ${FINGERPRINT:-none}" <<<"$restore_out"; then
  # Only after a FAIL above: the later checks still run against a real restore.
  echo "     restoring instead into a new, empty database that the chart's own migration Job migrated (the server never started)"
  if migrated_empty_db; then ok "the target's database is new and migrated by the chart's migration Job"
  else fail "the target's database is new and migrated by the chart's migration Job"; fi
  restore_out=$(kobe_restore)
  sed 's/^/     /' <<<"$restore_out"
fi
stop_forwards
contains "kobe restore loads the backup it was given (same fingerprint)" "restored backup ${FINGERPRINT:-none}" "$restore_out"
contains "...with every S3 object present and unchanged" 'S3 objects checked: [1-9][0-9]*, problems: 0' "$restore_out"
contains "...the audit chain verified, containing the source's head (--expect-audit-head)" 'audit chain verified; head [0-9]+:[0-9a-f]{64}' "$restore_out"
psql_super "$TGT_DB" "$TEAM_COUNTS_SQL" >"$WORK/counts-target"
diffs=$(diff "$WORK/counts-source" "$WORK/counts-target" | grep '^[<>]' | tr '\n' ' ' || true)
tables=$(grep -c . "$WORK/counts-target" || true)
rows=$(awk -F= '{ n += $2 } END { print n + 0 }' "$WORK/counts-target")
contains "every team table's row count matches the source ($tables tables, $rows rows)" '^$' "$diffs"
mdiffs=$(join -t= "$WORK/counts-target" "$WORK/counts-manifest" | awk -F= '$2 != $3 { print $1 ": " $2 " restored, " $3 " in the manifest" }' | tr '\n' ' ')
contains "...and the signed manifest's counts" '^$' "$mdiffs"
contains "the restore is in the audit log (platform.restore.completed)" '^1$' \
  "$(psql_super "$TGT_DB" "SELECT count(*) FROM audit_log WHERE action = 'platform.restore.completed'")"
back_at=$(psql_super "$TGT_DB" "SELECT now()::text")
$KUBECTL -n "$NS" scale "deploy/$RELEASE-server" --replicas="${SERVER_REPLICAS:-2}" >/dev/null
$KUBECTL -n "$NS" scale "deploy/$RELEASE-scheduler" --replicas="${SCHEDULER_REPLICAS:-1}" >/dev/null
if $KUBECTL -n "$NS" rollout status "$SERVER" --timeout=300s >/dev/null 2>&1; then ok "the restored site's server is back"
else fail "the restored site's server is back"; fi
# The fresh site's Bifrost knows nothing of the restored providers, catalog and team keys: the
# server's gateway sync (a full pass when a replica becomes its leader, KOBE-40) must push them
# before a run can reach a model. `model_gateway_state` came back with the source's progress.
gateway_state() { psql_super "$TGT_DB" "SELECT desired_version || ':' || synced_version || ':' || coalesce(last_synced_at::text, '-') || ':' || coalesce(last_error, '-') FROM model_gateway_state"; }
echo "     model gateway state after the restore (desired:synced:last synced:last error): $(gateway_state)"
gateway_pushed() { [[ "$(psql_super "$TGT_DB" "SELECT last_synced_at > '$back_at'::timestamptz AND last_error IS NULL FROM model_gateway_state")" == t ]]; }
if until_ok 180 gateway_pushed; then ok "the restored site's server syncs the gateway (a pass since it started)"
else
  fail "the restored site's server syncs the gateway (a pass since it started; state: $(gateway_state))"
  $KUBECTL -n "$NS" logs -l app.kubernetes.io/component=server -c server --since=10m --tail=-1 2>/dev/null \
    | grep -E 'model gateway' | tail -5 | cut -c1-300 | sed 's/^/     server: /' || true
fi
echo "     m1's sandbox row after the restore: $(psql_super "$TGT_DB" "SELECT state FROM sandboxes WHERE team_id = '$TEAM' AND user_id = '$M1'")"

# ---- restore: the restored site ---------------------------------------------------------------------------
echo "==> restore: the restored site has the same data, the grant opens, the thread continues"
after=$(snapshot)
show "after" "$(grep -v '^entries=' <<<"$after")"
missing=$(comm -23 <(field entries "$before" | tr ',' '\n' | sort) <(field entries "$after" | tr ',' '\n' | sort) | grep -c . || true)
contains "the users sign in again with their passwords; the thread has every entry" '^0 [1-9]' "$missing $(field thread_get "$after")"
contains "the artifacts are the same" "^artifacts=$(field artifacts "$before")\$" "$after"
# Uploads are private to their uploader and not served by /v1/files (routes/files.ts): the upload's
# object is checked in the bucket below; the shared file's bytes here.
for k in "artifact_content $ARTIFACT" "file_content $SHARED"; do
  contains "...$k: the same bytes" "^$k=$(sed -n "s/^$k=//p" <<<"$before" | grep '^200:')\$" "$after"
done
contains "the upload's object is in the bucket" "^upload_object $UPLOAD=present:${#CSV}\$" "$after"
contains "the memory doc has the same content" "^doc_content=$MEM_TEXT\$" "$after"
contains "the project's files are the same" "^project_files=$(field project_files "$before" | sed 's/[.]/[.]/g')\$" "$after"
contains "the skill bundle is the same bytes" "^bundle=200:$SKILL_HASH\$" "$after"
contains "the connector grant opens with the restored envelope key" "^grant_sha=$API_KEY_SHA\$" "$after"
contains "...and not with another key" '^wrong_key=refused$' "$after"
tgt_integrity=$(step integrity '"check":1')
show "audit chain (restored)" "$tgt_integrity"
contains "the restored audit chain verifies (GET /v1/site/audit/integrity)" '^integrity=200:ok=true:' "$tgt_integrity"
src_seq=${SRC_HEAD%%:*}
tgt_seq=$(field head "$tgt_integrity" | cut -d: -f1)
src_seq=${src_seq//[^0-9]/} tgt_seq=${tgt_seq//[^0-9]/}
contains "...past the source's head (seq ${src_seq:-none} → ${tgt_seq:-none})" '^[1-9]' "$((${tgt_seq:-0} - ${src_seq:-0}))"
br=$(step blob-refs '"check":1')
show "object references" "$br"
contains "every object key the database references resolves in the bucket" '^blob_missing=-$' "$br"
contains "...thread entries, artifacts, files, memory, project files and workspace files among them" \
  '^blob (artifact_versions|files|memory_doc_versions|project_files|workspace_files)\.[a-z_]+=[1-9]' "$br"
lost_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
next=$(turn "$U_M1" "history?" "\"threadId\":\"$T_DATA\"")
show "the next turn" "$next"
contains "the restored thread continues (the run completes)" '^terminal=run.completed$' "$next"
grep -q '^terminal=run.completed$' <<<"$next" || { shim_refusals; sbx_diagnose; }
contains "...in a sandbox that wakes for it (sandbox.waking)" '^waking=[a-z_]+' "$next"
contains "...and Pi gets the earlier turns (its session rebuilt from Postgres)" "history said: .*(gate4 restore hello|$REPORT)" "$(said "$next")"
if sbx_await "$SBX_WAIT" "the restored thread"; then
  contains "Pi's session file is in the new sandbox" '^jsonl=[1-9][0-9]*$' \
    "$(in_sbx "f=/workspace/.kobe/sessions/$T_DATA.jsonl; if test -s \$f; then echo jsonl=\$(wc -l < \$f); else echo jsonl=missing; fi")"
  contains "...written by the server's restore of the lost session" '^[1-9]' \
    "$($KUBECTL -n "$NS" logs -l app.kubernetes.io/component=server -c server --since-time="$lost_at" --tail=-1 2>/dev/null \
      | grep -F "\"thread_id\":\"$T_DATA\"" | grep -c 'Pi session lost; restoring from Postgres' || true)"
  ws_back() { [[ "$(in_sbx "cat /workspace/$REPORT 2>/dev/null")" == "${CSV%$'\n'}" ]]; }
  if until_ok 90 ws_back; then ok "the workspace file is back in the new sandbox, same content (from S3)"
  else fail "the workspace file is back in the new sandbox (got [$(in_sbx "ls -la /workspace | head -20" | tr '\n' ' ')])"; fi
  contains "the project file is mounted in the new sandbox" "^$PROJECT_TEXT\$" "$(in_sbx "cat /workspace/projects/$SLUG/docs/brief.txt")"
fi

echo "==> install: timing"
echo "     cluster with gVisor and agent-sandbox (scripts/dev-cluster.sh): ${CLUSTER_SECONDS:-not measured here} s"
echo "     helm install → first assistant token: ${took:-not measured} s; budget ${SETUP_BUDGET} s (spec §8)"
if ((failed)); then
  verdict "Gate 4 restore: FAILED"
  exit 1
fi
if ((xfailed)); then
  verdict "Gate 4 restore: backup → fresh site → restore round-trips, with $xfailed expected failures (filed; KOBE_GATE_STRICT=1 fails them)"
else
  verdict "Gate 4 restore: backup → fresh site → restore round-trips"
fi
