#!/usr/bin/env bash
# The repository is public: infrastructure details (LAN hosts and addresses, SSH users, local paths)
# belong in the gitignored CLAUDE.local.md, never in tracked files. Fails on any match.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
pattern='\.atom\.splittingatom\.io|claude@compute|192\.168\.1\.[0-9]|/Users/[a-z]+/|AI Notes/'
if git grep -nIE "$pattern" -- . ':!scripts/check-public-hygiene.sh'; then
  echo "error: infrastructure details in tracked files (move them to CLAUDE.local.md)" >&2
  exit 1
fi
echo "public hygiene: ok"
