# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Kobe is a self-hosted, Apache-2.0 conversational agent platform for one organization and its teams,
deployed only with Helm on k3s. The agreed spec (32 decisions, D1–D32) lives in the vault at
`~/Documents/AI Notes/Product Specs/Skunkwerks/Kobe/specs/Kobe — Product Spec.md`. Decisions there are
final — do not re-litigate them. Kobe inherits nothing from Catalyst Agents/Foundry.

Work is tracked in Hadron (project `kobe`, tickets KOBE-1..65, four phases each closed by a gate ticket).
Start each session by reading `docs/RUN-LEDGER.md` and running Hadron ignite; keep the ledger current.

## Commands

pnpm 12 is pinned via `packageManager`; if the global pnpm is older, prefix with `npx pnpm@12.8.1`.

```bash
pnpm install
pnpm build          # turbo; packages build before dependents (^build)
pnpm test           # vitest in every package (depends on ^build)
pnpm lint           # eslint flat config at repo root
pnpm typecheck
pnpm format:check   # prettier
pnpm license:check  # fails on deps outside MIT/Apache/BSD/MPL family

pnpm --filter @kobe/server test                              # one package
pnpm --filter @kobe/server exec vitest run src/app.test.ts   # one file
pnpm --filter @kobe/server exec vitest run -t "healthz"      # one test by name

pnpm images:check   # build every service image, assert non-root (needs Docker)
```

There is no local Docker engine on the dev Mac; build on a cluster node with
`DOCKER_HOST=ssh://claude@compute2.atom.splittingatom.io` (amd64, matching the cluster).
Cluster access: `ssh claude@compute1.atom.splittingatom.io` then `sudo k3s kubectl`.

## Architecture

- **Workspaces:** `apps/web` (Next.js 16 + assistant-ui), `services/{server,sandbox-agent,mcp-proxy,egress-proxy}`
  (Node 24, Hono), `packages/protocol` (Kobe Event Stream types shared by server and web),
  `packages/db` (Drizzle, RLS, cross-team probe suite), `tools/license-check`, `charts/kobe` (Helm).
- **Internal packages compile to `dist/`** and are consumed through `exports` → `dist`, so tests and
  typechecks of dependents need `^build` first (turbo handles this).
- **ESM everywhere**, TS `NodeNext` resolution: relative imports in services/packages use `.js` extensions.
  `apps/web` uses `Bundler` resolution.
- **Config is validated with zod at startup** (`src/config.ts` per service); invalid env fails fast.
- **Images:** one multi-stage Dockerfile per service, built from the repo root (`docker build -f
services/<svc>/Dockerfile .`), runtime `USER 1000:1000` (numeric, for `runAsNonRoot`). Node services
  ship via `pnpm deploy --prod --legacy`; web ships Next.js `standalone` output.

### Non-negotiables (enforced in review)

- k3s + Helm only — no `docker compose` anywhere, including dev (Tilt against k3s; k3d only in CI).
- Kobe refuses to run agents without a gVisor or Kata RuntimeClass; never add a bypass mode. Check the
  RuntimeClass **handler** (`runsc`/`kata*`), not its name.
- Secrets never enter sandboxes: models via Bifrost with a session token, MCP via `mcp-proxy`, internet
  via `egress-proxy`.
- Every team table: `team_id NOT NULL`, `ENABLE` + `FORCE ROW LEVEL SECURITY`, policy on
  `current_setting('kobe.team_id')` set with `SET LOCAL` inside `withTeam()`. App connects as a non-owner
  role. The cross-team probe suite must stay green on every migration.
- Server decides every tool call; approvals are HMAC-signed over (run_id, tool_call_id, canonical input).
  No approval bypass.
- Pi `1.0.x` in RPC mode behind `kobe-sandbox-agent`, which dials out over WSS; sandboxes accept no
  inbound connections. `pi-server` is not used in v1.
- No Redis: Postgres `LISTEN/NOTIFY` for fan-out hints; Postgres is always the durable record.
- Dependencies MIT/Apache/BSD/MPL only; exceptions documented in
  `tools/license-check/license-exceptions.json`. `sharp` is excluded (LGPL libvips).

### Version pins worth knowing

- TypeScript is pinned to `~6.0` because typescript-eslint does not support TS 7 yet.
- agent-sandbox on the cluster is v1.0.4; its CRDs are served as `v1beta1`
  (`agents.x-k8s.io/v1beta1` Sandbox, `extensions.agents.x-k8s.io/v1beta1` SandboxWarmPool/Template/Claim).
