# KOBE-730: Extract and unit-test renderPage from event-stream/stream.ts step() and the nested part of retention exportZip

- **Status:** in review (group 59)
- **Branch / worktree:** `group-59-server-helpers` in `../Kobe-g59`
- **Depends on:** KOBE-731 (same branch)

## Plan

Review CODE-34: pure extraction, no behaviour change. `event-stream/read.ts` and
`event-stream/stream.test.ts` untouched (new test files only).

## Decisions

- `renderPage(page, lastSent, epilogue)` in `event-stream/stream.ts`: renders one page of events
  as SSE text and returns `{ text, lastSent, terminal, announced, epilogue, dirty }`. It does not
  mutate its input: the tracked epilogue's written set is copied when an event is added (pages
  hold at most 50 rows). `step()` applies the result: arms one epilogue timer per announcement (as
  each old `waitForEpilogue` call did), sets `endReason` for a terminal event or a closed
  epilogue, `dirty` when the run's last seq is past what was sent, and enqueues the text. The
  time-dependent `epilogueStillOpen()` check stays in `step()`.
- `exportZip` (retention/export.ts): the per-thread body (nesting 6) is split into generators
  `threadExport` -> `sessionFile`, `transcriptFiles` (+ `branchFile`), `artifactFiles`,
  `threadFiles`; `storedFiles` (memory files and projects), `feedbackFile`, `jsonArrayFile`
  (memory items, eval cases) and `copyObject` (the two copies of the object-to-entry loop). Pure,
  exported and unit-tested: `threadIndexEntry`, `jsonArrayItem`, `jsonArrayEnd`. Entry order, file
  names, bytes and the drain points are the same as before.

## Docs

No user-facing change: no `docs/guide` update needed.

## Evidence (acceptance criteria → test or command output)

- ac-1: `event-stream/render-page.test.ts`: terminal event mid-page, epilogue announced (and events
  after it counted as written), stale seq skipped, `lastSeq > lastSent` leaves dirty, input epilogue
  not mutated.
- ac-2: `retention/export-parts.test.ts`; `event-stream/stream.test.ts`, `retention*.db.test.ts`,
  `retention-export*` green (see results).
- Results: event-stream and retention unit tests 13 files / 99 tests; event-stream, retention and
  export db tests 6 files / 73 tests; `pnpm verify` green; server db suite 268 files / 3312 tests.
