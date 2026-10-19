# KOBE-324: B5: Contract: eval cases and scorecard

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

## Handoff (for the agent doing KOBE-325 onward)

- **Branch:** `group-skills-b` in `../Kobe-skB`; 320–323 reviewed, 324 is the contract (stop for
  review before 325). Earlier handoffs: `KOBE-320.md` … `KOBE-323.md` (323 lists what 325 reuses:
  `prepareDraftTest`, `draftSkillForRun`, `withDraftTests`/`onlySkill`).
- **Contract:** `packages/protocol/src/skill-evals/` + [docs/skill-evals.md](../skill-evals.md),
  revised after review-324 (B1, B2, S1–S8, nits). 325 should use: `parseSkillEvalSuite(text,
{paths, maxCases})` from `@kobe/protocol/skill-evals` (refuse a run with issues),
  `planSkillEvalExecutions`, `expectedChecks`, `fixtureWorkspacePath`, the snapshot types and
  `checkEvalOutputs` (the sandbox side walks with lstat, never following links), `skillUses` from
  `runs.skills_used`, `skillEvalExecutionSchema` (one row per execution),
  `computeSkillEvalScorecard` / `verifySkillEvalScorecard` (never compute numbers elsewhere),
  `skillEvalRunSchema` and the payloads, `skillEvalLimitsSchema`, `EVAL_MATCH_TIMEOUT_MS`. 326:
  `skillEvalJudgeMessages`, `parseSkillEvalJudgeVerdict`, `runModel.fellBack`, `judgeModel.source`.
  327: `SKILL_EVAL_USAGE_KINDS`, the cost reconciliation rule, `skillEvalEstimateSchema`,
  `teamEvalCapSchema`. 328: issues carry line/column; Phase C: `CatalogSkillEvalScorecard` is the
  only type for site-wide storage, `skillEvalSubmissionShortfalls` for SK20.
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

## Review-324 fixes (`review-324.md`)

- **B1:** outputs match only produced files: regular files in the after-snapshot outside
  `skills/` and hidden segments (any depth), absent from the before-snapshot or with other bytes.
  Links are never followed or read. Caps: 10 000 entries walked, 100 files / 50 MiB per glob,
  over-cap fails `over_cap`. Literal reserved globs are lint errors.
- **B2:** `expectedChecks`; compute refuses check sets that aren't the case's, and a `triggers`
  check that contradicts `triggered`; `triggered` is derived from `skillUses`
  (`runs.skills_used`); `verifySkillEvalScorecard`; `completedAt ≥ startedAt`; 10 forged fixtures.
- **S1:** status counts per mode; a pair with an errored side makes lift null
  (`liftUnavailable: incomplete_pairs`); scorecards hold only passed/failed/error/timed_out
  (cancelled and budget-stopped runs have none). Lift asymmetry documented.
- **S2/S3:** `CatalogSkillEvalScorecard` (full only, rates checked against counts, `triggerCounts`,
  status counts, `judge.source`, `runModelFellBack`) replaces provenance's scorecard block;
  `skillEvalSubmissionShortfalls` (missing lift or precision fails its rule).
- **S4:** `judge.ts`: rubric-only system message, nonce-delimited JSON data, caps, strict verdict.
- **S5:** explicit tags refused (`yaml_tag`), nesting ≤ 16 (`too_deep`, lexer pre-scan + tree);
  the parser moved to the `@kobe/protocol/skill-evals` subpath (root entry has no `yaml`).
- **S6/S7:** cost, duration, judge cost and `max_cost_usd` pinned; cost reconciles with
  `run_usage`; run schema ties scorecard to status, package, mode and progress; with_only never
  exported.
- **Nits:** `casesExpectingTrigger` vs kind count; `maxCases` lint option; `contains` untrimmed;
  modifier groups refused; check `reason` enum; turns and denials defined; format rule; "nothing
  grants anything".

## Re-review should-fixes

- **S-R1/S-R2:** before = fixtures (server-side hashes); the after-walk covers each glob's literal
  directory only, hashes fixture paths only, and is capped per walk. `O_NOFOLLOW` + `fstat` and a
  256 KiB read cap for judge reads.
- **Judge:** structured-output mode with `SKILL_EVAL_JUDGE_RESPONSE_SCHEMA`, one fenced block
  accepted, temperature 0; `judgeOutputText` defines binary; reviewers check rubrics (Phase C).
- **S-R3:** the lexer pre-scan counts block levels (compact `- - -` and `?` included); a parser
  stack overflow is refused as `too_deep`. `maxCases` clamped to 1–25;
  `skillEvalSubmissionRulesSchema`.
- **For 325:** the after-snapshot needs a sandbox-wire frame (request: walk roots + fixture paths;
  reply: `EvalWorkspaceSnapshot`).

## Decisions

- **Baseline only for behaviour cases.** Trigger-only cases (positive or negative) run with the
  skill only: without it the trigger check can't be made and the case would pass vacuously.
- **Lift over the same cases:** with-skill pass rate over the baseline cases minus the baseline
  pass rate (the headline pass rate covers all cases). Documented in the doc and code.
- **Errors count as failed** for pass rates, but errored executions are left out of trigger
  precision/recall (null when a denominator is 0) and make lift unavailable.
- **Outputs relative to `/workspace`**, not only `/workspace/outputs/`: the spec's
  `outputs/*.xlsx` works as written, and the Workbench templates (KOBE-322) write `/workspace/out/`.
  Safe because only produced files outside reserved paths are matched (B1).
- **Regex for `matches`** (spec SK15) while policy stays glob-only: ≤ 256 characters, compiled with
  `u`, flags `i m s`, evaluated by the runner with a 100 ms limit on the first 64 Ki characters.
- **Retries:** an execution reports its final attempt; `totalCostUsd` includes the retry.
- **`yaml` moved to `@kobe/protocol` dependencies** so lint and the runner share one parser with
  positions; only the `@kobe/protocol/skill-evals` subpath loads it. ISC, already shipped by server,
  web and the sandbox image; licences regenerated, `license:check` green.
- **Limits** (coordinator): 25 cases and 10 minutes are ceilings a Site may lower, never raise.

## Departures

- `provenance.json` `scorecard` is now `CatalogSkillEvalScorecard` (precision/recall optional with
  counts, status counts, lift reason, judge source, run-model fallback, `mode: full` only). Nothing
  writes provenance yet (Phase C); fixtures updated.
- SK16 runs every case but negative ones both ways; trigger-only positive cases get no baseline
  either (it would pass vacuously).
- `.prettierignore` lists the one deliberately invalid YAML fixture.

## Open questions (for review)

- Event transport for `skill.eval.*` (left to 325).

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
- Review fixes: `outputs.test.ts`, `judge.test.ts`, `scorecard.test.ts` (forged fixtures,
  errored baseline, SK20), `cases.test.ts` (tags, depth, `__proto__`, reserved globs, maxCases),
  `api.test.ts` (run ↔ scorecard).
- `@kobe/protocol`: test 900 passed, typecheck, lint, build; server and web typecheck;
  `license:check`, site wording, public hygiene ok.
