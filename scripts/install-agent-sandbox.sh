#!/usr/bin/env bash
# Installs the kubernetes-sigs/agent-sandbox controller with extensions (claims, templates, warm
# pools). Pinned: v1.0.5's controller image was not published when this was written.
set -euo pipefail
VERSION="${AGENT_SANDBOX_VERSION:-v1.0.4}"
KUBECTL="${KUBECTL:-kubectl}"
URL="https://github.com/kubernetes-sigs/agent-sandbox/releases/download/${VERSION}/sandbox-with-extensions.yaml"

echo "==> installing agent-sandbox ${VERSION}"
curl -fsSL "$URL" | $KUBECTL apply --server-side --force-conflicts -f -
$KUBECTL -n agent-sandbox-system rollout status deploy/agent-sandbox-controller --timeout=180s
$KUBECTL api-resources --api-group=agents.x-k8s.io
