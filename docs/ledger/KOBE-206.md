# KOBE-206: B2: Steering panel replaces the run panel

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (PR #264)
- **Branch / worktree:** `kobe-206-steering-panel` in `../Kobe-wt206`
- **Depends on:** KOBE-205 (fixed composer footer), KOBE-203 (IconAction, registry), KOBE-201

## Plan

CE10: `components/chat/steering-panel.tsx` (status and controls rows, expand, live region) and
`steering-queue.tsx` (chips) sit directly above the composer input in KOBE-205's fixed footer.
`lib/chat/steering.ts` derives the mode and phase from the thread state and the event stream
(pure). `lib/chat/use-steering.ts` holds the budget re-read, the throttled live text and the
elapsed clock.

## Server gaps (coordinator approved 2026-10-13, two commits in this PR)

- **Reorder:** there was no route. `POST /v1/threads/{id}/queue/order {run_ids}` is owner only
  (`lockOwnedThread` in `withTeam`, the same thread row lock as submit, resume and promotion).
  The ids must be exactly the queued set, else 409 `queue_changed`. The body holds UUIDs with
  no repeats and at most 25 ids (the queue cap, `QUEUE_ORDER_MAX`, now also
  `RUN_DEFAULTS.maxQueuedPerThread`). `queue_pos` is rewritten in two steps (above the current
  max, then 1..n) to get past `runs_queue_pos_unique`. Retries keep running first: positions are
  written retries first, so `queue_pos` agrees with the computed rank. Code in
  `services/server/src/runs/queue-order.ts`.
- **Pause:** only Stop paused the queue. `POST /v1/threads/{id}/queue/pause` follows the same
  ownership and lock rules. It does nothing when nothing is queued or the queue is already
  paused. Promotion and the sweep already honour `queue_paused_at`, and a new message still
  releases it.
- **Audit:** new actions `run.queue_paused {threadId, queued}`, `run.queue_resumed {threadId,
wasInterrupted}` (resume had none) and `run.queue_reordered {threadId, queued}`; in
  `docs/audit-log.md`.
- Both routes return ThreadRuns like `queue/resume`, and both are in the OpenAPI doc.
- **Not changed:** "finishing on budget" has no live signal (`budget_stop_scope` is not in the
  snapshot, and no event fires until `run.budget_stopped`). It is derived on the client instead:
  an exhausted budget status while a run holds the thread. The status is read at run start and on
  tool results at most every 5 s. **Follow-up for the coordinator:** a live `budget_stop` event
  would be cleaner (a protocol contract PR).

## Decisions

- **States** (`steeringMode`): interrupted > waiting (an approval asked and not resolved, or the
  run is `waiting_approval`) > active (a run holds the thread) > queued (queued messages or one
  being queued, with no run) > idle.
- **Phase:** approval > finishing on budget > waking (`sandbox.waking` until work) > running tool
  `<name>` (the latest call without a result) > thinking. Agent = the thread's agent name. Model =
  `run.started.model`, else the agent's pin, else the thread's choice, else "Default model".
  Elapsed counts from `run.started.ts` (now kept in `LiveRun`), else the snapshot's `started_at`,
  else first sight.
- **Zero height:** the panel is a one-row grid, `0fr` when idle and `1fr` otherwise, with
  `transition-[grid-template-rows]` and `motion-reduce:transition-none`. When idle the inner box
  is empty and `inert`.
- **Live region:** a separate polite `role=status` (`data-kobe-phase-live`). The phase text
  changes at most once per 2 s, and the latest phase wins. The thread's own announcements are
  unchanged. The `announcement()` test helper skips the phase region.
- **Queue chips:** clicking a chip edits it (inline editor, "Edit queued message N"). ×
  (`delete-queued`) deletes it. The grip (`move-queued`) reorders, with pointer events (capture,
  and drop index from the start-of-drag chip centres) or with Arrow keys, Home and End. Focus stays
  on the moved chip (keyed by run). Reorder is optimistic. A refusal (`queue_changed`) shows the
  error and reads the queue again. Pause (`pause-queue`) shows while a run is on; Resume
  (`resume-queue`) shows while the queue is paused. No new dependency.
- **Composer:** while a run holds the thread, the primary button is **Queue** and Enter queues.
  Steer now (`steer`, Mod+Shift+Enter, registered, and the tooltip shows the key because the
  composer binds it) and Stop moved to the panel's controls row. Steer now sends the composer's
  text. It is unavailable with nothing typed, or with files attached, because a steer carries text
  only (the keyboard path refuses files too).
- **run-panel.tsx removed.** Its non-steering parts (connection banners, run notices, how the
  last run ended, run usage, budget banner, action error) live on in `run-notices.tsx` above the
  footer. Git shows it as a rename. The waking banner became the panel's phase. Approval cards
  stay in the thread.
- **Readers** of a shared thread see the status row only, while a run is on.

## Open questions (for Chris or the coordinator)

- Size: web ~780 added / ~225 removed non-test lines (about 550 net, a good share of it comments),
  plus ~190 server lines from the two approved route commits. If you want a split: (1) the server
  routes (both commits), (2) the web panel.
- Dictation keeps listening when the panel's Steer now clears the text. The composer's keyboard
  steer still stops it.

## Evidence (acceptance criteria → test or command output)

There is no Playwright suite, and the bash e2e (`e2e/gate1`, `gate2`, `executor`) drives only the
API. It greps no run-panel selectors, so it needs no change.

- **ac-1:** `components/chat/steering-panel.test.tsx` "walks idle → active → queued → waiting →
  interrupted" is the component-level state machine test in place of the "one e2e". It covers:
  zero height idle; active with model, elapsed, thinking and running tool bash; queued (paused
  after Stop); waiting (approval; the card is in the thread, not the panel); interrupted (Retry
  and Continue). Also "back to zero height", "works at 390 px" and unit tests in
  `lib/chat/steering.test.ts`.
- **ac-2:** same file, "queue chips": edit, delete, keyboard reorder, pointer drag reorder, stale
  order 409, pause and resume, each against the fake server's routes. Server:
  `services/server/src/runs-queue-order.db.test.ts` covers the order applied and the next start
  following it; 409 for a stale or partial set; body validation; a team member and another team
  get 404 (cross-team); a run start racing a reorder; pause holding past the run end, then resume,
  idempotent, nothing queued, a new message releasing it; and the audit rows.
- **ac-3:** `run-panel.tsx` is gone. "composer and controls": the Queue label; Steer now with its
  shortcut sending the typed text; Ctrl/Cmd+Shift+Enter; Retry from last entry and Continue
  without retry from the panel; Finishing on budget. The existing `conversation.test.tsx` queue,
  Stop and interrupted cases pass against the panel.
- `lib/chat/use-steering.test.ts`: the throttled live text and the budget re-read throttle.
