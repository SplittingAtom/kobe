# KOBE-104: team connector enablement and exposure (storage and API)

- **Status:** in review
- **Branch / worktree:** `kobe-104-team-connector-enablement` in `../Kobe-wt104`
- **Depends on:** KOBE-100/101 (registry, pins)

## Decisions

- **No migration, one PR.** `team_connectors` already exists (0037/0038, KOBE-58): `team_id NOT NULL`,
  PK `(team_id, connector_id)`, FK to the install-scoped `connectors`, ENABLE + FORCE RLS with the canonical
  `team_isolation` policy, tenancy-registered in `tenancy/connectors.ts` with a probe fixture, covered by
  `packages/db/src/connectors.db.test.ts`. It already holds exposure (`read_only` | `all` | `custom`) and the
  `enabled_tools` tick list; no row = off. Nothing was missing, so no migration PR (does not hold the queue).
  No break_glass_read (configuration, not content).
- **API** `/v1/team/connectors` (`routes/team-connectors.ts`, `connectors/team-store.ts`): `GET /` (team.read) lists
  registered, non-removed connectors with the team's state and their pinned tools (read_only flag, status);
  `PUT /:id` (`team.connectors.manage`, team admin) body `{exposure, enabled_tools?}`; `DELETE /:id` disables.
- **Exposure model (D27):** `read_only` = pinned tools with `readOnlyHint: true`; `all` = every pinned tool;
  `custom` = the tick list of Pi tool names. `enabled_tools` is required for `custom` and refused otherwise
  (400); names must be pinned (not drifted) tools of that connector (422 `unknown_tool`); duplicates collapse;
  switching away from `custom` clears the list. A disabled install connector cannot be enabled (409).
  Connector row is locked FOR SHARE so a concurrent install soft delete waits.
- **Audit:** `mcp.connector.team_changed` (team scope): `connectorId`, `name`, `change` (enabled, exposure_changed,
  disabled), `exposure`, `tools`. No event when a PUT changes nothing. Never URLs. Documented in `docs/audit-log.md`.
- **Run offering:** already follows enablement, no code change: the resolver reads `team_connectors` joined to
  active connectors (`runs/resolver-input.ts`) and tool lists use `exposedTools` (`mcp/catalog.ts`). Tests assert it.
  Proxy-side enforcement is KOBE-106, admin UI is KOBE-105.

## Open questions

- None blocking. `enabled_by` records the first enabler only (later exposure changes are in the audit log).

## Evidence

- ac-1 (off by default): `services/server/src/team-connectors.db.test.ts` "off by default".
- ac-2 (mode and list stored and audited): same file "enable and exposure", "audit".
