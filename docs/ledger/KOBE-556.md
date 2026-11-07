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
- **Default pill** = the policy default level, titled "Model's default"; clicking it stores null.
  A stored choice equal to the default shows that pill pressed; clicking it again stores null.
  With no policy default (not reachable while levels exist: the policy requires one) no pill is
  pressed until the member picks.
- **Readout** is shown only with both `spent` and `budget` known and `budget > 0` (Off has budget
  0: nothing to fill). An estimate prefixes ≈ and the bar's `aria-valuetext` says "about … (estimated)".
  The readout text is `aria-hidden`; the progressbar carries it for screen readers.
- **Layout**: the group is `inline-flex flex-col`; pills in a `rounded-full` bordered track
  (`field` surface plus a real border, so forced colours keep it), readout to its right, the 3px
  bar under it. Toolbar pills `h-6 text-xs` in a 1.75rem track (the select's height); compact
  `h-5 text-[0.7rem]` in 1.5rem. The track never shrinks; the model select shrinks first.
- **No preflight in the chat**: pills reset the browser button border/fill/font explicitly.
- **Forced colours**: track border is a real border; the pressed pill gets an outline; the bar
  keeps assistant-ui's `forced-colors:outline` and `forced-color-adjust-none` fill.
- No chat CSS-module rule changed (only Tailwind utilities), so the chat CSS snapshot is unchanged.
- `FOLD_SELECTORS_BELOW_PX` stays 640 (measured below).

## Readout wiring (KOBE-557)

`use-reasoning-spend.ts` reads the latest run of `GET /v1/threads/{id}/usage` (the existing
`ThreadUsageProvider` read) for `reasoningTokens` / `reasoningEstimated` and the shown level's
budget. KOBE-557's exports were not on main when this was built: the hook carries a local type and
a local `THINKING_EFFORT_BUDGETS` under the agreed names with a `TODO(KOBE-557)`; swap in the
protocol imports (and `thinkingBudget(control, level)` once team models carry the control) after
rebasing on 557.

## Open questions (for Chris or the coordinator)

- `thinkingBudget(control, level)` needs the model's control, which `/v1/team/models` does not
  expose to the web today; until it does the hook uses the effort table for every model.

## Evidence (acceptance criteria → test or command output)

- ac-1: `components/chat/thinking-effort.test.tsx` (pills, aria-pressed, group label, title,
  Enter/Space, disabled, compact) and `thinking-picker.test.tsx` (level sets, default vs chosen,
  null on choosing the default, disabled, clamping).
- ac-2: `model-picker.test.tsx` (saved per thread via PATCH, back to null, new-conversation draft
  sent on POST, lowered level shown as Medium), `composer-selectors.test.tsx` (toolbar, folded
  menu row, compact below, Tab order through the pills); e2e `thinking.spec.ts` updated to pills.
- ac-3: `thinking-effort.test.tsx` (hidden without spend or budget, with budget 0; values render
  "2,000 / 8,000", 25% `bg-brand-primary` fill; estimate ≈ and aria-valuetext);
  `use-reasoning-spend.test.ts`.
- ac-4: headless Chromium harness (compiled `app/tailwind.css` + theme, a 616px toolbar replica
  with a long agent chip, a long model name and four pills): no overflow at the fold width; the
  pills take ~179px (the old select up to 192px), the model select shrinks to ~118px; with a
  readout ~274px and still no overflow; folded menu and compact line fit. Theme-css guard green.
- ac-5: MIT notice in `thinking-effort.tsx`; `tools/license-check/inventory.yaml` row
  `assistant-ui-reasoning-effort`; `THIRD_PARTY_LICENSES.md` regenerated;
  `docs/design/thinking-controls.md` "In the composer".
- ac-6: `pnpm verify` and PR CI: see the PR.
