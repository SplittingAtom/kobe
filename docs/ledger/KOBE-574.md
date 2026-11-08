# KOBE-574: Composer: Reasoning effort control polish (visible selected pill, centred text on the line below, no bar/readout)

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (PR with KOBE-575, branch `kobe-574-575-composer-polish`)
- **Branch / worktree:** `kobe-574-575-composer-polish` in `../Kobe-wt574`
- **Depends on:** KOBE-556 (the vendored control), KOBE-557 (data stays), KOBE-450 (line below)

## Plan

1. Pressed pill `bg-foreground text-background` (was `bg-background text-foreground shadow-xs`).
2. Centre the pill text in both sizes; row heights unchanged.
3. Remove the spend bar and readout: render path, `spent`/`budget`/`estimated`, ThinkingPicker
   `spend`, `use-reasoning-spend.ts` + test, model-picker wiring and readout-only tests.

## Decisions

- **Cause of the off-centre text:** the chat's unlayered-zero-specificity button rule
  (`app/chat-global.css`, buttons without `data-slot`) gives the pills `padding: 0.25rem` and
  `line-height: 1.25rem`. In the compact pill (`h-5`, border-box) that leaves a 12px content box
  under a 20px line box, so the text sat 3-4px low. Fix: `inline-flex items-center
justify-center` with a line box as tall as the pill (`h-6 leading-6`, `h-5 leading-5`), not
  `leading-none` (measured 0.6-1.6px off with the 11.2px compact size, see Evidence). The leading
  sits after the size in the class list: tailwind-merge drops a line height before a font size.
- `thinkingControl()` (thinking-picker.tsx) existed only for the readout: removed with it.
- The inventory row (`assistant-ui-reasoning-effort`) and the MIT notice stay unchanged (the row's
  component text still says "range helpers"; left as is so THIRD_PARTY_LICENSES.md needs no
  regeneration); the file's header comment says the bar, readout and helpers were removed.
- `thinking.spec.ts` had no progressbar assertion on main; it now asserts the line below has none.

## Open questions (for Chris or the coordinator)

- None. Coordinator: check the pills on gate1 in light and dark, toolbar and line below (ac-4).

## Evidence (acceptance criteria → test or command output)

- ac-1: `thinking-effort.test.tsx` "the pressed pill is the inverted foreground fill" (classes
  `bg-foreground text-background`, forced-colours outline class kept, unpressed pill transparent
  with the unchanged hover). Headless Chromium (harness below): pressed pill light
  bg oklch(0.145)/text oklch(1), dark bg oklch(0.985)/text oklch(0.145) (the page's own
  foreground/background, so every preset inverts the same way); forced colours: pressed outline
  `solid`. Theme-css guard: `pnpm verify`.
- ac-2: `thinking-effort.test.tsx` "centres the pill text vertically in both sizes". Headless
  Chromium harness (the real component rendered with react-dom/server inside `[data-kobe-chat]`
  with the compiled `app/chat-global.css` + `app/theme.css`; cap box vs pill, DPR 2):

  | font          | row     | track | pill | before: cap top / below baseline | after |
  | ------------- | ------- | ----- | ---- | -------------------------------- | ----- |
  | default stack | toolbar | 28    | 24   | 7 / 8                            | 7 / 8 |
  | default stack | compact | 24    | 20   | 9 / 3 (3px low)                  | 5 / 7 |
  | Outfit        | toolbar | 28    | 24   | 7 / 8                            | 7 / 8 |
  | Outfit        | compact | 24    | 20   | 10 / 2 (4px low)                 | 6 / 6 |

  Track heights unchanged (toolbar 1.75rem, compact 1.5rem). Harness script, output and light/dark
  screenshots: the agent's scratchpad of the 2026-11-08 run (`pills/final.cjs`, `final.txt`,
  `pills-light.png`, `pills-dark.png`; path in the agent's report to the coordinator).

- ac-3: no `progressbar` in `thinking-effort.test.tsx`, `model-picker.test.tsx` (KOBE-574 case:
  thread usage with reasoning tokens present, no bar or numbers in the control), e2e
  `thinking.spec.ts`; `use-reasoning-spend.ts`/test deleted; `docs/design/thinking-controls.md`
  "In the composer" and "Budgets and reasoning spend" updated. No server, protocol or API change.
- ac-4: `pnpm verify` and PR CI: see the PR.
