# Kobe sandbox image (spec D12, KOBE-21): the one image every agent sandbox runs under gVisor.
# Build from the repository root: docker build -f images/sandbox/Dockerfile .
# Every input is pinned (base digests, npm, Pi lockfile, hashed pip lock); bump deliberately.
# No `# syntax=` directive: dockerd's built-in frontend parses this file, so builds don't start
# the external docker/dockerfile frontend container (it crashed intermittently on CI runners:
# "frontend grpc server closed unexpectedly").
ARG NODE_IMAGE=node:22-trixie-slim@sha256:b26b04c123d9ff8ab646ceb18b9d75a1173acf64b9a401094b906d27b29338d4
ARG PYTHON_IMAGE=python:3.12-slim-trixie@sha256:dddfd7e07f9d15aeeca61529320492139d21cac7f0070c00609243e51e4e0016
ARG PNPM_VERSION=12.8.1
ARG NPM_VERSION=12.2.0
# Init for PID 1 (reaps orphaned tool processes, forwards signals). MIT ("Expat").
ARG TINI_VERSION=0.19.0-3+b8

# kobe-sandbox-agent, built and deployed with production dependencies only (ships dist/ only).
FROM ${NODE_IMAGE} AS agent
ARG PNPM_VERSION
RUN npm install -g pnpm@${PNPM_VERSION}
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile \
 && pnpm turbo run build --filter=@kobe/sandbox-agent... \
 && pnpm --filter=@kobe/sandbox-agent deploy --prod --legacy /out

