# KOBE-525: Measure load and render times for every Kobe component and record a baseline

- **Status:** instrumentation, measurement run and queries done on `group-hardening-3` (not
  pushed; the group PR carries it). **ac-4's gate1 numbers are pending**: this VM cannot reach
  gate1, so `docs/perf-baseline-2026-10-30.md` holds the method, the exact commands and queries,
  the bundle sizes (local build) and empty tables the coordinator fills after the deploy.
- **Branch / worktree:** `group-hardening-3` in `../Kobe-g-hardening-3`
- **Depends on:** KOBE-10/273 (OTel → Langfuse), KOBE-274 (run traces), KOBE-25 (lifecycle)

## Decisions

- **Spans, not metrics.** Langfuse 4's `/api/public/otel` takes traces only, so every latency is
  a span whose **duration is the latency**; percentiles need only `name`, `start_time`,
  `end_time` in ClickHouse `events_core` (`docs/perf/latency-queries.sql`). Where a name is
  fixed, a low-cardinality attribute groups (route template, wake reason, tool name).
- **Per-route request duration (ac-2):** server/scheduler and MCP proxy already name request
  spans `<METHOD> <route template>` with `http.route` and status (`honoTracing`); unchanged. Model
  gateway: `http.route` from `routeTemplate()` (Gemini model folded to `{model}`). Egress proxy:
  `http.route` (`CONNECT` / `http-upgrade`) and `kobe.setup_ms` (CONNECT → established, upgrade →
  verified TLS); the span's own duration is the tunnel's life, not a latency.
- **Run latencies (ac-2):** `RunLatency` (sandbox-wire/run-latency.ts), fed by `RunIngest`'s new
  `onFrame` hook with each translated frame: `run.pi_ready` (lease taken just before run.start →
  first Pi frame), `run.first_token` (→ first text or reasoning delta), `run.tool_call`
  (`tool.call` → `tool.result`, so the server's policy decision is inside). Spans go in the
  run's trace (`runParentContext`). Resumed runs record tool calls only.
- **Sandbox (ac-3):** `sandbox.wake` (lifecycle wake → pod Ready) with `sandbox.claim` (provider
  returned a running sandbox: warm-pool bind or resume) and `sandbox.pod_ready`, in the trace of
  the first run that waited; `claim_ms` also on the "sandbox woken/ensured" log line.
  `sandbox.agent_hello`: `sandboxes.state_changed_at` (wake start) → hello, when within 5 min
  (one extra read per hello, after `hello.ack`, never blocking it). Pi ready = `run.pi_ready`.
- **Web (ac-1):** `WebVitalsReporter` in the root layout (`useReportWebVitals`, no new
  dependency) batches reports and posts them (keepalive) on hide / every 10 s to
  `POST /v1/telemetry/web-vitals`: session required (CSRF origin check as all /v1), zod strict
  body (9 metric names, value 0..600000, ≤ 20 reports), 4 KiB body cap, 60/1 s token bucket
  per user. The server re-normalizes the route (ids → `[id]`, > 8 segments → `other`) and
  records `web.vital <metric> <route>` spans (CLS × 1000). No migration. Signed-out pages report
  nothing (no session); the lab run covers them.
- **Measurement run:** `e2e/browser/perf/` (not CI): `npm run perf:measure` with its own
  `playwright.perf.config.ts` (reuses `tests/auth.setup.ts`); routes come from `apps/web/app`'s
  `page.tsx` files; bundle sizes from Next 16's `.next/diagnostics/route-bundle-stats.json` plus
  gzip of the chunks (`npm run perf:bundles`). Pure helpers are tested with `node --test`
  (`npm run perf:test`, Node 24 type stripping; `.ts` imports, `allowImportingTsExtensions`).

## Open questions (for Chris or the coordinator)

- `events_core` layout verified on gate1 (Langfuse 4.56, 2026-10-30): `name`, `start_time`,
  `end_time`, attributes as parallel arrays `metadata_names` / `metadata_values` with keys prefixed
  `attributes.` (not a map); the queries read them with `arrayElement(..., indexOf(...))`.
- Chat milestones inside a page (thread open, composer ready, stream start) are not separate
  marks: the lab run times page loads, the field data has run latencies. A follow-up could add
  `performance.mark`s if a page turns out slow.
- Finding already: every route ships ~2.0–2.2 MB raw / 640–700 KB gz first-load JS (the
  workspace lives in the root layout) — a candidate follow-up once the gate1 numbers are in.

## Evidence (acceptance criteria → test or command output)

- **ac-1:** server `routes/web-vitals.test.ts` (span per report, refusals, 413, 429,
  `normalizeRoute`); web `lib/telemetry/web-vitals.test.ts`, `components/shell/web-vitals-reporter.test.tsx`;
  `npm run perf:test` in e2e/browser (10 pass: stats, routes, bundles, table);
  `playwright test -c playwright.perf.config.ts --list` lists setup + perf. Not run against a
  deployment here (no gate1 access; no browser host libraries on this VM).
- **ac-2:** server `sandbox-wire/run-latency.test.ts`; model-gateway `routes.test.ts`
  "routeTemplate"; egress `proxy.test.ts` "tracing (KOBE-525)" and the KOBE-10 span test
  (`http.route`); queries 1–4 in `docs/perf/latency-queries.sql`.
- **ac-3:** server `sandbox-lifecycle/timing.test.ts`; query 5.
- **ac-4:** `docs/perf-baseline-2026-10-30.md` (bundle table filled; gate1 tables pending).
