# Server-originated model calls (KOBE-234)

CE18 (auto-titles) and CE21 (follow-ups) have the **server** ask the thread's model something after
a run completes. Until now every model call came from a sandbox, with a session token and a run
token (KOBE-117/118), and every `run_usage` row had a sandbox. This document is the contract
KOBE-219 (titles) and KOBE-222 (follow-ups) build on. The wire shapes live in
`packages/protocol/src/server-call.ts` (+ `src/node/server-call-token.ts`), `src/events.ts` and
`src/sse.ts`; the gateway side is implemented and tested in `services/model-gateway`
(`server-call.ts`, `server-call.test.ts`); the ledger column is migration 0099.

**Eval judge (KOBE-326).** The skill eval judge is a server call too: purpose `eval_judge` (a token
purpose, never announced in `run.completed.epilogue`), one call per judged eval execution after its
run completed, on the team-enabled judge model, under the execution's member and run. Its limits are
its own (`SERVER_CALL_LIMITS.eval_judge`: 512 / 2048 output tokens, 60 s, messages up to 400 000
characters, 2 MiB body, temperature 0, skipped only at 100 %); it may send exactly one
`response_format`, the verdict schema (`SERVER_CALL_RESPONSE_FORMATS`), which the gateway compares.
Usage rows are `kind = eval_judge` (migration 0147). Details in [skill-evals.md](../skill-evals.md).

## Decisions

