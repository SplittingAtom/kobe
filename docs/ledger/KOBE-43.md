# KOBE-43: run_usage ledger and dashboards

- **Status:** in review
- **Branch / worktree:** `kobe-43-run-usage` in `../Kobe-wt43`
- **Depends on:** KOBE-40 (shim, `UsageSink`), KOBE-41 (Pi wiring, advisory `x-kobe-run-id`)

## Brief (coordinator) and spec (D30, §5.4)

A `run_usage` team table (RLS) filled from the shim's `UsageSink`: input, output and cached tokens,
model, latency, attributed to team, user, sandbox and run where known. Correct for streaming
(final-chunk usage for OpenAI-style, Anthropic and Gemini). Aggregates per run, thread, user and
team. Team console and install console usage pages with time ranges and charts. Per-run usage in
the chat's run details. Optional per-catalog-entry prices (Ollama Cloud has none); tokens always
counted.

## Design

```
sandbox ── Pi ──▶ model-gateway shim ──▶ Bifrost ──▶ provider
                    │ UsageMeter taps the response stream (never buffers it)
                    │ CallRecord.usage {counts, source}  ──▶ DbUsageSink (batched, per team)
                    ▼
                 run_usage (team table, RLS) ◀── server: /v1/team/usage, /v1/install/usage,
                                                  /v1/runs/:id/usage, /v1/threads/:id/usage
```

- **Ledger** (`packages/db` `schema/usage.ts`, migrations `0041_run_usage`, `0042_run_usage_rls`):
  `run_usage(team_id, id, at, user_id, sandbox_id, run_id?, thread_id?, agent_id?, route, model,
status, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, usage_source,
cost_usd?, duration_ms, ttfb_ms?, aborted)`. `input_tokens` excludes cache reads/writes (each
  prompt token counted once). No foreign key to runs/threads: spend outlives a purged thread.
  Indexes `(team_id, at)`, `(team_id, user_id, at)`, run and thread partial indexes.
- **Prices** on `model_catalog` (`input|output|cache_read|cache_write _usd_per_mtok`, nullable,
  0–10 000): set through `POST/PATCH /v1/install/models/catalog`. `recordModelUsage` prices each
  row in its INSERT from the catalog of that moment (several aliases on one model: the highest
  price per kind). No input+output price → `cost_usd` null (dashboards show "unpriced" calls).
- **Measuring** (`services/model-gateway/src/usage/`): `UsageMeter` reads the upstream response as
  it streams to the sandbox. SSE events are decoded line by line (≤ 32 Ki chars a line) and the
  provider's usage merged: OpenAI chat's include_usage chunk, Responses' `response.completed`,
  Anthropic `message_start` + `message_delta`, Gemini's last `usageMetadata`. JSON bodies: a
  structural scanner (`json-scan.ts`) captures only a top-level `usage`/`usageMetadata` (or one of a
  top-level array's elements — Gemini's non-SSE stream), ≤ 64 KiB. `normalize.ts` maps each
  provider's fields.
- **Reported vs estimated.** Reported only when the response completed and carried a final usage
  report; otherwise estimated: reported fields kept, missing input = request bytes / 4, output =
  generated text chars / 4 (response bytes / 4 when unreadable, e.g. content-encoded). So a
  sandbox cannot make calls cheaper by suppressing usage (omitting `include_usage`, aborting a
  stream). Error answers (≥ 400) record zero tokens.
- **Writing** (`DbUsageSink`): every forwarded model call (named a model, reached Bifrost) → a
  queued row; flushed every second, one transaction per team (a failed team retries alone, ≤ 10
  attempts, never duplicating another team's rows); queue bounded at 50 000 rows (oldest dropped
  with an error log). Thread and agent are looked up from the run in the INSERT (team-scoped
  joins). The JSON log line per call stays.
- **Reading** (`services/server/src/models/usage-store.ts`, `routes/usage.ts`): team report
  (totals, time series hour/day in UTC, by user, model, agent — top 50) inside `withTeam`; install
  report sums every team via `scanTeams` (no RLS bypass) and adds `by_team`. Per run / per thread
  for whoever can read the run or thread (visibility via the orchestrator's `getRun` /
  `listThreadRuns`). Ranges default to 30 days, at most 400 days (hourly ≤ 31 days).
