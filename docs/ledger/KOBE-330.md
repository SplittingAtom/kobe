# KOBE-330: C1: Registry settings and the Registry team

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (group branch `group-skills-c`, one PR for Phase C)
- **Branch / worktree:** `group-skills-c` in `../Kobe-skC`
- **Depends on:** KOBE-311 (the `site_skill_settings` row and its columns), KOBE-325/326 (eval
  limits, judge alias readers)
- **Migrations:** none (the table and its seeded row exist since 0133)

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
- **"Approve disabled" (ac-2):** there is no Approve yet (the review screen is a later Phase C
  ticket). `registryReady()` is the guard Approve and re-runs must call, and the console shows
  "not ready"; the review ticket wires the button and the 409.
- Rule documents are replaced whole on save (the web sends the full rules object when any rule
  changed), so the stored document is always complete.

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
