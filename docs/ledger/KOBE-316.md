# KOBE-316: A10: Personal skill enablement and team-local access modes

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

## Handoff (for the fresh agent doing KOBE-317 and KOBE-318)

- **Branch state:** `group-skills-a` (worktree `../Kobe-skA`) holds KOBE-307..316 and KOBE-423,
  all reviewed; the 316 review fixes are the last commit. Migrations 0128..0136 are unreleased;
  the next free number is 0137. Nothing is pushed; one PR at the end. Read the ledgers of 313,
  315 and this one first (their handoffs and decisions), `docs/skill-package.md` and
  BRIEF-317/318 (untracked; never commit them). Reviews land in the session scratchpad as
  `review-<N>.md`.
- **Conventions:**
  - A migration commit holds `packages/db/drizzle/*` plus the schema TS it encodes, so each
    commit passes `db:check`. Generated SQL and custom SQL go in separate migrations.
  - Edit an unreleased migration by removing it (sql, snapshot, journal entry), regenerating
    with `drizzle-kit generate --name <same>`, and restoring the journal `when`.
  - Backfills on FORCE-RLS tables lift FORCE inside the migration, with an upgrade test that
    has rows and runs as the non-superuser owner (see `skill-registry.db.test.ts`).
  - Seeded tables go in `packages/cli/src/seeded.ts`. New object-key columns go in
    `BLOB_REF_COLUMNS` (guard test, KOBE-423).
- **Traps:**
  - Rebuild `@kobe/db` (and protocol/scanner) before the server typecheck or tests: dependants
    read `dist`.
  - drizzle-kit orders a new UNIQUE constraint after the FK that needs it: check the generated
    SQL (0136 was reordered by hand).
  - `docs/audit-log.md` must list every audit action (`events.test.ts`). The KOBE-255 test
    forbids "install" in action names, and columns with "install" in their names go into
    `site-rename-migration.db.test.ts`.
  - After changing routes or events, run `UPDATE_OPENAPI=1 npx vitest run
src/openapi/document.test.ts`, then prettier on `openapi.json`.
  - `seededRandom` (testing) seeds from the clock; use label-seeded generators for fixtures.
  - Lock order: Default set (shared), then install (`lockInstall`), then team skill names
    (`lockTeamSkillNames`, the upload lock). Uploads take only names.
  - DB tests: `KOBE_TEST_DATABASE_URL` from `CLAUDE.local.md`; run `@kobe/db` and
    `@kobe/server` `test:db`. There's no pg_dump locally (the backup tests skip).
- **For 317 (built-ins as Kobe-published Default catalog skills):**
  - Built-ins are still `isBuiltinSkillName` (protocol), baked into the sandbox image. They
    resolve outside the catalog and claim their names after step 2 (`resolve.ts`; review N5
    of 315 is open: Required or offered skills named like a built-in still load alongside).
  - Catalog versions have no stored bundle: `bundleRefsWithGaps` (`skills/materialize.ts`)
    reports them as `unavailable`. 317 stores the bytes and adds a catalog branch to
    `sizesByHash` and `locateBundle`.
  - Kobe-published versions: requester NULL plus `publisher = 'kobe'`, enforced by a CHECK. No
    fake system user.
  - Default installs come from `addInTeam` / `installDefaultsInNewTeam`.
- **For 318 (agent publish freezes local skill versions):**
  - Named local skills resolve to the newest approved version: `teamSkillStates` through
    `catalogNamed` / `loadSkillFacts` in `runs/resolver-input.ts`.
  - Frozen versions must still check the team review status and `suspended_at` (KOBE-313
    ledger), and Revoke or blocklist omits them with a notice.
- **Open items carried:** 315 nits N2 (markers cost and name-only keys), N4, N5, N6. From 316's
  review: N5 (Hidden toggle answers 409, not 404), N6 (no archived filter on personal skills),
  N7 (the toggle list shows the install's state, not a member add's).

- **Status:** in review (group branch, Skills v1.2 Phase A)
- **Branch / worktree:** `group-skills-a` in `../Kobe-skA`
- **Depends on:** KOBE-315 (same branch)

## Plan

A migration (members' personal toggles need a column), then the toggles, the access mode
selector, the catalog switches route and Builder installs, the web, and tests.

## Decisions

- **Departure (migration):** the brief says no migration. `member_skill_enablements` had no way
  to name a personal skill, so 0136 (generated) adds `personal_skill_id`. It has a composite FK
  to `personal_skills (id, owner_user_id)`, so the skill is always the member's own (new unique
  key), cascade on delete. A partial unique index covers (team, user, skill), and the one-skill
  check now spans three columns. No backfill: no row means on.
- **Personal toggles (ac-1, D22):**
  - A row with `enabled = false` leaves the skill out of that member's runs in that team only.
  - `personalSkillUsage` filters it, so the skill is not queued for the team's review and gets
    no notice: it was the member's own choice.
  - Takes effect at the next run start, because the resolver reads at run start.
- **Member toggles of team skills and installs (ac-3):**
  - On by default can be turned off; Available can be turned on.
  - Required and Hidden refuse with 409 `not_toggleable`. Archived team skills and blocked
    installs are not listed (404).
  - A catalog toggle on an install the member also added for themselves turns their add on or
    off.
