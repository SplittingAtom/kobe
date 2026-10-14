# KOBE-211: B7: Context gauge in bar row two

- **Status:** in review (PR #273)
- **Branch / worktree:** `kobe-211-context-gauge` in `../Kobe-wt211`
- **Depends on:** KOBE-210 (closed here, see below), KOBE-197 (bar row two, merged)

## Plan

- Server (own commit, for Opus review): `GET /v1/threads/{id}/usage` adds `latest_call`; OpenAPI
  for `GET/PUT /v1/team/models` and the thread usage route (KOBE-210 ac-3).
- Web: `lib/chat/context-usage.ts` (pure numbers and wording), `LiveRun.contextTokens` in
  `lib/chat/live.ts`, `components/shell/context-gauge.tsx` rendered by `ContextRow`.

## Decisions

- **Numerator from run_usage needs one row, not run totals.** The thread usage route summed per
  run, so it gained `latest_call` (`at`, `model`, `input_tokens`, `cache_read_tokens`): the newest
  `run_usage` row of the thread with `input_tokens + cache_read_tokens > 0` (a call refused before
  the provider read anything says nothing about the context), null before the first call. Ordered
  by `at DESC, id DESC`; uses the existing `run_usage_thread_idx`. No migration.
- **Live value = the committed assistant message's Pi `usage`.** The Kobe Event Stream has no
  `message_end` event; the server mirrors the message Pi ended as `entry.committed`, whose payload
  carries `message.usage` (`input`, `cacheRead`). `live.ts` keeps the newest as
  `contextTokens`; offloaded payloads (over 64 KB) and zero-usage messages keep the previous value.
- **Which value wins** (`newestContextTokens`): on load, run_usage; while a run streams, the
  stream; after the run ends, run_usage again once `ThreadUsageProvider` re-read it (its existing
  1.5 s settle read). The provider now records which run's end each read followed (`afterRun`).
- **Scale = the model the thread runs with next:** agent pin, else the thread's choice, else the
  team default, looked up in `GET /v1/team/models` (`context_window`). A model change re-renders
  only the scale; the fill (tokens) stays. Over 100% the bar is full and the text says e.g. 130%.
- **Thresholds:** green < 65%, orange >= 65%, red >= 85% on the unrounded share; the shown
  percentage is rounded down so it never reads 65% while green.
- **Blank window:** no meter (it needs a max); the count as text ("142k tokens") with a
  screen-reader prefix "Context used:", tooltip "142k tokens · <model>".
- **Empty before the first turn:** an existing thread without calls shows an empty meter
  ("0 of 200k tokens (0%)"). A brand-new conversation (no thread yet) shows no gauge until its
  first message creates the thread (the draft model has no subscription to re-scale on).
- **Compact this thread: hidden until B9.** `ContextGauge` takes `onCompact`; at red with a handler
  it adds the tooltip line and an `IconAction` (`compact-thread`, new registry entry, scope `thread`: the bar test wants every `bar` command always shown). `ContextRow`
  passes none, so nothing inert ships; B9 (KOBE-213) only has to pass the handler.
- **Accessibility:** `role="meter"`, `aria-label="Context used"`, `aria-valuemin/max/now`
  (now capped at max) and `aria-valuetext` = the tooltip text; focusable, so the tooltip opens on
  keyboard focus too. Colours: tokens on `.gauge` with dark-mode values; no preflight assumed.

## KOBE-210 close-out

- ac-1: met in KOBE-259 (migration 0090, admin field; see `docs/ledger/KOBE-259.md`).
- ac-2: met: `GET /v1/team/models` (what the chat's picker and gauge read) carries
  `context_window`, null when blank: `services/server/src/models.db.test.ts` (KOBE-210 ac-2 case,
  now also parsing the answer with the documented schema and checking the key is never absent).
- ac-3: met: `services/server/openapi.json` documents `/v1/team/models`, `/v1/team/models/{alias}`
  and `/v1/threads/{id}/usage` from zod contracts (`src/openapi/models.ts`, `src/openapi/usage.ts`);
  `src/openapi/document.test.ts` checks the routes mounted vs documented and that
  `context_window` is required and nullable. (`mountedOperations` now dedupes routes with
  per-route middleware.)

## Open questions (for Chris or the coordinator)

- Server change for Opus review: commit "feat(server): latest model call on thread usage…".
- Assumed, not verified against each provider: Pi's `usage.input` excludes cache reads (like the
  gateway's `input_tokens`). If a provider counted cached tokens inside `input`, the live value
  would over-count during a run until the post-run run_usage read corrects it.

## Evidence (acceptance criteria → test or command output)

- ac-1: `apps/web/components/shell/context-gauge.test.tsx` "shows run_usage's newest call on load,
  follows message usage during a run, then run_usage again"; `lib/chat/live.test.ts` "context
  tokens (KOBE-211)"; `lib/chat/context-usage.test.ts` `newestContextTokens`; server
  `services/server/src/usage.db.test.ts` "the thread's latest model call (KOBE-211…)".
- ac-2: `context-gauge.test.tsx` thresholds (64/65/84/85/130%), tooltip text, blank window;
  `context-usage.test.ts` `gaugeLabel`, `gaugeLevel`.
- ac-3: `context-gauge.test.tsx` "re-scales on a model change without clearing the fill".
