# KOBE-234: C0 contract: server-originated model calls (titles, follow-ups)

- **Status:** done on branch, awaiting the coordinator's security/DB review (no PR: group G3)
- **Branch / worktree:** `group-3-phase-c-org` in `../Kobe-g3` (group G3, Phase C)
- **Depends on:** KOBE-118 (run tokens), KOBE-286 (reservation reads spend), KOBE-252 (0098)
- **Blocks:** KOBE-219 (titles), KOBE-222 (follow-ups)

## Commits

1. `feat(db)`: migration **0099_run_usage_kind**: own first commit (group workflow, in place of a
   separate `migration` ticket). `run_usage.kind` (`run` default, `title`, `followups`),
   `sandbox_id` nullable only for non-`run` kinds, which must carry `run_id`
   (`run_usage_kind_shape`). Expand-only, no new table, no RLS change; the cross-team probe stays
   as is (its fixture is a `run` row). Generated (not hand-written), so `db:rebase` regenerates it.
2. `feat(protocol)`: `src/server-call.ts`, `src/node/server-call-token.ts`, epilogue events in
   `events.ts`, `epilogueOpen` / `decideStreamOpen` in `sse.ts`; design doc
   `docs/design/server-model-calls.md`. Web reducer (`apps/web/lib/chat/live.ts`) lists the two
   new event types (no behaviour).
3. `feat(model-gateway)`: the server-call path (`server-call.ts`, `gateway.ts`), budget soft limit
   (`budget-gate.ts`), principal load without a sandbox (`@kobe/db` `loadGatewayPrincipal`).

## Decisions

- **Identity:** per-call server-call token `ksc1.` (HMAC-SHA256, HKDF info
  `kobe/server-call-token/v1` over the gateway session key the server already holds), audience
  `kobe.model-gateway.server-call`, header `x-kobe-server-call` alone, TTL ≤ 60 s (server uses
  30 s), single use per gateway replica (in-memory jti set, fails closed when full). Binds purpose,
  team, user, thread, triggering run, model, output cap. Rejected: a static server credential
  (unbound, long-lived); a session token with a fake sandbox (indistinguishable in ledger/gate).
- **Attribution and the 80 % rule:** the triggering run's member and team, same `BudgetGate` /
  `kobe_reserve_budget` path as sandbox calls; counts toward 80 % warnings and 100 % stops.
  Follow-ups skipped at ≥ 80 % of any applicable line, titles only at 100 %; the gateway enforces
  the 80 % rule too (402 `budget_soft_limit`).
- **Usage row:** `run_usage` with `kind = purpose`, `sandbox_id` NULL, `run_id` = triggering run
  (thread/agent resolve as for run calls; `run_usage_thread_needs_run` unchanged). Migration 0099.
- **Model and caps:** thread's resolved model via `resolveRunModel` with the pinned-agent alias
  (pin wins), at call time; title ≤ 64 output tokens / 15 s, follow-ups ≤ 256 / 20 s;
  non-streaming, no retries, failures logged, never run failures. Gateway refuses tools, streaming,
  other routes, other models and higher caps whatever the token says.
- **Event:** `run.completed.epilogue` announces calls; `thread.updated {thread_id, title}` and
  `thread.suggestions {thread_id, suggestions}` follow on the same run's stream; the SSE response
  stays open up to 30 s for them. Rejected: a new thread-scoped stream (new infra); results before
  `run.completed` (delays completion).
- **Tracing:** server span `server_call.<purpose>` with `traceparent`; gateway span gets
  `kobe.usage_kind` and `kobe.thread_id`; content only under `captureContent`. Langfuse sessions
  (coordinator, 2026-10-16): the token's `thread_id` / `user_id` claims are what the gateway puts in
  `session.id` / `user.id` for server calls, matching KOBE-274 ac-6 for run calls; setting the
  attributes is KOBE-274's job. Dashboards gain a
  `kind` breakdown (KOBE-219).
