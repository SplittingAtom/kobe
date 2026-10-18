# KOBE-318: A12: Agent publish freezes local skill versions

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (group branch, Skills v1.2 Phase A)
- **Branch / worktree:** `group-skills-a` in `../Kobe-skA`
- **Depends on:** KOBE-313, 315, 316, 317 (same branch)

## Plan

Two migrations (0139 generated, 0140 custom backfill), then freezing at publish, frozen
resolution at run start, the builder's "skill update available", and tests (upgrade with rows,
run-start parity, the 313 frozen-version check). Phase A summary in `skills-phase-a.md`.

## Decisions

- **Where the manifest lives:** `team_agent_versions.skill_manifest` only, as
  `{"skills": [{"name", "skill_id", "version"}]}` in the agent's order (team skill id and
  version: the key every review row and bundle uses). The brief says `agent_versions` and "team
  and personal skills it names":
  - Agents name only team (and catalog) skills: since D22 a named name never resolves to a
    personal skill (personal skills are the member's step 4, newest version, and an agent naming
    one shadows it). So there are no named personal skills to freeze.
  - Personal and gallery agent versions (`site_agent_versions`) have no team at publish and run
    in any of their user's teams; freezing team skills there would put team skill ids in a
    site-wide row (teams are walls). They freeze nothing and resolve as before. **Open question.**
  - Gallery versions name only Kobe skills, which are catalog skills (never frozen, 317).
- **0139 (generated):** `skill_manifest jsonb`, nullable so it can be added to existing rows.
- **0140 (custom backfill):** every team agent version gets the versions it resolves to on
  migration day, in SQL that mirrors `loadSkillFacts`: per listed name, once, in order; never
  Kobe's seven; only names the team has a skill of; the newest approved or suspended review row
  of that slug (`teamSkillStates`, so a suspended newest stays `suspended`); not a name whose own
  skill is archived while the team installed a published catalog skill of that name
  (`catalogNamed`). FORCE is lifted on `team_agent_versions`, `team_skills`,
  `team_skill_reviews` and `team_skill_installs`, and the immutability trigger disabled, for the
  backfill only (one transaction); a `RAISE NOTICE` counts versions and frozen entries. Then
  `team_agent_versions_skill_manifest` (SQL-only CHECK, like 0130's): not null, an object with a
  `skills` array, at most 16 KiB. Upgrade note in `docs/install.md` (old pods can't publish team
  agents after the Job; a rolled-back release ignores the freeze).
- **Publish (`agents/skill-freeze.ts`, `skills/frozen.ts`):** `insertVersion` freezes for team
  locations, inside the publish transaction: the names that route to the team's own skills
  (`localNamedSkills`, the same split as run start), each at its **newest valid** version
  (approved, not suspended, hash not blocklisted), so a republish moves off a version a rescan
  or the blocklist took out. With none valid, the newest approved-or-suspended one, so the
  notice keeps its reason. A name with no reviewed version is not frozen.
  - `contentKey` includes the skill manifest (team only), so a republish that only picks up a
    newer skill version is a new version, and one that changes nothing is still `unchanged`.
    The eval gate's own unchanged check freezes the same way.
  - **Rollback** restores the frozen versions of the version it republishes (it restores that
    version's behaviour; the tool manifest is recomputed because it is a policy ceiling, while
    every frozen version is checked again at run start anyway).
  - Drafts (test pane) freeze nothing: they run today's newest approved versions, a preview of
    what a publish would freeze.
- **Run start (`runs/resolver-input.ts`):** `loadSkillFacts` takes `frozen` (the pinned team
  version's manifest). A frozen name resolves to exactly that version (`frozenStates`): loaded
  only while the team's review row (scope team, same slug) is `approved` and `suspended_at` is
  null; suspended → `suspended`; rejected, pending or missing → `not_approved`; a blocklisted
  hash → the resolver's `blocklisted`. Never another version. A team name not in the manifest
  is `not_approved` until a republish, whatever was approved since (ac-2). Reasons are existing
  ones (no protocol change); they reach the run's `context.omitted` notice.
  - **Archive:** a frozen name stays local even if the team since archived the skill and installed
    the catalog skill of that name (SK31: archive keeps versions resolvable for frozen agents); a
    republish hands the name to the install.
  - **Required:** a Required team skill of the same name loads first at its newest version and
    the frozen one is a silent duplicate (SK27: Required first). A Required skill of another
    source still makes the named one `shadowed` (317).
  - **Team blocks** apply to catalog skills only, so they never touch frozen local versions.
  - **Cap of 64:** frozen named skills count in step 2, after Required (test).
  - **Catalog and Kobe skills:** never frozen; they follow the team install's pin (test).
  - A manifest that doesn't parse makes the version `version_unreadable` (fail closed).
- **Builder (ac-3):** `GET /v1/agents/{id}/skill-updates` (anyone who may read the definition;
  404 for another team's agent; personal and gallery agents list none) answers, per named team
  skill of the current version, `frozen` `{version, semver}`, `status` (`ok`, `blocklisted`,
  `suspended`, `not_approved`) and `update` (the valid version a republish would freeze, when
  different). The team agent builder shows "Skill update available: x 0.1.0 → 0.2.0. Publish
  again to use it." and "x 0.1.0 is blocklisted: runs of v3 leave it out." (`skill-updates.tsx`).
  Threads then see the D19 "v4 available" badge as before. Not in OpenAPI (agent routes aren't).
- **Changed test:** `skill-resolver-v2.db.test.ts` marker test: a named team skill no longer
  moves on approval (ac-2), so the marker is shown with an On by default team skill instead.

## Open questions (for Chris or the coordinator)

- Personal agents name team skills of whichever team runs them, and freeze nothing. Freezing them
  per team would need a team table (frozen at first run or at publish for each of the owner's
  teams); say if SK28 should cover them.
- Republish picks the newest **valid** version, which can be older than a suspended or
  blocklisted newest one (a visible step back the builder shows as the update). Say if a
  republish should rather keep the newest and its notice.

## Evidence (acceptance criteria → test or command output)

- ac-1: `packages/db/src/agent-skill-manifest-upgrade.db.test.ts` (rows at the old schema,
  migrated as the non-superuser owner: manifests per version, walls, FORCE and trigger back,
  the CHECK); `services/server/src/skill-freeze-upgrade.db.test.ts` (parity: seven versions over
  every kind of named skill resolve identically, hashes and notices included, unfrozen before
  and through the backfilled manifest after).
- ac-2: `services/server/src/skill-freeze.db.test.ts` "publish freezes local skill versions"
  (newer approval changes nothing until republish, also for run.start's bundles; rollback;
  not-yet-approved names).
- ac-3 and the 313 check: same file, "a frozen version that later fails a check" (suspended,
  blocklisted, no longer approved; republish picks a valid one), "next to Required, archive,
  catalog and the cap", "the builder's skill updates";
  `apps/web/components/admin/team/agent-builder/skill-updates.test.tsx`.
- Suites: `@kobe/server` test:db 132 files / 1751 (alone; the one failure, a raw insert without
  a manifest in `agent-versions.db.test.ts`, fixed and rerun with the changed files: 46 / 46);
  `@kobe/db` test:db 58 / 1335; `@kobe/cli` test:db 4 / 28 with `KOBE_PG_BIN_DIR`; unit suites
  of server (1991), web (1831), db (566), cli (85); repo typecheck, lint, format:check. The old
  marker test fails under the freeze, as intended (checked, then changed).
