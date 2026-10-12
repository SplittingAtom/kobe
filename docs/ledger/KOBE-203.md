# KOBE-203: A7: IconAction, tooltip convention, command registry, dot badges, lint rule

- **Status:** in review (PR pending)
- **Branch / worktree:** `kobe-203-icon-action` in `../Kobe-wt203`
- **Depends on:** KOBE-197 (merged, PR #254)

## Plan

`IconAction` (`apps/web/components/shell/icon-action.tsx`) over the shadcn ghost `Button` and the
radix tooltip (300 ms); the registry in `apps/web/lib/shell/commands.ts`; move today's bar, rail,
message and artifact-column actions onto it; `no-restricted-syntax` rule in `eslint.config.js`.

## Decisions

- **Registry entry:** id, name, icon, scope (`bar` / `rail` / `message` / `artifact`), optional
  CE23 shortcut, `href` for navigation, `available(ctx)` (consoles today). Handlers of in-thread
  actions stay with the assistant-ui primitives that render the IconAction (`asChild`); C6/C7 add a
  handler map when the `/` menu and palette need to run them away from their message.
- **Shortcuts are recorded, not shown yet:** `SHORTCUTS_BOUND = false` keeps tooltips from naming
  keys nothing listens to. KOBE-225 (C7) binds the keys and flips it; `IconAction` already renders
  the `<kbd>` and `aria-keyshortcuts` (both `Control+` and `Meta+` forms, so SSR matches).
- **Accessible name = tooltip text.** A call site may name the object (`Rename Budget`,
  `Download version 2`, `Open artifact: Notes`), so existing accessible names are unchanged.
- **Dot badge:** `badge="2 unread"` shows the dot and joins the label (`Notifications, 2 unread`).
  The bell's numeric badge became the dot (CE13); the count stays in the label and tooltip.
- **`description`:** a second tooltip line wired as `aria-describedby`; the root-branching
  "coming soon" actions use it instead of a native `title` (no double tooltip).
- **Lint rule:** `JSXElement[a] > JSXText[/\w/]` in `components/{chat,shell}/**/*.tsx` (tests
  excluded). Markdown links render agent content through `{children}`, so they pass; the skip link
  (WCAG 2.4.1) carries a reasoned `eslint-disable-next-line`. The retention notice's and the
  rail's export links became `export-threads` IconActions; the Scheduled hint's inline
  "schedules" link was dropped (the bar has My schedules).

## Converted

- Bar: My memory / schedules / agents, Team and Site consoles (registry `available`), the bell,
  the profile disclosure (`as="summary"`), Files (row two).
- Rail: New conversation, show/hide toggle, Rename, Move to Trash, Restore, Delete forever, Export.
- Message: Copy, Edit, Regenerate, branch Previous/Next, the two root-branching pending actions,
  Open artifact (tool card and run notice).
- Artifact column: version Previous/Next, Download, Close artifact, Close files.

## Left for later tickets

- C6 (KOBE-224) `/` menu and C7 (KOBE-225) palette + key handlers read `COMMANDS`.
- A2 (KOBE-198) rail rebuild: the Conversations / Scheduled / Trash view switch and Load more stay
  text until then. A4 (KOBE-200) artifact tabs add their own actions to the registry.
- Not in A7's list, left on `TooltipIconButton`: composer buttons, code-block copy, jump to latest.

## Open questions (for Chris or the coordinator)

- Diff is +472 / -274 non-test lines (most of the deletions are replaced markup). A split, if
  wanted: (1) IconAction + registry + lint rule + bar; (2) rail, message and artifact conversions.

## Evidence (acceptance criteria → test or command output)

- ac-1: `components/shell/icon-action.test.tsx` (tooltip after 300 ms, label, shortcut, badge,
  description, links); existing conversation / threads / artifacts / shell tests keep their names.
- ac-2: `shell.test.tsx` "renders every bar action through IconAction from the command registry".
- ac-3: `components/shell/text-link-rule.test.ts` lints fixtures with the repo config.
- `pnpm lint`, web `tsc`, web vitest (84 files, 750 tests), hygiene and Site wording checks: green.
