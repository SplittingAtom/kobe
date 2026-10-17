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
Tests: `layout.test.tsx`, `field.test.tsx`, `display.test.tsx`, `confirm-dialog.test.tsx` (23).

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
  `npx playwright test consoles --update-snapshots=all` → `e2e/browser/console-shots/`. Then on
  this branch: `npx playwright test consoles` for the diffs.
- Checks (2026-10-16): format, lint, typecheck, web unit tests 159 files / 1534 tests green,
  `next build` ok, public hygiene and site wording ok. No new dependencies.
