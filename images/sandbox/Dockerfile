# syntax=docker/dockerfile:1
# Kobe sandbox image (spec D12, KOBE-21): the one image every agent sandbox runs under gVisor.
# Build from the repository root: docker build -f images/sandbox/Dockerfile .
ARG NODE_IMAGE=node:22-trixie-slim
ARG PYTHON_IMAGE=python:3.12-slim-trixie
ARG PNPM_VERSION=12.8.1
# Pi pinned to an exact 1.0.x release (spec D13).
ARG PI_VERSION=1.0.0

# kobe-sandbox-agent, built and deployed with production dependencies only.
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

# Pi coding agent (global install keeps its dependency tree self-contained).
FROM ${NODE_IMAGE} AS pi
ARG PI_VERSION
# npm itself is upgraded too: the copy bundled with Node lags on security fixes.
RUN npm install -g npm@latest \
 && npm install -g --omit=dev "@earendil-works/pi-coding-agent@${PI_VERSION}" \
 && npm cache clean --force

FROM ${PYTHON_IMAGE}
ENV DEBIAN_FRONTEND=noninteractive \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    MPLCONFIGDIR=/tmp/matplotlib \
    HOME=/home/kobe

RUN apt-get update \
 && apt-get upgrade -y --no-install-recommends \
 && apt-get install -y --no-install-recommends \
      ca-certificates git curl jq ripgrep unzip zip file less procps \
 && rm -rf /var/lib/apt/lists/*

COPY images/sandbox/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt && rm /tmp/requirements.txt

# Node 22 runtime (npm/npx included) and Pi.
COPY --from=pi /usr/local/bin/node /usr/local/bin/node
COPY --from=pi /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && ln -s ../lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js /usr/local/bin/pi

COPY --from=agent /out /opt/kobe/sandbox-agent

# Non-root user; /workspace is the persistent volume, /opt/kobe/skills holds gallery skills (A6).
RUN groupadd --gid 1000 kobe \
 && useradd --uid 1000 --gid 1000 --create-home --home-dir /home/kobe --shell /bin/bash kobe \
 && mkdir -p /workspace /opt/kobe/skills \
 && chown kobe:kobe /workspace

USER 1000:1000
WORKDIR /workspace
ENTRYPOINT ["node", "/opt/kobe/sandbox-agent/dist/index.js"]
