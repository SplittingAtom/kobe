-- Kobe latency baseline queries (KOBE-525) for a Langfuse 4 trace backend, whose OTLP endpoint
-- stores Kobe's spans in ClickHouse table `events_core` (Langfuse 4 has no traces API).
--
-- Every latency Kobe records is a span whose duration is the latency, so the queries below need
-- only span names and times. Attributes are used for grouping only where the name is fixed
-- (model gateway, egress proxy, wake reason).
--
-- Run (on the cluster; see docs/perf-baseline-2026-10-30.md for the exact command):
--   kubectl -n <langfuse namespace> exec -i clickhouse-0 -- \
--     clickhouse-client --user <user> --password "$CLICKHOUSE_PASSWORD" --multiquery \
--     < docs/perf/latency-queries.sql
--
-- Window: the last 7 days. Percentiles are exact (the volumes here are small).

-- 0. Schema check (verified on gate1, Langfuse 4.56, 2026-10-30): span attributes are not a map but
--    two parallel arrays, `metadata_names` / `metadata_values`, with OTel attribute keys prefixed
--    `attributes.` (resource attributes `resourceAttributes.`). `arrayElement(metadata_values, indexOf(metadata_names, 'attributes.<key>'))` reads one; if a
--    newer Langfuse stores them differently, the second query shows the keys to adapt it to.
DESCRIBE TABLE events_core FORMAT PrettyCompact;
SELECT name, metadata_names
  FROM events_core
 WHERE name IN ('model_gateway.request', 'egress.connection', 'sandbox.wake')
 ORDER BY start_time DESC
 LIMIT 3
FORMAT Vertical;

-- 1. Server (API and scheduler replicas, same code) and MCP proxy: per-route request duration.
--    Span names are `<METHOD> <route template>` (honoTracing). Streaming routes (event streams,
--    `.../events`) last as long as the stream and are listed for completeness only.
SELECT name AS route,
       count() AS n,
       round(quantileExact(0.50)(dateDiff('millisecond', start_time, end_time))) AS p50_ms,
       round(quantileExact(0.95)(dateDiff('millisecond', start_time, end_time))) AS p95_ms,
       round(quantileExact(0.99)(dateDiff('millisecond', start_time, end_time))) AS p99_ms
  FROM events_core
 WHERE start_time > now() - INTERVAL 7 DAY
   AND match(name, '^(GET|POST|PUT|PATCH|DELETE) /')
 GROUP BY name
HAVING n >= 5
 ORDER BY p95_ms DESC
FORMAT PrettyCompact;

-- 2. Model gateway: per-route duration (span `model_gateway.request`, attribute `http.route`).
--    Streaming completions last until the model finishes (time to first token is query 4).
SELECT arrayElement(metadata_values, indexOf(metadata_names, 'attributes.http.route')) AS route,
       count() AS n,
       round(quantileExact(0.50)(dateDiff('millisecond', start_time, end_time))) AS p50_ms,
       round(quantileExact(0.95)(dateDiff('millisecond', start_time, end_time))) AS p95_ms,
       round(quantileExact(0.99)(dateDiff('millisecond', start_time, end_time))) AS p99_ms
  FROM events_core
 WHERE start_time > now() - INTERVAL 7 DAY
   AND name = 'model_gateway.request'
 GROUP BY route
 ORDER BY p95_ms DESC
FORMAT PrettyCompact;

-- 3. Egress proxy: tunnel set-up time (CONNECT → Connection Established; for http-upgrade:
--    request → verified upstream TLS), attribute `kobe.setup_ms`. The span itself lasts as long
--    as the tunnel, so its duration is not a latency.
SELECT arrayElement(metadata_values, indexOf(metadata_names, 'attributes.http.route')) AS route,
       count() AS n,
       quantileExact(0.50)(toUInt64OrNull(arrayElement(metadata_values, indexOf(metadata_names, 'attributes.kobe.setup_ms')))) AS p50_ms,
       quantileExact(0.95)(toUInt64OrNull(arrayElement(metadata_values, indexOf(metadata_names, 'attributes.kobe.setup_ms')))) AS p95_ms,
       quantileExact(0.99)(toUInt64OrNull(arrayElement(metadata_values, indexOf(metadata_names, 'attributes.kobe.setup_ms')))) AS p99_ms
  FROM events_core
 WHERE start_time > now() - INTERVAL 7 DAY
   AND name = 'egress.connection'
   AND arrayElement(metadata_values, indexOf(metadata_names, 'attributes.kobe.setup_ms')) != ''
 GROUP BY route
