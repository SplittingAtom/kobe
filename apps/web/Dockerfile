# syntax=docker/dockerfile:1
# Build from the repository root: docker build -f apps/web/Dockerfile .
ARG NODE_VERSION=24
ARG PNPM_VERSION=12.8.1

FROM node:${NODE_VERSION}-slim AS build
ARG PNPM_VERSION
RUN npm install -g pnpm@${PNPM_VERSION}
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile \
 && pnpm turbo run build --filter=@kobe/web...

FROM node:${NODE_VERSION}-slim
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=8080 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=1000:1000 /repo/apps/web/.next/standalone ./
COPY --from=build --chown=1000:1000 /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=1000:1000 /repo/apps/web/public ./apps/web/public
# Numeric non-root user so Kubernetes runAsNonRoot can verify it.
USER 1000:1000
EXPOSE 8080
CMD ["node", "apps/web/server.js"]
