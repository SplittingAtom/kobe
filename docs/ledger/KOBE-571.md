# KOBE-571: Web: fork dialog and lineage, version rule UI, picker grouping, team default agent

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (PR #495)
- **Branch / worktree:** `kobe-571-fork-dialog-picker` in `../Kobe-wt571`
- **Depends on:** KOBE-568 (fork/adopt routes), KOBE-569/570 (Agents page), KOBE-567 (default agent
  hook). Spec `docs/specs/agents-roster.md` AR5, AR8, AR14, AR15, §6.4, §6.6, §6.7, §7.5, §7.7 (AR-7).
  No migration.

## Plan

Web plus additive server reads. Server: roster View read `agents/roster-read.ts`; lineage
`agents/lineage.ts`; team default `agents/team-default.ts` + `routes/team-default-agent.ts`
(`/v1/team/default-agent`); runnable `group`; row fields. Protocol: `team-default-agent.ts`,
`forkAgentRequestSchema`, row `forkBoundTeamId`/`forkedFrom`, reach `declined`, `actions.adopt`.
Web: `components/agents/fork-dialog.tsx`, `lineage.tsx` (Forked from, Compare with source),
version picker in `roster-dialogs.tsx`, version link in `roster-tab.tsx`, picker groups
(`lib/chat/agent-groups.ts`), team console page `components/admin/team/default-agent-page.tsx`.

## Decisions

- **View from a roster (Hadron log a):** `GET /v1/agents/:id` (and `GET …/versions`,
  `…/versions/:n` via a new `resolveRead` option of `mountVersionRoutes`) fall back to
  `rosterDefinitionRead`: someone else's personal agent, not bound elsewhere, with an assigned
  (`active|suspended`) site entry (`use`) or team entry of the active team (`build`). The definition
  is the **version in effect**, never the draft; the agent carries `versionInEffect`; access is
  read-only (no edit, publish, status, export, evals, feedback, cases: those keep `resolve`). Team
  reads inside `withTeam()` with `team_id` explicit. Never-published entries stay 404. Two KOBE-568
  tests changed: a team admin/builder now views a team-assigned agent read-only (was 404).
- **Declined marker (Hadron log b), no migration (review 3):** a decline now writes
  `removedAt = null` with `decidedBy/decidedAt` set; removals, withdrawals and adopts always
  write `removedAt`. `isDeclined()` = removed + decided + no `removedAt`. **Limit:** entries
  declined before this PR carry `removedAt` and can't be told from a removal, so they show no
  "Declined" (no backfill); a re-proposed entry loses its old `removedAt` when declined again.
  Web: "Declined for X" / "Declined for X: note" (target kept: Reach lists several rosters).
- **View source entry (review 2):** `GET /v1/agents/:id` prefers the team entry for callers with
  `build` (Team tab); `?from=site` (Site tab View links, passed through by `/agents/:id`) prefers the
  site entry; each falls back to the other readable entry. The View answers `canExport: false`.
- **`actions.adopt`** (optional in the contract, review 1; the server always sends it): roster admin + assigned entry + a bound agent only in its own
  team (the adopt route's rules). The web shows Adopt from it (no longer only on Unavailable rows).
- **Fork dialog:** "Fork to Personal…" on every tab where `actions.fork`; name and slug prefilled;
  description "Your copy, in Personal…"; binding note from the new row field `forkBoundTeamId`
  (`rowForkBinding`, the fork route's rule: site entry wins over team entry, bound agents keep
  their team), "Bound to Team X: usable only there." Sends only changed `name`/`slug` (fork route
  gained optional `name`, additive); opens the copy's draft (`/agents/:id`).
- **Lineage:** Personal rows carry `forkedFrom {agentId, version, name, kind}`; name/kind only when
  the viewer may read the source from the active team (fork-source rules), else "Forked from an
  agent you can't see vN" without a link. "Compare with source" (row menu) shows the source
  version's instructions beside the copy's draft (no agent compare component existed; same
  side-by-side as the gallery's Compare).
- **Version rule UI:** header "Version in effect"; the version links to `#history-title` in the
  View (or the owner's editor when `actions.edit`); "Update available: vN" badge and "Update to
  latest (vN)" kept; Pin/Approve dialogs list "Follow latest (now vN)" and "Pin to vN (published
  date)" from the version history (falls back to numbers if unreadable). The builder shows a
  read-only notice "You're viewing vN, the version this roster runs" and hides owner-only panels.
- **Picker grouping:** runnable items gain `group` (`personal` own, `team` team-owned/team entry,
  `site` gallery/site entry); the picker renders Personal, Team, Site groups (`role=group`),
  Dangerous badge kept, no Update available. Older servers: group from scope.
- **Team default agent:** `teams.settings.default_agent_id` (jsonb, no migration).
  `GET /v1/team/default-agent` (any member: `agentId`, `unavailable`, `options` = team-owned,
  active team entries, site entries, gallery; published, active here); `PUT` (team admins,
  `team.agents.manage`) refuses anything else `422 agent_not_eligible`; audit
  `team.default_agent_changed {agentId, previousAgentId}` (events.ts, docs/audit-log.md).
  `teamDefaultAgentId` reads it; `defaultNewThreadPin` still resolves per member, so an
  unrunnable choice falls back to Kobe. Console section "Default agent" (Agents and skills).

## Open for 572/573

- **572 labels:** "Fork to Personal…", dialog "Fork <name>", button "Fork and open", note "Bound to
  Team <team>: usable only there."; "Compare with source"; Pin dialog options "Follow latest (now
  vN)", "Pin to vN (published YYYY-MM-DD)"; console page `/admin/team/default-agent`, select "New
  conversations start with"; picker group headings Personal / Team / Site.
- **573 docs:** View read rule (version in effect), declined marker, team default agent route and
  audit row; Adopt now offered on every assigned entry (not only Unavailable).
- Lent agents in the picker still show the origin chip "Personal" (KOBE-297 labels by scope).

## Open questions (for Chris or the coordinator)

- None blocking.

## Evidence (acceptance criteria → test or command output)

- ac-1: `services/server/src/agent-roster-views.db.test.ts` (View per role: admin/builder read
  version in effect, member/other team 404, site entry for every team; fork with name, binding and
  lineage incl. anonymous after withdraw; gallery unbound); `agents/roster-access.test.ts`
  (`rowForkBinding`, adopt); web `components/agents/agents-fork-lineage.test.tsx` (bound/unbound
  dialog, refusal, lineage link/anonymous, Compare), `agent-builder-pages.test.tsx` (read-only View).
- ac-2: `agents-page.test.tsx` "pins a version…" (Version in effect, Update available, history
  picker, PUT bodies), `agents-fork-lineage.test.tsx` (version link), `lib/agents/roster-labels.test.ts`.
- ac-3: `agent-roster-views.db.test.ts` "Team default agent" (403 builder/member, 422, audit,
  `defaultNewThreadPin` per team, unavailable → site default, runnable `default`, groups);
  `components/chat/agent-picker.test.tsx` (groups), `lib/chat/agent-groups.test.ts`,
  `components/admin/team-default-agent-page.test.tsx`; protocol `team-default-agent.test.ts`,
  `agent-roster.test.ts`; `src/openapi/document.test.ts` (route documented, openapi.json regenerated).
- Review fixes: `agent-roster-views.db.test.ts` (View from team vs `?from=site`, never-rostered 404, `canExport: false`, default falls back when suspended or archived, other team's agent 422, legacy decline not shown). Declined marker: decline vs removal vs approved-then-removed vs
  withdrawal).
