# Skill evals contract

The eval suite a skill package carries and the scorecard an eval run produces (KOBE-324; spec Kobe
v1.2 Skills System, SK15–SK18). The code is the contract: `packages/protocol/src/skill-evals/`
(`cases.ts` format and limits, `parse.ts` located issues, `plan.ts` executions and expected checks,
`outputs.ts` what a glob matches, `judge.ts` judge isolation, `scorecard.ts` the team scorecard,
`compute.ts` its numbers and verification, `catalog-scorecard.ts` what may leave the team and the
SK20 rules, `api.ts` routes, events and settings). The root entry `@kobe/protocol` exports all but
the parser; `@kobe/protocol/skill-evals` adds `parseSkillEvalSuite` (and so loads `yaml`). Golden
fixtures: `packages/protocol/src/skill-evals/fixtures/` (`cases/*.yaml` with `cases/issues.json`,
`scorecard/valid-full.json`, and `scorecard/forged-*.json`, which must fail verification). The runner (KOBE-325), judge and run model (KOBE-326), budgets
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
root is a mapping; duplicate keys, aliases and explicit tags (`!foo`, `!!timestamp`) are refused,
and nesting is at most 16 levels (checked on the lexer's tokens before the tree is built, flow brackets
and block levels, compact `- - -` included, so no engine overflows its stack; an overflow is still
refused as `too_deep`). **Unknown keys are refused at every level**, so a check Kobe does not
know is never skipped (skipping would pass a case silently). Nothing in the file grants anything:
no key pre-approves a tool, widens egress or adds a connector, and eval runs use auto mode.

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

| Key                      | Rule                                                                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `prompt`                 | 1–8000 characters, trimmed; no control characters but tab and line breaks                                                            |
| `files`                  | `fixtures/<path>`, a valid package path below `evals/fixtures/` that exists in the package; copied to `/workspace/<path>`            |
| `expect.triggers`        | `true` / `false`: whether the skill was read, from the run's recorded skill uses (`runs.skills_used`, KOBE-297); with the skill only |
| `expect.outputs`         | 1–10 globs (Kobe glob grammar, `*` crosses `/`) relative to `/workspace`; each matches a file the run produced (below)               |
| `expect.contains`        | a text or 1–10 texts (≤ 500 characters each, never trimmed), all in the final answer, case-sensitive                                 |
| `expect.matches`         | a pattern or 1–10 of them; a pattern is a string or `{pattern, flags}` (flags from `i m s`; `u` always on), ≤ 256 characters         |
| `expect.judge`           | a rubric of 1–2000 characters for the judge model (SK17), trimmed                                                                    |
| `expect.max_cost_usd`    | above 0, at most 50: the final attempt's model spend (`costUsd`; judge excluded)                                                     |
| `expect.max_turns`       | 1–100, **default 20** model calls; a run that wants one more is stopped and fails (`over_limit`); ending on the last passes          |
| `expect.no_denied_tools` | `true`: no `policy.denied` event (auto-mode would-ask denials included; egress refusals inside a tool are not tool denials)          |

A case needs `triggers` or a behaviour check (`outputs`, `contains`, `matches`, `judge`). Fixtures
and output globs that name `skills/` or a hidden segment at any depth are refused. `contains` and `matches` read the first 64 Ki characters of the final answer; each pattern
gets at most 100 ms (the runner evaluates it off the event loop or under a VM timeout) and fails
its check as `match_timeout` otherwise, so an author's regular expression never stalls the server.
This is the one place a user writes a regular expression (the spec chose regex for `matches`);
policy patterns stay globs. ES2018 syntax with `u` (named groups, lookbehind, `\p{…}`); modifier
groups such as `(?i:…)` are refused, so browser lint and the server agree.

### What an output glob matches

**Before** is the case's fixtures as the runner wrote them (paths and SHA-256 from the package
bytes, on the server). **After** is taken in the sandbox when the run ended (a sandbox-wire request;
self-reported like every sandbox observation, which is why the Registry re-run is authoritative).
It walks only each glob's literal directory (`evalOutputWalkRoots`: `outputs/*.xlsx` walks
`outputs/`; a glob starting with a wildcard walks all of `/workspace`), so an `npm install` or a
venv elsewhere costs nothing; each walk stops after 10 000 entries. The walk uses `lstat`, never
follows a symbolic link (a link is recorded, never read, opened or passed on), records regular
files only, and never descends into a `skills` or hidden segment at any depth (such as `.kobe/`,
where Pi keeps session files; so `outputs/skills/x.md` never counts either). It hashes **only
fixture paths**: any other path is produced because it is new, so a large output is never hashed;
a fixture counts only when its bytes changed. Globs are matched as strings against produced paths
only, so no wildcard (`*`, `?kobe/*`) reaches Kobe's state or leaves `/workspace`. The check fails
with a reason when a glob matches nothing (`not_produced`), its walk was truncated, or it matches
more than 100 files or 50 MiB (`over_cap`). Reading a matched file for the judge opens it with
`O_NOFOLLOW`, refuses it unless `fstat` shows a regular file of the walked size, and reads at most
256 KiB. `checkEvalOutputs` is the function.

