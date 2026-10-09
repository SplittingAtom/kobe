# KOBE-186: flaky workspace-sync-limits M4

## Status

PR open; evidence below.

## Findings

- Failing test: M4 "collections kicked by quota pressure run one at a time per replica", the final
  `expect.poll(counters(b).blob_count).toBe(0)` (expected 1 to be 0).
- Race: a's kicked collection decrements `blob_count` inside its delete transaction, then still runs
  `reconcile` before releasing the per-replica `kicking` slot. The test treated `blob_count == 0` as
  "collection over", re-uploaded b2 while the slot was still held, so the kick was dropped (by design:
  one per replica) and b's collection never ran. Not a product starvation bug: a dropped kick is
  retried by the sandbox's next upload.
- Fix: `WorkspaceSync.settled()` resolves when the in-flight kicked collection has fully finished; M4
  awaits it instead of polling a counter (no sleeps, no wider assertion). It also asserts the slot is
  still held while deletes are gated.
- Not reproducible locally before the fix (DB is remote and fast); window is the reconcile query.

## Evidence

- Server `test:db` file, 20 runs with 16 CPU burners: 20/20 passed (all 14 tests in the file).
