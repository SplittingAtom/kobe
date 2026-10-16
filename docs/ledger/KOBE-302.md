# KOBE-302: Compaction marker does not open to its summary on click; row-menus spec misses Share

- **Status:** committed on the group branch
- **Branch / worktree:** `group-4-composer` in `../Kobe-g4`
- **Depends on:** KOBE-209 (markers), KOBE-208 (Detail toggle), KOBE-221 (Share)

## Root cause

Not a remount and not a double toggle. The gate1 trace (2026-10-16) shows the marker's header
with `aria-expanded="true"` before the test's click, and `false` after it, with the same
`aria-controls` id in every snapshot (no remount). The owner's stored Detail toggle is on
(`aria-pressed="true"` from page load), and the compaction marker follows Detail by design
(KOBE-209 ledger: "Compaction expands with the Detail toggle"). The spec's click therefore closed
an open marker. The spec assumed Detail off.

## Decisions

- No product change: the marker keeps following Detail (KOBE-209 decision).
- `compact-now.spec.ts` opens the marker only when it is closed, checks `aria-expanded`, then
  checks that a click closes it and the next opens it, whatever the stored Detail preference is.
- Component tests pin both halves: the open state survives a new turn, the markers read after it
  and a new title (same element, still open); with `detail_expanded: true` stored, the marker
  starts open and a click closes it. Both pass on the code as it was: there is no product bug to
  fail on.
- Other disclosures (reasoning, tool cards) use the same `useDisclosure`; no e2e spec clicks
  them, so nothing else depends on Detail being off.

## Evidence (acceptance criteria → test or command output)

- ac-1: `apps/web/components/chat/markers.test.tsx` "a compaction's open state (KOBE-302)";
  web unit tests 1312/1312 pass; format, lint, web and e2e typecheck clean.
- ac-2: `e2e/browser/tests/row-menus.spec.ts` lists Share between Archive and Delete (matches
  `thread-menu.test.tsx`); the ArrowDown check on item 2 is unaffected.
- ac-3: after the G4 deploy (coordinator).
