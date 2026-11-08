# KOBE-569: Web: /agents with Personal, Team and Site tabs, rows, actions, redirects, nav rename

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (PR #490)
- **Branch / worktree:** `kobe-569-agents-page-tabs` in `../Kobe-wt569`
- **Depends on:** KOBE-566 (roster routes, `@kobe/protocol` `agent-roster.ts`), KOBE-567 (row status
  `unavailable`). Spec `docs/specs/agents-roster.md` AR1, AR2, AR5–AR7, AR13–AR16, §5, §6.4–6.6 (AR-5).

## Plan

Web only. `/agents` page (`components/agents/agents-page.tsx`) with tabs from
`lib/agents/tabs.ts`; one roster table per tab (`roster-tab.tsx`, rows, Load more by cursor); row
actions and their flows (`roster-actions.tsx`, dialogs in `roster-dialogs.tsx`); API calls in
`lib/agents/roster-api.ts`; row wording in `lib/agents/roster-labels.ts`; redirects in
`lib/agents/redirects.ts` (wired in `next.config.ts`).

## Decisions

- **Rights from the server only.** Every menu item and Edit/View link comes from `row.actions`;
  the page derives nothing from the role. The only role check is the existing "Create for the
  team" link (`team.agents.build`, AR13), which is not a row action.
- **Routes moved, not duplicated.** The personal editor and its shared cases moved from
  `/me/agents/...` to `/agents/...` (`app/agents/[id]`, `new`, `[id]/cases[/caseId]`); redirects:
  `/me/agents` → `/agents?tab=personal`, `/me/agents/:path+` → `/agents/:path+` (both 307, so the
  old address stays reusable). Deep links to an editor keep working. The builder's back link and
  `agentHref` (shared cases) point at `/agents`. Console pages do not redirect (KOBE-570).
- **Panel and nav.** Panel prefix `/agents`, title "Agents", id still `my-agents` (AR15); the
  command registry entry (bar, `/agents` slash item, palette) is renamed "Agents" with href
  `/agents`. Existing gate1 specs that named "My agents" or `/me/agents` were updated to the new
  label/paths (agent-creator, workspace-panels, blue-buttons, consoles); no new browser spec (572).
- **Tab memory.** `?tab=` wins; otherwise the last tab from localStorage `kobe.agents.tab`, else
  Personal. Switching writes both the address (`replaceState`, as the Skills page does) and the
  storage (as the Workbench draft tabs do). Storage failures only lose the memory.
- **View.** "View" opens `/agents/:id`, the existing builder, which is read-only when the server
  says `canEdit: false` (definition, versions, quality). Edit: own agent → `/agents/:id`,
  team-owned → `/admin/team/agents/:id`, gallery → `/admin/site/gallery/:id` (AR14).
- **Fork** stays a plain action ("Fork to Personal"): `POST /v1/agents/:id/fork {scope:
"personal"}` and opens the copy; no dialog (KOBE-571). Until KOBE-568 lands, the server refuses
  team → personal with 403 and the page shows its message.
- **Version rule UI (minimal).** "Pin a version…" opens a dialog with "Latest published version"
  or `Pin to vN` for N = current … 1 (from `currentVersion`, no extra call; the versions route
  does not serve other members' personal agents). "Update to latest (vN)" when `updateAvailable`.
  Approve follows latest (no version choice yet: KOBE-570/571).
- **Which roster an admin action hits.** Team tab → `PUT /v1/team/agent-roster/:id`, Site tab →
  `/v1/site/...`; "Suspend here"/"Resume here" always the team route (also on the Site tab),
  site-wide suspend/resume the site route (KOBE-566 hand-off).
- **Toasts.** The console has no toast primitive: success notices use `MutationStatus`
  (`role=status`, announced) above the table, e.g. "Notes is on Finance's roster." (201) vs
  "Proposed Notes to the site: a site admin decides." (202). Errors show the server's message.
- **Refresh after a write** reloads the tab's first page (a write may move a row or change its
  actions); later pages load again with Load more.
- **Reach column**: Private; `Bound to Team: X`; `Team: X`; `Site`; `… (suspended)`;
  `Proposed to X`; `Declined for X: note` (removed entries with a note); withdrawn/removed entries
  without a note are hidden. Entries on another team's roster carry a Withdraw button
  (`DELETE …/assignments/team?teamId=`), for teams the owner left.
- **`unavailable`** is read defensively (`status as … | "unavailable"`) so the page compiles
  before and after #489's contract; label "Unavailable: its owner left the team / was
  deactivated".

## Open for 570/571/572

- **570:** inventory columns, Customized/Compare/Reset on the Site tab, proposals count and filter,
  approve with a version choice, email; then redirect `/admin/team/agents`, `/admin/team/inventory`,
  `/admin/site/gallery` to `/agents?tab=…` (add to `lib/agents/redirects.ts`).
- **571:** fork dialog (replace `fork()` in `roster-actions.tsx`), lineage on the row, a fuller
  version picker (version history with dates) in `PinDialog`, picker grouping, team default agent.
- **Server gap (for 571 or a server follow-up):** View of another member's assigned personal agent
  opens `/agents/:id`, but `GET /v1/agents/:id` only serves personal agents to their owner, so the
  page shows "not found". The row's `viewDefinition` is true for builders on Team rows (§5); the
  server needs a read of the version in effect for roster readers.
- **572:** browser specs can drive the menu items by their labels (`Assign to <team>`,
  `Propose to the site`, `Pin a version…`, `Update to latest (vN)`, `Approve`, `Decline…`,
  `Withdraw from <team>`) and the row's `data-agent=<slug>`.

## Open questions (for Chris or the coordinator)

- None blocking. Panel/brand still say "My area" in the frame header (shared `MyAgentsShell`).

## Evidence (acceptance criteria → test or command output)

- ac-1: `apps/web/components/agents/agents-page.test.tsx` "as a member / builder / team admin /
  site admin" (three tabs, columns, Edit/View targets, menu items per role, Create for the team);
  `lib/agents/roster-labels.test.ts` (status incl. Unavailable, version in effect, Reach, Edit).
- ac-2: `agents-page.test.tsx` "flows": assign 201 / propose 202 with notices and refresh,
  422 message, withdraw (active team and `?teamId=`), pin + update to latest, approve + decline
  with note, suspend here / resume site-wide, remove, fork, Load more by cursor.
- ac-3: `lib/agents/redirects.test.ts` (rules, wired in next.config, console pages untouched),
  `lib/agents/tabs.test.ts` + "tab memory" tests, `lib/shell/panels.test.ts` (prefix `/agents`,
  id `my-agents`), `shell.test.tsx`, `slash-menu.test.tsx`, `command-palette.test.tsx`,
  `icon-action.test.tsx` (label "Agents").
- Checks: format, lint, typecheck, `@kobe/web` tests, hygiene, wording (see PR).
