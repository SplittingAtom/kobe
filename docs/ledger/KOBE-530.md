# KOBE-530: Perf: the chat page (/) cold load and the root-layout bundle

- **Status:** in review (group branch; not pushed)
- **Branch / worktree:** `kobe-530-perf` in `../Kobe-wt530`
- **Depends on:** KOBE-525 (baseline, Web Vitals reporter)

## Plan

1. Reproduce the cold TTFB locally (`next build` + `next start`), separate module loading from the
   branding fetch.
2. Add the cheapest durable measurement: `Server-Timing` on HTML responses.
3. Attribute the `/` first-load JS (`next analyze`) and decide on splitting the root layout.

## Decisions

- **Server-Timing via `instrumentation.ts`, not `proxy.ts`.** Next 16 gives a render no way to set
  a response header and the proxy runs before the render, so `register()` installs a
  `diagnostics_channel` (`http.server.request.start`) subscriber: each request gets an id in
  `x-kobe-timing-id` (always replaced, a client cannot choose it), the root layout records
  `branding` under it, and `app` + `cold` are added just before the headers are written, HTML only.
  Registry on `globalThis` (instrumentation and app bundles are separate module graphs).
  The web has no OTel SDK, so no span (not added, as briefed).
- **Web Vitals reporter unchanged:** the server's strict schema (`services/server/src/routes/web-vitals.ts`)
  has no field for server timing.
- **No bundle split now** (reasons and the order to do it in: `docs/perf-baseline-2026-10-30.md`,
  section "KOBE-530"). Signed-out routes without the workspace come first when it is needed.
- Budget unchanged (watch item).

## Open questions (for Chris or the coordinator)

- gate1's split of the 1099 ms (module loading vs branding): measured after the next gate1 deploy,
  from the `Server-Timing` of a fresh web pod's first page.
- Why `/forgot-password` was also cold in the lab run (one web process should be cold once): a
  second web replica or a pod restart? Measured after the next gate1 deploy.
- Worth a follow-up: fetch the branding in `register()` and warm one render before Ready? And the
  failing-branding retry waits ≤ 1 s every 30 s (see the baseline doc).

## Evidence (acceptance criteria → test or command output)

- **ac-1:** `apps/web/lib/telemetry/server-timing.test.ts` (7 tests: id replaced, metrics, cold
  once, HTML only, forgotten after answer/close), `apps/web/app/layout.test.tsx` "root layout server
  timing (KOBE-530)". Local `next start` numbers in the baseline doc, section "KOBE-530"; e.g.
  unreachable server: `branding;dur=1002.6, app;dur=1326.1;…, cold;…` on the first `/`, then
  `app;dur≈15`.
- **ac-2:** decision and attribution in the baseline doc, section "KOBE-530" (from
  `next analyze -o`, `.next/diagnostics/analyze/data/analyze.data`, local only).