- **Routes:**
  - `GET` and `PUT /v1/me/skills/enablements` (any member, active team): zod strict body
    `{kind, skillId, enabled}`.
  - A per-member advisory lock serializes the toggles, so the first row is written and audited
    once.
  - Audited as `skill.enablement.changed` `{kind, skillId, name, enabled}`, on real changes
    only.
- **Access modes (ac-2), `PUT /v1/skills/{id}/access`:**
  - Builders (`team.skills.publish`) set Available, On by default and Hidden. Only Team admins
    make a skill Required or change a Required one (403 otherwise).
  - Audited as `skill.access.changed` `{skillId, slug, access, previous}`.
  - `offer_to_all` is kept in step (`= default_on`) so a rollback keeps today's runs, and the
    old `/offer` route stays for older pages.
  - On by default plus Required are capped at 32 together, the old offer cap (409
    `offer_limit`).
  - The answer carries `requiredCount`: Required team skills plus Required installs. From 5 it
    adds `warning: "many_required"`, and the install PUT does the same. The web shows the
    warning when it is in the answer.
- **Reach:** `GET /reach` returns `access`. Required reaches every agent, exclusive ones too.
  On by default reaches agents that aren't exclusive. Available and Hidden don't reach agents
  that don't name them.
- **Catalog switches (re-review R-N3):** `PUT /v1/team/skill-review/settings` now also takes
  `membersMayAddCatalog` and `buildersMayInstallCatalog`.
  - Body: strict and partial, at least one field.
  - Team admins only (`team.skills.review`), RLS-scoped under withTeam.
  - Audited as `skill.catalog_switches.changed`, with only the changed values.
  - `GET` returns all three switches.
- **Builder installs (re-review R-N2, SK25, SK31):** `PUT /installs/{id}` is open to
  `team.skills.publish`. For a caller who is not a Team admin:
  - refused with 403 `forbidden` while "Builders may install catalog skills" is off;
  - refused for `access: required`, or when the existing install is Required;
  - refused for a deprecated version: that override is the Team admin's.
  - Uninstall, Reinstall and blocks stay Team admin only.
- **Name-clash race (re-review R-N1):** fixed with one advisory lock per team (`lockTeamSkillNames`,
  the upload's existing team lock).
  - Taken by team skill uploads, catalog installs, Reinstall and the Default sync's add, so the
    SK27 checks on each side see the other's commits.
  - Lock order is Default set, then install, then names; uploads take only the names lock.
- **Web:**
  - My skills (`/me/skills`): "Skills in your runs in <team>" lists personal skills, team skills
    and catalog installs with checkboxes. Required ones are locked on, with a hint per access
    mode.
  - Team skill editor: the Access selector replaces "Offer to all agents". Builders see Required
    disabled, and the Required count shows as a warning from 5.
  - Team Skills page: a "Catalog settings" section, which only Team admins can change.
- Docs: `docs/audit-log.md` gains the three new actions and `name_conflict`. `docs/install.md`
  has the upgrade note.

## Review fixes (review-316)

- **S1:** the legacy `PUT /offer` goes through `setTeamSkillAccess` (On by default or
  Available): the same cap, plus a `skill.access.changed` audit. A Required or Hidden skill gets
  409 `access_mode`, never a silent change.
- **S2:** the skill switches take a per-team advisory lock, and the upsert writes only the changed
  columns. Two admins changing different switches both stick.
- **S3:** `skill-registry.db.test.ts` covers the personal FK, the unique index, the one-skill and
  pin checks, and the cascade.
- **S4:** each install row has a "Change" form (version, pin mode, access). Team admins see it
  always. Builders see it while the setting allows, with no Required option, and not on Required
  or Default installs. The warning from 5 Required skills shows.
- **N1:** Builders change only installs a Builder or member made: never Required, Default or
  Team-admin-made ones (`builderMay`). Team admins change everything.
- **N2:** documented on `changeTeamInstall`.
- **N3:** `/access` refuses archived skills (404), and the cap counts only unarchived ones.
- **N4:** a new team takes every install lock, then the names lock, before its steps.
- Suites after the fixes: `@kobe/db` test:db 56 / 1325; `@kobe/server` test:db 129 / 1722.
  Under load, two unrelated files (artifacts, project-propose) and two hooks timed out once;
  rerun singly they pass. Unit suites, lint and typecheck: green.

## Open questions (for Chris or the coordinator)

- Builders may set a team skill to On by default, which reaches every member. Before this, only
  Team admins could turn on "Offer to all agents". This follows the brief ("Required — Team admin
  only"); say so if On by default should be Team admin only too.

## Evidence (acceptance criteria → test or command output)

- ac-1: `skill-enablements.db.test.ts` "a member's toggle takes effect on the next run, in that
  team only" (also: not another member's skill). Web: `my-skill-choices.test.tsx`.
- ac-2: the same db file, "Builders set Available, On by default and Hidden; Required is Team
  admin only" and "warns once the team has 5 Required skills". Web: `skill-reach.test.tsx`.
- ac-3: "turns On by default off and Available on; Required and Hidden can't be toggled", and
  "toggles an install the team made Available or On by default".
- Switches and Builder installs: "Team admins change the switches (audited); Builders install
  only while allowed". Web: `my-skill-choices.test.tsx` "Catalog settings".
- Suites: `@kobe/server` test:db 129 files / 1718 tests (one settings test widened for the
  additive switches, rerun green); `@kobe/db` test:db 56 / 1324; server, web and db unit suites,
  repo lint and typecheck green.
