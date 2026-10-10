# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Kobe is a self-hosted, Apache-2.0 conversational agent platform for one organization and its teams,
deployed only with Helm on k3s. The agreed spec (32 decisions, D1–D32) lives outside this repo (path
in `CLAUDE.local.md`). Decisions there are
final — do not re-litigate them. Kobe inherits nothing from Catalyst Agents/Foundry.

Work is tracked in Hadron (project `kobe`, tickets KOBE-1..65, four phases each closed by a gate ticket).
Start each session by reading `docs/RUN-LEDGER.md` and running `scripts/hadron.sh ignite`; keep the ledger current.
Hand tickets to agents as in `docs/agent-prompt.md` (brief, model per job, short reports).
Several agents work in parallel: follow `docs/parallel-work.md` (worktree per ticket, per-ticket
ledger in `docs/ledger/`, tables in your area's `packages/db/src/tenancy/<area>.ts`, `db:rebase` for
migration conflicts).

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

There is no local Docker engine on the dev Mac; build on a remote amd64 Docker host via `DOCKER_HOST`.
Host names, cluster access and the dev Postgres URL are in `CLAUDE.local.md` (gitignored, local only):
this repository is public, so infrastructure details never go into tracked files (CI checks this).

## Architecture

- **Workspaces:** `apps/web` (Next.js 16 + assistant-ui), `services/{server,sandbox-agent,mcp-proxy,egress-proxy}`
  (Node 24, Hono), `packages/protocol` (Kobe Event Stream types shared by server and web),
  `packages/db` (Drizzle, RLS, cross-team probe suite), `tools/license-check`, `charts/kobe` (Helm).
- **Internal packages compile to `dist/`** and are consumed through `exports` → `dist`, so tests and
  typechecks of dependents need `^build` first (turbo handles this).
- **ESM everywhere**, TS `NodeNext` resolution: relative imports in services/packages use `.js` extensions.
  `apps/web` uses `Bundler` resolution.
- **Config is validated with zod at startup** (`src/config.ts` per service); invalid env fails fast.
- **Sandbox image:** `images/sandbox/Dockerfile` (Python 3.12 slim + Node 22 + Pi pinned 1.0.0 +
  `kobe-sandbox-agent` + data stack from `images/sandbox/requirements.txt`); checks in
  `images/sandbox/test-image.sh <image>`; built, tested and Trivy-scanned by
  `.github/workflows/sandbox-image.yml` (fails on fixable CRITICAL).
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
  role. The cross-team probe suite must stay green on every migration. One accepted exception
  (KOBE-120, user-approved 2026-10-10): the budget reservation functions (`kobe_reserve_budget` and
  friends) set the team themselves with transaction-local `set_config(..., true)` to stay one round
  trip; they are invoker-rights (never `SECURITY DEFINER`), pin `search_path`, and refuse when a
  different team is already in force. No other code may set the team outside `withTeam()`.
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