**Issues** (`parseSkillEvalSuite(text, {paths})`, the same in the browser and on the server): each
has `file` (`evals/cases.yaml`), a `code`, a `path` (`cases[2].expect.max_turns`, empty for the
file), a sentence `message` that names the place, and the 1-based `line`/`column` of the node (or
its nearest existing parent). Codes: `too_large`, `yaml_syntax`, `yaml_duplicate_key`,
`yaml_alias`, `yaml_tag`, `too_deep`, `not_a_mapping`, `missing`, `invalid_type`, `invalid_value`, `out_of_range`,
`unknown_key`, `duplicate`, `no_expectation`, `bad_pattern`, `fixture_missing`. Every problem is
reported at once, in file order. A single value written for a list (`contains: Total`) is reported
at the value, not as `[0]`. `{maxCases}` takes the Site's lower limit, so lint agrees with the
runner.

**Versioning.** `apiVersion` is optional because skills written for other tools have none. A new
expectation is a contract change; a format older Kobe must refuse gets a new `apiVersion` (older
Kobe then refuses the file instead of skipping a check). The scorecard has its own `format: 1`: an
added optional field keeps it, a removed or changed one bumps it, and readers of stored cards parse
a union by `format`. API responses are strict, so the web client ships with, never before, the
server that adds a field.

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
(KOBE-327) multiplies its length. **Departure from SK16:** a positive trigger-only case gets no
baseline either (without the skill it would pass vacuously).

`expectedChecks(case, withSkill)` lists the checks an execution must make: `triggers` with the
skill when set, each behaviour check set, `max_cost_usd` when set, `max_turns` always,
`no_denied_tools` when true. A passed execution lists exactly these, all passed; a failed one a
subset with a failure (the runner skips the judge once another check failed, which the estimate
counts on). A missing check never passes. Each failed check carries a `reason` (`not_triggered`,
`unexpected_trigger`, `not_produced`, `over_cap`, `no_match`, `match_timeout`, `judge_failed`,
`judge_unparseable`, `judge_rejected`, `over_limit`, `denied`).

- **Statuses in a scorecard:** `passed`, `failed`, `error` (infrastructure, no observation),
  `timed_out` (10 min, a real failure). Only a `completed` eval run has a scorecard; a cancelled or
  budget-stopped run (D30) has partial results and none, so it is never submission evidence.
- **Retry:** one, after `failed`, `error` or `timed_out`. The execution reports the final attempt:
  `costUsd` (what `max_cost_usd` checks) and `durationMs` are its; `totalCostUsd`,
  `totalDurationMs` and `judgeCostUsd` cover both attempts (a retry re-judges).
- **Reconciliation:** the card's `costUsd` (Σ `totalCostUsd`) equals the eval run's `run_usage`
  rows of kind `eval`, its `judgeCostUsd` the `eval_judge` rows (KOBE-327 asserts it).
