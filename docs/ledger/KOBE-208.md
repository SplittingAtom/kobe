# KOBE-208: B4: Rich history: reasoning block, tool cards, hover footer, Detail toggle

- **Status:** in review (PR #271)
- **Branch / worktree:** `kobe-208-rich-history` in `../Kobe-wt208`
- **Depends on:** KOBE-202 (A6 preferences), KOBE-203 (A7 IconAction, command registry)

## Plan

1. Server (own commit, needs the Opus security review): read one entry with its offloaded body;
   thread usage names each run's prompt entry.
2. Protocol (own commit): `detail_expanded` UI preference (the key KOBE-202 left room for).
3. Web: timing and offloaded-result mapping in the projection (`lib/chat/history.ts`,
   `tree.ts`); `reasoning.tsx`, reworked `tool-call.tsx`, `message-footer.tsx`, `detail.tsx`
   (provider, toggle, disclosure); the toggle in bar row two.

## Decisions

- **New server route** `GET /v1/threads/{id}/entries/{entryId}` (`routes/threads.ts`,
  `threads/entry-body.ts`): `{entry_id, payload}`. No route read offloaded bodies back before
  (only fork and export touched them). Visibility = `findThread` (owner; project readers once
  shared); the entry query names `team_id`; the body is read only from the thread's own object
  tree (`threadKey`), capped at 8 MB and parsed as JSON, else 409 `entry_unavailable`. Inline
  entries answer as stored. Tests: `thread-sharing.db.test.ts` "offloaded entry bodies".
- **Usage change** (no new route): `runsUsage` LEFT JOINs `runs` (same `team_id`) for
  `user_entry_id`, so `GET /v1/threads/{id}/usage` lets the footer put each run under the answer
  to its prompt (entries carry no run id). Several runs on one prompt (retry) are summed.
- **Which entry is a large tool result:** an offloaded body's role is unknown client-side. Pi
  appends results after the calling step in call order, so an offloaded entry under a step
  (directly or after other results) answers its next unanswered call; anywhere else it stays the
  "too large" notice. The card reads the body only when opened (Detail toggle included), once.
- **Timing** uses Pi's clock: reasoning = the step (message `timestamp` → entry `timestamp`;
  Pi has no separate end of thinking), tool = calling entry → result entry. An offloaded entry
  has no payload here, so its `created_at` stands in. Live parts show "Thinking…" / no duration
  until committed.
- **Collapse model:** each block follows the Detail toggle unless opened or closed by hand since
  the toggle last changed (a generation counter). Bodies stay mounted with `hidden`, so a fetched
  output survives closing. Reasoning uses assistant-ui's reasoning part (and its `timing` field);
  no primitive exists for the disclosure itself, so it is a small `Disclosure` component.
- **Footer** = run_usage models, tokens in/out, cost (when priced) and the answer's stored time;
  revealed on hover/focus where hover exists (`group/answer`), always present for touch.
- Detail command `detail` (Mod+Shift+D, unbound while `SHORTCUTS_BOUND` is false); the toggle is
  an `IconAction` with `aria-pressed`.

## Open questions (for Chris or the coordinator)

- The PR is ~1,180 net lines (about 560 production, the rest tests). Split if wanted:
  (1) server + protocol commits (~160), (2) projection + API + FakeKobe (`history.ts`, `tree.ts`,
  `api.ts`, ~280), (3) components and the fixture test (~740).
- Reasoning duration is the whole step (thinking plus the text after it): Pi records no end of
  thinking. Fine for v1.1?

## Evidence (acceptance criteria → test or command output)

- ac-1: `components/chat/rich-history.test.tsx` "rendering a recorded thread" (reasoning first
  line + duration, tool header + full I/O, large output read only on open and once, failure
  alert, footer); `lib/chat/history.test.ts`; `lib/chat/tree.test.ts` "rich history".
- ac-2: `rich-history.test.tsx` "the Detail toggle" (all open/closed, PUT `detail_expanded`,
  restored after reload); `lib/shell/preferences.test.ts`; protocol `ui-preferences.test.ts`.
- ac-3: `rich-history.test.tsx` "collapsed by default" (answer shown, every block closed, no
  crushed icon buttons).
- Server: `thread-sharing.db.test.ts` (owner/reader/outsider/other team, foreign key, missing,
  not JSON), `usage.db.test.ts` (`user_entry_id`).
