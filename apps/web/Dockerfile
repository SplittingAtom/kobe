# Build from the repository root: docker build -f apps/web/Dockerfile .
# No `# syntax=` directive: dockerd's built-in frontend parses this file, so builds don't start
# the external docker/dockerfile frontend container (it crashed intermittently on CI runners:
# "frontend grpc server closed unexpectedly").
# Digest-pinned: Node 24.22.1, whose bundled root store drops emSign ECC Root CA - G3 (KOBE-486).
ARG NODE_IMAGE=node:24-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
ARG PNPM_VERSION=12.8.1

FROM ${NODE_IMAGE} AS build
ARG PNPM_VERSION
RUN npm install -g pnpm@${PNPM_VERSION}
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile \
 && pnpm turbo run build --filter=@kobe/web...

FROM ${NODE_IMAGE}
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=8080 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /repo/apps/web/public ./apps/web/public
# Next.js needs a writable cache dir; everything else stays root-owned
RUN mkdir -p apps/web/.next/cache && chown 1000:1000 apps/web/.next/cache
# Kobe's license, NOTICE and third-party inventory (Apache-2.0 section 4, KOBE-375).
COPY LICENSE NOTICE THIRD_PARTY_LICENSES.md /usr/share/doc/kobe/
# Files stay root-owned (read-only to the app); numeric non-root user so runAsNonRoot can verify it.
USER 1000:1000
EXPOSE 8080
CMD ["node", "apps/web/server.js"]
