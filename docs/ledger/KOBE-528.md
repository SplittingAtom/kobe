# KOBE-528: Perf: MCP connector calls and the internal probe reach 0.8 s at p95

- **Status:** in progress (span in; numbers awaiting the next gate1 deploy)
- **Branch / worktree:** `kobe-527-perf` in `../Kobe-wt527` (shared with KOBE-527)
- **Depends on:** KOBE-525

## Decisions

- `mcp.upstream` (client span) wraps one upstream MCP session in `services/mcp-proxy/src/upstream.ts`
  (initialize, initialized, the request(s); not the best-effort session DELETE). Parent:
  `mcp.tools/call` for sandbox calls, the route span for the probe and app calls.
- Attributes: `kobe.upstream.kind` (`mcp` | `probe` | `app`; new optional `kind` on the upstream
  call, defaulting by method), `kobe.upstream.method` (`tools/call` | `tools/list`),
  `kobe.upstream.outcome` (`ok` or the `UpstreamFailure`), `kobe.upstream.error` (+ span status),
  `kobe.upstream.requests` (HTTP requests in the session: shows when a probe also reads `ui://`
  templates or a call lists tools first). Connector id, URL, tool and content stay off.
- The existing `mcp.tools/call` span keeps its `kobe.connector_id` (KOBE-274, unchanged).
- Queries 9 (route minus upstream per route, requests that reach no upstream apart), 9b (upstream
  by kind and outcome) and 9c (probes per hour) in `docs/perf/latency-queries.sql`.

## Probe cadence finding

- Schedule: `startConnectorRefresh` (`services/server/src/connectors/refresh.ts`), every
  `KOBE_CONNECTOR_REFRESH_SECONDS` (default 3600, chart `server.connectorRefreshSeconds`), one
  probe per pinned active connector, on every server replica (`startup/jobs.ts`).
- gate1 (query 9c, 2026-10-28..30): exactly 6 probes an hour. Server logs on both pods show a
  "connectors refreshed" pass (checked 3) each hour, ~17 s apart: the advisory lock is a try-lock
  that only prevents overlap, so each of the 2 replicas runs its own pass. Half the probes are
  redundant; with N replicas each connector is probed N times per interval.
- Not changed: the probe is background work no user waits on, at 6/hour the load is negligible,
  and a fix (skip a connector whose `refreshed_at` is younger than about half the interval) changes
  the refresh's DB logic and its tests, which is not a small change for this ticket. Suggested
  follow-up ticket; the cadence itself (hourly) is fine.
- The probe route should not count against the user-facing 300 ms budget (background job).

## Open questions (for Chris or the coordinator)

- File the "one refresh pass per interval across replicas" follow-up?
- Exclude `POST /internal/v1/probe` from the user-facing budget once query 9 shows its upstream share?

## Evidence (acceptance criteria → test or command output)

- ac-1: `services/mcp-proxy/src/mcp.test.ts` "tracing (KOBE-274)" (2 new: child of
  `mcp.tools/call`, kind `mcp`, no connector id; 401 → `auth_required` + error status),
  `services/mcp-proxy/src/probe.test.ts` "upstream span (KOBE-528)" (2: child of the route, exact
  attributes, request count 3; failure flagged).
- ac-2: awaiting gate1 numbers; `docs/perf-baseline-2026-10-30.md` "KOBE-528" table, filled from
  query 9 after the next deploy.