- **Replay across replicas** is bounded (TTL, cap, budget), not prevented: single use across
  replicas needs a shared table, which the CE spec rules out. Judged sufficient for a token that
  only travels server → gateway inside the cluster. Flag for the security review.

## Acceptance text for KOBE-219 (coordinator applies in Hadron)

Add to the description: "Builds on the KOBE-234 contract (`docs/design/server-model-calls.md`,
`@kobe/protocol` server-call.ts). The gateway side and migration 0099 (`run_usage.kind`) are done."

- **ac-a** On a completed message run, the server writes `run.completed.epilogue: ["title"]` when
  the thread has no title, `title_locked` is false and the run is among the thread's first three
  completed message runs; then, off the run's path, mints a `title` server-call token (TTL 30 s,
  `max_output_tokens` ≤ `SERVER_CALL_LIMITS.title`) for the thread's resolved model
  (`resolveRunModel`, pinned agent wins) and calls `POST /v1/chat/completions` on the gateway
  with `x-kobe-server-call` only, `stream: false`, 15 s timeout, no retries.
- **ac-b** The reply is normalised to `generatedTitleSchema`; `UPDATE threads … WHERE title IS
NULL AND NOT title_locked` (team_id explicit); `thread.updated` is appended only when a row
  changed. A rename (sets `title_locked`) always wins; failures are logged with codes only.
- **ac-c** The SSE route keeps the response open while `epilogueOpen` holds and answers reconnects
  with `decideStreamOpen({..., epilogue_open})`; the web keeps listening after `run.completed`
  when it announces an epilogue and applies `thread.updated` to the rail and bar.
- **ac-d** Per-run usage (`runsUsageIn`) and the context gauge (`latestCallIn`) read
  `kind = 'run'` rows only; usage dashboards show a breakdown by `kind`.
- **ac-e** Chart: model-gateway NetworkPolicy admits the server pods on 8080; server env has the
  gateway URL; a test proves the server never sends a session token, run token or provider key on
  this path.
- **ac-f** Server test:db covers: title written once, locked thread untouched, budget at 100 %
  (gateway 402) leaves no title and no failed run, a usage row of kind `title` with no sandbox.

## Acceptance text for KOBE-222 (coordinator applies in Hadron)

Add to the description: "Follow-ups use the KOBE-234 contract (purpose `followups`), same path as
KOBE-219's title call."

- **ac-a** Follow-ups run only when the team switch is on (default off), the run was started by a
  member (not a schedule), and no budget line of the member is at ≥ 80 % (the server checks; the
  gateway's 402 `budget_soft_limit` is the backstop and is logged, not shown).
- **ac-b** `run.completed.epilogue` includes `followups`; the call uses a `followups` token
  (≤ `SERVER_CALL_LIMITS.followups` output tokens, 20 s, no retries); up to three lines parsed with
  `threadSuggestionsSchema` are appended as `thread.suggestions`.
- **ac-c** The web shows them as chips above the composer until the next send; usage rows have
  kind `followups`.

## Evidence

- ac-1 contract: commits 2 and 1; `docs/design/server-model-calls.md`.
- ac-2 gateway: `services/model-gateway/src/server-call.test.ts` (server-call token refused as a
  bearer / API key / run token; session token, run token and a token signed with the run-token key
  refused as a server-call token; mixed credentials 400; replay 401; tools, streaming, other
  routes, other model, higher cap refused; forwarded with the member's virtual key, no token and no
  `x-bf-*` across), `src/model-gateway.db.test.ts` (real store: hibernated sandbox still titled,
  sandbox token refused, ledger row kind `title`), `budget-gate.test.ts` (80 % follow-ups).
  Protocol: `packages/protocol/src/server-call.test.ts` (key separation both ways).
- ac-3: acceptance text above; the migration rides in this group as its own first commit.
- Commands: `pnpm verify`; `@kobe/db`, `@kobe/model-gateway`, `@kobe/server` `test:db`.
