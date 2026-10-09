#!/usr/bin/env bash
# Asserts that a local image runs as a non-root numeric user (KOBE-5 ac-2): Config.User is set and
# not root/0, and `id -u` inside the image is not 0. Used by check-images.sh and the e2e images job.
set -euo pipefail
image="${1:?usage: assert-image-nonroot.sh <image>}"
configured_user="$(docker image inspect --format '{{.Config.User}}' "${image}")"
runtime_uid="$(docker run --rm --entrypoint id "${image}" -u)"
if [[ -z "${configured_user}" || "${configured_user%%:*}" == "0" || "${configured_user%%:*}" == "root" || "${runtime_uid}" == "0" ]]; then
  echo "FAIL ${image}: USER='${configured_user}' uid=${runtime_uid}"
  exit 1
fi
echo "ok   ${image}: USER=${configured_user} uid=${runtime_uid}"
