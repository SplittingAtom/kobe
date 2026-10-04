#!/usr/bin/env bash
# Compact Hadron client for the Kobe coordinator and ticket agents. Prints only what a session
# needs, so raw API responses never land in an agent's context.
#
# Connection settings (HADRON_API_URL, HADRON_PROJECT, HADRON_API_KEY) come from the environment or
# from the gitignored CLAUDE.local.md at the repository root. HADRON_AGENT names the caller
# (default claude-coordinator).
#
#   scripts/hadron.sh ignite [--full]         briefing; project notes only with --full
#   scripts/hadron.sh next                    highest-priority ready ticket
#   scripts/hadron.sh show <N>                one ticket: status, criteria, links
#   scripts/hadron.sh brief <N>               ticket + spec + decisions + ledger mentions (markdown)
#   scripts/hadron.sh start <N>               backlog -> ready if needed, then claim
#   scripts/hadron.sh log <N> <message>       progress log entry
#   scripts/hadron.sh ac <N> <ac-id> pass|fail [notes]
#   scripts/hadron.sh close <N> <pr>          merged PR -> complete (in_review) -> done
#   scripts/hadron.sh cost <N> <tokens_in> <tokens_out> <dollars> [model]
#   scripts/hadron.sh remember <text>         durable project memory (max 4000 chars)
#
# <N> is a ticket number (69) or id (KOBE-69).
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
AGENT="${HADRON_AGENT:-claude-coordinator}"

die() {
  echo "hadron: $*" >&2
  exit 1
}

load_env() {
  if [[ -z "${HADRON_API_KEY:-}" && -f "$ROOT/CLAUDE.local.md" ]]; then
    eval "$(sed -n '/^export HADRON_/p' "$ROOT/CLAUDE.local.md")"
  fi
  [[ -n "${HADRON_API_URL:-}" && -n "${HADRON_PROJECT:-}" && -n "${HADRON_API_KEY:-}" ]] ||
    die "HADRON_API_URL, HADRON_PROJECT and HADRON_API_KEY must be set (see CLAUDE.local.md)"
  BASE="$HADRON_API_URL/api/v1/projects/$HADRON_PROJECT"
}

ticket_id() {
  local raw="${1:-}"
  [[ "$raw" =~ ^([Kk][Oo][Bb][Ee]-)?([0-9]+)$ ]] || die "expected a ticket number or KOBE-<N>, got '$raw'"
  echo "KOBE-${BASH_REMATCH[2]}"
}

# api METHOD PATH [JSON]: prints the response body; on non-2xx prints Hadron's error and exits.
api() {
  local method="$1" path="$2" body="${3:-}" out status
  local args=(-sS -X "$method" -H "X-API-Key: $HADRON_API_KEY" -w '\n%{http_code}')
  [[ -n "$body" ]] && args+=(-H "Content-Type: application/json" -d "$body")
  out="$(curl "${args[@]}" "$BASE$path")" || die "request failed: $method $path"
  status="${out##*$'\n'}"
  out="${out%$'\n'*}"
  if [[ "$status" -lt 200 || "$status" -ge 300 ]]; then
    die "$method $path -> $status: $(jq -r '.error.message // .' <<<"$out" 2>/dev/null || echo "$out")"
  fi
  echo "$out"
}

cmd_ignite() {
  local content
  content="$(api GET "/ignite?agent=$AGENT" | jq -r '.data.content')"
  if [[ "${1:-}" == "--full" ]]; then
    echo "$content"
  else
    # Project notes are long and change rarely; `brief` pulls the ones a ticket needs.
    awk '/^## Project notes/{skip=1; next} /^## /{skip=0} !skip' <<<"$content"
  fi
}

cmd_next() {
  api GET "/tickets/next" |
    jq -r '.data | "\(.display_id) [\(.priority)/\(.effort // "?")] \(.title)"'
}

