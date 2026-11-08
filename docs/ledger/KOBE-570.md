# KOBE-570: Web: team admin and site admin actions on the tabs (inventory and gallery fold-in), proposals queue

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (PR #493)
- **Branch / worktree:** `kobe-570-admin-fold-in` in `../Kobe-wt570`
- **Depends on:** KOBE-569 (Agents page, merged), KOBE-566 (roster routes), KOBE-567 (Unavailable),
  KOBE-568 (adopt routes). Spec `docs/specs/agents-roster.md` AR12, §6.4, §6.5 (AR-6).

## Plan

Web, plus one additive server read. Rows carry the Inventory's usage for team admins; the Team
and Site tabs render it (`components/agents/usage-cells.tsx`); the Site tab loads the gallery's
scores (everyone) and the Site console's gallery state (site admins,
`components/agents/use-gallery-extras.ts`); new row items in `roster-actions.tsx`; Approve
dialog in `roster-dialogs.tsx`; the queue in `lib/agents/proposals.ts`; redirects in
`lib/agents/redirects.ts`.

## Decisions

- **Usage on the roster rows (server, additive).** `GET /v1/agents/roster` adds an optional
  `usage` per row on the Team and Site tabs for callers with `team.agents.suspend` (the
  Inventory's own right): `runCount`, `lastRunAt`, `tokens`, `schedules[]` (owner, status,
  `pausedBy`), `orbitScore`, `canExport` (definition readable, as the Inventory's `canExport`).
  The Inventory's SQL was split into shared fragments (`usageCtes`, `USAGE_COLUMNS`,
  `USAGE_JOINS` in `agents/inventory.ts`); `usageOf()` reads them for the page's rows only, in
  the same `withTeam()` transaction as the tab's rows (one snapshot, review 5) with `team_id`
  explicit (team-filter guard green). Shared `toUsage()` builds the usage for both (review 8). Protocol
  `agentRosterUsageSchema` (optional field, so older clients ignore it); OpenAPI regenerated.
  Columns are the Inventory's, not the spec's wording: Runs, Last run, Tokens, Schedules, Orbit
  score (spec "threads, last used" = the Inventory's runs and last run).
- **Gallery agents on the Site tab** get usage too (the Inventory listed gallery agents the team
  used); the Site tab always shows an Orbit score column: the team's result from `usage`, else the
  gallery's published score (`/v1/agents/gallery-scores`, any member, as the old Team agents page
  showed members).
- **Inventory actions.** Suspend/Reactivate are the roster's "Suspend here"/"Resume here" (same
  table, `team_agent_suspensions`, via the team roster route since KOBE-566; team-owned agents by
  status). Export to Orbit: a row item when `usage.canExport` and published (same call,
  `GET /v1/agents/:id/versions/:n/orbit`).
- **Gallery actions (site admins, Site tab).** Customized badge in the name cell; the Gallery
  page's notice (Compare, Reset to repository) above the table for customized agents behind the
  repository (shared `UpdateAvailable`); Edit is the row's Edit link (`actions.edit` →
  `/admin/site/gallery/:id`); row items Run eval (in the active team: the old page's team picker
  is dropped) and Export file (the same download URL). Reset reloads the gallery state and the tab.
  Run eval… opens a team picker (`listMyTeamsForEval`, active team first; review 2). Compare/Reset
  notices only for gallery rows on screen, after the table loaded (review 3).
- **Adopt** (KOBE-568 routes): "Adopt into <roster>" on Unavailable rows for the roster's admins
  (`actions.remove`, not a proposal), confirm first, then refresh. Rows have no `actions.adopt`
  yet (568 hand-off), so this is the documented stand-in.
- **Proposals queue.** For the tab's deciders (Team: `team.agents.manage`; Site: site admin) a
  toggle button `Proposed (n)` (`aria-pressed`) above the table; n = the response's additive
  `proposedCount` (all pending proposals the caller decides on the whole roster, admins only;
  review 4), else the loaded rows with status `proposed` and `actions.decide`; the filter itself
  works on loaded rows; pressed shows only those ("No proposals are waiting." when
  none). Approve is now "Approve…": a dialog with the version rule (latest by default, or
  `Pin to vN`); latest sends `{state: "active"}` as before, a pin adds `versionRule`. Decline
  keeps 569's note dialog; the proposer's Personal row shows "Declined for Team: X: <note>"
  (569's Reach wording, kept; a decline without a note is not distinguishable from a removal on
  the reach item, so it just disappears).
