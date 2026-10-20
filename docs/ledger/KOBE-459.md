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
  320 px; the default rail is what a 14rem tree leaves. The columns follow a container query on
  the page's width (review LOW-3), not the viewport: under 36rem no handle, tree above the rail.
- **Width per member:** saved with the layout preferences (server-side, debounced PUT) via
  `useStoredPreference`. This needed a new optional key `workbench_editor_width` (320..8192, null =
  default) in `@kobe/protocol` `ui-preferences.ts`. The server's route already validates with
  that schema, so **no server code change**, but it is an additive protocol change in a feature
  PR (the coordinator may split it out). The shell now provides `LayoutPreferencesContext`
  (`chat-app.tsx`) so panel pages can read and save preferences; outside the shell: defaults.
- **Eval history (review MEDIUM-1):** a saved version keeps **no link** to its draft (only the
  `skill.uploaded` audit row names `draftId`; a `draft_id` column on versions needs a migration,
  so it is a follow-up). Save version files a draft under the skill named by SKILL.md, so the
  history matches by name, narrowly: the same-named team skill and, for the author only, their
  personal skill, and of those **only versions the viewer saved** (`uploadedBy` from
  `GET /v1/skills/:id/versions`, no server change). Those rows read "Team skill x (same name)",
  every version as `v<semver>` (LOW-2). Runs come from `GET /v1/skill-evals?draft_id=` and
  `?scope=&skill_id=`, merged newest first in the Evals panel's "Eval history" table (Source
  column); rows link to the scorecard and Show it here. Read while Eval is shown and after each
  save; a failed read is a warning notice, the draft's runs still show.
- **Preferences provider (review HIGH-1):** `ChatApp` owns the one `useLayoutPreferences` (loaded
  once a session exists) and provides it around both the workspace and the panel page, so the
  Skills panel's draft page loads and saves the width (test in `workspace-panel.test.tsx`).
- **Rolling deploy (LOW-1):** a new web against an old server gets 400 on a PUT carrying
  `workbench_editor_width` (strict schema); only that save fails. Server and web deploy together
  on gate1, so no window there; landing the protocol commit first removes it elsewhere.

## Open questions (for Chris or the coordinator)

- Follow-up: record `draft_id` on saved versions (migration) so the history uses the real link,
  not the name plus the viewer's own versions.
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
