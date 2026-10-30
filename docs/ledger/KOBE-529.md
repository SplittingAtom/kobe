# KOBE-529: Perf: workspace writes sit above the 300 ms p95 budget

- **Status:** in review (group branch; not pushed by the ticket agent)
- **Branch / worktree:** `kobe-529-perf` in `../Kobe-wt529`
- **Depends on:** KOBE-525 (route spans, baseline doc, latency queries)

## Plan

Child spans inside the three write routes that split object-store time from Postgres, a query
that reads them, and a budget proposal for routes with an object-store round trip.

## Decisions

- One helper module, `services/server/src/workspace-sync/write-spans.ts` (`s3PutSpan`,
  `writeTxSpan`, `lockWaitSpan`), on `withSpan`, so spans nest under the `honoTracing` server span.
- Span names: `workspace.s3_put` (attribute `kobe.workspace.s3_op` stream/copy/put/delete),
  `workspace.reserve_tx`, `workspace.blob_tx`, `workspace.manifest_tx`, `workspace.lock_wait`
  (attribute `kobe.workspace.lock` workspace/team_storage, inside `manifest_tx`). All carry
  `kobe.workspace.write` (upload/drop/artifact/save/blob); transactions carry
  `kobe.workspace.outcome`, a code word or `other`/`error`. No ids, paths or content.
- The blob PUT has no workspace lock of its own (its reservation updates the row; not separable
  cheaply), so it has no `lock_wait`.
- A save's `team_storage` lock wait includes the team quota read (`teamStorageAllows` does both);
  not split, to avoid a second lock round trip.
- An upload's `stream` and a blob's `put` include receiving the request body, so a slow client
  counts as object-store time. Stated in the doc and the query comment.
- Budget: proposed, not decided (see the baseline doc, KOBE-529 subsection).

## Open questions (for Chris or the coordinator)

- Query 7 assumes `events_core` has a `trace_id` column (not verified on gate1; check with query
  0's DESCRIBE before the first run).
- Budget proposal for write routes (Kobe-side p95 < 300 ms, whole request p95 < 600 ms) awaits
  Chris.
- Numbers in the KOBE-529 table: measured after the next gate1 deploy (coordinator).

## Evidence (acceptance criteria → test or command output)

- ac-1: `services/server/src/workspace-sync/write-spans.test.ts` (8 unit tests: name, parent,
  attributes, error flag, outcome, off when tracing is off) and
  `services/server/src/workspace-write-spans.db.test.ts` (3 tests, one per route, real Postgres:
  children under the server span, lock waits under `manifest_tx`, failed put flagged, no names or
  ids in attributes). Touched DB suites (workspace-files, -save, -sync, -blob-heal,
  -sync-team-quota, -sync-limits, artifact-edit-as-file) pass; server lint and typecheck clean.
- ac-2: `docs/perf-baseline-2026-10-30.md` (KOBE-529 subsection) and
  `docs/perf/latency-queries.sql` queries 7a/7b; awaiting gate1 numbers.
