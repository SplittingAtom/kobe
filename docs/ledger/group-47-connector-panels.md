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
