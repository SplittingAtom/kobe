# Kobe

Kobe is a self-hosted conversational agent platform for one organization and its teams: your own
Claude.ai-style workspace on your own k3s cluster. Agents run in gVisor-isolated sandboxes with a real
filesystem and shell, teams are isolated by Postgres row-level security, and every tool call is decided
by the server. Licensed under Apache-2.0.

> **Status:** pre-release, Phase 1 (Spine) in progress. Deployment is Helm on k3s only — there is no
> `docker compose`, including for development.

## Repository layout

| Path                     | What it is                                                             |
| ------------------------ | ---------------------------------------------------------------------- |
| `apps/web`               | Next.js + assistant-ui web app                                         |
| `services/server`        | Hono API server: REST + SSE, auth, runs, policy, sandbox orchestration |
| `services/sandbox-agent` | Sandbox main process: dial-out WSS, Pi RPC bridge                      |
| `services/mcp-proxy`     | Credential-holding MCP proxy                                           |
| `services/egress-proxy`  | Default-deny egress proxy                                              |
| `packages/protocol`      | Kobe Event Stream schema shared by server and web                      |
| `packages/db`            | Drizzle schema, migrations, RLS policies, cross-team probe suite       |
| `tools/license-check`    | Dependency license policy check                                        |
| `images/sandbox`         | The one sandbox image agents run in (gVisor)                           |
| `charts/kobe`            | Helm umbrella chart                                                    |

## Dev quickstart

Prerequisites: Node 24 (see `.nvmrc`) and pnpm 12 (pinned in `package.json`; `npx pnpm@12.8.1` works
if your global pnpm is older).

```bash
pnpm install
pnpm build        # turbo builds every package in dependency order
pnpm test         # vitest in every package
pnpm lint
pnpm typecheck
pnpm format:check
pnpm license:check  # fails on any dependency outside the MIT/Apache/BSD/MPL family
```

Run one package's tests, or a single test file / test name:

```bash
pnpm --filter @kobe/server test
pnpm --filter @kobe/server exec vitest run src/app.test.ts
pnpm --filter @kobe/server exec vitest run -t "healthz"
```

Build every service image and verify it runs as a non-root user (needs a Docker engine; set
`DOCKER_HOST` to build remotely):

```bash
pnpm images:check
```

The k3s dev loop (Tilt) and the Helm install are added in KOBE-6 and KOBE-7.

## License

Apache-2.0 — see [LICENSE](LICENSE). Dependencies are restricted to MIT/Apache/BSD/MPL-family
licenses; justified exceptions are documented in `tools/license-check/license-exceptions.json`.