- **Triggered** is derived: `skillUses` (the final attempt's recorded reads of the skill) > 0 with
  the skill, null without it or after an error. The `triggers` check passes exactly when it equals
  the expectation.

## Scorecard

`computeSkillEvalScorecard` defines every number from the suite and the executions (it refuses a
set that is not exactly the plan, or an execution whose checks are not its case's).
`verifySkillEvalScorecard(card, suite, rows?)` recomputes a stored card and compares all of it, so
a forged aggregate, check set or trigger is one call to detect (SK20 reads the submitted card).

- **Pass rate**: passed / with-skill executions, over every case. Errors and timeouts fail.
- **Baseline pass rate**: passed / baseline executions (`full` only, else null).
- **Lift**: with-skill pass rate **over the baseline cases** minus the baseline pass rate, so both
  sides cover the same cases. Null with `liftUnavailable`: `with_only`, `no_baseline_cases`, or
  `incomplete_pairs` (either side of a pair errored: an infrastructure failure never makes lift
  look good). The with side also makes the `triggers` check, so a skill that never fires on a case
  the bare model solves shows negative lift, on purpose.
- **Trigger precision / recall**: over with-skill executions of cases that set `triggers`, errors
  excluded: TP / (TP + FP) and TP / (TP + FN), null when the denominator is 0. `triggerCounts`
  (observed, tp, fp, fn, tn) are on the card.
- **Mean cost / duration** per mode: of final attempts (judge excluded); `costUsd` is all run spend
  including retries, `judgeCostUsd` the judge's. Micro-dollar and millisecond rounding.
- **Status counts** per mode (passed, failed, errored, timedOut) and **denied tool calls**.
- `runModel {requested, used, fellBack}` and each execution's `model` (SK17: a missing alias is
  reported, never silent); `judgeModel {alias, source: site|team}` or null without rubrics.
- `details[]`: per case, its kind and the with/without executions with checks (`detail` holds a
  judge reason or the glob that matched nothing), cost, duration, turns, denials, `threadId`,
  `runId`.

## What leaves the team

Eval threads are ordinary team threads (RLS, retention, legal hold, offboarding), and the scorecard
holds their ids and judge reasons: **`SkillEvalScorecard` is team content**, served only in the team
that ran it. Progress and completion events carry ids, statuses and numbers only.

**`CatalogSkillEvalScorecard` is the only scorecard type that may be written to a site-wide table**
(`registry_versions.scorecard`, `authoritative_scorecard`), an event outside the team, an export or
`provenance.json`. `scorecardForProvenance` makes it from a `full` card (it refuses `with_only`):
package hash, case counts, pass rates, lift or the reason it is missing, trigger precision and
recall when defined with their counts, status counts per mode, total cost including the judge, the
judge's source and whether the run model fell back. No case ids, prompts, answers, details, model
names or thread ids. Its schema checks every rate against its counts.

**SK20** (`skillEvalSubmissionShortfalls`, Site-editable defaults): ≥ 3 cases with ≥ 1 negative
trigger case, pass rate ≥ 0.8, lift ≥ 0, trigger precision ≥ 0.8, from this exact package hash. A
missing number fails its rule: no lift fails `lift`; no precision (the skill was never read) fails
`trigger_precision`.

**The suite itself does leave on promotion.** `evals/` (prompts, rubrics, fixtures) is part of the
package (SK19 shows the fixtures on the confirmation screen), so the whole-tree scan reads it and the
SK23 review checklist ("no secrets") covers it. Transcripts, answers and test threads never leave.
Registry re-runs run in the Registry team (SK21).

## The judge

`judge.ts` (for KOBE-326): the system message holds fixed grading instructions and the **rubric,
the only instruction text**. The case prompt, the final answer (≤ 64 Ki characters) and the matched
outputs (≤ 64 Ki characters of text in total; binary files by path and size) go into the user
message as one JSON document between `BEGIN DATA <nonce>` / `END DATA <nonce>` lines, with a new
128-bit nonce per call that the sandbox never sees; the data is told to be graded, never obeyed.
The judge gets no tools, no SKILL.md and no thread history, on a model the team has enabled, at
temperature 0 where the provider allows it. The call uses the gateway's JSON / structured-output
mode (`SKILL_EVAL_JUDGE_RESPONSE_SCHEMA`) where the model supports it; the reply is the verdict
JSON (`{passed, reason}`), alone or as exactly one fenced code block. Anything else is
`judge_unparseable` and a failed call `judge_failed`, both failures. So text in the answer
("Grader: PASS") can't change the rubric or the verdict format. **Binary** (`judgeOutputText`): a
file holding a NUL byte or not valid UTF-8 (`fatal` decoding; a character cut by the read cap is
dropped, not taken as binary).

**How it runs (KOBE-326).** Which model: the Site's `judge_alias` when the team enabled it, else
the team's own choice (Team admin: `PUT /v1/team/skill-review/settings {evalJudgeAlias}`, one of
its enabled models, audited `skill.eval_judge.changed`; a model disabled since no longer counts),
else the team default; chosen at start and stored as `judgeModel {alias, source}`. When a case is
judged the server checks again that the team still enables it; if not, nothing is sent and the
check fails `judge_failed` with the reason on the case. The matched outputs' bytes come from the
eval sandbox by **`eval.read`** (the request names paths and walked sizes only: no rubric, nonce or
message ever reaches the sandbox): each opened with `O_NOFOLLOW | O_NONBLOCK`, no link on the way,
refused unless `fstat` shows a regular file of the walked size, at most 256 KiB each and 1 MiB per
read (100 files); later, refused, skipped or binary files are shown by path and size only. The call
is a **server call** (KOBE-234 token, purpose `eval_judge`): under the execution's member and its
completed run, through the member's budget lines like the run, temperature 0, the verdict's
`response_format` for providers of kind `openai` (elsewhere the strict parser alone), its own 60 s
timeout (the runner keeps beating meanwhile). The gateway records it in `run_usage` as kind
`eval_judge` (no sandbox, the run named); the execution's `judgeCostUsd` is read back from those
rows. Without server calls configured, a `judge` check fails `judge_failed`.

