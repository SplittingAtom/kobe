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
  list is the only thing that scrolls there. On one column (under 48rem) the rows are
  `minmax(0, auto) minmax(min(20rem, 100%), 1fr) minmax(0, auto)`. The conversation keeps 20rem
  (the composer plus some list), and the rail (at most 40dvh) and the artifact column (at most
  50dvh) yield first. A5 (KOBE-201) replaces these rules with the full CE7 yield order and the
  overlay sheet.
- **Composer outside the scroll.** `ThreadPrimitive.ViewportProvider` wraps the `Viewport`
  (message list) and the footer (run panel, composer, suggestions). The provider forwards
  `scrollToBottom` and mirrors `isAtBottom`, so the pill (`ThreadPrimitive.ScrollToBottom`) and the
  follow hook work from outside the scroll container. `ViewportFooter` is no longer used: it only
  measures sticky footers inside the viewport. An empty thread centres the welcome and the
  composer (both halves `flex-1`). The composer element is the same one either way, so it never
  remounts on the first send. A long run-panel queue scrolls within 30dvh.
- **Keyboard.** The `viewport` export sets `interactive-widget=resizes-content` (Chrome/Android).
  `useViewportHeight` sets `--kobe-viewport-height` and `--kobe-viewport-offset` (`offsetTop`, used
  as `top` on `.app`) from `visualViewport` on resize and scroll, for Safari. It drops both while
  pinch-zoomed.
- **Follow (CE9), one source (review round 1).** `useFollowLatest` holds the mode (`pending` while
  a thread opens, then `pinned`/`unpinned`) and passes `autoScroll={mode === "pinned"}` to the
  viewport. So assistant-ui's own resize observer does all following, and only while pinned. Pin:
  any `scrollToBottom` request on the viewport store (the pill, a send, a restore) or the store's
  `isAtBottom` turning true. Unpin: any scroll up by the member, however small (scroll over
  unchanged content, the same rule as assistant-ui's `isUserScrollUp`, plus wheel up and touch drag
  down). The 48 px band only re-pins: scrolling down into it requests the bottom. The second
  ResizeObserver is gone. assistant-ui's own run-start, initialize and thread-switch scrolls are
  off. Sends request the bottom with `instant` (so `scroll-smooth` never chases a stale bottom),
  and again once the sent message has rendered.
- **turnAnchor `top` → `bottom`: intended.** Chris asked for the chat to auto-scroll as it streams
  (2026-10-12), and assistant-ui doesn't follow during a run with `top`. Not to be reverted.
- **Pill.** It is still the `jump-to-latest` IconAction, renamed "Jump to latest", with the count as
  its badge. Its accessible name is "Jump to latest, 2 new messages". It mounts when the list
  unpins and is keyed by thread, so the count starts from what was on screen then. Messages are counted by position, not
  by id: Pi commits replace `live:`/`prompt:` ids. assistant-ui's optimistic placeholder is not
  counted.
- **Restore.** sessionStorage `kobe.scroll:<threadId>` holds `bottom` or an offset. Reads and writes
  are wrapped in try/catch, and junk values are ignored. Writes are debounced (200 ms) and flushed
  at once when the thread is left. Scroll events are ignored from a switch until the new thread's
  restore, and the thread is read from a ref, so a late event never lands under the wrong key.
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
- Review round 1: tests for a small scroll up unpinning during a stream, re-pinning from the 48 px
  band, a restored position holding through resizes, a flush on leave and late scrolls during a
  switch (Beta's load held at a gate), and the pill count starting again per thread.
- Mutation check: removing the unpin on scroll up, the band re-pin, the switch guard or the flush
  on leave fails its test. Two changes no test can tell apart:
  - Gating `autoScroll` on the mode. In 0.15.26 assistant-ui's mount-time resize puts the list at
    the bottom before the restore runs, so the restore is an upward scroll, and assistant-ui's
    `isUserScrollUp` already stops following. The "restored position stays put" test drives
    assistant-ui's real resize path (its ResizeObserver, faked) and passes either way. The gate
    covers a downward restore.
  - The second re-pin after a send renders. assistant-ui follows the render anyway once pinned.
