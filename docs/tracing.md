# Tracing (OpenTelemetry)

Kobe's server, scheduler, MCP proxy, egress proxy and model gateway export traces over OTLP/HTTP.
Tracing is off unless an endpoint is set, and then registers nothing, so it costs nothing.

```yaml
telemetry:
  endpoint: http://otel-collector.observability:4318 # base URL; /v1/traces is appended
  headersSecret: otel-auth # optional Secret, key `headers` = name=value,name=value
  captureContent: false # install-level opt-in, see below
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
start, steer, stop), `mcp.tools/call`, `model_gateway.request` (GenAI attributes), `egress.connection`.

## Content capture

`telemetry.captureContent: true` (env `KOBE_OTEL_CAPTURE_CONTENT=true`) adds `url.query`,
`kobe.tool.input` / `kobe.tool.output` (MCP calls) and `gen_ai.prompt` (the model request body),
each truncated to 4096 characters. The gate is enforced twice: call sites add content only through
`contentAttributes()`, and the exporter wrapper (`packages/telemetry/src/content.ts`) drops any
content-keyed attribute when capture is off, whatever a call site recorded. Model responses are
not captured. Header values are never exported.

## Propagation

W3C `traceparent` only (no baggage). Incoming HTTP and WebSocket-upgrade requests join the
caller's trace; the MCP proxy passes it to the server's internal listener and the model gateway to
Bifrost. It is not sent to connector servers or the internet. The sandbox agent does not export or
propagate traces yet.

## Backends

- **Tempo**: point `endpoint` at an OpenTelemetry Collector (OTLP in, Tempo out), or at Tempo's
  OTLP/HTTP receiver (port 4318).
- **Langfuse**: `endpoint: https://<host>/api/public/otel`, `headersSecret` with
  `Authorization=Basic <base64 public:secret>`; enable `captureContent` to see prompts.
- **Phoenix**: `endpoint: http://phoenix:6006` (OTLP/HTTP at `/v1/traces`), optional
  `Authorization=Bearer <key>` header.
