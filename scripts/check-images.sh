#!/usr/bin/env bash
# Builds every control-plane service image (the sandbox image has its own checks:
# images/sandbox/test-image.sh) and asserts it runs as a non-root numeric user (KOBE-5 ac-2) and
# ships LICENSE, NOTICE and THIRD_PARTY_LICENSES.md (KOBE-375).
set -euo pipefail
cd "$(dirname "$0")/.."

# service:dockerfile pairs (portable to macOS bash 3.2, which lacks associative arrays)
IMAGES="web:apps/web/Dockerfile
server:services/Dockerfile
mcp-proxy:services/Dockerfile
egress-proxy:services/Dockerfile
model-gateway:services/Dockerfile"
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
  # The Node services share services/Dockerfile and name themselves with SERVICE (KOBE-723).
  build_args=()
  [ "${dockerfile}" != services/Dockerfile ] || build_args=(--build-arg "SERVICE=${svc}")
  echo "==> building ${image}"
  if ! docker build --progress=plain -f "${dockerfile}" ${build_args[@]+"${build_args[@]}"} -t "${image}" . >"${build_log}" 2>&1; then
    tail -n 80 "${build_log}"
    echo "FAIL ${image}: docker build failed; daemon state follows"
    scripts/ci-docker-diagnostics.sh
    exit 1
  fi

  scripts/assert-image-nonroot.sh "${image}" || failed=1
  scripts/assert-image-licenses.sh "${image}" || failed=1
done

exit "${failed}"
