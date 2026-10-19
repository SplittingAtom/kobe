# KOBE-431: Connector refresh probes with a site admin's credential

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

Group G10 (`group-10-connectors`), together with KOBE-303. Decision by Chris (2026-10-19):
**option (a)**, the key of the site admin who last pinned or approved the connector; a 303 site
key first; never a member's key; the choice audited without the value; an `auth_required` skip
shown to site admins on the connector page and as a drift notification.

## What changed

- **Schema** (`0149_connector_refresh_probe`, generated): `connectors.pinned_by` (FK users, ON
  DELETE SET NULL), `refresh_skipped` (failure code, CHECK `^[a-z_]{1,32}$`), `refreshed_at`.
- **Backfill** (`0150_connector_pinned_by_backfill`, custom): `pinned_by` = user actor of the
  latest `mcp.connector.pinned` / `.reapproved` audit row, else `created_by`; unpinned stay NULL.
  No RLS on either table. Upgrade test: `packages/db/src/connector-pinned-by-upgrade.db.test.ts`.
- **One choice function** `services/server/src/connectors/probe-credential.ts`:
  `chooseProbeCredential(db, envelope, connectorId, adminId | "pinned_by")` → site key (303) →
  the admin's own key via `adminProbeKey` (only while active and holding a site role) → none.
  Non-`api_key` connectors never look anything up. KOBE-430's Re-probe button should call
  `pinConnector(..., { credential: adminPinCredential(db, envelope, adminId), pinnedBy })` or
  `chooseProbeCredential` directly.
- **Audit** `mcp.connector.probe_credential {purpose: pin|refresh, credential: site_key|admin_key|none, adminId?}`:
  every pin (as the acting admin); the refresh (system) only when the choice changes (compared
  with the last refresh row in `audit_log`). `mcp.connector.refresh_skipped {reason: auth_required}`
  when a skip begins (not per pass).
- **Pins** set `pinned_by` = acting admin (registration, URL change, `POST /:id/pin`);
  **re-approval** sets it to the approving admin (`approveConnectorTools(..., approvedBy)`).
- **Refresh** (`refresh.ts`) takes `{ envelope }` (jobs.ts passes `deps.envelope`), writes
  `refreshed_at` every pass, `refresh_skipped` on a skip (under the row lock, URL unchanged),
  clears it on a good pass, a pin or a URL change.
- **Surfacing**: `GET /v1/site/connectors[/:id]` carries `refreshSkipped` / `refreshedAt`; the
  registry page shows "Not checked for changes: needs a key" with whose key is used;
  `/v1/me/connector-notices` gives site admins `{tools: [], refreshSkipped: "auth_required"}`;
  `notifyDrift` emails site admins (only) once per skip event ("tools are not checked for
  changes"), deduped by `mcp.connector.drift_notified` with `driftSeq` = the skip row.

## Tests

- `services/server/src/connector-probe-credential.db.test.ts` (7): pin records admin + choice;
  refresh with the admin key finds new tools drifted; a member's key is never used (no admin key
  → `auth_required`, skip stored, one event, page shows it, cleared after the admin re-adds a
  key); demoted or deactivated admin → skip; approval moves `pinned_by`; `none` auth; email +
  notices for site admins only.
- `connectors.db.test.ts` audit test now expects `mcp.connector.probe_credential` rows.
- Web: `components/admin/connectors-page.test.tsx` "refresh skips (KOBE-431)".

## Review fixes (2026-10-19, review-g10 M1, L2, L3, tests 1 and 6)

- **M1 (coordinator decision):** `nextPinnedBy` (probe-credential.ts) moves `pinned_by` to the
  approving or pinning admin only when their own key is usable, or when the admin named now has
  no usable key (null, deactivated, demoted, keyless); otherwise it stays. Used by
  `POST /:id/tools/approve` and every pin.
- **L2:** the remedy text depends on `credentialSource` (pin message, skip email, registry page):
  for a site-key connector, "set (or re-enter) its site-wide key".
- **L3:** `mcp.connector.drift_notified` carries `kind` (drift | skipped); the email rate limit is
  per connector, recipient and kind, so a skip email never holds back a drift email.
- Tests: keyless approver keeps a keyed `pinned_by`; keyed approver takes over; keyless approver
  takes over from a keyless admin; refresh audit only on change (admin_key → none → admin_key);
  a drift email after a skip email; site-key remedy text (server and web).

## Open

- ac-4's gate1 e2e against Catalyst is a deploy step (not run here): after deploy, the Catalyst
  connector's `pinned_by` comes from the backfill; the next pass should drift the 5 new tools.