cmd_show() {
  local id
  id="$(ticket_id "${1:-}")"
  api GET "/tickets/$id" | jq -r '.data |
    "\(.display_id) [\(.status)] \(.title)",
    "priority \(.priority), effort \(.effort // "?"), attempts \(.attempts)",
    (.acceptance_criteria // [] | .[] | "  \(.id) \(if .passed == true then "PASS" elif .passed == false then "fail" else "-" end) \(.description)"),
    (.links // [] | .[] | "  \(.type)/\(.direction) \(.display_id) \(.title)")'
}

cmd_brief() {
  local id ticket spec_id
  id="$(ticket_id "${1:-}")"
  ticket="$(api GET "/tickets/$id")"
  jq -r '.data |
    "# \(.display_id): \(.title)\n",
    "\(.ticket_type), priority \(.priority), effort \(.effort // "?")\n",
    "## Description\n\n\(.description)\n",
    "## Acceptance criteria\n",
    (.acceptance_criteria // [] | .[] | "- **\(.id)** \(.description)"),
    "",
    (if (.links // []) | length > 0 then "## Links\n", (.links[] | "- \(.type) \(.display_id): \(.title)"), "" else empty end)' <<<"$ticket"

  spec_id="$(jq -r '.data.spec_id // empty' <<<"$ticket")"
  if [[ -n "$spec_id" ]]; then
    api GET "/specs/$spec_id" | jq -r '.data |
      "## Spec: \(.title)\n",
      "**Goals.** \(.goals)\n",
      "**Architecture.** \(.architecture)\n",
      "**Constraints.** \(.constraints)\n"'
  fi

  echo "## Decisions that name $id"
  echo
  api GET "/memories" | jq -r --arg id "$id" '
    .data | (if type == "array" then . else (.items // []) end)
    | map(select(.body | test("\\b" + $id + "\\b")) | "- " + .body) | if length == 0 then "- none" else .[] end'
  echo
  echo "## Other ledgers mentioning $id"
  echo
  (cd "$ROOT" && git grep -nI -w "$id" -- docs/RUN-LEDGER.md docs/ledger ":!docs/ledger/$id.md" || echo "none") |
    cut -c1-300
}

cmd_start() {
  local id status
  id="$(ticket_id "${1:-}")"
  status="$(api GET "/tickets/$id" | jq -r '.data.status')"
  if [[ "$status" == "backlog" ]]; then
    api POST "/tickets/$id/transition" '{"status":"ready"}' >/dev/null
  fi
  api POST "/tickets/$id/claim" "$(jq -nc --arg a "$AGENT" '{agent_id: $a, agent_provider: "anthropic"}')" >/dev/null
  echo "$id claimed by $AGENT (was $status)"
}

cmd_log() {
  local id
  id="$(ticket_id "${1:-}")"
  shift
  [[ $# -gt 0 ]] || die "log needs a message"
  api POST "/tickets/$id/log" "$(jq -nc --arg m "$*" '{event_type: "progress", message: $m}')" >/dev/null
  echo "$id: logged"
}

cmd_ac() {
  local id ac="${2:-}" result="${3:-}" notes="${4:-}"
  id="$(ticket_id "${1:-}")"
  [[ "$ac" =~ ^ac-[0-9]+$ ]] || die "expected ac-<n>, got '$ac'"
  [[ "$result" == pass || "$result" == fail ]] || die "expected pass or fail, got '$result'"
  api POST "/tickets/$id/criteria/$ac" \
    "$(jq -nc --argjson p "$([[ $result == pass ]] && echo true || echo false)" --arg n "$notes" \
      '{passed: $p} + (if $n == "" then {} else {notes: $n} end)')" >/dev/null
  echo "$id $ac: $result"
}

# Merged PR -> complete (in_review) -> done. The user authorized moving merged tickets to done
# (2026-10-03); gate tickets KOBE-1..4 are closed by hand once every criterion is proven.
cmd_close() {
  local id pr info state body
  id="$(ticket_id "${1:-}")"
  pr="${2:-}"
  [[ "$pr" =~ ^[0-9]+$ ]] || die "close needs a PR number"
  [[ "$id" =~ ^KOBE-[1-4]$ ]] && die "$id is a gate ticket: close it by hand once every criterion is proven"
  info="$(cd "$ROOT" && gh pr view "$pr" --json state,url,title,headRefName,mergeCommit)"
  state="$(jq -r .state <<<"$info")"
  [[ "$state" == MERGED ]] || die "PR #$pr is $state, not merged"
  body="$(jq -c --arg pr "$pr" '{
      summary: "Merged to main in PR #\($pr): \(.title)",
      branch: .headRefName, pr_url: .url, commit_sha: .mergeCommit.oid,
      verification: "Required checks (checks, db, images, k3d) green in the merge queue; coordinator review on the PR."
    }' <<<"$info")"
  case "$(api GET "/tickets/$id" | jq -r '.data.status')" in
  done) die "$id is already done" ;;
  in_review) ;; # completed earlier; only the move to done is left
  *) api POST "/tickets/$id/complete" "$body" >/dev/null ;;
  esac
  api POST "/tickets/$id/transition" '{"status":"done"}' >/dev/null
  api POST "/tickets/$id/log" \
    '{"event_type":"completed","message":"Merged to main; moved to done under the standing authorization of 2026-10-03."}' >/dev/null
  echo "$id done (PR #$pr, $(jq -r '.mergeCommit.oid[0:12]' <<<"$info"))"
}

cmd_cost() {
  local id tin="${2:-}" tout="${3:-}" dollars="${4:-}" model="${5:-}"
  id="$(ticket_id "${1:-}")"
  [[ "$tin" =~ ^[0-9]+$ && "$tout" =~ ^[0-9]+$ && "$dollars" =~ ^[0-9]+(\.[0-9]+)?$ ]] ||
    die "cost needs <tokens_in> <tokens_out> <dollars> as numbers"
  api POST "/tickets/$id/cost" "$(jq -nc --argjson i "$tin" --argjson o "$tout" --argjson d "$dollars" --arg m "$model" \
    '{tokens_in: $i, tokens_out: $o, dollars: $d} + (if $m == "" then {} else {model: $m} end)')" >/dev/null
  echo "$id: cost recorded"
}

cmd_remember() {
  [[ $# -gt 0 ]] || die "remember needs text"
  [[ ${#*} -le 4000 ]] || die "memory is longer than 4000 characters"
  api POST "/memories" "$(jq -nc --arg b "$*" '{body: $b}')" >/dev/null
  echo "remembered"
}

main() {
  local cmd="${1:-}"
  [[ -n "$cmd" ]] || die "usage: scripts/hadron.sh <ignite|next|show|brief|start|log|ac|close|cost|remember> ..."
  shift
  load_env
  case "$cmd" in
  ignite | next | show | brief | start | log | ac | close | cost | remember) "cmd_$cmd" "$@" ;;
  *) die "unknown command '$cmd'" ;;
  esac
}

main "$@"
