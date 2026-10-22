# KOBE-430: Connectors: a Re-probe button that refreshes an MCP server's tool list now

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

Group 34 (`group-34-connector-reprobe`).

## What changed

- **Route** `POST /v1/site/connectors/:id/refresh` (`routes/site-connectors.ts`, behind
  `site.connectors.manage`, so site admins only, server-enforced). Logic in
  `services/server/src/connectors/reprobe.ts`, answers in `routes/reprobe-reply.ts`.
- **Same code as the periodic refresh**: a pinned connector goes through `refreshConnector`
  (probe through mcp-proxy, `applyDrift`, write only under the row lock and only if the URL is
  unchanged, else `changed`); an unpinned one through `pinConnector`. D27/U7 unchanged: changed and
  new tools become `drifted` (disabled until re-approved), removed ones leave the snapshot.
- **No overlap**: a per-connector session advisory lock `kobe.connector-refresh:<id>`
  (`connectorRefreshLocks` in `refresh.ts`). The periodic pass now takes it around each connector
  and skips one it finds held; a Re-probe that finds it held answers 409 `refresh_running`.
- **Credential**: the acting admin's (site key, else their own key), else the `pinned_by` admin's
  (KOBE-431's rule), never a member's. `RefreshOptions.credential` lets the caller pass it; the
  periodic pass is unchanged (chooses `pinned_by`, audits on change).
- **Rate limit**: `REPROBE_RATE` 5 per connector per 10 min (`rate_limits` table, all replicas);
  429 `rate_limited`.
- **Audit** `mcp.connector.refreshed {outcome, reason?, changed, added, removed, credential?,
adminId?}` as the admin: counts and codes only, no tool names/URL/key (docs/audit-log.md). Drift
  itself is still recorded as `mcp.connector.drift` (system), so drift emails work as before.
- **Answers**: 200 `{connector, refresh: {status, counts, message}}`; 502 `reprobe_failed`
  `{failure, message}` with Kobe's fixed sentence per code (never the remote's text; web shows it
  via `SHOWN_5XX_CODES`); 409 `changed` / `refresh_running` / `connector_disabled`; 429.
- **Web**: `components/admin/site/connector-reprobe.tsx` — "Re-probe" per active connector row; the
  server's sentence is the notice or the alert; the list reloads; drift with changed/new tools opens
  the tool review (re-keyed so an open review reloads).
- **Members** (`/me/connectors`): not offered. Decision: site managers only (the default in the
  brief) — a probe can change what every team is offered and uses site-wide trust.
- Shared failure sentences moved to `routes/connector-messages.ts` (`PIN_MESSAGES`).
- docs/install.md "Probing and drift" mentions Re-probe.

## Tests

- `services/server/src/connector-reprobe.db.test.ts` (12): member 403 / 404; unchanged + audit;
  drift (1 changed, 1 added, 1 removed; snapshot `drifted`, review shows changed/added; audit counts
  only); unpinned → pin path; unreachable 502 keeps pins; credential fallback to the pinning admin's
  key, key never in audit or answer; auth_required message; disabled 409; admin URL edit during the
  probe wins (409 `changed`, pins untouched); lock held → 409 `refresh_running`; periodic pass skips
  a locked connector; rate limit (6th → 429).
- `routes/reprobe-reply.test.ts` (3): wording of drift/failures/refusals.
- Web `components/admin/connector-reprobe.test.tsx` (5): drift message + reload + review opens;
  unchanged; 502 failure reason shown; 429 and 409 shown; not offered when disabled.
- e2e `e2e/browser/tests/connector-reprobe.spec.ts` (gate1, `KOBE_CONNECTOR` default `catalyst_2`):
  written, not run here (needs a deploy of this branch to gate1).
