# KOBE-452: Team console, Site console, My agents and Skills open as panels over the workspace

- **Status:** in review (Sonnet), committed on `group-11a-panels`, not pushed
- **Branch / worktree:** `group-11a-panels` in `../Kobe-g11a` (group G11a: 452, then 453, 448)
- **Depends on:** KOBE-424 (My area beside the thread, replaced here), KOBE-419 (rail top line)

## Decisions (Chris 2026-10-20, followed)

- Large centred overlay, ~90% of the window (`inset: 5dvh 5vw`) over a dimmed workspace
  (`--kobe-console-overlay`); full-screen sheet under 820 px. My memory, approvals, schedules and
  connectors (KOBE-424, beside the thread until now) open as the same panels.

## Design

- **Routing:** every `/admin/*` and `/me/*` address is a panel (`lib/shell/panels.ts`: title,
  id, `embedded` for the four single My pages). The chat moved from `app/page.tsx` into the root
  layout (`components/shell/workspace-host.tsx`): on `/` and on panel addresses it renders
  `ChatApp` with the route's page as the panel content, so client-side navigation between the chat
  and a panel never remounts the workspace (run stream, draft, scroll, thread). Other pages
  (sign-in, setup, invite, reset) render alone. No files moved; existing URLs and Next `Link`s
  work as they were, and the server still enforces every route and API.
- **Frame:** `components/shell/workspace-panel.tsx` (chat side: CSS module, `IconAction` Close,
  `useModalLayer` modal: inert workspace, Escape and press-outside close, focus returns to the
  opener, else to `#kobe-chat-main`). `role="dialog"`, `aria-modal`, named by its h2.
- **Page:** `components/ui/console/panel-content.tsx` (console side): `InPanel` (the console and
  My area shells drop the "Kobe /" brand; switcher, who and theme toggle stay on a slim line),
  `EmbeddedPage` for single pages, and the unsaved-edit guard: an edit in a `<form>` (not a search
  box or `role="search"`) until it is submitted, or `useUnsavedChanges(dirty)` (agent builder's
  `dirty`, Workbench editor while a save is pending). Close/Escape/outside ask "Discard your
  changes?" (Keep editing / Discard and close). Browser Back does not ask (not interceptable).
- **Close and history:** `lib/shell/panel-history.ts` records, with the Navigation API, the chat
  entry each panel returns to (per tab, sessionStorage). Opened from the chat, Close is
  `history.go(-n)` past every step inside the panel, so Back never reopens it; opened by a link,
  a new tab or without that entry, Close `router.replace`s the panel's entry with the last thread
  (`lastThreadHref`). Without the Navigation API, Close replaces.
- **Thread under a panel:** `useThreadUrl` keeps the workspace's thread while the address is a
  panel's (a deep link or reload shows the tab's last thread, `lastThreadId`), and follows `?thread=`
  again once back on `/`. The bell under a panel pushes `/?thread=`.
- **Old `?area=` links** (KOBE-424) are replaced by `/me/<area>` over their thread.
- **Client-side inside panels:** pages that did `window.location.assign` after create/delete
  (agent builder, skill reach, Workbench new/fork/delete, project delete, the bell's skill link)
  now use `useNavigate` (router push; tests without a router still `assign`).
- Removed: `area-panel.tsx`, `area-beside.tsx`, `openBeside`/`showArea`/`closeArea`, the
  `.artifact:has([data-kobe-area])` rule.

## Shared files touched

- `apps/web/app/layout.tsx`, `app/page.tsx`, `components/chat/chat-app.tsx` (route prop, panel,
  thread under a panel; nothing in the composer), `components/shell/icon-action.tsx`,
  `profile-menu.tsx`, `use-navigate.ts`, `utility-bar.tsx`, `components/ui/console/layout.tsx`.
- Not touched: `lib/shell/commands.ts` (Close reuses `area-close`, labelled `Close <panel>`).

## Open questions

- A deep link to a console the member can't open shows the console's refusal inside the panel
  (as the page did); entry points stay hidden for them. OK?
- `consoles.spec.ts` screenshots need a new baseline (every page is now the panel over the chat).

## Evidence (acceptance criteria → test or command output)

- ac-1, ac-5: `components/shell/workspace-panel.test.tsx` "Team console opens over the workspace…"
  (draft, thread, inert workspace, focus), "a run keeps streaming under the panel…" (same
  EventSource, deltas arrive while open), "one panel at a time"; browser
  `e2e/browser/tests/workspace-panels.spec.ts` (mid-run console, ~90% box, backdrop).
- ac-2: `lib/shell/panel-history.test.ts`; panel tests "Back steps inside the panel…", "Close after
  steps inside…", "a link or a reload opens the panel over the last thread…", "?area=memory";
  browser "deep links, reload and Back".
- ac-3: panel tests "closing" (form edit asks, submit doesn't, `useUnsavedChanges`), phone dialog;
  `layout.test.tsx` panel mode; browser phone sheet and light/dark screenshots.
- ac-4: panel tests "permissions" (member gets no entry point; site console refusal in a panel);
  `console-shell`, `rail-header` unit tests unchanged and passing; browser `consoles.spec.ts`
  (settles on the panel), `rail-header.spec.ts` (Team console opens the panel, focus back).
- ac-6: `e2e/browser/tests/my-area-panels.spec.ts` (was `my-area-beside.spec.ts`), gate5 U18 memory
  test, `slash-menu` / `command-palette` tests (`/memory` navigates).
- Manual: `next build`; standalone server + Chromium: bar link → panel without a reload, Escape →
  `/`, Back → previous page, deep link Close → `/` without a reload, 1152x720 box at 1280x800,
  390 px full screen.
