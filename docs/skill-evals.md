# Skill evals contract

The eval suite a skill package carries and the scorecard an eval run produces (KOBE-324; spec Kobe
v1.2 Skills System, SK15–SK18). The code is the contract: `packages/protocol/src/skill-evals/`
(`cases.ts` format and limits, `parse.ts` located issues, `plan.ts` executions, `scorecard.ts`
metrics, `api.ts` routes, events and settings). Golden fixtures:
`packages/protocol/src/skill-evals/fixtures/` (`cases/*.yaml` with `cases/issues.json`,
`scorecard/valid-full.json`). The runner (KOBE-325), judge and run model (KOBE-326), budgets
(KOBE-327) and the Workbench panel (KOBE-328) build on it.

## Where the suite lives

```text
evals/cases.yaml          the suite                    package only
evals/fixtures/**         files a case copies in       package only
```

`evals/**` is outside the runtime hash and the runtime zip ([skill-package.md](skill-package.md)):
no sandbox that loads the skill ever receives the suite or its fixtures, and editing them changes
the package hash only. Proofs: `skill-evals/api.test.ts` (the golden package's runtime zip holds
`SKILL.md` and `scripts/` only; the runtime hash ignores any suite edit), server
`skills/bundle-package.test.ts` and `skill-package-upload.db.test.ts` (uploads and saves store the
runtime zip), and the Workbench test chat, which builds its bundle through the same validation.

## evals/cases.yaml

Text rules as `kobe.skill.yaml`: UTF-8, at most 64 KiB, one YAML 1.2 (core schema) document whose
root is a mapping; duplicate keys and aliases are refused. **Unknown keys are refused at every
level**, so a check Kobe does not know is never skipped (skipping would pass a case silently).

```yaml
apiVersion: kobe.dev/skill-evals/v1 # optional; absent means v1
model: smart # optional catalog alias; the team default runs when the team hasn't enabled it
cases: # 1 to 25
  - id: q3-workbook # lowercase slug, unique in the suite
    prompt: "Build the Q3 revenue workbook from sales.csv"
    files: [fixtures/sales.csv] # optional; from evals/fixtures/, at most 20
    expect:
      triggers: true
      outputs: ["outputs/*.xlsx"]
      judge: "One sheet per region and a totals row on each sheet."
      max_cost_usd: 0.40
  - id: unrelated-question
    prompt: "What is the capital of France?"
    expect: { triggers: false }
```

| Key                      | Rule                                                                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `prompt`                 | 1–8000 characters; no control characters but tab and line breaks                                                             |
| `files`                  | `fixtures/<path>`, a valid package path below `evals/fixtures/` that exists in the package; copied to `/workspace/<path>`    |
| `expect.triggers`        | `true` / `false`: whether the skill was read (KOBE-297 detection); checked with the skill only                               |
| `expect.outputs`         | 1–10 globs (Kobe glob grammar, `*` crosses `/`) relative to `/workspace`; each matches a file the run produced               |
| `expect.contains`        | a text or 1–10 texts (≤ 500 characters each), all in the final answer, case-sensitive                                        |
| `expect.matches`         | a pattern or 1–10 of them; a pattern is a string or `{pattern, flags}` (flags from `i m s`; `u` always on), ≤ 256 characters |
| `expect.judge`           | a rubric of 1–2000 characters for the judge model (SK17)                                                                     |
| `expect.max_cost_usd`    | above 0, at most 50: the run's model spend for the case (judge excluded)                                                     |
| `expect.max_turns`       | 1–100, **default 20**; the runner ends the run there                                                                         |
| `expect.no_denied_tools` | `true`: the run never hit a policy denial                                                                                    |

A case needs `triggers` or a behaviour check (`outputs`, `contains`, `matches`, `judge`). Fixtures
and output globs stay out of `skills/` and hidden folders of `/workspace` (Kobe's and Pi's own
state). `contains` and `matches` read the first 64 Ki characters of the final answer; each pattern
gets at most 100 ms (the runner evaluates it off the event loop or under a VM timeout) and fails
its check as `match_timeout` otherwise, so an author's regular expression never stalls the server.
This is the one place a user writes a regular expression (the spec chose regex for `matches`);
policy patterns stay globs.

**Issues** (`parseSkillEvalSuite(text, {paths})`, the same in the browser and on the server): each
has `file` (`evals/cases.yaml`), a `code`, a `path` (`cases[2].expect.max_turns`, empty for the
file), a sentence `message` that names the place, and the 1-based `line`/`column` of the node (or
its nearest existing parent). Codes: `too_large`, `yaml_syntax`, `yaml_duplicate_key`,
`yaml_alias`, `not_a_mapping`, `missing`, `invalid_type`, `invalid_value`, `out_of_range`,
`unknown_key`, `duplicate`, `no_expectation`, `bad_pattern`, `fixture_missing`. Every problem is
reported at once, in file order. A single value written for a list (`contains: Total`) is reported
at the value, not as `[0]`.

