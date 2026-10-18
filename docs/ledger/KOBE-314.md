# KOBE-314: A8: Tags and the Default sync

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (group branch, Skills v1.2 Phase A)
- **Branch / worktree:** `group-skills-a` in `../Kobe-skA`
- **Depends on:** KOBE-311 (same branch)

## Plan

Migration alone (`0135_skill_default_syncs`, generated, new site-wide table, no backfill), then
tags, the Default sync job, team uninstall/reinstall, the new-team hook, routes, Site console page
and Team console section, with tests.

## Decisions

- **Departure (migration):** the brief says no migration. A job "with progress" that is
  "idempotent and safe across replicas" needs a durable record, so `skill_default_syncs`
  (site-wide †: skill, kind `add|remove|move_major`, the major and version it targets, status
  `queued|running|done`, who asked, team cursor `after_team_id`, counts). SELECT/INSERT/UPDATE for
  the app role. Not seeded.
- **Job (`skills/default-sync.ts`):** queued in the transaction that changes the tag; jobs run one
  at a time, oldest first, on the replica holding a session advisory lock (`defaultSyncOnce`;
  `startDefaultSync` peeks every 10 s and only then takes the lease). Teams are walked in id
  order; each team's step and the job's counts and cursor commit in one `withTeam` transaction, so
  progress is exact and a crashed job resumes after the last finished team. Steps are idempotent.
  The version is re-read at run time (newest approved, not suspended, in the job's major). The
  finish is audited `skill.default.synced` (system actor, counts only).
- **Steps (`default-sync-team.ts`):** `add` skips opted-out teams, keeps a team's own install
  (`kept`, it gains the badge), else installs `default_on` + `within_major` + origin `default_tag`,
  installed by the tagger. `remove` turns `default_tag` installs into `team` and deletes the team's
  opt-out. `move_major` moves only `default_tag` + `within_major` installs on an older major.
- **Locks (`default-target.ts`):** a transaction advisory lock on the Default set: tag changes and
  move-major take it exclusively (and queue the job inside), team creation, uninstall and reinstall
  take it shared. So a new team either commits before a tag change (the job sees it) or reads the
  tag after it. A per-(team, skill) lock orders sync steps against uninstall/reinstall, so an
  opt-out is never overwritten by an install.
- **Default major:** the major Default installs follow is the newest `add`/`move_major` job's
  (`defaultTargets`). New teams (`installDefaultsInNewTeam`, inside `createTeamWithAdmin`) and
  Reinstall get the newest approved version in that major. Adding Default needs an approved
  version (409 `no_version`) and starts at the newest approved version's major.
- **Opt-out rule:** uninstalling a skill that carries the Default tag records an opt-out whatever
  the install's origin (otherwise a re-sync would put a team's own removed install back). The
  reason is stored, never audited (`reasonGiven`). Uninstalling a non-Default skill records none.
- **Tags (`skills/tags.ts`):** topic tags are created, renamed, retired and restored (never
  deleted); adding a retired or unknown tag to a skill is refused (400 `unknown_tags`), a retired
  one already on it may stay. System tags only through `PUT …/tags` (`default`).
- **Audit (docs/audit-log.md):** `skill.tag.created`, `skill.tag.updated`,
  `skill.catalog.tags_changed`, `skill.default.major_moved`, `skill.default.synced` (site);
  `skill.catalog.removed`, `skill.default.restored` (team). Names avoid "install": the KOBE-255
  rename test forbids it in actions. Also added the missing `skill.rescan.suspended` row (313).
- **Permissions:** `site.skills.catalog.manage` (admin) and `team.skills.installs.manage`
  (team_admin). The site middleware is per path, so a later Registry queue under
  `/v1/site/skills/registry` can use the reviewer grant.
- **Routes:** `/v1/site/skills/{tags, tags/:id, catalog, catalog/:id/tags,
catalog/:id/default/move-major, default-syncs}`; `/v1/team/skills/{installs, installs/:id
(DELETE, optional reason), removed-defaults/:id/reinstall}`.
- **Minimum-count rule (SK26):** opt-out counts (catalog list, job rows) of 1 or 2 teams show as
  `few`; never team names. Counts are read team by team under RLS (`scanTeams`).
- **Notices:** email to the active Team admins of each team the change reached (add: installed
  or kept; remove: had an install or an opt-out), after the team's step commits; best effort (a
  crash between the two loses that email). In-app notifications stay schedule-only (313 note).
- **Protocol (additive):** `teamSkillInstallSchema.isDefault`, `createTopicTagSchema`,
  `updateTopicTagSchema`, `moveDefaultMajorSchema`, `uninstallSkillSchema`,
  `DEFAULT_SYNC_KINDS/STATUSES` (contract test ties them to the DB checks).
- **Web:** Site console "Skill tags" page (vocabulary, catalog skills with Default badge, major
  and opt-outs, Edit tags, Move Default to major N, Default syncs progress); Team Skills page
  section "Catalog skills in this team" with "Added by Site default", Removed defaults, Uninstall
  and Reinstall for Team admins.
- **For KOBE-317:** the seed calls `queueDefaultSync(tx, {kind: "add", …})` under
  `lockDefaultSet(tx, "exclusive")` on every upgrade; opt-outs survive (tested). `requested_by`
  and `installed_by` are NOT NULL users: the seed needs an actor (no system user exists).

## Open questions (for Chris or the coordinator)

- Should a team that changes a Default install's access keep origin `default_tag` (moves still
  apply) as SK6 reads? Nothing changes access yet (no PUT install route in Phase A).

## Evidence (acceptance criteria → test or command output)

- ac-1: `services/server/src/skill-default-sync.db.test.ts` "adding Default": all teams but the
  opted-out one, job progress queued → done (3 of 3), kept install untouched, notices; new team
  at creation gets it. Web: `components/admin/skill-tags-page.test.tsx`.
- ac-2: same file "opt-outs are sticky": uninstall records the opt-out (audited), a re-sync and a
  simulated upgrade (the seed re-adding Default) skip it, Reinstall clears it.
  `components/admin/catalog-installs-section.test.tsx`.
- ac-3: same file "moving Default installs" (only untouched `default_tag` + `within_major`
  move; pinned and team-made stay; new teams get the new major; audited) and "removing Default"
  (origin → team, opt-outs cleared, notices, new teams get nothing; audited).
- ac-4: same file: two concurrent `defaultSyncOnce` run the job once; a rerun does nothing; a
  job left `running` with a cursor resumes and finishes all teams.
- `@kobe/server` test:db 124 files / 1686 tests green; server, web and db unit suites green;
  `drizzle-kit generate` → no schema changes.
