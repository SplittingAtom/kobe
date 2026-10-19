# KOBE-334: C5: Review console

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (group branch `group-skills-c`, one PR for Phase C)
- **Branch / worktree:** `group-skills-c` in `../Kobe-skC`
- **Depends on:** KOBE-330 (Registry team, `requireRegistryTeam`), KOBE-331 (`skillReviewAllows`),
  KOBE-332 (`recordFirstMaintainer`, `submissionRight`), KOBE-333 (submissions); KOBE-335 fills
  the authoritative scorecard Approve needs
- **Migrations (review):** 0153 `retracted` state, `finding_acknowledged`/`retracted` actions
  (generated); 0153 `registry_versions_review` CHECK covers the confirmer (generated); 0158 the
  review guard treats the confirmer as the submitter (custom); upgrade test
  `packages/db/src/registry-review-confirmer-upgrade.db.test.ts`. New dependency `diff` 9.0.0 (jsdiff, BSD-3-Clause; inventory regenerated)
- **Also here (KOBE-333 re-review LOWs):** R1 0157 joins the draft row in the version's own team
  (edited in place: the migration is unreleased; upgrade test adds a look-alike row in a second
  team); R2 `submit` re-reads the team review `FOR SHARE` inside its transaction and refuses
  `team_review` (test: a rejection landing between the check and the submit)

## What shipped

- **Server** (`services/server/src/skills/registry/review-*.ts`, routes
  `routes/site-skill-registry-review.ts` under `/v1/site/skills/registry`, each behind
  `requireSkillReview(action)`; the decision route checks the body's action with
  `mayReviewSkills`):
  - `GET /?state=open|submitted|in_review|changes_requested|approved|rejected|all`: the queue
    (maintainer submissions, oldest first, 100) with the bump against the approved version and the
    changed-file count (diffed from the catalog bytes, cached by hash pair).
  - `GET /:id`: evidence: scan verdict and findings, submitted and authoritative scorecards,
    capabilities (`egress` hosts with `inCeiling` against `egress_domains`), provenance and source
    team name, submitter, confirming Team admin, maintainers, similar names, the SK23 checklist,
    the history, and `approveProblems` for the caller.
  - `GET /:id/diff`: package vs the approved version (verified reads; changed first; text hunks
    via jsdiff; binary or > 256 KiB by status only; 20 000 patch lines then `truncated`).
  - `POST|DELETE /:id/claim`, `POST /:id/comments`, `POST /:id/decision {action, note?,
checklist?}` with approve, request_changes (note required), reject, reject_and_block.
- **Approve** (`review-approve.ts`), one transaction, fails closed, in order: `requireRegistryTeam`
  (409 `registry_not_ready`); version `FOR UPDATE`, still submitted/in review (409 `decided`), not
  claimed by another (409 `claimed`); the authoritative scorecard (409
  `authoritative_scorecard_missing` / `_stale`, the KOBE-335 hook `authoritativeScorecardProblem`
  in `review-guards.ts`); not on the blocklist (409 `blocked`); a Block verdict only by a Site
  admin (403 `block_verdict`); not the submitter's (403 `own_submission`) nor the confirming Team
  admin's (403 `confirmed_by_you`) unless `soleReviewer` (single-admin Site, same rule and lock as
  the DB guard); the submitter still an active maintainer once the skill has maintainers (409
  `not_maintainer`). Then the review (DB sets `self_approved`), `recordFirstMaintainer`, the
  catalog summary from the approved manifest, the event and `registry.approved` (with `verdict`,
  `selfApproved`, `confirmerApproved?`).
- **Other decisions** (`review-decide.ts`): each locks the row; claim (submitted → in review; own
  submission only on a single-admin Site), release (claimer, or a Site admin taking it over),
  comment, request changes, reject, reject and block (runtime hash blocklisted in the same
  transaction, `addBlockedInTx`). Audits `registry.claimed|unclaimed|commented|
changes_requested|rejected{blocked}`.
- **Names come free** (must-do 3, review C3-M2): before a first approval the right belongs to
  whoever has a submission open (submitted, in review, changes requested); with none open (all
  rejected) anyone may take the name. A rejected version keeps its semver (unique) but sets no
  floor for `not_newer`.
- **Notifications:** the submitter is emailed on claim, release, changes requested (with the
  note), approved and rejected, off the request path (`review-notify.ts`). The durable record is
  `GET /v1/me/skill-submissions` (own submissions, decision notes only; reviewers' comments stay in
  the Registry). `/v1/me` adds `siteGrants`.
