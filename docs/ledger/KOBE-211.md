# KOBE-211: B7: Context gauge in bar row two

- **Status:** in review (PR #273), review findings addressed
- **Branch / worktree:** `kobe-211-context-gauge` in `../Kobe-wt211`
- **Depends on:** KOBE-210 (closed here, see below), KOBE-197 (bar row two, merged)

## Plan

- Server (own commits, for Opus review): `GET /v1/threads/{id}/usage` adds `latest_call`; OpenAPI
  for `GET/PUT /v1/team/models` and the thread usage route (KOBE-210 ac-3).
- Web: `lib/chat/context-usage.ts` (pure numbers and wording), `LiveRun.contextTokens` in
  `lib/chat/live.ts`, `components/shell/context-gauge.tsx` rendered by `ContextRow`.

## Decisions

- **Context size = input + cache read + cache write** (review 1/2). Both sources keep the three
  disjoint. Pi 1.0.0 (pi-ai): Anthropic `input_tokens` / `cache_read_input_tokens` /
  `cache_creation_input_tokens` map 1:1; OpenAI chat and responses and Gemini subtract cached
  (and cache-write) tokens from the prompt count. Gateway (`usage/normalize.ts`) does the same, so
  the sum counts each prompt token once whatever the provider. One gap: Gemini
  `toolUsePromptTokenCount` is input to the gateway but not to Pi (live value a little lower until
  the post-run read). Tests per shape: `context-usage.test.ts` (Anthropic, OpenAI chat/responses,
  Gemini, no cache), `live.test.ts` (cache write), `usage.db.test.ts` (OpenAI and Anthropic rows).
- **`latest_call`** = the thread's newest `run_usage` row with input + cache read + cache write
  > 0 (a refused call says nothing about the context): `run_id`, `at`, `model`, the three counts;
  > null before the first call. Read with the per-run totals in one `withTeam` transaction (review 8).
- **Live value** = the committed assistant message's Pi `usage` (`entry.committed` payload; the
  Event Stream has no `message_end`). A `compaction` entry sets it to null (unknown) until the next
  message. Offloaded payloads and zero-usage messages keep the previous value.
- **Which value wins** (`newestContextSize`, review 3): while a run streams, the stream. After it
  ended, run_usage only when a read made after the end holds a call of that run (`run_id`);
  otherwise the streamed value stays and `ThreadUsageProvider` reads again at 3 s and 6 s (bounded,
  2 extra reads). With no run streamed, run_usage as loaded.
- **Compaction** (review 4): `run_usage` has no call kind or flag, so the server can't leave out a
  compaction's summary call, and clocks (`run_usage.at` vs entry times) can't order it safely
  (entries are mirrored after the next call may start). The web orders by entry seq instead:
  when a `compaction` entry is newer than the newest answer with usage (an offloaded message counts
  as an answer), the size is unknown and the gauge hides until the next call.
- **Model** (review 5): scale = the model the thread runs with next (agent pin, thread choice,
  team default), so a model change re-scales the same fill (ac-3). The counting model is
  `latest_call.model` (matched by `gateway_model`) or the run's alias; when it isn't the scale's
  model the text says so: "150k of 1M tokens (15%) · GLM 5.3 · counted by Kimi K2.7 Code".
- **Hidden when unknown** (review 6): no gauge before the first call, after an unfollowed
  compaction, or in a new conversation; never "0 of …".
- **One `useTeamModels` hook** (review 7, `components/chat/use-team-models.ts`) for the picker and
  the gauge, with the fresh re-read after `agent_model_not_enabled`; the session shares a fresh
  read made in the last second, so both readers cost one request.
- **Thresholds:** green < 65%, orange >= 65%, red >= 85% on the unrounded share; shown percentage
  rounded down. Over 100% the bar is full and the text says e.g. 130%.
- **Blank window:** no meter; "142k tokens" with a screen-reader prefix "Context used:".
- **Compact this thread: hidden until B9.** `ContextGauge` takes `onCompact`; at red with a handler
  it adds a tooltip line and an `IconAction` (`compact-thread`, scope `thread`: the bar test wants
  every `bar` command always shown). `ContextRow` passes none; B9 (KOBE-213) passes the handler.
- **Accessibility:** `role="meter"`, `aria-label="Context used"`, `aria-valuemin/max/now` (now
  capped at max), `aria-valuetext` = the tooltip text; focusable for keyboard tooltips.

## Follow-ups

- Index for `latest_call`: `run_usage (team_id, thread_id, at DESC) WHERE thread_id IS NOT NULL`
  (today the partial `run_usage_thread_idx` plus a sort over the thread's rows). Needs a migration.
- A call kind on `run_usage` (title/follow-ups/compaction) would let the server drop summary calls.

## KOBE-210 close-out

- ac-1: met in KOBE-259 (migration 0090, admin field; see `docs/ledger/KOBE-259.md`).
- ac-2: met: `GET /v1/team/models` (picker and gauge) carries `context_window`, null when blank:
  `services/server/src/models.db.test.ts` (parses the answer with the documented schema).
- ac-3: met: `services/server/openapi.json` documents `/v1/team/models`, `/v1/team/models/{alias}`
  and `/v1/threads/{id}/usage` from zod contracts (`src/openapi/models.ts`, `usage.ts`);
  `document.test.ts` checks mounted vs documented routes and that `context_window` is nullable.

## Open questions (for Chris or the coordinator)

- None open. The Pi input question is settled above (counts are disjoint; sum all three).

## Evidence (acceptance criteria → test or command output)

- ac-1: `context-gauge.test.tsx` "shows run_usage's newest call on load, follows message usage
  during a run, then run_usage again" (incl. a stale read), compaction and before-first-call cases;
  `live.test.ts` "context tokens (KOBE-211)"; `context-usage.test.ts`; server `usage.db.test.ts`
  "the thread's latest model call (KOBE-211…)" incl. the shared-reader test.
- ac-2: `context-gauge.test.tsx` thresholds (64/65/84/85/130%), tooltip, blank window.
- ac-3: `context-gauge.test.tsx` "re-scales on a model change without clearing the fill".
