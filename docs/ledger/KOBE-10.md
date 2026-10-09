# KOBE-10: OpenTelemetry tracing (metadata-only default)

- **Status:** in review
- **Branch / worktree:** `kobe-10-otel-tracing` in `../Kobe-wt10`
- **Depends on:** KOBE-23, KOBE-30 (merged)

## Plan

New `packages/telemetry` (`@kobe/telemetry`); wire server, mcp-proxy, egress-proxy, model-gateway;
chart `telemetry.*`; docs in `docs/tracing.md`. No DB migration.

## Decisions

- Env (`KOBE_OTEL_ENDPOINT`, `_HEADERS`, `_CAPTURE_CONTENT`) validated by one zod schema in the
  package, called from each service's `index.ts`; no endpoint = nothing registered (API no-op).
- Content gate twice: `contentAttributes()` at call sites, plus `ContentGuardExporter` dropping
  content-keyed attributes when capture is off.
- Explicit spans, no auto-instrumentation. Errors record type only. W3C context only.
- sandbox-agent / Pi `pi-telemetry` not done (lead scope: only if asked); the server accepts
  `traceparent` on the sandbox WS upgrade, so the sandbox can join later.
- Collector egress must be allowed in the proxies' NetworkPolicy (`extraEgress`).

## Open questions (for Chris or the coordinator)

- Pi `pi-telemetry` in the sandbox (BRIEF description) is left for a follow-up ticket.
- Model responses are not captured with capture on (prompt only).

## Evidence (acceptance criteria → test or command output)

- ac-1: spans with ids on server/mcp/gateway/egress: `app.test.ts`, `gateway.test.ts` (tracing),
  `proxy.test.ts` (tracing), `packages/telemetry/src/*.test.ts`. A live collector run was not done.
- ac-2: `packages/telemetry/src/spans.test.ts` ("exports metadata only by default"), gateway test.
- ac-3: same files ("includes content once capture is opted in"); chart `tests/telemetry.test.ts`.
