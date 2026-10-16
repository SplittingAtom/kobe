# Server-originated model calls (KOBE-234)

CE18 (auto-titles) and CE21 (follow-ups) have the **server** ask the thread's model something after
a run completes. Until now every model call came from a sandbox, with a session token and a run
token (KOBE-117/118), and every `run_usage` row had a sandbox. This document is the contract
KOBE-219 (titles) and KOBE-222 (follow-ups) build on. The wire shapes live in
`packages/protocol/src/server-call.ts` (+ `src/node/server-call-token.ts`), `src/events.ts` and
`src/sse.ts`; the gateway side is implemented and tested in `services/model-gateway`
(`server-call.ts`, `server-call.test.ts`); the ledger column is migration 0099.

## Decisions

| Topic         | Decision                                                                                                                                                                                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Identity      | A per-call **server-call token** (`ksc1.`, HMAC-SHA256, own HKDF key `kobe/server-call-token/v1` from the gateway's session key, `aud: kobe.model-gateway.server-call`) in `x-kobe-server-call`, alone on the request. TTL ≤ 60 s, single use per gateway replica. |
| What it binds | `purpose` (`title` / `followups`), team, user, thread, triggering run, the one `model`, `max_output_tokens` (≤ the purpose's hard cap), `jti`.                                                                                                                     |
| Refusals      | Only `POST /v1/chat/completions`; body must match `serverCallRequestSchema` (no tools, functions, tool messages, images, streaming, `n > 1`, unknown fields); `body.model` must equal the token's and be enabled for the team; output limit ≤ the token's.         |
| Attribution   | The triggering run's member and team, through the same `BudgetGate` and `kobe_reserve_budget` path as sandbox calls (site, team and user-in-team lines, dollars and tokens). The call counts toward 80 % warnings and 100 % stops like any call.                   |
| 80 % rule     | Follow-ups are skipped when any applicable budget line is at **≥ 80 %**; titles only at 100 % (the ordinary stop). The server checks before calling; the gateway enforces it again (402 `budget_soft_limit`).                                                      |
| Usage record  | One `run_usage` row: `kind` = purpose, `sandbox_id` NULL, `run_id` = triggering run (so `thread_id` and `agent_id` resolve as for run calls). Migration 0099 (expand-only; no new table, no RLS change).                                                           |
| Model         | The thread's resolved model at call time: `resolveRunModel` with the thread's pinned-agent alias (a pin wins; else the team default), the same function `run.start` uses. A model no longer enabled: skip.                                                         |
| Caps          | Title: ≤ 64 output tokens, 15 s. Follow-ups: ≤ 256 output tokens, 20 s. Non-streaming, no retries. Failures are logged (codes only) and never surface as run failures.                                                                                             |
| Secrets       | The server holds only the session key it already has (it mints run tokens from it). Provider keys stay in Bifrost; the gateway forwards with the member's virtual key exactly as for sandbox calls. The token never reaches a sandbox or a browser.                |
| Events        | `run.completed.epilogue` announces the calls; results follow on the same run's event stream: `thread.updated {thread_id, title}` and `thread.suggestions {thread_id, suggestions[1..3]}`. The stream stays open for them up to 30 s (`epilogueOpen`).              |
| Tracing       | The server wraps each call in a span `server_call.<purpose>` and injects `traceparent`, so the gateway's `model_gateway.request` span is its child; the gateway adds `kobe.usage_kind`. Content only under the existing `captureContent` switch (off on gate1).    |
| Dashboards    | Usage dashboards gain a breakdown by `kind`; per-run usage and the context gauge read `kind = 'run'` rows only (KOBE-219).                                                                                                                                         |

## Identity in detail

Why not reuse an existing credential:

- The **session token** names a sandbox (`sub`), and the gateway checks the sandbox is live
  (`principals.ts`). There is none here, and minting a session token for a fake sandbox would make
  server calls indistinguishable from sandbox calls in the ledger and the gate.
- The **run token** is bound to an active run on a sandbox; the run has ended.
- A **static server credential** (a shared secret header) would be long-lived and unbound: one leak
  lets anyone call any model for any team. A per-call token binds team, member, model, output cap
  and purpose, and expires within a minute.

Separation from sandbox credentials (ac-2):

1. Own key: `HKDF(session key, info "kobe/server-call-token/v1")`. A run token (`krt1`, info
   `kobe/run-token/v1`) or a session token (HS256 JWT) never verifies as a server-call token, and a
   server-call token never verifies as either: wrong prefix, and the MAC is over another key.
2. Own header and audience. The gateway decides the path by the header: with
   `x-kobe-server-call` present, any session token (`Authorization`, `x-api-key`, `x-goog-api-key`,
   `api-key`, `?key=`), run token or `x-kobe-run-id` on the same request is a 400
   `ambiguous_credentials`; without it, the request is a sandbox call and a server-call token in an
   API-key header fails session verification (401).
3. Sandboxes hold none of the keys. The server mints the token right before the call and sends it
   only to the gateway; it is never stored, logged or sent to a client.
4. A server bug cannot widen a call: the gateway enforces the purpose's hard output cap, the
   request shape, the token's model, the team's enabled models, the member's liveness, the budget
   reservation and the 80 % rule for follow-ups, whatever the token says.

Replay: the gateway refuses a `jti` it has already seen (in memory, per replica, kept until the
token expires). Across replicas a captured token could be replayed until it expires (≤ 60 s), each
replay still capped, budget-reserved and recorded. Cross-replica single use would need shared state
(a table), which the CE spec rules out ("no new team tables"); the bound is judged sufficient for a
token that only ever travels server → gateway inside the cluster.

Network: the gateway's NetworkPolicy admits only team namespaces today. KOBE-219 adds an ingress
rule from the server pods (port 8080) and, where server egress is restricted, the matching egress.

## Flow (KOBE-219 / KOBE-222)

1. When a **message** run completes, the server decides, in the transaction that writes
   `run.completed`:
   - **title** when the thread has no title, `title_locked` is false, and the run is one of the
     thread's first three completed message runs (a model that keeps failing costs at most three
     calls);
   - **followups** when the team switch is on, the run was started by a member (not a schedule),
     and no budget line of the run's member is at 80 % or more.
     It writes `run.completed` with `epilogue: [...]` only for calls it will attempt.
2. After commit, off the run's path: resolve the model; mint a token (TTL 30 s, `max_output_tokens`
   ≤ `SERVER_CALL_LIMITS[purpose]`); `POST <gateway>/v1/chat/completions` with
   `x-kobe-server-call`, `stream: false`, and the purpose's timeout; no retries.
