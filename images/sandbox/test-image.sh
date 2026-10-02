#!/usr/bin/env bash
# Acceptance checks for the Kobe sandbox image (KOBE-21). Usage: test-image.sh <image>
# Runs the image the way Kobe will: non-root, read-only root filesystem, writable /tmp, /workspace
# and $HOME only.
set -euo pipefail
IMAGE="${1:?usage: $0 <image>}"
failed=0

run() {
  docker run --rm --read-only --tmpfs /tmp --tmpfs /workspace:uid=1000,gid=1000 \
    --tmpfs /home/kobe:uid=1000,gid=1000 --entrypoint "$1" "$IMAGE" "${@:2}"
}

check() { # name, expected-regex, command...
  local name="$1" expect="$2" out
  shift 2
  if out="$(run "$@" 2>&1)" && grep -Eq "$expect" <<<"$out"; then
    echo "ok   ${name}"
  else
    echo "FAIL ${name}: ${out}"
    failed=1
  fi
}

check "runs as non-root uid 1000" '^1000$' id -u
check "pi is 1.0.x" '(^|[^0-9])1\.0\.[0-9]+' pi --version
check "node is 22.x (>= 22.19)" '^v22\.(19|[2-9][0-9])\.' node --version
check "python is 3.12" '^Python 3\.12\.' python3 --version
check "python data stack imports" '^ok$' python3 -c \
  'import pandas, numpy, duckdb, pyarrow, matplotlib, openpyxl, docx, reportlab; matplotlib.use("Agg"); import matplotlib.pyplot as plt; plt.figure(); print("ok")'
check "duckdb queries" '^42$' python3 -c 'import duckdb; print(duckdb.sql("select 42").fetchone()[0])'
check "git and CLIs present" '^ok$' sh -c 'for b in git curl jq rg unzip zip file; do command -v $b >/dev/null || { echo "missing $b"; exit 1; }; done; echo ok'
# The agent must start and refuse to run without its server URL (exits non-zero by design).
check "kobe-sandbox-agent installed" 'KOBE_SERVER_URL must be a ws' sh -c 'node /opt/kobe/sandbox-agent/dist/index.js 2>&1; true'
check "skills directory exists" '^/opt/kobe/skills$' sh -c 'test -d /opt/kobe/skills && echo /opt/kobe/skills'
check "workspace is writable, root FS is not" '^ok$' sh -c 'touch /workspace/x && ! touch /usr/x 2>/dev/null && echo ok'
check "no secrets baked into the environment" '^ok$' sh -c 'env | grep -Eiq "(api_?key|token|secret|password)=" && echo leaked || echo ok'

exit "$failed"
