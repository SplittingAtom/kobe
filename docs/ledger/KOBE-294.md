# KOBE-294: Consoles on Tailwind (1/3): foundation

- **Status:** in progress (group 7, not pushed)
- **Branch / worktree:** `group-7-consoles` in `../Kobe-g7`
- **Depends on:** KOBE-282 (theme), KOBE-281 (portal theming), KOBE-283 (choices), KOBE-301 (status tokens)
- **Followed by:** KOBE-295, KOBE-296 (the remaining pages)

## How Tailwind was scoped, and what changed

- Before: Tailwind v4 (theme + utilities layers, no preflight) came only from `app/chat-global.css`,
  imported by the chat page, the agent builder's test pane and the consoles' theme toggle. Its
  preflight slice and base rules are scoped to `[data-kobe-chat]`.
- Now: the Tailwind core (layers, imports, `dark` variant, `@theme inline` tokens) is
  `app/tailwind.css`. `chat-global.css` imports it first and keeps only its own rules; its
  compiled output was byte-identical to main's before any new class was added (checked with
  `@tailwindcss/postcss`). `app/admin/layout.tsx` (new: `/admin`, Site and Team consoles) and
  `app/me/layout.tsx` load `app/admin/admin-global.css`, which imports the same entry and adds
  base-layer rules scoped to `[data-kobe-console]`. The theme toggle no longer loads the chat CSS.
- Console palette added to the shared `@theme inline`: `console-fg|muted|bg|panel|border|accent|
danger|danger-bg|warn-bg` (from `--kobe-console-*` and `--admin-*`), beside the KOBE-301
  `status-*` colours. Both themes come from `app/theme.css`, so the KOBE-282 toggle just works.

## Decisions

- **No preflight on console pages.** The 120-odd CSS-module components rely on browser defaults;
  preflight would restyle every one at once. Primitives carry their own resets (`m-0`,
  `box-border`, `font-[inherit]`, explicit borders). 296 can scope a preflight slice to
  `[data-kobe-console]` once the last module is gone.
- **One build for both.** A page that has both stylesheets (client navigation between chat and a
  console, or the test pane) gets two copies of the same utilities, harmless only while they are
  identical; so every token lives in `app/tailwind.css` (guarded).
- **The shell's descendant rules moved** from `.shell` (unlayered) to the base layer of
  `admin-global.css`: `--admin-*` variables, link colour, focus ring, KOBE-283 fieldset spacing.
  Unmigrated pages keep them; utilities override them.
- **Portals:** `consolePortalContainer()` (`components/ui/chat-portal.ts`) = the console root;
  `chatPortalContainer()` falls back to it when there is no chat root (the toggle's tooltip). The
  KOBE-282 portal test accepts either helper.
- **Notice colours:** info/warn/error use the KOBE-301 status tokens (as asked), so `ErrorNotice`
  and the isolation banner shift slightly from `--admin-danger*`/`#b7791f` to `status-failed` and
  `status-attention`, with an icon per tone.
- **Confirm:** `useConfirm()` (Radix AlertDialog) replaces `window.confirm` page by page; the
  reference page uses it. Focus starts on Cancel and returns to the asking control.

## Primitives (`components/ui/console`, barrel `index.ts`)

`ConsoleLayout`/`ConsoleMain`/`ConsoleWho` (frame, skip link, header slots), `SideNav`/
`SideNavGroup`/`SideNavLink`, `PageHeader`, `Section`, `Card`, `Field` (label, hint, error via
context and `aria-describedby`/`aria-invalid`), `FormRow`, `TextInput`, `Textarea`, `Select`,
`Checkbox`/`Radio` (inline in their label, KOBE-283), `ChoiceGroup` (fieldset + legend), `Switch`
(Radix), `Button` (primary, secondary, danger; sm), `Table` + parts, `EmptyState`, `Notice`
(info, warn, error), `Badge` (status tones), `ConfirmDialog` + `useConfirm`.
Tests: `layout.test.tsx`, `field.test.tsx`, `display.test.tsx`, `confirm-dialog.test.tsx` (36).

**Reference migration:** console layout and nav (`console-shell.tsx`, `console-nav.tsx`, also the
My-area shell, `error-notice.tsx`, `isolation-banner.tsx`, the theme toggle) and the Team console
**Invitations** page (`team/invites-page.tsx`: header, form fields, primary button, empty state,
table, badges, danger button, confirm dialog). Unused shell classes removed from `admin.module.css`.

## Guard tests (`app/console-css-guard.test.ts`)

- Tailwind entry: theme + utilities only, no preflight, no style rules; chat page and the /admin and
  /me layouts load it.
- The chat and console builds have identical `@layer theme` and `@layer utilities`.
- Every rule of the console stylesheet names `[data-kobe-console]`; the chat's never does.
- The chat's own compiled rules (everything but Tailwind's generated layers, `--tw-*` properties
  and its keyframes) match `app/__snapshots__/chat-global.own.css.snap`, which equals main's.
  Changing chat styling on purpose: update it with `-u` in that PR.
- For 295/296 to tighten: `CSS_MODULES` (modules console code may import; must exist and be used),
  `ON_TAILWIND` (files that import none: add each migrated page), and every `styles.x` a console
  file uses must still be defined in its module, so deleting classes is safe.

