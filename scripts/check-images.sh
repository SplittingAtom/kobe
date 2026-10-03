#!/usr/bin/env bash
# Builds every control-plane service image (the sandbox image has its own checks:
# images/sandbox/test-image.sh) and asserts it runs as a non-root numeric user (KOBE-5 ac-2).
set -euo pipefail
cd "$(dirname "$0")/.."

# service:dockerfile pairs (portable to macOS bash 3.2, which lacks associative arrays)
IMAGES="web:apps/web/Dockerfile
server:services/server/Dockerfile
mcp-proxy:services/mcp-proxy/Dockerfile
egress-proxy:services/egress-proxy/Dockerfile
model-gateway:services/model-gateway/Dockerfile"
TAG="${IMAGE_TAG:-dev}"
# e.g. IMAGE_PREFIX=ghcr.io/splittingatom/kobe- IMAGE_TAG=0.1.0 to build release-named images.
PREFIX="${IMAGE_PREFIX:-kobe-}"
failed=0
build_log="$(mktemp)"
trap 'rm -f "${build_log}"' EXIT

for entry in ${IMAGES}; do
  svc="${entry%%:*}"
  dockerfile="${entry#*:}"
  image="${PREFIX}${svc}:${TAG}"
  echo "==> building ${image}"
  if ! docker build --progress=plain -f "${dockerfile}" -t "${image}" . >"${build_log}" 2>&1; then
    tail -n 80 "${build_log}"
    echo "FAIL ${image}: docker build failed; daemon state follows"
    scripts/ci-docker-diagnostics.sh
    exit 1
  fi

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
