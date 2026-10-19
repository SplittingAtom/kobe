# KOBE-339: C10: Usage signals with the minimum-count rule

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (group branch `group-skills-c`, one PR for Phase C)
- **Branch / worktree:** `group-skills-c` in `../Kobe-skC`
- **Depends on:** KOBE-297 (`runs.skills_used`, `skill_refs` with semver), KOBE-275 (ratings and
  its minimum-raters rule), KOBE-336 (catalog cards), KOBE-338
- **Migrations:** none

## What shipped

- **Nightly snapshot** (`services/server/src/skills/usage-snapshot.ts`): for the last 30 finished
  UTC days (ending at the start of the snapshot's UTC day), per catalog skill and team: the
  install and the version it runs (`pickCatalogVersion`), a Default opt-out, and per version the
  runs that read the skill (`skills_used`, catalog source, version from `skill_refs`), the members
  whose runs did (thread owners) and the thumbs on those runs' answers rated in the window. Each
  team read under its own RLS (`scanTeams`); the Registry team, test chats and eval threads left
  out. Computed once per UTC day per replica (single flight), warmed by the server job
  `skill-usage-snapshot` at start and at 00:05 UTC; reads only, kept in memory.
- **The rule** (`skills/usage-views.ts`): a cross-team number shows only when at least 3 teams
  **other than every team the viewer belongs to** contribute (and, for thumbs, at least 20 of
  their ratings); otherwise "few", zero included (none can't be told from few). A per-version
  column is withheld whole when any non-empty cell is "few". Own-team thumbs need 5 raters other
  than the viewer (`FEEDBACK_MIN_RATERS`, as KOBE-275), per version only when every rated version
  has them.
- **Members** (catalog): cards and detail carry `teamsInstalled`, `usage {members, thumbsUp}`
  and the page/detail `usageWindow`; "Sort by teams installed" ranks by the shown values (the old
  5-minute live `scanTeams` count is gone). No thumbs sort, no leaderboard.
- **Team admins:** `GET /v1/team/skills/usage` (`team.skills.installs.manage`): per catalog skill
  the team used or installed: runs, members, thumbs, and runs/members (and thumbs) per version.
- **Maintainers and Site admins:** `GET /v1/skills/catalog/:skillId/usage` (active maintainers of
  the skill, or `site.skills.catalog.manage`): totals (teams installed, members, runs, thumbs,
  Default opt-outs) and per-version columns (teams running it, members, runs, thumbs).
- Both usage routes take **no parameters** (400 on any query): fixed windows only.
- **Web:** cards ("12 teams", "40 members in 30 days", "95% thumbs up" or "Few …"); the detail's
  **Usage** section with the window and, for maintainers and Site admins, the per-version panel
  (`skill-usage-panel.tsx`, shown only on 200); the team console's **Catalog skill usage**
  (`team-usage-section.tsx`); the Site console's catalog table gets **Usage** per skill.

## Decisions

- **No table:** the snapshot is deterministic for a UTC day (fixed window ending at midnight), so
  it lives in memory per replica and needs no migration; every read on one day sees the same
  numbers (tested: a run added after the first read changes nothing until tomorrow).
- **"Other teams than the viewer's":** subtracting what a viewer knows of their own teams (they
  may be in several) still leaves at least 3 teams mixed, for every role, Site admins included.
- **Own-team runs and members are exact** for Team admins (SK26 gives them their own team's runs
  and members; no member is named); only thumbs carry the 5-rater rule, as KOBE-275's. Question
  below.
- Members are distinct users across teams; a run's member is its thread's owner.
- **Residual (accepted, as KOBE-275):** consecutive days' windows differ by one day at each end,
  so comparing two days' numbers can narrow down that day's change; the 3-team and 20-rating
  thresholds still apply to each number shown.
- The Site console's existing live Default opt-out count (KOBE-314) is unchanged; the snapshot's
  opt-out count is in the maintainers' and Site admins' usage view.

## Open questions (for Chris or the coordinator)

- Should own-team runs and members also need a minimum (say 5 members) for Team admins? A count
  of 1 tells a Team admin that one member used the skill, not who.

## Evidence (acceptance criteria → test or command output)

- **ac-1** `services/server/src/skills/usage-views.test.ts` (three other teams, none reads few,
  thumbs on 20 other ratings from 3 teams, opt-outs); `skills/usage-snapshot.test.ts` (window,
  00:05 UTC); DB `services/server/src/skill-usage-signals.db.test.ts` "members see…" (4 teams,
  5 members, 95%; today's run, a 31-day-old run, the Registry team and a test chat not counted).
- **ac-2** same DB file "no team names or ids": every usage answer of every role is searched
  for the teams' names and other teams' ids.
- **ac-3** same DB file: members (cards, detail), a viewer in two teams sees few, Team admins
  (team 1: thumbs not enough; team 3: 5 raters → 7 up), maintainers and Site admins per version,
  members and outsiders 403. Web `apps/web/components/skills/skill-usage.test.tsx`,
  `components/admin/skill-tags-page.test.tsx`.
- **ac-4** DB: `?window=`, `?from=` refused (400); per-version columns withheld when 2.0.0 runs in
  one team; the same answer after new use within the day. Unit: withheld columns.