FORMAT PrettyCompact;

-- 4. Runs: run.start → Pi ready (first Pi frame), run.start → first model token, and the tool
--    call round trip (start → result, the server's policy decision included).
SELECT name,
       count() AS n,
       round(quantileExact(0.50)(dateDiff('millisecond', start_time, end_time))) AS p50_ms,
       round(quantileExact(0.95)(dateDiff('millisecond', start_time, end_time))) AS p95_ms,
       round(quantileExact(0.99)(dateDiff('millisecond', start_time, end_time))) AS p99_ms
  FROM events_core
 WHERE start_time > now() - INTERVAL 7 DAY
   AND name IN ('run.pi_ready', 'run.first_token', 'run.tool_call')
 GROUP BY name
FORMAT PrettyCompact;

-- 4b. Tool call round trip per tool (the ten slowest at p95).
SELECT arrayElement(metadata_values, indexOf(metadata_names, 'attributes.kobe.tool.name')) AS tool,
       count() AS n,
       round(quantileExact(0.50)(dateDiff('millisecond', start_time, end_time))) AS p50_ms,
       round(quantileExact(0.95)(dateDiff('millisecond', start_time, end_time))) AS p95_ms
  FROM events_core
 WHERE start_time > now() - INTERVAL 7 DAY
   AND name = 'run.tool_call'
 GROUP BY tool
 ORDER BY p95_ms DESC
 LIMIT 10
FORMAT PrettyCompact;

-- 5. Sandbox cold start: wake → pod Ready (`sandbox.wake`), split into the claim (SandboxClaim
--    bound to a warm-pool pod, or the Sandbox resumed: `sandbox.claim`) and pod Ready
--    (`sandbox.pod_ready`); wake → agent hello (`sandbox.agent_hello`). Pi ready is query 4.
SELECT name,
       arrayElement(metadata_values, indexOf(metadata_names, 'attributes.kobe.wake.reason')) AS reason,
       count() AS n,
       round(quantileExact(0.50)(dateDiff('millisecond', start_time, end_time))) AS p50_ms,
       round(quantileExact(0.95)(dateDiff('millisecond', start_time, end_time))) AS p95_ms,
       round(quantileExact(0.99)(dateDiff('millisecond', start_time, end_time))) AS p99_ms
  FROM events_core
 WHERE start_time > now() - INTERVAL 7 DAY
   AND name IN ('sandbox.wake', 'sandbox.claim', 'sandbox.pod_ready', 'sandbox.agent_hello')
 GROUP BY name, reason
 ORDER BY name, reason
FORMAT PrettyCompact;

-- 6. Web Vitals from browsers (field data): spans `web.vital <metric> <route>`, lasting the
--    metric (CLS: 1000 × the score, so divide by 1000).
SELECT name,
       count() AS n,
       round(quantileExact(0.50)(dateDiff('millisecond', start_time, end_time))) AS p50,
       round(quantileExact(0.95)(dateDiff('millisecond', start_time, end_time))) AS p95
  FROM events_core
 WHERE start_time > now() - INTERVAL 7 DAY
   AND startsWith(name, 'web.vital ')
 GROUP BY name
 ORDER BY name
FORMAT PrettyCompact;

-- 7. Workspace writes (KOBE-529): the child spans of the three write routes, which split object
--    store time (`workspace.s3_put`, attribute `kobe.workspace.s3_op`: stream / copy / put /
--    delete) from Postgres (`workspace.reserve_tx`, `workspace.blob_tx`, `workspace.manifest_tx`,
--    and `workspace.lock_wait` inside the manifest transaction, attribute `kobe.workspace.lock`).
--    A server span is the root of its own trace (KOBE-274), so children join their route by
--    `trace_id`. An upload's `stream` also spans receiving the browser's body. `trace_id` is
--    assumed to be the column's name: check it in query 0's DESCRIBE before the first run.
--    7a: p50/p95 per child span (summed per request: an upload has two reserve transactions).
WITH routes AS (
       SELECT trace_id, name AS route
         FROM events_core
        WHERE start_time > now() - INTERVAL 7 DAY
          AND name IN ('POST /v1/workspace/files', 'PUT /v1/workspace/file',
                       'PUT /v1/sandbox/workspace/blobs/:sha256')),
     children AS (
       SELECT trace_id,
              if(name = 'workspace.s3_put',
                 concat(name, ' ', arrayElement(metadata_values, indexOf(metadata_names, 'attributes.kobe.workspace.s3_op'))),
                 if(name = 'workspace.lock_wait',
                    concat(name, ' ', arrayElement(metadata_values, indexOf(metadata_names, 'attributes.kobe.workspace.lock'))),
                    name)) AS child,
              sum(dateDiff('millisecond', start_time, end_time)) AS ms
         FROM events_core
        WHERE start_time > now() - INTERVAL 7 DAY
          AND startsWith(name, 'workspace.')
        GROUP BY trace_id, child)
SELECT r.route,
       c.child,
       count() AS n,
       round(quantileExact(0.50)(c.ms)) AS p50_ms,
       round(quantileExact(0.95)(c.ms)) AS p95_ms
  FROM children AS c
 INNER JOIN routes AS r ON r.trace_id = c.trace_id
 GROUP BY r.route, c.child
 ORDER BY r.route, c.child
FORMAT PrettyCompact;

-- 7b. Per write route: request, object store and Postgres time per request, and the Kobe-side
--     share (the request minus its object-store calls, over the request). Lock waits are inside
--     `manifest_tx`, so they are not added again.
WITH routes AS (
       SELECT trace_id, name AS route, dateDiff('millisecond', start_time, end_time) AS route_ms
         FROM events_core
        WHERE start_time > now() - INTERVAL 7 DAY
          AND name IN ('POST /v1/workspace/files', 'PUT /v1/workspace/file',
                       'PUT /v1/sandbox/workspace/blobs/:sha256')),
     split AS (
       SELECT trace_id,
              sumIf(dateDiff('millisecond', start_time, end_time), name = 'workspace.s3_put') AS s3_ms,
              sumIf(dateDiff('millisecond', start_time, end_time),
                    name IN ('workspace.reserve_tx', 'workspace.blob_tx', 'workspace.manifest_tx')) AS pg_ms
         FROM events_core
        WHERE start_time > now() - INTERVAL 7 DAY
          AND startsWith(name, 'workspace.')
        GROUP BY trace_id)
SELECT r.route,
       count() AS n,
       round(quantileExact(0.50)(r.route_ms)) AS route_p50_ms,
       round(quantileExact(0.95)(r.route_ms)) AS route_p95_ms,
       round(quantileExact(0.50)(s.s3_ms)) AS s3_p50_ms,
       round(quantileExact(0.95)(s.s3_ms)) AS s3_p95_ms,
       round(quantileExact(0.50)(s.pg_ms)) AS pg_p50_ms,
       round(quantileExact(0.95)(s.pg_ms)) AS pg_p95_ms,
       round(quantileExact(0.95)(greatest(r.route_ms - s.s3_ms, 0))) AS kobe_side_p95_ms,
       round(quantileExact(0.50)(if(r.route_ms > 0, greatest(r.route_ms - s.s3_ms, 0) / r.route_ms, 0)), 2) AS kobe_share_p50
  FROM routes AS r
 INNER JOIN split AS s ON s.trace_id = r.trace_id
 GROUP BY r.route
 ORDER BY r.route

-- 8. App calls (KOBE-527): where `POST /v1/team/apps/:appId/calls` spends its time on the server.
--    Child spans: `app_call.decide` (app, thread, schema validation, policy), `app_call.credential`
--    (key or grant revealed; api_key/oauth connectors only), `app_call.audit` (the allowed row) and
--    `app_call.proxy` (mcp-proxy + the app backend). Every request is a trace of its own (the
--    listeners never join a caller's trace), so spans are matched by `trace_id`; `kobe_*` is the
--    route minus the proxy round trip, per request. The proxy's own split is query 9.
SELECT count() AS n,
       round(quantileExact(0.50)(route_ms)) AS route_p50,
       round(quantileExact(0.95)(route_ms)) AS route_p95,
       round(quantileExact(0.95)(decide_ms)) AS decide_p95,
       round(quantileExact(0.95)(credential_ms)) AS credential_p95,
       round(quantileExact(0.95)(audit_ms)) AS audit_p95,
       round(quantileExact(0.50)(proxy_ms)) AS proxy_p50,
       round(quantileExact(0.95)(proxy_ms)) AS proxy_p95,
       round(quantileExact(0.50)(route_ms - proxy_ms)) AS kobe_p50,
       round(quantileExact(0.95)(route_ms - proxy_ms)) AS kobe_p95,
       round(sum(proxy_ms) / sum(route_ms), 2) AS proxy_share
  FROM (
        SELECT trace_id,
               sumIf(ms, name = 'POST /v1/team/apps/:appId/calls') AS route_ms,
               sumIf(ms, name = 'app_call.decide') AS decide_ms,
               sumIf(ms, name = 'app_call.credential') AS credential_ms,
               sumIf(ms, name = 'app_call.audit') AS audit_ms,
               sumIf(ms, name = 'app_call.proxy') AS proxy_ms,
               countIf(name = 'POST /v1/team/apps/:appId/calls') AS routes,
               countIf(name = 'app_call.proxy') AS proxied
          FROM (SELECT trace_id, name, dateDiff('millisecond', start_time, end_time) AS ms
                  FROM events_core
                 WHERE start_time > now() - INTERVAL 7 DAY
                   AND name IN ('POST /v1/team/apps/:appId/calls', 'app_call.decide',
                                'app_call.credential', 'app_call.audit', 'app_call.proxy'))
         GROUP BY trace_id
        HAVING routes = 1 AND proxied = 1
       )
FORMAT PrettyCompact;

-- 9. MCP proxy (KOBE-527, KOBE-528): each route minus its upstream round trip (`mcp.upstream`, one
--    per upstream MCP session: initialize, initialized, the request(s); the session DELETE is not
--    in it). `kobe_*` is the proxy's own share, including the policy decision with the server for
--    `/v1/mcp/:connectorId`. Requests that never reach an upstream (a sandbox's tools/list, a
--    refused call) are listed apart (`reached_upstream = 0`).
SELECT route,
       upstreams > 0 AS reached_upstream,
       count() AS n,
       round(quantileExact(0.50)(route_ms)) AS route_p50,
       round(quantileExact(0.95)(route_ms)) AS route_p95,
       round(quantileExact(0.50)(upstream_ms)) AS upstream_p50,
       round(quantileExact(0.95)(upstream_ms)) AS upstream_p95,
       round(quantileExact(0.50)(route_ms - upstream_ms)) AS kobe_p50,
       round(quantileExact(0.95)(route_ms - upstream_ms)) AS kobe_p95,
       round(sum(upstream_ms) / sum(route_ms), 2) AS upstream_share
  FROM (
        SELECT trace_id,
               anyIf(name, name != 'mcp.upstream') AS route,
               sumIf(ms, name != 'mcp.upstream') AS route_ms,
               sumIf(ms, name = 'mcp.upstream') AS upstream_ms,
               countIf(name = 'mcp.upstream') AS upstreams
          FROM (SELECT trace_id, name, dateDiff('millisecond', start_time, end_time) AS ms
                  FROM events_core
                 WHERE start_time > now() - INTERVAL 7 DAY
                   AND name IN ('POST /v1/mcp/:connectorId', 'POST /internal/v1/probe',
                                'POST /internal/v1/app-calls', 'mcp.upstream'))
         GROUP BY trace_id
        HAVING route != '' AND countIf(name != 'mcp.upstream') = 1
       )
 GROUP BY route, reached_upstream
 ORDER BY route, reached_upstream
FORMAT PrettyCompact;

-- 9b. Upstream round trips by kind (mcp: a sandbox's call, probe: the server's pinning probe,
--     app: an MCP App's own call), method and outcome, with the HTTP requests per session.
SELECT arrayElement(metadata_values, indexOf(metadata_names, 'attributes.kobe.upstream.kind')) AS kind,
       arrayElement(metadata_values, indexOf(metadata_names, 'attributes.kobe.upstream.method')) AS method,
       arrayElement(metadata_values, indexOf(metadata_names, 'attributes.kobe.upstream.outcome')) AS outcome,
       count() AS n,
       round(avg(toUInt32OrZero(arrayElement(metadata_values, indexOf(metadata_names, 'attributes.kobe.upstream.requests')))), 1) AS requests,
       round(quantileExact(0.50)(dateDiff('millisecond', start_time, end_time))) AS p50_ms,
       round(quantileExact(0.95)(dateDiff('millisecond', start_time, end_time))) AS p95_ms
  FROM events_core
 WHERE start_time > now() - INTERVAL 7 DAY
   AND name = 'mcp.upstream'
 GROUP BY kind, method, outcome
 ORDER BY kind, method, n DESC
FORMAT PrettyCompact;

-- 9c. Probes per hour (KOBE-528: the connector refresh cadence; one probe per pinned connector per
--     pass, plus registrations, pins and admins' re-probes).
SELECT toStartOfHour(start_time) AS hour, count() AS probes
  FROM events_core
 WHERE start_time > now() - INTERVAL 2 DAY
   AND name = 'POST /internal/v1/probe'
 GROUP BY hour
 ORDER BY hour
FORMAT PrettyCompact;
