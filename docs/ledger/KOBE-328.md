# KOBE-328: B9: Scorecard UI and case suggestions

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (group branch `group-skills-b`, one PR for Phase B)
- **Branch / worktree:** `group-skills-b` in `../Kobe-skB`
- **Depends on:** KOBE-325 (runner, history API), KOBE-321 (Workbench editor), KOBE-327 (estimate,
  cap)

## What shipped

- **Evals panel** (`apps/web/components/skills/evals-panel.tsx`) in the draft editor, below the test
  pane: Suggest trigger cases, the estimate and Run (`eval-run.tsx`), live progress (the history is
  read again every 2 s while an eval of the draft is queued or running), the history of every eval
  of the draft by revision (`GET /v1/skill-evals?draft_id=`), and the picked eval: its scorecard,
  its progress, or why it failed or stopped.
- **Scorecard** (`eval-scorecard.tsx`): pass rate, baseline pass rate, lift (or why none), trigger
  precision and recall with their counts, cost and judge cost, case counts, run model (with any
  fallback) and judge model; with/without summaries (pass rate, statuses, mean cost and duration,
  denials); per case each execution's status, retry, failed checks with reasons and details,
  model and any missing alias, cost, judge cost, duration, turns, denials, triggered, and a link to
  its eval thread (`/?thread=<id>`). Numbers are the stored card's, never recomputed.
- **Case suggestions** (`lib/skills/case-suggestions.ts`): positives from the description's "Use
  when …" requests (or the skill's name), always a near miss and unrelated asks as negatives
  (`triggers: false`), ids unique against existing cases; appended with `yaml` (comments kept), or a
  new file. The built-in **skill-creator 1.1.0** step 3 now writes `evals/cases.yaml` the same way,
  with at least one negative case (version bumped, hashes appended in `kobe-packages.test.ts`).
- **Team eval cap form** (`components/admin/team/eval-cap-form.tsx`) on Team admin › Budgets, beside
  "This month by kind": monthly dollars (whole cents, ≥ $0.01) or tokens, Save / Remove; shown with
  the `team.skills.review` permission (the settings route's), console buttons (shadcn outline look).

## Decisions

- **Form + YAML:** the suite is edited as YAML in the existing file pane; the form is the
  suggestion button (structured add). A field-by-field case form is left out to keep the PR small.
- **Progress by polling** the history (2 s, only while an eval is open) rather than the SSE stream:
  one request covers every eval of the draft and its scorecard.
- **History per version:** per draft revision in the Workbench, and **per saved version** on the
  team skill's view (Team admin › Skills › a skill: "Evals by version", `skill-eval-history.tsx`,
  `GET /v1/skill-evals?scope=team&skill_id=`): each version's evals newest first (status, mode,
  pass rate, baseline, lift, precision/recall, cost), each linking to its full scorecard
  (`/me/skills/evals/<id>`, `eval-run-page.tsx`). Personal skills have no version view yet.
- **Tables:** column headers are `TableHeader` (th) inside `TableHead` (thead), as elsewhere.

## Review-328 fixes (`review-328.md`) and coordinator decisions

- **Cap permission (decision 1):** the cap moved to `PUT /v1/team/budgets/eval-cap`
  (`team.budgets.manage`); the skill review settings refuse it (400). Today both permissions are
  Team admin, so a reviewer without budget rights can't exist yet; the route test checks a member
  gets 403 and the review route can't set it. The web form needs `team.budgets.manage`.
- **Live progress (decision 2):** `useLiveEval` follows `GET /v1/skill-evals/{id}/events`
  (`skill.eval.progress`, `skill.eval.completed`), falls back to polling on a stream error (paused
  while the tab is hidden, stopped after 5 failed reads), in the panel, the version history and
  the eval page.
- **Costs (coordinator):** `GET /v1/skill-evals/:id` and the history lists leave out every cost
  field unless the viewer started the eval or holds `team.budgets.manage` (`costsHidden`;
  `withoutSkillEvalCosts` in the protocol); the UI says who sees costs. Route test in
  `skill-eval-budget.db.test.ts`.
- **Double start:** the server refuses a second start of the same revision and mode while one is
  open (409 `eval_already_running`, before the scan and under the team lock); the client guards
  with a ref, and Run is disabled while an eval of the draft is open.
- M1 errors clear on the next good read; M2 a request sequence drops stale reads; M3 the cap form
  is keyed by the cap; M4 one "Evals" heading and region. L1 regions with names; L2 captions on
  the scorecard tables; L3 `next/link` with a per-case name; L4 statuses and check reasons in
  words (`lib/skills/eval-format.ts`, shared); L5 as above; L6 `aria-pressed` and a named Show; a
  vanished pick falls back; L7 the stream.

## Open questions (for the reviewer / coordinator)

- Personal skills have no version view to put their eval history on; add one?

## Evidence (acceptance criteria → test or command output)

- **ac-1** `apps/web/components/skills/evals-panel.test.tsx` "the scorecard": every metric label,
  values from the golden `valid-full.json`, both modes, every case, one link per execution with a
  thread; lift reason and run-model fallback.
- **ac-2** `apps/web/lib/skills/case-suggestions.test.ts` (≥ 1 negative with and without requests
  in the description; ids unique; appended suite parses with `parseSkillEvalSuite`); panel test
  "suggests cases …" (writes `triggers: false` and `triggers: true`); server
  `skills/kobe-packages.test.ts` (skill-creator asks for a negative case, with examples).
- **ac-3** panel test "lists the draft's evals by revision, shows live progress and the picked
  scorecard"; "shows why a budget-stopped eval ended".
- **ac-3 (saved versions)** `apps/web/components/skills/skill-eval-history.test.tsx` (grouped by
  version newest first, links to each scorecard, drafts left out, empty state, on the team skill's
  view; the scorecard page and a stopped eval).
- **Cap form** `apps/web/components/admin/budgets-pages.test.tsx` "team eval cap" (spend by kind,
  sub-cent refused, tokens saved, removal; hidden without the permission).
- Commands: see the final report (typecheck, lint, web 1925, server unit, built-in DB tests).
