#!/usr/bin/env bash
# Creates a local k3d cluster that meets Kobe's prerequisites: gVisor (RuntimeClass "gvisor",
# handler runsc) and the agent-sandbox controller. Used by the dev loop and CI e2e.
# Works with a local or remote Docker engine (DOCKER_HOST=ssh://...): binaries are copied into the
# node containers rather than bind-mounted.
#   NO_GVISOR=1 creates the cluster without gVisor (to prove the chart refuses to install).
set -euo pipefail
cd "$(dirname "$0")/.."

CLUSTER="${KOBE_CLUSTER:-kobe}"
K3S_IMAGE="${K3S_IMAGE:-rancher/k3s:v1.34.6-k3s1}"
GVISOR_RELEASE="${GVISOR_RELEASE:-20260928.0}"
K3D="${K3D:-k3d}"
KUBECTL="${KUBECTL:-kubectl}"
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/kobe/gvisor-${GVISOR_RELEASE}"

fetch_gvisor() { # arch: x86_64 | aarch64 — releases ship as a checksummed tarball
  local arch="$1" dir="$CACHE/$1" base="https://storage.googleapis.com/gvisor/releases/release/${GVISOR_RELEASE}/$1"
  if [[ ! -x "$dir/runsc" || ! -x "$dir/containerd-shim-runsc-v1" || ! -d "$dir/gvisor-bin" ]]; then
    # Explicit `|| return`: errexit does not apply inside command substitution on bash 3.2 (macOS).
    mkdir -p "$dir" || return 1
    curl -fsSL -o "$dir/gvisor.tar.bz2" "$base/gvisor.tar.bz2" || return 1
    curl -fsSL -o "$dir/gvisor.tar.bz2.sha512" "$base/gvisor.tar.bz2.sha512" || return 1
    (cd "$dir" && { sha512sum -c gvisor.tar.bz2.sha512 2>/dev/null || shasum -a 512 -c gvisor.tar.bz2.sha512; } >/dev/null) || return 1
    # runsc needs its gvisor-bin/ sidecars next to it (sentry, gofer, ...).
    tar -xjf "$dir/gvisor.tar.bz2" -C "$dir" || return 1
    rm -f "$dir/gvisor.tar.bz2"
  fi
  echo "$dir"
}

echo "==> creating k3d cluster '${CLUSTER}' (${K3S_IMAGE})"
"$K3D" cluster create "$CLUSTER" --image "$K3S_IMAGE" --agents 1 --wait \
  --k3s-arg "--disable=metrics-server@server:*" >/dev/null
"$K3D" kubeconfig merge "$CLUSTER" --kubeconfig-switch-context >/dev/null

if [[ "${NO_GVISOR:-0}" != "1" ]]; then
  echo "==> installing gVisor ${GVISOR_RELEASE} into every node"
  nodes=$(for role in server agent; do
    docker ps --filter "label=k3d.cluster=${CLUSTER}" --filter "label=k3d.role=${role}" --format '{{.Names}}'
  done)
  [[ -n "$nodes" ]] || { echo "no k3d nodes found for cluster ${CLUSTER}" >&2; exit 1; }
  dropin=$(mktemp)
  printf '%s\n' "[plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.runsc]" '  runtime_type = "io.containerd.runsc.v1"' >"$dropin"
  for node in $nodes; do
    arch=$(docker exec "$node" uname -m)
    dir=$(fetch_gvisor "$arch") || { echo "failed to fetch gVisor ${GVISOR_RELEASE} for ${arch}" >&2; exit 1; }
    docker cp "$dir/runsc" "$node:/bin/runsc"
    docker cp "$dir/containerd-shim-runsc-v1" "$node:/bin/containerd-shim-runsc-v1"
    docker cp "$dir/gvisor-bin" "$node:/bin/gvisor-bin"
    docker exec "$node" mkdir -p /var/lib/rancher/k3s/agent/etc/containerd/config-v3.toml.d
    docker cp "$dropin" "$node:/var/lib/rancher/k3s/agent/etc/containerd/config-v3.toml.d/10-gvisor.toml"
  done
  rm -f "$dropin"
  docker restart $nodes >/dev/null
  echo "==> waiting for nodes after restart"
  for _ in $(seq 1 60); do $KUBECTL get nodes >/dev/null 2>&1 && break; sleep 2; done
  $KUBECTL wait --for=condition=Ready nodes --all --timeout=180s >/dev/null
  $KUBECTL apply -f charts/kobe/runtimeclass-gvisor.yaml >/dev/null

  echo "==> smoke-testing gVisor"
  $KUBECTL run gvisor-smoke --image=busybox:1.37 --restart=Never \
    --overrides='{"spec":{"runtimeClassName":"gvisor"}}' -- dmesg >/dev/null
  $KUBECTL wait --for=jsonpath='{.status.phase}'=Succeeded pod/gvisor-smoke --timeout=120s >/dev/null
  $KUBECTL logs gvisor-smoke | grep -q "Starting gVisor" && echo "ok: pods run under gVisor"
  $KUBECTL delete pod gvisor-smoke --wait=false >/dev/null
fi

KUBECTL="$KUBECTL" scripts/install-agent-sandbox.sh >/dev/null && echo "ok: agent-sandbox controller ready"
echo "Cluster '${CLUSTER}' is ready (context k3d-${CLUSTER})."
