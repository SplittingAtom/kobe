#!/usr/bin/env bash
# Builds the Kobe images for the e2e suite and loads them into the k3d cluster's nodes.
# Usage: e2e/load-images.sh <cluster> <tag>
#
# A failed build prints the Docker daemon's state (scripts/ci-docker-diagnostics.sh). The import
# streams straight into each node (`--mode direct`): the default tools-node mode can start the
# import before its tarball exists and still report success, leaving the chart to pull images
# that were never published. Every image is then checked on every node.
set -euo pipefail
cd "$(dirname "$0")/.."

cluster="${1:?usage: e2e/load-images.sh <cluster> <tag>}"
tag="${2:?usage: e2e/load-images.sh <cluster> <tag>}"
registry="ghcr.io/splittingatom"

build() {
  local dockerfile="$1" image="$2"
  echo "==> building ${image}"
  if ! docker build --progress=plain -f "${dockerfile}" -t "${image}" .; then
    echo "error: docker build failed for ${image}; daemon state follows" >&2
    scripts/ci-docker-diagnostics.sh
    return 1
  fi
}

images=()
for pair in web:apps/web/Dockerfile server:services/server/Dockerfile \
  mcp-proxy:services/mcp-proxy/Dockerfile egress-proxy:services/egress-proxy/Dockerfile \
  model-gateway:services/model-gateway/Dockerfile \
  sandbox:images/sandbox/Dockerfile; do
  image="${registry}/kobe-${pair%%:*}:${tag}"
  build "${pair#*:}" "${image}"
  images+=("${image}")
done

nodes=$(k3d node list --no-headers | awk -v c="${cluster}" '$3 == c && ($2 == "server" || $2 == "agent") { print $1 }')
[ -n "${nodes}" ] || { echo "error: no server or agent nodes in k3d cluster ${cluster}" >&2; exit 1; }

missing_on() {
  local node="$1" present
  present=$(docker exec "${node}" ctr -n k8s.io images ls -q)
  for image in "${images[@]}"; do
    grep -qxF "${image}" <<<"${present}" || echo "${image}"
  done
}

for attempt in 1 2; do
  k3d image import --mode direct -c "${cluster}" "${images[@]}"
  missing=""
  for node in ${nodes}; do
    m=$(missing_on "${node}")
    [ -z "${m}" ] || missing+="${node}: ${m//$'\n'/ }"$'\n'
  done
  if [ -z "${missing}" ]; then
    echo "==> all ${#images[@]} images present on: ${nodes//$'\n'/ }"
    exit 0
  fi
  echo "warning: import attempt ${attempt} left images missing:" >&2
  printf '%s' "${missing}" >&2
done
echo "error: images still missing from the k3d nodes after two imports" >&2
exit 1