## Review fixes (coordinator review, 2026-10-16)

- **M1 control borders:** new token `--kobe-console-control-border` (`border-console-control`) on
  text inputs, selects, textareas and secondary buttons; `console-border` stays for dividers.
  Ratios: light `#80808c` 3.90:1 on the page (`#ffffff`), 3.55:1 on the panel (`#f4f4f6`); dark
  `#74747f` 3.91:1 on the page (`#16161a`), 3.51:1 on the panel (`#202027`). Pinned (≥3:1) in
  `theme-css.test.ts`.
- **S1:** every focusable primitive carries `FOCUS_RING` (`focus.ts`); the console base rules for
  links and `:focus-visible` are now declared permanent (plain content links) and pinned by the guard.
- **S2:** the legacy KOBE-283 fieldset spacing skips labels with a `data-slot` (primitive choices).
- **S3:** the confirm dialog falls back to `#console-main` when the asking control is gone or
  disabled; Invitations then moves focus to the next row's Revoke, or the list heading when empty.
- **S4:** `Field` and `ChoiceGroup` take `required` (marker, native `required`; a group passes it to
  its radios only) and `error` (`role="alert"`, in `aria-describedby`, `aria-invalid`).
- **S5:** `Notice` gets `success`, an `actions` slot and passes div props; `MutationStatus` shows
  successes as a success Notice inside its live region. `Button` gets `loading`, `asChild`, `ghost`.
  `Section`/`Card` take a heading `level` (Card a `title`), `PageHeader` a `back` link; `Table` a
  hidden caption, a focusable named scroll region and numeric cells.
- **S6 (rule for 295/296):** the consoles' CSS modules (admin, usage, agent-builder, skill-editor)
  are wrapped in `@layer kobe-legacy`, between `base` and the utilities; the order
  `properties, theme, base, kobe-legacy, components, utilities` is declared first in
  `app/theme.css` (root layout). So a utility always beats a module rule on the same element.
  Modules shared with the chat (`components/memory`, `components/files`) stay unlayered and still
  win: don't nest primitives inside them. Move files whole: the guard fails on a file that imports
  both the primitives and a CSS module. Delete a module (and its `CSS_MODULES` line) with its last user.
- **S7:** a second snapshot pins `app/tailwind.css` without the console tokens (chat token mapping,
  dark variant, layer order). The chat-rules snapshot changed only in its layer statement
  (`kobe-legacy` added).
- **S8:** console code's Radix portals must use `consolePortalContainer()`, all other code
  `chatPortalContainer()`; a test covers both wrong cases.
- **S9:** the spec also shoots the eval report (from the team agent's page), adds a 390 px pass
  (landings, Members and Invitations, the opened nav), records a failing page and goes on, checks
  ChoiceGroup spacing, and stores shots per platform (`console-shots/<platform>/…`).
- **S10:** Invitations tests for a refused invite, a failed list, the badges and focus after revoke.
- Nits: overlay token, unanswered confirms resolve false on replace and unmount, dialog scrolls in
  short viewports, `text-start`, no `pe-6` on Select, disabled Switch label cursor, shell loading
  and denied states use `PageHeader`, Invitations caption hidden (the section heading says it),
  module-import guard catches `import * as` and side-effect imports.

## Open questions (for Chris or the coordinator)

- ac-3 needs your gate1 run (below). Baseline PNGs show deployment data (names, emails, connector
  hosts): keep them out of git; attach the archive or its location here.
- `Pending` invitations show a neutral badge and `Expired` an amber one: say if you'd rather not.

## Evidence (acceptance criteria → test or command output)

- **ac-1:** `console-css-guard.test.ts` (10 tests); `theme-css.test.ts`; `next build` shows the
  invitations route loading only the console CSS chunk (Tailwind + `[data-kobe-console]` rules)
  and `/` only the chat chunk; chat compiled CSS identical to main before new classes.
- **ac-2:** primitive tests above; `team-pages.test.tsx` (invite, revoke with confirm, cancel);
  `console-shell.test.tsx` and `my-agents.test.tsx` unchanged and green.
- **ac-3:** `e2e/browser/tests/consoles.spec.ts` (committed before any styling change, 0e3c9f39):
  every Site, Team and My-area page from the consoles' nav, plus new/detail pages, in light and dark,
  full page, times masked. **Chris to run against gate1 for the baseline**, on a build _before_
  this branch (main/G4): `KOBE_USER` = the Owner who is a team admin of Team1 (Team1 active):
  `npx playwright test consoles --update-snapshots=all` → `e2e/browser/console-shots/<platform>/`
  (take and compare on the same platform). Then on
  this branch: `npx playwright test consoles` for the diffs.
- Checks (2026-10-16, after the review fixes): format, lint, typecheck, web unit tests 159 files /
  1558 tests green (one unrelated chat timing test, `conversation.test.tsx` interrupted runs, failed
  once under full-suite load and passed 3/3 alone and on the rerun), `next build` ok (module rules
  ship inside `@layer kobe-legacy`), public hygiene ok. No new dependencies.