# kobe-runas (KOBE-71): the one privileged file in the image. Starts each Pi process (and so the
# tools it runs) under its own uid; static, so the runtime image needs no compiler.
FROM ${PYTHON_IMAGE} AS runas
RUN apt-get update \
 && apt-get install -y --no-install-recommends gcc libc6-dev \
 && rm -rf /var/lib/apt/lists/*
COPY images/sandbox/runas/kobe-runas.c /src/kobe-runas.c
RUN mkdir /out && gcc -std=c11 -O2 -Wall -Wextra -Werror -static-pie -fPIE -D_FORTIFY_SOURCE=2 \
      -fstack-protector-strong -Wl,-z,relro,-z,now -o /out/kobe-runas /src/kobe-runas.c

# Node runtime with a pinned npm, and Pi 1.0.x from its lockfile (spec D13). Dependency install
# scripts are not run (Pi works without them; they would run as root at build time).
FROM ${NODE_IMAGE} AS pi
ARG NPM_VERSION
RUN npm install -g "npm@${NPM_VERSION}" && npm cache clean --force
WORKDIR /opt/pi
COPY images/sandbox/pi/package.json images/sandbox/pi/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

FROM ${PYTHON_IMAGE}
ARG TINI_VERSION
ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    MPLCONFIGDIR=/tmp/matplotlib \
    HOME=/home/kobe

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates git curl jq ripgrep unzip zip file less procps libcap2-bin "tini=${TINI_VERSION}" \
 && rm -rf /var/lib/apt/lists/*

# Fully locked with hashes (pip-compile --generate-hashes from requirements.in).
COPY images/sandbox/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir --require-hashes --no-deps -r /tmp/requirements.txt && rm /tmp/requirements.txt

COPY --from=pi /usr/local/bin/node /usr/local/bin/node
COPY --from=pi /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
COPY --from=pi /opt/pi /opt/pi
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && ln -s /opt/pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js /usr/local/bin/pi

COPY --from=agent /out/dist /opt/kobe/sandbox-agent/dist
COPY --from=agent /out/node_modules /opt/kobe/sandbox-agent/node_modules
COPY --from=agent /out/package.json /opt/kobe/sandbox-agent/package.json
COPY images/sandbox/entrypoint.sh /opt/kobe/entrypoint.sh
COPY --from=runas /out/kobe-runas /opt/kobe/bin/kobe-runas
COPY images/sandbox/runas/kobe-reclaim.sh /opt/kobe/bin/kobe-reclaim
# kobe-policy (KOBE-36): the Pi extension that asks the server about every tool call. Loaded by the
# agent with --extension, last; root-owned and read-only so sandbox code cannot replace it. Only the
# compiled .js files (it imports nothing but node builtins and its own files).
COPY --from=agent /out/dist/kobe-policy/*.js /opt/kobe/pi-extensions/kobe-policy/
# kobe-models (KOBE-41): the Pi extension that serves the run's model through the Kobe model
# gateway with the sandbox's session token. Loaded right before kobe-policy; root-owned and
# read-only; imports node builtins, Pi's own pi-ai and its own files only.
COPY --from=agent /out/dist/kobe-models/*.js /opt/kobe/pi-extensions/kobe-models/
# Egress for Pi's tools (KOBE-39): the BASH_ENV script that turns the agent's rotating egress
# token file into HTTPS_PROXY for each bash tool call. Root-owned and read-only: it runs in every
# tool's shell, so sandbox code must not be able to change it.
COPY images/sandbox/egress-env.sh /opt/kobe/egress-env.sh
# Built-in gallery skills (KOBE-88): SKILL.md bundles plus offline helper scripts over the Python
# stack above. Registered with Pi per run only when the run's effective skills list them
# (`run.start.config.builtin_skills`); root-owned and read-only below. Scripts run through an
# interpreter (`python scripts/x.py`), so no exec bit is needed.
COPY images/sandbox/skills/ /opt/kobe/skills/
ENV KOBE_BUILTIN_SKILLS_DIR=/opt/kobe/skills

# Users (KOBE-71): `kobe` (1000) runs kobe-sandbox-agent; group `kobe` (1000) is also the shared
# /workspace group (the pod's fsGroup). `kobe-agent` (1001) is a group only the agent has (pod
# supplementalGroups): it alone may execute kobe-runas. `kobe-pi-<n>` (2000+n, own group each) are
# the Pi identities: each Pi process and its tools run as one of them (the pod gives the agent
# their groups too, so it can hand a Pi its private runtime directory).
# /workspace is the persistent volume, /opt/kobe/skills holds the built-in gallery skills (KOBE-88,
# root-owned, read-only), /opt/kobe/pi-extensions the root-owned Pi extensions, /run/kobe-agent the
# agent-only directory the pod mounts the bootstrap token under, /run/kobe-pi the mount point of
# the volume the agent creates each Pi's private runtime directory in (KOBE-41/71).
# Setuid/setgid bits are stripped so sandbox code has no privilege-escalation helpers; the only
# privileged file is kobe-runas (file capabilities setuid+setgid, executable by `kobe-agent` only).
RUN groupadd --gid 1000 kobe \
 && useradd --uid 1000 --gid 1000 --create-home --home-dir /home/kobe --shell /bin/bash kobe \
 && groupadd --gid 1001 kobe-agent \
 && for n in $(seq 0 63); do \
      groupadd --gid $((2000 + n)) "kobe-pi-$n" \
      && useradd --uid $((2000 + n)) --gid $((2000 + n)) --no-create-home --home-dir /home/kobe \
           --shell /bin/bash "kobe-pi-$n" || exit 1; \
    done \
 && mkdir -p /workspace /opt/kobe/skills /run/kobe-agent /run/kobe-pi \
 && chown 1000:1001 /run/kobe-agent && chmod 0700 /run/kobe-agent \
 && chmod 0555 /opt/kobe/entrypoint.sh \
 && chown 0:0 /opt/kobe/egress-env.sh && chmod 0444 /opt/kobe/egress-env.sh \
 && chown -R 0:0 /opt/kobe/pi-extensions /opt/kobe/skills \
 && find /opt/kobe/skills -type d -exec chmod 0555 {} + \
 && find /opt/kobe/skills -type f -exec chmod 0444 {} + \
 && chmod 0444 /opt/kobe/pi-extensions/kobe-policy/*.js /opt/kobe/pi-extensions/kobe-models/*.js \
 && chmod 0555 /opt/kobe/pi-extensions /opt/kobe/pi-extensions/kobe-policy /opt/kobe/pi-extensions/kobe-models \
 && chown kobe:kobe /workspace \
 && find / -xdev -perm /6000 -type f -exec chmod a-s {} + \
 && chown 0:1001 /opt/kobe/bin/kobe-runas && chmod 0750 /opt/kobe/bin/kobe-runas \
 && chown 0:0 /opt/kobe/bin/kobe-reclaim && chmod 0555 /opt/kobe/bin/kobe-reclaim \
 && chmod 0755 /opt/kobe/bin \
 && setcap cap_setuid,cap_setgid=ep /opt/kobe/bin/kobe-runas \
 && chmod 0644 /etc/passwd /etc/group && chmod 0640 /etc/shadow

USER 1000:1000
WORKDIR /workspace
# tini is PID 1; the entrypoint disables core dumps and runs node with --disable-sigusr1. Pod specs
# must set `args` only, never `command` (that would bypass all three).
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/kobe/entrypoint.sh"]
