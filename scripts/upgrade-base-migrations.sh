#!/usr/bin/env bash
# Prints the path of a temp dir holding packages/db/drizzle as the upgrade base has it (KOBE-69).
# CI db job: pull_request -> the base branch tip (HEAD^1 of the merge ref is the same commit),
# merge_group -> the queue's base sha, push -> the commit the branch forked from main (its merge
# base), not main's tip: a branch pushed before another PR's migration landed is still a valid
# "base + this branch's migrations" upgrade, and must not need a main merge for every migration that
# lands meanwhile. The merge queue tests against main's real tip, so a branch that is truly behind
# is still caught there. The checkout is shallow, so the merge base comes from the compare API.
# Needs `git fetch` access to origin (and `gh` with GITHUB_TOKEN for the push case).
set -euo pipefail
case "${GITHUB_EVENT_NAME:-}" in
  pull_request) base="${PR_BASE_SHA:?PR_BASE_SHA required}" ;;
  merge_group) base="${MERGE_GROUP_BASE_SHA:?MERGE_GROUP_BASE_SHA required}" ;;
  *)
    base="${UPGRADE_BASE_REF:-origin/main}"
    if [[ -z "${UPGRADE_BASE_REF:-}" && -n "${GITHUB_REPOSITORY:-}" && -n "${GITHUB_SHA:-}" ]]; then
      fork=$(gh api "repos/${GITHUB_REPOSITORY}/compare/main...${GITHUB_SHA}" \
        -q .merge_base_commit.sha 2>/dev/null || true)
      [[ "$fork" =~ ^[0-9a-f]{40}$ ]] && base="$fork"
    fi
    ;;
esac
case "$base" in
  origin/*) git fetch --quiet --depth=1 origin "${base#origin/}" && base=FETCH_HEAD ;;
  *) git fetch --quiet --depth=1 origin "$base" ;;
esac
dir="$(mktemp -d)"
git archive "$base" packages/db/drizzle | tar -x -C "$dir"
echo "$dir/packages/db/drizzle"
