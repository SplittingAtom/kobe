# KOBE-327: B8: Eval budgets, estimate and team eval cap

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (group branch `group-skills-b`, one PR for Phase B)
- **Branch / worktree:** `group-skills-b` in `../Kobe-skB`
- **Depends on:** KOBE-325, KOBE-326 (the `eval` / `eval_judge` kinds and their CHECKs, 0148)

## Handoff (for the reviewer and KOBE-328)

- **Migrations:** 0149 (generated: `model_spend_daily.eval_cost_usd` / `eval_tokens`,
  `budget_reservations.eval`, `team_skill_settings.eval_cap_usd` / `eval_cap_tokens` with a CHECK;
  constant defaults, no rewrite) and 0150 (custom: `kobe_count_model_spend` also sums kinds
  `eval` / `eval_judge`; `kobe_reserve_budget` judges a line of scope `eval`). Upgrade test
  `packages/db/src/eval-cap-upgrade.db.test.ts`; function test `budget-reservations-eval.db.test.ts`.
- **Where things are:** server `skills/evals/estimate.ts`, `budget.ts`, `start.ts`
  (`estimateSkillEval`, refusals), `runner.ts` (`#stopIfBudget`), `store.ts`
  (`budgetStopEvalRun`), `skills/settings.ts` (eval cap), `budgets/store.ts` (view),
  `routes/skill-evals.ts` (estimate routes); db `models/budgets.ts` (`evalLines`,
  `loadEvalCapLines`); gateway `gateway.ts` (eval sandbox → `eval`), `budget-gate.ts` (`linesFor`),
  `usage/sink.ts`; web `components/skills/eval-run.tsx`, `lib/skills/evals-api.ts`,
  `components/admin/team/budgets-page.tsx`.
- **For 328:** `EvalRun` is a minimal estimate + Run block in the draft editor; the Workbench
  panel can absorb it (history, progress, scorecard).

## Decisions

- **Kinds (ac-1):** the gateway marks a call `eval` when the session token names an
  `eval_thread` (only the server mints those, for eval sandboxes). Eval runs' readers (runner
  cost and turns, per-run and thread usage, context gauge) read `kind IN ('run', 'eval')`, so a
  rollout with an old gateway (still `run`) counts the same. Team usage `by_kind` already groups;
  the team budget view adds `spent_by_kind` (this month, from the ledger) and `eval_cap` (cap and
  eval spend, from the counters).
- **Cap enforcement (ac-3):** a spend cap, separate from 325's concurrency and queue bounds. It
  reuses the reservation path: the gateway sends the cap as an extra line (scope `eval`, month)
  on every eval sandbox and eval judge call; `kobe_reserve_budget` judges it under the team lock
  on `model_spend_daily.eval_*` plus the live `eval` reservations, with the member share like a
  team line. No new check-then-act. Gateways' cached budget state is hinted on a cap change
  (`budgets:<team>`). The budget monitor ignores eval lines (it never stops ordinary runs for the
  cap).
- **Refusal and stop (ac-3, ac-4):** a start is refused 409 `eval_cap_reached` /
  `budget_exhausted` with a message naming the line, the amounts and the way out; the estimate
  returns the same as `blocked`. The runner checks before each execution and after a failed
  attempt: a used-up cap or budget ends the eval `budget_stopped` (`failure` set, no retry, no
  scorecard; queued executions never start). A run the budget monitor stops (D30, 100 %) ends
  the eval the same way.
- **ac-4 interpretation:** "budget soft limits respected" read as D30 for evals: the 100 % stop
  ends evals like runs (above) and refuses new ones; the 80 % warning stays the member banner.
  KOBE-360 isn't in Hadron (404), so this is a guess: see open questions.
- **Estimate (ac-2):** executions × the team's mean per-execution total cost and duration on the
  run model (30 days, newest 200 non-error executions, retries included) + mean judge cost per
  judged execution; minutes from waves of `maxConcurrentSandboxes`. Without eval history on the
  model: the team's completed ordinary runs on it (cost and duration per run) and the mean
  `eval_judge` call. Nothing: `basis: none`. Returned on start too (from history before the run).
- **Settings:** the cap lives in the team skill settings (Team admin, `team.skills.review`), one
  transaction with the other switches, audited `skill.eval_cap.changed`.
- **No backfill** of `eval_*` counters: the eval kinds are new in this release (0148).

## How ac-2's ±50 % is verified

1. **Recorded reference usage (CI):** `services/server/src/skill-eval-budget.db.test.ts` runs the
   reference suite (5 cases: 3 behaviour with baselines, one judged, two trigger cases; 8
   executions in `full`) twice through the real runner, with each run's model calls recorded as
   kind `eval` from two recordings of per-case token counts (`REFERENCE_USAGE`), priced at the
   catalog's $2 / $10 per Mtok, and judge calls as `eval_judge`. The estimate taken before the
   second run must be within ±50 % of its actual cost (`scorecard.costUsd + judgeCostUsd`).
2. **gate1 (after deploy):** in Team1, run the same reference suite (a draft with this
   `evals/cases.yaml`) once in `full` to seed history, read
   `GET /v1/skills/drafts/{id}/evals/estimate?mode=full`, run it again, and compare the estimate
   with the second run's `scorecard.costUsd + judgeCostUsd` and its wall time; record both in
   this ledger. Pass: cost within ±50 %. (Ollama Cloud models need catalog prices for a dollar
   estimate; without them the check uses tokens from `/v1/team/usage` by kind.)

## Open questions (for the reviewer / coordinator)

- ac-4 / KOBE-360: is "soft limit" the 80 % warning (show it before Run?) or something else, such
  as skipping the eval judge at 80 % like follow-ups? Today: 100 % stop only, and the judge is
  skipped only at 100 %.
- The cap is set through the skill settings API; the team budgets page shows it read-only. A
  form for it belongs with the team skill settings UI (none yet).

## Evidence (acceptance criteria → test or command output)

- **ac-1** `skill-eval-budget.db.test.ts` ac-1 test (ledger kinds `eval`, `eval_judge` for the
  eval's runs; card costs equal the ledger; `/v1/team/usage` `by_kind`; `/v1/team/budgets`
  `spent_by_kind` and `eval_cap`); gateway `gateway.test.ts` (eval token → kind `eval`),
  `usage.db.test.ts` (db, kind shapes).
- **ac-2** same test (estimate before Run within ±50 %; `basis: none` with no history; the start
  returns the same estimate); web `eval-run.test.tsx` (shown before Run, follows the mode).
- **ac-3** `skill-eval-budget.db.test.ts` ac-3 test (PUT cap, audited; running eval ends
  `budget_stopped` `eval_cap_reached` with fewer executions; new start 409 with the exact message;
  estimate `blocked`; tokens cap; invalid cap 400); `budget-reservations-eval.db.test.ts` (atomic
  in the function); gateway `budget-gate.test.ts` (eval and judge calls stopped, others not;
  reservations hold); web `eval-run.test.tsx` (refusal shown instead of Run).
- **ac-4** `skill-eval-budget.db.test.ts` ac-4 test (team budget used up mid-eval →
  `budget_stopped` `budget_exhausted`; new start refused).
- Commands (2026-10-18): `pnpm typecheck`, `pnpm lint`, prettier green; unit tests protocol 915,
  db 580, server 2041, model-gateway 180, web 1913, sandbox-agent 848 (one unrelated
  `pi/identities.test.ts` timing flake under load, green alone); DB: `@kobe/db` 66 files / 1459,
  model-gateway 6 files / 20, server eval, budget, usage, runs, approvals, titles, follow-ups,
  settings and review files (18 files) green.
