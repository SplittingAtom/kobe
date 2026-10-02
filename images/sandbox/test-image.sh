#!/usr/bin/env bash
# Acceptance checks for the Kobe sandbox image (KOBE-21). Usage: test-image.sh <image>
# Runs the image like a sandbox pod: uid 1000, read-only root filesystem, all capabilities dropped,
# no-new-privileges, with writable /tmp, $HOME and (where a check needs it) /workspace.
set -euo pipefail
IMAGE="${1:?usage: $0 <image>}"
failed=0
HARDENED=(--rm --read-only --cap-drop ALL --security-opt no-new-privileges --user 1000:1000
  --tmpfs /tmp --tmpfs /home/kobe:uid=1000,gid=1000)

run() { docker run "${HARDENED[@]}" --entrypoint "$1" "$IMAGE" "${@:2}"; }
run_ws() { docker run "${HARDENED[@]}" --tmpfs /workspace:uid=1000,gid=1000 --entrypoint "$1" "$IMAGE" "${@:2}"; }

check() { # name, expected-regex, runner, command...
  local name="$1" expect="$2" runner="$3" out
  shift 3
  if out="$("$runner" "$@" 2>&1)" && grep -Eq "$expect" <<<"$out"; then
    echo "ok   ${name}"
  else
    echo "FAIL ${name}: ${out}"
    failed=1
  fi
}

check "runs as non-root uid 1000" '^1000$' run id -u
host() { "$@"; }
check "image default user is 1000:1000" '^1000:1000$' host docker image inspect --format '{{.Config.User}}' "$IMAGE"
check "pi is 1.0.x" '(^|[^0-9])1\.0\.[0-9]+' run pi --version
check "node is 22.x (>= 22.19)" '^v22\.(19|[2-9][0-9])\.' run node --version
check "python is 3.12" '^Python 3\.12\.' run python3 --version
check "python data stack imports" '^ok$' run python3 -c \
  'import pandas, numpy, duckdb, pyarrow, matplotlib, openpyxl, docx, reportlab; matplotlib.use("Agg"); import matplotlib.pyplot as plt; plt.figure(); print("ok")'
check "duckdb queries" '^42$' run python3 -c 'import duckdb; print(duckdb.sql("select 42").fetchone()[0])'
check "git and CLIs present" '^ok$' run sh -c 'for b in git curl jq rg unzip zip file; do command -v $b >/dev/null || { echo "missing $b"; exit 1; }; done; echo ok'
# The agent must start and refuse to run without its server URL (exits non-zero by design).
check "kobe-sandbox-agent installed" 'KOBE_SERVER_URL must be a ws' run sh -c 'node /opt/kobe/sandbox-agent/dist/index.js 2>&1; true'
check "agent ships only dist, deps and manifest" '^ok$' run sh -c \
  'cd /opt/kobe/sandbox-agent && [ "$(ls -A | sort | tr "\n" " ")" = "dist node_modules package.json " ] && echo ok || ls -A'
check "skills directory exists, root-owned" '^0:0$' run stat -c '%u:%g' /opt/kobe/skills
check "/workspace in the image is owned by uid 1000" '^1000:1000$' run stat -c '%u:%g' /workspace
check "workspace (volume) is writable" '^ok$' run_ws sh -c 'touch /workspace/x && echo ok'
check "no setuid/setgid binaries" '^none$' run sh -c 'f=$(find / -xdev -perm /6000 -type f 2>/dev/null); [ -z "$f" ] && echo none || echo "$f"'
check "nothing outside /workspace, /tmp, \$HOME is writable by uid 1000" '^none$' run sh -c \
  'f=$(find /bin /sbin /lib /usr /opt /etc /root /var /srv -xdev -writable 2>/dev/null | grep -v "^/var/tmp" | head -5); [ -z "$f" ] && echo none || echo "$f"'
check "no private keys or credential files baked in" '^none$' run sh -c \
  'f=$( (grep -rlI "PRIVATE KEY" /opt/kobe /home/kobe /etc --exclude-dir=ssl 2>/dev/null; find /opt/kobe /home /etc -xdev \( -name ".env*" -o -name ".npmrc" -o -name "*.pem" -o -name "id_rsa*" \) -not -path "/etc/ssl/*" 2>/dev/null) | head -5); [ -z "$f" ] && echo none || echo "$f"'
check "no secrets in the environment" '^ok$' run sh -c 'env | grep -Eiq "(api_?key|token|secret|password)=" && echo leaked || echo ok'

exit "$failed"