**Versioning.** `apiVersion` is optional because skills written for other tools have none. A new
expectation is a contract change; a format older Kobe must refuse gets a new `apiVersion` (older
Kobe then refuses the file instead of skipping a check). The scorecard has its own `format: 1`.

## Executions

One execution is one case in one fresh, ephemeral sandbox (SK16), in auto mode (anything that would
ask is denied and recorded), as the author, under team policy, egress and budget.

| Case kind                                                | `full` run               | `with_only` run |
| -------------------------------------------------------- | ------------------------ | --------------- |
| negative trigger (`triggers: false`)                     | with the skill           | with the skill  |
| positive trigger (`triggers: true`, no behaviour check)  | with the skill           | with the skill  |
| behaviour (a behaviour check; `triggers: true` optional) | with, and with no skills | with the skill  |

"With" loads **only** this skill, "without" loads none (no Required or other skills, SK25). The
baseline makes every check but `triggers`. `planSkillEvalExecutions` gives the list; the estimate
(KOBE-327) multiplies its length. One automatic retry per failing execution; the execution reports
its final attempt, and `totalCostUsd` includes the retry.

## Scorecard

`computeSkillEvalScorecard` defines every number from the suite and the executions (it refuses a
set that is not exactly the plan):

- **Pass rate**: passed / with-skill executions, over every case. An execution passes when its run
  finished and every check passed; errors, timeouts (10 min), budget stops and cancellations fail.
- **Baseline pass rate**: passed / baseline executions (`full` only, else null).
- **Lift**: with-skill pass rate **over the baseline cases** minus the baseline pass rate, so both
  sides cover the same cases. Null without a baseline.
- **Trigger precision / recall**: over with-skill executions of cases that set `triggers` and
  observed a read or not (errors and cancellations observe nothing): TP / (TP + FP) and
  TP / (TP + FN), null when the denominator is 0.
- **Mean cost / duration** per mode: of final attempts (judge excluded); `costUsd` is all run spend
  including retries, `judgeCostUsd` the judge's. Micro-dollar and millisecond rounding.
- **Denied tool calls** per mode, and per execution.
- `runModel {requested, used, fellBack}` and each execution's `model` (SK17: a missing alias is
  reported, never silent); `judgeModel {alias, source: site|team}` or null without rubrics.
- `details[]`: per case, its kind and the with/without executions with checks (`detail` holds a
  judge reason or the glob that matched nothing), cost, duration, turns, denials, `threadId`,
  `runId`.

## What leaves the team

Eval threads are ordinary team threads (RLS, retention, legal hold, offboarding), and the scorecard
holds their ids and judge reasons: **it is team content**, served only in the team that ran it.
Progress and completion events carry ids, statuses and numbers only. The one export is
`scorecardForProvenance`: the numbers `provenance.json` carries at promotion (package hash, mode,
case counts, pass rates, lift, trigger precision and recall when defined, total cost including the
judge, `at`), with no case ids, prompts, answers, details, model names or thread ids (SK19).
Registry re-runs run in the Registry team (SK21).

## Limits and settings

| Limit                              | Value                                                                        |
| ---------------------------------- | ---------------------------------------------------------------------------- |
| Cases per suite                    | 25 (Site may lower: `site_skill_settings.eval_limits.maxCases`)              |
| Wall clock per case                | 10 min (Site may lower: `caseWallClockMinutes`)                              |
| Concurrent eval sandboxes per team | 4 by default, 1–16 (`maxConcurrentSandboxes`), inside the team ResourceQuota |
| Team eval cap (Team admin)         | none by default; monthly `{usd}` or `{tokens}` (`teamEvalCapSchema`)         |
| `run_usage` kinds                  | `eval`, `eval_judge`                                                         |

## API

In the caller's active team (`api.ts` has the shapes): `POST /v1/skills/drafts/{id}/evals` and
`POST /v1/skills/{scope}/{id}/versions/{seq}/evals` with `{mode}` → 202 `{evalRunId, estimate}`;
`GET /v1/skill-evals/{id}`; `GET /v1/skill-evals?draft_id=…` (history); `POST
/v1/skill-evals/{id}/cancel`. Events `skill.eval.progress` and `skill.eval.completed`; KOBE-325
picks their transport.
