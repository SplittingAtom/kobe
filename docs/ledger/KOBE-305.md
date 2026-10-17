# KOBE-305: Resizable left rail

- **Status:** implemented on group branch `group-2-quality` (no PR of its own); review next
- **Branch / worktree:** `group-2-quality` in `../Kobe-g2`
- **Depends on:** KOBE-200 (artifact splitter), KOBE-201 (bands), KOBE-225 (Mod+B), KOBE-304 (tree)

## Plan

1. Extract the artifact column's splitter into one hook, `components/shell/use-splitter.ts`
   (pointer drag with a 3 px click threshold, commit on release, arrow / Page / Home / End keys,
   optional double-click reset, aria values that follow ResizeObserver). `artifact-resize.tsx`
   now only says how to measure its column, preview and commit.
2. `components/shell/rail-resize.tsx`: the rail's handle on the same hook.
3. Width state in `RailProvider` (`width`, `setWidth`, `resetWidth`) on `useStoredPreference`
   (`rail_width` preference), helpers in `lib/shell/rail-width.ts`, bounds in `lib/shell/layout.ts` (`RAIL_PX.min/max`, `maxRailWidth`,
   `layoutAt` takes `railWidth`). `ShellGrid` sets `--kobe-rail-expanded-width`.
4. CSS: `--kobe-rail-width: min(var(--kobe-rail-expanded-width, 280px), 100% - var(--kobe-rail-room))`,
   room 400 px, 760 px while the artifact column is a column. Collapsed and < 1100 px rules still
   force 48 px. Handle `.railHandle` only from 1100 px.

## Decisions

- **Bounds:** 200 px minimum (names readable; under the tree's 15rem container query the size
  column hides, names truncate as in KOBE-304), 560 px maximum, default 280 px. The dynamic
  maximum is `grid − 400` (no artifact) or `grid − 760` (artifact column open), so both columns
  keep their floors (CE7). The CSS clamps a stored width too, so a width chosen on a wider window
  yields and comes back.
- **Storage: server-side per user** (coordinator decision 2026-10-17, replacing the first
  localStorage version): a new `rail_width` key in `UiPreferences` (`packages/protocol`, int
  200..560 or `null` for the default), saved through the artifact column's mechanism
  (`useStoredPreference`, debounced `PUT /v1/me/preferences`, flushed on pagehide). No migration:
  `users.ui_preferences` is a jsonb document (4 KiB CHECK) and the route validates with the
  protocol schema. No localStorage first paint, since the artifact column has none either: the
  stored width applies once the preferences load. Stored values are read leniently (out of bounds:
  the default).
- **Handle placement:** a sibling of the rail's `<aside>`, positioned against the grid at
  `var(--kobe-rail-width) − 2px`, 6 px wide, so it neither scrolls with the rail nor covers the
  sections' scrollbars. Rendered only when docked (≥ 1100 px) and expanded: no handle when
  collapsed (Mod+B), at 820–1100 px (48 px rail / drawer) or under 768 px (drawer, as today).
- **Mod+B** keeps the width in state and storage; expanding restores it (the grid variable stays).
- **Double-click** resets to 280 px and saves `rail_width: null`. The artifact column gets no
  double-click (its behaviour unchanged); the hook's `reset` is optional.
- **Keys** step 24 px (as the artifact column), Page Up/Down four steps, Home/End the bounds.
  One small change shared by both handles: after a key press `aria-valuenow` shows the new value
  at once instead of waiting for the ResizeObserver (screen readers announced the old value).
- **Motion:** the handle's highlight fades only under `prefers-reduced-motion: no-preference`.
  Colours are the `--admin-*` tokens, so dark mode follows.
- The Threads/Files divider (`rail-divider.tsx`, horizontal, a share not px) stays on its own.

## Open questions (for Chris or the coordinator)

- none

## Evidence (acceptance criteria → test or command output)

- ac-1: `components/shell/rail-resize.test.tsx` "drags within the bounds…", "a press that doesn't
  move…"; `lib/shell/layout.test.ts` "the rail's dragged width"; CSS contract in
  `layout-contract.test.tsx` (cursor, focus/hover highlight, wide only).
- ac-2: `rail-resize.test.tsx` "persistence and reset" (stored width applied, out-of-bounds and
  garbled values ignored, one debounced PUT, double-click saves null); `lib/shell/rail-width.test.ts`,
  `lib/shell/preferences.test.ts` (wire), `packages/protocol/src/ui-preferences.test.ts`,
  `services/server/src/me-preferences.db.test.ts` (follows the member to another session, null
  resets, out of bounds refused with 400).
- ac-3: `rail-resize.test.tsx` "is a vertical separator…", "arrow keys step 24 px…"; one hook
  (`use-splitter.ts`) for both handles; artifact tests unchanged and green
  (`artifact-tabs.test.tsx`, `layout-preferences.test.tsx`, `breakpoints.test.tsx`).
- ac-4: `rail-resize.test.tsx` "with the rest of the shell" (Mod+B restore, 960/390 px and the
  drawer have no handle, beside the artifact column End = 520 px at 1280); `layout.test.ts`
  floors at every wide width.
- ac-5: component tests above; `e2e/browser/tests/rail-resize.spec.ts` (second browser context
  gets the width, screenshots light/dark and with a file tab; restores the member's width) to run
  on gate1.
- Checks (2026-10-17, after the server-side switch): `pnpm format:check`, `pnpm lint`,
  `pnpm typecheck`, protocol `ui-preferences.test.ts`, server `me-preferences.db.test.ts` (dev
  Postgres), web vitest 170 files / 1706 tests green apart from one timing flake in
  `file-tree.test.tsx` under the full parallel run (5 s timeout; green alone, file not touched),
  `next build` green.
