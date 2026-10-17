#!/usr/bin/env bash
# Asserts that a Kobe image ships the repository's LICENSE, NOTICE and THIRD_PARTY_LICENSES.md under
# /usr/share/doc/kobe/, byte for byte (Apache-2.0 section 4, KOBE-375). Run from the repository
# root on the commit the image was built from. Used by check-images.sh and the image workflows.
set -euo pipefail
image="${1:?usage: assert-image-licenses.sh <image>}"
failed=0
for file in LICENSE NOTICE THIRD_PARTY_LICENSES.md; do
  if docker run --rm --entrypoint cat "${image}" "/usr/share/doc/kobe/${file}" | cmp -s - "${file}"; then
    echo "ok   ${image}: /usr/share/doc/kobe/${file}"
  else
    echo "FAIL ${image}: /usr/share/doc/kobe/${file} is missing or differs from ${file}"
    failed=1
  fi
done
exit "${failed}"
