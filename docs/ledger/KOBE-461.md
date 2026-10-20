# KOBE-461: Rail: picker defaults to the last pick or the first picker; Files opens with its tab; Refresh beside Upload

- **Status:** in review (group branch, not pushed)
- **Branch / worktree:** `group-14-rail-tweaks` in `../Kobe-wt461`
- **Depends on:** KOBE-460, KOBE-448

## Decisions

- **Picker state** (`rail-state.tsx`): `picker` is `undefined` (never chose: `rail_picker` absent),
  `null` (chose None) or an app id. `useStoredPreference` treats `null` from `resolve` as "keep",
  so a chosen None is held internally as a symbol and saved as `null`.
- **Default** (`rail-pickers.tsx`): the remembered pick while live; a remembered None stays None;
  otherwise the first live picker. Nothing is chosen until the member's preferences load, so the
  opening tool is called once, for the right picker. The default is not saved.
- **Gone pick:** the first live picker shows with the "no longer available" note; the stale id
  stays remembered (not overwritten) until the member chooses (before: cleared to None).
- **Files listing** (`workspace-rail.tsx` `useListWhenShown`): once per page load, the first time
  Files is on screen in an expanded rail after the layout loads (tab click, load on Files, the
  drawer). Later showings (Apps then Files, collapse and expand, the drawer again) reuse the kept
  listing without waking (coordinator, 2026-10-20). Refresh files, Show files, Mod+Shift+F and
  `/files` list again. Apps tab, a collapsed rail and a closed drawer wake nothing. The "Open
  files" button is removed: it could never show.
- **Refresh files** moved into `FileBrowser`'s top row (`onRefresh` prop, after Upload; ghost
  `IconAction` like Upload's look, same `refresh-files` command/tooltip). It still clears the
  drop notice.

## Open questions (for Chris or the coordinator)

- none (once-per-load listing settled by the coordinator)

## Evidence (acceptance criteria → test or command output)

- ac-1: `rail-pickers.test.tsx` (first live picker when never chose, remembered None, remembered
  pick with one opening call, gone pick → first live with note); e2e `gate-apps/picker.spec.ts`
  adds "a remembered None stays None on load".
- ac-2: `rail-files.test.tsx` (listed on load, collapsed load wakes nothing, collapse/Mod+B
  expand reuses, `/files` lists again), `rail-tabs.test.tsx` (load on Apps wakes nothing; Files
  lists the first time, Apps then Files reuses, Mod+Shift+F lists again), `breakpoints.test.tsx`
  (390 px drawer lists once; close and reopen reuses).
- ac-3: `rail-files.test.tsx` (Refresh in the top row beside Upload, only one); e2e
  `files-tree.spec.ts` checks the same.
- ac-4: specs updated: files-tree, composer-cues, row-menus, rail-resize, gate5/u18-never-lose
  (no "Open files"; files written after load are listed with Refresh). Gate1 runs: coordinator.
