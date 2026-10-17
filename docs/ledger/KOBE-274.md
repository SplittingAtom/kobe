# KOBE-274: Sandbox agent tracing: run spans relayed through the server

- **Status:** implemented on `group-2-quality` (not pushed); k3d e2e and gate1 Langfuse check pending
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
  them. A compaction is its own run, so its own trace, in the same session (review S6). Command
  spans link to the request that caused them (the root is recorded later, on the connection's
  replica, where no request is in scope). Langfuse scores (KOBE-275) can name a trace from the run
  id. A run whose sandbox connection is lost for good gets no root (accepted; its spans stay in
  the trace).
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
- **Session for gateway run calls by server-side lookup**, not a new run-token claim (no rollout
  hazard with the strict claims schema). Departure from S6: a separate cached query
  (`runSessionOf`: run → thread → `owner_user_id`, cached 10 min, only while tracing is on) instead
  of widening `isRunTokenActive`, so the hot path is unchanged with tracing off and 20+ gateway test
  fakes keep their boolean contract. Server calls take `thread_id` / `user_id` from the claims; the
  gateway's `serverCallRunMatches` already requires the claimed user to hold the run's lease, which
  delivery only grants to the thread owner, so a session never shows two users.
- **Tool names on denied calls:** the server stamps a name for allowed calls and for denied built-ins
  only; a denied non-built-in (possibly hallucinated, i.e. model text) is `unknown`.
- **Trace context added by the requesting replica, kept or stripped by the delivering one:** the
  scheduler needs no `k_trace`; only the replica that delivers and relays needs it.
- **Gateway trace parent per turn:** the agent writes the current run or turn span to Pi's model
  file (`traceparent`, re-read per request), so `model_gateway.request` hangs under the turn.
- **e2e sink:** `e2e/lib/otlp-sink.js`, Node built-ins only (no new dependency), run from the
  model-gateway image; CI's k3d install has no collector. Tracing is on for the whole e2e suite
  (endpoint at install; the sink rule merged into the proxies' later extraEgress overrides).

- **Security review fixes (SF1–SF5):** the trace frame rate is charged on the decoded type (no
  prefix sniff) and the replica budget before any span parse or HMAC; the public API no longer
  joins a caller's trace; per-run state (cap, seen-set, command spans) lives per replica and
  survives reconnects there (cross-replica resume starts afresh, documented); `mcp.tools/call`
  names the tool from the server's decision (`unknown` before) and drops the sandbox's thread
  header; negative tests added (relay off, listener wiring, key order, e2e sandbox → sink blocked).
- **Review nits:** call ids exported only as plain tokens (N1); agent drop counts capped per run
  (N4); late frame after both the 256 ended-lease cap and the 30 s grace stays a violation,
  commented (N2); a resumed run on another replica is marked traced (N3, same run and team);
  the gateway maps every incoming parent through the HMAC, the agent never sends the command id
  (N5); `user.id` equal on both sides because delivery refuses a run whose `ownerUserId` is not
  the connection's user (N6); tracing is on for the whole e2e suite, so the off path has unit and
  DB tests but no e2e run (N8).

## Open questions (for Chris or the coordinator)

- ac-2 e2e is written (`e2e/run.sh` "run traces (KOBE-274)", after KOBE-41's chat) but not run
  yet: it needs the group's CI e2e job (no local k3d run without the coordinator's go).
- ac-6 Langfuse check on gate1 needs a deploy of this branch (images, chart); not done here.

## Evidence (acceptance criteria → test or command output)

- ac-1: contract `beae796d`, amended `5da5f00f`; `packages/protocol/src/sandbox-wire/trace-frames.test.ts`,
  `src/tracing.test.ts`.
- ac-2: unit/DB: `services/server/src/trace-spans.db.test.ts` (trace context on run.start, relayed
  span under the command span, identity and session), `packages/telemetry/src/run-trace.test.ts`,
  `services/model-gateway/src/gateway.test.ts` "tracing"; k3d: `e2e/run.sh` (pending CI).
- ac-3: `services/server/src/sandbox/manifests.test.ts` (template without collector even when the
  server has one), `charts/kobe/tests/telemetry.test.ts` (endpoint and Secret in the five services
  only); `trace-spans.db.test.ts` (malformed → `malformed_frame`, oversized → close, never-held run
  → `lease_violation`, late frame dropped without close); `trace-intake.test.ts`.
- ac-4: `trace-intake.test.ts` (content stripped at intake), `run-trace.test.ts` (relay exporter
  content gate), `recorder.test.ts` (agent sends content only with `capture_content`).
- ac-5: `services/sandbox-agent/src/agent.traces.test.ts` (no trace context → no frames);
  `docs/tracing.md`.
- ac-6: `trace-intake.test.ts`, `trace-spans.db.test.ts`, `gateway.test.ts`,
  `trace-placement.test.ts`, `services/server/src/models/gateway-client.test.ts` (session on
  server, relayed, gateway and server-call spans); gate1 Langfuse view pending.
