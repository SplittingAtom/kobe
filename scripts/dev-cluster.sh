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
# Single node by default (k3d nodes are inotify-hungry); set KOBE_AGENTS=1 to add an agent.
AGENTS="${KOBE_AGENTS:-0}"
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

# k3s nodes are inotify-hungry; low host limits make containerd's CRI plugin fail on restart
# ("too many open files"). The limit is host-wide, so read it through a throwaway container.
inotify=$(docker run --rm busybox:1.37 cat /proc/sys/fs/inotify/max_user_instances 2>/dev/null || echo 0)
if [[ "$inotify" =~ ^[0-9]+$ && "$inotify" -lt 512 ]]; then
  echo "warning: docker host fs.inotify.max_user_instances=${inotify}; k3d needs >= 512" >&2
  echo "         (on the docker host: sudo sysctl -w fs.inotify.max_user_instances=512)" >&2
fi

if "$K3D" cluster get "$CLUSTER" >/dev/null 2>&1; then
  echo "==> k3d cluster '${CLUSTER}' exists; reusing it"
else
  echo "==> creating k3d cluster '${CLUSTER}' (${K3S_IMAGE})"
  "$K3D" cluster create "$CLUSTER" --image "$K3S_IMAGE" --agents "$AGENTS" --wait \
    --k3s-arg "--disable=metrics-server@server:*" >/dev/null
fi
"$K3D" kubeconfig merge "$CLUSTER" --kubeconfig-switch-context >/dev/null

k3d_nodes() {
  for role in server agent; do
    docker ps --filter "label=k3d.cluster=${CLUSTER}" --filter "label=k3d.role=${role}" --format '{{.Names}}'
  done
}

has_gvisor() {
  docker exec "$1" sh -c 'test -x /bin/runsc && test -d /bin/gvisor-bin &&
    test -f /var/lib/rancher/k3s/agent/etc/containerd/config-v3.toml.d/10-gvisor.toml'
}

install_gvisor() { # node...
  local dropin node arch dir
  dropin=$(mktemp)
  printf '%s\n' "[plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.runsc]" '  runtime_type = "io.containerd.runsc.v1"' >"$dropin"
  for node in "$@"; do
    arch=$(docker exec "$node" uname -m)
    dir=$(fetch_gvisor "$arch") || { echo "failed to fetch gVisor ${GVISOR_RELEASE} for ${arch}" >&2; exit 1; }
    docker cp "$dir/runsc" "$node:/bin/runsc"
    docker cp "$dir/containerd-shim-runsc-v1" "$node:/bin/containerd-shim-runsc-v1"
    docker exec "$node" mkdir -p /bin/gvisor-bin
    docker cp "$dir/gvisor-bin/." "$node:/bin/gvisor-bin/"
    docker exec "$node" mkdir -p /var/lib/rancher/k3s/agent/etc/containerd/config-v3.toml.d
    docker cp "$dropin" "$node:/var/lib/rancher/k3s/agent/etc/containerd/config-v3.toml.d/10-gvisor.toml"
  done
  rm -f "$dropin"
  docker restart "$@" >/dev/null
  echo "==> waiting for nodes after restart"
  for _ in $(seq 1 60); do $KUBECTL get nodes >/dev/null 2>&1 && break; sleep 2; done
  $KUBECTL wait --for=condition=Ready nodes --all --timeout=300s >/dev/null
}

if [[ "${NO_GVISOR:-0}" != "1" ]]; then
  missing=()
  while IFS= read -r node; do
    [[ -n "$node" ]] && ! has_gvisor "$node" && missing+=("$node")
  done < <(k3d_nodes)
  if [[ ${#missing[@]} -gt 0 ]]; then
    echo "==> installing gVisor ${GVISOR_RELEASE} into ${missing[*]}"
    install_gvisor "${missing[@]}"
  else
    echo "==> gVisor already installed on every node"
  fi
  $KUBECTL apply -f charts/kobe/runtimeclass-gvisor.yaml >/dev/null

  echo "==> smoke-testing gVisor"
  smoke="gvisor-smoke-$RANDOM"
  $KUBECTL run "$smoke" --image=busybox:1.37 --restart=Never \
    --overrides='{"spec":{"runtimeClassName":"gvisor"}}' -- dmesg >/dev/null
  $KUBECTL wait --for=jsonpath='{.status.phase}'=Succeeded "pod/$smoke" --timeout=120s >/dev/null
  if $KUBECTL logs "$smoke" | grep -q "Starting gVisor"; then echo "ok: pods run under gVisor"; else
    echo "gVisor smoke test failed" >&2; $KUBECTL logs "$smoke" >&2; exit 1; fi
  $KUBECTL delete pod "$smoke" --wait=false >/dev/null
fi

log=$(mktemp)
if KUBECTL="$KUBECTL" scripts/install-agent-sandbox.sh >"$log" 2>&1; then echo "ok: agent-sandbox controller ready"; else
  cat "$log" >&2; rm -f "$log"; exit 1; fi
rm -f "$log"
echo "Cluster '${CLUSTER}' is ready (context k3d-${CLUSTER})."
