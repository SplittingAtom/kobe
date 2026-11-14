# KOBE-657: Expanded MCP App in the artifact column: keep the frame within the column height

- **Status:** in review (not pushed; coordinator opens the PR)
- **Branch / worktree:** `kobe-657-app-tab-height` in `../Kobe-wt657`
- **Depends on:** none

## Plan

Fix A (coordinator's choice): in the expanded placement the frame always equals the column and the
app scrolls inside its own document.

## Decisions

- `apps/web/components/apps/app-frame.tsx`: expanded frames fill like the rail (section
  `min-h-0 flex-1`, iframe `height: 100%` + `min-h-0 flex-1`); a report no longer sets a
  `minHeight`. `onHeight` is still called with each report, so a card coming back from expanded
  keeps its last height (MA10, `tool-card-app.tsx`).
- Host context: `containerDimensions.maxHeight` for expanded is the iframe's `clientHeight` (falls
  back to `EXPANDED_MAX_HEIGHT` before layout). A `ResizeObserver` on the iframe sends
  `ui/notifications/host-context-changed` with `{ containerDimensions: { width, maxHeight } }` when
  the height changes; unchanged heights and a hidden tab (height 0) send nothing.
- Inline (360 start, 720 cap) and rail sizing unchanged.
- Guide: `docs/guide/connectors-and-apps.md` gains a **Size** bullet.

## Open questions (for Chris or the coordinator)

- ac-1 (reproduce on gate1) and the ac-5 browser check need a gate1 deploy; not done from this
  worktree.

## Evidence (acceptance criteria → test or command output)

- ac-2, ac-3, ac-5 (unit): `app-frame.test.tsx` "AppFrame expanded in the artifact column
  (KOBE-657)": 1500 px report sets no minHeight; initialize reports `maxHeight: 800` (the frame's
  height); resize to 520 sends a host-context change, repeated/zero heights send none; `onHeight`
  still fires. Written first, 3 failed before the fix.
- ac-4: `vitest run components/apps components/chat`: 85 files, all tests passed (inline and rail
  tests unchanged).
