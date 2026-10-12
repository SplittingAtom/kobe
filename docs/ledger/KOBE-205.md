# KOBE-205: Independent column scroll, auto-follow, Jump to latest pill, fixed composer

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review
- **Branch / worktree:** `kobe-205-scroll` in `../Kobe-wt205`
- **Depends on:** KOBE-197 (shell grid), KOBE-203 (IconAction, command registry)

## Plan

CE9, plus the extra scope from 2026-10-12: the page never scrolls; the rail, the artifact column and
the conversation's message list each scroll independently; the composer is a fixed footer of the
conversation column.

## Decisions

- **Layout.** `.app` is `height: var(--kobe-viewport-height, 100dvh); overflow: hidden`. The grid row
  is `minmax(0, 1fr)`. The rail and the artifact column have `overflow-y: auto` and
  `overscroll-behavior: contain`. The conversation column is `overflow: hidden`, so the message
  list is the only thing that scrolls there. On one column (under 48rem) the rows are rail (at most
  40dvh), conversation, artifact (at most 50dvh). A5 (KOBE-201) replaces these rules with the CE7
  yield order and the overlay sheet.
- **Composer outside the scroll.** `ThreadPrimitive.ViewportProvider` wraps the `Viewport`
  (message list) and the footer (run panel, composer, suggestions). The provider forwards
  `scrollToBottom` and mirrors `isAtBottom`, so the pill (`ThreadPrimitive.ScrollToBottom`) and the
  follow hook work from outside the scroll container. `ViewportFooter` is no longer used: it only
  measures sticky footers inside the viewport. An empty thread centres the welcome and the
  composer (both halves `flex-1`). The composer element is the same one either way, so it never
  remounts on the first send. A long run-panel queue scrolls within 30dvh.
- **Keyboard.** The `viewport` export sets `interactive-widget=resizes-content` (Chrome/Android).
  `useViewportHeight` sets `--kobe-viewport-height` from `visualViewport` for Safari, and drops it
  while pinch-zoomed.
- **Follow (CE9).** assistant-ui 0.15.26 `autoScroll` follows only within 1 px of the bottom
  (`isViewportAtBottom`). `useFollowLatest` adds the 48 px band: when the content grows while the
  list is pinned, it scrolls to the bottom. `turnAnchor` changed from `top` to the default `bottom`,
  because with `top` assistant-ui does not follow during a run. `scrollToBottomOnRunStart`,
  `scrollToBottomOnInitialize` and `scrollToBottomOnThreadSwitch` are off: a run started elsewhere
  must not yank a member who scrolled up, and opening a thread is handled by the restore step.
  Sending re-pins on `composer.send`, from any composer (including edits).
- **Pill.** It is still the `jump-to-latest` IconAction, renamed "Jump to latest", with the count as
  its badge. Its accessible name is "Jump to latest, 2 new messages". It mounts when the list
  unpins, so the count starts from what was on screen then. Messages are counted by position, not
  by id: Pi commits replace `live:`/`prompt:` ids. assistant-ui's optimistic placeholder is not
  counted.
- **Restore.** sessionStorage `kobe.scroll:<threadId>` holds `bottom` or an offset. Reads and writes
  are wrapped in try/catch, and junk values are ignored. Positions are saved only after a thread's
  own restore, so scroll events during a switch never overwrite them.
- **Scroll anchoring.** `[overflow-anchor:auto]` is set on the list, so growth above the viewport
  (a tool card) doesn't move what is on screen.

## Open questions (for Chris or the coordinator)

- None blocking.

## Evidence (acceptance criteria → test or command output)

There is no Playwright suite, and adding one would be a new dependency. The coordinator agreed on
2026-10-12 that the tests below use vitest and happy-dom with faked scroll geometry. Real-browser
e2e is deferred. A manual browser check was not done in this ticket: the coordinator will check on
gate1 after deploy.

- ac-1: `components/chat/scroll.test.tsx` "Jump to latest": scrolling up during a stream keeps the
  view where it is, the pill counts "1 new message", and clicking it or sending re-pins.
- ac-2: same file, "scroll position per thread": a new thread opens at the bottom, reopening one
  restores its offset, and a thread left at the bottom reopens at the bottom. Storage edge cases
  are in `lib/chat/scroll-follow.test.ts`.
- ac-3: `components/shell/layout-contract.test.tsx` checks that the composer is outside and after
  the scroll container in the conversation column at every width (the DOM does not change with
  width), and covers `dvh`/`interactive-widget`/visualViewport.
- ac-4: same file, CSS contract: the page never scrolls, the rail and artifact columns scroll on
  their own, the conversation is `overflow: hidden`, and the grid rows are bounded.
- ac-5: `scroll.test.tsx` "following the stream": the list follows at the bottom and from 30 px
  above it.
- Mutation check: disabling the 48 px band, the re-pin on send, or the restore each fails its test.
