# KOBE-424: U18 (CE4): My memory and the profile menu pages open beside the thread, not as full pages

- **Status:** in progress (group G5, branch `group-5-gates`; not pushed)
- **Branch / worktree:** `group-5-gates` in `../Kobe-g5`
- **Depends on:** KOBE-305/418 (the artifact column); found by KOBE-227 (failure 1)

## Plan

Open the My area pages CE4 names in the artifact column, keep the thread and composer on screen,
put the open page in the address (`?area=`) for deep links and Back/Forward, and use the column's
sheet on narrow screens. Flip gate5's U18 `test.fail()`.

## Decisions

- **Which pages (narrower reading of CE4).** CE4 lists "memory panel, approvals, … schedules
  list, profile and settings" beside the thread and keeps "the agent and skill builders" as full
  pages. Moved: My memory and My schedules (bar), My approvals and My connectors (profile menu;
  connectors are the member's settings). Kept as pages: My agents and My skills (builders), and
  Projects and My shared cases, which CE4 does not name. `lib/shell/areas.ts` holds the list.
- **Where:** the artifact column (`components/shell/area-panel.tsx`), which the page takes over
  while open (`.artifact:has(> [data-kobe-area])` hides the tabs; they stay mounted and come back
  on close). A column the member hid shows again for it. Under 820 px it is the column's sheet (from
  768 px over the conversation, below 768 px full screen and modal) with Back to the conversation;
  Close (or Escape) beside the thread, focus back to the conversation.
- **Address:** `?area=memory|approvals|schedules|connectors` beside `?thread=`, a new history entry
  per open and close, followed through `popstate`: a link or refresh reopens it, Back/Forward
  step through it, an unknown value opens nothing. The `/me/...` routes stay: a modifier click
  (new tab) or a link from a console still opens the full page.
- **Entry points:** the bar's links (`IconAction`), the profile menu (closes on the click), the
  palette and the `/` menu (`useNavigate`), all through `openBeside()`; only on the chat page.
- **The pages themselves are the My area's**, embedded by `components/me/area-beside.tsx` (team
  access from `/v1/me` + `/v1/team`, console primitives, the console sheet scoped by
  `data-kobe-console`; `app/console-css-guard.test.ts` allows that import). Their page title
  (`PageHeader` h1) is left out under the panel's h2 (`EmbeddedPage`). Memory beside the thread
  keeps its project choice in the panel, not in `?project=` (which the chat reads as the draft's
  project).

## Open questions (for Chris or the coordinator)

- Light, dark and phone screenshots (ac-3) are not taken here (no browser run against a site);
  the frame uses the theme tokens of the artifact column, the pages their console primitives.
- The schedules page's "agents" link and the agents page's connector link still go to full pages
  (they are inside the pages, unchanged).

## Evidence (acceptance criteria → test or command output)

- ac-1: `apps/web/components/shell/area-panel.test.tsx` (bar and profile menu open each page in
  the artifact column; thread, heading and composer stay; focus moves in; the page's content
  without its h1; the builders stay links).
- ac-2: same file (deep link `?area=`, Back closes and Forward reopens, Escape, unknown area,
  modifier click keeps the page; at 390 px a modal full-screen sheet with Back);
  `lib/shell/areas.test.ts`; palette and `/` menu tests updated (`/memory` beside, `/agents`
  navigates).
- ac-3: `e2e/browser/tests/gate5/u18-never-lose.spec.ts` U18 without `test.fail()`, now also
  checking the region, the composer and answer in view, `?area=`, and Back; pending the group CI
  run. Local: `@kobe/web` 1880/1880, typecheck, lint; `tsc -p e2e/browser`.
