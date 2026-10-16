# KOBE-285: Playwright browser suite for the v1.1 Phase A/B surfaces, run against a deployment

- **Status:** committed on `group-1-fixes` (ticket group G1; no PR of its own). Not in CI.
- **Branch / worktree:** `group-1-fixes` in `../Kobe-g1`
- **Depends on:** KOBE-205 (scroll), KOBE-206 (steering), KOBE-209 (markers), KOBE-211 (gauge),
  KOBE-213 (compact now), KOBE-214 (root edit), KOBE-216 (fork), KOBE-217 (regenerate with),
  KOBE-282 (theme toggle)

## Plan

`e2e/browser/`: a self-contained Playwright project (`@playwright/test` 1.55.0, the version of
the runner's `mcr.microsoft.com/playwright:v1.55.0-noble` image). `playwright.config.ts` takes
`baseURL` from `KOBE_BASE_URL`; a `setup` project signs in once with `KOBE_USER`/`KOBE_PW` and
saves the session to `.auth/user.json` (gitignored) for the `chromium` project. One spec per
surface, each grounded in the coordinator's ad-hoc gate1 checks of the same name:

| Spec                      | What it proves                                                                                                                                                                                                                                                                |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scroll-follow.spec.ts`   | List scrolls on its own, composer outside it and in view, page never scrolls; `data-kobe-follow` pinned while streaming; wheel up unpins and holds; Jump to latest re-pins; 390 px.                                                                                           |
| `steering-panel.spec.ts`  | Idle panel has no height; active while running; two queued chips; Home on the grip reorders; Pause/Resume; delete both; Stop folds the panel, nothing queued ran.                                                                                                             |
| `context-gauge.spec.ts`   | No gauge before the first call; after it the meter's value equals the usage read's `latest_call` (input + cache read + cache write, capped); tooltip repeats the value text.                                                                                                  |
| `compact-now.spec.ts`     | Short turn, then a ~30k-token turn; Compact now (with a focus) closes the dialog, adds the "Context compacted" marker with its summary, hides the gauge; an immediate retry refuses.                                                                                          |
| `root-edit.spec.ts`       | Editing the first message gives "Version 2 of 2" and a BETA answer; survives a reload; Previous version shows ALPHA.                                                                                                                                                          |
| `regenerate-with.spec.ts` | Regenerate with… lists models; choosing another adds a "Model changed to" marker and version 2 of 2, both after a reload. Skips when the team has one model.                                                                                                                  |
| `fork.spec.ts`            | Fork to a new thread with a title opens another thread with the "Fork origin" note linking the source, the copied messages, and the title in the rail.                                                                                                                        |
| `theme.spec.ts`           | OS light, nothing saved: Regenerate with… menu, Compact and Fork dialogs (and input), notifications panel paint light, tooltip readable; toggle → dark (cookie), the same popups paint dark; reload serves `<html data-theme="dark">`; the admin header toggle flips it back. |

Arrival fade and the history/detail toggle (the other two ad-hoc checks) were not in the ticket's
list and are left out.

## Decisions

- **Standalone, not a workspace package.** `pnpm-workspace.yaml` globs don't cover `e2e/*`, so
  the suite has its own `package.json` and npm `package-lock.json`, stays out of the root
  `pnpm-lock.yaml`, and nothing in turbo, `pnpm verify` or any workflow runs it (CI can't start it
  by accident). Joining the workspace would have put a Playwright download into every CI install
  and made `turbo test`/`typecheck` pick it up. The cost: `pnpm license:check` doesn't scan it;
  its tree is `@playwright/test`, `playwright`, `playwright-core` (Apache-2.0), `fsevents`
  (optional, MIT), `typescript` (Apache-2.0), `@types/node` and `undici-types` (MIT). Root
  prettier still formats it. `npm run typecheck` in the folder checks the specs.
- **Selectors:** roles and accessible names (IconAction labels from `lib/shell/commands.ts`),
  labels, and `data-kobe-*`/`data-role`/`data-thread-actions`/`data-compact-dialog` attributes;
  no CSS classes. Exceptions: `[data-slot="tooltip-content"]` (the tooltip has no stable role)
  and the `Conversation actions` `<summary>`, found by its label because its role varies.
- **Run completion** (`Chat.waitForIdle`): steering panel `data-state="idle"`, no answer with
  `aria-busy="true"`, no "Sent, waiting for the agent" — checked twice 1.5 s apart.
- **Popups in a theme:** background luminance (through a canvas, so oklch reads as sRGB) above or
  below 0.5 and text contrast above 0.3. Tooltips are inverted on purpose: checked for contrast,
  and their background must change between themes.
- **Clean-up:** the `chat` fixture moves every thread a test opened to Trash with
  `DELETE /v1/threads/{id}` through the page's own session (the rail's "Move … to Trash" button
  can't tell same-titled test threads apart).
- **Model use:** one worker by default (`KOBE_WORKERS`), no retries, short "No tools. Reply with
  the single word X." prompts; the long ones (scroll, steering) are stopped once checked.

## Findings on gate1 (main as of 2026-10-15; not fixed here)

- **Phantom pending message after a very long send.** After the ~30k-token turn finished
  (footer "40.4k input · 33 output tokens · 1 model call"), the user message showed "Forked
  here · 2 branches", "Version 1 of 2" and "Sent, waiting for the agent" with no answer: the
  optimistic copy apparently didn't reconcile with the stored entry. A reload shows the thread
  correctly. Seen once in two runs; `compact-now.spec.ts` reloads after that turn.
- **"Sent, waiting for the agent" after Stop.** When Stop lands before the first answer text, the
  user message keeps "Sent, waiting for the agent" while the footer says "Stopped.". So the suite
  no longer treats that text as a run-in-progress signal.
- **Wheel-up around a run's end didn't unpin once** (scroll spec, run 2: `data-kobe-follow`
  stayed `pinned` after five wheel steps up; the answer had just finished). A diagnostic run
  unpinned fine on a settled list, before and after a reload. The spec now checks unpin, hold and
  the pill after the run ends; following is still sampled during the stream.
- **Two "Model changed to" markers** after Regenerate with: Pi also marks the thread's first model
  (`ollama/glm-5.3-flash`, the default) next to the new one; the spec picks the one not naming the
  default. Intended?

## Open questions (for Chris or the coordinator)

- The three UI behaviours above: file tickets?
- `.auth/user.json` holds a session cookie; the runner deletes the container copy, but a local
  run leaves it in `e2e/browser/.auth/` (gitignored, noted in the README).

## Evidence (acceptance criteria → test or command output)

- **ac-1:** `e2e/browser/` — config, `tests/auth.setup.ts`, eight specs (table above),
  `tests/support/` (chat fixture, colours). `npx playwright test --list`: 9 tests in 9 files;
  `npm run typecheck` clean.
- **ac-2:** README "Run it": one command with `KOBE_BASE_URL`/`KOBE_USER`/`KOBE_PW`. No workflow,
  turbo task or workspace entry refers to it. `pnpm verify` green, including
  `scripts/check-public-hygiene.sh` over the new files.
- **ac-3:** full pass on gate1 through the coordinator's runner (2026-10-15, Playwright 1.55.0
  container, 1 worker; results in the gitignored `e2e/browser-results/run.log`):

  ```text
  ✓ [setup] auth.setup.ts › sign in (2.8s)
  ✓ compact-now.spec.ts (41.5s)      ✓ context-gauge.spec.ts (11.7s)
  ✓ fork.spec.ts (9.7s)              ✓ regenerate-with.spec.ts (28.2s)
  ✓ root-edit.spec.ts (17.2s)        ✓ scroll-follow.spec.ts (44.1s)
  ✓ steering-panel.spec.ts (7.1s)    ✓ theme.spec.ts (13.1s)
  9 passed (3.0m)
  ```

  Earlier partial runs: run 1 (fork, root edit, gauge, theme) passed but clean-up got 403 (the
  server's CSRF Origin check; clean-up now calls the API from the page), its five threads were
  trashed by a one-off spec (200 ×5); run 2 failed four specs (findings above), fixed in runs 3–4.
  `@playwright/test` 1.55.0: Apache-2.0 (`npm view @playwright/test@1.55.0 license`).
