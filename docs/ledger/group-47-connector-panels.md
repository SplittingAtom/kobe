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

## KOBE-641: site connector detail panel

- New read-only route `GET /v1/site/connectors/:id/teams` (`services/server/src/connectors/team-usage.ts`,
  mounted in `routes/site-connectors.ts` behind the router-wide `site.connectors.manage`):
  `{teams: [{id, name, slug, exposure, enabled_tools (count, custom only)}]}`, ordered by team
  name; walks teams one `withTeam` at a time like `countTeamsUsing` (RLS); 404 for unknown/removed.
  No migration.
- Everything else from existing site APIs: the list row (URL, auth, credential source, status,
  refresh/skip, counts), `GET /:id/tools` (definitions incl. annotations, input schema, `ui`),
  `GET /:id/templates` (status, placement). Each part loads on its own; a failed part shows its
  error, the rest still renders.
- New console primitive `SidePanel` (`apps/web/components/ui/console/side-panel.tsx`, + test):
  Radix Dialog at the right edge, portalled into the console root like `Dialog`, so its Escape
  never closes the workspace panel (`data-kobe-panel`) underneath; focus returns to the name.
- `connector-detail-panel.tsx` + `connector-detail-tools.tsx`: name in the registry row is a
  button (`aria-haspopup="dialog"`). Site key shown only as set / not set / re-enter, never its
  hint. Annotations: Destructive / Not destructive (hidden for read-only), Idempotent, Open/Closed
  world; undeclared hints show MCP's default with a tooltip "Not declared…". Inputs summary up to
  12 properties with type and required. Badge review from the templates list (`unknown` if that
  list failed). Actions stay in the row (the ticket made them optional in the panel).
- Docs: `docs/guide/admin/site-admin.md` (Connector registry bullet).
- Tests: `connectors.db.test.ts` (route, 403 for non-site-admins, 404s, no key/header text),
  `apps/web/components/admin/connector-detail-panel.test.tsx` (open, Escape/Close focus return,
  info/teams/templates, tools, partial failure).

## Gate1 browser spec

`e2e/browser/tests/connector-panels.spec.ts` (owner, `KOBE_CONNECTOR` default `catalyst_2`; no
writes, no tokens): team columns + counts + badges + narrow stacking; site name opens the panel,
`/teams` has no key/header text, ≥3 templates, tool details, badges, Escape returns focus.

## Review fixes (docs/ledger/review-g47.md)

- M1: team view tools gain `model_visible` (`connectors/visibility.ts` `modelVisible`); app-only
  tools are marked "Not offered (app only)" under every exposure and cannot be ticked.
- M2: marker follows the saved exposure ("Not offered to the team (Read-only tools)"); an unsaved
  Read-only choice says "Would not be offered under Read-only tools".
- L3 built-in connector 404s on `/teams`; L4 team reads via `mapLimited` (now generic, 4 at once);
  L5 custom count ignores ticks that no longer name a pinned tool; L7 key-set assertions.
- L9 badge neutral while templates load; L10 badge is a focusable button (Radix Tooltip on hover
  and focus, portalled into the console root), accessible name "MCP-UI: Opens an app: …".
- e2e: `exact: true` names, key-set check, per-column list counts vs heading counts, `expect.poll`.
