# KOBE-184: File browser follow-ups (stream uploads, paging cursor, legal_hold, live listing)

- **Status:** in progress
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
