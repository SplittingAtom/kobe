# KOBE-288: Chat state glitches found by the Playwright suite

- **Status:** committed on `group-1-fixes` (ticket group G1; no PR of its own)
- **Branch / worktree:** `group-1-fixes` in `../Kobe-g1`
- **Depends on:** KOBE-285 (the suite that found them, `docs/ledger/KOBE-285.md`), KOBE-205 (scroll)

## Root causes

1. **"Sent, waiting for the agent" after a run ended.** The server mirrors Pi's entries at
   `turn_end`, so a run that ends before its first turn ended (Stop before the answer, a start
   failure, a budget stop) never streams `entry.committed` for its prompt; after Stop the mirror is
   refused outright (the run is no longer active). The client kept the send's copy of the prompt
   with `pending: true`, and the note was tied to `pending`, not to the run being active.
2. **Phantom "Version 1 of 2 · Sent, waiting for the agent" after a ~30k-token send.** The prompt
   (~140 KB) is over the 64 KiB `entry.committed` payload cap, so the event carries no `payload`.
   `live.ts` only recognised the prompt by `payload.message.role === "user"`, so `promptCommitted`
   stayed false: the send's copy stayed in the overlay as a sibling of the stored entry (a second
   version, the head, waiting). The thread read after the run had the real entry, but nothing
   reconciled the two until a reload.
3. **Wheel-up at a run's end did not unpin.** Three paths re-pinned without the member:
   - `useRepinOnSend` armed "re-pin when the sent message renders" on `composer.send`, which
     assistant-ui delivers in a microtask, after the message had already rendered (discrete event,
     synchronous render). The flag then waited for the next change in message count: a queued
     run's prompt joining the list, or the run's end in some orders. It fired a scroll-to-bottom
     request there, which pins.
   - "Reaching the bottom pins" (`isAtBottom` from the viewport store): at a run's end the list
     shrinks ("Working…" goes) and its box grows (the steering panel folds), so a member a little
     above the bottom is clamped onto it and was re-pinned.
   - In the frame between the wheel's unpin and React committing `autoScroll={false}`,
     assistant-ui's resize observer still follows and scrolls to the bottom; that scroll counted
     as reaching the bottom (and as a "down" move into the 48 px band).

## Fixes

- `tree.ts`: the send's prompt copy carries `waiting: active`; `messages.tsx` shows the note (and
  the faded style) only while `waiting`. The copy itself stays after the run ended (like text cut
  off by Stop, it is what the entries don't have); `pending` still means "no entry" (no Edit, no
  Fork).
- `thread-state.ts` `liveOverlay`: the prompt counts as saved when the stream said so or the tree
  holds a user message the run committed (`promptSaved`); then the copy goes. `thread-controller.ts`
  reads the thread when an `entry.committed` arrives without its body, so the stored entry (and
  its role) shows during the run, not only after it.
- `use-follow.ts`: the send's second re-pin only waits when the message has not rendered yet (the
  thread was not running at the event: a new thread is created first); reaching the bottom pins
  only when the member moved down there while assistant-ui was not following (committed mode
  `unpinned`), or when the list no longer overflows.
- Fake (`fake-kobe.ts`): `entry.committed` omits `payload` over 64 KiB, as the server does;
  `agent.budgetStop`.

## Decisions

- Kept the unsaved prompt on screen after Stop instead of dropping it: the steering spec expects
  the stopped message to stay, and the overlay already keeps an ended run's cut-off text. A reload
  shows the server's tree (without it, since Pi's entries were not mirrored).
- The frame race is reproduced by doing growth, wheel, scroll and resize inside one `act()` (React
  does not commit in between), which is deterministic; no fake timers were needed.

## Playwright workarounds removed (e2e/browser)

- `support/chat.ts` `waitForIdle` checks again that no "Sent, waiting for the agent" shows.
- `steering-panel.spec.ts`: after Stop, asserts the note is gone.
- `compact-now.spec.ts`: no reload after the long turn; asserts no "Version n of m" label.
- `scroll-follow.spec.ts`: wheels up before the run is stopped or ends, then checks unpin, the
  pill and the held position through the run's end.

**To do after G1 deploys:** run the suite without the workarounds on gate1 (gate1 runs main, so
it can't prove these fixes before then).

## Evidence (acceptance criteria → test or command output)

- **ac-1:** `apps/web/components/chat/run-end.test.tsx` "no message waits for the agent after its
  run ended": Stop, `run.completed`, `run.failed`, `run.budget_stopped` before Pi saved the
  prompt, and Stop after it saved prompt and part of the answer. The first four failed before the
  fix (note still shown).
- **ac-2:** `run-end.test.tsx` "a prompt over 64 KiB reconciles with its stored entry": one copy,
  no version label, nothing waiting, during the run and after it; the list's text after the run
  equals a fresh load's. Both failed before (during the run without the controller read; after
  the run without `promptSaved`).
- **ac-3:** `apps/web/components/chat/scroll.test.tsx` "a scroll up in the last frames of a
  stream": a queued send does not re-pin when its run starts (failed with the old send hook); the
  run's end shrinking the list onto the member; new content and the wheel in one frame before the
  re-render (both failed with the old at-bottom rule); reaching the bottom while the list grows
  still re-pins. Suite: workarounds removed (above); gate1 run pending the G1 deploy.
- `apps/web` vitest: 126 files, 1200 tests passed; `pnpm verify` green (DB tests not run: no `KOBE_TEST_DATABASE_URL`).