3. Result:
   - title: normalise the reply (first line, no quotes or trailing punctuation, ≤ 80 chars,
     `generatedTitleSchema`), then `UPDATE threads SET title = $1 WHERE team_id = $2 AND id = $3
AND title IS NULL AND NOT title_locked`; append `thread.updated` only when a row changed
     (a rename in the meantime wins);
   - follow-ups: parse up to three lines (`threadSuggestionsSchema`); append `thread.suggestions`.
4. Failure (gateway refusal, timeout, empty or invalid reply): log `{purpose, run_id, code}` at
   warn, write nothing. The epilogue window closes by its deadline.

Prompts carry the first user message and the start of the answer, truncated to
`SERVER_CALL_MESSAGE_MAX_CHARS`; the request body is at most 64 KiB.

## Event stream

`run.completed` stays the run's terminal event (it ends the run; nothing after it changes run
state). With an `epilogue`, the SSE response stays open until each announced result was sent or
`SERVER_CALL_EPILOGUE_MAX_MS` (30 s) after `run.completed`, then ends; a reconnect after that with
no new events is a 204 (`decideStreamOpen` with `epilogue_open`). Clients that stop at the terminal
event lose nothing durable: the title is on the thread row, and follow-ups are a hint until the
next send. Epilogue events are ordinary `run_events` rows (seq after the terminal), so a client
that reconnects with `Last-Event-ID` gets them by replay.

## Gateway contract stub

`services/model-gateway/src/server-call.ts`:

| Step        | Check                                                                      | Refusal                                                                 |
| ----------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Credentials | `x-kobe-server-call` alone (no API-key header, `?key=`, run token, run id) | 400 `ambiguous_credentials`                                             |
| Token       | prefix, MAC, claims, time                                                  | 401 `invalid_server_call_token`                                         |
| Replay      | `jti` unseen on this replica                                               | 401 `server_call_token_replayed`                                        |
| Route       | `POST /v1/chat/completions`                                                | 403 `server_call_route_refused`                                         |
| Member      | active member with a virtual key (no sandbox check)                        | as sandbox calls (401 `session_revoked`, 503 pending)                   |
| Body        | `serverCallRequestSchema`, model = token's, limit ≤ token's, ≤ 64 KiB      | 400 `server_call_body_refused`, 413                                     |
| Model       | enabled for the team                                                       | 403 `model_not_enabled`                                                 |
| Budget      | `BudgetGate` (reservation), plus `skip_at_percent` for the purpose         | 402 `budget_exhausted` / `budget_below_call` / `budget_soft_limit`, 429 |
| Usage       | `run_usage` row with `kind`, no sandbox, `run_id` from the token           | —                                                                       |

Rate and concurrency limits are keyed per team for server calls (`server-call:<team>`) instead of
per sandbox; the member's per-minute request rate applies as for sandbox calls.
