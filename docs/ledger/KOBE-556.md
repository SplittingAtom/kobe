# KOBE-556: Composer: replace the Thinking <select> with assistant-ui's Reasoning effort segmented control

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (PR #470)
- **Branch / worktree:** `kobe-556-reasoning-effort` in `../Kobe-wt556`
- **Depends on:** KOBE-260 (thinking levels), KOBE-418 (toolbar fold), KOBE-450 (line below);
  readout wiring on KOBE-557 (built in parallel)

## Plan

1. Vendor assistant-ui's `reasoning-effort.tsx` (main @ 208cc81de222) as
   `apps/web/components/chat/thinking-effort.tsx`: MIT notice kept, `field` surface and the
   `pct`/`announced` range helpers inlined, restyled with Kobe tokens.
2. `ThinkingPicker` (thinking-picker.tsx) renders it: pills = the team's allowed levels, storage
   and clamping (`shownThinking`) unchanged.
3. Readout and bar behind `use-reasoning-spend.ts`, hidden until KOBE-557's fields arrive.
4. Inventory row (new "Vendored source" section), `pnpm licenses:update`, docs.

## Decisions

- **Labels** Off/Low/Medium/High (`EFFORT_LABELS`); the /thinking menu and Session info keep
  `THINKING_LABELS` ("Thinking low (default)"), which read alone there.
- **Default pill** = the policy default level, hinted "Model's default" (tooltip and, review #4,
  an sr-only `aria-describedby` text, so touch and screen readers get it); clicking it stores null.
  A stored choice equal to the default shows that pill pressed; clicking it again stores null.
  **Trade-off for Chris:** a member can no longer pin the default level explicitly (the select's
  separate "Thinking low" vs "Thinking low (default)" is gone): picking that pill always follows
  the team's default, so a later change of the default moves the conversation with it.
  With no policy default (not reachable while levels exist: the policy requires one) no pill is
  pressed until the member picks.
- **Readout** describes the latest run, the pills the next one (review #1): spend of the thread's
  latest run against the budget of the level _that run_ ran with (`RunUsage.thinkingLevel`). The
  latest run is the one of the newest call (`latestCall.runId`/`at`, the only timestamp in the
  read; `runs` is ordered by first call); while the run streamed in this tab is not that run, nothing
  shows (review #2). Shown only with both known and `budget > 0`; ≈ for an estimate, and
  `aria-valuetext` says "about … (estimated)". Numbers via `formatTokens` ("12k / 24.6k").
- **Layout**: the group is `inline-flex flex-col`; pills in a `rounded-full` bordered track
  (`field` surface plus a real border, so forced colours keep it); under it one line: the 3px bar
  (flex-1) and the readout (10px mono). The readout never sits beside the pills (review #5), so the
  control's width is the track's. Toolbar pills `h-6 text-xs` in a 1.75rem track (the select's height); compact
  `h-5 text-[0.7rem]` in 1.5rem. The track never shrinks; the model select shrinks first.
- **No preflight in the chat**: pills reset the browser button border/fill/font explicitly.
- **Forced colours**: track border is a real border; the pressed pill gets an outline; the bar
  keeps assistant-ui's `forced-colors:outline` and `forced-color-adjust-none` fill.
- No chat CSS-module rule changed (only Tailwind utilities), so the chat CSS snapshot is unchanged.
- `FOLD_SELECTORS_BELOW_PX` stays 640 (measured below).

## Readout wiring (KOBE-557)

Wired after rebasing on main 136de5cf (KOBE-557 PR #471). `use-reasoning-spend.ts` reads the
latest run of `GET /v1/threads/{id}/usage` (the existing `ThreadUsageProvider` read):
`reasoningTokens ?? null`, `reasoningEstimated ?? false`, `thinkingLevel`; the budget is
`thinkingBudget(control, run's level)` from @kobe/protocol, the control being the conversation's
model's `thinking_in_team.control` (`thinkingControl` in thinking-picker.tsx; the run's gateway
model name can't be mapped back to an alias, so a model changed since the run grades with the
current model's control). Hidden while the control is unknown (older server), `none`, or the
budget is 0 (Off).

## Open questions (for Chris or the coordinator)

- After a model change, the latest run is graded with the new model's control (see above).

## Evidence (acceptance criteria → test or command output)

- ac-1: `components/chat/thinking-effort.test.tsx` (pills, aria-pressed, group label, title,
  Enter/Space, disabled, compact) and `thinking-picker.test.tsx` (level sets, default vs chosen,
  null on choosing the default, disabled, clamping).
- ac-2: `model-picker.test.tsx` (saved per thread via PATCH, back to null, new-conversation draft
  sent on POST, lowered level shown as Medium), `composer-selectors.test.tsx` (toolbar, folded
  menu row, compact below, Tab order through the pills); e2e `thinking.spec.ts` updated to pills.
- ac-3: `thinking-effort.test.tsx` (hidden without spend or budget, with budget 0; values render
  "2,000 / 8,000", 25% `bg-brand-primary` fill; estimate ≈ and aria-valuetext);
  `use-reasoning-spend.test.ts` (newest call's run, live run without usage, budgets per control,
  estimate, hidden without control); `model-picker.test.tsx` KOBE-557 cases (readout from the fake
  thread usage graded at the run's medium while the pills ask for low; none on an older server).
- ac-4: headless Chromium harness (compiled `app/tailwind.css` + theme; toolbar replicas at 616,
  680 and 736px, i.e. composer 640-760, with a long agent chip, a long model name, 4 or 2 pills,
  with and without the worst readout "≈12k / 24.6k"): no overflow and Send inside the line in all
  12; the control is 179px (4 levels; the old select up to 192px) or 103px either way; with the
  readout the toolbar line grows 34 → 40px (the bar line), never wider. Folded menu and compact
  line fit. `FOLD_SELECTORS_BELOW_PX` stays 640. Theme-css guard green.
- ac-5: MIT notice in `thinking-effort.tsx`; `tools/license-check/inventory.yaml` row
  `assistant-ui-reasoning-effort`; `THIRD_PARTY_LICENSES.md` regenerated;
  `docs/design/thinking-controls.md` "In the composer".
- ac-6: `pnpm verify` and PR CI: see the PR.
