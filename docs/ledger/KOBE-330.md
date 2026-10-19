# KOBE-330: C1: Registry settings and the Registry team

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (group branch `group-skills-c`, one PR for Phase C)
- **Branch / worktree:** `group-skills-c` in `../Kobe-skC`
- **Depends on:** KOBE-311 (the `site_skill_settings` row and its columns), KOBE-325/326 (eval
  limits, judge alias readers)
- **Migrations (review):** 0153 `teams.registry` + one-registry-team index (generated), 0155
  (custom) clears an ordinary team's designation and adds the guard triggers; upgrade test
  `packages/db/src/registry-team-upgrade.db.test.ts`

## What shipped

- **Protocol** (`packages/protocol/src/skill-registry-settings.ts`): zod documents with the spec's
  defaults, so an empty row reads as SK20's table:
  `submissionRules` {minCases 3, minNegativeCases 1, minPassRate 0.8, minLift 0,
  minTriggerPrecision 0.8, refuseBlockVerdict, requireLicense, requireFreshScorecard,
  retriesPerFailingCase 1}; `evalLimits` (the existing `skillEvalLimitsSchema`, SK18);
  `importAllowlist` (lowercase host names, at most 50, unique; D2); `scanner` {external false}
  (SK32); `mirror` {enabled false, url https when enabled, branch} (D1; credentials are not here);
  `judgeAlias`; `registryTeamId`. `registrySettingsUpdateSchema` takes any subset, at least one.
- **Server:** `skills/registry/settings.ts`: `readRegistrySettings` (a stored document that no
  longer parses reads as its defaults, so a bad row never blocks the Registry), `registryReady`
  (a Registry team is named; FK `ON DELETE SET NULL` makes a deleted team "not ready"), and
  `updateRegistrySettings` (the team must exist, the judge alias must be in `model_catalog`; one
  transaction; audit `skill.registry.settings_updated` with the changed names and, when they
  changed, the team id and alias, never URLs or rule values). Route
  `GET|PUT /v1/site/skills/registry/settings`, `site.skills.catalog.manage` (Site admins and the
  Owner; Skill reviewers, KOBE-331, are not given it: SK22).
- **Web:** Site console **Skill Registry** (`/admin/site/skill-registry`, Teams and agents): a
  "not ready" notice until a team is named, the team picker, judge alias, every rule, eval
  limits, allowlist, scanner and mirror; Save sends only what changed.

## Decisions

- **No new permission:** Registry settings sit with the catalog (`site.skills.catalog.manage`),
  which only admins hold; KOBE-331 adds `site.skills.review` for the queue.
- **"Approve disabled" (ac-2):** there is no Approve yet; `requireRegistryTeam(tx)` is the guard
  (see M2 below) and the console shows "not ready".
- Rule documents are replaced whole on save (the web sends the full rules object when any rule
  changed), so the stored document is always complete.

## Review fixes (review-c1.md)

- **H1 (coordinator decision): the Registry team is always a dedicated team Kobe creates.**
  `POST /v1/site/skills/registry/team {name, slug}` creates it flagged `teams.registry` (at most
  one; the flag is fixed at creation by trigger), with the creating Site admin as team admin and
  every active Skill reviewer as a member, and names it, in one transaction. `registryTeamId` is
  no longer a setting; the database refuses naming any other team (trigger, 23514). 0155 clears
  an existing designation of an ordinary team (a NOTICE in the migration log names it); its
  members are untouched. Deleting the Registry team leaves "not ready"; a new one can be created.
- **M1** a mirror URL with userinfo, query or fragment is refused (the token lives in a Secret).
- **M2** `registryTeamFor(tx)` reads the team under `FOR SHARE` and `requireRegistryTeam(tx)`
  answers `registry_not_ready`: **Approve, re-runs and every Registry action from KOBE-333 on must
  call it inside their transaction and use the id it returns** (tested now: not ready → refused).
- **L2** the audit lists settings whose values changed; re-sending the same values records
  nothing. **L3** an unparseable stored document reads as defaults with a warning. **L1** doc
  comment restored. **L4** SK30's allowlisted organizations and SK22's single-admin self-approve
  flag are left to the import (D2) and review tickets.

## Open questions (for Chris or the coordinator)

- The mirror's credentials (D1) and the scanner's settings beyond on/off (SK32) belong to their
  tickets; the shapes here may grow there.

## Evidence (acceptance criteria → test or command output)

- **ac-1** `services/server/src/skill-registry-settings.db.test.ts`: persist with validation
  (unknown team, unknown alias, out-of-range rules, bad hosts, mirror without URL, unknown keys
  refused; members 403) and one audit row with the actor; web
  `apps/web/components/admin/skill-registry-page.test.tsx` (only changed settings sent).
- **ac-2** same DB file: not ready on a fresh Site, ready once named, not ready when cleared or
  the team deleted; the console notice in the web test.
- **ac-3** `packages/protocol/src/skill-registry-settings.test.ts` (defaults equal SK20) and the DB
  test's fresh-Site read.
