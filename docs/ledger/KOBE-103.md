# KOBE-103: drift notifications

- **Status:** in review
- **Branch / worktree:** `kobe-103-drift-notifications` in `../Kobe-wt103`
- **Depends on:** KOBE-102 (PR #137; merge main again after it lands)

## Decisions

- **No migration, no new table.** The audit log is the queue: `mcp.connector.drift` (KOBE-102) is
  the event; a new `mcp.connector.drift_notified` `{connectorId, driftSeq, recipientId, emailed}`
  (ids and counts only) records each (event, recipient) once. It is also the dedupe and rate-limit
  record.
- **Delivery** (`connectors/drift-notify.ts`): runs after every refresh pass (inside the refresh
  lock, so one replica). Considers drift events of the last 24 h whose connector still has `drifted`
  tools (re-approval or removal ends it). Email first, audit row after the SMTP server accepted it:
  at least once, a failed send is retried next pass.
- **Rate limit:** one email per connector and recipient per 24 h; a further event inside the window
  is recorded `emailed: false` and not retried (the in-app notice still shows it).
- **Content:** connector name and changed/new tool names (max 20, then a count) and a link to
  `/admin/connectors`. No descriptions, schemas, URLs, secrets.
- **In-app notice:** `GET /v1/me/connector-notices`, derived from connector state (no storage), so it
  clears on re-approval. No general notifications mechanism exists yet (KOBE-176/177); when it
  does, `notifyDrift` becomes a producer and the endpoint can go. No web banner in this PR.
- **Recipients rule** (`connectors/drift-recipients.ts`, the one place to change): active install
  owner/admins, plus active `team_admin`s of teams with a `team_connectors` row for the connector.
  Members are not told. KOBE-104 (enablement) needs nothing if it keeps using `team_connectors`.
  KOBE-108 (per-user grants; no grants table exists yet) adds the users holding a grant to
  `driftRecipients` and their connectors to `driftNoticesFor`.

## Evidence

- ac-1: `connectors/drift-notify.db.test.ts` "emails install admins and admins of teams ... once";
  rate limit and retry tests beside it; in-app notice test.
- ac-2: same file, content assertion (no description text, no URL).