- **Web:** team console **Usage** and install console **Usage and spend** (time range, stat tiles,
  one-series SVG bar chart of spend or tokens with per-bar tooltips, breakdown tables);
  the chat's run panel shows the ended run's tokens, calls and spend.

## Decisions

- **The gateway is the source of usage, not Pi.** Spec D30 says "Pi's per-message usage … is
  written to `run_usage`"; Pi's numbers come over the sandbox wire (sandbox-controlled, and its
  cost is 0 for the `kobe` provider, KOBE-41) while the shim reads the provider's own report.
  Budgets (KOBE-42) need numbers a sandbox cannot forge, so the ledger is the shim's.
- **Run attribution is a hint** (KOBE-41): `run_id` (and thread/agent) only when the sandbox named
  an active run leased to it; a same-uid process could name a sibling run of the same sandbox.
  Team, user and sandbox come from the verified token.
- **Permissions:** team dashboard `team.budgets.manage` (team admins; the nav entry already used
  it); new install permission `install.usage.read` (Admin). Thread/run usage: `team.chat` + the
  run's visibility.
- **What admins see:** user names/emails, models, agent slugs and team names; never thread titles
  (team admins do not read members' threads; install admins never read team content, D8).
- **Estimates are generous on purpose** (SSE output estimated from generated text, not bytes, so a
  user's Stop is not over-charged ×30).
- **Calls refused before Bifrost** (gate, model not enabled, 4xx in the shim) are not ledger rows;
  the per-sandbox request rate (10/s) bounds rows a sandbox can cause.
- **Audit:** `models.catalog.changed` gains `pricesChanged?` (never the amounts).

## Contract changes

None in `packages/protocol`. `@kobe/model-gateway` `CallRecord` gains `startedAt`, `ttfbMs` and
`usage` (internal seam).

## For downstream tickets

- **KOBE-42 (budgets):** spend per period = `sum(cost_usd)` of `run_usage` by team / user (team
  table, RLS) and all teams (install). Rows land ≤ ~1 s after a call ends (sink flush); calls in
  flight are not yet in it. `DbUsageSink` is the place to also bump spend counters if summing gets
  slow. Unpriced models never consume a dollar budget.
- **KOBE-44 (admin UI):** the catalog API now has the four price fields (null = unset); the
  install models page should edit them.

## Open questions

1. Calls of models without prices never count against dollar budgets (D30 budgets are dollars).
   Token budgets would close that gap but are not in the spec.

## Evidence

| Item                      | Evidence                                                                                                                                                                                                                                                                                                                                        |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ledger, RLS, probe        | `packages/db` `usage.db.test.ts` (pricing incl. highest alias price and cache price, unpriced → null, run → thread attribution survives a purge, per-team RLS, clamping); probe fixture `run_usage`; `catalog.db.test.ts`                                                                                                                       |
| Streaming usage, all APIs | `services/model-gateway` `usage/meter.test.ts` (OpenAI chat + Responses, Anthropic, Gemini SSE; JSON incl. Gemini array; decoys in text; split chunks/UTF-8; long lines; estimates); `usage/usage.gateway.test.ts` (real shim + fake upstream, six API shapes → reported 5/3); `gateway.test.ts` (abort → estimated, error → zero, gate → none) |
| Sink                      | `usage/sink.test.ts` (per-team batches, retry only the failed team, bounded queue, give-up after attempts)                                                                                                                                                                                                                                      |
| Aggregates and API        | server `usage.db.test.ts` (catalog prices + audit; team report by user/model/agent/series; members 403; range validation; install by team; install 403 for team admins; run and thread usage for the owner, 404 for another team)                                                                                                               |
| Dashboards / run details  | web `usage-pages.test.tsx`, `lib/admin/usage-format.test.ts`, `conversation.test.tsx` "shows the ended run's tokens and spend…"                                                                                                                                                                                                                 |
| e2e                       | `e2e/run.sh` KOBE-41 story: "the model call is in the run_usage ledger with the provider's reported tokens", "the team usage dashboard counts it"                                                                                                                                                                                               |
