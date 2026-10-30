# Performance baseline 2026-10-30 (KOBE-525)

Load and render times for every Kobe component, measured on the gate1 test install so slow
components can be found and fixed in follow-up tickets. **No optimisation is part of this
ticket.**

**Status:** method, instrumentation and queries are done (group branch `group-hardening-3`).
The gate1 numbers are not in yet: they need this branch deployed to gate1, which the coordinator
does, then runs the commands below and fills the tables marked _pending_. The bundle sizes are
from a local `next build` of the branch and are final.

## Budgets (proposed, for discussion)

| Tier                                 | Budget         |
| ------------------------------------ | -------------- |
| Web: LCP                             | < 2.5 s (p95)  |
| Web: INP                             | < 200 ms (p95) |
| Server and proxies, non-streaming    | p95 < 300 ms   |
| Sandbox cold start (wake → Pi ready) | < 20 s (p95)   |

## What is measured, and where

Every latency is recorded as a trace span whose duration is the latency (the gate1 backend,
Langfuse 4, ingests OTLP traces only; no metrics SDK). Attributes are route templates and
kinds, never ids or content (`captureContent` stays off).

| Tier                         | Span (name)                                                                 | Measures                                                                          | Code                                                                                  |
| ---------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Web                          | `web.vital <metric> <route>`                                                | TTFB, FCP, LCP, INP, CLS (×1000), Next.js hydration/render                        | `apps/web/components/shell/web-vitals-reporter.tsx` → `POST /v1/telemetry/web-vitals` |
| Server, scheduler, MCP proxy | `<METHOD> <route template>`                                                 | request duration per route (`http.route`, status)                                 | `packages/telemetry/src/hono.ts` (existing)                                           |
| Model gateway                | `model_gateway.request` + `http.route`                                      | request duration per inference route                                              | `services/model-gateway/src/routes.ts`                                                |
| Egress proxy                 | `egress.connection` + `kobe.setup_ms`                                       | tunnel set-up (CONNECT → established; upgrade → verified TLS)                     | `services/egress-proxy/src/proxy.ts`                                                  |
| Runs                         | `run.pi_ready`, `run.first_token`, `run.tool_call`                          | run.start → first Pi frame / first token; tool start → result                     | `services/server/src/sandbox-wire/run-latency.ts`                                     |
| Sandbox                      | `sandbox.wake`, `sandbox.claim`, `sandbox.pod_ready`, `sandbox.agent_hello` | wake → pod Ready, claim (warm-pool bind or resume), pod Ready, wake → agent hello | `services/server/src/sandbox-lifecycle/timing.ts`                                     |

The Playwright measurement run (`e2e/browser/perf/`) adds lab numbers per route: every page under
`apps/web/app` loaded N times, TTFB / FCP / LCP / CLS / DOM ready / load from the Performance API,
p50 / p95 per route, with the route's first-load JS. Dynamic routes (`[id]`) are listed with their
bundle size only unless `KOBE_PERF_IDS` names a concrete path. INP needs real input, so it comes
from the field data (query 6) only.

## How to reproduce (coordinator, after deploying the branch to gate1)

1. Let gate1 see real use for a day (the browser suite, `e2e/gate1.sh`, ordinary chats), and run
   the cold-start trials once so the sandbox spans have samples:
   `node dist/cli/cold-start.js --team-id <uuid> --user-id <uuid> --trials 20` in a server pod.
2. Web lab run, from a checkout of the branch (Playwright container, as for the browser suite):

   ```bash
   npx pnpm@12.8.1 --filter @kobe/web build      # for the bundle column
   cd e2e/browser && npm ci
   KOBE_BASE_URL=https://<gate1 host> KOBE_USER=<owner> KOBE_PW=<password> \
     KOBE_PERF_RUNS=5 npm run perf:measure
   # → perf-results/web-<date>.md (table) and .json (every page load)
   ```

3. Field data and backend latencies: run `docs/perf/latency-queries.sql` in the Langfuse
   ClickHouse (query 0 first: it checks how span attributes are stored and the queries' column
   names), as in the comment at the top of that file.
4. Paste the tables below, name the three slowest components per tier, and file one follow-up
   ticket per component over budget.

## Results

### Web: first-load JS per route (local `next build`, branch at c704a248 + KOBE-525)

All 82 routes ship 2071–2257 KB raw / 642–702 KB gzipped first-load JS: the root layout keeps
the whole workspace (chat, panels) mounted on every page, so a console or sign-in page loads the
chat's code too. Largest:

| Route                                      | KB raw | KB gz |
| ------------------------------------------ | -----: | ----: |
| `/admin/site/skill-tags/catalog/[id]/edit` |   2257 |   702 |
| `/admin/team/agents/[id]`, `/new`          |   2247 |   700 |
| `/me/agents/[id]`, `/new`                  |   2244 |   698 |
| `/me/skills/drafts/[id]`                   |   2227 |   693 |
| `/admin/site/gallery/[id]`                 |   2226 |   692 |
| `/me/skills/evals/[id]`                    |   2192 |   680 |
| smallest (`/`, `/threads`, `/sign-in`, …)  |   2071 |   642 |

Full list: `npm run perf:bundles` in `e2e/browser` after a build.

### Web: lab run on gate1 (p50 / p95) — _pending_

_Paste `perf-results/web-<date>.md` here._

### Web: field data (query 6) — _pending_

| Metric / route | n   | p50 | p95 |
| -------------- | --- | --- | --- |

### Server and scheduler, MCP proxy: per route (query 1) — _pending_

| Route | n   | p50 ms | p95 ms | p99 ms |
| ----- | --- | ------ | ------ | ------ |

### Model gateway (query 2) and egress proxy set-up (query 3) — _pending_

| Component | Route | n   | p50 ms | p95 ms | p99 ms |
| --------- | ----- | --- | ------ | ------ | ------ |

### Runs (query 4) — _pending_

| Span              | n   | p50 ms | p95 ms | p99 ms |
| ----------------- | --- | ------ | ------ | ------ |
| `run.pi_ready`    |     |        |        |        |
| `run.first_token` |     |        |        |        |
| `run.tool_call`   |     |        |        |        |

### Sandbox cold start and warm-pool claim (query 5) — _pending_

| Span                  | Reason | n   | p50 ms | p95 ms | p99 ms |
| --------------------- | ------ | --- | ------ | ------ | ------ |
| `sandbox.wake`        |        |     |        |        |        |
| `sandbox.claim`       |        |     |        |        |        |
| `sandbox.pod_ready`   |        |     |        |        |        |
| `sandbox.agent_hello` |        |     |        |        |        |

## Slowest three per tier — _pending_

| Tier | 1   | 2   | 3   |
| ---- | --- | --- | --- |

## Follow-up tickets (one per component over budget) — _pending_

| Component | Measured | Budget | Ticket |
| --------- | -------- | ------ | ------ |

## Limits of the method

- Server-side times are taken where the server sees them (frame arrival), so run latencies include
  the sandbox → server network hop; sandbox-side spans (KOBE-274) have the in-sandbox detail.
- `sandbox.agent_hello` is recorded only for a hello within 5 minutes of the wake's start; a pod
  restart inside that window would be counted as a cold start.
- After a failed ingest batch a run's frames are translated again, so a tool call can be counted
  twice (rare).
- Signed-out pages report no field data (the endpoint needs a session); the lab run covers them.
