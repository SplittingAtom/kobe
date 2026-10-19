# KOBE-335: C6: Authoritative scorecard: re-run in the Registry team

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (group branch `group-skills-c`, one PR for Phase C)
- **Branch / worktree:** `group-skills-c` in `../Kobe-skC`
- **Depends on:** KOBE-334 (Approve's `authoritativeScorecardProblem` hook), KOBE-325/326/327
  (eval runner, judge, budgets), KOBE-330 (Registry team, Site judge alias)
- **Migrations:** 0153 `skill_eval_runs_subject_kind` adds `registry` (generated); upgrade test
  `packages/db/src/skill-eval-registry-subject-upgrade.db.test.ts`

## What shipped

- **Protocol:** `skillEvalSubjectSchema` gains `{kind: "registry", versionId, seq}`.
- **Start** (`skills/evals/start.ts`): subject `{kind: "registry", versionId}` loads the Registry
  version's package from the catalog store (verified by its row's hashes, `readPackage`); no
  test-chat gate (it is the Registry team's own review); the judge is `siteJudgeFor` only (Site
  `judge_alias` enabled in the team), else 409 `site_judge_unavailable` when the suite has judged
  cases. Everything else is a normal eval: scan, suite limits, budgets and the team eval cap,
  open-eval limits, run model.
- **Re-run** (`skills/registry/rerun.ts`, `POST /v1/site/skills/registry/:id/rerun-evals`, new
  review action `rerun` for Skill reviewers and admins): the version must be submitted or in
  review and the Registry team ready; the reviewer must be a member of the Registry team (409
  `not_registry_member`: Skill reviewers are by the grant; other Site admins must be added). A
  full eval in the Registry team, as the reviewer, so its threads, runs and spend are that
  team's (SK21). Like every eval run, it never reads the starter's personal connector keys
  (`withSkillEvals` `noPersonalGrants`); the run's skill is recorded as source `catalog`. Review
  event `evals_rerun`, audit `registry.evals_rerun`.
- **Authoritative scorecard** (`skills/registry/authoritative.ts`): when a `registry` eval run
  completes, in the same transaction (`completeIfDone`), its card reduced to the catalog card
  (`scorecardForProvenance`: numbers only, no case ids, prompts, threads or reasons) plus
  `rerun {teamId, evalRunId, judgeAlias}` is stored on the version, only while it is submitted or
  in review, the package hash matches, the run's team is the current Registry team and its judge
  the Site's. Audit `registry.authoritative_scorecard` (system). A later re-run replaces it.
- **Approve** needs that card: the package (review L2), the current Registry team and, when the
  card has a judge, the current Site judge (409 `authoritative_scorecard_stale` otherwise).
- **Review screen:** the detail carries `rerun` (latest run's state and progress, read under the
  Registry team's RLS); the Scorecards panel shows the authoritative card, **Re-run evals**
  (off while one runs) and the latest re-run's progress.

## Decisions

- Re-runs run as the reviewer, not a system identity: `started_by` is a person (budgets, the
  eval thread owner, audit), and the Registry team is the reviewers' own team. Site admins who
  aren't members are refused rather than added (teams are walls).
- (Superseded by review M3) the submitter may not start a re-run of their own submission.
- The catalog card's shape is the promotion's (`catalogSkillEvalScorecardSchema`), so the catalog
  (KOBE-336) shows submitted and authoritative cards alike; `rerun` sits beside it.

## Review fixes (review-335.md)

- **M1** (coordinator) acknowledging a Caution finding follows separation of duties: not the
  submitter or the confirming Team admin, except the single admin (`review-duties.ts`). Tests:
  rules file (403 `own_submission`), self-approve file (the single admin may).
- **M2** (coordinator) the diff reads SKILL.md, kobe.skill.yaml, `scripts/`, then the rest, so
  decoys can't push SKILL.md out of the budget; `GET /:id/diff?path=` loads a skipped file alone
  (a whole request's budget) and `GET /:id/file?path=` shows a too-large or too-different file
  whole (to 1 MiB, hidden characters marked). Unit test with six decoys and a changed SKILL.md.
- **M3** (coordinator) only reviewers who are neither submitter nor confirmer start or cancel
  re-runs (cancel at `/:id/reruns/:evalRunId/cancel`; the team's eval cancel refuses re-runs);
  every re-run stays in the review screen's history (from the Registry's own events, so a purged
  run shows `gone`) with starter, outcome and canceller; the card is the latest completed run's,
  and earlier completed runs that scored lower are marked. DB test: fail, cancel, pass.
- **L1** full diffs cached by package pair (50); 200 files under the caps stay under 2.5 s.
  **L2** a card the catalog contract refuses is logged, the eval still completes. **L3** decide,
  approve and retract cancel the version's open re-runs in their transaction (run in the Registry
  team's context, `registry-tx.ts`). **L4** cards older than 30 days, judged by another model
  than the Site alias names now, or with every execution errored are refused. **L5** the
  `not_registry_member` message (see the question). **L6** documented: re-runs read no personal
  key, but the Registry team's own connectors connect, so it should enable no keyed connector.
  **L7** tests: the Registry team's open-eval limit, the package guard on a completing card,
  0158's refusal as the app role. Not added: a budget-cap re-run test and a personal-connector
  re-run test (both go through the shared eval start and `withSkillEvals`, tested by
  `skill-eval-budget` and the runner tests).

## Open questions (for Chris or the coordinator)

- (Answered, review-336) Site admins may hold the Skill reviewer grant from another admin; the
  `not_registry_member` message says to ask for it.
- "Shown in the catalog" (ac-2): the catalog browse is KOBE-336; the card is stored and the
  review screen shows it.
- A completed re-run whose version was decided meanwhile is not stored (logged only).

## Evidence (acceptance criteria → test or command output)

- **ac-1** `services/server/src/skill-registry-rerun.db.test.ts` "runs there with the Site
  judge…": the eval run is the Registry team's, `subject_kind registry`, `full`, started by the
  reviewer, `judge_model {fast, site}`; its runs belong to the Registry team. "is refused…":
  non-member 409 `not_registry_member`; Site judge not enabled there 409
  `site_judge_unavailable`.
- **ac-2** same test: the stored card names the package, 3 cases, `judge.source site`, the
  `rerun` facts, and holds no case ids, prompts, thread ids or reasons; the review screen shows it
  and the re-run's state; audits `registry.evals_rerun`, `registry.authoritative_scorecard`. Web
  `apps/web/components/admin/skill-review-console.test.tsx` (Re-run evals, progress).
- **ac-3** same test: Approve refused (`authoritative_scorecard_missing`) before, allowed after;
  "goes stale…": another Registry team or Site judge refuses Approve. KOBE-334's tests use the
  fixture `authoritative()` shaped like a re-run's card.
- Runs: typecheck, lint, format:check, license:check, db:check; all unit tests (web and
  sandbox-agent flaked under the parallel run, pass alone); server DB 20 files (eval runner,
  judge, budget, registry, promotion, drafts, wire) 198/198; db probe and upgrade tests 693/693.
