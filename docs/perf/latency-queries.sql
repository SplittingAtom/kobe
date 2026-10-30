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
