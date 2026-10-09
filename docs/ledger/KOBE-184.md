# KOBE-184: File browser follow-ups (stream uploads, paging cursor, legal_hold, live listing)

- **Status:** in review
- **Branch / worktree:** `kobe-184-files-contract-paging` (contract), `kobe-184-file-browser-followups` (feature), `../Kobe-wt184`
- **Depends on:** KOBE-143, KOBE-148, KOBE-147

## Plan

Contract PR first (`packages/protocol/src/files.ts`, additive), then the feature PR on top. No migration.

## Decisions

- **Contract:** list query gains optional `cursor`, response optional `next_cursor` (opaque base64url,
  <= 1024 chars; present exactly when more entries follow). Error code `legal_hold` added; `read_only` kept.
- **Live listing: deferred.** It needs a new server -> sandbox request/response pair (a `fs.list` frame with
  capability negotiation, agent-side directory walk with path confinement and caps, server-side merge of
  `live` rows, a live download path, wake/timeout behavior). The wire has no server-initiated request
  pattern for filesystem reads to extend (frames are run/sync/memory/share scoped), so it is not small and
  would put an unreviewed sandbox-reading surface in a contract PR. Follow-up ticket; the contract already
  has `source: "live"` and `sandbox_unavailable`. `POST /wake` (KOBE-148) stays the interim.
- **Cursor (keyset):** list order is folders first, then name (`COLLATE "C"`). The cursor is base64url JSON
  `{d: 0|1, n: name}` of the last entry of the page; the next page is a `HAVING` on that position. Stable under
  concurrent adds/removes (no repeats, no skips of unchanged entries). Page size 5000 (`listPageSize` option for tests);
  `next_cursor` only when more follow. Bad cursor: 400. A cursor page that is empty is 200 (not 404); `x-kobe-truncated` removed.
  Not signed: it only names a position in the caller's own listing.
- **`legal_hold`:** delete under a hold now returns 409 `legal_hold` (was `read_only`).
- **Streaming upload:** `POST /v1/workspace/files` uses KOBE-143's `openUpload` (now takes a fields schema), `UploadMeter` and
  `putStream` into a staging object `<workspace>/incoming/<uuid>`, then reserve, server-side `copy` to the content-addressed
  key (skipped if the workspace already holds it), record blob; staging always deleted. Memory is bounded (S3 multipart).
  Team storage quota (KOBE-143 `lockTeamStorage/storageLimit/storageUsed`, install default from `deps.uploads`) is now enforced
  in the commit transaction too. Content-Length still required (411). Extra file parts are ignored (143 behaviour; was 400).
  A refused-after-stream upload (quota, taken) leaves its content-addressed blob unreferenced for the workspace collector.
  Crash between staging put and delete leaves a staging object (no queue like 143's threaded keys); needs a lifecycle rule on
  `incoming/` or a sweep: open question. Scan seam (KOBE-146) not wired: workspace files have no `files` row.

## Open questions

- Add an S3 lifecycle rule or sweep for `workspace/incoming/` leftovers?
- Live listing follow-up ticket (see above).

## Evidence

- ac-1: `workspace-files.db.test.ts` "paging", "streams through the uploads pipeline", "cuts an oversized body off mid-stream",
  "counts against the team storage quota", legal hold test (`legal_hold`); `files.test.ts` (contract).
