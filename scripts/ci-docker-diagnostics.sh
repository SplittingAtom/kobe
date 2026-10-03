#!/usr/bin/env bash
# Prints the Docker daemon's state after a failed image build so CI failures are diagnosable:
# daemon info, disk and memory (host and this container's cgroup), and the tail of the
# Docker-in-Docker daemon log when the self-hosted runners (ci/runners) provide one.
# Never fails: it runs on an error path.
set -u

section() { printf '\n--- %s\n' "$1"; }

section "docker info"
docker info 2>&1 || true
section "docker system df"
docker system df 2>&1 || true
section "containers"
docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.Status}}' 2>&1 || true
section "memory"
free -m 2>&1 || true
cat /proc/pressure/memory 2>/dev/null || true
for f in memory.max memory.current memory.peak memory.events; do
  [ -r "/sys/fs/cgroup/$f" ] && echo "cgroup $f: $(tr '\n' ' ' <"/sys/fs/cgroup/$f")"
done
section "disk"
df -h / "${GITHUB_WORKSPACE:-.}" 2>&1 || true

# ci/runners/values.yaml tees the dind sidecar's daemon log onto the shared work volume.
log="${KOBE_DIND_LOG:-/home/runner/_work/_dind/dockerd.log}"
section "dockerd log (last 200 lines)"
if [ -r "$log" ]; then tail -n 200 "$log"; else echo "(no daemon log at $log)"; fi
exit 0
