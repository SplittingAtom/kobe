# KOBE-240: Memory search: avoid reading up to 200 docs inside one DB transaction

- **Status:** in review (group G1, branch `group-1-fixes`)
- **Branch / worktree:** `group-1-fixes` in `../Kobe-g1`
- **Depends on:** [KOBE-156](KOBE-156.md). No migration.

## Plan

`recall` (`readMemory`, `services/server/src/memory/agent.ts`) used to run the run/switch/membership
checks, the doc listing, one `memory_doc_versions` lookup per doc and every blob read inside one
`withTeam` transaction: a 200-doc search held a pooled connection idle in transaction for every
object-store round trip.

## Decisions

- **List in the transaction, read bodies after it.** The checks and `listMemory` (now also selecting
  the current version's `blob_ref` in its existing join) run in one short `withTeam`; the bodies are
  read after it commits, by those keys only. Removes the 200 per-doc version lookups too.
- **Not Postgres full-text search:** content lives only in S3 (`memory_doc_versions.blob_ref`, spec
  D24: never in Postgres), so a tsvector would mean copying content into the DB. No index is needed
  (the listing already uses the owner/project unique indexes), so **no migration**.
- **RLS / ownership:** every DB read still goes through `withTeam`; the docs are the caller's own
  (personal: `owner_user_id = caller`; project: member check in the same transaction). Outside it the
  code carries only server-written keys from those rows (never a path or key from the sandbox) and
  the bytes go only into this caller's reply. Versions are immutable, so the object read is exactly
  the listed version. A change in the gap (doc deleted, member removed) is equivalent to the read
  having finished just before it; a purged object reads as missing and is skipped, as before.
- **Results unchanged:** path order (then scope), first 200 docs, at most 20 files and 256 KiB,
  `truncated` as before. Blobs are fetched 8 at a time but matched strictly in path order, so the
  answer is identical; at most 7 extra objects are read past the stopping point.
- `readMemory` now takes only `db`, `blobs`, `log` (all it uses).
- Not changed: `run.start.memory` (`loadIndex`) and the panel's single-doc read still read one or two
  blobs in their transaction; small, left as is.

## Evidence

- ac-1: `services/server/src/memory-search.db.test.ts`: 210 docs; a probe in the object store's `get`
  asserts no backend is `idle in transaction` on a memory query while any blob is read (failed
  before the change, passes after); ranking/limits (20 of 29 matches, `truncated`), a doc past the
  200 window is not searched but a path read finds it, a missing object is skipped, an ended run
  reads nothing. `memory-agent.db.test.ts` and `memory.db.test.ts` unchanged and green.
- Latency (dev Postgres, 220 personal docs, no-match query = 200 blob reads, 40 runs each; simulated
  object-store latency per get; hold = pool acquire to release):

  | S3 delay | before p50 / p95 | after p50 / p95 | hold before p50 / p95 | hold after p50 / p95 |
  | -------- | ---------------- | --------------- | --------------------- | -------------------- |
  | 0 ms     | 342 / 435 ms     | 33 / 54 ms      | 342 / 435 ms          | 28 / 50 ms           |
  | 2 ms     | 1023 / 1095 ms   | 129 / 139 ms    | 1023 / 1095 ms        | 57 / 65 ms           |
  | 5 ms     | 1816 / 1863 ms   | 209 / 225 ms    | 1816 / 1863 ms        | 47 / 60 ms           |

  The hold is now the checks plus one listing query, independent of object-store latency.
