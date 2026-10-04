#!/usr/bin/env bash
# Installs the kubernetes-sigs/agent-sandbox controller with extensions (claims, templates, warm
# pools). Pinned: v1.0.5's controller image was not published when this was written.
set -euo pipefail
# Bump both together; the checksum guards against a moved or tampered release asset.
VERSION="v1.0.4"
SHA256="8cbe7f4c252463667e2286993bd735cb33bb2e47d7f304b92aa2ca97f57052c0"
KUBECTL="${KUBECTL:-kubectl}"
URL="https://github.com/kubernetes-sigs/agent-sandbox/releases/download/${VERSION}/sandbox-with-extensions.yaml"

manifest=$(mktemp)
trap 'rm -f "$manifest"' EXIT
echo "==> installing agent-sandbox ${VERSION}"
curl -fsSL --retry 5 --retry-all-errors --retry-delay 3 --connect-timeout 20 -o "$manifest" "$URL"
actual=$( (sha256sum "$manifest" 2>/dev/null || shasum -a 256 "$manifest") | cut -d' ' -f1)
[[ "$actual" == "$SHA256" ]] || { echo "checksum mismatch for $URL: $actual" >&2; exit 1; }
$KUBECTL apply --server-side -f "$manifest"
$KUBECTL -n agent-sandbox-system rollout status deploy/agent-sandbox-controller --timeout=180s
$KUBECTL api-resources --api-group=agents.x-k8s.io
