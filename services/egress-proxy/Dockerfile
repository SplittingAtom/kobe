# syntax=docker/dockerfile:1
# Build from the repository root: docker build -f services/egress-proxy/Dockerfile .
ARG NODE_VERSION=24
ARG PNPM_VERSION=12.8.1

FROM node:${NODE_VERSION}-slim AS build
ARG PNPM_VERSION
RUN npm install -g pnpm@${PNPM_VERSION}
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile \
 && pnpm turbo run build --filter=@kobe/egress-proxy... \
 && pnpm --filter=@kobe/egress-proxy deploy --prod --legacy /out

FROM node:${NODE_VERSION}-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out ./
# Files stay root-owned (read-only to the app); numeric non-root user so runAsNonRoot can verify it.
USER 1000:1000
EXPOSE 8080
CMD ["node", "dist/index.js"]
