#!/usr/bin/env bash
# Installs gVisor on one k3s node and registers it with k3s' containerd (run as root on EVERY node,
# one node at a time). Then, once per cluster: `kubectl apply -f charts/kobe/runtimeclass-gvisor.yaml`.
# Idempotent. Restarting k3s does not stop running pods.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then echo "run as root (sudo $0)" >&2; exit 1; fi
command -v apt-get >/dev/null || { echo "Debian/Ubuntu only; see https://gvisor.dev/docs/user_guide/install/" >&2; exit 1; }

# Pinned so every node runs the same gVisor; bump deliberately (also in scripts/dev-cluster.sh).
RUNSC_VERSION="${RUNSC_VERSION:-20260928.0}"
GVISOR_KEY_FINGERPRINT="6F1DF85E3A71C24918E727D56FC6D554E32BD943"
DROPIN_DIR=/var/lib/rancher/k3s/agent/etc/containerd/config-v3.toml.d
SERVICE=k3s
systemctl list-unit-files k3s-agent.service >/dev/null 2>&1 && systemctl is-enabled -q k3s-agent && SERVICE=k3s-agent

echo "==> installing runsc from the gVisor apt repository"
curl -fsSL https://gvisor.dev/archive.key | gpg --dearmor --yes -o /usr/share/keyrings/gvisor-archive-keyring.gpg
keys=$(gpg --show-keys --with-colons /usr/share/keyrings/gvisor-archive-keyring.gpg)
grep -q "^fpr:::::::::${GVISOR_KEY_FINGERPRINT}:" <<<"$keys" \
  || { echo "unexpected gVisor signing key fingerprint" >&2; exit 1; }
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" \
  > /etc/apt/sources.list.d/gvisor.list
apt-get update -qq
DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l apt-get install -y -qq --allow-downgrades "runsc=${RUNSC_VERSION}"
runsc --version | head -1

echo "==> registering the runsc runtime with k3s containerd (drop-in, k3s config untouched)"
mkdir -p "$DROPIN_DIR"
desired=$'[plugins.\'io.containerd.cri.v1.runtime\'.containerd.runtimes.runsc]\n  runtime_type = "io.containerd.runsc.v1"'
# (Pipelines into `grep -q` are avoided throughout: pipefail + SIGPIPE gives false failures.)
cri_info() { k3s crictl info 2>/dev/null || true; }
if [[ "$(cat "$DROPIN_DIR/10-gvisor.toml" 2>/dev/null)" == "$desired" ]] && grep -q runsc <<<"$(cri_info)"; then
  echo "ok: runsc runtime already registered on $(hostname); no restart needed"
  exit 0
fi
printf '%s\n' "$desired" > "$DROPIN_DIR/10-gvisor.toml"

echo "==> restarting $SERVICE"
systemctl restart "$SERVICE"
for _ in $(seq 1 30); do systemctl is-active -q "$SERVICE" && break; sleep 2; done
grep -q runsc <<<"$(cri_info)" && echo "ok: runsc runtime registered on $(hostname)" || {
  echo "runsc not visible in containerd config; check: journalctl -u $SERVICE" >&2; exit 1; }
