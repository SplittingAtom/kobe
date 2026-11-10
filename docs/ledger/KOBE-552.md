# KOBE-552: flaky db-server tests

## Causes

1. `sync-conflicts.db.test.ts` "tells a run active on the connection at once with a note frame":
   the handler calls `send`, then marks the note told afterwards (`markTold`). The test read
   `takeAgentNotes` right after the frame, before the told-mark landed. Already fixed on main by
   b0b6e6ea (expect.poll on the told-mark, 2026-11-07, after the failing run); verified here, no change.
2. `schedule-governance.db.test.ts` "a user's own Stop is still user_cancelled": `Orchestrator.cancel`
   returns after its transaction; the transition listeners are notified from a tracked background
   step (`#emit` re-reads the row first). The test read `causes.get(runId)` right after the HTTP
   response, before the listener ran. Test-only race, product ordering is by design. Fix: `expect.poll`
   on the cause. The two `system_cancelled` assertions in the same describe read the same
   listener-fed map and got the same poll.

## Results

- Both files, 20 consecutive runs (`test:db` config): 20 pass, 0 fail.
- One run under CPU contention (2x nproc busy loops): 26/26 pass.
