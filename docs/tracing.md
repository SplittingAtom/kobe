# Tracing (OpenTelemetry)

Kobe's server, scheduler, MCP proxy, egress proxy and model gateway export traces over OTLP/HTTP.
Tracing is off unless an endpoint is set, and then registers nothing, so it costs nothing.

```yaml
telemetry:
  endpoint: http://otel-collector.observability:4318 # base URL; /v1/traces is appended
  headersSecret: otel-auth # optional Secret, key `headers` = name=value,name=value
  captureContent: false # site-level opt-in, see below
```

The proxies and the gateway restrict egress by NetworkPolicy: add the collector to
`mcpProxy.networkPolicy.extraEgress`, `egressProxy.networkPolicy.extraEgress` and
`modelGateway.networkPolicy.extraEgress`.

## What a span holds

Metadata only: span names, opaque ids (`kobe.team_id`, `kobe.user_id`, `kobe.thread_id`,
`kobe.agent_id`, `kobe.run_id`, `kobe.sandbox_id`), durations, HTTP method, route template, status
code, byte sizes, token counts (`gen_ai.usage.*`), the model name, outcomes. Never message text,
prompts, tool input or output, headers, or URLs (HTTP spans record the route template, never the
raw path; the query string is content). Errors record the error type, never its message.

Spans: `<METHOD> <route>` for each HTTP listener, `sandbox.ws.upgrade`, `sandbox.command` (run
start, steer, stop, compaction), `mcp.tools/call`, `model_gateway.request` (GenAI attributes),
`egress.connection`, `server_call.<purpose>` (titles and follow-ups), the run root `kobe.run`, and
the sandbox's `sandbox.run`, `sandbox.turn`, `sandbox.tool`, `sandbox.compaction` and
`sandbox.workspace_sync` (relayed, below). Tool spans carry the tool's name only as the server's
policy decision knows it (`unknown` otherwise) and the outcome; error codes are closed enums.
`mcp.tools/call` likewise names the tool only once the server resolved it to a pinned tool.

## Run traces and sessions

One run is one trace: its trace id is the run id's 32 hex digits and its root span `kobe.run` has
the run id's low 64 bits as span id, so every component places spans in it without a lookup, and
Langfuse scores can name a run's trace from the run id. The server records the root when the run
ends (with `kobe.trace.sandbox_spans_dropped` when sandbox spans were lost); its command spans for
the run (`run.start`, steer, stop) are children of the root and link to the request that caused
them. A compaction is its own run, so its own trace. Title and follow-up calls land in the trace of
the run that triggered them.

Every span of a run carries `session.id` = the thread id and `user.id` = the thread owner's user
id (an opaque uuid; never an email or a name), so Langfuse shows a conversation as one session.
The gateway takes both from the server's record of the run or from the server-call token, never
from the sandbox.

## Content capture

