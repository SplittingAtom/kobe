#!/usr/bin/env bash
# Prints the path of a temp dir holding packages/db/drizzle as the upgrade base has it (KOBE-69).
# CI db job: pull_request -> the base branch tip (HEAD^1 of the merge ref is the same commit),
# merge_group -> the queue's base sha, push -> origin/main. Needs `git fetch` access to origin.
set -euo pipefail
case "${GITHUB_EVENT_NAME:-}" in
  pull_request) base="${PR_BASE_SHA:?PR_BASE_SHA required}" ;;
  merge_group) base="${MERGE_GROUP_BASE_SHA:?MERGE_GROUP_BASE_SHA required}" ;;
  *) base="${UPGRADE_BASE_REF:-origin/main}" ;;
esac
case "$base" in
  origin/*) git fetch --quiet --depth=1 origin "${base#origin/}" && base=FETCH_HEAD ;;
  *) git fetch --quiet --depth=1 origin "$base" ;;
esac
dir="$(mktemp -d)"
git archive "$base" packages/db/drizzle | tar -x -C "$dir"
echo "$dir/packages/db/drizzle"