| Topic         | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity      | A per-call **server-call token** (`ksc1.`, HMAC-SHA256, own HKDF key `kobe/server-call-token/v1` from the gateway's session key, `aud: kobe.model-gateway.server-call`) in `x-kobe-server-call`, alone on the request. TTL ≤ 30 s, single use per gateway replica.                                                                                                                                                                                                                                         |
| What it binds | `purpose` (`title` / `followups`), team, user, thread, triggering run, the one `model`, `max_output_tokens` (≤ the purpose's hard cap), `jti`.                                                                                                                                                                                                                                                                                                                                                             |
| Refusals      | Only `POST /v1/chat/completions`; body must match `serverCallRequestSchema` (no tools, functions, tool messages, images, streaming, `n > 1`, unknown fields); `body.model` must equal the token's and be enabled for the team; output limit ≤ the token's.                                                                                                                                                                                                                                                 |
| Attribution   | The triggering run's member and team, through the same `BudgetGate` and `kobe_reserve_budget` path as sandbox calls (site, team and user-in-team lines, dollars and tokens). The call counts toward 80 % warnings and 100 % stops like any call.                                                                                                                                                                                                                                                           |
| 80 % rule     | Follow-ups are skipped when any applicable budget line is at **≥ 80 %**; titles only at 100 % (the ordinary stop). The server checks before calling; the gateway enforces it again (402 `budget_soft_limit`).                                                                                                                                                                                                                                                                                              |
| Usage record  | One `run_usage` row: `kind` = purpose, `sandbox_id` NULL, `run_id` = triggering run (so `thread_id` and `agent_id` resolve as for run calls). Migration 0099 (expand-only; no new table, no RLS change).                                                                                                                                                                                                                                                                                                   |
| Model         | The thread's resolved model at call time: `resolveRunModel` with the thread's pinned-agent alias (a pin wins; else the team default), the same function `run.start` uses. A model no longer enabled: skip.                                                                                                                                                                                                                                                                                                 |
| Caps          | Title: ≤ 64 output tokens, 15 s. Follow-ups: ≤ 256 output tokens, 20 s. A model the site catalog marks as reasoning (`model_catalog.reasoning`, the KOBE-259 flag in Site > Models) gets `reasoning_effort: "low"` and up to 512 (title) / 768 (follow-ups) output tokens (KOBE-219 review H1); the gateway allows the larger cap and the field only for such a model. Non-streaming, no retries. Failures are logged (codes only) and never surface as run failures.                                      |
| Secrets       | The server holds only the session key it already has (it mints run tokens from it). Provider keys stay in Bifrost; the gateway forwards with the member's virtual key exactly as for sandbox calls. The token never reaches a sandbox or a browser.                                                                                                                                                                                                                                                        |
| Events        | `run.completed.epilogue` announces the calls; results follow on the same run's event stream: `thread.updated {thread_id, title}` and `thread.suggestions {thread_id, suggestions[1..3]}`. The stream stays open for them up to 30 s (`epilogueOpen`).                                                                                                                                                                                                                                                      |
| Tracing       | The server wraps each call in a span `server_call.<purpose>` and injects `traceparent`, so the gateway's `model_gateway.request` span is its child; the gateway adds `kobe.usage_kind`. Langfuse sessions: the token's `thread_id` and `user_id` claims are the span's `session.id` and `user.id` (opaque uuids), as KOBE-274 ac-6 sets for run calls, so titles and follow-ups join their thread's session; the attributes themselves are KOBE-274's. Content only under `captureContent` (off on gate1). |
| Dashboards    | Usage dashboards gain a breakdown by `kind`; per-run usage and the context gauge read `kind = 'run'` rows only (KOBE-219).                                                                                                                                                                                                                                                                                                                                                                                 |

## Identity in detail

Why not reuse an existing credential:

- The **session token** names a sandbox (`sub`), and the gateway checks the sandbox is live
  (`principals.ts`). There is none here, and minting a session token for a fake sandbox would make
  server calls indistinguishable from sandbox calls in the ledger and the gate.
- The **run token** is bound to an active run on a sandbox; the run has ended.
- A **static server credential** (a shared secret header) would be long-lived and unbound: one leak
  lets anyone call any model for any team. A per-call token binds team, member, model, output cap
  and purpose, and expires within 30 s.

Separation from sandbox credentials (ac-2):

1. Own key: `HKDF(session key, info "kobe/server-call-token/v1")`. A run token (`krt1`, info
   `kobe/run-token/v1`) or a session token (EdDSA JWT since KOBE-513) never verifies as a server-call token, and a
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
   reservation and the 80 % rule for follow-ups, whatever the token says. It also checks the
   token's run in the record (`serverCallRunMatches`, one read by primary keys): a **completed**
   run of the token's thread, leased to the token's member (`sandbox_run_leases` keeps the row
   after the run ends), else 403 `server_call_run_mismatch`. So a bug cannot charge another member
   of the team; another team is impossible anyway (RLS).

### Replay threat model (accepted)

The gateway refuses a `jti` it has already seen (in memory, per replica, until the token expires;
the table is filled only after a MAC check and fails closed at 100 000 entries). Cross-replica
single use would need shared state (a nonce table), which the CE spec rules out ("no new team
tables"); reservations cannot serve as one (none is made without budget lines, and they end at
settle). Accepted because:

- **Who can see a token:** it travels only server → gateway inside the cluster, in plain HTTP. A
  sandbox cannot sniff other pods (gVisor/Kata, NetworkPolicy, no host network). Whoever can read
  that traffic or the server process (node root, the CNI, the host network, the server pod) can
  already read the `sandbox-session-keys` Secret and mint tokens, so a replay adds nothing to what
  they can do.
- **What a replay carries:** only the model, purpose, member, thread and output cap are bound, not
  the body: a replay can send an **attacker-chosen prompt** (≤ 64 KiB, ≤ 4 text messages, no
  tools, no streaming) and read the answer.
- **Bound:** at most one extra call per gateway replica that has not seen the `jti` (2 replicas: at
  most 1 extra), within the token's ≤ 30 s, capped at the purpose's output limit, through the
  same budget reservation and recorded as `kind = title | followups`, **charged to the right
  member** (the run check above).
- Revisit if the gateway ever gets ingress from outside the cluster.

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
2. After commit, off the run's path, the announced calls start **concurrently**
   (`services/server` `server-calls/epilogue.ts`, `runEpilogue`), so the epilogue window
   (`SERVER_CALL_EPILOGUE_MAX_MS` = the longest call's timeout + a 10 s margin = 30 s) covers
   both. Each: resolve the model; mint a token (TTL 30 s, `max_output_tokens`
   ≤ `SERVER_CALL_LIMITS[purpose]`); `POST <gateway>/v1/chat/completions` with
   `x-kobe-server-call`, `stream: false`, and the purpose's timeout; no retries.
3. Result:
   - title (saved first, event second: a refused event, e.g. the window closed, leaves the title
     saved and the next thread read shows it): normalise the reply (first line, no quotes or trailing punctuation, ≤ 80 chars,
     `generatedTitleSchema`), then `UPDATE threads SET title = $1 WHERE team_id = $2 AND id = $3
AND title IS NULL AND NOT title_locked`; append `thread.updated` only when a row changed
     (a rename in the meantime wins);
   - follow-ups: parse up to three lines (`threadSuggestionsSchema`); append `thread.suggestions`.
4. Failure (gateway refusal, timeout, empty or invalid reply): log `{purpose, run_id, code}` at
   warn, write nothing. The epilogue window closes by its deadline. A reply that came back but
   cannot be used is a skip, logged as `server call skipped` (the gateway's own skip line) with
   its code and the model: `empty_content` (no text: a reasoning model spent its allowance),
   `truncated` (`finish_reason: length`; never saved, the text may stop mid-word), `bad_reply`,
   `schema_reject` (no usable title: empty after normalising, or it holds a link); and so is a
   call with nothing to send (`no_model`, `no_lease`, `no_message`, `titled`).
5. Title fallback (KOBE-219 review M3): when no title will come, the first line of the first
   prompt (unsafe characters removed, ≤ 80 characters, cut with "…") is written with the same
   guard (`title IS NULL AND NOT title_locked`): at run end when the server makes no title calls
   (not configured, or the thread is past its three attempts), and after the epilogue when the
   last attempt failed or skipped, or at once when no model or lease will ever allow one. A
   fallback inside the epilogue is announced with `thread.updated` like a generated title.

Reasoning models: `low` was measured on gate1's `glm-5.3-flash` (a clean title in ~12 output
tokens, no reasoning); without it the 64 tokens went to reasoning and `content` was empty;
`minimal` still ran out, and `none` moved the reasoning into `content`, so neither is used.
Titles strip controls, format characters (bidi overrides, zero-width marks) and line separators
(`generatedTitleSchema` refuses them too).

Prompts carry the first user message and the start of the answer, truncated to
`SERVER_CALL_MESSAGE_MAX_CHARS`; the request body is at most 64 KiB.

## Event stream

`run.completed` stays the run's terminal event (it ends the run; nothing after it changes run
state). With an `epilogue`, the SSE response stays open until each announced result was sent or
`SERVER_CALL_EPILOGUE_MAX_MS` (30 s: the longest call plus a margin; the calls run concurrently) after `run.completed`, then ends; a reconnect after that with
no new events is a 204 (`decideStreamOpen` with `epilogue_open`). Clients that stop at the terminal
event lose nothing durable: the title is on the thread row, and follow-ups are a hint until the
next send. Epilogue events are ordinary `run_events` rows (seq after the terminal), so a client
that reconnects with `Last-Event-ID` gets them by replay.

Append rule (`services/server` `event-stream/append.ts`, enforced since KOBE-234): once a run has
its terminal event, the only events it takes are the epilogue types its `run.completed.epilogue`
announced (`title` → `thread.updated`, `followups` → `thread.suggestions`), **each at most once
per run**, within `SERVER_CALL_EPILOGUE_MAX_MS` of `run.completed` (database clock); anything else
is `run_finished`, and an epilogue event that does not fit is `epilogue_refused`. The guard looks
for the terminal among the run's last three events (at most two epilogue events follow it), so an
epilogue event at the end never reopens the run. Epilogue events are refused before the terminal.
The per-run event cap (`runMaxEvents`, enforced by producers) does not apply to them: they are at
most two. D18 compaction treats them like any event: deleted with the run's stream after 7 days
(the title stays on the thread row; old follow-ups have no use).

## Gateway contract stub

`services/model-gateway/src/server-call.ts`:

| Step        | Check                                                                                                                                                                                      | Refusal                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Credentials | `x-kobe-server-call` alone (no API-key header, `?key=`, run token, run id)                                                                                                                 | 400 `ambiguous_credentials`                                             |
| Token       | prefix, MAC, claims, time                                                                                                                                                                  | 401 `invalid_server_call_token`                                         |
| Replay      | `jti` unseen on this replica                                                                                                                                                               | 401 `server_call_token_replayed`                                        |
| Route       | `POST /v1/chat/completions`                                                                                                                                                                | 403 `server_call_route_refused`                                         |
| Member      | active member with a virtual key (no sandbox check)                                                                                                                                        | as sandbox calls (401 `session_revoked`, 503 pending)                   |
| Run         | completed run of the token's thread, leased to the token's member                                                                                                                          | 403 `server_call_run_mismatch`                                          |
| Body        | `serverCallRequestSchema`, model = token's, limit ≤ token's and ≤ the purpose's cap for the model (reasoning headroom and `reasoning_effort` only for a catalog reasoning model), ≤ 64 KiB | 400 `server_call_body_refused`, 413                                     |
| Model       | enabled for the team                                                                                                                                                                       | 403 `model_not_enabled`                                                 |
| Budget      | `BudgetGate` (reservation), at `skip_at_percent` of each line for the purpose                                                                                                              | 402 `budget_exhausted` / `budget_below_call` / `budget_soft_limit`, 429 |
| Usage       | `run_usage` row with `kind`, no sandbox, `run_id` from the token                                                                                                                           | —                                                                       |

Server calls have their **own** request rate and concurrency limiter, per team
(`SERVER_CALL_LIMIT_DEFAULTS`: 8 concurrent per team, 64 in all, burst 20, 5 per second), apart
from the sandboxes' per-sandbox limits, so a team whose sandboxes are busy still gets its titles
and server calls cannot crowd out sandboxes. Every server call the gateway refuses at the rate,
concurrency or budget step is logged at warn (`server call skipped`, with purpose, run and reason;
no content). The member's per-minute request rate (the budget gate) applies as for sandbox calls.

The 80 % rule is decided in the database: the gate passes each line to `kobe_reserve_budget` with
its limit at the purpose's percentage, so the reservation's own spend read and the other calls'
in-flight reservations (KOBE-286) judge it, not this replica's cached spend. The cached state only
refuses early. Because in-flight reservations count, a follow-up is skipped slightly before the
ledger alone reaches 80 % when many calls are in flight (conservative by design).