`telemetry.captureContent: true` (env `KOBE_OTEL_CAPTURE_CONTENT=true`) adds `url.query`,
`kobe.tool.input` / `kobe.tool.output` (MCP calls and the sandbox's tool spans) and `gen_ai.prompt`
(the model request body),
each truncated to 4096 characters. The gate is enforced twice: call sites add content only through
`contentAttributes()`, and the exporter wrapper (`packages/telemetry/src/content.ts`) drops any
content-keyed attribute when capture is off, whatever a call site recorded. Model responses are
not captured. Header values are never exported. With a Langfuse backend it also sends answer-rating comments with their
scores (below): Langfuse's operators can read them, and they outlive the thread's purge there.

## Answer ratings as scores

With a Langfuse endpoint (`…/api/public/otel`), a member's thumbs up or down on an answer
(KOBE-275) becomes a score on the run's trace: name `answer_feedback`, `BOOLEAN` (1 up, 0 down),
id = the rating's id (a change updates the score, clearing it deletes it), metadata = rating,
reason codes, team, thread, run, agent scope/id/version and model alias (ids and codes only, no
member id). The comment is sent only with `captureContent: true`. The server sends it to
Langfuse's public scores API with the exporter's own endpoint and headers, after the rating's
transaction commits, from one bounded queue per replica (changes to one rating coalesce; the worker
reads the current row, so replicas converge; a failed call is logged and dropped). Other backends
get no scores; the sandbox never sees the endpoint. A purged thread's ratings go from Postgres; the
scores stay in Langfuse under its own retention, like the trace.

## Propagation

W3C `traceparent` only (no baggage). Only the server's internal listener (behind its internal key)
joins a caller's trace. The public API does not: run trace ids are predictable, so joining would let
anyone who knows a run id write spans into that run's trace; every request starts its own trace.
Likewise **no listener a sandbox can reach joins a caller's trace** (the model
gateway, the MCP proxy, the egress proxy, the server's sandbox routes and WebSocket upgrade): run
trace ids are predictable, so a sandbox could otherwise write spans into any run's trace. The model
gateway opens `model_gateway.request` only after it attributed the call to a run (run token,
server-call token, or a leased advisory run id), in that run's trace; it uses an incoming
`traceparent` only for its parent span, and only when it names that very run's trace. Without an
attributed run the call starts a fresh trace. The MCP proxy passes its context to the server's
internal listener and the model gateway to Bifrost; nothing is sent to connector servers or the
internet.

## Sandbox spans

The sandbox holds no collector endpoint and no credential (the sandbox template has no
`KOBE_OTEL_*` variable; tests assert it). When the server's tracing is on, `run.start` and
`thread.compact` carry a trace context to agents that announce the `trace_spans` capability. The
agent records spans from Pi's RPC events for those runs only and sends them as `trace.spans` frames
over its existing WebSocket; Pi's model calls carry the current run or turn span as `traceparent`
(the run span is in Pi's model file before the prompt goes out; a turn's span replaces it once the
agent has seen the turn start, so a call racing that update hangs under the run span instead).
With tracing off the server sends no trace context, and the agent records and sends nothing.

The server takes a frame only for a run leased to that connection (a run it never held closes the
connection as a lease violation; a late frame is dropped quietly), parses each span on its own,
remaps span ids with a keyed HMAC per run (so a sandbox can never produce or overwrite another
span's id), drops duplicates and cycles, clamps times to the run, stamps team, user, thread, run,
sandbox and the session itself, and strips content attributes when capture is off. Relayed spans
go through their own bounded export queue (service name `kobe-sandbox-agent`), behind a per-replica
budget with a per-team share, so they never delay or evict the server's own spans; drops are
counted. Limits: 64 spans per frame, 10 frames per second per connection (counted on the decoded
frame type), 2048 spans per run, 512 buffered spans in the agent. A run's cap, seen-set and command
spans are kept per server replica, so a reconnect to the same replica keeps them; a run resumed on
another replica starts afresh there. The contract is `packages/protocol/src/sandbox-wire/trace-frames.ts`.

## Backends

- **Tempo**: point `endpoint` at an OpenTelemetry Collector (OTLP in, Tempo out), or at Tempo's
  OTLP/HTTP receiver (port 4318).
- **Langfuse**: `endpoint: https://<host>/api/public/otel` (in-cluster, the web Service on port
  3000 with the same path), `headersSecret` whose `headers` key is
  `Authorization=Basic <base64 of public-key:secret-key>`; enable `captureContent` to see prompts.
  Langfuse v4 stores spans in ClickHouse as events and has no traces list API: look at them in
  the UI. A self-hosted Langfuse is its own install (its own Postgres, ClickHouse, Valkey and S3),
  never part of this chart. If you use its chart's bundled SeaweedFS, set
  `global.seaweedfs.createClusterRole: false`: otherwise it grants pod create/delete in every
  namespace, including team sandbox namespaces.
- **Phoenix**: `endpoint: http://phoenix:6006` (OTLP/HTTP at `/v1/traces`), optional
  `Authorization=Bearer <key>` header.
