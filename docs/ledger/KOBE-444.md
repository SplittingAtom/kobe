# KOBE-444: SIGTERM ended a run failed (or completed) instead of interrupted

- **Status:** in review (Opus), committed on `hotfix-443-444`, not pushed
- **Branch / worktree:** `hotfix-443-444` in `../Kobe-hf`
- **Depends on:** KOBE-227 (U19's kill-mid-stream test), KOBE-258 (`entries_not_saved`)

## Root cause

U19 "interrupted: Retry, then Continue" (gate5-a) failed in the merge queues for #316 (run 39219456268) and #317 (run 39257421127). It waited about 5 min for `data-state=interrupted`. The
page showed "Run failed: … messages could not be saved".

The test deletes the sandbox pod gracefully, so the agent gets SIGTERM. `Agent.stop` drained 10 s,
then `#abort`ed the run. Pi settled it, and the agent stopped Pi straight away. The server's
run-end entry sync (`get_entries`) then got `pi_unavailable`, then `connection_lost`, and the run
ended **failed** `entries_not_saved`. If the sync had won the race, it would have ended
**completed**. Either way it never reached `interrupted`, so there was no Retry. It passed only
when Pi did not settle the abort within 2 x 5 s: Pi was then killed with the run still set, the
agent sent `pi.exited`, and the server interrupted the run. Passing runs take 1.2–1.4 min, which
fits that path.

Not a KOBE-325 regression: 325 changed neither the agent's shutdown or abort nor `ingest.ts`.
Not the KOBE-415/429 reconnect class: the "frame rate exceeded" storm ended minutes before the
kill, and the connection was stable through it.

## Decisions

- `ThreadManager.shutdown(deadlineMs, mode)`. `drain` (the server's `shutdown` frame, used for
  hibernation) works as before: it aborts and Pi settles. `terminate` (SIGTERM and SIGINT in
  `index.ts`): a run still active after the deadline, with its prompt in Pi, is **lost**. Its Pi is
  stopped without an abort, and the run is returned. A run still preparing is ended as before.
- `Agent.terminate(deadlineMs)`: after Pi stops, it waits until the outbox has forgotten each lost
  run, meaning the server acked (stored) every frame already sent. Frames are re-sent on a
  reconnect as usual. The wait is bounded by `LOST_ACK_TIMEOUT_MS` (3 s; past it a warning is
  logged). Then `pi.exited` (`exit_code` null, `signal` "SIGTERM") goes out for each lost run, and
  the server's existing handler interrupts it with cause `pi_exited` (Retry and Continue).
  Only then does the workspace flush run and the wire close. Budget: 10 s drain + Pi stop + at
  most 3 s + the flush, within the 30 s grace. If SIGKILL comes first, the sweeper still
  interrupts the run once the connection has been closed for 30 s.
- Nothing already sent is lost. Every event frame is stored before the run is interrupted, because
  the report waits for the acks. Pi's entries live in its session file on the workspace volume
  (`/workspace/.kobe/sessions`), which is flushed afterwards. The server forgets the thread's sync
  on `pi.exited`, so the next run mirrors them with a full sync, exactly as for a Pi crash.
- Traces: a lost run's `sandbox.run` span ends `failed`, with error `pi_exited`.
- Not changed (optional defence in depth, not needed for U19): the server could end a run whose
  run-end sync failed _because the connection closed_ as interrupted rather than `entries_not_saved`.

## Open questions (for Chris or the coordinator)

- U19 itself is unchanged. Its kill is the graceful case this fixes.

## Evidence (acceptance criteria → test or command output)

- RED, then GREEN: `services/sandbox-agent/src/agent.terminate.test.ts`, 7 tests:
  - a lost run gets `pi.exited` and no `abort` or `agent_settled`;
  - the report waits for the server's ack, then exits;
  - un-acked frames are re-sent after a reconnect before the report;
  - when no ack ever comes, the run is still reported after the bounded wait;
  - a run that ends within the deadline settles and reports nothing;
  - the hibernate `shutdown` frame still aborts and settles;
  - the lost run's span ends `failed`.
- `@kobe/sandbox-agent` unit tests: 860 passed (real-Pi suites skipped locally).
- CI gate5-a (U19) is to be confirmed on the PR.
