# KOBE-324: B5: Contract: eval cases and scorecard

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

## Handoff (for the agent doing KOBE-325 onward)

- **Branch:** `group-skills-b` in `../Kobe-skB`; 320–323 reviewed, 324 is the contract (stop for
  review before 325). Earlier handoffs: `KOBE-320.md` … `KOBE-323.md` (323 lists what 325 reuses:
  `prepareDraftTest`, `draftSkillForRun`, `withDraftTests`/`onlySkill`).
- **Contract:** `packages/protocol/src/skill-evals/` + [docs/skill-evals.md](../skill-evals.md).
  325 should use: `parseSkillEvalSuite(text, {paths})` (refuse a run with issues),
  `planSkillEvalExecutions(suite, mode)` (one sandbox per entry), `fixtureWorkspacePath`,
  `skillEvalExecutionSchema` (one row per execution), `computeSkillEvalScorecard` (never compute
  numbers elsewhere), `skillEvalRunSchema`/progress/completed payloads, `skillEvalLimitsSchema`,
  `EVAL_MATCH_TIMEOUT_MS` and `EVAL_ANSWER_CHECK_MAX_CHARS` (run `matches` under a VM timeout or in
  a worker). 326: `skillEvalJudgeVerdictSchema`, `runModel.fellBack`, `judgeModel.source`. 327:
  `SKILL_EVAL_USAGE_KINDS`, `skillEvalEstimateSchema`, `teamEvalCapSchema`. 328: issues carry
  line/column for lint; `scorecardForProvenance` is the only export path.
- **For 325:** add a test that `EVAL_MODEL_ALIAS_PATTERN` equals `@kobe/db` `MODEL_ALIAS_PATTERN`
  (protocol can't import db). Decide the event transport (run SSE or team stream; the doc says
  325 picks it). Startup seeds / jobs (e.g. a stale-eval-sandbox sweep) must be written to slot
  into `packages/db/src/startup-seeds.ts` and `services/server/src/startup/jobs.ts` from main
  (G5) at rebase; note them in the 325 ledger.
- **No migrations** in 324. Branch migrations stay 0141–0144 until the coordinator's `db:rebase`.

- **Status:** in review (group branch `group-skills-b`, one PR for Phase B)
- **Depends on:** KOBE-309

## What shipped

- `cases.ts`: `evals/cases.yaml` schema and limits (25 cases, prompt 8000, 20 fixtures, 10
  outputs/contains/matches, rubric 2000, `max_turns` 1–100 default 20, `max_cost_usd` ≤ 50),
  strict at every level, optional `apiVersion: kobe.dev/skill-evals/v1`.
- `parse.ts`: YAML (manifest text rules) → suite or located issues (code, path, sentence,
  line/column), every problem at once, in file order; fixture existence against package paths.
- `plan.ts`: case kinds and the executions of `full` / `with_only` runs.
- `scorecard.ts`: execution, case detail, mode summary, scorecard schemas (consistency checks),
  `computeSkillEvalScorecard`, `scorecardForProvenance`.
- `api.ts`: subject (draft rev or saved version), start body, estimate, run, events, Site limits,
  team cap, judge verdict, usage kinds.
- `docs/skill-evals.md`; links from `docs/skill-package.md` and the protocol README.

## Decisions

- **Baseline only for behaviour cases.** Trigger-only cases (positive or negative) run with the
  skill only: without it the trigger check can't be made and the case would pass vacuously.
- **Lift over the same cases:** with-skill pass rate over the baseline cases minus the baseline
  pass rate (the headline pass rate covers all cases). Documented in the doc and code.
- **Errors count as failed** for pass rates, but executions with no observation (error,
  cancelled) are left out of trigger precision/recall; null when a denominator is 0.
- **Outputs relative to `/workspace`**, not only `/workspace/outputs/`: the spec's
  `outputs/*.xlsx` works as written, and the Workbench templates (KOBE-322) write `/workspace/out/`.
  `skills/` and hidden folders are refused for outputs and fixtures.
- **Regex for `matches`** (spec SK15) while policy stays glob-only: ≤ 256 characters, compiled with
  `u`, flags `i m s`, evaluated by the runner with a 100 ms limit on the first 64 Ki characters.
- **Retries:** an execution reports its final attempt; `totalCostUsd` includes the retry.
- **`yaml` moved to `@kobe/protocol` dependencies** so lint and the runner share one parser with
  positions. Already shipped by server, web and the sandbox image; ISC; licences regenerated (the
  row now lists every image that bundles protocol), `license:check` green.

## Departures

- `provenance.json` `scorecard.triggerPrecision` / `triggerRecall` became optional (were
  required): a suite may have nothing to measure them on. A loosening; old documents stay valid.
- `.prettierignore` lists the one deliberately invalid YAML fixture.

## Open questions (for review)

- Event transport for `skill.eval.*` (left to 325).
- Should a Site be able to raise the 25-case / 10-minute limits? The contract makes them ceilings.

## Evidence (acceptance criteria → test or command output)

- **ac-1** `skill-evals/cases.test.ts` (golden `fixtures/cases/*.yaml` + `issues.json`, defaults,
  kinds, plan), `scorecard.test.ts` (golden `fixtures/scorecard/valid-full.json` computed exactly
  from its executions; lift, precision/recall, nulls, with_only, plan mismatch, inconsistent
  cards), `api.test.ts` (API shapes, limits, cap, events refuse extra content).
- **ac-2** `cases.test.ts` "refuses <file> with a precise issue" (code, path, line, column,
  sentence) for 20 invalid fixtures; messages named in "writes messages that name the place".
- **ac-3** `api.test.ts` "the runtime bundle never carries evals/" (zip entries, runtime hash
  invariant under suite edits); server `skills/bundle-package.test.ts`,
  `skill-package-upload.db.test.ts` ("an evals-only change … same runtime hash").
- `@kobe/protocol`: test 868 passed, typecheck, lint, build; server and web typecheck;
  `license:check`, site wording, public hygiene ok.
