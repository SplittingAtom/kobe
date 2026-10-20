# KOBE-459: Skills Workbench: Define, Test and Eval tabs; a wide, resizable editor rail

- **Status:** in review (group branch, not pushed)
- **Branch / worktree:** `group-12-workbench-tabs` in `../Kobe-wt459`
- **Depends on:** KOBE-321/323/328 (Workbench, test pane, evals), KOBE-305 (splitter), KOBE-452 (panels)

## Plan

The draft page keeps its header, Save version, status line, notices and DraftSettings, then a
console `Tabs` (Radix) with Define | Test | Eval (`components/skills/workbench-tabs.tsx`).

## Decisions

- **Tabs:** the console's `Tabs` (as the Skills page), label "Draft". A tab mounts the first
  time it is shown and is then kept (hidden), so a test chat or an eval's progress survives a trip
  to Define. Leaving Define calls `editor.flush()`; the test pane and Run still flush before
  they send or start anything, as before.
- **Address and memory:** `?tab=` is read by the route (`draftTabParam`: none -> null, unknown ->
  Define) and rewritten with `history.replaceState` (as the Skills page). The last tab per draft
  is kept in localStorage (`kobe.workbench.tab.<draftId>`; per browser, like the artifact tabs
  per thread): it is transient and keyed by draft, which the 1 KiB server preferences can't hold.
  Opening order: address, then memory, then Define.
- **Resizable rail:** `components/skills/define-layout.tsx` reuses the shell's `useSplitter`
  (KOBE-305; ARIA separator, keys, drag, Enter/double-click reset). New option `reversed` in
  `use-splitter.ts`: the rail sits after the handle, so Left widens it. Floors: tree 12rem, rail
  320 px; the default rail is what a 14rem tree leaves. Below md: no handle, tree above the rail.
- **Width per member:** saved with the layout preferences (server-side, debounced PUT) via
  `useStoredPreference`. This needed a new optional key `workbench_editor_width` (320..8192, null =
  default) in `@kobe/protocol` `ui-preferences.ts`. The server's route already validates with
  that schema, so **no server code change**, but it is an additive protocol change in a feature
  PR (the coordinator may split it out). The shell now provides `LayoutPreferencesContext`
  (`chat-app.tsx`) so panel pages can read and save preferences; outside the shell: defaults.
- **Eval history:** a draft keeps **no link** to the skill it was saved as. Save version files it
  under the skill named by SKILL.md (else the draft) in the chosen destination, and the bump
  suggestion finds it by name too. So the history matches by name: the same-named team skill and,
  for the author only, their personal skill (`lib/skills/eval-history.ts`). Runs come from
  `GET /v1/skill-evals?draft_id=` and `?scope=&skill_id=`, merged newest first in the Evals
  panel's existing "Eval history" table with a Source column ("This draft", "Team skill x",
  "Personal skill x"); rows still link to the scorecard page and Show the scorecard here. Read
  while the Eval tab is shown and again after each saved version. A failed read is a warning
  notice; the draft's runs still show.

## Open questions (for Chris or the coordinator)

- Name matching shows a same-named team skill's runs even if this draft never saved into it (e.g.
  another member's skill of that name). A stored draft->skill link would need a server change.
- `workbench_editor_width` in `@kobe/protocol`: keep in this group PR or land it first on its own?

## Evidence (acceptance criteria -> test or command output)

- ac-1, ac-2, ac-4, ac-5, ac-6: `apps/web/components/skills/draft-workbench-tabs.test.tsx`
- ac-3: `components/skills/define-layout.test.tsx`, `components/shell/use-splitter.test.tsx`
  (reversed), `lib/shell/preferences.test.ts`, `packages/protocol/src/ui-preferences.test.ts`
- ac-5: `lib/skills/eval-history.test.ts`, `components/skills/evals-panel.test.tsx` (merged rows)
- ac-6: `lib/skills/draft-tabs.test.ts`
- ac-7, ac-8: browser spec `e2e/browser/tests/workbench-tabs.spec.ts` (three tabs, keys + drag
  resize, width and tab after reload, unknown tab -> Define, phone width light/dark screenshots,
  tree above the rail). Not run against gate1 from this worktree. Existing Workbench specs
  (`skills-workbench`, `skill-creator-workbench`, `workspace-panels`) only touch the header,
  DraftSettings and Define's fields, which stay on the default tab: unchanged.
- `pnpm verify` green; `pnpm --filter @kobe/web test`: 242 files, 2221 tests passed.
