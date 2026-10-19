# KOBE-333: C4: Promotion: packaging, rules and Team admin confirmation

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

## Handoff for KOBE-334 onward (Phase C; a fresh agent continues)

- **Branch:** `group-skills-c` in `../Kobe-skC`, from main 16155c46; nothing pushed; one PR for
  Phase C (Chris's gate review after it; KOBE-342 is not ours). Done and reviewed: KOBE-442,
  330, 331, 332, 333 (ledgers in `docs/ledger/`). G10 (PR #317) and MCP Apps add migrations too:
  run `pnpm --filter @kobe/db db:rebase` at PR time.
- **Migrations on this branch:** 0149 `skill_drafts.synced_rev`, 0150 its backfill (custom), 0151
  partial unique save target, 0152 `teams.registry`, 0153 dedicated-Registry-team guard (custom),
  0154 `team_members.added_via`, 0155 `skill_promotion_requests` + `builders_may_promote`, 0156 its
  RLS (custom), 0157 `*_skill_versions.from_conversation`, 0158 its backfill (custom). Each alone in
  its commit, generated and custom apart, upgrade tests in `packages/db/src/*-upgrade.db.test.ts`.
- **Decisions in force (coordinator / Chris):**
  - The Registry team is a dedicated team Kobe creates (`POST /v1/site/skills/registry/team`,
    `teams.registry`); an existing team is never named (DB trigger). Its creator is team admin.
  - Skill reviewer grant (`site_grants`): never to oneself, Site admins, the Owner or a
    deactivated account; Kobe adds grantees to the Registry team (`added_via`) and taking the grant
    removes only those memberships. `skillReviewAllows`/`requireSkillReview(deps, action)` are the
    authorization for every Registry action: reviewers queue/claim/comment/approve/request
    changes/reject; admins also reject-and-block, withdraw, revoke, tag Default, settings.
  - Only a version the team's own review approved (not suspended) is promoted; a Builder's
    promotion waits for a Team admin unless `buildersMayPromote`; the first decision on a request
    wins (409 `request_closed`).
  - An Unmaintained skill refuses every former maintainer until a Site admin reassigns it.
  - `from_conversation` lives on the version (set at save, through forks); provenance and
    `skill.promoted` copy it.
- **Must-dos for KOBE-334 (review console), decided, not built:**
  1. Approve calls `requireRegistryTeam(tx)` (skills/registry/settings.ts) **inside** the approve
     transaction (it takes `FOR SHARE` on the settings row) and answers 409 `registry_not_ready`;
     Approve is disabled in the UI while `GET /v1/site/skills/registry/status` says not ready.
  2. Approve calls `recordFirstMaintainer(tx, skillId, submittedBy)` (maintainers.ts): the first
     approved submitter becomes the first maintainer.
  3. Free the name when a never-approved skill's first submission is rejected or withdrawn
     (review C3-M2): delete its `registry_skills` row (no approved version, no maintainers) or let
     the next submitter take it; test that a squatted name comes free.
  4. Separation of duties (`registry_versions_review` CHECK, self-approve flag), claims, the diff
     against the approved version, `similarCatalogNames` hints (`GET .../registry/similar`).
  5. Decide whether a demoted Registry-team creator hands the team over (review-c2 L-d).
- **Known follow-ups (review-c2 LOWs, not done):** the grantee checks run before the grant
  transaction (L-b); `kobe-` prefix and token-contains name hints (C3-L1); maintainers' emails
  visible to all members (C3-L2: hide until published); submission right re-checked inside
  `submit` with a row lock on the catalog skill and 23505 → 409 (C3-L3); a sweep for a failed
  Unmaintained hook (C3-L4); cancel open requests when the requester leaves or is demoted, and
  re-check at confirm (C4-L1); orphan catalog blobs after a failed submit (C4-L2); the preview of
  a team skill should need `team.skills.publish` (C4-L4).
- **What 335 to 341 need from here:** 335 re-runs evals in the Registry team (`registryTeamFor`
  for the team id; the Site judge `judge_alias`) and stores `authoritative_scorecard` (the
  catalog card shape, `scorecardForProvenance`); Approve also needs it. 336 browses
  `registry_skills`/`registry_versions` (approved only; never `source` to browsers). 337/338
  install approved versions (`team_skill_installs`, `member_skill_enablements`). 339 aggregates
  with the minimum-count rule (3 teams / 20 ratings). 340 deprecate/withdraw/revoke through the
  blocklist (admin-only actions in `skillReviewAllows`). 341: the scanner toggle is
  `site_skill_settings.scanner.external`; the Job runs in the Registry team's namespace.

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

- **From-conversation flag** (review C4-M3): stored on the version at save (0157), from the draft
  (`startedFrom thread` or a thread id) or a fork's parent version (team, personal or catalog
  provenance); 0158 backfills older versions from the audit log (forks before it not traced).
- The eval that counts must have run in the **active** (source) team: eval transcripts never
  leave a team, and the scorecard comes from that team's run.
- The "one automatic retry per failing case" rule is the eval runner's to apply (KOBE-325); it is
  stored in the rules but not checked at submission.
- `registryTeamFor`/`requireRegistryTeam` (KOBE-330 review M2) is for approve and re-run;
  submission does not need the Registry team (the queue may fill before it exists).

## Review fixes (review-c2.md)

- C4-M2 `team_review` refusal; C4-M1 request row lock, 409 `request_closed`; C4-M3 the flag on
  the version; C4-L3 `kobe.skill.yaml` listed as leaving. Tests: team-rejected and unreviewed
  refused, decline-then-confirm and racing decisions, true path for a conversation draft, its
  fork and a personal skill promoted from another team; a direct upload is false.
- L-a (pre-review reviewers left in an ordinary team): no install ran that code (gate1 was
  checked: no designation, no grants), so nothing is migrated; 0153's comment overstates that
  nothing was recorded (the memberships were made, never marked).

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
