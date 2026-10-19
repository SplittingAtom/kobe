# KOBE-339: C10: Usage signals with the minimum-count rule

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (group branch `group-skills-c`, one PR for Phase C)
- **Branch / worktree:** `group-skills-c` in `../Kobe-skC`
- **Depends on:** KOBE-297 (`runs.skills_used`, `skill_refs` with semver), KOBE-275 (ratings and
  its minimum-raters rule), KOBE-336 (catalog cards), KOBE-338
- **Migrations (review M1):** 0166 `skill_usage_snapshots` (generated; site table, app role
  SELECT/INSERT/DELETE, a startup seed); upgrade test
  `packages/db/src/skill-usage-snapshots-upgrade.db.test.ts`

## What shipped

- **Windows** (review M2): fixed, non-overlapping 30-day periods counted from the Unix epoch
  (UTC). The current period always shows the **last closed** window; its numbers never change.
- **Snapshot** (`services/server/src/skills/usage-snapshot.ts`): once a window closes, one
  replica (session advisory lock on a dedicated connection, as the rescan's) computes, per
  catalog skill and team: the install and the version it then ran, a Default opt-out, and per
  version the window's runs that read the skill (`skills_used`, version from `skill_refs`), their
  members (the thread's owner) and the thumbs on those runs' answers. Each team in its own
  transaction under its RLS; the Registry team, test chats and eval threads left out. Stored once
  in `skill_usage_snapshots` (`ON CONFLICT DO NOTHING`), windows older than the previous one
  purged. Every replica serves the stored row (cached; while the newest isn't stored yet, the
  newest stored window; with none, every number reads "few"). Job `skill-usage-snapshot`: at
  start and hourly.
- **The rule** (`skills/usage-views.ts`), with the viewer's teams read **at request time**
  (review M3, `viewerTeamsOf`): a cross-team number shows only when at least 3 teams outside the
  viewer's teams contribute, none of them more than 80% of what those teams give together
  (review L2), and for thumbs at least 20 of their ratings; otherwise "few", zero included. A
  per-version column carries an **other** cell (runs without a version, installs whose pin runs
  nothing, unlisted versions; review L1) and is withheld whole when any non-empty cell is "few".
- **Own team** (coordinator): runs and members show only with at least 3 members other than the
  viewer; the version table is withheld whole when any version reads "few"; thumbs need 5 raters
  other than the viewer (as KOBE-275).
- **Members** (catalog): cards and detail carry `teamsInstalled`, `usage {members, thumbsUp}`
  and `usageWindow`; "Sort by teams installed" ranks by the shown values. No thumbs sort.
- **Team admins:** `GET /v1/team/skills/usage` (`team.skills.installs.manage`).
- **Maintainers and Site admins:** `GET /v1/skills/catalog/:skillId/usage` (active maintainers or
  `site.skills.catalog.manage`; 404 for a skill without a published version, review L4): totals,
  per-version columns, Default opt-outs.
- **Site console** (review M4): the catalog table's Default opt-out count comes from the snapshot
  under the rule (no live count); a **Usage** button opens the per-version panel.
- Both usage routes take **no parameters** (400 on any query).
- **Web:** cards ("12 teams", "40 members in 30 days", "95% thumbs up" or "Few …"); the detail's
  **Usage** section; `skill-usage-panel.tsx` (shown only on 200; "Withheld", "Other or
  unknown"); the team console's **Catalog skill usage** ("Few", "Withheld: too few members").

## Decisions

- A run's member is its **thread's owner** (review L5): runs record no starter; in a shared
  thread another member's run counts to the owner. Ratings count by their run's window.
- Installs and opt-outs are as they stood when the window was computed (just after it closed).
- **Departed teams stay "own"** (340 review N1): the viewer's teams are their memberships now,
  the active team, and every team they left since the served window opened (the team audit's
  `identity.member.removed` rows), so joining, reading and leaving gains nothing.
- **No user ids stored** (340 review N2): members and raters are kept as
  `sha256(window salt : user id)`; each window has its own random salt, and a row lives at most
  two windows (60 days).
- **Residual (accepted, 340 review N3):** teams installed and opt-outs are states, so two
  consecutive windows' values can differ by one team's change over 30 days.
- `catalog.db.test.ts` was missing `skill_promotion_requests`' break-glass clause (KOBE-333);
  added.

## Open questions (for Chris or the coordinator)

- none

## Evidence (acceptance criteria → test or command output)

- **ac-1** `services/server/src/skills/usage-views.test.ts` (three other teams, none reads few,
  thumbs on 20 other ratings, dominance, opt-outs, own-team minimum and withheld versions);
  `skills/usage-snapshot.test.ts` (epoch windows never overlap, payload round trip); DB
  `services/server/src/skill-usage-signals.db.test.ts`: two concurrent `ensureUsageSnapshot`
  store once; runs of the open period, before the window, the Registry team and a test chat not
  counted.
- **ac-2** same DB file: every usage answer of every role is searched for team names and other
  teams' ids.
- **ac-3** same DB file: members (cards, detail), a viewer in two teams sees few, joining a team
  now makes it few, Team admins (team 1 few and withheld, team 3 shown), maintainers and Site
  admins per version with the other cell, outsiders 403. Web
  `apps/web/components/skills/skill-usage.test.tsx`, `components/admin/skill-tags-page.test.tsx`.
- **ac-4** DB: `?window=`, `?from=` refused; a closed window answers the same after new use, a
  restart and another replica's check (one stored row). Unit: withheld columns, other cell.
