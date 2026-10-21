# KOBE-466: Threads panel: trash icon on hover moves the thread to Trash

- **Status:** in review (group branch, no PR yet)
- **Branch / worktree:** `group-16-thread-trash` in `../Kobe-wt466`
- **Depends on:** KOBE-292, KOBE-220 (the row menu's Delete)

## Plan

An `IconAction` (`trash-thread`, "Move <title> to Trash") beside the row's ⋯ button in
`ThreadRowMenu`, running the menu bindings' own `trash-thread` handler. No new API call.

## Decisions

- Same behaviour as the menu's Delete: no confirm (Trash is undoable), a refusal shows the
  menu's notice ("Not deleted" beside the row, full text for screen readers).
- Revealed with `pointer-fine:` hover/focus-within classes; `hidden` without a fine pointer, so
  touch screens keep the ⋯ menu as the way to Trash.
- Not shown on Trash rows (they keep Restore / Delete forever) nor on threads shared with the
  member read-only (only the owner can delete; the menu item explains why).
- No shortcut shown in its tooltip (`shortcut={null}`).

## Open questions (for Chris or the coordinator)

- none

## Evidence (acceptance criteria → test or command output)

- ac-1, ac-2, ac-3: `apps/web/components/chat/thread-row-trash.test.tsx` (6 tests).
- `thread-menu.test.tsx` no longer asserts the row has no Trash icon.
- Browser: `e2e/browser/tests/row-menus.spec.ts` checks the icon shows on row hover (no spec
  counted row controls); not run here.
- `pnpm verify` green.
