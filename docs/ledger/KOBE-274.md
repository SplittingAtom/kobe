# KOBE-274: Sandbox agent tracing: run spans relayed through the server

- **Status:** contract amended after review (M1–M6, S1–S7, N1–N5); implementation in progress
- **Branch / worktree:** `group-2-quality` in `../Kobe-g2` (group branch, no own PR)
- **Depends on:** KOBE-10 (tracing), KOBE-273 (gate1 Langfuse), KOBE-118 (run tokens), KOBE-234 (server calls)

## Plan

1. Contract (ac-1): `packages/protocol/src/tracing.ts` (run trace ids, `traceparent`, session
   attributes, listener rule), `src/node/trace-span.ts` (`k_trace`, `mapSandboxSpanId`),
   `src/sandbox-wire/trace-frames.ts` (`trace.spans`, `run.start.trace`, `thread.compact.trace`,
   capability `trace_spans`, limits). Reviewed; amended in its own commit.
2. Telemetry: separate bounded relay pipeline; root span with fixed ids; no generic extraction on
   sandbox-reachable listeners.
3. Server: run root span and command spans in the run trace; trace context on `run.start` /
   `thread.compact`; `trace.spans` intake (lease, grace, rate, budgets, remap, clamp, re-attribution).
4. Sandbox agent: spans from Pi RPC events, bounded buffer, flush; `traceparent` on Pi's model calls.
5. Model gateway: span after attribution, in the run's trace; `session.id` / `user.id` from the server.
6. k3d e2e against an OTLP sink; docs/tracing.md.

## Decisions

- **Trace id = run id hex, root span id = its low 64 bits.** Steer, stop and server title/follow-up
  calls (server-call token `run_id`) land in the run's trace whatever request or replica caused
  them. A compaction is its own run, so its own trace, in the same session (review S6). The HTTP
  request that created the run is linked, not the parent. Langfuse scores (KOBE-275) can name a
  trace from the run id.
- **Predictable ids are never trusted (review M1).** Sandbox-reachable listeners (model gateway, MCP
  proxy, egress proxy, WSS upgrade) do not extract `traceparent`; the gateway opens
  `model_gateway.request` after run attribution, in that run's trace.
- **Span ids remapped (M2):** HMAC-SHA256(`k_trace`, run ‖ 0 ‖ id)[:8], `k_trace` = HKDF of the
  model-gateway session key (info `kobe/trace-span/v1`), shared by server and gateway like the
  run-token key. Per-run seen-set drops duplicates; cycles dropped, deep chains and a misparented
  run span reparented, unknown parents left as orphans (S1).
- **Tool name from the server (M3):** the frame has no tool name at all (stricter than a charset):
  the server stamps it from its policy decision for (run, call id); unknown call → `unknown`, call
  id dropped. `error_type` and `kobe.stop_reason` are closed enums with `other` (S2).
- **Times (M4):** plausible-range schema check (2001..2286) plus server clamp to the run window ±60 s.
  `SANDBOX_SPAN_MAX_DURATION_MS` removed instead of tied to a run duration cap: there is no run
  duration cap in Kobe, and the clamp to the run window is the real bound.
- **Late and reconnect frames (M5):** dropped and counted, connection kept; ended runs are kept for
  the 30 s grace beyond the ended-lease count cap; the agent discards spans of runs `hello.ack`
  does not list and stops 20 s after a run ends. Never-held runs stay `lease_violation`.
- **Own export queue (M6):** relayed spans go through their own batch processor and bounded
  queue, behind a per-replica token bucket with a per-team fair share.
- **Per-span parsing (S3), loose trace context and capability versioning (S4), drop accounting on
  `kobe.run` (S5), `user.id` = `threads.owner_user_id` everywhere (S6), content stripped at intake
  too (S7):** adopted as written.
- **Allow-list in the schema:** closed span names (`sandbox.run|turn|tool|compaction|
workspace_sync`), strict attribute set per name; no token counts on sandbox spans (the gateway
  meters; Langfuse would double costs).
- **Trace context only on `run.start` and `thread.compact`,** not steer/stop (description listed
  them): the trace is fixed at the start; the server records its steer/stop command spans in it.
- **Session for gateway run calls by server-side lookup** (run row read with the run-token activity
  check), not a new run-token claim: no rollout-order hazard with the strict claims schema.

## Open questions (for Chris or the coordinator)

## Evidence (acceptance criteria → test or command output)

- ac-1: contract `beae796d`, amended after review; `packages/protocol/src/sandbox-wire/trace-frames.test.ts`,
  `src/tracing.test.ts`.
