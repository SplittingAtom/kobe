# KOBE-384: SMA9 Memory panel tabs (Memories / Notes) and Me editor

- **Status:** committed locally (coordinator pushes / opens the PR)
- **Branch / worktree:** `kobe-384-sm-panel` in `../Kobe-wt384`, on `kobe-379-sm-checks` (PR #541)
- **Depends on:** KOBE-378 (item store API, on main), KOBE-379 (checks, PR #541)
- **Migrations:** none. **Server changes:** none (the item API had everything needed).

## Plan

Web only: the existing **My memory** page (`/me/memory`, bar icon, panel) gains **Memories**
(default) and **Notes** tabs; Notes is the D24 file panel unchanged; Memories is the Me editor.

## Decisions

- **Naming (ac-3).** One page, one label: the bar, palette, panel and `/memory` slash command keep
  **My memory**; inside it the tabs are **Memories** and **Notes**. No new icon, route or panel.
  The page has one h1, **My memory** (review M5).
- **Tab in the address:** `?tab=notes`; `?project=` (project memory is notes only, and the project
  page's link) opens Notes. Memories needs no parameter (`lib/memory/tabs.ts`).
- **Chips:** the `memory.updated` chip reads **Note saved: path (my notes | project notes)**; item
  saves in the editor announce **Memory saved.** (with Undo). No item chip in the chat yet: the
  agent has no write path to items (Phase B's accept flow will reuse the wording).
- **Labels (review H1):** one map, `SEMANTIC_MEMORY_SCOPE_LABELS` in the protocol, one string per
  scope: user "Only in this workspace", portable "All my workspaces", team "Workspace memories",
  site "Site memories". Editor groups and the context viewer's lanes use it; "This workspace" is
  gone. (Protocol change inside this PR at the coordinator's request.)
- **Portable:** only on add, only for kind preference (checkbox **Use in all my workspaces**);
  `confirm_portable: true` after the confirm dialog **Use in all my workspaces?** that shows the
  text. Editing a portable item fixes its kind (preference). Moving an existing item between
  groups is not offered (the API has no scope change; supersede is same-scope).
- **Checks:** `apiRequest` gained an opt-in `errorDetails` (4xx body kept in `error.details`,
  camelized; never for 5xx) so the editor can read `warnings`, `duplicates`, `policy_conflicts`,
  `current_version`, `capacity`. Lint warnings and Policy conflicts show inline under the control
  with **Save anyway**; the override is kept when a second refusal follows (lint then Policy sends
  both). `memory_secret` has no Save anyway. Near-duplicates are links to the item's row
  (`#memory-item-<id>`, statement from the loaded lists; "A similar memory" when not loaded).
- **Undo:** add → archive; statement-only edit → `revert` to the version before (expected_version
  = the new one); other edits → patch the old fields back; pin ↔ unpin; archive ↔ restore. Undo
  itself runs through the checks (a revert can meet a warning).
- **Conflicts:** every mutation sends `expected_version`; `memory_version_conflict` says so with
  **Reload** (reloads both groups).
- **Limits:** per group notice from 80% (`SEMANTIC_MEMORY_NEAR_FULL_RATIO`) and when full;
  "n of 10 pinned"; statement length (500 code points) and 5 tags checked before sending.
- **Lists (review M1):** per group, pinned items by their own request (`pinned=true`, at most 10:
  exact count, listed first), the rest with `pinned=false` and **Show more** (`cursor`), the
  archive on demand with its own Show more. No server change. Server answers are placed in the
  lists (`lib/memory/item-lists.ts`), rows keyed by id: no reload after a change.
- **Review M2-M5, lows:** Undo bar keyed per change (a new change clears an old Undo's warning);
  an Undo meeting a version conflict is withdrawn. Focus: Edit → textarea, Save/Cancel → Edit, Pin
  → Pin (fixed name + aria-pressed), Archive → group heading, Restore → Archived heading, Undo →
  the row. A conflict keeps the draft; Reload shows the saved text above it and Save goes over that
  version. One h1 "My memory" above the tabs; the tab bodies have no titles of their own (Notes'
  section is "Files" or "Project memory"). Memories tab stays mounted (drafts survive Notes).
  Save anyway is dropped when Use in all my workspaces changes; a near-duplicate without items
  shows the server's words. Guide limits: 300 / 50 / 1,000 / 1,000.
- Browser spec `e2e/browser/tests/memory-editor.spec.ts` (gate1, coordinator runs it).

## Open questions (for Chris or the coordinator)

1. Resolved: labels (H1) and paging (M1) per the review.
2. `/memory` in the ticket: there is no `/memory` route; read as the `/memory` slash command,
   which opens `/me/memory` (unchanged).

## Evidence (acceptance criteria → test or command output)

- **ac-1** Notes unchanged: `components/me/my-memory.test.tsx` (all existing cases) and
  `components/chat/memory-notice.test.tsx` pass; changes are copy ("Note saved", "this
  workspace") and opening the Notes tab (`?tab=notes` in the address before each case).
- **ac-2** `components/me/my-memories.test.tsx` (23 cases, incl. the review fixes) and
  `lib/memory/item-lists.test.ts`: add + Undo, portable confirmation with
  the text (cancel sends nothing), portable for preferences only, lint warnings + near-duplicate
  link + Save anyway, no Save anyway for a secret, lint then Policy keeps both overrides, edit
  with expected_version + Undo (revert), version conflict + Reload, pin/archive/restore + Undo +
  focus, 80%/full notices, Workspace wording (no "team"), length check before sending.
- **ac-3** tabs test in `my-memories.test.tsx`; no change to `lib/shell/panels.ts`, bar or routes.
- **ac-4** guide: `docs/guide/memory.md` (Memories/Notes tabs, Your memories section),
  `getting-started/layout.md`, `glossary.md`, `reference/troubleshooting.md`; /llms.txt is built
  from the guide. Gate 3 browser script matches the new chip text.
