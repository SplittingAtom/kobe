# syntax=docker/dockerfile:1
# Kobe sandbox image (spec D12, KOBE-21): the one image every agent sandbox runs under gVisor.
# Build from the repository root: docker build -f images/sandbox/Dockerfile .
# Every input is pinned (base digests, npm, Pi lockfile, hashed pip lock); bump deliberately.
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
      ca-certificates git curl jq ripgrep unzip zip file less procps "tini=${TINI_VERSION}" \
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

# Non-root user; /workspace is the persistent volume, /opt/kobe/skills holds gallery skills (A6,
# root-owned / mounted read-only). Strip setuid/setgid bits so sandbox code has no local
# privilege-escalation helpers even if a pod spec forgets allowPrivilegeEscalation=false.
RUN groupadd --gid 1000 kobe \
 && useradd --uid 1000 --gid 1000 --create-home --home-dir /home/kobe --shell /bin/bash kobe \
 && mkdir -p /workspace /opt/kobe/skills /opt/kobe/pi-agent \
 && chmod 0555 /opt/kobe/pi-agent /opt/kobe/entrypoint.sh \
 && chown kobe:kobe /workspace \
 && find / -xdev -perm /6000 -type f -exec chmod a-s {} + \
 && chmod 0644 /etc/passwd /etc/group && chmod 0640 /etc/shadow

USER 1000:1000
WORKDIR /workspace
# tini is PID 1; the entrypoint disables core dumps and runs node with --disable-sigusr1. Pod specs
# must set `args` only, never `command` (that would bypass all three).
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/kobe/entrypoint.sh"]
