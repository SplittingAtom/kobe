# KOBE-553: Composer: bridge-mediated pointer drag from an MCP App frame

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (PR #TBD)
- **Branch / worktree:** `kobe-553-frame-drag` in `../Kobe-wt553`
- **Depends on:** KOBE-551 (native drop path, unchanged); Catalyst CAT-247 (the picker side,
  built in parallel to the shared `DRAG-CONTRACT.md`)

## Plan

Chromium refuses native drags between cross-origin frames (crbug.com/59081), so the picker
drives the drag with captured pointer events and posts `kobe/notifications/drag-start|move|end|
cancel` over the bridge. Kobe maps the points to the page, draws a ghost, cues the composer and
inserts the item through the native drop's chain.

## Decisions

- **Bridge** (`lib/apps/host-bridge.ts`, schemas in `bridge-schema.ts`): an optional
  `handlers.drag(event)`; the bridge tracks a live drag per frame (move/end/cancel without a
  start ignored, second start replaces), item a plain object of at most 8 KiB (`DRAG_ITEM_MAX`),
  x/y finite; cancel params may be absent or any object (unknown fields tolerated like the
  other schemas). Detaching mid-drag cancels it (frame removed, team switch).
- **AppFrame** gets `onDrag`; it adds the iframe's `getBoundingClientRect()` left/top on every
  notification (`pagePoint`), never cached.
- **Store** `session.frameDrag` (`lib/apps/frame-drag.ts`): one live drag; `start()` returns a
  handle that is spent once the drag ends, is cancelled or is replaced, so a frame's late moves
  never move another frame's drag. `frameDragRelay` keeps one handle per frame and is used by
  `useAppComposer.onDrag` with the app's title as `from` (no composer for the frame: no drag).
- **Composer**: `useFrameDrop` / `watchFrameDrop` (`components/chat/composer-frame-drop.ts`)
  hit-tests the panel rect on every phase and drives the existing `rowDrop "item"` cue; on an
  end inside, `insertLakehouseItem(session, draft, JSON.stringify(item), from)`, now shared with
  the native drop. Only a writable composer has a panel, so read-only and Trash take nothing.
- **Ghost** `components/apps/frame-drag-ghost.tsx`, rendered once in `ChatApp` inside the
  session provider: inside the chat root (no React portal, KOBE-282), `position: fixed` at the point (offset 12 px by
  `transform`), `pointer-events: none`, `aria-hidden`; server snapshot null, so never on the
  server render. Its name is bounded (512 chars) before it is drawn.
- **Stuck-drag guard** (not in the contract, host-only): while a drag is live, a `pointerdown`
  or Escape in the page cancels it. During capture the page gets no pointer events, so a press
  there means the app's end was lost (rate limit, crash).
- `e2e/browser`: `fetchReal` and the guard regex moved from `app-frame.spec.ts` to
  `tests/support/frame-route.ts` for reuse; `frame-drag` added to the Firefox project.

## Open questions (for Chris or the coordinator)

- none

## Follow-ups

- `frame-drag.spec.ts` was not run here (no browser libs on this VM): the coordinator runs it
  against gate1 with `KOBE_PICKER_HTML=<built picker html>` until the CAT-247 build is pinned.

## Evidence (acceptance criteria → test or command output)

- ac-1: `apps/web/lib/apps/host-bridge-drag.test.ts`
- ac-2: `apps/web/components/apps/app-frame-drag.test.tsx`, `apps/web/lib/apps/frame-drag.test.ts`
- ac-3, ac-4: `apps/web/components/chat/composer-frame-drag.test.tsx` (ghost, cue, drop, outside,
  cancel, stuck-drag guard, refusal, full row, read-only and Trash)
- ac-5: `apps/web/components/chat/frame-drop-equivalence.test.ts`
- ac-6: `docs/specs/mcp-apps-host.md` §8 (Chromium finding on the native-drag paragraph; new
  "Host extension: pointer drags from an app frame"); `docs/ledger/KOBE-551.md` follow-up
- ac-7: `e2e/browser/tests/frame-drag.spec.ts` (typechecks; run by the coordinator)
- ac-8: `pnpm verify` green; PR CI (see PR)