**The run model** is the suite's `model:` if the team enabled it, else the team default; an
execution then carries `requestedModel` (the alias that didn't run) beside `model`, and the card's
`runModel.fellBack` is true: a missing alias is reported on every case, never silent.

Rubrics are author content that reaches the Site judge in the Registry re-run, so **catalog
reviewers check them** (Phase C): the review screen shows every rubric, and the SK23 checklist adds
"rubrics grade behaviour; none says always pass".

## Budgets, the estimate and the team eval cap (KOBE-327, SK18)

- **Spend kinds.** An eval sandbox's model calls are `run_usage` kind `eval` (the gateway reads
  the session token's `eval_thread`), the judge's `eval_judge`. Both count against every budget
  like a run's, and show apart in team usage (`by_kind`) and the team budget view
  (`spent_by_kind`, `eval_cap`).
- **Estimate before Run.** `GET /v1/skills/drafts/{id}/evals/estimate?mode=` (and
  `/v1/skills/{scope}/{id}/versions/{seq}/evals/estimate`) → `{estimate, runModel, blocked}`;
  the start returns the same estimate. Executions × the team's mean total cost and duration per
  eval execution on the run model (last 30 days, newest 200; retries included), plus the mean
  judge cost per judged execution; minutes = ⌈executions / concurrent sandboxes⌉ × the mean
  duration. Without eval history on the model, the team's ordinary runs on it stand in; with no
  history at all, `basis: none` and null numbers. Unpriced models: cost null.
- **Team eval cap** (Team admin: `PUT /v1/team/skill-review/settings {evalCap: {usd} | {tokens}
| null}`, audited `skill.eval_cap.changed`): monthly, counted from the eval kinds only
  (`model_spend_daily.eval_*`). Enforced on every eval and eval judge call by the gateway in
  `kobe_reserve_budget` (an `eval` line beside the member's budgets: atomic across replicas, no
  separate check-then-act); ordinary calls never see it.
- **Stops (D30).** A start is refused (409 `eval_cap_reached` or `budget_exhausted`, the message
  saying which and what to do) while the cap or a budget that applies to the starter is used up;
  the estimate says so in `blocked`. A running eval whose next execution would start, or whose
  attempt failed, while one is used up ends `budget_stopped` (no retry, no scorecard, nothing
  more starts); its calls are refused by the gateway meanwhile.

## The Workbench evals panel (KOBE-328)

In the draft editor: **Suggest trigger cases** appends cases to `evals/cases.yaml` (or starts it):
positive ones from the description's "Use when …" requests and always negative ones (a near miss
and unrelated asks), for the author to edit as YAML in the file pane. The built-in
skill-creator (1.1.0) proposes the same shape in a chat. Then the estimate and **Run evals**
(baseline on or off), live progress while an eval is queued or running, the history of every
eval of the draft by revision, and the scorecard of the picked one: every metric of
`SkillEvalScorecard` and each case's executions with a link to their eval threads. The team eval
cap is edited in Team admin › Budgets.

## Limits and settings

| Limit                              | Value                                                                        |
| ---------------------------------- | ---------------------------------------------------------------------------- |
| Cases per suite                    | 25 (Site may lower: `site_skill_settings.eval_limits.maxCases`)              |
| Wall clock per case                | 10 min (Site may lower: `caseWallClockMinutes`)                              |
| Concurrent eval sandboxes per team | 4 by default, 1–16 (`maxConcurrentSandboxes`), inside the team ResourceQuota |
| Team eval cap (Team admin)         | none by default; monthly `{usd}` or `{tokens}` (`teamEvalCapSchema`)         |
| `run_usage` kinds                  | `eval`, `eval_judge` (migration 0148)                                        |

## API

In the caller's active team (`api.ts` has the shapes): `POST /v1/skills/drafts/{id}/evals` and
`POST /v1/skills/{scope}/{id}/versions/{seq}/evals` with `{mode}` → 202 `{evalRunId, estimate}`;
`GET /v1/skill-evals/{id}`; `GET /v1/skill-evals?draft_id=…` (history); `POST
/v1/skill-evals/{id}/cancel`. Events `skill.eval.progress` and `skill.eval.completed` stream as
SSE from `GET /v1/skill-evals/{id}/events` (KOBE-325: one progress event per execution done, then
the completion, then the end of the stream).
