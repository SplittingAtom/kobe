#!/usr/bin/env bash
# Runs the capture against one Bifrost image on the Docker host DOCKER_HOST points at.
# Usage: run.sh <bifrost-image-ref> <label> <cases.json> <out-dir>
# Creates network bfcap-<label>, containers bfcap-<label>-{capture,bifrost,drive}; removes them
# at the end (images are left for the caller to remove). Nothing is published on host ports.
set -euo pipefail
IMAGE="$1"; LABEL="$2"; CASES="$3"; OUT="$4"
HERE="$(cd "$(dirname "$0")" && pwd)"
NET="bfcap-${LABEL}"
NODE_IMAGE="${NODE_IMAGE:-node:24-slim}"
cleanup() { docker rm -f "${NET}-capture" "${NET}-bifrost" "${NET}-drive" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup
docker network create "$NET" >/dev/null

docker create --name "${NET}-capture" --network "$NET" --network-alias capture "$NODE_IMAGE" node /srv/capture-server.mjs >/dev/null
docker cp "$HERE/capture-server.mjs" "${NET}-capture:/srv/capture-server.mjs"
docker start "${NET}-capture" >/dev/null

docker create --name "${NET}-bifrost" --network "$NET" --network-alias bifrost "$IMAGE" >/dev/null
docker cp "$HERE/bifrost-config.json" "${NET}-bifrost:/app/data/config.json"
docker start "${NET}-bifrost" >/dev/null

docker create --name "${NET}-drive" --network "$NET" "$NODE_IMAGE" \
  sh -c 'for i in $(seq 1 60); do node -e "fetch(\"http://bifrost:8080/health\").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" && break; sleep 1; done; node /srv/drive.mjs /srv/cases.json' >/dev/null
docker cp "$HERE/drive.mjs" "${NET}-drive:/srv/drive.mjs"
docker cp "$CASES" "${NET}-drive:/srv/cases.json"
mkdir -p "$OUT"
docker start -a "${NET}-drive" > "$OUT/results-${LABEL}.json"
docker logs "${NET}-bifrost" > "$OUT/bifrost-${LABEL}.log" 2>&1 || true
echo "wrote $OUT/results-${LABEL}.json"
