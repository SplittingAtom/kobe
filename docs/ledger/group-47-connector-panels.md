# Group 47: connector panels (KOBE-639, KOBE-640, KOBE-641)

- **Status:** in progress
- **Branch / worktree:** `group-47-connector-panels` in `../Kobe-g47` (from origin/main d1595bbb)
- **Depends on:** none (no migration)

## KOBE-639: team Connectors panel, Read only / Write columns

- Shared `apps/web/components/admin/connector-tools.tsx` (`groupTools`, `ToolColumns`): read-only
  only when the pinned annotations say `readOnlyHint: true` (the server's `read_only` flag on the
  team view), everything else Write, as exposure `read_only` in `services/server/src/mcp/catalog.ts`.
- Each column is a region "<Read only|Write> tools of <connector>" with the count in its heading;
  `md:grid-cols-2`, stacked below; empty column says "No read-only tools." / "No write tools.".
- Under the exposure chosen in the form = Read-only tools, Write tools are struck through and
  badged "Not offered to the team (Read-only tools)" (follows the radio, so the admin sees the effect
  before saving). Custom ticks work in both columns; drifted tools stay disabled.
- Docs: `docs/guide/admin/team-admin.md` (Connectors paragraph).
- Tests: `apps/web/components/admin/team-connectors-page.test.tsx` (split + counts, empty state,
  not-offered marking, ticks across both columns).

## KOBE-640: MCP-UI badge

- API: `GET /v1/team/connectors` tools gain `app: {resource_uri, review} | null` (additive;
  `services/server/src/connectors/team-store.ts` `templateStates` + `toolApp`). `review`:
  `approved` (template row pinned and approved, so it renders), `pending` (row drifted / never
  approved), `missing` (tool names a URI with no template row). Same for the gallery connector list.
- Web: `McpUiBadge` in `connector-tools.tsx` (shared with 641): text "MCP-UI", `title` and sr-only
  text "Opens an app: ui://… (approved | waiting for a site admin's review | template not pinned)";
  accent tone when approved, attention otherwise; renders nothing without `app`.
- Docs: `docs/guide/admin/team-admin.md`, `docs/guide/connectors-and-apps.md`.
- Tests: `services/server/src/team-connectors.db.test.ts` (three review states + null),
  `team-connectors-page.test.tsx` (badge shown/hidden, tooltip text).
