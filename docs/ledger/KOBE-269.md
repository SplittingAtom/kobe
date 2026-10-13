# KOBE-269: Chat shell polish: crushed icon buttons, list indents, sheet over send

- **Status:** in review (PR #268)
- **Branch / worktree:** `kobe-269-shell-polish` in `../Kobe-wt269`
- **Depends on:** none (found in the gate1 browser check 2026-10-13)

## Plan

1. Icon buttons: `chat-global.css` pads every `button:not([data-slot])` 0.25rem 0.75rem, so a raw
   28 px icon button left its 16 px svg 2 px (measured on gate1). Move the raw icon buttons to
   `IconAction` (shadcn Button sets `data-slot`), with registry entries.
2. Lists: no Tailwind preflight in the chat, so `<ul>`/`<ol>`/`<p>` keep UA margins and the 40 px
   indent. Reset them for Kobe chrome only.
3. 768–820 px: the overlay sheet covered the composer's Send.

## Decisions

- **Sweep:** raw icon-only buttons inside `[data-kobe-chat]` were the retention banner close, the
  file-gone banner close (`file-tab.tsx`, same pattern, not in the brief) and the Files row
  Download/Delete. All four are now `IconAction`s; new registry commands `dismiss-notice`
  (thread), `download-file` and `delete-file` (rail). Size `sm` (24 px, `p-1`). Labels unchanged.
  The attachment chips' Retry/Remove set their own `p-1`, so the rule never crushed them; kept.
- **Guard:** `crushedIconButtons()` in `components/chat/testing.tsx` lists buttons in
  `[data-kobe-chat]` with an svg, no visible text, no `data-slot` and no `p-*` class. Asserted
  empty in the retention, file-gone, Files rows + open tab, and composer-attachments tests
  (happy-dom: classes and attributes, not pixels). A lint selector was considered and dropped:
  it cannot see class names held in variables (the `iconButton` constant was exactly that case).
- **Lists (review round 1: scoped):** no chat-wide reset; it took spacing from notices (egress
  `.denied`, approved input, notification "Load more") and left bare lists' markers outside the
  box. The chrome that needed it says so with utilities: steering queue/panel (`m-0`, lists
  `m-0 list-none ps-0`), the Files list and notes, and the rail drop zone's status line (an empty
  `<p>` with UA margins: the "gap above" the Files list). `browserSpaced()` (testing.tsx) guards
  the steering panel and the Files section.
- **768–820 sheet (CE7/CE8):** smallest fix that keeps the table's "artifact column overlays the
  conversation; conversation holds ≥ 400": the sheet ends above the composer instead of covering
  it. CSS anchor positioning: `[data-kobe-composer] { anchor-name: --kobe-composer }` and, in the
  band, `.artifact { bottom: anchor(--kobe-composer top) }`. No JS, no new breakpoint, the sheet
  keeps its width and stays non-modal. Without anchor support the declaration is dropped and the
  sheet keeps today's full height. Review round 1: `anchor(…, 0px)` fallback (no composer on
  screen: loading, error), and the anchor is `[data-kobe-composer-box]` (steering panel + input),
  not the footer, which grows with notices and the welcome. Deliberately not the input card alone:
  the steering panel above it holds Stop and the queue, which the sheet must not cover. Rejected: composer above the sheet (hides the sheet's bottom
  under it), a modal sheet in this band (changes CE7's overlay into the < 768 behaviour), a
  ResizeObserver-fed height variable (more code for the same result).

- **Arrival fade colours (coordinator, 2026-10-13):** on gate1 Chromium mid-fade words computed
  as `oklab(1 69.6 189.8)` (red/green): `@keyframes kobe-arrive` interpolated `color` from the
  rgb/oklch tint to the text colour, which the build emits as `lab()`. Now the keyframes move a
  registered `@property --kobe-arrived` (<percentage>, 0% → 100%, initial 100%) and the word's
  colour is `color-mix(in srgb, currentColor var(--kobe-arrived), var(--kobe-arrive-tint))`: no
  colour interpolation, both endpoints mixed in one space. Text colour first because Tailwind's
  build emits the first colour as the fallback without color-mix (`color: currentColor`, checked
  in the built CSS). Without @property the percentage flips at mid-animation (discrete), harmless.
- **Fade after Stop:** the part kept `data-kobe-arrive="running"` until the run's end event,
  which can come seconds after the server accepts the cancel. The controller now records
  `stopRequested` (the run id) on an accepted Stop; `isStopping(state)` holds while that run is
  still current, and the text and reasoning parts stop fading at once (`useArriving` in
  `messages.tsx`, a boolean selector, so no extra renders per token). Review round 1: the flag is
  set at the click and undone if the cancel fails; `settleStop` in the controller's `#set` drops it
  once its run is no longer current. `kobeExtrasOf` is the one extras selector (runtime, artifact
  state, messages).
- **Review round 1, guard and rows:** `crushedIconButtons` treats `sr-only`/`visuallyHidden` text
  as no text and accepts only inline padding classes (`p-*`, `px-*`, variants; `py-*` alone still
  crushes); `crushed-icon-buttons.test.tsx` proves it flags the original banner button. Files row
  Download/Delete are the standard 32 px IconAction, Delete set apart with `ms-2`.

## Open questions (for Chris or the coordinator)

- Confirm on gate1: mid-fade word colour lies between the tint and the text colour.
- Confirm on gate1 after deploy at ~800 px with an artifact open: Send visible and clickable,
  sheet bottom at the composer's top; queue chips and the Files list flush left.

## Evidence (acceptance criteria → test or command output)

- ac-1 (icon buttons): `threads.test.tsx` retention close, `file-viewer.test.tsx` rows + gone
  notice, `attachments.test.tsx` composer: `crushedIconButtons()` empty (failed before the fix
  with "Download todo.md", "Delete todo.md", "Dismiss file notice", "Dismiss retention notice").
- ac-2 (lists): `browserSpaced()` empty for the steering panel (`steering-panel.test.tsx`, paused
  queue) and the Files section (`file-viewer.test.tsx`); Markdown is untouched.
- ac-3 (sheet): `layout-contract.test.tsx` 768–820 test pins `bottom: anchor(--kobe-composer top, 0px)`
  and the anchor name; the DOM contract test pins the anchor box (input + steering, not the footer); `next build` keeps both declarations in the emitted CSS.
- Fade (coordinator follow-up): `arrival-fade.test.tsx` pins the registered percentage, the
  endpoints (0% tint, 100%/rest text colour) and that the keyframes never set `color`; "Stop ends
  the fade at once, before the server confirms" (cancel accepted with 202, end withheld) failed
  before the fix; "after Stop and the run's end" passes.
