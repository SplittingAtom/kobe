# KOBE-203: A7: IconAction, tooltip convention, command registry, dot badges, lint rule

- **Status:** in review (PR #256)
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

## Review round 1 (`/code-review medium`, 9 findings)

- **Lint rule** now catches `<a>` and next/link `<Link>` with any letter or digit (Unicode) inside,
  nested elements included, as JSX text, `{"string"}` or `{`template`}`. Exempt by construction:
  `InlineLink` (prose only) and `MenuLink` (profile menu items) in `components/shell/text-links.tsx`.
  The skip link keeps its single reasoned `eslint-disable-next-line`.
- **One tooltip provider** (`IconActionProvider`, 300 ms) at the chat app root and the agent
  builder's test pane; IconAction mounts none, so neighbours share Radix's skip-delay.
- **One precedence rule:** every path renders through `asChild`; IconAction's label,
  `data-command` and shortcut win, a passed `aria-describedby` is merged with the description.
- **Disabled** becomes `aria-disabled` with the click swallowed: the tooltip still opens, the
  look is `aria-disabled:opacity-50`. The jump pill hides on `aria-disabled:invisible`.
- **Prose links restored** as `InlineLink`: the Scheduled hint's "schedules", the retention
  notice's "Export your conversations", the signed-out "Sign in". The banner's "Project" link is
  navigation, so it became the `open-project` IconAction.
- **Bell keeps its count** (1–99, then 99+): CE13's dot is for panels "with something new
  (approval waiting, drift notice, memory update)" and does not name the bell, which already had a
  count (KOBE-181). IconAction's `count` prop shows it in place of the dot.
- **Shortcuts:** `formatShortcut` maps `Ctrl` to `⌃` and runs macOS symbols together; non-`Mod`
  shortcuts give one ARIA value (`Control+K`, `Escape`, `Shift+?`).
- **Bar** renders from `commandsIn("bar", ctx)` by registry `group` (areas, consoles).
- **TooltipIconButton deleted:** composer (attach, dictate, send, stop `Mod+.`), code-block copy
  and the jump pill are registry commands now. `components/files/file-browser.tsx` still has its own
  icon buttons (open folder, download, delete; out of scope here).

## Converted

- Bar: My memory / schedules / agents, Team and Site consoles, the bell, the profile disclosure
  (`as="summary"`), Files (row two).
- Rail: New conversation, show/hide toggle, Rename, Move to Trash, Restore, Delete forever, Export.
- Thread: Project (shared-thread banner), Scroll to bottom.
- Message: Copy, Edit, Regenerate, branch Previous/Next, the two root-branching pending actions,
  Open artifact, Copy code. Composer: Attach, Dictate, Send, Stop.
- Artifact column: version Previous/Next, Download, Close artifact, Close files.

## Left for later tickets

- C6 (KOBE-224) `/` menu and C7 (KOBE-225) palette + key handlers read `COMMANDS`.
- A2 (KOBE-198) rail rebuild: the Conversations / Scheduled / Trash view switch and Load more stay
  text until then. A4 (KOBE-200) artifact tabs add their own actions to the registry.
- `components/files/file-browser.tsx` icon buttons.

## Open questions (for Chris or the coordinator)

- Diff is over the ~600-line guide (most deletions are replaced markup). A split, if wanted:
  (1) IconAction + registry + lint rule + bar; (2) rail, message, composer and artifact conversions.

## Evidence (acceptance criteria → test or command output)

- ac-1: `components/shell/icon-action.test.tsx` (tooltip after 300 ms, label, shortcut, badge,
  description, links); existing conversation / threads / artifacts / shell tests keep their names.
- ac-2: `shell.test.tsx` "renders every bar action through IconAction from the command registry".
- ac-3: `components/shell/text-link-rule.test.ts` lints fixtures with the repo config.
- `pnpm lint`, web `tsc`, web vitest (84 files, 764 tests), hygiene and Site wording checks: green.
