# KOBE-102: periodic refresh and drift re-approval

- **Status:** in review
- **Branch / worktree:** `kobe-102-connector-drift-reapproval` in `../Kobe-wt102`
- **Depends on:** KOBE-101 (probe and pins)

## Plan

Re-probe pinned connectors on an interval, diff the live list against the stored pins, disable what
changed, and let an install admin re-approve.

## Decisions

- **No migration.** State stays in `connectors.tools_snapshot` / `tools_hash`. The existing per-tool
  `status` (`pinned` | `drifted`) is the switch; the snapshot JSON gained an optional `proposed`
  (live title, description, schema, annotations, sha256) on a drifted tool.
- **Per tool** (`server/src/connectors/drift.ts`, pure): same hash stays `pinned`; changed becomes
  `drifted`, keeping the approved definition and holding the live one in `proposed`; new upstream
  becomes `drifted` with the live definition and no `proposed`; gone upstream is dropped from the
  snapshot (not offered, not callable); a drifted tool whose live definition equals the approval
  again is `pinned` again. A tool that drifts further updates `proposed`.
- **`tools_hash`** = hash over approved definitions only (new unapproved tools excluded), so it moves
  only on approval or removal.
- **Refresh** (`connectors/refresh.ts`): every `KOBE_CONNECTOR_REFRESH_SECONDS` (default 3600, 0 = off,
  else 60..86400; chart `server.connectorRefreshSeconds`), one replica under advisory lock
  `kobe.connector-refresh`. Skips unpinned, disabled and removed connectors. A failed probe or an
  unusable live list (invalid/ambiguous names) leaves the snapshot untouched. The write takes the
  row lock and requires the probed URL, so an admin edit during a probe wins.
- **Enforcement already fails closed** (KOBE-58): `exposedTools` lists `pinned` only, the policy gate
  denies `tool_drifted`, the proxy runs nothing on a deny. New tests prove it for a tool the refresh
  disabled (`mcp.db.test.ts`) and for the proxy (`mcp-proxy/src/mcp.test.ts`).
- **Re-approval:** `GET /v1/install/connectors/:id/tools` (approved vs live per tool) and
  `POST /:id/tools/approve {tools:[{name, sha256}]}`; `sha256` is the live hash the admin saw, so a
  tool that changed again is refused (409 `stale`); all or nothing. UI: Review button in the
  registry table, per tool or "Approve all".
- Annotations (risk hints) are not pinned (KOBE-101 scope); they come from the first pin and only
  change when a tool is re-approved.

## For KOBE-103

Audit action `mcp.connector.drift` (category `install`, system actor, no team): target
`{connectorId, name, changed: string[], added: string[], removed: string[]}` of tool names, never
descriptions or schemas. Written once per pass that finds a new difference (not again while the same
drift persists; a further change to an already drifted tool is listed under `changed` again).
`mcp.connector.reapproved` `{connectorId, name, tools}` closes it. To find who to notify: teams with
a `team_connectors` row for `connectorId` (admins, and users granted it). Poll `audit_log` by `seq`
or hook into `recordAudit` for this action.

## Open questions

- Authenticated connectors have no pins yet (KOBE-61/108), so they are not refreshed until they do.
- Annotation-only changes (readOnlyHint etc.) are ignored by the hash, so they do not drift.

## Evidence

- ac-1: `connectors.db.test.ts` "disables a tool whose description changed..."; `connectors/drift.test.ts`.
- ac-2: `connectors.db.test.ts` "drops removed tools and adds new ones disabled".
- Enforcement: `mcp.db.test.ts` "fails closed on a tool the refresh disabled"; proxy `mcp.test.ts`.
- UI: `apps/web/components/admin/connectors-page.test.tsx`; chart: `charts/kobe/tests/render.test.ts`.
