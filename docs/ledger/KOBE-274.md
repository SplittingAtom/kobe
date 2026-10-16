# KOBE-274: Sandbox agent tracing: run spans relayed through the server

- **Status:** contract committed, waiting for review (ac-1); implementation not started
- **Branch / worktree:** `group-2-quality` in `../Kobe-g2` (group branch, no own PR)
- **Depends on:** KOBE-10 (tracing), KOBE-273 (gate1 Langfuse), KOBE-118 (run tokens), KOBE-234 (server calls)

## Plan

1. Contract (ac-1): `packages/protocol/src/tracing.ts` (run trace ids, `traceparent`, session
   attributes) and `src/sandbox-wire/trace-frames.ts` (`trace.spans`, `run.start.trace`,
   `thread.compact.trace`, capability `trace_spans`, limits). Own commit, reviewed before step 2.
2. Server: run root span and command spans in the run trace; trace context on `run.start` /
   `thread.compact`; `trace.spans` intake (lease, grace, rate, per-run cap, re-attribution) into the
   exporter behind the content gate.
3. Sandbox agent: spans from Pi RPC events, bounded buffer, flush; `traceparent` on Pi's model calls.
4. Model gateway: trace id from the attributed run; `session.id` / `user.id` from the run row or
   the server-call claims.
5. k3d e2e against an OTLP sink; docs/tracing.md.

## Decisions

- **Trace id = run id hex, root span id = its low 64 bits.** Steer, stop, compaction (its own run)
  and server title/follow-up calls (server-call token `run_id`) land in the run's trace whatever
  request or replica caused them, and the gateway needs no lookup and no new token claim to place
  `model_gateway.request`: it trusts an incoming `traceparent` only for its parent span id, and only
  when the trace id matches the attributed run. The HTTP request that created the run is linked
  (span link), not the parent. Langfuse scores (KOBE-275) can name a trace from the run id.
- **Frames carry no trace id and no identity.** The server derives the trace from the leased run
  and stamps team/user/thread/run/sandbox, `session.id` and `user.id`; a span reusing a server-issued
  span id is dropped (no shadowing of server spans in Langfuse, which upserts by span id).
- **Allow-list in the schema:** closed span names (`sandbox.run|turn|tool|compaction|
workspace_sync`), strict attribute set per name; no token counts on sandbox spans (the gateway
  meters; Langfuse would double costs). Content only `kobe.tool.input/output`, ≤ 4096 chars, sent
  only with `trace.capture_content`, and the server's content gate drops them when capture is off.
- **Trace context only on `run.start` and `thread.compact`,** not steer/stop (description listed
  them): the trace is fixed at the start; the server records its steer/stop command spans in it.
- **Fire and forget.** Unsequenced, unacknowledged, not re-sent; agent buffer ≤ 512 spans (drop and
  count in `dropped`); server: ≤ 2048 spans per run, 10 frames/s (burst 20) per connection, frames
  for runs ended < 30 s ago accepted, anything it won't take dropped silently (no `error` chatter).
  Foreign run/thread stays a `lease_violation` like every frame.
- **Session for gateway run calls by server-side lookup** (run row read with the run-token activity
  check), not a new run-token claim: no rollout-order hazard with the strict claims schema.

## Open questions (for Chris or the coordinator)

## Evidence (acceptance criteria → test or command output)

- ac-1: contract commit; `packages/protocol/src/sandbox-wire/trace-frames.test.ts`,
  `src/tracing.test.ts` (protocol suite green: 26 files, 641 tests).
