# Performance baseline 2026-10-30 (KOBE-525)

Load and render times for every Kobe component, measured on the gate1 test install so slow
components can be found and fixed in follow-up tickets. **No optimisation is part of this
ticket.**

**Status:** measured on gate1 running main `b0634553` (PR #425 deployed 2026-10-30 ~09:30 UTC):
the web lab run, the field and backend tables below, and four follow-up tickets (KOBE-527 to
KOBE-530). Samples for runs and cold starts are still few (hours, not a day); rerun queries 4 and 5
after a day of use before acting on them. The bundle sizes are from a local `next build` of the
branch and are final.

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

| Tier                         | Span (name)                                                                                                     | Measures                                                                          | Code                                                                                  |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Web                          | `web.vital <metric> <route>`                                                                                    | TTFB, FCP, LCP, INP, CLS (×1000), Next.js hydration/render                        | `apps/web/components/shell/web-vitals-reporter.tsx` → `POST /v1/telemetry/web-vitals` |
| Server, scheduler, MCP proxy | `<METHOD> <route template>`                                                                                     | request duration per route (`http.route`, status)                                 | `packages/telemetry/src/hono.ts` (existing)                                           |
| Model gateway                | `model_gateway.request` + `http.route`                                                                          | request duration per inference route                                              | `services/model-gateway/src/routes.ts`                                                |
| Egress proxy                 | `egress.connection` + `kobe.setup_ms`                                                                           | tunnel set-up (CONNECT → established; upgrade → verified TLS)                     | `services/egress-proxy/src/proxy.ts`                                                  |
| Runs                         | `run.pi_ready`, `run.first_token`, `run.tool_call`                                                              | run.start → first Pi frame / first token; tool start → result                     | `services/server/src/sandbox-wire/run-latency.ts`                                     |
| Workspace writes (KOBE-529)  | `workspace.s3_put`, `workspace.reserve_tx`, `workspace.blob_tx`, `workspace.manifest_tx`, `workspace.lock_wait` | object store vs Postgres time inside the three write routes                       | `services/server/src/workspace-sync/write-spans.ts`                                   |
| App calls (server)           | `app_call.decide`, `app_call.credential`, `app_call.audit`, `app_call.proxy`                                    | steps of `POST /v1/team/apps/:appId/calls` (KOBE-527)                             | `services/server/src/apps/call.ts`                                                    |
| MCP proxy upstream           | `mcp.upstream` + `kobe.upstream.kind`                                                                           | one upstream MCP session (KOBE-527, KOBE-528)                                     | `services/mcp-proxy/src/upstream.ts`                                                  |
| Sandbox                      | `sandbox.wake`, `sandbox.claim`, `sandbox.pod_ready`, `sandbox.agent_hello`                                     | wake → pod Ready, claim (warm-pool bind or resume), pod Ready, wake → agent hello | `services/server/src/sandbox-lifecycle/timing.ts`                                     |

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

### Web: lab run on gate1 (p50 / p95)

main `b0634553` on gate1, 2026-10-30 ~10:00 UTC, Playwright 1.55.0 container on the build host,
5 loads per route (315 page loads, 81 routes; dynamic `[id]` routes were not visited, no
`KOBE_PERF_IDS`). The bundle column is empty because the container had no local `next build`; the
sizes are in the table above. Every signed-in route except `/` has LCP p95 under 900 ms; `/` and
`/forgot-password` show a ~1.1 s TTFB on their first (cold) load, `/admin/team/memory` once.

| Route                                      | Visits | JS first load (KB raw / gz) | TTFB ms   | FCP ms     | LCP ms     | CLS           | DOM ready ms | Load ms    |
| ------------------------------------------ | ------ | --------------------------- | --------- | ---------- | ---------- | ------------- | ------------ | ---------- |
| `/`                                        | 5      | –                           | 37 / 1099 | 120 / 1164 | 432 / 1756 | 0.030 / 0.030 | 196 / 1151   | 196 / 1326 |
| `/admin`                                   | 5      | –                           | 37 / 52   | 84 / 96    | 84 / 96    | 0.039 / 0.052 | 107 / 119    | 108 / 161  |
| `/admin/site`                              | 5      | –                           | 20 / 44   | 64 / 104   | 256 / 400  | 0.030 / 0.076 | 98 / 126     | 98 / 177   |
| `/admin/site/[section]`                    | 0      | –                           | –         | –          | –          | –             | –            | –          |
| `/admin/site/appearance`                   | 5      | –                           | 34 / 48   | 84 / 92    | 276 / 372  | 0.030 / 0.030 | 103 / 134    | 103 / 226  |
| `/admin/site/audit`                        | 5      | –                           | 16 / 34   | 64 / 76    | 256 / 292  | 0.030 / 0.049 | 87 / 95      | 87 / 143   |
| `/admin/site/audit-forwarding`             | 5      | –                           | 26 / 28   | 56 / 84    | 260 / 336  | 0.030 / 0.030 | 81 / 118     | 81 / 172   |
| `/admin/site/backup`                       | 5      | –                           | 39 / 45   | 72 / 116   | 284 / 388  | 0.031 / 0.033 | 95 / 128     | 95 / 128   |
| `/admin/site/break-glass`                  | 5      | –                           | 30 / 45   | 72 / 108   | 256 / 344  | 0.030 / 0.030 | 96 / 131     | 96 / 166   |
| `/admin/site/connectors`                   | 5      | –                           | 24 / 35   | 64 / 92    | 260 / 296  | 0.028 / 0.030 | 86 / 116     | 106 / 156  |
| `/admin/site/egress`                       | 5      | –                           | 35 / 42   | 76 / 80    | 272 / 456  | 0.028 / 0.030 | 102 / 108    | 102 / 175  |
| `/admin/site/gallery`                      | 5      | –                           | 19 / 38   | 60 / 92    | 264 / 324  | 0.045 / 0.062 | 88 / 119     | 88 / 175   |
| `/admin/site/gallery/[id]`                 | 0      | –                           | –         | –          | –          | –             | –            | –          |
| `/admin/site/invites`                      | 5      | –                           | 27 / 38   | 68 / 88    | 368 / 524  | 0.029 / 0.050 | 88 / 106     | 91 / 139   |
| `/admin/site/isolation`                    | 5      | –                           | 23 / 40   | 68 / 88    | 384 / 472  | 0.066 / 0.066 | 92 / 111     | 94 / 145   |
| `/admin/site/legal-hold`                   | 5      | –                           | 34 / 43   | 88 / 96    | 284 / 348  | 0.030 / 0.030 | 86 / 119     | 113 / 137  |
| `/admin/site/models`                       | 5      | –                           | 19 / 34   | 52 / 80    | 268 / 368  | 0.030 / 0.030 | 87 / 101     | 87 / 154   |
| `/admin/site/policy-floor`                 | 5      | –                           | 19 / 36   | 60 / 88    | 252 / 352  | 0.054 / 0.067 | 83 / 109     | 98 / 122   |
| `/admin/site/retention`                    | 5      | –                           | 34 / 44   | 88 / 104   | 284 / 352  | 0.030 / 0.030 | 113 / 125    | 113 / 174  |
| `/admin/site/roles`                        | 5      | –                           | 20 / 41   | 64 / 96    | 256 / 272  | 0.091 / 0.091 | 85 / 117     | 92 / 127   |
| `/admin/site/settings`                     | 5      | –                           | 18 / 35   | 68 / 76    | 432 / 456  | 0.030 / 0.114 | 89 / 100     | 89 / 144   |
| `/admin/site/skill-blocklist`              | 5      | –                           | 19 / 38   | 60 / 72    | 244 / 352  | 0.036 / 0.037 | 85 / 96      | 85 / 138   |
| `/admin/site/skill-registry`               | 5      | –                           | 28 / 40   | 60 / 92    | 436 / 484  | 0.030 / 0.075 | 91 / 112     | 103 / 151  |
| `/admin/site/skill-review`                 | 5      | –                           | 17 / 39   | 60 / 92    | 280 / 400  | 0.028 / 0.030 | 86 / 112     | 86 / 165   |
| `/admin/site/skill-review/[id]`            | 0      | –                           | –         | –          | –          | –             | –            | –          |
| `/admin/site/skill-tags`                   | 5      | –                           | 36 / 39   | 68 / 80    | 264 / 280  | 0.115 / 0.424 | 91 / 105     | 93 / 159   |
| `/admin/site/skill-tags/catalog/[id]`      | 0      | –                           | –         | –          | –          | –             | –            | –          |
| `/admin/site/skill-tags/catalog/[id]/edit` | 0      | –                           | –         | –          | –          | –             | –            | –          |
| `/admin/site/teams`                        | 5      | –                           | 23 / 40   | 68 / 84    | 276 / 360  | 0.030 / 0.030 | 96 / 107     | 105 / 140  |
| `/admin/site/usage`                        | 5      | –                           | 29 / 41   | 72 / 80    | 376 / 400  | 0.055 / 0.055 | 96 / 105     | 104 / 132  |
| `/admin/site/users`                        | 5      | –                           | 20 / 25   | 52 / 68    | 352 / 372  | 0.029 / 0.030 | 78 / 91      | 78 / 140   |
| `/admin/team`                              | 5      | –                           | 21 / 30   | 56 / 60    | 240 / 260  | 0.030 / 0.075 | 78 / 91      | 78 / 91    |
| `/admin/team/[section]`                    | 0      | –                           | –         | –          | –          | –             | –            | –          |
| `/admin/team/agent-evaluation`             | 5      | –                           | 15 / 20   | 56 / 80    | 268 / 408  | 0.030 / 0.030 | 85 / 112     | 86 / 152   |
| `/admin/team/agents`                       | 5      | –                           | 34 / 45   | 68 / 108   | 264 / 300  | 0.130 / 0.132 | 90 / 101     | 90 / 172   |
| `/admin/team/agents/[id]`                  | 0      | –                           | –         | –          | –          | –             | –            | –          |
| `/admin/team/agents/[id]/cases`            | 0      | –                           | –         | –          | –          | –             | –            | –          |
| `/admin/team/agents/[id]/cases/[caseId]`   | 0      | –                           | –         | –          | –          | –             | –            | –          |
| `/admin/team/agents/[id]/evals/[evalId]`   | 0      | –                           | –         | –          | –          | –             | –            | –          |
| `/admin/team/agents/new`                   | 5      | –                           | 30 / 34   | 68 / 84    | 404 / 492  | 0.030 / 0.031 | 93 / 112     | 102 / 167  |
| `/admin/team/audit`                        | 5      | –                           | 15 / 45   | 68 / 76    | 416 / 528  | 0.030 / 0.049 | 80 / 106     | 81 / 160   |
| `/admin/team/break-glass`                  | 5      | –                           | 31 / 37   | 64 / 88    | 248 / 280  | 0.029 / 0.030 | 88 / 119     | 100 / 164  |
| `/admin/team/budgets`                      | 5      | –                           | 22 / 35   | 64 / 88    | 276 / 384  | 0.030 / 0.030 | 85 / 113     | 92 / 129   |
| `/admin/team/connectors`                   | 5      | –                           | 24 / 37   | 64 / 76    | 240 / 256  | 0.030 / 0.030 | 92 / 99      | 95 / 144   |
| `/admin/team/egress`                       | 5      | –                           | 28 / 48   | 76 / 112   | 288 / 872  | 0.032 / 0.041 | 107 / 110    | 108 / 158  |
| `/admin/team/follow-ups`                   | 5      | –                           | 30 / 36   | 64 / 68    | 344 / 596  | 0.030 / 0.030 | 88 / 94      | 90 / 156   |
| `/admin/team/inventory`                    | 5      | –                           | 27 / 39   | 84 / 100   | 348 / 392  | 0.147 / 0.177 | 96 / 115     | 96 / 160   |
| `/admin/team/invites`                      | 5      | –                           | 27 / 37   | 64 / 72    | 248 / 260  | 0.030 / 0.050 | 85 / 98      | 85 / 143   |
| `/admin/team/members`                      | 5      | –                           | 27 / 35   | 60 / 76    | 332 / 420  | 0.029 / 0.030 | 84 / 97      | 96 / 151   |
| `/admin/team/memory`                       | 5      | –                           | 20 / 36   | 68 / 1052  | 384 / 1416 | 0.029 / 0.049 | 92 / 1035    | 92 / 1137  |
| `/admin/team/models`                       | 5      | –                           | 32 / 42   | 68 / 84    | 344 / 368  | 0.029 / 0.030 | 85 / 102     | 85 / 158   |
| `/admin/team/policy`                       | 5      | –                           | 14 / 40   | 56 / 72    | 304 / 332  | 0.056 / 0.058 | 76 / 97      | 76 / 160   |
| `/admin/team/retention`                    | 5      | –                           | 14 / 33   | 88 / 108   | 400 / 488  | 0.029 / 0.030 | 112 / 168    | 117 / 168  |
| `/admin/team/schedules`                    | 5      | –                           | 18 / 36   | 68 / 84    | 256 / 440  | 0.030 / 0.030 | 95 / 107     | 96 / 157   |
| `/admin/team/skill-review`                 | 5      | –                           | 21 / 29   | 52 / 92    | 224 / 352  | 0.030 / 0.054 | 75 / 116     | 98 / 124   |
| `/admin/team/skills`                       | 5      | –                           | 38 / 41   | 96 / 108   | 436 / 476  | 0.306 / 0.635 | 121 / 128    | 121 / 174  |
| `/admin/team/skills/[id]`                  | 0      | –                           | –         | –          | –          | –             | –            | –          |
| `/admin/team/usage`                        | 5      | –                           | 28 / 39   | 72 / 84    | 356 / 700  | 0.030 / 0.030 | 96 / 107     | 102 / 150  |
| `/admin/team/web-search`                   | 5      | –                           | 28 / 37   | 68 / 104   | 344 / 480  | 0.030 / 0.030 | 92 / 115     | 92 / 163   |
| `/forgot-password`                         | 5      | –                           | 27 / 1113 | 68 / 1192  | 68 / 1192  | 0.000 / 0.000 | 145 / 1154   | 145 / 1552 |
| `/invite`                                  | 5      | –                           | 29 / 253  | 48 / 400   | 184 / 648  | 0.000 / 0.000 | 153 / 369    | 156 / 531  |
| `/me/agents`                               | 5      | –                           | 35 / 54   | 80 / 96    | 268 / 276  | 0.030 / 0.030 | 94 / 126     | 94 / 191   |
| `/me/agents/[id]`                          | 0      | –                           | –         | –          | –          | –             | –            | –          |
| `/me/agents/[id]/cases`                    | 0      | –                           | –         | –          | –          | –             | –            | –          |
| `/me/agents/[id]/cases/[caseId]`           | 0      | –                           | –         | –          | –          | –             | –            | –          |
| `/me/agents/new`                           | 5      | –                           | 23 / 39   | 52 / 116   | 376 / 484  | 0.030 / 0.036 | 74 / 141     | 74 / 141   |
| `/me/approvals`                            | 5      | –                           | 32 / 38   | 88 / 104   | 340 / 364  | 0.047 / 0.057 | 111 / 123    | 115 / 162  |
| `/me/connectors`                           | 5      | –                           | 16 / 33   | 68 / 84    | 232 / 244  | 0.029 / 0.030 | 91 / 106     | 91 / 155   |
| `/me/memory`                               | 5      | –                           | 20 / 42   | 64 / 100   | 228 / 272  | 0.052 / 0.073 | 82 / 125     | 82 / 173   |
| `/me/projects`                             | 5      | –                           | 20 / 39   | 72 / 96    | 244 / 444  | 0.030 / 0.036 | 96 / 120     | 96 / 142   |
| `/me/projects/[id]`                        | 0      | –                           | –         | –          | –          | –             | –            | –          |
| `/me/schedules`                            | 5      | –                           | 16 / 38   | 68 / 76    | 240 / 264  | 0.030 / 0.030 | 93 / 105     | 97 / 155   |
| `/me/shared-cases`                         | 5      | –                           | 17 / 34   | 72 / 96    | 340 / 404  | 0.036 / 0.036 | 94 / 117     | 104 / 132  |
| `/me/skills`                               | 5      | –                           | 22 / 41   | 76 / 96    | 364 / 440  | 0.062 / 0.137 | 99 / 119     | 102 / 146  |
| `/me/skills/catalog/[id]`                  | 0      | –                           | –         | –          | –          | –             | –            | –          |
| `/me/skills/drafts/[id]`                   | 0      | –                           | –         | –          | –          | –             | –            | –          |
| `/me/skills/evals/[id]`                    | 0      | –                           | –         | –          | –          | –             | –            | –          |
| `/reset-password`                          | 5      | –                           | 14 / 24   | 48 / 68    | 160 / 340  | 0.000 / 0.000 | 64 / 212     | 74 / 212   |
| `/setup`                                   | 5      | –                           | 25 / 35   | 60 / 72    | 204 / 360  | 0.000 / 0.000 | 146 / 248    | 166 / 248  |
| `/sign-in`                                 | 5      | –                           | 20 / 28   | 36 / 72    | 36 / 72    | 0.000 / 0.000 | 118 / 237    | 134 / 237  |
| `/threads`                                 | 5      | –                           | 28 / 34   | 68 / 84    | 388 / 440  | 0.030 / 0.075 | 86 / 110     | 86 / 110   |

### Web: field data (query 6)

The first hours after the deploy (the coordinator's own tabs and the browser suite; CLS ×1000):

| Metric / route              | n   | p50 | p95  |
| --------------------------- | --- | --- | ---- |
| `web.vital LCP /`           | 13  | 668 | 1796 |
| `web.vital FCP /`           | 13  | 120 | 1196 |
| `web.vital TTFB /`          | 13  | 33  | 1115 |
| `web.vital CLS /`           | 11  | 30  | 71   |
| `web.vital LCP /admin`      | 5   | 84  | 96   |
| `web.vital LCP /admin/site` | 2   | 256 | 256  |

### Server and scheduler, MCP proxy: per route (query 1)

Seven days to 2026-10-30 10:00 UTC, routes with at least 5 requests (164 routes); the
8 at or over the 300 ms p95 budget. `POST /v1/sandbox/session` is a long poll by design
(KOBE-417) and is excluded; the others are followed up below.

| Route                                     | n   | p50 ms | p95 ms | p99 ms |
| ----------------------------------------- | --- | ------ | ------ | ------ |
| `POST /v1/team/apps/:appId/calls`         | 36  | 595    | 1022   | 1143   |
| `POST /internal/v1/app-calls`             | 40  | 506    | 910    | 1092   |
| `POST /v1/mcp/:connectorId`               | 390 | 25     | 833    | 1706   |
| `POST /internal/v1/probe`                 | 924 | 287    | 819    | 896    |
| `POST /v1/sandbox/session`                | 68  | 226    | 623    | 20158  |
| `POST /v1/workspace/files`                | 14  | 245    | 442    | 442    |
| `PUT /v1/sandbox/workspace/blobs/:sha256` | 24  | 204    | 405    | 500    |
| `PUT /v1/workspace/file`                  | 16  | 222    | 307    | 307    |

### Model gateway (query 2) and egress proxy set-up (query 3)

Gateway spans include the upstream model's time (Bifrost → provider), so the inference route is
not held to the 300 ms budget. Spans from before this deploy carry no `http.route` (the empty
row). No `egress.connection` span fell in the window: the agent opened no tunnel.

| Component     | Route                  | n      | p50 ms | p95 ms | p99 ms |
| ------------- | ---------------------- | ------ | ------ | ------ | ------ |
| model gateway | `/v1/chat/completions` | 12     | 1102   | 1642   | 1642   |
| model gateway | `/healthz`             | 313    | 1      | 2      | 2      |
| model gateway | (pre-deploy, no route) | 362782 | 1      | 1      | 1      |
| egress proxy  | CONNECT / http-upgrade | 0      | –      | –      | –      |

### Runs (query 4)

Five runs since the deploy (the live check and the browser suite; short prompts, one tool call
each, `bash` p50 183 ms, `write` p50 127 ms):

| Span              | n   | p50 ms | p95 ms | p99 ms |
| ----------------- | --- | ------ | ------ | ------ |
| `run.pi_ready`    | 5   | 2658   | 2797   | 2797   |
| `run.first_token` | 5   | 4382   | 5006   | 5006   |
| `run.tool_call`   | 5   | 161    | 183    | 183    |

### Sandbox cold start and warm-pool claim (query 5)

One real cold start so far (a hibernated sandbox woken for the live check); `reconnect` rows are
wakes of running sandboxes after the server roll. The cold start is inside the 20 s budget.

| Span                  | Reason     | n   | p50 ms | p95 ms | p99 ms |
| --------------------- | ---------- | --- | ------ | ------ | ------ |
| `sandbox.wake`        | hibernated | 1   | 13238  | 13238  | 13238  |
| `sandbox.wake`        | reconnect  | 34  | 317    | 759    | 930    |
| `sandbox.claim`       | hibernated | 1   | 445    | 445    | 445    |
| `sandbox.claim`       | reconnect  | 34  | 266    | 729    | 866    |
| `sandbox.pod_ready`   | hibernated | 1   | 12793  | 12793  | 12793  |
| `sandbox.pod_ready`   | reconnect  | 34  | 36     | 64     | 75     |
| `sandbox.agent_hello` | –          | 1   | 13116  | 13116  | 13116  |

## Slowest three per tier

| Tier          | 1                                                         | 2                                            | 3                                  |
| ------------- | --------------------------------------------------------- | -------------------------------------------- | ---------------------------------- |
| Web (LCP p95) | `/` 1756 ms                                               | `/admin/team/memory` 1416 ms (one cold load) | `/admin/team/egress` 872 ms        |
| Server        | `POST /v1/team/apps/:appId/calls` 1022 ms                 | `POST /internal/v1/app-calls` 910 ms         | `POST /v1/mcp/:connectorId` 833 ms |
| Gateway       | `/v1/chat/completions` 1642 ms (model time)               | –                                            | –                                  |
| Runs          | `run.first_token` 5.0 s                                   | `run.pi_ready` 2.8 s                         | `run.tool_call` 183 ms             |
| Sandbox       | `sandbox.wake` hibernated 13.2 s (pod Ready 12.8 s of it) | `sandbox.agent_hello` 13.1 s                 | `sandbox.claim` reconnect 729 ms   |

## Follow-up tickets (one per component over budget)

Filed in Hadron (backlog, label `performance`), measure-and-explain first:

| Component                                                                         | Measured (p95)            | Budget    | Ticket   |
| --------------------------------------------------------------------------------- | ------------------------- | --------- | -------- |
| App calls (`POST /v1/team/apps/:appId/calls`, `/internal/v1/app-calls`)           | 1022 ms, 910 ms           | 300 ms    | KOBE-527 |
| MCP connector calls and probe (`POST /v1/mcp/:connectorId`, `/internal/v1/probe`) | 833 ms, 819 ms            | 300 ms    | KOBE-528 |
| Workspace writes (`POST /v1/workspace/files`, blob PUT, `PUT /v1/workspace/file`) | 442, 405, 307 ms          | 300 ms    | KOBE-529 |
| Chat page `/` cold load (LCP 1756 ms, TTFB 1099 ms); root-layout bundle           | within budget, watch item | LCP 2.5 s | KOBE-530 |

Within budget, no ticket: INP (no samples: the lab run does not interact), cold start 13.2 s
(< 20 s), every other route's LCP, the gateway's own overhead (~1 ms around the model).

### Workspace writes: object store vs Postgres (KOBE-529)

The three write routes record child spans under their server span
(`services/server/src/workspace-sync/write-spans.ts`), attributes low-cardinality only (write kind
`upload` / `drop` / `artifact` / `save` / `blob`, S3 operation, lock, outcome code; never ids,
paths or content; a failure carries its error type):

| Span                    | Covers                                                                                                                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspace.s3_put`      | one object-store call: `stream` (upload body → staging, includes receiving the body), `copy` (staging → content key), `put` (save; sandbox blob, streaming its body), `delete` (staging) |
| `workspace.reserve_tx`  | the read-only checks and the upload reservation transaction                                                                                                                              |
| `workspace.blob_tx`     | recording the stored blob and ending the reservation                                                                                                                                     |
| `workspace.manifest_tx` | the manifest/team transaction of an upload or save (lock, quotas, file row, audit)                                                                                                       |
| `workspace.lock_wait`   | inside `manifest_tx`: the workspace row lock, the team storage lock (save: with the team quota read)                                                                                     |

The sandbox blob PUT has no manifest transaction (its commit is a separate request), so it splits
into `reserve_tx`, `s3_put put`, `blob_tx`. Query 7a gives p50/p95 per child span and route, 7b the
request, object-store and Postgres time per route and the Kobe-side share (request minus its
object-store calls).

| Route                                     | n   | route p50 / p95 ms | S3 p50 / p95 ms | Postgres p50 / p95 ms | Kobe-side p95 ms | Kobe share p50 |
| ----------------------------------------- | --- | ------------------ | --------------- | --------------------- | ---------------- | -------------- |
| `POST /v1/workspace/files`                | 4   | 215 / 292          | 117 / 221       | 51 / 75               | 98               | 0.44           |
| `PUT /v1/sandbox/workspace/blobs/:sha256` | 2   | 207 / 207          | 179 / 179       | 36 / 36               | 41               | 0.26           |
| `PUT /v1/workspace/file`                  | 4   | 41 / 209           | 109 (n=1)       | 27 / 68               | 100              | –              |

Measured 2026-10-30 on gate1 at 2e086c54 from two runs of the `file-tab-outside-change` browser
spec (an upload, three saves of which two were unchanged and skipped the object store, and the
sandbox's `mv` commit). Small n, but the split is unambiguous: the object store is 55–75 % of a
write that stores bytes (`stream` 106 / 154 ms for a 20-byte upload body, `put` 109–179 ms, `copy`
60 ms), Postgres 27–75 ms, lock waits 0–9 ms, and the Kobe side (request minus S3) stays at
41–100 ms p95 on every route. The 7-day p95s of 307–442 ms were larger uploads: the S3 share grows
with the body, Kobe's does not.

**Proposed decision (for Chris):** routes whose request includes an object-store round trip (the
three writes above, and any later route that stores bytes) get their own budget: the Kobe-side
time (request minus `workspace.s3_put`) is held to the 300 ms p95 server budget, and the whole
request to p95 < 600 ms on gate1, where the object store is MinIO on the NAS over plain-HTTP LAN.
If query 7 shows the Kobe side itself above 300 ms (for example `lock_wait` or `manifest_tx`), that
part stays a performance ticket rather than being covered by the write budget.

### KOBE-527: app calls, server and proxy split

New spans: on the server, children of `POST /v1/team/apps/:appId/calls`: `app_call.decide`
(app, thread on screen, schema validation, policy at `app_bridge`), `app_call.credential` (key
or grant revealed; api_key/OAuth connectors only), `app_call.audit` (the allowed audit row) and
`app_call.proxy` (client span: mcp-proxy and the app backend), each with `kobe.app_call.outcome`
(a fixed reason or failure code) and, on credential and proxy, `kobe.app_call.error`. On the
proxy, `mcp.upstream` (kind `app`) under `POST /internal/v1/app-calls`. The proxy never joins a
caller's trace (KOBE-274), so the two halves are separate traces: query 8 splits the server
route, query 9 the proxy route. Code: `services/server/src/apps/call.ts`,
`services/mcp-proxy/src/upstream.ts`.

| Share (p50 / p95)                                 | ms                        |
| ------------------------------------------------- | ------------------------- |
| Server route (query 8 `route`)                    | 110 / 706 (n=24)          |
| of which Kobe server (`kobe`: decide, key, audit) | 87 / 131 (decide p95 86)  |
| of which `app_call.proxy` (hop + backend)         | 24 / 575 (share p50 0.50) |
| Proxy route (query 9, `/internal/v1/app-calls`)   | 20 / 543 (n=24)           |
| of which the app backend (`upstream`)             | 18 / 536 (share 0.98)     |
| of which Kobe proxy (`kobe`)                      | 1 / 5                     |

Measured 2026-10-30 on gate1 at 2e086c54 (`local-2e086c5496b2`): 24 `list_catalogs` calls on
the Lakehouse Explorer app from a server pod, two batches; the first call of each batch took
712 and 923 ms (the backend's cold session), the rest 41–242 ms. The 7-day p95 of 1022 ms is the
same shape: the app backend (Catalyst, through the proxy) is the tail, Kobe's two halves together
stay under ~140 ms at p95.

Budget verdict (ac-2): **excluded from the 300 ms route budget; the Kobe side is held to it
instead.** The backend's share dominates the tail (0.98 of the proxy route, about half of the
server route at p50 and nearly all of its p95), and Kobe's own time (server `kobe` p95 131 ms +
proxy `kobe` p95 5 ms) is within budget. Watch item: `app_call.decide` p95 86 ms (policy, schema,
member app lookup) is the largest Kobe step; a ticket only if it passes ~150 ms.

### KOBE-528: MCP connector calls and the probe, upstream split

New span: `mcp.upstream` (client span, one per upstream MCP session: initialize, initialized,
the request or requests; the best-effort session DELETE is outside it) under
`mcp.tools/call` for `POST /v1/mcp/:connectorId` and directly under the route for
`POST /internal/v1/probe`. Attributes: `kobe.upstream.kind` (`mcp`, `probe`, `app`),
`kobe.upstream.method`, `kobe.upstream.outcome` (`ok` or the failure kind),
`kobe.upstream.error`, `kobe.upstream.requests`; never the connector id, URL, tool or content.
Query 9 gives each route minus its upstream time (`kobe`), with requests that reach no upstream
(a sandbox's `tools/list`, refused calls: the 25 ms p50) listed apart; query 9b splits upstream
time by kind and outcome; query 9c counts probes per hour.

| Route (p50 / p95 ms)                                             | Route                      | Upstream              | Kobe side |
| ---------------------------------------------------------------- | -------------------------- | --------------------- | --------- |
| `POST /internal/v1/probe` (reached upstream)                     | 178 / 607 (n=15)           | 171 / 597 (share .98) | 3 / 26    |
| `POST /v1/mcp/:connectorId` (no upstream: `tools/list`, refused) | 23 / 56 (n=72)             | –                     | 23 / 56   |
| `POST /v1/mcp/:connectorId` (upstream `tools/call`)              | no sample since the deploy | –                     | –         |

Measured 2026-10-30 on gate1 at 2e086c54: 15 probes triggered through the site console's refresh
(3 connectors × 5; the sixth each is rate-limited) and the proxy requests of four owner runs. The
probe's time is the upstream MCP server's `tools/list` session (5 requests): Kobe's side is 26 ms
p95, so the 7-day 819 ms p95 is upstream. A sandbox's `tools/call` through the proxy had no sample
after the deploy: the owner's runs in Team1 received no Catalyst tools (the connector lists
`enabled_tools: []`; the earlier 7-day p50 of 25 ms is the same `tools/list` shape). Query 9
reports that row as soon as a member calls a connector tool; by the probe's split the expectation
is the same 0.98 upstream share.

Verdict (ac-2): **both routes leave the 300 ms user-facing budget; the Kobe side is held to it
instead** (probe 26 ms, connector calls 56 ms p95 so far). The internal probe is not user-facing at
all and should be excluded on that ground alone.

Probe cadence (query 9c, gate1, 2026-10-28 to 2026-10-30): a steady 6 probes an hour. The
refresh (`KOBE_CONNECTOR_REFRESH_SECONDS`, default 3600) runs on every server replica: the
advisory lock only stops two passes overlapping, so with `server.replicas: 2` both replicas probe
each of gate1's 3 pinned connectors about 17 s apart (server logs, "connectors refreshed",
checked 3 per pass on each pod). Half the probes are redundant; the probe is a background job
that no user waits for, so it is not a user-facing latency. Not changed here (see
`docs/ledger/KOBE-528.md`).

## KOBE-530: cold load of `/` and the root-layout bundle

**Cold TTFB.** Every HTML response now carries `Server-Timing` (`apps/web/lib/telemetry/server-timing.ts`,
enabled by `instrumentation.ts`): `app` (the web's time from request to response headers),
`branding` (the root layout's wait on the site branding) and `cold` on the first page a web process
serves. Lab runs and DevTools read it as `PerformanceNavigationTiming.serverTiming`; the Web Vitals
reporter does not forward it (the server's strict schema has no field for it).

Local `next build` + `next start` (dev box, amd64; `curl` TTFB, first request / later ones):

| `KOBE_SERVER_URL`             | First page of the process                   | Later pages (any route) |
| ----------------------------- | ------------------------------------------- | ----------------------- |
| unset (defaults)              | 410–570 ms (`branding` 0.3 ms)              | 12–50 ms                |
| stub server, answers at once  | 450–525 ms (`branding` 107 ms)              | 12–30 ms                |
| unreachable (packets dropped) | 1.33–1.40 s (`branding` 1003 ms, timed out) | 11–55 ms                |

The ~400–450 ms is per process, not per route: warming `/admin` first makes `/` 18–32 ms. It is
Next loading the app's server modules on the first render; the branding fetch adds its own time on
the same request (≤ 1 s timeout), after which it is cached. So gate1's 1099 ms p95 is the first page
after a web pod start: module loading plus the first branding fetch. The split on gate1 (2e086c54,
a fresh web pod's `Server-Timing` on `/sign-in`, read through a port-forward so no other request
reached it first): first page `app;dur=899.1` with `branding;dur=467.0` and `cold`, so about 430 ms
of module loading plus a 467 ms first branding fetch; the second and third pages `app;dur=20.0`
and `13.1` with `branding` under 0.1 ms. That matches the 1099 ms lab p95 and the local split. One hazard found: while
the branding endpoint fails, the loader retries with a wait every 30 s, so an unreachable server
costs up to 1 s on one render every 30 s (`branding;dur≈1000` shows it). Options if the cold load
matters: fetch the branding in `register()` and send one warm-up request before the pod is Ready.

**Root-layout bundle.** `next analyze` on `/` (per-module gzip, which over-counts the 642 KB by
~1.4×): Next + React DOM 177 KB, assistant-ui family 170, chat components and `lib/chat` 131,
markdown stack 51, shell 55, `@kobe/protocol` 46 + zod 35, lucide 25. Panels closed at first paint:
files 28, console panels and admin nav 23, apps host 14, artifact panel / context viewer / steering
/ palette / dialogs 24: about 65 KB real gzip, ~10 %. `"sideEffects": false` on `@kobe/protocol`
saves only 4 KB gzip (22 KB raw; tried, not kept). **Decision: no split now.** The panels are
imported across ~10 modules of `chat-app.tsx` (it even imports `FileGoneNotice` from
`file-tab.tsx`), so even the files panel needs more than one or two `next/dynamic` boundaries; the
saving is ≤ 10 %, LCP is within budget, and the cold TTFB is server-side. When `/` LCP p95 nears
2 s, or for light signed-out pages: first give the signed-out routes (`/sign-in`,
`/forgot-password`, `/reset-password`, `/invite`) a root layout without the workspace (they need
none of the chat), then `next/dynamic` for the files panel, console panels and apps host.

## Limits of the method

- Server-side times are taken where the server sees them (frame arrival), so run latencies include
  the sandbox → server network hop; sandbox-side spans (KOBE-274) have the in-sandbox detail.
- `sandbox.agent_hello` is recorded only for a hello within 5 minutes of the wake's start; a pod
  restart inside that window would be counted as a cold start.
- After a failed ingest batch a run's frames are translated again, so a tool call can be counted
  twice (rare).
- Signed-out pages report no field data (the endpoint needs a session); the lab run covers them.
