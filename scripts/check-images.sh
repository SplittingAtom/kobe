#!/usr/bin/env bash
# Builds every service image and asserts it runs as a non-root numeric user (KOBE-5 ac-2).
set -euo pipefail
cd "$(dirname "$0")/.."

# service:dockerfile pairs (portable to macOS bash 3.2, which lacks associative arrays)
IMAGES="web:apps/web/Dockerfile
server:services/server/Dockerfile
sandbox-agent:services/sandbox-agent/Dockerfile
mcp-proxy:services/mcp-proxy/Dockerfile
egress-proxy:services/egress-proxy/Dockerfile"
TAG="${IMAGE_TAG:-dev}"
failed=0

for entry in ${IMAGES}; do
  svc="${entry%%:*}"
  dockerfile="${entry#*:}"
  image="kobe-${svc}:${TAG}"
  echo "==> building ${image}"
  docker build --quiet -f "${dockerfile}" -t "${image}" . >/dev/null

  configured_user="$(docker image inspect --format '{{.Config.User}}' "${image}")"
  runtime_uid="$(docker run --rm --entrypoint id "${image}" -u)"
  if [[ -z "${configured_user}" || "${configured_user%%:*}" == "0" || "${configured_user%%:*}" == "root" || "${runtime_uid}" == "0" ]]; then
    echo "FAIL ${image}: USER='${configured_user}' uid=${runtime_uid}"
    failed=1
  else
    echo "ok   ${image}: USER=${configured_user} uid=${runtime_uid}"
  fi
done

exit "${failed}"
