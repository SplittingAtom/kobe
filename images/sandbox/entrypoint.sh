#!/bin/sh
# kobe-sandbox-agent launcher (PID 2, under tini). Root-owned, read-only.
# - No core dumps: they would hold the wire token and agent memory (hard limit, cannot be raised).
# - NODE_OPTIONS from the pod is ignored: it could enable an inspector in the agent.
# - --disable-sigusr1: `kill -USR1` from sandbox code must not open an inspector.
set -eu
ulimit -c 0
unset NODE_OPTIONS
exec node --disable-sigusr1 /opt/kobe/sandbox-agent/dist/index.js "$@"
