#!/usr/bin/env bash
# Semantic memory eval harness (KOBE-387; v1.3 SM25/SM30, Gate A = KOBE-388). KOBE-400 extends it
# with the extractor eval. Method and results: docs/gates/gate-7a.md; the relevance set and how it
# was built: e2e/fixtures/memory-relevance/README.md.
#
#   e2e/memory-eval.sh relevance
#     Seeds e2e/fixtures/memory-relevance/items.json into a throwaway database on
#     KOBE_TEST_DATABASE_URL's server (a superuser URL; the database is created and dropped), runs
#     the KOBE-382 selector's store read for each of the ~150 queries and prints recall@8 per kind
#     and overall (the Gate A number: Phase D vectors only if it is below 0.85).
#
#   e2e/memory-eval.sh cache
#     Replays the 20 messages of e2e/fixtures/memory-cache/turns.json in one new thread on a
#     running Kobe (real model through the gateway) and prints the cache-read share from the
#     thread's gateway usage (all turns, and turns 2-20). Environment (from the operator's shell,
#     never committed):
#       KOBE_EVAL_URL       the install's public URL, e.g. https://kobe.example.com (required)
#       KOBE_EVAL_EMAIL / KOBE_EVAL_PASSWORD   a member's password sign-in, or
#       KOBE_EVAL_COOKIE    a signed-in browser's Cookie header value (SSO-only installs)
#       KOBE_EVAL_TEAM_ID   the Workspace to use (default: the member's active one)
#       KOBE_EVAL_AGENT_ID  agent to chat with (its Memory setting must be Full; default agent if unset)
#       KOBE_EVAL_MODEL     model alias for the thread (default: the team's default)
#       KOBE_EVAL_SEED=1    first create the memories of e2e/fixtures/memory-cache/seed.json
#                           (once per install; Policy rows need a Site admin)
#       KOBE_EVAL_LABEL     a label for the output (before/after)
#
#   KOBE_EVAL_OUT=<file>  also writes the report as JSON (both modes).
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
mode=${1:-}
case "$mode" in
  relevance)
    : "${KOBE_TEST_DATABASE_URL:?set KOBE_TEST_DATABASE_URL to a Postgres 17 superuser URL (a scratch database is created and dropped)}"
    file=relevance.eval.ts
    ;;
  cache)
    : "${KOBE_EVAL_URL:?set KOBE_EVAL_URL to the public URL of the install}"
    if [[ -z "${KOBE_EVAL_COOKIE:-}" && (-z "${KOBE_EVAL_EMAIL:-}" || -z "${KOBE_EVAL_PASSWORD:-}") ]]; then
      echo "set KOBE_EVAL_EMAIL and KOBE_EVAL_PASSWORD, or KOBE_EVAL_COOKIE" >&2
      exit 2
    fi
    file=cache.eval.ts
    ;;
  *)
    echo "usage: e2e/memory-eval.sh relevance|cache" >&2
    exit 2
    ;;
esac

cd "$root"
# The server's workspace dependencies are consumed from dist/ (turbo caches the build).
pnpm turbo run build --filter '@kobe/server^...' --output-logs=errors-only >&2
cd services/server
exec pnpm exec vitest run -c vitest.eval.config.ts "src/testing/memory-eval/$file"
