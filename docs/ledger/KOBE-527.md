# KOBE-527: Perf: app calls take ~1 s at p95

- **Status:** in progress (spans in; numbers awaiting the next gate1 deploy)
- **Branch / worktree:** `kobe-527-perf` in `../Kobe-wt527` (shared with KOBE-528)
- **Depends on:** KOBE-525 (baseline, `honoTracing` route spans)

## Plan

Measure first: child spans for every step of an app call, queries that split Kobe time from the
app backend's, then the budget decision from gate1 numbers. No optimisation in this ticket.

## Decisions

- Server spans (children of `POST /v1/team/apps/:appId/calls`, `services/server/src/apps/call.ts`):
  `app_call.decide` (steps 1-4: app, thread on screen, schema validation, policy),
  `app_call.credential` (step 5, api_key/OAuth connectors only), `app_call.audit` (the allowed
  row: a hash-chained audit write, worth seeing on its own) and `app_call.proxy` (client span).
  Attribute `kobe.app_call.outcome` is a fixed `AppCallReason` or the proxy's failure code;
  `kobe.app_call.error` (+ span status) on credential and proxy. No ids, tool names or URLs.
- `callApp` was split into `decideCall` (steps 1-4) + the traced steps; behaviour and audit rows
  are unchanged (the team-apps DB suite stays green).
- Proxy side: `mcp.upstream` (kind `app`) under `POST /internal/v1/app-calls`, shared with
  KOBE-528 (see its ledger).
- There is no server policy re-check on this path: the proxy's app-calls route only calls the
  upstream (the server decided before forwarding). The "re-check" in the hand-off applies to
  sandbox MCP calls (`/v1/mcp/:connectorId`), not app calls.
- The server's proxy call carries no `traceparent`, and it would not help: the proxy's listener
  never joins a caller's trace (KOBE-274, sandboxes reach it). So server and proxy halves are
  separate traces, matched per service by `trace_id` in queries 7 and 8.

## Open questions (for Chris or the coordinator)

- After the deploy: if `mcp.upstream` (kind `app`) is most of the route's time, record the route
  as excluded from the 300 ms budget with that share (ac-2); otherwise file the dominant Kobe step.

## Evidence (acceptance criteria → test or command output)

- ac-1 (child spans): `services/server/src/team-apps.db.test.ts` "tracing (KOBE-527)" (3 tests:
  all four steps under the route with their attributes and no ids; a denial on the decide span
  and no proxy span; a failed proxy answer flagged as an error);
  `services/mcp-proxy/src/app-calls.test.ts` "upstream span (KOBE-527)" (2 tests).
- ac-2: awaiting gate1 numbers. Queries 7 and 8 in `docs/perf/latency-queries.sql` (syntax run on
  gate1's ClickHouse 2026-10-30: zero rows, the spans are not deployed yet); results go in
  `docs/perf-baseline-2026-10-30.md` "KOBE-527".