- **Redirects** (307, not permanent): `/admin/team/agents` → `/agents?tab=team`,
  `/admin/site/gallery` → `/agents?tab=site`. **Deviation from AR12** (coordinator, review 1):
  `/admin/team/inventory` does not redirect; it stays as the team's Skills and Connectors
  inventory, its Agents section a pointer to the Team tab, because the spec folded only the agent
  columns into the tab. Exact paths only: the builder
  (`/admin/team/agents/new`, `/:id`, `/:id/cases…`) and the gallery editor (`/admin/site/gallery/:id`)
  stay. Their back links now point at the tabs.
- **Console nav.** New section status `movedTo(href)` (`lib/admin/nav/types.ts`): the entry stays
  in the console nav and overview but links to the tab; the registry test requires no console page
  for it. Team "Team agents" → `/agents?tab=team`; Site "Gallery agents" → `/agents?tab=site`;
  "Inventory" stays (skills and connectors). Command palette already had "Agents" (569): unchanged.
- **Removed:** the list pages and components (`team/agents-page`, `team/gallery-agents`,
  `team/agent-inventory`, `site/gallery-page`), their tests, and API helpers only they used
  (`listAgentInventory`, `setInventoryAgentStatus`, team `listGalleryAgents`, `forkGalleryAgent`,
  site `listGalleryScores`).
- **One paused wording** (review 6): `lib/schedules/paused-by.ts` `pausedByLabel()` for the team
  and personal schedule lists, the Schedules column and the paused notification ("Paused by a team
  admin", "Paused: owner deactivated or removed", "Paused: agent unavailable").
- **Browser specs** (existing ones that opened the old pages) point at the tabs:
  `consoles.spec.ts`, `console-sections.spec.ts` (Team tab columns and table layout),
  `site-gallery-edit.spec.ts` (list on the Site tab, editor unchanged). Not run (gate1, KOBE-572).

## Open for 571/572

- **571:** the version picker in `ApproveDialog`/`PinDialog` is the shared `VersionRuleField`
  (numbers only); a fuller history goes there. `forkGalleryAgent` is gone (fork is personal).
- **572:** labels: `Proposed (n)` button, `Approve…` dialog "Approve X for <roster>?" with
  "Version rule", `Adopt into <roster>`, `Export to Orbit`, `Run eval`, `Export file`; Team tab
  columns Runs, Last run, Tokens, Schedules, Orbit score.
- **Server follow-up (optional):** `actions.adopt` on rows; a reach flag for "declined" so a
  decline without a note can still be shown to the proposer; email on decision (§6.4) not done.
- Agents used by the team's threads but on no roster (the old Inventory listed them) no longer
  appear anywhere for admins.

## Open questions (for Chris or the coordinator)

- None blocking.

## Evidence (acceptance criteria → test or command output)

- ac-1: `apps/web/components/agents/agents-admin.test.tsx` (team admin: inventory columns,
  schedule labels incl. "Paused: agent unavailable", Export to Orbit, Adopt; member: none of it;
  site admin: Customized, Compare, Reset, Edit, Run eval, Export file);
  `lib/agents/redirects.test.ts` (rules, next.config, deep links untouched);
  `lib/admin/nav/registry.test.ts`, `lib/admin/nav/redirects.test.ts` (moved sections);
  server `src/agent-roster.db.test.ts` "gives team admins the inventory's usage…" and "counts
  every pending proposal…", `team-inventory-page.test.tsx` (skills, connectors, pointer),
  `src/agent-inventory.db.test.ts` (unchanged, still green), protocol `agent-roster.test.ts`.
- ac-2: `agents-admin.test.tsx` "Proposals queue" (server count, count and filter, empty state, approve with a
  pin, approve latest, decline with note and the proposer's Personal row, no queue for members);
  `lib/agents/proposals.test.ts`.
- Checks: see PR (format, lint, typecheck, web tests, server tests incl. db, license, hygiene,
  wording).
