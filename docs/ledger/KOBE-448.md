# KOBE-448: Workspace rail: Files and Apps share one tabbed section (tabs Files | Apps)

- **Status:** in review (Sonnet), committed on `group-11a-panels`, not pushed
- **Branch / worktree:** `group-11a-panels` in `../Kobe-g11a` (G11a: 452, 453, 448)
- **Depends on:** KOBE-453 (threads out of the rail), KOBE-440 (rail Apps), KOBE-419 (top line)

## Decisions (Chris 2026-10-20, followed)

- With KOBE-453 the rail is the Files | Apps section only; the tab remembers the member's last
  one, Files the first time.

## Design

- **Section:** `components/shell/rail-tabs.tsx` (`RailTabList`): ARIA tablist "Files and apps",
  automatic activation, Left/Right (wrapping), Home/End, one tab stop. Both panels stay mounted
  (`hidden`), so Files keeps its listing and tree and Apps its launch state.
- **Files tab** keeps its Files region inside the tabpanel (`id="kobe-rail-files"`, named by the
  tab), so everything that found "Files" still does; its own title is screen-reader only there.
- **Apps tab** (`rail-apps.tsx`) is a tabpanel (`kobe-rail-apps`) the section's full height; no
  tab and no tablist when the team has no apps and no "Add your key" hint, whatever is stored.
- **Remembered:** `rail_tab` ("files" | "apps") added to the protocol's UI preferences (the
  server validates with the same schema; no migration), read and saved like the other rail state
  (`useRailTab` in `rail-state.tsx`). Choosing a tab saves it; so does asking for one (Show files,
  Mod+Shift+F, a drop: Files; the collapsed Apps icon: Apps).
- **Top line:** the section toggle reads "Files and apps" when the Apps tab exists; hidden, the
  rail collapses (KOBE-453 review), so Apps never disappears on its own (453 review MEDIUM).
- **Collapsed rail:** one icon for the section, Show files or Show apps by the last tab; it
  expands the rail on that tab and focuses it (the old `appsFocus` request is this reveal).
- Drawer, drop zone, Files keyboard, rename, drag-to-move, Move to and mentions are untouched
  (Files' own code); the phone drawer opens on the last tab.

## Shared files touched

- `packages/protocol/src/ui-preferences.ts` (+ test): `RAIL_TABS`, `rail_tab`.
- `components/chat/chat-app.tsx`: none for 448.

## Evidence

- ac-1: `components/shell/rail-tabs.test.tsx` "starts on Files…keeps its state", "remembers the
  member's tab across loads"; `lib/shell/preferences.test.ts`; protocol `ui-preferences.test.ts`.
- ac-2: rail-tabs "no Apps tab and no tablist", "a key to add is enough"; `app-cards.test.tsx`.
- ac-3: rail-tabs arrow keys/Home/End/one tab stop; collapsed icon opens on the last tab (focus);
  Mod+Shift+F to Files; "Files and apps" toggle hides both (rail collapses).
- ac-4: browser `rail-header.spec.ts` "Files | Apps" (arrows, light/dark shots, reload keeps Apps;
  Files alone where there are no apps), `support/chat.ts` (`FILES_TOGGLE`, starts on the Files
  tab), `gate-apps/explorer.spec.ts` (`showAppsTab` before a launch), U17 toggle name.
- ac-5: the rail holds only this section (KOBE-453); Files the first time (`initial: "files"`).