- **Web:** Site console **Skill reviews** (`/admin/site/skill-review`, open to Site admins and
  Skill reviewers: `SiteSection.grant`, `SiteAccess.grants`): the queue with a state filter and
  the not-ready notice; the review screen (`/admin/site/skill-review/[id]`) opens on the diff,
  then evidence, the decision (checklist, note, Approve off with the reasons, Reject and block for
  admins only, confirmed) and the history; Claim / Let go. The Workbench tab lists **My Site
  submissions** with states and reviewers' notes.

## Decisions

- **Confirming Team admin** (review-c2 (b)): refused for Approve only (they may send back or
  reject). On a single-admin Site they may approve, flagged `self_approved` (review M2).
- **Name freeing by reopening, not deleting:** rejected versions stay in the Registry (its
  history), so the name's row stays and the next submitter's versions join it; approval re-checks
  the right, so two people can't both end up approved under one name.
- **Claims:** a decision needs the item unclaimed or claimed by the caller; Site admins may release
  anyone's claim. Approve needs no prior claim.
- **Email best effort:** like the Unmaintained email; the in-app list is the record. No outbox
  column (no migration).
- **Reject and block** blocks the runtime hash (its alias group covers the package hash).

## Review fixes (review-334.md)

- **H1** line diffs only up to 128 KiB / 5000 lines a file; jsdiff `timeout` 250 ms and
  `maxEditLength` 5000; 1.5 s per request; such files show "too large / too different / not
  diffed". The queue counts changed files by bytes (`changedFileCount`), never diffing.
  `review-diff.test.ts` runs the review's two 20 000-line files (< 3 s).
- **M1** (coordinator) `POST /:id/acknowledgements {finding}`: one Caution finding
  (`rule@file:line`) per call, a `finding_acknowledged` event and `registry.finding_acknowledged`
  audit; Approve 409 `findings_unacknowledged` until all are; the UI has one button per finding.
- **M2** (coordinator) the DB flags the confirmer's single-admin approval `self_approved`
  (0153/0158) and refuses it otherwise; the Workbench and queue show "Self-approved" (the catalog
  card is KOBE-336's).
- **M3** (coordinator) Reject/Reject and block also act on Changes requested; the author withdraws
  (`POST /v1/me/skill-submissions/:id/retract`, state `retracted`, Workbench button). Either frees
  a never-approved name. Tests in `skill-registry-review-rules.db.test.ts`.
- **L1/C3-L3** Approve locks the catalog skill row; `submit` re-checks `submissionRight` on the
  locked row and maps unique races to `taken`/`already_submitted`. **L2** the authoritative card
  must name the package. **L3** a Block override needs a note (`scanOverride` audited). **L4**
  hidden and bidi characters shown as `⟨U+202E⟩` markers in the diff. **L5** archived skill and
  deactivated submitter refused.
- Decided: no Registry-team hand-over on demotion.

## Open questions (for Chris or the coordinator)

- The `registry.version.updated` stream event (spec §8) isn't emitted; the console reloads.

## Evidence (acceptance criteria → test or command output)

- **ac-1** `services/server/src/skill-registry-review.db.test.ts` "the queue and the review
  screen": bump, changed files, diff hunks against 0.1.0, verdict, findings, scorecards,
  capabilities vs ceiling, provenance, similar names, checklist, history; reviewers and admins
  only. Diff unit tests `skills/registry/review-diff.test.ts`. Web
  `apps/web/components/admin/skill-review-console.test.tsx` (diff before evidence, panels).
- **ac-2** same DB file: Registry not ready, authoritative scorecard missing, own submission
  (approve, reject, claim), the confirming Team admin, reviewers can't block, admins block (hash
  listed, audit), blocklisted package, Block verdict, claims, racing decisions;
  `skill-registry-self-approve.db.test.ts`: single admin self-approves (flagged) and approves what
  it confirmed (audited), refused once a Skill reviewer exists. Web: Approve off with reasons,
  no Reject and block for reviewers; nav `lib/admin/nav/registry.test.ts`.
- **ac-3** DB "Request changes reaches the author": note required, `/v1/me/skill-submissions`
  shows it (only to the author), the email carries it, a new version is a new submission. Web
  `components/skills/my-submissions.test.tsx`.
- **ac-4** DB "every catalog version is reviewed by a human": submissions land `submitted`; the
  `registry_versions_approval` CHECK refuses `approved` without a reviewer; no code path sets it
  except Approve.
- Must-dos: 1 (registry team inside the transaction), 2 (first maintainer), 3 ("names come
  free"), 4 (row lock, `decided`), 5 (confirmer), 6 (scorecard missing) all in the DB file.
- Runs: typecheck, lint, format:check, license:check; all unit tests (chart `backup-secrets`
  flaked once under load, passes alone); server DB 12 files 126/126; db probe + registry upgrade
  tests 681/681.
