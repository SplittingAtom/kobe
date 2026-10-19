# KOBE-333: C4: Promotion: packaging, rules and Team admin confirmation

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (group branch `group-skills-c`, one PR for Phase C)
- **Branch / worktree:** `group-skills-c` in `../Kobe-skC`
- **Depends on:** KOBE-330 (settings, rules), KOBE-332 (`submissionRight`), KOBE-310 (SkillStore
  `export`), KOBE-324 (catalog scorecard), KOBE-309 (provenance)
- **Migrations:** 0155 `skill_promotion_requests` + `team_skill_settings.builders_may_promote`
  (generated), 0156 its RLS (custom: ENABLE + FORCE, team policy, break-glass read by team or
  requester). New, empty table and a defaulted column: no backfill. Probe suite fixture and
  `BREAK_GLASS_READABLE_TABLES` entry added.

## What shipped

- **Preview and rules** (`skills/registry/promote-check.ts`): the version's own package from
  `SkillStore.export` (verified by hash; a legacy version is refused until saved again), split
  into payload files and `evals/` (cases and fixtures), the from-conversation flag, a fresh scan
  of the package, and the team's newest completed **full** eval of this package hash (its
  `scorecardForProvenance` numbers). SK20 checks with the Site's rules (KOBE-330): name right
  (reserved, taken, not a maintainer, archived), semver already submitted or older, kobe.skill.yaml
  present, license, Block verdict, scorecard present and each `skillEvalSubmissionShortfalls`
  (stale only when freshness is required). Each refusal has a code and a message.
- **Promote** (`skills/registry/promote.ts`, `POST /v1/skills/promotions`,
  `GET /v1/skills/promotions/preview`): personal → its author (the store only exports the
  caller's own); team → a Team admin, or a Builder while "Builders may promote without
  confirmation" is on; otherwise a Builder's Promote creates a pending
  `skill_promotion_requests` row (one open request per version, 202) and audits
  `skill.promotion.requested`. Members: 403. Refusals: 422 `submission_refused` with
  `refusals`.
- **Submit:** the runtime and package zips go to the catalog's content-addressed keys
  (`skills/catalog/<sha256>`, as KOBE-317); then one transaction in the source team's context
  creates the catalog skill for a new name (publisher `maintainer`, summary from the manifest),
  the `submitted` Registry version (`seq` next, `source` the local team/skill/seq, scan document,
  `scorecard` = the catalog card), its Kobe-written `provenance.json` (validated by
  `provenanceSchema`: hashes, source team, submitter, `confirmedBy`, from-conversation, scan
  locations, scorecard numbers only), the `submitted` review event, and the audits
  `skill.promoted` (team: counts of files and fixtures, the flag, the request) and
  `registry.submitted` (Site).
- **Team queue** (`/v1/team/skill-promotions`, Team admins): list, a request's preview (exactly
  what leaves), confirm (rules checked again; the Builder stays the submitter, the admin is
  `confirmedBy`; `skill.promotion.confirmed`) or decline with a note
  (`skill.promotion.declined`). The switch lives in the team's skill settings
  (`buildersMayPromote`, audited as `skill.catalog_switches.changed`).
- **Web:** Skills page Team and Mine rows get **Promote to Site** (Builders/Team admins for team
  skills, the author for personal ones): what leaves, the rules' reasons, Promote. The team
  console Skills page gets **Promote to Site requests** (confirm/decline) and the Builders switch.

## Decisions

- **From-conversation flag** is read from the team's own audit rows (`skill.uploaded` with its
  `draftId` → that draft's `skill.draft.created` `startedFrom`; for personal versions the
  `skill.draft.personalized` row of the active team), so a deleted draft still answers. A personal
  version saved from another team's draft reads false (that team's log is not this team's).
- The eval that counts must have run in the **active** (source) team: eval transcripts never
  leave a team, and the scorecard comes from that team's run.
- The "one automatic retry per failing case" rule is the eval runner's to apply (KOBE-325); it is
  stored in the rules but not checked at submission.
- `registryTeamFor`/`requireRegistryTeam` (KOBE-330 review M2) is for approve and re-run;
  submission does not need the Registry team (the queue may fill before it exists).

## Open questions (for Chris or the coordinator)

- The first approved submitter becomes the maintainer at approval (KOBE-332's
  `recordFirstMaintainer`); the review ticket wires it.

## Evidence (acceptance criteria → test or command output)

- **ac-1** `services/server/src/skill-promotion.db.test.ts` "a Team admin's promotion" and
  "a personal promotion": the stored package is exactly payload, `evals/` and
  `kobe.skill.yaml`; provenance parses and holds the source, submitter and numbers only (no case
  ids, threads, runs, prompts or details); audits on both sides.
- **ac-2** same file "rules": no scorecard and no license refused with reasons, nothing submitted;
  web `apps/web/components/admin/skill-promotion.test.tsx` shows the reasons and disables Promote.
- **ac-3** same DB file "a Builder's promotion": request, admin-only queue, preview, confirm
  (Builder submitter, admin `confirmedBy`), decline, the team switch letting Builders through;
  web tests for the queue.
- **ac-4** same DB file "teams are walls": another team's admin can't read, fork, preview or
  promote the skill, and nothing of it reaches the Registry without promotion.
- Probe suite 657/657 with the new table.
