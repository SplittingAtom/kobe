# KOBE-282: Light/dark theme toggle in the top bar; every popup themed in both themes

- **Status:** in review (PR #289)
- **Branch / worktree:** `kobe-282-theme-toggle` in `../Kobe-wt282`
- **Depends on:** KOBE-281 (PR #287: chat dialogs portalled into the chat root, `chat-portal.ts`)

## Plan

1. One theme source: `apps/web/app/theme.css`, imported by the root layout, declares every colour
   token on `:root` (shadcn tokens, shared accents, console neutrals, gauge colours). Popups that
   portal anywhere resolve them; module CSS only reads them.
2. Dark applies when `<html data-theme="dark">`, or with no `data-theme` when the OS is dark
   (`@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) }`). `color-scheme`
   matches (`light dark` when unset), so native controls and browser-default pages follow.
3. Cookie `kobe-theme=light|dark` (Path=/, one year, SameSite=Lax, Secure over https), read by
   `app/layout.tsx` with `cookies()` to set `<html data-theme>`: first paint is right, no script.
4. Bar toggle (`components/shell/theme-toggle.tsx`) between the notifications bell and Profile.

## Decisions

- Toggle is a toggle button named "Dark theme" with `aria-pressed` (registry rule: bar icons carry
  the registry name, shell.test.tsx). Icon = current theme (sun / moon). Both icons are rendered and
  `--kobe-when-light/dark` in theme.css pick one, so SSR paints the right icon even when the theme
  follows the OS; `aria-pressed` is set after hydration (`useSyncExternalStore`, server snapshot
  null).
- A press always saves an explicit choice; "follow the OS" again means clearing the cookie (no
  third state, per the coordinator's decision: the button flips light/dark).
- The two dark blocks are duplicated on purpose (no `light-dark()`: Tailwind's Lightning CSS pass
  rewrites it for older targets); `theme-css.test.ts` asserts they are identical.
- Tailwind `dark:` variant: `[data-theme="dark"] *`, or `:root:not([data-theme="light"]) *` under
  the dark media query (`app/chat-global.css`).
- Regenerate with… (assistant-ui `ActionBarMore`, a Radix DropdownMenu portalled to `<body>`) was
  the reported bug: its `bg-background`/`border` resolved to undefined tokens outside
  `[data-kobe-chat]`. Fixed twice over: tokens are global now, and it portals into the chat root
  (`portalProps.container = chatPortalContainer()`) so the preflight slice (border colour,
  box-sizing) applies too.

## Popup audit (ac-1)

| Popup                                                                                         | Where it mounts                                          | Theming source                                |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------- |
| Regenerate with… menu (`chat/regenerate-with.tsx`)                                            | Radix DropdownMenu portal → chat root                    | shadcn tokens (`bg-background`, `border`)     |
| Compact dialog, Fork dialog (`chat/compact-dialog.tsx`, `fork-dialog.tsx`)                    | Radix Dialog portal → chat root (KOBE-281)               | shadcn tokens                                 |
| Tooltips of every IconAction, context gauge tooltip (`ui/tooltip.tsx`)                        | Radix Tooltip portal → chat root                         | `bg-foreground text-background`               |
| Agent picker (`chat/agent-picker.tsx`)                                                        | Radix Popover, not portalled (in the bar)                | shadcn tokens                                 |
| Model pickers (`chat/model-picker.tsx`), approval card select, project/console selects        | native `<select>`                                        | `color-scheme` on `:root`                     |
| Profile menu, Conversation actions menu (`shell/profile-menu.tsx`, `chat/thread-actions.tsx`) | `<details>` + absolute `.menuList` in `.app`             | `--admin-*` → shadcn tokens (chat.module.css) |
| Team switcher (`app/team-switcher.tsx`)                                                       | `<details>`, in flow in the bar                          | inherits `.app` colours; chat button style    |
| Notifications panel (`chat/notification-bell.tsx`)                                            | absolute `.notePanel` in `.app`                          | `--admin-bg`/`--admin-border` → tokens        |
| Thread search results (`shell/thread-search.tsx`)                                             | absolute `.results` in `.app`                            | `--admin-*` → tokens                          |
| Bar Menu under 768 px, rail drawer, artifact sheet (`shell/*`)                                | in `.app`; ShellSlots `createPortal` into bar/rail slots | `--admin-*` → tokens                          |
| Files delete confirm (`files/file-browser.tsx`)                                               | inline `role="alertdialog"` in the rail                  | shadcn tokens                                 |
| Agent builder Publish dialog (`admin/team/agent-builder/publish-dialog.tsx`)                  | fixed backdrop inside console `.shell`                   | `--admin-*` → `--kobe-console-*`              |
| Admin consoles, My area (all pages, inline forms)                                             | `.shell`                                                 | `--kobe-console-*`, `color-scheme` for inputs |
| Agent builder test pane (chat inside a console)                                               | `[data-kobe-chat]` inside `.shell`                       | shadcn tokens                                 |
| `window.confirm` (rename/Trash, console removals, web search)                                 | browser chrome                                           | browser's own UI theme (cannot be styled)     |
| Sign-in, setup, invite, password pages                                                        | browser defaults                                         | `color-scheme` on `:root`                     |

## Open questions (for Chris or the coordinator)

- Resolved (coordinator, review of #289): the toggle is also in the console and My-area headers
  (`components/admin/console-theme-toggle.tsx`); no "follow the OS" reset for now.

## Review fixes (#289)

- The one-row bar Menu's outside-press check uses `CHAT_PORTALLED`, so a press in the Compact
  dialog no longer closes the Menu behind it (`compact-dialog.test.tsx`, 390 px case).
- Shared accents (`--admin-accent/danger/danger-bg/warn-bg`) are set once in `theme.css`.
- `use-theme.ts` keeps one lazily created `MediaQueryList`; the portal audit parses TSX.

## Evidence (acceptance criteria → test or command output)

- ac-1: `apps/web/components/ui/popup-portals.test.ts` (every Radix portal and assistant-ui "more"
  menu names `chatPortalContainer()`; React portals only in ShellSlots);
  `components/chat/regenerate-with.test.tsx` (menu inside `[data-kobe-chat]`);
  `compact-dialog.test.tsx` / `fork-thread.test.tsx` (KOBE-281); table above. Gate1 Playwright
  screenshots in both schemes: coordinator, after deploy.
- ac-2: `apps/web/lib/theme/theme.test.ts` (parse, cookie string, precedence),
  `components/shell/theme-toggle.test.tsx` (name, pressed state, OS follow, cookie + `data-theme`,
  in bar row one), `app/layout.test.tsx` (cookie → `<html data-theme>`),
  `components/shell/ssr.test.tsx` (both icons server-rendered, no `aria-pressed`).
- ac-3: `apps/web/app/theme-css.test.ts` (one source; dark blocks identical; `color-scheme`;
  no other stylesheet reads `prefers-color-scheme`; tokens global; Tailwind `dark:` variant).
  `pnpm verify` green; CI on the PR.
